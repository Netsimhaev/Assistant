import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { decide } from '../governance/approvals.js';
import { evaluateToolCall } from './engine.js';

const BUSINESS = 'test-business';

// Fixed clock, matching the convention in engine.test.ts / positive-controls.test.ts:
// 09:00 UTC is noon in Asia/Jerusalem, safely outside the fixture's 20:00-07:00
// quiet-hours window. Without this the outcome of every call below depends on
// the wall-clock time the suite happens to run at.
const NOON = new Date('2026-08-18T09:00:00.000Z');

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

/**
 * A call that the gate queues: a known counterparty the charter still requires
 * approval for.
 *
 * `known_counterparty`, not `unknown_external`: the fixture's provenance
 * ceiling for `unknown_external` is `draft_only`, which is more restrictive
 * than `approve_required` and denies at gate step 8 before `queue_approval` is
 * ever reached — no action class escapes that ceiling. `known_counterparty`'s
 * ceiling is `approve_required`, so it actually reaches the approval branch
 * this file exercises.
 *
 * Deliberately still not `boss`: a later task in this plan stops first
 * contact from escalating when the chain's origin is the boss, and picking
 * `boss` here would make these tests stop queueing — and so stop testing
 * anything — for a reason unrelated to approval consumption. Every test in
 * this file must keep a non-boss provenance.
 */
const CALL = {
  toolName: 'mail.send',
  input: { to: 'stranger@example.com', body: 'שלום' },
  ctx: {
    agent: 'comms.email' as const,
    jobId: 'J-1',
    stepId: 's1',
    provenance: 'known_counterparty' as const,
    // `FactsContext` requires it: zero is a call with no delegation chain.
    chainDepth: 0,
    counterpartyTags: [] as string[],
    rampLevel: 'auto' as const,
    businessId: BUSINESS,
    now: NOON,
  },
};

describe('an approval already granted is honoured, not recomputed', () => {
  it('runs the step instead of queueing a second request', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    const first = await evaluateToolCall(CALL.toolName, CALL.input, { ...CALL.ctx, bundle });
    expect(first.outcome).toBe('queue_approval');
    if (first.outcome !== 'queue_approval') throw new Error('unreachable');

    await decide(first.approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS });

    const second = await evaluateToolCall(CALL.toolName, CALL.input, {
      ...CALL.ctx, bundle, approvalId: first.approvalId,
    });
    expect(second.outcome).toBe('allow');
  });

  it('queues a fresh request when the same approval is offered twice', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const first = await evaluateToolCall(CALL.toolName, CALL.input, { ...CALL.ctx, bundle });
    if (first.outcome !== 'queue_approval') throw new Error('unreachable');
    await decide(first.approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS });

    const ctx = { ...CALL.ctx, bundle, approvalId: first.approvalId };
    expect((await evaluateToolCall(CALL.toolName, CALL.input, ctx)).outcome).toBe('allow');

    const third = await evaluateToolCall(CALL.toolName, CALL.input, ctx);
    expect(third.outcome).toBe('queue_approval');
    if (third.outcome !== 'queue_approval') throw new Error('unreachable');
    expect(third.approvalId).not.toBe(first.approvalId);
  });

  it('queues a fresh request when the input changed after the approval', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const first = await evaluateToolCall(CALL.toolName, CALL.input, { ...CALL.ctx, bundle });
    if (first.outcome !== 'queue_approval') throw new Error('unreachable');
    await decide(first.approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS });

    const changed = await evaluateToolCall(
      CALL.toolName,
      { ...CALL.input, body: 'נוסח אחר לגמרי' },
      { ...CALL.ctx, bundle, approvalId: first.approvalId },
    );
    expect(changed.outcome).toBe('queue_approval');
  });

  it('does not let an approval carry an action past a denial', async () => {
    // The fixture cannot express a charter `forbidden` rule, so the denial
    // under test is the autonomy one at gate step 8. Either way the point is
    // the same: consumption is step 10, and every denial before it stands —
    // an `approvalId` is present here and it must still deny. This reuses
    // CALL.ctx, so `known_counterparty` (non-boss, see the CALL docblock)
    // still applies; the forbidden override dominates it regardless.
    const bundle = await installCharter(
      buildCharter({ autonomyBase: { 'email.initiate': 'forbidden' } }),
      { businessId: BUSINESS },
    );
    const denied = await evaluateToolCall(CALL.toolName, CALL.input, {
      ...CALL.ctx, bundle, approvalId: 'A-anything',
    });
    expect(denied.outcome).toBe('deny');
  });
});
