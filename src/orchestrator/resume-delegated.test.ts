import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { PolicyBundle } from '../domain/policy.js';
import { createJob, loadJob, transition, type Job } from './jobs.js';
import { requestHelp, type RequestHelpInput } from './delegate.js';
import { resumeDelegatedJobs } from './resume-delegated.js';

const BUSINESS = 'test-business';

async function openParentJob(): Promise<{ job: Job; bundle: PolicyBundle }> {
  const bundle = await installCharter(buildCharter({ version: `parent-${ulid()}` }), {
    businessId: BUSINESS,
  });
  const created = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'delegating job',
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(created.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const job = await loadJob(created.jobId, { businessId: BUSINESS });
  if (job === null) throw new Error('parent job vanished');
  return { job, bundle };
}

function baseRequest(
  job: Job,
  bundle: PolicyBundle,
  overrides: Partial<RequestHelpInput> = {},
): RequestHelpInput {
  return {
    parentJobId: job.jobId,
    from: 'comms.email',
    to: 'know.reader',
    intent: 'read_for_question',
    payload: { question: 'מה המסמך הזה מבקש?' },
    contextRefs: [{ kind: 'document', documentId: `doc-${ulid()}` }],
    bundle,
    parentEnvelope: null,
    businessId: BUSINESS,
    ...overrides,
  };
}

/** A real parent → child delegation, opened through `requestHelp` itself. */
async function openDelegation(): Promise<{
  parentJobId: string;
  childJobId: string;
  envelopeId: string;
}> {
  const { job, bundle } = await openParentJob();
  const result = await requestHelp(baseRequest(job, bundle));
  if (result.status !== 'opened') throw new Error(`expected opened, got ${result.status}`);
  return { parentJobId: job.jobId, childJobId: result.childJobId, envelopeId: result.envelopeId };
}

/** Walk a child all the way to `closed`, the only legal route from `verify`. */
async function closeChild(jobId: string): Promise<void> {
  for (const to of ['verify', 'remember', 'closed'] as const) {
    await transition(jobId, { to, actor: 'orchestrator', reason: 'test setup', businessId: BUSINESS });
  }
}

async function failChild(jobId: string): Promise<void> {
  await transition(jobId, { to: 'failed', actor: 'orchestrator', reason: 'test setup', businessId: BUSINESS });
}

async function latestResultPayload(): Promise<{ outcome: string; note: string }> {
  const { rows } = await getPool().query<{ payload: { outcome: string; note: string } }>(
    `SELECT payload FROM agent_envelopes
      WHERE business_id = $1 AND kind = 'result'
      ORDER BY created_at DESC LIMIT 1`,
    [BUSINESS],
  );
  const payload = rows[0]?.payload;
  if (payload === undefined) throw new Error('expected a result envelope');
  return payload;
}

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('resumeDelegatedJobs', () => {
  it('wakes the parent when the child closes, and writes a result envelope', async () => {
    const { parentJobId, childJobId } = await openDelegation();
    await closeChild(childJobId);

    const result = await resumeDelegatedJobs({ businessId: BUSINESS });
    expect(result.resumed).toEqual([parentJobId]);
    expect(result.timedOut).toEqual([]);
    expect(result.errored).toEqual([]);

    const parent = await loadJob(parentJobId, { businessId: BUSINESS });
    expect(parent?.phase).toBe('execute');
    expect(parent?.awaitingEnvelopeId).toBeNull();

    const payload = await latestResultPayload();
    expect(payload.outcome).toBe('succeeded');
  });

  it('wakes the parent and says so plainly when the child failed', async () => {
    const { parentJobId, childJobId } = await openDelegation();
    await failChild(childJobId);

    const result = await resumeDelegatedJobs({ businessId: BUSINESS });
    expect(result.resumed).toEqual([parentJobId]);

    const parent = await loadJob(parentJobId, { businessId: BUSINESS });
    // The parent does not fail on its own account of its helper failing —
    // that is a decision for its own plan to make on the next pass.
    expect(parent?.phase).toBe('execute');

    const payload = await latestResultPayload();
    expect(payload.outcome).toBe('failed');
  });

  it("wakes the parent when the envelope's deadline passed and the child is still running", async () => {
    const { parentJobId, childJobId } = await openDelegation();
    // The child is deliberately left running — never closed, never failed.
    const wellPastTheDefaultWindow = new Date(Date.now() + 25 * 60 * 60 * 1000);

    const result = await resumeDelegatedJobs({ businessId: BUSINESS, now: wellPastTheDefaultWindow });
    expect(result.timedOut).toEqual([parentJobId]);
    expect(result.resumed).toEqual([]);
    expect(result.errored).toEqual([]);

    const parent = await loadJob(parentJobId, { businessId: BUSINESS });
    expect(parent?.phase).toBe('execute');
    expect(parent?.awaitingEnvelopeId).toBeNull();

    // The stuck child itself is untouched — only the parent is freed.
    const child = await loadJob(childJobId, { businessId: BUSINESS });
    expect(child?.phase).toBe('execute');

    const payload = await latestResultPayload();
    expect(payload.outcome).toBe('timeout');
  });

  it('leaves a parent alone while its child is still inside the deadline', async () => {
    const { parentJobId } = await openDelegation();

    const result = await resumeDelegatedJobs({ businessId: BUSINESS });
    expect(result.resumed).toEqual([]);
    expect(result.timedOut).toEqual([]);
    expect(result.errored).toEqual([]);

    const parent = await loadJob(parentJobId, { businessId: BUSINESS });
    expect(parent?.phase).toBe('followup');
  });

  it('isolates a failure on one parent from the rest of the round', async () => {
    const good = await openDelegation();
    await closeChild(good.childJobId);

    const bad = await openDelegation();
    // Corrupt the bad parent's own row: point it at an envelope id nothing
    // ever wrote. `followup` has no self-transition, so the row is walked
    // back to `execute` first and re-parked with the bogus id — the same
    // shape a real crash between `writeEnvelope` and `attachChildJob` could
    // leave behind, engineered directly rather than raced for.
    await transition(bad.parentJobId, {
      to: 'execute',
      actor: 'orchestrator',
      reason: 'test corruption',
      businessId: BUSINESS,
    });
    await transition(bad.parentJobId, {
      to: 'followup',
      actor: 'orchestrator',
      reason: 'test corruption',
      awaitingEnvelopeId: 'ENV-does-not-exist',
      businessId: BUSINESS,
    });

    const result = await resumeDelegatedJobs({ businessId: BUSINESS });
    expect(result.resumed).toEqual([good.parentJobId]);
    expect(result.errored).toEqual([bad.parentJobId]);

    // The good parent actually woke, despite running in the same pass as the
    // corrupted one.
    const goodParent = await loadJob(good.parentJobId, { businessId: BUSINESS });
    expect(goodParent?.phase).toBe('execute');
  });
});
