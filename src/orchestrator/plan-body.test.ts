import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { Plan } from '../domain/plan.js';
import { createJob, transition } from './jobs.js';
import { bindPlanToJob, loadPlanBody, planHashOf } from './plan-store.js';

const BUSINESS = 'test-business';

const PLAN: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the confirmation',
      toolName: 'mail.send',
      input: { to: 'dana@example.com', subject: 'hi', body: 'hello' },
      expectedActionClass: 'email.initiate',
    },
  ],
});

async function seedJob(): Promise<string> {
  const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'plan body test',
  });
  // A job only reaches `execute` through `understand` and `plan` — there is no
  // `intake -> plan` edge, and `bindPlanToJob` is meant to be called once a
  // job has actually reached execution.
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  return job.jobId;
}

describe('loadPlanBody', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('returns null for a job that is bound to no plan', async () => {
    const jobId = await seedJob();
    expect(await loadPlanBody(jobId, { businessId: BUSINESS })).toBeNull();
  });

  it('returns the plan a job was bound to, byte for byte', async () => {
    const jobId = await seedJob();
    await bindPlanToJob(jobId, PLAN, { businessId: BUSINESS });

    const loaded = await loadPlanBody(jobId, { businessId: BUSINESS });
    expect(loaded).not.toBeNull();
    expect(loaded?.plan).toEqual(PLAN);
    expect(loaded?.planHash).toBe(planHashOf(PLAN));
    // The point of the whole task: a round trip through the database must
    // still hash to the same plan, or resumption silently re-plans.
    expect(planHashOf(loaded!.plan)).toBe(planHashOf(PLAN));
  });

  it('does not read another business’s row', async () => {
    const jobId = await seedJob();
    await bindPlanToJob(jobId, PLAN, { businessId: BUSINESS });
    expect(await loadPlanBody(jobId, { businessId: 'other-business' })).toBeNull();
  });

  it('throws rather than returning a plan that no longer parses', async () => {
    const jobId = await seedJob();
    await bindPlanToJob(jobId, PLAN, { businessId: BUSINESS });
    await getPool().query(
      `UPDATE job_plans SET plan = '{"goal":"broken"}'::jsonb
        WHERE business_id = $1 AND job_id = $2`,
      [BUSINESS, jobId],
    );

    await expect(loadPlanBody(jobId, { businessId: BUSINESS })).rejects.toThrow(
      /stored plan/i,
    );
  });
});
