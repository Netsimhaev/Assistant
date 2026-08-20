import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { assessRisk } from '../policy/risk.js';
import { canonicalHash } from '../util/canonical.js';
import { decide, enqueueApproval } from './approvals.js';
import { consumeApproval } from './consume.js';

import type { PolicyBundle, ActionFacts } from '../domain/policy.js';

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

describe('the consumption columns', () => {
  it('start null, so an existing approval reads as unspent', async () => {
    const { rows } = await getPool().query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'approval_requests'
          AND column_name IN ('consumed_at', 'consumed_by_step')
        ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['consumed_at', 'consumed_by_step']);
    expect(rows.every((r) => r.column_default === null)).toBe(true);
  });

  it('reject approval_requests with consumed_at set but consumed_by_step null', async () => {
    const pool = getPool();

    // Insert a valid approval_request first
    await pool.query(
      `INSERT INTO approval_requests
       (approval_id, business_id, action_class, summary, detail, risk,
        proposed_tool, proposed_input, input_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        'approval-123',
        'test-business',
        'email.send',
        'Test approval',
        'Test detail',
        '{}',
        'email.send',
        '{}',
        'abc123',
        new Date(Date.now() + 3600000).toISOString(),
      ],
    );

    // Try to set consumed_at without consumed_by_step — should fail
    await expect(
      pool.query(
        `UPDATE approval_requests SET consumed_at = NOW() WHERE approval_id = $1`,
        ['approval-123'],
      ),
    ).rejects.toThrow(/approval_consumption_both_or_neither|CHECK constraint/i);
  });

  it('reject dashboard_sessions for a username with no matching dashboard_users row', async () => {
    const pool = getPool();

    // Try to insert a session for a non-existent user
    await expect(
      pool.query(
        `INSERT INTO dashboard_sessions (session_id, business_id, username, expires_at)
         VALUES ($1, $2, $3, $4)`,
        ['session-123', 'test-business', 'nonexistent-user', new Date(Date.now() + 3600000).toISOString()],
      ),
    ).rejects.toThrow(/dashboard_sessions_owner_fk|FOREIGN KEY constraint/i);
  });
});

const BUSINESS = 'test-business';
const INPUT = { to: 'dana@example.com', body: 'שלום' };

async function install(): Promise<PolicyBundle> {
  const charter = buildCharter();
  return installCharter(charter, { businessId: BUSINESS });
}

/**
 * Real `ActionFacts` and `RiskAssessment` values, never `as never`.
 *
 * A cast to `never` switches off exactly the checking that catches a drifted
 * fact shape — and a silently-empty fact field is a failure this codebase has
 * hit more than once. Build the objects; let the compiler read them.
 */
function factsFor(input: unknown): ActionFacts {
  return {
    toolName: 'mail.send',
    actionClass: 'email.initiate',
    provenance: 'boss',
    chainDepth: 0,
    provenanceChainDerived: false,
    inputHash: canonicalHash(input),
    amountMinor: 0,
    amountDeclared: false,
    counterpartyId: null,
    counterpartyEmails: ['dana@example.com'],
    counterpartyPhones: [],
    counterpartyTags: [],
    dataClasses: [],
    leavesInstance: true,
    supplierId: null,
    discountPercent: 0,
  };
}

/**
 * A real assessment from the real scorer.
 *
 * `RiskDimensions` is a closed shape of seven sub-objects; hand-writing one
 * would be forty lines of invented numbers that drift the moment the scorer
 * changes. Calling `assessRisk` costs one line and cannot drift.
 */
async function riskFor(input: unknown, bundle: PolicyBundle) {
  return assessRisk(factsFor(input), bundle);
}

async function pendingApproval(jobId: string, bundle: PolicyBundle, input: unknown = INPUT) {
  const approvalId = await enqueueApproval(
    {
      jobId,
      facts: factsFor(input),
      risk: await riskFor(input, bundle),
      proposedInput: input,
      summary: 'שליחת מייל',
    },
    { businessId: BUSINESS },
  );
  return approvalId;
}

async function approvedApproval(jobId: string, bundle: PolicyBundle, input: unknown = INPUT) {
  const approvalId = await pendingApproval(jobId, bundle, input);
  await decide(approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' },
    { businessId: BUSINESS });
  return approvalId;
}

describe('an approval is spent exactly once', () => {
  let bundle: PolicyBundle;

  beforeEach(async () => {
    bundle = await install();
  });

  it('lets the step through when all four conditions hold', async () => {
    const approvalId = await approvedApproval('J-1', bundle);
    const out = await consumeApproval({
      approvalId, jobId: 'J-1', stepId: 's1',
      liveInputHash: canonicalHash(INPUT), businessId: BUSINESS,
    });
    expect(out).toEqual({ ok: true });
  });

  it('refuses the same approval a second time', async () => {
    const approvalId = await approvedApproval('J-1', bundle);
    const args = {
      approvalId, jobId: 'J-1', stepId: 's1',
      liveInputHash: canonicalHash(INPUT), businessId: BUSINESS,
    };
    expect(await consumeApproval(args)).toEqual({ ok: true });
    expect(await consumeApproval({ ...args, stepId: 's2' })).toEqual({
      ok: false, code: 'already_consumed',
    });
  });

  it('refuses when the input changed after the approval', async () => {
    const approvalId = await approvedApproval('J-1', bundle);
    const out = await consumeApproval({
      approvalId, jobId: 'J-1', stepId: 's1',
      liveInputHash: canonicalHash({ ...INPUT, body: 'משהו אחר' }),
      businessId: BUSINESS,
    });
    expect(out).toEqual({ ok: false, code: 'input_changed' });
  });

  it('refuses an approval that belongs to another job', async () => {
    const approvalId = await approvedApproval('J-1', bundle);
    const out = await consumeApproval({
      approvalId, jobId: 'J-2', stepId: 's1',
      liveInputHash: canonicalHash(INPUT), businessId: BUSINESS,
    });
    expect(out).toEqual({ ok: false, code: 'wrong_job' });
  });

  it('refuses an approval nobody decided yet', async () => {
    const approvalId = await pendingApproval('J-1', bundle);
    const out = await consumeApproval({
      approvalId, jobId: 'J-1', stepId: 's1',
      liveInputHash: canonicalHash(INPUT), businessId: BUSINESS,
    });
    expect(out).toEqual({ ok: false, code: 'not_approved' });
  });

  it('refuses an approval id that does not exist', async () => {
    const out = await consumeApproval({
      approvalId: 'A-nope', jobId: 'J-1', stepId: 's1',
      liveInputHash: canonicalHash(INPUT), businessId: BUSINESS,
    });
    expect(out).toEqual({ ok: false, code: 'unknown_approval' });
  });

  it('lets exactly one of two concurrent attempts through', async () => {
    const approvalId = await approvedApproval('J-1', bundle);
    const args = {
      approvalId, jobId: 'J-1', stepId: 's1',
      liveInputHash: canonicalHash(INPUT), businessId: BUSINESS,
    };
    const [a, b] = await Promise.all([
      consumeApproval(args),
      consumeApproval({ ...args, stepId: 's2' }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
});
