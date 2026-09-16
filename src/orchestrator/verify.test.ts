import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, withTransaction } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import { recallMemories } from '../memory/store.js';
import type { CurationResult } from '../memory/curation-parse.js';
import type { Curator } from '../sdk/curator.js';
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

  // Made deterministic on purpose. Without deleting the key, this test's
  // actual behaviour depends on whether the machine running it has a real
  // `ANTHROPIC_API_KEY` in `.env` (this repo's own does, per CLAUDE.md's
  // note that the development machine "carries a real ANTHROPIC_API_KEY").
  // With the key present and no `curator` injected, `curateJob` does NOT
  // take the `no_key` skip \u2014 it reaches `curateWithModel`, whose
  // `refuseUnderTest` guard throws because `NODE_ENV=test`, and that throw is
  // caught inside `curateJob`'s own `try/catch` (`ran: false, failed: true`).
  // That is a different `CurationOutcome` than the `no_key` skip (`failed:
  // false`), even though both leave `ran: false`, which is all this test
  // checks. Deleting the key here removes that ambiguity: this test now
  // names, and guarantees, the `no_key` skip specifically. The refusal path
  // is exercised implicitly by the sibling test below, which injects a
  // `curator` and so never reaches `curateWithModel` at all \u2014 there is no
  // test in this file that deliberately drives the `refuseUnderTest` throw;
  // that path is `curate.test.ts`'s to cover, not this file's.
  it('closes a job anyway when ANTHROPIC_API_KEY is absent, so curation is skipped rather than run', async () => {
    const { jobId, planHash } = await jobInVerify();
    await recordStep(jobId, planHash, 'completed');
    const original = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    try {
      const result = await closeVerifiedJobs({ businessId: BUSINESS });

      expect(result.closed).toContain(jobId);
      // The property under test: a job that did its work still closes when
      // curation does not run.
      expect(result.curated).not.toContain(jobId);
      // And the skip is visible rather than discarded (N2): "curation is
      // off" must not look identical to "nothing was worth remembering".
      expect(result.curationSkipped).toContainEqual({ jobId, reason: 'no_key' });
    } finally {
      if (original !== undefined) process.env['ANTHROPIC_API_KEY'] = original;
    }
  });

  // The test above proves a real property (curation off must not strand a
  // job), but on its own it cannot tell "the call is wired in" from "the
  // call was deleted": `curated: []` is initialised whether or not
  // `curateJob` ever runs, so a purely negative assertion against it holds
  // either way. This test closes that gap with an injected curator \u2014 the
  // same seam `runPlan`'s `bindings` parameter provides \u2014 and asserts on a
  // side effect (a `memories` row) that only a real call can produce.
  it('runs an injected curator and writes what it returns, before closing', async () => {
    const { jobId, planHash } = await jobInVerify();
    await recordStep(jobId, planHash, 'completed');

    // PLAN's one step sends to dana@example.com, so that address is in
    // `touched.recipients` and `siftCandidates` will accept a candidate
    // naming it.
    const curator: Curator = async (): Promise<CurationResult> => ({
      candidates: [
        {
          kind: 'chunk',
          subjectKey: 'dana@example.com',
          body: { value: '\u05de\u05e2\u05d3\u05d9\u05e4\u05d4 \u05ea\u05d9\u05d0\u05d5\u05dd \u05d1\u05d1\u05d5\u05e7\u05e8' },
          sourceRef: '\u05d2\u05d5\u05e3 \u05d4\u05d4\u05d5\u05d3\u05e2\u05d4',
        },
      ],
    });

    const result = await closeVerifiedJobs({ businessId: BUSINESS, curator });

    expect(result.closed).toContain(jobId);
    expect(result.curated).toContain(jobId);
    const rows = await recallMemories(
      { subjectKey: 'dana@example.com', kind: 'chunk' },
      { businessId: BUSINESS },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toEqual({ value: '\u05de\u05e2\u05d3\u05d9\u05e4\u05d4 \u05ea\u05d9\u05d0\u05d5\u05dd \u05d1\u05d1\u05d5\u05e7\u05e8' });
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
