import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import type { CharterConnection } from '../domain/connection.js';
import { loadPlanBody } from './plan-store.js';
import { loadInstructionForJob } from '../governance/instructions.js';
import { createJob } from './jobs.js';
import { writeMemory } from '../memory/store.js';
import { runInstruction } from './instruct.js';
import type { Plan } from '../domain/plan.js';
import type { PlanRequest } from '../sdk/planner.js';

const BUSINESS = 'test-business';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

function mailPlan(to: string): Plan {
  return {
    goal: 'לשלוח לדנה את ההצעה',
    assumptions: [],
    clarifyingQuestion: null,
    estimatedCostMinor: 0,
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'לשלוח את ההצעה',
        toolName: 'mail.send',
        input: { to, subject: 'הצעה', body: 'מצורף' },
        dependsOn: [],
        expectedActionClass: 'email.initiate',
      },
    ],
  };
}

async function withCharter(): Promise<void> {
  await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
    businessId: BUSINESS,
  });
}

describe('runInstruction', () => {
  beforeEach(async () => {
    await resetDatabase();
    await withCharter();
  });

  afterAll(async () => {
    await closePool();
  });

  it('opens a boss job, stores the instruction, binds the plan', async () => {
    const result = await runInstruction(
      { text: 'תשלחי ל-dana@example.com את ההצעה' },
      { textOrigin: 'typed', businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('unreachable');

    const jobs = await getPool().query<{ provenance: string; phase: string }>(
      `SELECT provenance, phase FROM jobs WHERE job_id = $1`,
      [result.jobId],
    );
    expect(jobs.rows[0]?.provenance).toBe('boss');
    expect(jobs.rows[0]?.phase).toBe('execute');

    expect(await loadPlanBody(result.jobId, { businessId: BUSINESS })).not.toBeNull();
    const stored = await loadInstructionForJob(result.jobId, { businessId: BUSINESS });
    expect(stored?.text).toBe('תשלחי ל-dana@example.com את ההצעה');
  });

  it('grants a standing authorisation for the address the owner typed', async () => {
    const result = await runInstruction(
      { text: 'תשלחי ל-dana@example.com את ההצעה' },
      { textOrigin: 'typed', businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
    );
    if (result.status !== 'planned') throw new Error('unreachable');

    expect(result.granted).toEqual([
      { actionClass: 'email.initiate', recipients: ['dana@example.com'] },
    ]);

    const { rows } = await getPool().query<{ action_class: string; recipients: string[] }>(
      `SELECT action_class, recipients FROM job_authorizations WHERE job_id = $1`,
      [result.jobId],
    );
    expect(rows[0]?.action_class).toBe('email.initiate');
    expect(rows[0]?.recipients).toEqual(['dana@example.com']);

    // M4, the other half: nothing anywhere pinned `grantNote` to `null` on
    // the ordinary single-class path, so a bug that produced the multi-class
    // note here — and sent the owner a sentence saying no authorisation was
    // given, next to one that was — would have gone unnoticed.
    expect(result.grantNote).toBeNull();
  });

  it('grants nothing when the owner never named the address', async () => {
    const result = await runInstruction(
      { text: 'תשלחי לדנה את ההצעה' },
      { textOrigin: 'typed', businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
    );
    if (result.status !== 'planned') throw new Error('unreachable');

    // The job still runs — the step simply takes the ordinary approval path.
    expect(result.granted).toEqual([]);
    const { rows } = await getPool().query(`SELECT 1 FROM job_authorizations`);
    expect(rows).toHaveLength(0);
  });

  it('waits for an answer instead of planning when the planner asks', async () => {
    const asking: Plan = { ...mailPlan('x@example.com'), clarifyingQuestion: 'איזו דנה?' };
    const result = await runInstruction(
      { text: 'תשלחי לדנה את ההצעה' },
      { textOrigin: 'typed', businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: asking }) },
    );

    expect(result.status).toBe('needs_answer');
    if (result.status !== 'needs_answer') throw new Error('unreachable');
    expect(result.question).toBe('איזו דנה?');

    // Nothing bound, and the job is still where a question leaves it — a
    // question is not a plan, so it never reaches `plan` or `execute`.
    // (`not.toBe('execute')` would also be satisfied by `undefined` if no row
    // existed at all — assert the actual phase, not the absence of one value.)
    expect(await loadPlanBody(result.jobId, { businessId: BUSINESS })).toBeNull();
    const jobs = await getPool().query<{ phase: string }>(
      `SELECT phase FROM jobs WHERE job_id = $1`,
      [result.jobId],
    );
    expect(jobs.rows[0]?.phase).toBe('understand');
    const auths = await getPool().query(`SELECT 1 FROM job_authorizations`);
    expect(auths.rows).toHaveLength(0);

    // I3: the question is written down, not merely returned. Without this
    // row it lives only in the HTTP response that carried it, and a reload
    // orphans the job in `understand` with the owner unable to see what they
    // were asked.
    const stored = await loadInstructionForJob(result.jobId, { businessId: BUSINESS });
    expect(stored?.question).toBe('איזו דנה?');
    expect(result.instructionText).toBe('תשלחי לדנה את ההצעה');
  });

  it('refuses an unparseable plan without opening anything runnable', async () => {
    const result = await runInstruction(
      { text: 'תשלחי לדנה' },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        planner: async () => ({ status: 'unparseable', raw: '{{', reason: 'bad json' }),
      },
    );

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    const { rows } = await getPool().query(`SELECT 1 FROM job_authorizations`);
    expect(rows).toHaveLength(0);
    // A refusal that leaves the job anywhere but `failed` is a job nothing in
    // production ever revisits. Deleting the `→ failed` transition would
    // still leave this test green without this assertion.
    const jobs = await getPool().query<{ phase: string }>(`SELECT phase FROM jobs`);
    expect(jobs.rows[0]?.phase).toBe('failed');
  });

  it('refuses a plan whose steps do not form a DAG', async () => {
    const cyclic: Plan = {
      ...mailPlan('dana@example.com'),
      steps: [
        { ...mailPlan('dana@example.com').steps[0]!, id: 's1', dependsOn: ['s2'] },
        { ...mailPlan('dana@example.com').steps[0]!, id: 's2', dependsOn: ['s1'] },
      ],
    };
    const result = await runInstruction(
      { text: 'תשלחי לדנה' },
      { textOrigin: 'typed', businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: cyclic }) },
    );

    expect(result.status).toBe('refused');
    expect(await getPool().query(`SELECT 1 FROM job_plans`).then((r) => r.rows)).toHaveLength(0);
    // Same reasoning as the unparseable-plan test above: without this, the
    // `→ failed` transition on the DAG-rejection path could be deleted and
    // this test would not notice.
    const jobs = await getPool().query<{ phase: string }>(`SELECT phase FROM jobs`);
    expect(jobs.rows[0]?.phase).toBe('failed');
  });

  it('refuses when no charter is installed', async () => {
    await resetDatabase();
    const result = await runInstruction(
      { text: 'תשלחי לדנה' },
      { textOrigin: 'typed', businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
    );
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    // Without this, removing the `active === null` guard entirely still
    // passes: `active.charter` throws instead, which is a refusal by
    // rejection rather than the deliberate one this function returns. The
    // exact reason is what tells the two apart.
    expect(result.reason).toBe('אין תקנון פעיל — המתכנן נשען על הקטלוג והתקרות שבו.');
  });

  it('refuses an empty instruction', async () => {
    let called = false;
    const result = await runInstruction(
      { text: '   ' },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        planner: async () => {
          called = true;
          return { status: 'planned', plan: mailPlan('dana@example.com') };
        },
      },
    );

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.reason).toBe('ההוראה ריקה.');
    expect(called).toBe(false);
    const jobs = await getPool().query(`SELECT 1 FROM jobs`);
    expect(jobs.rows).toHaveLength(0);
  });

  it('grants nothing and explains why when a plan spans more than one action class', async () => {
    const twoClassPlan: Plan = {
      goal: 'לשלוח לדנה את ההצעה ולקבוע איתה פגישה',
      assumptions: [],
      clarifyingQuestion: null,
      estimatedCostMinor: 0,
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'לשלוח את ההצעה',
          toolName: 'mail.send',
          input: { to: 'dana@example.com', subject: 'הצעה', body: 'מצורף' },
          dependsOn: [],
          expectedActionClass: 'email.initiate',
        },
        {
          id: 's2',
          agent: 'sched.meetings',
          intent: 'לקבוע פגישה',
          toolName: 'calendar.write',
          input: { to: 'dana@example.com', when: 'יום שלישי' },
          dependsOn: [],
          expectedActionClass: 'calendar.create',
        },
      ],
    };

    const result = await runInstruction(
      { text: 'תשלחי ל-dana@example.com את ההצעה ותקבעי איתה פגישה ביום שלישי' },
      { textOrigin: 'typed', businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: twoClassPlan }) },
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('unreachable');

    // Zero grants, not a thrown AuthorizationAlreadyGrantedError out of a
    // function typed to return an outcome, and not a silent pick of whichever
    // class happened to sort first.
    expect(result.granted).toEqual([]);
    // M4: `not.toBeNull()` is satisfied by `undefined`, so the assertion held
    // whether or not the field was ever set. Pinned to the sentence the owner
    // actually reads instead.
    expect(result.grantNote).toContain('ביותר מסוג פעולה אחד שאתה נקבת בנמען שלו');

    const { rows } = await getPool().query(`SELECT 1 FROM job_authorizations WHERE job_id = $1`, [
      result.jobId,
    ]);
    expect(rows).toHaveLength(0);

    // The plan still ran — only the shortcut was withheld, not the job.
    const jobs = await getPool().query<{ phase: string }>(`SELECT phase FROM jobs WHERE job_id = $1`, [
      result.jobId,
    ]);
    expect(jobs.rows[0]?.phase).toBe('execute');
  });

  it('grants a standing authorisation for a phone number the owner typed, for a WhatsApp step', async () => {
    const waPlan: Plan = {
      goal: 'לשלוח לדנה הודעת וואטסאפ',
      assumptions: [],
      clarifyingQuestion: null,
      estimatedCostMinor: 0,
      steps: [
        {
          id: 's1',
          agent: 'comms.whatsapp',
          intent: 'לשלוח הודעה',
          toolName: 'wa.send_message',
          input: { toNumber: '0521234567', body: 'מצורף' },
          dependsOn: [],
          expectedActionClass: 'whatsapp.initiate',
        },
      ],
    };

    const result = await runInstruction(
      { text: 'תשלחי לה וואטסאפ למספר 0521234567' },
      { textOrigin: 'typed', businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: waPlan }) },
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('unreachable');

    // Same reader (`readPhones`) on both the grant side (`grantForPlan`,
    // here) and the check side (`coveredByAuthorization`) — the symmetry the
    // interfaces section calls out — proven by the suite rather than by
    // reading the two call sites side by side.
    expect(result.granted).toEqual([
      { actionClass: 'whatsapp.initiate', recipients: ['0521234567'] },
    ]);

    const { rows } = await getPool().query<{ action_class: string; recipients: string[] }>(
      `SELECT action_class, recipients FROM job_authorizations WHERE job_id = $1`,
      [result.jobId],
    );
    expect(rows[0]?.action_class).toBe('whatsapp.initiate');
    expect(rows[0]?.recipients).toEqual(['0521234567']);
  });

  it('refuses an over-long instruction before creating anything', async () => {
    let called = false;
    const result = await runInstruction(
      { text: 'א'.repeat(4001) },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        planner: async () => {
          called = true;
          return { status: 'planned', plan: mailPlan('dana@example.com') };
        },
      },
    );

    expect(result.status).toBe('refused');
    expect(called, 'the cap exists to stop a paste before it costs money').toBe(false);
    // The planner not being called was always true, because saveInstruction
    // enforces the same cap and throws first regardless of this function's
    // own check. What the check in runInstruction actually buys is that no
    // job is created at all for an over-long paste, rather than a job row
    // that gets created and then has to be marked failed.
    const jobs = await getPool().query(`SELECT 1 FROM jobs`);
    expect(jobs.rows).toHaveLength(0);
  });

  it('transitions to failed and refuses when the planner throws', async () => {
    // makePlan returns {status:'unparseable'} for bad model OUTPUT, but a
    // missing API key, an HTTP error, or a dropped connection throws instead
    // — the ordinary failure mode of a network call. Left uncaught, the job
    // would sit in `understand` forever, a phase nothing in production reads.
    const result = await runInstruction(
      { text: 'תשלחי לדנה' },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        planner: async () => {
          throw new Error('network is down');
        },
      },
    );

    expect(result.status).toBe('refused');
    const jobs = await getPool().query<{ phase: string }>(`SELECT phase FROM jobs`);
    expect(jobs.rows[0]?.phase).toBe('failed');
  });

  it('refuses a class-mismatched step before anything is bound or granted', async () => {
    // The planner declares `email.reply`, but the step's input carries no
    // `inReplyTo` — the gate would classify this as `email.initiate`, a
    // plausible slip when the owner said "answer Dana". Left unchecked here,
    // this reaches `execute` and is rejected by `runPlan` on every pass
    // thereafter, and `runDueJobs` never moves a job off a rejection like
    // that — the same starvation `unbound` already documents for its own case.
    const mismatchedPlan: Plan = {
      goal: 'לענות לדנה',
      assumptions: [],
      clarifyingQuestion: null,
      estimatedCostMinor: 0,
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'לענות לדנה',
          toolName: 'mail.send',
          input: { to: 'dana@example.com', subject: 'תשובה', body: 'תודה' },
          dependsOn: [],
          expectedActionClass: 'email.reply',
        },
      ],
    };

    const result = await runInstruction(
      { text: 'תעני לדנה' },
      { textOrigin: 'typed', businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mismatchedPlan }) },
    );

    expect(result.status).toBe('refused');
    const auths = await getPool().query(`SELECT 1 FROM job_authorizations`);
    expect(auths.rows).toHaveLength(0);
    const plans = await getPool().query(`SELECT 1 FROM job_plans`);
    expect(plans.rows).toHaveLength(0);
    const jobs = await getPool().query<{ phase: string }>(`SELECT phase FROM jobs`);
    expect(jobs.rows[0]?.phase).toBe('failed');
  });

  /**
   * The chain instruction -> subjects -> recall -> prompt, proven end to end
   * rather than in pieces: `planner.test.ts` proves `buildPlannerPrompt`
   * places an already-built string correctly, which says nothing about
   * whether `instruct.ts` ever builds one. Capturing the real `PlanRequest`
   * the injected planner receives is what makes deleting the recall call
   * fail this test rather than leaving the suite green.
   */
  it('passes the planner a memory block for an address the instruction names', async () => {
    const active = await loadActiveCharter(BUSINESS);
    if (active === null) throw new Error('unreachable');
    const seedJob = await createJob({
      charterVersion: active.charter.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'preference',
        subjectKey: 'ronit@beta-log.example',
        attribute: 'ערוץ מועדף',
        body: { value: 'טלפון' },
      },
      { businessId: BUSINESS },
    );

    const captured: { request: PlanRequest | null } = { request: null };
    const result = await runInstruction(
      { text: 'תשיבי לרונית בכתובת ronit@beta-log.example' },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        planner: async (request) => {
          captured.request = request;
          return { status: 'planned', plan: mailPlan('ronit@beta-log.example') };
        },
      },
    );

    expect(result.status).toBe('planned');
    expect(captured.request?.memoryBlock).toContain('טלפון');
  });

  /**
   * Spec §6: a name that fits more than one contact must stop the job before
   * anything is planned or sent, not narrow to a guess.
   */
  it('stops and asks when a name fits two contacts, and plans nothing', async () => {
    const active = await loadActiveCharter(BUSINESS);
    if (active === null) throw new Error('unreachable');
    const seedJob = await createJob({
      charterVersion: active.charter.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    // Two-word names, matching the fixtures `contact-resolver.test.ts` already
    // uses for this exact pair — a single-word name would collide with itself
    // in `namePartsOf` (full name === its only part) and is not this test's
    // concern.
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-cohen-beta-log',
        body: { name: 'רונית כהן', company: 'בטא לוגיסטיקה' },
      },
      { businessId: BUSINESS },
    );
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-levi-gamma',
        body: { name: 'רונית לוי', company: 'גמא הרמה' },
      },
      { businessId: BUSINESS },
    );

    const outcome = await runInstruction(
      { text: 'תשיבי לרונית' },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        planner: async () => {
          throw new Error('the planner must not be called when the identity is unresolved');
        },
      },
    );

    expect(outcome.status).toBe('needs_answer');
    if (outcome.status !== 'needs_answer') return;
    expect(outcome.question).toContain('רונית');
    // Both distinguishing details are offered, so the owner can answer in a word.
    expect(outcome.question).toContain('בטא לוגיסטיקה');
    expect(outcome.question).toContain('גמא הרמה');

    // Nothing bound — the same resting place the planner's own question uses.
    expect(await loadPlanBody(outcome.jobId, { businessId: BUSINESS })).toBeNull();
    const jobs = await getPool().query<{ phase: string }>(`SELECT phase FROM jobs WHERE job_id = $1`, [
      outcome.jobId,
    ]);
    expect(jobs.rows[0]?.phase).toBe('understand');
  });

  /**
   * Spec §6: when neither candidate has a company or an address to tell them
   * apart, offering their bare names twice is a question with no answer. The
   * owner must be told what actually works instead — typing the address,
   * which both identifies the person and authorises writing to them.
   */
  it('tells the owner to type the address when neither candidate has a distinguishing detail', async () => {
    const active = await loadActiveCharter(BUSINESS);
    if (active === null) throw new Error('unreachable');
    const seedJob = await createJob({
      charterVersion: active.charter.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-cohen-nodetail',
        body: { name: 'רונית כהן' },
      },
      { businessId: BUSINESS },
    );
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-levi-nodetail',
        body: { name: 'רונית לוי' },
      },
      { businessId: BUSINESS },
    );

    const outcome = await runInstruction(
      { text: 'תשיבי לרונית' },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        planner: async () => {
          throw new Error('the planner must not be called when the identity is unresolved');
        },
      },
    );

    expect(outcome.status).toBe('needs_answer');
    if (outcome.status !== 'needs_answer') return;
    expect(outcome.question).toContain('רונית');
    expect(outcome.question).toContain('כתובת');
  });

  /**
   * A name that resolves to exactly one contact must feed that contact's
   * memory to the planner — proven end to end, as the neighbouring test above
   * proves the typed-address path, so deleting the resolver call fails this
   * test rather than leaving the suite green.
   */
  it('resolves a name to memory and hands it to the planner', async () => {
    const active = await loadActiveCharter(BUSINESS);
    if (active === null) throw new Error('unreachable');
    const seedJob = await createJob({
      charterVersion: active.charter.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-cohen-beta-log',
        body: { name: 'רונית כהן', company: 'בטא לוגיסטיקה', email: 'ronit@beta-log.example' },
      },
      { businessId: BUSINESS },
    );
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'preference',
        subjectKey: 'ronit@beta-log.example',
        attribute: 'ערוץ מועדף',
        body: { value: 'טלפון' },
      },
      { businessId: BUSINESS },
    );

    let seen: PlanRequest | undefined;
    const result = await runInstruction(
      { text: 'תשיבי לרונית' },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        planner: async (request) => {
          seen = request;
          return { status: 'planned', plan: mailPlan('ronit@beta-log.example') };
        },
      },
    );

    expect(result.status).toBe('planned');
    // The value can only have reached the planner via the preference row
    // seeded above, keyed under the contact's own address — no other path in
    // this test produces the word "טלפון".
    expect(seen?.memoryBlock ?? '').toContain('טלפון');
  });

  /**
   * Spec §7.2: the identity question is asked once per chain. Once the
   * dashboard's answer route has re-run the instruction, an unresolved name
   * must not stop the job a second time — it proceeds with no memory instead.
   */
  it('does not ask a second time once an answer has come back', async () => {
    const active = await loadActiveCharter(BUSINESS);
    if (active === null) throw new Error('unreachable');
    const seedJob = await createJob({
      charterVersion: active.charter.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-cohen-beta-log',
        body: { name: 'רונית כהן', company: 'בטא לוגיסטיקה' },
      },
      { businessId: BUSINESS },
    );
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-levi-gamma',
        body: { name: 'רונית לוי', company: 'גמא הרמה' },
      },
      { businessId: BUSINESS },
    );

    const outcome = await runInstruction(
      { text: 'תשיבי לרונית\n\nאני לא זוכר' },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        identityAsked: true,
        planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }),
      },
    );

    expect(outcome.status).not.toBe('needs_answer');
  });

  /**
   * Spec §7.2 has two halves — she proceeds without memory **and states
   * that** ("ומציינת זאת") — and only the first was implemented. An owner
   * who has already been asked once, and whose answer did not settle it,
   * otherwise believes their memory was taken into account when it was not.
   * The sentence must also say what actually works: giving the address.
   */
  it('says so when it proceeds without memory after an answer', async () => {
    const active = await loadActiveCharter(BUSINESS);
    if (active === null) throw new Error('unreachable');
    const seedJob = await createJob({
      charterVersion: active.charter.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-cohen-beta-log',
        body: { name: 'רונית כהן', company: 'בטא לוגיסטיקה' },
      },
      { businessId: BUSINESS },
    );
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-levi-gamma',
        body: { name: 'רונית לוי', company: 'גמא הרמה' },
      },
      { businessId: BUSINESS },
    );

    const outcome = await runInstruction(
      { text: 'תשיבי לרונית\n\nאני לא זוכר' },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        identityAsked: true,
        planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }),
      },
    );

    expect(outcome.status).toBe('planned');
    if (outcome.status !== 'planned') throw new Error('unreachable');
    expect(outcome.identityNote).not.toBeNull();
    expect(outcome.identityNote ?? '').toContain('רונית');
    // The one thing the owner can do about it.
    expect(outcome.identityNote ?? '').toContain('כתובת');
  });

  /**
   * The negative half: a note that is present on every planned instruction
   * tells the owner nothing. An instruction naming nobody ambiguous carries
   * no note at all.
   */
  it('carries no identity note when nothing was ambiguous', async () => {
    const outcome = await runInstruction(
      { text: 'תשלחי ל-dana@example.com את ההצעה' },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }),
      },
    );

    expect(outcome.status).toBe('planned');
    if (outcome.status !== 'planned') throw new Error('unreachable');
    expect(outcome.identityNote).toBeNull();
  });

  /**
   * Spec §10, row 1: "קריאת הזיכרון נכשלת → ההוראה ממשיכה בלי זיכרון ובלי
   * שאלה". Deleting the `try/catch` around `listContacts` left the whole
   * suite green, so the degrade path was documented and unproven.
   *
   * The failure is made real rather than injected: the table the read needs
   * is renamed out from under it for the duration, so `listContacts` throws
   * the way it would if the read genuinely failed, and it is put back in
   * `finally` so a failing assertion cannot leak into the next test. With
   * the catch removed, the throw escapes `runInstruction` and this test
   * fails on the rejection instead of the assertions.
   */
  it('plans anyway when the contact read fails, and asks nothing', async () => {
    await getPool().query('ALTER TABLE memories RENAME TO memories_hidden');
    try {
      const outcome = await runInstruction(
        { text: 'תשיבי לרונית' },
        {
          textOrigin: 'typed',
          businessId: BUSINESS,
          planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }),
        },
      );

      expect(outcome.status).toBe('planned');
      if (outcome.status !== 'planned') throw new Error('unreachable');
      // No question, and nothing claiming a name went unresolved: a failed
      // read means nothing was recognised, which is not the same as
      // recognising something ambiguous.
      expect(outcome.identityNote).toBeNull();
    } finally {
      await getPool().query('ALTER TABLE memories_hidden RENAME TO memories');
    }
  });

  /**
   * The other half of the same row: the planner really is handed no memory
   * block when the read fails, rather than a stale or partial one.
   */
  it('hands the planner no memory block when the contact read fails', async () => {
    await getPool().query('ALTER TABLE memories RENAME TO memories_hidden');
    try {
      let seen: PlanRequest | undefined;
      const outcome = await runInstruction(
        { text: 'תשיבי לרונית' },
        {
          textOrigin: 'typed',
          businessId: BUSINESS,
          planner: async (request) => {
            seen = request;
            return { status: 'planned', plan: mailPlan('dana@example.com') };
          },
        },
      );

      expect(outcome.status).toBe('planned');
      expect(seen?.memoryBlock).toBeUndefined();
    } finally {
      await getPool().query('ALTER TABLE memories_hidden RENAME TO memories');
    }
  });
});

/**
 * F-live-2. `identityNote` rode only the `planned` outcome, and the case that
 * actually happens is the other one: when a name stays unresolved the memory
 * block is empty, and a planner handed no context is MORE likely to come back
 * with a clarifying question of its own — so the instruction ends as
 * `needs_answer` and the note is never rendered. Measured live: the owner was
 * asked a generic question about רונית and told nothing about the name not
 * having been recognised. The two co-occur precisely because the missing
 * memory is what produced the question.
 */
describe('saying she went ahead without the memory when the planner asks too', () => {
  beforeEach(async () => {
    await resetDatabase();
    await withCharter();
  });

  afterAll(async () => {
    await closePool();
  });

  /** Two people called רונית, so the name cannot be settled from contacts alone. */
  async function seedTwoRonits(): Promise<void> {
    const active = await loadActiveCharter(BUSINESS);
    if (active === null) throw new Error('unreachable');
    const seedJob = await createJob({
      charterVersion: active.charter.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-cohen-beta-log',
        body: { name: 'רונית כהן', company: 'בטא לוגיסטיקה' },
      },
      { businessId: BUSINESS },
    );
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-levi-gamma',
        body: { name: 'רונית לוי', company: 'גמא הרמה' },
      },
      { businessId: BUSINESS },
    );
  }

  it('carries the identity note on the planner s own clarifying question', async () => {
    await seedTwoRonits();

    const outcome = await runInstruction(
      { text: 'תשיבי לרונית\n\nאני לא זוכר' },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        identityAsked: true,
        planner: async () => ({
          status: 'planned',
          plan: { ...mailPlan('dana@example.com'), clarifyingQuestion: 'על איזו הצעה מדובר?' },
        }),
      },
    );

    expect(outcome.status).toBe('needs_answer');
    if (outcome.status !== 'needs_answer') throw new Error('unreachable');
    expect(outcome.question).toBe('על איזו הצעה מדובר?');
    // `?? ''` rather than `.not.toBeNull()`: an absent field is `undefined`,
    // which is not null, so the looser assertion would have passed against
    // the very defect this test exists for.
    expect(outcome.identityNote ?? '').toContain('רונית');
    expect(outcome.identityNote ?? '').toContain('כתובת');
  });

  /**
   * The identity question's own early return is the opposite case: that
   * question IS the notice, so a note repeating it would be noise.
   */
  it('carries no identity note on the identity question itself', async () => {
    await seedTwoRonits();

    const outcome = await runInstruction(
      { text: 'תשיבי לרונית' },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        planner: async () => {
          throw new Error('the planner must not be reached on the identity question');
        },
      },
    );

    expect(outcome.status).toBe('needs_answer');
    if (outcome.status !== 'needs_answer') throw new Error('unreachable');
    expect(outcome.question).toContain('רונית');
    expect(outcome.identityNote).toBeNull();
  });
});

/**
 * Owner's decision 2 (05/10/2026), end to end through the whole door: a clear
 * transcript authorises the ACTION; an address that appears only in a
 * recording needs his explicit word, and he is told so.
 *
 * `instruct.ts` is where both halves land — the grant is withheld here and
 * the sentence is composed here — so this is the layer where "the instruction
 * still runs, only the shortcut is withheld" can actually be observed rather
 * than inferred from a filter's return value.
 */
describe('an instruction whose text came from a recording', () => {
  const SPOKEN = 'תשלחי ל-dana@example.com את ההצעה';

  beforeEach(async () => {
    await resetDatabase();
    await withCharter();
  });

  afterAll(async () => {
    await closePool();
  });

  async function authorisationRows(jobId: string): Promise<Array<{ recipients: string[] }>> {
    const { rows } = await getPool().query<{ recipients: string[] }>(
      `SELECT recipients FROM job_authorizations WHERE job_id = $1`,
      [jobId],
    );
    return rows;
  }

  it('plans the instruction but authorises nobody, and names who needs confirming', async () => {
    const result = await runInstruction(
      { text: SPOKEN },
      {
        textOrigin: 'transcribed',
        businessId: BUSINESS,
        planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }),
      },
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('unreachable');

    // Withheld — this is the defect itself. The identical call with
    // `textOrigin: 'typed'` is the first test in this file and it grants.
    expect(result.granted).toEqual([]);
    expect(await authorisationRows(result.jobId)).toHaveLength(0);

    // And SAID, which is the owner's other half. A silent withholding is the
    // branch's own recurring defect: he speaks an instruction, watches it be
    // planned, and later meets an approval card for a recipient he believes
    // he already named.
    expect(result.recordingNote).not.toBeNull();
    expect(result.recordingNote).toContain('dana@example.com');
    expect(result.recordingNote).toContain('הקלטה');
    expect(result.recordingNote).toContain('אישור מפורש');

    // The ACTION is still authorised in the owner's sense: the job was
    // planned, bound and promoted exactly as a typed one is. Only who may be
    // contacted changed.
    const jobs = await getPool().query<{ phase: string }>(
      `SELECT phase FROM jobs WHERE job_id = $1`,
      [result.jobId],
    );
    expect(jobs.rows[0]?.phase).toBe('execute');
    expect(await loadPlanBody(result.jobId, { businessId: BUSINESS })).not.toBeNull();

    // Stored on the row, not merely used in passing: the next hop (an answer
    // joined onto this text) reads it back, and without the column a typed
    // answer would relabel this instruction as typed.
    const stored = await loadInstructionForJob(result.jobId, { businessId: BUSINESS });
    expect(stored?.textOrigin).toBe('transcribed');
  });

  it('says nothing about a recording when the owner typed the instruction', async () => {
    const result = await runInstruction(
      { text: SPOKEN },
      {
        textOrigin: 'typed',
        businessId: BUSINESS,
        planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }),
      },
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('unreachable');
    // The paired negative: the note must be absent here, or it says nothing
    // when it is present. A version that set it unconditionally would pass
    // the test above and fail this one.
    expect(result.recordingNote).toBeNull();
    expect(result.granted).toHaveLength(1);
    const stored = await loadInstructionForJob(result.jobId, { businessId: BUSINESS });
    expect(stored?.textOrigin).toBe('typed');
  });

  it('still authorises a counterparty the charter knows, and says nothing', async () => {
    // A second charter version, so `knownCounterparties` really carries the
    // domain the plan addresses. Authority from a signature is not authority
    // from today's keystrokes: it survives a recording, and over-tightening
    // here — gating the whole filter on the origin instead of the verbatim
    // arm — fails this test while the first one above stays green.
    await installCharter(
      buildCharter({
        version: '2026-08-15.2',
        connections: [MAIL_CONNECTION],
        knownCounterpartyEmailDomain: 'example.com',
      }),
      { businessId: BUSINESS },
    );

    const result = await runInstruction(
      // No address in the text at all, so nothing but the charter can
      // authorise this recipient.
      { text: 'תשלחי לדנה את ההצעה' },
      {
        textOrigin: 'transcribed',
        businessId: BUSINESS,
        planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }),
      },
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('unreachable');
    expect(result.granted).toEqual([
      { actionClass: 'email.initiate', recipients: ['dana@example.com'] },
    ]);
    expect(await authorisationRows(result.jobId)).toHaveLength(1);
    // Nothing was withheld, so there is nothing to say. A note here would
    // send the owner looking for a confirmation that is not pending.
    expect(result.recordingNote).toBeNull();
  });
});
