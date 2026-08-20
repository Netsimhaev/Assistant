import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { PolicyBundle } from '../domain/policy.js';
import { createJob, loadJob, transition } from './jobs.js';
import type { Job } from './jobs.js';
import { executeStep } from './execute.js';
import { applyDecision } from './resume.js';

/**
 * What `perform` returns when a step produced nothing an adapter would hand
 * back. The shape is `StepEffect`: the output, and the provider's handle on
 * whatever was created.
 */
const NOTHING = { output: null, externalId: null };

const BUSINESS = 'test-business';
/** 12:00 Asia/Jerusalem — outside the fixture's quiet window. */
const NOON = new Date('2026-08-18T09:00:00.000Z');

async function install(overrides = {}): Promise<PolicyBundle> {
  return installCharter(buildCharter(overrides), { businessId: BUSINESS });
}

async function jobInExecute(bundle: PolicyBundle): Promise<Job> {
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

/** A first contact from an untrusted origin: the gate queues this. */
const STRANGER = {
  stepId: 'step-1',
  agent: 'comms.email' as const,
  toolName: 'mail.send',
  toolInput: { to: 'stranger@example.com', body: 'נוסח מקורי' },
  counterpartyTags: [] as string[],
  rampLevel: 'auto' as const,
  provenance: 'unknown_external' as const,
};

async function parkOnApproval(bundle: PolicyBundle, job: Job) {
  const queued = await executeStep({
    ...STRANGER, job, bundle, perform: async () => NOTHING, now: NOON,
  });
  if (queued.status !== 'awaiting_approval') {
    throw new Error(`expected awaiting_approval, got ${queued.status}`);
  }
  return queued.approvalId;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('a step resumed from an approval', () => {
  it('runs, and performs exactly once', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const approvalId = await parkOnApproval(bundle, job);

    await applyDecision(approvalId, 'approved',
      { by: 'p_boss', channel: 'dashboard' }, { businessId: BUSINESS });

    const resumed = await loadJob(job.jobId, { businessId: BUSINESS });
    if (resumed === null) throw new Error('job vanished');

    let performed = 0;
    const outcome = await executeStep({
      ...STRANGER, job: resumed, bundle, approvalId,
      perform: async () => { performed += 1; return NOTHING; }, now: NOON,
    });

    expect(outcome.status).toBe('done');
    expect(performed).toBe(1);
  });

  it('does not queue a second request for the same step', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const approvalId = await parkOnApproval(bundle, job);
    await applyDecision(approvalId, 'approved',
      { by: 'p_boss', channel: 'dashboard' }, { businessId: BUSINESS });

    const resumed = await loadJob(job.jobId, { businessId: BUSINESS });
    if (resumed === null) throw new Error('job vanished');
    const outcome = await executeStep({
      ...STRANGER, job: resumed, bundle, approvalId,
      perform: async () => NOTHING, now: NOON,
    });

    expect(outcome.status).not.toBe('awaiting_approval');
  });

  it('runs the EDITED input when the boss changed it', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const approvalId = await parkOnApproval(bundle, job);

    await applyDecision(approvalId, 'approved',
      {
        by: 'p_boss',
        channel: 'dashboard',
        editedInput: { ...STRANGER.toolInput, body: 'נוסח ערוך' },
      },
      { businessId: BUSINESS });

    const resumed = await loadJob(job.jobId, { businessId: BUSINESS });
    if (resumed === null) throw new Error('job vanished');

    const seen: unknown[] = [];
    await executeStep({
      ...STRANGER, job: resumed, bundle, approvalId,
      perform: async (input) => { seen.push(input); return NOTHING; }, now: NOON,
    });

    expect(seen).toHaveLength(1);
    expect((seen[0] as { body: string }).body).toBe('נוסח ערוך');
  });
});
