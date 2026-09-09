import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import type { CharterConnection } from '../domain/connection.js';
import { loadPlanBody } from './plan-store.js';
import { loadInstructionForJob } from '../governance/instructions.js';
import { runInstruction } from './instruct.js';
import type { Plan } from '../domain/plan.js';

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
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
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
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
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
  });

  it('grants nothing when the owner never named the address', async () => {
    const result = await runInstruction(
      { text: 'תשלחי לדנה את ההצעה' },
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
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
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: asking }) },
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
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: cyclic }) },
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
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
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
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: twoClassPlan }) },
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('unreachable');

    // Zero grants, not a thrown AuthorizationAlreadyGrantedError out of a
    // function typed to return an outcome, and not a silent pick of whichever
    // class happened to sort first.
    expect(result.granted).toEqual([]);
    expect(result.grantNote).not.toBeNull();

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
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: waPlan }) },
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
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mismatchedPlan }) },
    );

    expect(result.status).toBe('refused');
    const auths = await getPool().query(`SELECT 1 FROM job_authorizations`);
    expect(auths.rows).toHaveLength(0);
    const plans = await getPool().query(`SELECT 1 FROM job_plans`);
    expect(plans.rows).toHaveLength(0);
    const jobs = await getPool().query<{ phase: string }>(`SELECT phase FROM jobs`);
    expect(jobs.rows[0]?.phase).toBe('failed');
  });
});
