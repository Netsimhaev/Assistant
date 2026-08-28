import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { PolicyBundle } from '../domain/policy.js';
import { createJob, loadJob, transition } from './jobs.js';
import type { Job } from './jobs.js';
import { executeStep } from './execute.js';
import { applyDecision } from './resume.js';
import { getApproval } from '../governance/approvals.js';

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

  /**
   * The edited payload has to reach the performer as well as the gate.
   *
   * `executeStep` substitutes the edit before the gate sees it, so the budget,
   * the redaction and the do-not-contact check all judge what the boss actually
   * approved. But the performer chooses the destination — which signed
   * connection, which endpoint, which credential — and it was deriving that
   * from the ORIGINAL step input. An owner who corrects a supplier on the card
   * got the new supplier's ceiling enforced and the order sent over the old
   * supplier's connection, with the old supplier's credential, and nothing in
   * the audit trail disagreed. Same shape for a corrected recipient.
   */
  it('hands the performer the approved payload, not the one first proposed', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const approvalId = await parkOnApproval(bundle, job);
    const edited = { ...STRANGER.toolInput, body: 'נוסח ערוך', counterpartyId: 'c_812' };

    await applyDecision(approvalId, 'approved',
      { by: 'p_boss', channel: 'dashboard', editedInput: edited },
      { businessId: BUSINESS });

    const resumed = await loadJob(job.jobId, { businessId: BUSINESS });
    if (resumed === null) throw new Error('job vanished');

    let effective: unknown = null;
    await executeStep({
      ...STRANGER, job: resumed, bundle, approvalId,
      perform: async (_redacted, forRouting) => { effective = forRouting; return NOTHING; },
      now: NOON,
    });

    expect(effective).toEqual(edited);
  });

  // "The approval expired" must be a fresh question, never a failure: the
  // work is still wanted and nothing about it went wrong. `expireOverdue`
  // never touches a decided row, so this state — approved, unspent, past its
  // expiry — is what a job that halted for a few hours leaves behind.
  it('queues a fresh request instead of spending an expired approval', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const approvalId = await parkOnApproval(bundle, job);
    await applyDecision(approvalId, 'approved',
      { by: 'p_boss', channel: 'dashboard' }, { businessId: BUSINESS });

    await getPool().query(
      `UPDATE approval_requests SET expires_at = now() - interval '1 hour'
        WHERE approval_id = $1`,
      [approvalId],
    );

    const resumed = await loadJob(job.jobId, { businessId: BUSINESS });
    if (resumed === null) throw new Error('job vanished');

    const outcome = await executeStep({
      ...STRANGER, job: resumed, bundle, approvalId,
      perform: async () => { throw new Error('perform must not run'); }, now: NOON,
    });

    expect(outcome.status).toBe('awaiting_approval');
    if (outcome.status !== 'awaiting_approval') return;
    expect(outcome.approvalId).not.toBe(approvalId);

    // The expired one stays unspent — a claim that failed must not mark it.
    const { rows } = await getPool().query<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM approval_requests WHERE approval_id = $1`,
      [approvalId],
    );
    expect(rows[0]?.consumed_at).toBeNull();
  });

  // `executeStep` is exported and takes `approvalId` from its caller, while
  // `getApproval` is scoped by business alone. Before the job predicate, an
  // approval-with-edit belonging to a DIFFERENT job of the same business
  // replaced this step's payload before the gate ever saw it — and the
  // `wrong_job` refusal that followed fell through to the normal path, which
  // then evaluated the foreign text. The queued request's `proposedInput` is
  // what the gate actually judged, so it is the thing to assert on.
  it('ignores an edit from another job of the same business', async () => {
    const bundle = await install();
    const other = await jobInExecute(bundle);
    const foreignApprovalId = await parkOnApproval(bundle, other);
    await applyDecision(foreignApprovalId, 'approved',
      {
        by: 'p_boss',
        channel: 'dashboard',
        editedInput: { ...STRANGER.toolInput, body: 'טקסט של job אחר' },
      },
      { businessId: BUSINESS });

    const mine = await jobInExecute(bundle);
    const outcome = await executeStep({
      ...STRANGER, job: mine, bundle, approvalId: foreignApprovalId,
      perform: async () => { throw new Error('perform must not run'); }, now: NOON,
    });

    expect(outcome.status).toBe('awaiting_approval');
    if (outcome.status !== 'awaiting_approval') return;
    const queued = await getApproval(outcome.approvalId, { businessId: BUSINESS });
    expect(queued?.jobId).toBe(mine.jobId);
    expect((queued?.proposedInput as { body: string }).body).toBe('נוסח מקורי');

    // And the foreign approval is still unspent — this step never touched it.
    const foreign = await getApproval(foreignApprovalId, { businessId: BUSINESS });
    expect(foreign?.state).toBe('approved_with_edit');
  });
});
