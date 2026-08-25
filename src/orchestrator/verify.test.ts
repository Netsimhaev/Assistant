import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, withTransaction } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import { createJob, loadJob, transition } from './jobs.js';
import { bindPlanToJob, planHashOf, recordStepCompletion } from './plan-store.js';
import { closeVerifiedJobs } from './verify.js';

const BUSINESS = 'test-business';

const PLAN: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the confirmation',
      toolName: 'mail.send',
      input: { to: 'dana@example.com', counterpartyId: 'c_812', subject: 'נושא', body: 'גוף' },
      expectedActionClass: 'email.initiate',
    },
  ],
});

let charterCounter = 0;

/** A job parked in `verify`, through the real transition chain. */
async function jobInVerify(
  options: { businessId?: string; bindPlan?: boolean } = {},
): Promise<{ jobId: string; planHash: string }> {
  const businessId = options.businessId ?? BUSINESS;
  charterCounter += 1;
  const bundle = await installCharter(
    buildCharter({ version: `2026-08-25.${charterCounter}` }),
    { businessId },
  );
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId,
    title: 'verify',
  });
  for (const to of ['understand', 'plan', 'execute', 'verify'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId });
  }
  if (options.bindPlan === false) return { jobId: job.jobId, planHash: '' };
  await bindPlanToJob(job.jobId, PLAN, { businessId });
  // `PlanBinding` is a union whose `conflict` arm carries no `planHash`, and
  // a fresh job never hits that arm. `planHashOf` is the same hash the bind
  // just stored, without the narrowing.
  return { jobId: job.jobId, planHash: planHashOf(PLAN) };
}

async function recordStep(
  jobId: string,
  planHash: string,
  status: 'completed' | 'unknown',
  businessId: string = BUSINESS,
): Promise<void> {
  await withTransaction(async (tx) => {
    await recordStepCompletion(tx, {
      jobId,
      businessId,
      planHash,
      stepId: 's1',
      externalId: status === 'completed' ? '<MSG-1@example.com>' : null,
      status,
    });
  });
}

describe('closeVerifiedJobs', () => {
  beforeEach(async () => {
    await resetDatabase();
    charterCounter = 0;
  });

  afterAll(async () => {
    await closePool();
  });

  it('does nothing when no job is in verify', async () => {
    const result = await closeVerifiedJobs({ businessId: BUSINESS });
    expect(result.closed).toEqual([]);
  });

  it('closes a job whose every step completed', async () => {
    const { jobId, planHash } = await jobInVerify();
    await recordStep(jobId, planHash, 'completed');

    const result = await closeVerifiedJobs({ businessId: BUSINESS });

    expect(result.closed).toEqual([jobId]);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('closed');
  });

  // A lock, not a discovery. Closing goes `verify → remember → closed`, and
  // the cheap-looking shortcut is to widen `LEGAL_TRANSITIONS` with a direct
  // `verify → closed` edge. That would erase the difference between a job
  // that passed the curator and one that never did, and it would do it
  // silently — every assertion above still passes under it. This is the test
  // that does not.
  it('records the curator hop, rather than jumping verify straight to closed', async () => {
    const { jobId, planHash } = await jobInVerify();
    await recordStep(jobId, planHash, 'completed');

    await closeVerifiedJobs({ businessId: BUSINESS });

    const { rows } = await getPool().query<{ from_phase: string; to_phase: string; reason: string }>(
      `SELECT from_phase, to_phase, reason FROM job_steps
        WHERE job_id = $1 AND to_phase IN ('remember', 'closed')
        ORDER BY at`,
      [jobId],
    );
    expect(rows.map((r) => `${r.from_phase}→${r.to_phase}`)).toEqual([
      'verify→remember',
      'remember→closed',
    ]);
    // The reason must not claim a verification that did not happen.
    expect(rows[0]?.reason).toContain('no acceptance criteria');
  });

  it('stops a job carrying an unknown step at failed, naming the step', async () => {
    const { jobId, planHash } = await jobInVerify();
    await recordStep(jobId, planHash, 'unknown');

    const result = await closeVerifiedJobs({ businessId: BUSINESS });

    expect(result.closed).toEqual([]);
    expect(result.failed[0]?.jobId).toBe(jobId);
    expect(result.failed[0]?.detail).toContain('s1');
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('failed');
  });

  it('stops a job at failed when a step has no result row at all', async () => {
    const { jobId } = await jobInVerify();

    const result = await closeVerifiedJobs({ businessId: BUSINESS });

    expect(result.closed).toEqual([]);
    expect(result.failed[0]?.jobId).toBe(jobId);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('failed');
  });

  it('finishes a job left in remember by an interrupted pass', async () => {
    const { jobId, planHash } = await jobInVerify();
    await recordStep(jobId, planHash, 'completed');
    await transition(jobId, {
      to: 'remember',
      actor: 'orchestrator',
      reason: 'setup',
      businessId: BUSINESS,
    });

    const result = await closeVerifiedJobs({ businessId: BUSINESS });

    expect(result.closed).toEqual([jobId]);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('closed');
  });

  it('reports a job in verify with no plan bound, and does not move it', async () => {
    const { jobId } = await jobInVerify({ bindPlan: false });

    const result = await closeVerifiedJobs({ businessId: BUSINESS });

    expect(result.unbound).toEqual([jobId]);
    expect(result.closed).toEqual([]);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('verify');
  });

  it('leaves another business\u2019s job alone', async () => {
    const mine = await jobInVerify();
    await recordStep(mine.jobId, mine.planHash, 'completed');
    const theirs = await jobInVerify({ businessId: 'other-business' });
    await recordStep(theirs.jobId, theirs.planHash, 'completed', 'other-business');

    const result = await closeVerifiedJobs({ businessId: BUSINESS });

    expect(result.closed).toEqual([mine.jobId]);
    expect((await loadJob(theirs.jobId, { businessId: 'other-business' }))?.phase).toBe('verify');
  });
});
