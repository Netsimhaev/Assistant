/**
 * Live end-to-end run of the contact resolver, through the real planner.
 *
 *   npm run sdk:contact-resolver
 *
 * A script and not a test, for the reason every `sdk:*` script here is one:
 * it costs money and needs a key, and a suite that skips silently without one
 * reports green for work it did not do.
 *
 * What only a live run can show. The resolver itself is deterministic and
 * covered by tests that need no key — that half is not in question. What no
 * test can answer is whether the model, handed a memory block that arrived
 * because a NAME resolved rather than because an address was typed, actually
 * plans differently. Two earlier live runs on this project each found a real
 * defect no test had caught, both of them in exactly this seam: what the
 * model does with text the code assembled for it.
 *
 * It drives `runInstruction` itself rather than calling the resolver — the
 * resolver working and the resolver being wired are different claims, and the
 * wiring is the half that has broken before. The planner is passed as a
 * PASS-THROUGH SPY: it records the request and then calls the real `makePlan`,
 * so the model call is genuine and the prompt it received is observable. An
 * injected fake would prove the wiring and not the feature; no injection at
 * all would prove the feature and show nothing of what reached the model.
 *
 * Three runs, and the middle one deliberately costs nothing:
 *   A. one contact, named but not addressed  → resolves, recalls, plans.
 *   B. two contacts sharing a name           → stops and asks, model NEVER called.
 *   C. the answer narrows it, as the dashboard re-runs it → resolves, plans.
 *
 * SEED ADDRESSES MUST BE UNUSED, and this cost something to learn. The first
 * run seeded a preference under `ronit@beta-log.example` — an address the
 * curator's own live run had already written to — and replace-on-write did
 * exactly what it is specified to do: it retired the curator's real memory as
 * superseded. Soft deletion made it recoverable, but the lesson is that a
 * probe which writes to a key production data already holds is not a probe,
 * it is an edit. Every address here is unique to this script.
 *
 * SAFETY. A `planned` outcome leaves its job in `execute` with a plan bound,
 * which is precisely what `npm run scheduler` picks up and sends for real.
 * This script therefore parks every job it creates in `failed` before it
 * exits, and seeds only `.example` addresses, which cannot be delivered to.
 * Leaving a live probe's job executable would make a demonstration into an
 * outbound message nobody asked for.
 */
import { config } from '../config.js';
import { closePool, getPool } from '../db/pool.js';
import { loadActiveCharter } from '../charter/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { writeMemory, retireMemories } from '../memory/store.js';
import { listContacts } from '../memory/contacts.js';
import { resolveContacts } from '../memory/contact-resolver.js';
import { runInstruction } from '../orchestrator/instruct.js';
import { makePlan } from '../sdk/planner.js';
import type { PlanRequest, PlanOutcome } from '../sdk/planner.js';

const BUSINESS = config.businessId;

/** One person, named in the instruction but never addressed in it. */
const DANA = {
  entityId: 'dana-shapira-gamma-lift',
  email: 'dana@probe-gamma.example',
  name: 'דנה שפירא',
  company: 'גמא הרמה',
};

/** Two people who share a first name, so the name alone cannot settle it. */
const RONIT_LEVI = {
  entityId: 'ronit-levi-beta-log',
  email: 'ronit.levi@probe-beta.example',
  name: 'רונית לוי',
  company: 'בטא לוגיסטיקה',
};
const RONIT_BARAK = {
  entityId: 'ronit-barak-delta-print',
  email: 'ronit.barak@probe-delta.example',
  name: 'רונית ברק',
  company: 'דלתא דפוס',
};

const SEEDED = [DANA, RONIT_LEVI, RONIT_BARAK];

/** Jobs this run created, parked before exit so the scheduler cannot send them. */
const created: string[] = [];

function banner(title: string): void {
  console.log('');
  console.log('='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

/**
 * The planner, recorded and then really called.
 *
 * `seen` is what the prompt assembly produced — above all `memoryBlock`,
 * which is the whole question this run exists to answer.
 */
function spyPlanner(): {
  planner: (request: PlanRequest) => Promise<PlanOutcome>;
  seen: () => PlanRequest | undefined;
  calls: () => number;
} {
  let request: PlanRequest | undefined;
  let calls = 0;
  return {
    planner: async (r) => {
      request = r;
      calls += 1;
      return makePlan(r);
    },
    seen: () => request,
    calls: () => calls,
  };
}

/** A planner that proves it was never reached — run B must not cost a cent. */
const forbiddenPlanner = async (): Promise<PlanOutcome> => {
  throw new Error('the planner was called on an unresolved identity — it must not be');
};

async function seedContact(
  person: { entityId: string; email: string; name: string; company: string },
  charterVersion: string,
): Promise<void> {
  const job = await createJob({
    charterVersion,
    provenance: 'boss',
    title: `seed ${person.name}`,
    businessId: BUSINESS,
  });
  created.push(job.jobId);

  await writeMemory(
    {
      jobId: job.jobId,
      kind: 'entity',
      subjectKey: person.entityId,
      body: { name: person.name, company: person.company, email: person.email },
    },
    { businessId: BUSINESS },
  );

  // A preference stored under the ADDRESS, not the entity id — that is where
  // the curator writes, and the split between the two keys is exactly what
  // `listContacts` returning both subject keys exists to bridge (spec §8).
  await writeMemory(
    {
      jobId: job.jobId,
      kind: 'preference',
      subjectKey: person.email,
      attribute: 'ערוץ מועדף',
      body: { value: `מעדיפה שכל מה שקשור להצעות מחיר יגיע במייל ולא בטלפון (${person.company})` },
      sourceRef: 'הרצה חיה של פותר אנשי הקשר',
    },
    { businessId: BUSINESS },
  );
}

function reportOutcome(outcome: Awaited<ReturnType<typeof runInstruction>>): void {
  console.log(`status: ${outcome.status}`);
  if (outcome.status === 'needs_answer') {
    console.log(`job:    ${outcome.jobId}`);
    console.log('');
    console.log('--- השאלה שהבוס יראה ---');
    console.log(outcome.question);
    // Printed here too, not only on `planned`: this script is what measured
    // the note never reaching the owner, and it measured it by showing only
    // the question. A live run that cannot see the note cannot catch its
    // absence a second time.
    console.log(`identityNote: ${outcome.identityNote ?? '—'}`);
  } else if (outcome.status === 'planned') {
    console.log(`job:    ${outcome.jobId}`);
    console.log(`granted: ${JSON.stringify(outcome.granted)}`);
    console.log(`grantNote: ${outcome.grantNote ?? '—'}`);
    // Always `—` in this script, and printed anyway for the same reason
    // `identityNote` is printed on the branch above: a live run that cannot
    // see a note cannot notice the day it goes missing. It is non-null only
    // for text that came from a recording, which no run here produces.
    console.log(`recordingNote: ${outcome.recordingNote ?? '—'}`);
    console.log(`identityNote: ${outcome.identityNote ?? '—'}`);
  } else {
    console.log(`reason: ${outcome.reason}`);
  }
  if (outcome.status !== 'refused') created.push(outcome.jobId);
}

function reportPrompt(seen: PlanRequest | undefined, calls: number): void {
  console.log('');
  console.log(`--- מה הגיע למתכנן (קריאות למודל: ${calls}) ---`);
  if (seen === undefined) {
    console.log('(המתכנן לא נקרא כלל)');
    return;
  }
  console.log(`provenance: ${seen.provenance} · rampLevel: ${seen.rampLevel}`);
  console.log(`instruction: ${JSON.stringify(seen.instruction ?? null)}`);
  console.log('memoryBlock:');
  console.log(seen.memoryBlock === undefined || seen.memoryBlock === '' ? '  (ריק)' : seen.memoryBlock);
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

  const charter = await loadActiveCharter(BUSINESS);
  if (charter === null) {
    console.error(`אין תקנון פעיל ל-${BUSINESS}. הרץ scripts/seed-charter.ts תחילה.`);
    process.exitCode = 1;
    return;
  }

  console.log(`עסק: ${BUSINESS} · תקנון: ${charter.bundle.charterVersion}`);

  banner('הכנה: זריעת שלושה אנשי קשר');
  for (const person of SEEDED) {
    await seedContact(person, charter.bundle.charterVersion);
    console.log(`  ${person.name} · ${person.company} · ${person.email}`);
  }

  const contacts = await listContacts({ businessId: BUSINESS });
  console.log(`\nרשימת המועמדים שנבנתה: ${contacts.length} אנשי קשר`);

  // ---------------------------------------------------------------- RUN A
  banner('A · שם בלבד, אדם אחד — ההוראה מסתיימת בנקודה');
  const textA = 'תשיבי לדנה שפירא ואשרי שקיבלנו את הצעת המחיר.';
  console.log(`ההוראה: ${textA}`);

  // The deterministic half, shown before the model sees anything, so the
  // model's behaviour cannot be confused with the matcher's.
  const resA = resolveContacts(textA, contacts);
  console.log(`הפותר: subjects=${JSON.stringify(resA.subjects)} ambiguities=${resA.ambiguities.length}`);

  const spyA = spyPlanner();
  const startedA = Date.now();
  // `textOrigin: 'typed'` — this script types its own instructions, exactly
  // as the dashboard box does. The option is required and has no default
  // (see `RunInstructionOptions`), so a script is made to state it too.
  const outA = await runInstruction(
    { text: textA },
    { businessId: BUSINESS, textOrigin: 'typed', planner: spyA.planner },
  );
  console.log(`\n(${((Date.now() - startedA) / 1000).toFixed(1)}s)`);
  reportOutcome(outA);
  reportPrompt(spyA.seen(), spyA.calls());

  // ---------------------------------------------------------------- RUN B
  banner('B · שם שמתאים לשתי נשים — חייבת לעצור, בלי לשלם על קריאה');
  const textB = 'תשיבי לרונית.';
  console.log(`ההוראה: ${textB}`);

  const resB = resolveContacts(textB, contacts);
  console.log(`הפותר: subjects=${JSON.stringify(resB.subjects)} ambiguities=${resB.ambiguities.length}`);

  const outB = await runInstruction(
    { text: textB },
    { businessId: BUSINESS, textOrigin: 'typed', planner: forbiddenPlanner },
  );
  reportOutcome(outB);
  console.log('');
  console.log('המתכנן לא נקרא — ההוראה נעצרה לפניו, ולכן ההרצה הזו לא עלתה כלום.');

  // ---------------------------------------------------------------- RUN C
  banner('C · הבוס עונה, והתשובה מצמצמת — בדיוק כפי שהדשבורד מריץ מחדש');
  const answer = 'רונית מבטא לוגיסטיקה';
  const textC = `${textB}\n\n${answer}`;
  console.log(`ההוראה + התשובה: ${JSON.stringify(textC)}`);

  const resC = resolveContacts(textC, contacts);
  console.log(`הפותר: subjects=${JSON.stringify(resC.subjects)} ambiguities=${resC.ambiguities.length}`);

  const spyC = spyPlanner();
  const startedC = Date.now();
  const outC = await runInstruction(
    { text: textC },
    { businessId: BUSINESS, textOrigin: 'typed', identityAsked: true, planner: spyC.planner },
  );
  console.log(`\n(${((Date.now() - startedC) / 1000).toFixed(1)}s)`);
  reportOutcome(outC);
  reportPrompt(spyC.seen(), spyC.calls());

  // ------------------------------------------------------------- THE PLANS
  banner('התוכניות שנקשרו בפועל');
  const plans = await getPool().query<{ job_id: string; plan: unknown }>(
    `SELECT job_id, plan FROM job_plans WHERE business_id = $1 AND job_id = ANY($2::text[])`,
    [BUSINESS, created],
  );
  if (plans.rows.length === 0) console.log('(אף תוכנית לא נקשרה)');
  for (const row of plans.rows) {
    console.log(`\n${row.job_id}:`);
    console.log(JSON.stringify(row.plan, null, 2));
  }
}

/**
 * Park every job and retire every memory this run created.
 *
 * Not tidiness. A `planned` job sits in `execute` with a plan bound, and that
 * is what the scheduler executes — a demonstration left behind that way turns
 * into a real outbound message the first time anyone starts the scheduler.
 * Each failure here is reported and none stops the rest, because a cleanup
 * that gives up halfway leaves exactly the state it was written to prevent.
 */
async function cleanup(): Promise<void> {
  banner('ניקוי');
  for (const jobId of created) {
    try {
      await transition(jobId, {
        to: 'failed',
        actor: 'human',
        reason: 'live contact-resolver probe: parked so nothing executes',
        businessId: BUSINESS,
      });
    } catch (err) {
      console.error(`  לא הצלחתי לעצור את ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`נעצרו ${created.length} משימות.`);

  for (const person of SEEDED) {
    for (const target of [
      { kind: 'entity' as const, subjectKey: person.entityId, attribute: null },
      { kind: 'preference' as const, subjectKey: person.email, attribute: 'ערוץ מועדף' },
    ]) {
      try {
        await retireMemories(
          { ...target, reason: 'live contact-resolver probe: seeded data' },
          { businessId: BUSINESS },
        );
      } catch (err) {
        console.error(`  לא הצלחתי לגרוע ${target.subjectKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  console.log('הזיכרונות שנזרעו נגרעו (גריעה רכה — השורות נשארות, מסומנות).');
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
