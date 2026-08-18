import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { queryAudit, verifyChain } from '../audit/log.js';
import { decide, getApproval, pendingApprovals } from '../governance/approvals.js';
import { release, trip } from '../governance/killswitch.js';
import { evaluateToolCall, type GateContext } from './engine.js';
import type { PolicyBundle } from '../domain/policy.js';

const BUSINESS = 'test-business';

async function install(overrides = {}): Promise<PolicyBundle> {
  const charter = buildCharter(overrides);
  return installCharter(charter, { businessId: BUSINESS });
}

function ctx(bundle: PolicyBundle, over: Partial<GateContext> = {}): GateContext {
  return {
    agent: 'comms.email',
    bundle,
    provenance: 'boss',
    chainDepth: 0,
    businessId: BUSINESS,
    jobId: 'J-TEST',
    ...over,
  };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
// Exit criterion 1 — a policy denial is provable from the audit log.

describe('exit criterion: policy denial', () => {
  it('denies a hard-forbidden action and leaves a citable audit entry', async () => {
    const bundle = await install();

    const decision = await evaluateToolCall(
      'data.export',
      { counterpartyId: 'c_812', dataClasses: ['customer_pii'] },
      ctx(bundle, { agent: 'ops.systems' }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    // Exact, not `toContain` — the code is deterministic, and a loose match
    // would still pass if the kind prefix were doubled again.
    expect(decision.code).toBe('forbidden:no_customer_data_export');

    const denials = await queryAudit(
      { businessId: BUSINESS, kind: 'policy_denial' },
      getPool(),
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]?.reason).toContain('no_customer_data_export');
    expect(denials[0]?.charterVersion).toBe(bundle.charterVersion);
  });

  it('denies a tool no agent owns before the charter rule is even consulted', async () => {
    const bundle = await install();

    // contract.sign is forbidden by the charter *and* owned by nobody. The
    // capability layer wins, which is the correct order: the cheapest and most
    // absolute control runs first.
    const decision = await evaluateToolCall(
      'contract.sign',
      { counterpartyId: 'c_812' },
      ctx(bundle, { agent: 'ops.systems' }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('tool_not_allowlisted');
  });

  it('denies a tool the agent is not allowlisted for, before any classification', async () => {
    const bundle = await install();

    // ops.web must never be able to send mail, whatever the prompt says.
    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'x@example.com' },
      ctx(bundle, { agent: 'ops.web' }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('tool_not_allowlisted');
  });

  it('denies when the run holds a stale charter version', async () => {
    const stale = await install({ version: '2026-08-15.1' });
    // A newer charter is signed and activated underneath the running agent.
    await install({ version: '2026-08-15.2' });

    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'a@b.com', inReplyTo: 'm1' },
      ctx(stale),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('stale_policy');
  });

  it('denies a money action over the per-class ceiling and names the limit', async () => {
    const bundle = await install();

    const decision = await evaluateToolCall(
      'quote.issue',
      { counterpartyId: 'c_812', amountMinor: 936_000 }, // ₪9,360 vs ₪5,000 cap
      ctx(bundle, { agent: 'comms.email' }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toContain('budget_exceeded:per_action_class');
    expect(decision.reason).toContain('5,000');
  });

  it('enforces the discount ceiling — the check that was unreachable before', async () => {
    // The charter declares maxDiscountPercent, facts.ts reads discountPercent
    // and budget.ts checks it, but no tool produced `discount.grant`, so the
    // whole chain was dead. This test is what keeps it alive.
    const bundle = await install();

    const decision = await evaluateToolCall(
      'discount.grant',
      { counterpartyId: 'c_812', amountMinor: 10_000, discountPercent: 25 }, // cap is 10%
      ctx(bundle, { agent: 'comms.email' }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('budget_exceeded:discount');
    expect(decision.reason).toContain('10%');
  });

  it('caps an untrusted chain at draft_only however permissive the baseline is', async () => {
    // email.reply is auto_notify at baseline, but an unknown_external origin
    // must not be able to reach it.
    const bundle = await install();

    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812' },
      ctx(bundle, { provenance: 'unknown_external' }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('draft_only:persist_as_draft');
  });

  it('blocks a contact flagged doNotContact', async () => {
    const bundle = await install();

    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'x@y.com', inReplyTo: 'm1', counterpartyId: 'c_blocked' },
      ctx(bundle),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('do_not_contact');
  });
});

// ---------------------------------------------------------------------------
// Exit criterion 2 — an approval is provable from the audit log.

describe('exit criterion: approval', () => {
  it('queues an approval rather than blocking, and records intent before the decision', async () => {
    const bundle = await install();

    const decision = await evaluateToolCall(
      'browser.submit_order',
      { supplierId: 'supplier_a', amountMinor: 210_000, sku: 'PRD-77', qty: 50 },
      ctx(bundle, { agent: 'ops.web' }),
    );

    expect(decision.outcome).toBe('queue_approval');
    if (decision.outcome !== 'queue_approval') throw new Error('unreachable');
    expect(decision.code).toContain('queued_for_approval:');

    const queued = await pendingApprovals({ businessId: BUSINESS });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.actionClass).toBe('purchase.place');

    // Intent to act is written BEFORE the decision, so a crash between the two
    // is visible. Audit is newest-first, so the intent is the older entry.
    const entries = await queryAudit({ businessId: BUSINESS }, getPool());
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain('intent_to_act');
    expect(kinds).toContain('decision');
    expect(kinds.indexOf('decision')).toBeLessThan(kinds.indexOf('intent_to_act'));
  });

  it('binds the approval to the exact input that was shown (TOCTOU guard)', async () => {
    const bundle = await install();

    const decision = await evaluateToolCall(
      'browser.submit_order',
      { supplierId: 'supplier_a', amountMinor: 210_000, qty: 50 },
      ctx(bundle, { agent: 'ops.web' }),
    );
    if (decision.outcome !== 'queue_approval') throw new Error('expected a queued approval');

    const before = await getApproval(decision.approvalId, { businessId: BUSINESS });
    const approved = await decide(
      decision.approvalId,
      'approved',
      { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS },
    );

    expect(approved.state).toBe('approved');
    // The hash the approval is bound to is the hash of what was proposed.
    expect(before?.inputHash).toBe(approved.inputHash);
  });

  it('re-binds to the edited input when the boss changes the action', async () => {
    const bundle = await install();

    const decision = await evaluateToolCall(
      'browser.submit_order',
      { supplierId: 'supplier_a', amountMinor: 210_000, qty: 50 },
      ctx(bundle, { agent: 'ops.web' }),
    );
    if (decision.outcome !== 'queue_approval') throw new Error('expected a queued approval');

    const edited = await decide(
      decision.approvalId,
      'approved',
      {
        by: 'p_boss',
        channel: 'whatsapp',
        editedInput: { supplierId: 'supplier_a', amountMinor: 168_000, qty: 40 },
      },
      { businessId: BUSINESS },
    );

    expect(edited.state).toBe('approved_with_edit');
    expect(edited.editedInput).toMatchObject({ qty: 40 });
  });

  it('refuses to decide the same approval twice', async () => {
    const bundle = await install();
    const decision = await evaluateToolCall(
      'browser.submit_order',
      { supplierId: 'supplier_a', amountMinor: 210_000 },
      ctx(bundle, { agent: 'ops.web' }),
    );
    if (decision.outcome !== 'queue_approval') throw new Error('expected a queued approval');

    await decide(decision.approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' }, { businessId: BUSINESS });

    await expect(
      decide(decision.approvalId, 'denied', { by: 'p_boss', channel: 'dashboard' }, { businessId: BUSINESS }),
    ).rejects.toThrow(/already approved/);
  });

  it('never lets an irreversible class run autonomously, even at auto baseline', async () => {
    // refund.issue is on NEVER_FULLY_AUTONOMOUS but is not hard-forbidden in
    // the fixture, so it exercises the ramp cap rather than a charter rule.
    const bundle = await install({
      autonomyBase: { 'refund.issue': 'auto' },
    });

    const decision = await evaluateToolCall(
      'refund.issue',
      { counterpartyId: 'c_812', amountMinor: 5_000 },
      ctx(bundle, { agent: 'ops.systems' }),
    );

    expect(decision.outcome).toBe('queue_approval');
  });
});

// ---------------------------------------------------------------------------
// Exit criterion 3 — the kill switch is provable from the audit log.

describe('exit criterion: kill switch', () => {
  it('stops everything at scope "all" and records who stopped it and why', async () => {
    const bundle = await install();
    await trip('all', 'p_boss', 'חשד לפעולה שגויה', {
      businessId: BUSINESS,
      charterVersion: bundle.charterVersion,
    });

    const decision = await evaluateToolCall(
      'memory.recall',
      {},
      ctx(bundle, { agent: 'know.reader' }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('kill_switch_active');

    const entries = await queryAudit(
      { businessId: BUSINESS, kind: 'kill_switch' },
      getPool(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toContain('TRIPPED');
    expect(entries[0]?.reason).toContain('p_boss');
  });

  it('scope "outbound" stops sending but lets reading continue', async () => {
    const bundle = await install();
    await trip('outbound', 'p_boss', 'עצירת יוצא זמנית', {
      businessId: BUSINESS,
      charterVersion: bundle.charterVersion,
    });

    const send = await evaluateToolCall(
      'mail.send',
      { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812' },
      ctx(bundle),
    );
    expect(send.outcome).toBe('deny');

    // Analysis is deliberately unaffected — that is the point of this scope.
    const read = await evaluateToolCall('memory.recall', {}, ctx(bundle, { agent: 'know.reader' }));
    expect(read.outcome).toBe('allow');
  });

  it('a department stop leaves other departments working', async () => {
    const bundle = await install();
    await trip('operations', 'p_boss', 'תקלה בדפדפן', {
      businessId: BUSINESS,
      charterVersion: bundle.charterVersion,
    });

    const web = await evaluateToolCall('browser.navigate', {}, ctx(bundle, { agent: 'ops.web' }));
    expect(web.outcome).toBe('deny');

    const reader = await evaluateToolCall('memory.recall', {}, ctx(bundle, { agent: 'know.reader' }));
    expect(reader.outcome).toBe('allow');
  });

  it('survives a release and re-records the reason', async () => {
    const bundle = await install();
    await trip('all', 'p_boss', 'stop', { businessId: BUSINESS, charterVersion: bundle.charterVersion });
    await release('all', 'p_boss', 'נבדק ותוקן', {
      businessId: BUSINESS,
      charterVersion: bundle.charterVersion,
    });

    const decision = await evaluateToolCall('memory.recall', {}, ctx(bundle, { agent: 'know.reader' }));
    expect(decision.outcome).toBe('allow');

    const entries = await queryAudit({ businessId: BUSINESS, kind: 'kill_switch' }, getPool());
    expect(entries).toHaveLength(2);
    expect(entries[0]?.reason).toContain('RELEASED');
  });
});

// ---------------------------------------------------------------------------
// The trail itself must be trustworthy, or none of the above proves anything.

describe('audit chain integrity', () => {
  it('stays intact across a full denial + approval + kill switch sequence', async () => {
    const bundle = await install();

    await evaluateToolCall(
      'data.export',
      { counterpartyId: 'c_812' },
      ctx(bundle, { agent: 'ops.systems' }),
    );
    await evaluateToolCall(
      'browser.submit_order',
      { supplierId: 'supplier_a', amountMinor: 210_000 },
      ctx(bundle, { agent: 'ops.web' }),
    );
    await trip('all', 'p_boss', 'end of test', {
      businessId: BUSINESS,
      charterVersion: bundle.charterVersion,
    });

    const verification = await verifyChain(BUSINESS, getPool());
    expect(verification.intact).toBe(true);
    if (verification.intact) {
      expect(verification.entries).toBeGreaterThan(3);
    }
  });

  it('rejects an UPDATE against the append-only trigger', async () => {
    const bundle = await install();
    await evaluateToolCall(
      'data.export',
      { counterpartyId: 'c_812' },
      ctx(bundle, { agent: 'ops.systems' }),
    );

    await expect(
      getPool().query(`UPDATE audit_log SET reason = 'tampered' WHERE business_id = $1`, [
        BUSINESS,
      ]),
    ).rejects.toThrow(/append-only/);
  });
});
