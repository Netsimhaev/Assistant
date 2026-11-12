/**
 * Live end-to-end run of the curator against the Agent SDK.
 *
 *   npm run sdk:curator -- --business <id>
 *
 * A script and not a test, for the same reason `sdk:propose` is one: it costs
 * money and needs a key, and a suite that skips silently without one reports
 * green for work it did not do. Everything this composes is covered by tests
 * that need neither — what only a live run can show is whether the model,
 * given the brief this code builds, returns facts worth keeping and in the
 * shape `CurationResult` demands.
 *
 * It drives the whole path rather than calling `curateJob` directly: a job is
 * created, a plan bound, a step recorded, and the job walked to `verify` —
 * then `closeVerifiedJobs` is what calls the curator, exactly as the scheduler
 * does in production. Calling the curator directly would prove the curator and
 * not the wiring, and the wiring is the half that has broken before.
 *
 * Then it reads back what was written and renders the planning block, because
 * "the memory row exists" and "the memory reaches a prompt, labelled" are two
 * different claims and only the second one is the feature.
 */
import { transaction, type BusinessDb } from '../db/pool.js';
import { closeCliPools, runForBusiness } from '../cli/business-arg.js';
import { loadActiveCharter } from '../charter/store.js';
import { createJob, loadJob, transition } from '../orchestrator/jobs.js';
import { bindPlanToJob, recordStepCompletion } from '../orchestrator/plan-store.js';
import { closeVerifiedJobs } from '../orchestrator/verify.js';
import { recallMemories } from '../memory/store.js';
import { recallForPlanning } from '../memory/recall-planning.js';
import { Plan } from '../domain/plan.js';

const RONIT = 'ronit@beta-log.example';

/** What the owner would have typed. The curator sees this and the body below. */
const TITLE = 'לשלוח לרונית עדכון על לוח הזמנים';

/**
 * The body carries two things worth remembering and one worth ignoring. A
 * live run that seeds nothing learnable proves only that the plumbing runs.
 */
const BODY = [
  'רונית שלום,',
  '',
  'מצרפת עדכון על לוח הזמנים. כפי שביקשת, אני שולחת את זה במייל ולא בוואטסאפ —',
  'רשמתי לפניי שאת מעדיפה שכל מה שקשור לחוזים יגיע בכתב.',
  '',
  'בנוסף, ציינת שאת לא זמינה בימי שישי, אז קבעתי את הפגישה ליום רביעי.',
  '',
  'תודה,',
  'המשרד',
].join('\n');

function planFor(): Plan {
  // Parsed, not cast. `as never` past a schema is what concealed a request
  // that could not work earlier on this branch; if this plan is malformed the
  // right time to find out is here, not inside the engine.
  return Plan.parse({
    goal: TITLE,
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'לשלוח לרונית את העדכון',
        toolName: 'mail.send',
        input: { to: RONIT, subject: 'עדכון על לוח הזמנים', body: BODY, inReplyTo: 'thread-live-curator' },
        dependsOn: [],
        expectedActionClass: 'email.reply',
      },
    ],
  });
}

async function main(db: BusinessDb): Promise<void> {
  const BUSINESS = db.businessId;
  const hasCredentials =
    process.env['ANTHROPIC_API_KEY'] !== undefined ||
    process.env['ANTHROPIC_AUTH_TOKEN'] !== undefined;
  if (!hasCredentials) {
    console.error('אין ANTHROPIC_API_KEY בסביבה. ההרצה החיה דורשת מפתח.');
    process.exitCode = 1;
    return;
  }

  const charter = await loadActiveCharter(db);
  if (charter === null) {
    console.error(`אין תקנון פעיל ל-${BUSINESS}. הרץ scripts/seed-charter.ts תחילה.`);
    process.exitCode = 1;
    return;
  }

  console.log(`עסק: ${BUSINESS} · תקנון: ${charter.bundle.charterVersion}`);

  const before = await recallMemories(db, { subjectKey: RONIT });
  console.log(`זיכרונות על ${RONIT} לפני הריצה: ${before.length}`);

  // 1. A job the owner opened, walked to `verify` the way the engine walks it.
  const job = await createJob(db, {
    charterVersion: charter.bundle.charterVersion,
    provenance: 'boss',
    title: TITLE,
  });
  console.log(`נפתחה משימה ${job.jobId}`);

  const plan = planFor();
  const binding = await bindPlanToJob(db, job.jobId, plan);
  if (binding.status === 'conflict') throw new Error('bindPlanToJob returned conflict on a fresh job');

  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(db, job.jobId, { to, actor: 'orchestrator', reason: 'live curator run' });
  }

  // The step really ran, as far as the record is concerned — `closeVerifiedJobs`
  // refuses to close a job whose plan declares a step with no row.
  await transaction(db, (tx) => recordStepCompletion(tx, {
    jobId: job.jobId,
    planHash: binding.planHash,
    stepId: 's1',
    externalId: 'live-curator-run',
    status: 'completed',
    performed: true,
  }));

  await transition(db, job.jobId, { to: 'verify', actor: 'orchestrator', reason: 'live curator run' });
  console.log('המשימה ב-verify. קורא ל-closeVerifiedJobs — כאן נופלת הקריאה למודל.');

  // 2. The real thing: production's own closer, which calls the curator.
  const started = Date.now();
  const result = await closeVerifiedJobs(db);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  console.log(`=== מה closeVerifiedJobs החזיר (${seconds}s) ===`);
  console.log(`closed:          ${JSON.stringify(result.closed)}`);
  console.log(`curated:         ${JSON.stringify(result.curated)}`);
  console.log(`curationSkipped: ${JSON.stringify(result.curationSkipped ?? [])}`);
  console.log(`failed:          ${JSON.stringify(result.failed)}`);
  console.log(`errored:         ${JSON.stringify(result.errored)}`);

  const closed = await loadJob(db, job.jobId);
  console.log(`phase של המשימה: ${closed?.phase}`);

  // 3. What was actually written, read back from the table itself.
  const after = await recallMemories(db, { subjectKey: RONIT });
  console.log('');
  console.log(`=== זיכרונות על ${RONIT} אחרי: ${after.length} (לפני: ${before.length}) ===`);
  for (const memory of after) {
    console.log(
      `- [${memory.kind}] ${memory.attribute ?? '—'} · provenance=${memory.provenance}\n` +
        `    ${JSON.stringify(memory.body)}\n` +
        `    מקור: ${memory.sourceRef ?? '—'}`,
    );
  }

  // 4. The audit row — counts only, and the cap counts these.
  const audit = await db.query<{ reason: string; at: string }>(
    `SELECT reason, at::text FROM audit_log
      WHERE business_id = $1 AND kind = 'curation'
      ORDER BY seq DESC LIMIT 3`,
    [BUSINESS],
  );
  console.log('');
  console.log('=== שורות ביקורת מסוג curation ===');
  for (const row of audit.rows) console.log(`- ${row.at} · ${row.reason}`);

  // 5. The half that is the feature: does it reach a prompt, labelled?
  const block = await recallForPlanning(db, [RONIT]);
  console.log('');
  console.log('=== הבלוק שהמתכנן יקבל ===');
  console.log(block === '' ? '(ריק)' : block);
}

// `main` sets exit code 1 itself on its own refusals; only a `--business`
// refusal (2) comes back from `runForBusiness`, and 0 must not overwrite that 1.
runForBusiness(process.argv.slice(2), (line) => console.error(line), main)
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeCliPools());
