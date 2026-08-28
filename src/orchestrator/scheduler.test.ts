import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { getApproval, pendingApprovals } from '../governance/approvals.js';
import type { PolicyBundle } from '../domain/policy.js';
import { createJob, loadJob, transition } from './jobs.js';
import { executeStep } from './execute.js';
import { startScheduler, tick } from './scheduler.js';
import { applyDecision } from './resume.js';

/**
 * What `perform` returns when a step produced nothing an adapter would hand
 * back. The shape is `StepEffect`: the output, and the provider's handle on
 * whatever was created — `executeStep` writes that handle down with the step's
 * completion, which is what lets a resumed run skip the step instead of
 * repeating it.
 */
const NOTHING = { output: null, externalId: null };


const BUSINESS = 'test-business';
/** 03:00 Asia/Jerusalem — inside the fixture's 22:00–07:00 quiet window. */
const NIGHT = new Date('2026-08-18T00:00:00.000Z');
/** 12:00 Asia/Jerusalem — outside it. */
const NOON = new Date('2026-08-18T09:00:00.000Z');

async function install(overrides = {}): Promise<PolicyBundle> {
  return installCharter(buildCharter(overrides), { businessId: BUSINESS });
}

async function jobInExecute(bundle: PolicyBundle) {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, {
      to,
      actor: 'orchestrator',
      reason: 'setup',
      businessId: BUSINESS,
    });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

const STEP = {
  stepId: 'step-1',
  agent: 'comms.email' as const,
  toolName: 'mail.send',
  toolInput: { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812' },
  counterpartyTags: [] as string[],
  rampLevel: 'auto' as const,
};

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('the scheduler closes the loop the orchestrator opens', () => {
  it('wakes a job that quiet hours put to sleep', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    let sent = 0;

    // Deferred at night. Before the scheduler existed this job slept forever:
    // `wakeAt` was written and nothing ever read it.
    const deferred = await executeStep({
      ...STEP,
      job,
      bundle,
      perform: async () => {
        sent += 1;
        return NOTHING;
      },
      now: NIGHT,
    });
    expect(deferred.status).toBe('deferred');
    expect(sent).toBe(0);

    const asleep = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(asleep?.phase).toBe('followup');

    // Too early — the window has not closed yet.
    const early = await tick({ businessId: BUSINESS, now: NIGHT });
    expect(early.wokenJobs).toEqual([]);

    const later = await tick({ businessId: BUSINESS, now: NOON });
    expect(later.wokenJobs).toEqual([job.jobId]);

    const awake = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(awake?.phase).toBe('execute');
    // Woken once, not every tick thereafter.
    expect(awake?.wakeAt).toBeNull();
    expect((await tick({ businessId: BUSINESS, now: NOON })).wokenJobs).toEqual([]);
  });

  it('the woken job then actually sends, in the morning', async () => {
    // `STEP` writes to `a@b.com`; the charter is given that domain so the send
    // is `routine` and the subject stays what it says — quiet hours deferring a
    // job and the wake-up actually sending. An entity id no longer vouches for
    // an address the charter cannot resolve (`visibility-scoring.test.ts`), and
    // an escalation here would stop the step before `perform` ever ran.
    const bundle = await install({ knownCounterpartyEmailDomain: 'b.com' });
    const job = await jobInExecute(bundle);
    let sent = 0;

    await executeStep({ ...STEP, job, bundle, perform: async () => { sent += 1; return NOTHING; }, now: NIGHT });
    await tick({ businessId: BUSINESS, now: NOON });

    const awake = await loadJob(job.jobId, { businessId: BUSINESS });
    if (awake === null) throw new Error('job vanished');
    const outcome = await executeStep({
      ...STEP,
      job: awake,
      bundle,
      perform: async () => {
        sent += 1;
        return NOTHING;
      },
      now: NOON,
    });

    expect(outcome.status).toBe('done');
    expect(sent).toBe(1);
  });

  it('expires an approval nobody answered and frees the job behind it', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);

    const queued = await executeStep({
      ...STEP,
      job,
      bundle,
      toolInput: { to: 'new@example.com', body: 'פנייה ראשונה' },
      perform: async () => NOTHING,
      now: NOON,
    });
    expect(queued.status).toBe('awaiting_approval');
    if (queued.status !== 'awaiting_approval') throw new Error('unreachable');

    await getPool().query(
      `UPDATE approval_requests SET expires_at = now() - interval '1 hour' WHERE approval_id = $1`,
      [queued.approvalId],
    );

    const result = await tick({ businessId: BUSINESS, now: NOON });

    expect(result.expiredApprovals).toEqual([queued.approvalId]);
    expect((await getApproval(queued.approvalId, { businessId: BUSINESS }))?.state).toBe(
      'expired',
    );
    // The job is freed rather than failed: nobody answering is not a rejection.
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('followup');
    expect(await pendingApprovals({ businessId: BUSINESS })).toEqual([]);
  });

  it('leaves an approval that is still within its fuse alone', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);

    const queued = await executeStep({
      ...STEP,
      job,
      bundle,
      toolInput: { to: 'new@example.com', body: 'פנייה' },
      perform: async () => NOTHING,
      now: NOON,
    });
    if (queued.status !== 'awaiting_approval') throw new Error('unreachable');

    const result = await tick({ businessId: BUSINESS, now: NOON });

    expect(result.expiredApprovals).toEqual([]);
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe(
      'await_approval',
    );
  });

  it('a second scheduler skips the tick rather than repeating it', async () => {
    await install();
    // Both ticks race for the same advisory lock; exactly one does the work.
    const [a, b] = await Promise.all([
      tick({ businessId: BUSINESS, now: NOON }),
      tick({ businessId: BUSINESS, now: NOON }),
    ]);
    expect([a.skipped, b.skipped].filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });

  it('runs on an interval and stops cleanly', async () => {
    await install();
    const errors: unknown[] = [];
    const handle = startScheduler({
      businessId: BUSINESS,
      intervalMs: 50,
      onError: (error) => errors.push(error),
    });

    await new Promise((resolve) => setTimeout(resolve, 160));
    await handle.stop();

    expect(errors).toEqual([]);
  });
});

describe('a human decision restarts the job it was blocking', () => {
  it('an approval returns the job to execute', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);

    const queued = await executeStep({
      ...STEP,
      job,
      bundle,
      toolInput: { to: 'new@example.com', body: 'פנייה ראשונה' },
      perform: async () => NOTHING,
      now: NOON,
    });
    if (queued.status !== 'awaiting_approval') throw new Error('unreachable');

    // `decide` wrote the row and stopped, so the job stayed parked with
    // nothing to restart it.
    const result = await applyDecision(
      queued.approvalId,
      'approved',
      { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS },
    );

    expect(result.state).toBe('approved');
    expect(result.jobPhase).toBe('execute');
  });

  it('a refusal closes the job rather than failing it', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);

    const queued = await executeStep({
      ...STEP,
      job,
      bundle,
      toolInput: { to: 'new@example.com', body: 'פנייה ראשונה' },
      perform: async () => NOTHING,
      now: NOON,
    });
    if (queued.status !== 'awaiting_approval') throw new Error('unreachable');

    const result = await applyDecision(
      queued.approvalId,
      'denied',
      { by: 'p_boss', channel: 'dashboard', note: 'לא עכשיו' },
      { businessId: BUSINESS },
    );

    // The system did what was asked and a person said no. That is an outcome.
    expect(result.jobPhase).toBe('closed');
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.closedAt).not.toBeNull();
  });
});
