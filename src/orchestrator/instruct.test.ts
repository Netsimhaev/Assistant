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

    // Nothing bound, and the job is not in execute — a question is not a plan.
    expect(await loadPlanBody(result.jobId, { businessId: BUSINESS })).toBeNull();
    const jobs = await getPool().query<{ phase: string }>(
      `SELECT phase FROM jobs WHERE job_id = $1`,
      [result.jobId],
    );
    expect(jobs.rows[0]?.phase).not.toBe('execute');
    const auths = await getPool().query(`SELECT 1 FROM job_authorizations`);
    expect(auths.rows).toHaveLength(0);
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
    const { rows } = await getPool().query(`SELECT 1 FROM job_authorizations`);
    expect(rows).toHaveLength(0);
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
  });

  it('refuses when no charter is installed', async () => {
    await resetDatabase();
    const result = await runInstruction(
      { text: 'תשלחי לדנה' },
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
    );
    expect(result.status).toBe('refused');
  });

  it('refuses an instruction past the cap before calling the planner', async () => {
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
  });
});
