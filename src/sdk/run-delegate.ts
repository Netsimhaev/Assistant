/**
 * Live end-to-end run of a delegation: `gov.verify` asks `know.reader` for
 * help, through the real Agent SDK.
 *
 *   npm run sdk:delegate
 *
 * A script and not a test, for the reason every `sdk:*` script here is one:
 * it costs money and needs a key, and a suite that skips silently without one
 * reports green for work it did not do. The five guards, `tightenConstraints`,
 * and the whole shape of `requestHelp` are already covered by tests that need
 * neither a key nor a real child job running to completion. What only a live
 * run can show is the seam this task actually cares about: a real plan step
 * (`doc.fetch`) running under a REAL Agent SDK call inside a job that a
 * delegation opened, closing for real, and the parent actually waking up on
 * the other side — not a stubbed `reader` standing in for any of it.
 *
 * This drives the pieces by hand rather than through `conduct.ts`, on
 * purpose. `conduct.ts`'s `beginVerification` opens the delegation and then
 * immediately fails its own job (Task 11's documented gap: nothing yet
 * resumes a `gov.verify` job with the reader's answer, so the judge never
 * runs in production today). This script does not paper over that gap or
 * pretend it is closed — it stops at exactly the same place production does
 * (the delegation opens, the child runs and closes, the parent wakes), and
 * then CLOSES THE PARENT JOB ITSELF, by hand, as the demonstration's own
 * bookkeeping — not as a claim that something in `src/` does this today. See
 * the printed note right before that step.
 *
 * SEED IDENTIFIERS MUST BE UNIQUE. A live run on this project once seeded a
 * preference under an address the curator's own live run had already
 * written to, and replace-on-write did exactly what it is specified to do:
 * it retired a real memory as superseded. Every job title, document name and
 * document body here carries a fresh `probe-*` id, generated once per run,
 * so two runs never collide and neither run can be mistaken for the other's
 * data. The probe document's own content is also unique per run (the id is
 * embedded in the text), so its `sha256` never matches an earlier probe's —
 * `documents` dedupes by `(business_id, sha256)`, and a repeat would silently
 * reuse a previous run's row and reading instead of exercising a fresh one.
 *
 * SAFETY, no memory writes. The child job's one step (`doc.fetch`) does not
 * address anyone, and it carries no `proposals` row — `curateJob`'s own
 * `touched` set (`src/memory/curation-brief.ts`) is built ONLY from a plan's
 * outgoing steps and, when the job carries a `proposals` row, that reading's
 * own entity-kind intents. Neither source contributes anything here, so
 * `touched` is empty and `siftCandidates` rejects every candidate the curator
 * could ever propose about this probe, model or no model. This script still
 * does not risk it: it injects a curator stub that returns zero candidates
 * outright, both to keep this run's cost and scope to the one thing it
 * demonstrates (delegation, not curation) and to make the "no memory can be
 * written from this job" claim structural rather than dependent on what a
 * live model happens to return this time.
 *
 * SAFETY, nothing left runnable. Every job this script opens is moved to a
 * terminal phase before it exits — the parent and the child by the ordinary
 * mechanism this script exercises, the throwaway "subject" job (the draft
 * under review, distinct from the job doing the delegating — see
 * `VerifyDraftInput.subjectJobId`'s own docblock for why the two are never
 * the same row) failed in cleanup because nothing else in this script ever
 * advances it. A job left sitting in `execute` with no plan bound is exactly
 * what `run-scheduler.ts` prints an error line for on its very next pass.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { queryAudit } from '../audit/log.js';
import { ingestDocument } from '../documents/ingest.js';
import { loadEnvelopeWithChild, loadResultForChildJob } from '../governance/envelope-store.js';
import { createJob, loadJob, transition } from '../orchestrator/jobs.js';
import { runDueJobs } from '../orchestrator/run-due.js';
import { resumeDelegatedJobs } from '../orchestrator/resume-delegated.js';
import { closeVerifiedJobs } from '../orchestrator/verify.js';
import { verifyDraft, type AwaitingDelegation, type VerifyDraftResult } from './gov-verify.js';

const BUSINESS = config.businessId;

/** One id per run — see this file's own docblock on why every seed uses it. */
const PROBE = `probe-${ulid()}`;

/** Jobs this run opened, closed in `finally` regardless of how far the run got. */
const openedJobs: string[] = [];

/**
 * `Verdict` carries no `status` field at all, so the two arms of
 * `VerifyDraftResult` are told apart by presence of the field, not by a
 * shared discriminant TS can narrow on directly — same helper
 * `gov-verify.test.ts` uses for the identical reason.
 */
function isAwaitingDelegation(result: VerifyDraftResult): result is AwaitingDelegation {
  return 'status' in result && result.status === 'awaiting_delegation';
}

function banner(title: string): void {
  console.log('');
  console.log('='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

const failures: string[] = [];
function check(label: string, ok: boolean): void {
  console.log(`  [${ok ? 'עבר' : 'נכשל'}] ${label}`);
  if (!ok) failures.push(label);
}

async function main(): Promise<void> {
  const hasCredentials =
    process.env['ANTHROPIC_API_KEY'] !== undefined ||
    process.env['ANTHROPIC_AUTH_TOKEN'] !== undefined;
  if (!hasCredentials) {
    console.error('אין ANTHROPIC_API_KEY בסביבה. ההרצה החיה דורשת מפתח.');
    process.exitCode = 1;
    return;
  }

  const active = await loadActiveCharter(BUSINESS);
  const bundle = active?.bundle ?? (await installCharter(buildCharter()));
  console.log(`עסק: ${BUSINESS} · תקנון: ${bundle.charterVersion} · עוגן: ${PROBE}`);

  // ------------------------------------------------------- SEED A DOCUMENT
  banner('הכנה: קליטת מסמך אמיתי ל-know.reader לקרוא');
  const probeText =
    `פנייה (${PROBE})\n\n` +
    'שלום, אנא אשרו קבלת הפנייה הזו וחזרו אלינו בהקדם. אין כאן סכום לאישור.';
  const tmpDir = await mkdtemp(join(tmpdir(), 'agent-envelope-probe-'));
  const tmpPath = join(tmpDir, `${PROBE}.txt`);
  await writeFile(tmpPath, probeText, 'utf8');
  let documentId: string;
  try {
    const document = await ingestDocument(
      { path: tmpPath, source: 'manual', originalName: `${PROBE}.txt` },
      { businessId: BUSINESS },
    );
    console.log(`מסמך ${document.documentId} · סטטוס ${document.status}`);
    if (document.status !== 'extracted') {
      throw new Error(`הקליטה לא הפיקה מסמך שאפשר לקרוא (${document.status}: ${document.reason ?? '—'})`);
    }
    documentId = document.documentId;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------- OPEN THE JOBS
  banner('הכנה: משימת gov.verify (המאצילה) ומשימת הנושא (מה שהיא בודקת)');
  // The job DOING THE DELEGATING — `gov.verify`'s own job. Walked
  // intake → understand → plan → execute with NO plan bound, exactly the
  // shape `conduct.ts`'s `beginVerification` uses and for the same reason:
  // `verifyDraft` calls `requestHelp` directly, never through a plan step.
  const parent = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'unknown_external',
    title: `${PROBE}: gov.verify מאצילה ל-know.reader`,
    businessId: BUSINESS,
  });
  openedJobs.push(parent.jobId);
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(parent.jobId, { to, actor: 'orchestrator', reason: `${PROBE}: הכנה`, businessId: BUSINESS });
  }
  console.log(`הורה (gov.verify): ${parent.jobId} · provenance=${parent.provenance}`);

  // The job WHOSE DRAFT IS UNDER REVIEW — never the same row as the parent
  // (`VerifyDraftInput.subjectJobId`'s own docblock). Parked in
  // `await_approval`, mirroring the real shape: a card is already up when
  // verification runs.
  const subject = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    title: `${PROBE}: הנושא שהטיוטה שלו נבדקת`,
    businessId: BUSINESS,
  });
  openedJobs.push(subject.jobId);
  for (const to of ['understand', 'plan', 'await_approval'] as const) {
    await transition(subject.jobId, { to, actor: 'orchestrator', reason: `${PROBE}: הכנה`, businessId: BUSINESS });
  }
  console.log(`נושא (הטיוטה שנבדקת): ${subject.jobId}`);

  // ------------------------------------------------------- OPEN THE DELEGATION
  banner('שלב 1: gov.verify מאצילה — verifyDraft עם answer: null');
  const opened = await verifyDraft({
    parentJobId: parent.jobId,
    subjectJobId: subject.jobId,
    documentId,
    draftText: 'אישרנו את קבלת הפנייה, נחזור אליכם בהקדם.',
    sources: [probeText],
    question: 'מה השולח מבקש?',
    answer: null,
    parentEnvelope: null,
    businessId: BUSINESS,
  });
  if (!isAwaitingDelegation(opened)) {
    // verifyDraft's other branch is a finished Verdict — unreachable with
    // `answer: null`, but TypeScript does not know that, and neither should
    // a reader of this script's output pretend a Verdict landed here.
    throw new Error(`verifyDraft לא האציל כפי שציפינו: ${JSON.stringify(opened)}`);
  }
  console.log(`envelope=${opened.envelopeId} · child=${opened.childJobId ?? '(אבד באמצע — ראו תיעוד requestHelp)'}`);
  console.log(`ungroundedNumbers מהטיוטה: ${JSON.stringify(opened.ungroundedNumbers)}`);
  const childJobId = opened.childJobId;
  if (childJobId !== null) openedJobs.push(childJobId);

  banner('אימות 1: שורת agent_envelopes מסוג help_request, ותקרות מהודקות');
  check('childJobId לא null (הילד נוצר ולא רק המעטפת)', childJobId !== null);
  if (childJobId === null) {
    console.log('עוצר כאן — בלי ילד אין מה להריץ ולסגור.');
    return;
  }
  const stored = await loadEnvelopeWithChild(opened.envelopeId, { businessId: BUSINESS });
  check('המעטפת קיימת בבסיס הנתונים', stored !== null);
  if (stored === null) return;
  const envelope = stored.envelope;
  check('kind === help_request', envelope.kind === 'help_request');
  check('from === gov.verify, to === know.reader', envelope.from === 'gov.verify' && envelope.to === 'know.reader');
  check('correlationId שווה למזהה משימת ההורה (האצלת שורש)', envelope.correlationId === parent.jobId);
  check('hops === 1', envelope.hops === 1);
  check('childJobId על השורה שווה למה ש-verifyDraft החזירה', stored.childJobId === childJobId);

  const nowMs = Date.now();
  const deadlineMs = Date.parse(envelope.constraints.deadlineAt);
  check(
    "constraints.provenanceCeiling שווה ל-provenance של המשימה המאצילה (unknown_external) — לא הורפה חזרה ל-'boss'",
    envelope.constraints.provenanceCeiling === parent.provenance,
  );
  check("constraints.autonomyCeiling === 'auto'", envelope.constraints.autonomyCeiling === 'auto');
  check('constraints.moneyCeilingMinor === null', envelope.constraints.moneyCeilingMinor === null);
  check(
    'constraints.deadlineAt מהודק לחלון האצלה של כ-24 שעות — לא לתאריך הסנטינל המתירני של שורש חסר-הורה',
    deadlineMs > nowMs && deadlineMs < nowMs + 25 * 60 * 60 * 1000,
  );
  check(
    'constraints.charterVersion זהה לתקנון שהמשימה המאצילה רצה תחתיו',
    envelope.constraints.charterVersion === bundle.charterVersion,
  );

  // ------------------------------------------------------------- RUN THE CHILD
  banner('שלב 2: הילד רץ — קריאה חיה אמיתית אל know.reader (doc.fetch)');
  const due = await runDueJobs({ businessId: BUSINESS, limit: 5 });
  console.log(`due.ran: ${JSON.stringify(due.ran)}`);
  if (due.errored.length > 0) console.log(`due.errored: ${JSON.stringify(due.errored)}`);
  const childRan = due.ran.find((r) => r.jobId === childJobId);
  check("הילד רץ עד done דרך runDueJobs — לא halted ולא rejected", childRan?.status === 'done');

  const afterRun = await loadJob(childJobId, { businessId: BUSINESS });
  check("שלב הילד עבר ל-verify אחרי הריצה", afterRun?.phase === 'verify');

  banner('שלב 3: סגירת הילד — closeVerifiedJobs (אוצר מדומה: אפס מועמדים, ראו תיעוד)');
  const verified = await closeVerifiedJobs({
    businessId: BUSINESS,
    // Not the point of this run — see this file's own docblock on why zero
    // candidates is safe here regardless, and why the stub is chosen anyway.
    curator: async () => ({ candidates: [] }),
  });
  console.log(`verified.closed: ${JSON.stringify(verified.closed)}`);
  if (verified.failed.length > 0) console.log(`verified.failed: ${JSON.stringify(verified.failed)}`);
  check('הילד נמצא ברשימת verified.closed', verified.closed.includes(childJobId));

  const closedChild = await loadJob(childJobId, { businessId: BUSINESS });
  check("שלב הילד הוא closed", closedChild?.phase === 'closed');

  // ------------------------------------------------------------ WAKE THE PARENT
  banner('שלב 4: resumeDelegatedJobs — האם ואם מתעוררת');
  const delegatedResult = await resumeDelegatedJobs({ businessId: BUSINESS });
  console.log(`resumed: ${JSON.stringify(delegatedResult.resumed)}`);
  console.log(`timedOut: ${JSON.stringify(delegatedResult.timedOut)}`);
  if (delegatedResult.errored.length > 0) console.log(`errored: ${JSON.stringify(delegatedResult.errored)}`);
  check('ההורה נמצא ברשימת resumed (לא timedOut, לא errored)', delegatedResult.resumed.includes(parent.jobId));

  const wokenParent = await loadJob(parent.jobId, { businessId: BUSINESS });
  check("שלב ההורה חזר ל-execute", wokenParent?.phase === 'execute');
  check('awaitingEnvelopeId נוקה', wokenParent?.awaitingEnvelopeId === null);

  banner('אימות 2: שורת agent_envelopes מסוג result');
  const resultEnvelope = await loadResultForChildJob(childJobId, parent.jobId, { businessId: BUSINESS });
  check('שורת result נמצאה', resultEnvelope !== null);
  if (resultEnvelope !== null) {
    check("kind === result", resultEnvelope.kind === 'result');
    check('correlationId זהה לזו של help_request', resultEnvelope.correlationId === parent.jobId);
    const payload = resultEnvelope.payload as { outcome?: unknown; note?: unknown };
    console.log(`תוצאה: ${JSON.stringify(payload)}`);
    check("payload.outcome === 'succeeded'", payload.outcome === 'succeeded');
  }

  banner('אימות 3: audit_log מסוג delegation, עם envelope_id שאינו null');
  const auditRows = await queryAudit({ businessId: BUSINESS, jobId: parent.jobId, kind: 'delegation' });
  for (const row of auditRows) {
    console.log(`  ${row.at} · envelopeId=${row.envelopeId ?? '(null)'} · ${row.reason}`);
  }
  check('יש לפחות שורת ביקורת אחת מסוג delegation', auditRows.length > 0);
  check(
    'envelope_id אינו null באף שורה — לראשונה בחיי הפרויקט שהעמודה הזו נושאת ערך',
    auditRows.length > 0 && auditRows.every((row) => row.envelopeId !== null),
  );

  // ---------------------------------------------------- CLOSE THE PARENT
  banner('שלב 5: סגירת ההורה — ידנית, בכוונה');
  console.log(
    'שום דבר בייצור עוד לא מחדש את verifyDraft עם answer שנפתר, ולכן gov.verify\n' +
      'לא רץ עד judged בפועל היום (docs/09-roadmap.md). הסקריפט הזה סוגר את משימת\n' +
      'ההורה בעצמו, כדי להוכיח שהמנגנון עד כאן שלם — לא כדי לטעון שקורא ייצור עושה זאת.',
  );
  await transition(parent.jobId, {
    to: 'verify',
    actor: 'human',
    reason: `${PROBE}: הדגמה בלבד — אין עדיין קורא שממשיך את gov.verify עם התשובה`,
    businessId: BUSINESS,
  });
  await transition(parent.jobId, {
    to: 'remember',
    actor: 'human',
    reason: `${PROBE}: אין מה לאצור — משימת ההדגמה עצמה לא קראה תוכן`,
    businessId: BUSINESS,
  });
  await transition(parent.jobId, {
    to: 'closed',
    actor: 'human',
    reason: `${PROBE}: ההדגמה הושלמה`,
    businessId: BUSINESS,
  });
  const finalParent = await loadJob(parent.jobId, { businessId: BUSINESS });
  check('ההורה הושלם (closed)', finalParent?.phase === 'closed');

  // --------------------------------------------------------------- SUMMARY
  banner('סיכום');
  if (failures.length === 0) {
    console.log('כל הבדיקות עברו. ראה את שבעת הסעיפים שהמשימה דרשה, כולם למעלה:');
    console.log('  1. שורת agent_envelopes אחת help_request ואחת result');
    console.log('  2. משימת-בת שנסגרה, עם correlationId זהה לזה של האם');
    console.log('  3. constraints של הבת מהודקות או שוות בכל שדה');
    console.log('  4. שורות audit_log מסוג delegation עם envelope_id שאינו null');
    console.log('  5. האם התעוררה והשלימה');
  } else {
    console.log(`${failures.length} בדיקות נכשלו:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

/**
 * Every job this run opened, moved to a terminal phase. The parent and the
 * child reach `closed` through the ordinary run above; this only has real
 * work to do for the "subject" job, which nothing else in this script ever
 * advances past `await_approval`, and as a safety net if the run threw
 * before reaching its own closing steps.
 */
async function cleanup(): Promise<void> {
  banner('ניקוי');
  for (const jobId of openedJobs) {
    try {
      const job = await loadJob(jobId, { businessId: BUSINESS });
      if (job === null) continue;
      if (job.phase === 'closed' || job.phase === 'failed' || job.phase === 'halted') continue;
      await transition(jobId, {
        to: 'failed',
        actor: 'human',
        reason: `${PROBE}: ניקוי הרצה חיה — לא נדרשת המשך`,
        businessId: BUSINESS,
      });
      console.log(`  ${jobId}: נסגר בניקוי`);
    } catch (err) {
      console.error(`  לא הצלחתי לנקות את ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((err: unknown) => console.error(err));
    await closePool();
  });
