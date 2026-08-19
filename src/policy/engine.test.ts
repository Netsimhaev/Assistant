import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { queryAudit, verifyChain } from '../audit/log.js';
import { decide, getApproval, pendingApprovals } from '../governance/approvals.js';
import { release, trip } from '../governance/killswitch.js';
import { evaluateToolCall, type GateContext } from './engine.js';
import { refineActionClass } from './classify.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { BusinessCharter } from '../domain/charter.js';

const BUSINESS = 'test-business';

/**
 * A fixed clock, 12:00 in Asia/Jerusalem.
 *
 * Without it these tests read the wall clock, and the fixture charter has quiet
 * hours 22:00-07:00 — so every test that sends something would have failed
 * between 10pm and 7am and passed the rest of the day. A suite whose result
 * depends on when it runs is not a suite.
 */
const NOON = new Date('2026-08-18T09:00:00.000Z');

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
    // Stated, not defaulted. Production callers pass `draft_only` because no
    // autonomy ramp exists yet; these tests exercise the gate itself, so they
    // pass the permissive value deliberately and say so here.
    counterpartyTags: [],
    rampLevel: 'auto',
    now: NOON,
    ...over,
    // The spread of a Partial can reintroduce `undefined` for a required field
    // under exactOptionalPropertyTypes; the cast is confined to this helper.
  } as GateContext;
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

// ---------------------------------------------------------------------------
// Regressions. Every test below fails against the code as it stood before the
// review: each one describes a gate step that compiled, ran, and decided
// nothing.

describe('regressions found in review', () => {
  it('holds the discount ceiling on a call that carries no amount', async () => {
    const bundle = await install();

    // A discount is a percentage; the tool call granting one has no
    // `amountMinor`, so `readAmountMinor` returns 0. The budget gate returned
    // early on exactly that and never reached the discount comparison — a 90%
    // discount passed a signed 10% cap with outcome `allow`.
    const decision = await evaluateToolCall(
      'discount.grant',
      { counterpartyId: 'c_812', discountPercent: 90 },
      ctx(bundle),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('budget_exceeded:discount');
  });

  it('enforces the per-supplier auto-order ceiling the owner signed', async () => {
    const bundle = await install();

    // supplier_a is approved up to ₪2,500 in the fixture. Nothing compared
    // that number to anything before this.
    const decision = await evaluateToolCall(
      'browser.submit_order',
      { supplierId: 'supplier_a', amountMinor: 260_000 },
      ctx(bundle, { agent: 'ops.web' }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('budget_exceeded:supplier:supplier_a');
  });

  it('treats an explicit null thread id as a first contact, not a reply', () => {
    // Asserted on the classifier directly. Going through the gate does not
    // isolate this: an unresolvable recipient makes the risk layer escalate on
    // its own, so the call queues for approval either way and the test passes
    // against the bug — which is how this one nearly shipped as a test that
    // guarded nothing.
    expect(refineActionClass('email.reply', { inReplyTo: null })).toBe('email.initiate');
    expect(refineActionClass('email.reply', { inReplyTo: '' })).toBe('email.initiate');
    expect(refineActionClass('email.reply', { inReplyTo: 't-1' })).toBe('email.reply');
    expect(refineActionClass('whatsapp.reply', { conversationId: null })).toBe(
      'whatsapp.initiate',
    );
  });

  it('does not let a null thread id buy auto_notify at the gate', async () => {
    const bundle = await install();

    // With a counterparty the charter knows, risk stays routine — so the only
    // thing standing between this call and `allow` is the action class. Under
    // the old classifier it was `email.reply` (auto_notify) and the message
    // went out; it is `email.initiate` (approve_required) now.
    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'vip@example.com', counterpartyId: 'c_812', inReplyTo: null, body: 'שלום' },
      ctx(bundle),
    );

    expect(decision.outcome).toBe('queue_approval');
  });

  it('blocks a counterparty marked do-not-contact by email domain', async () => {
    const bundle = await install({ doNotContactEmailDomain: 'rival-legal.co.il' });

    // The compiled entry used to be compared against `counterpartyId` alone,
    // so a domain block was a rule that existed in the signed document and
    // stopped nothing.
    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'Adv@Rival-Legal.co.il', inReplyTo: 'thread-1', body: 'שלום' },
      ctx(bundle),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('do_not_contact');

    const denials = await queryAudit(
      { businessId: BUSINESS, kind: 'policy_denial' },
      getPool(),
    );
    expect(denials.some((e) => e.reason.includes('rival-legal.co.il'))).toBe(true);
  });

  it('does not score an unresolvable counterparty as one we know', async () => {
    const bundle = await install();

    // `buildFacts` falls back to the payload's `entityId`, so any outbound
    // payload carrying that field scored as `one_known` (25) instead of
    // `one_unknown` (55) and dropped out of the sensitive band.
    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'x@example.com', entityId: 'not_in_the_charter', inReplyTo: 't-9' },
      ctx(bundle),
    );

    expect(decision.outcome).toBe('queue_approval');
  });

  it('refuses to decide an approval whose fuse already burned out', async () => {
    const bundle = await install();

    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'new@example.com', body: 'פנייה ראשונה' },
      ctx(bundle),
    );
    expect(decision.outcome).toBe('queue_approval');
    if (decision.outcome !== 'queue_approval') throw new Error('unreachable');

    // Push the fuse into the past. `expireOverdue` has no caller yet, so the
    // row stays `pending` — which is exactly the state the bug lived in.
    await getPool().query(
      `UPDATE approval_requests SET expires_at = now() - interval '3 days'
        WHERE approval_id = $1`,
      [decision.approvalId],
    );

    await expect(
      decide(decision.approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' }, {
        businessId: BUSINESS,
      }),
    ).rejects.toThrow(/expired/);

    const after = await getApproval(decision.approvalId, { businessId: BUSINESS });
    expect(after?.state).toBe('pending');
  });

  it('refuses to record a release of a kill switch that was never tripped', async () => {
    await install();

    // The UPDATE matched no row and the audit entry was written anyway, so the
    // permanent trail gained a RELEASED event for something that never stopped.
    await expect(
      release('all', 'p_boss', 'לא היה מה לשחרר', { businessId: BUSINESS }),
    ).rejects.toThrow(/not tripped/);

    const entries = await queryAudit(
      { businessId: BUSINESS, kind: 'kill_switch' },
      getPool(),
    );
    expect(entries).toEqual([]);
  });

  it('keeps a charter scoped to its own business', async () => {
    const bundle = await install();
    // Same version string, different business — a global primary key on
    // `charter_version` rejected this outright, and the active-charter join
    // could hand one business the other's rules.
    await installCharter(buildCharter({ dailyCeilingMinor: 50 }), {
      businessId: 'other-business',
    });

    const mine = await loadActiveCharter(BUSINESS, getPool());
    expect(mine?.bundle.ceilings.dailyMinor).toBe(bundle.ceilings.dailyMinor);

    const theirs = await loadActiveCharter('other-business', getPool());
    expect(theirs?.bundle.ceilings.dailyMinor).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// `installCharter` receives an argument already typed as `BusinessCharter`,
// but the type checker cannot see whether the caller actually ran it through
// `.parse()`. Without a runtime check inside `installCharter` itself, an
// invalid charter installs, activates, and only fails the next time anything
// reads it — by which point the gate has no policy to load at all.

describe('installCharter validates at write time', () => {
  it('throws on a charter with a bad connection, before writing anything', async () => {
    const charter = buildCharter();
    const broken: BusinessCharter = {
      ...charter,
      connections: [
        {
          system: 'ghost',
          label: 'לא קיים',
          channel: 'api',
          serves: ['mail.teleport'],
          target: null,
          subprocessor: null,
        },
      ],
    };

    await expect(installCharter(broken, { businessId: BUSINESS })).rejects.toThrow();

    // Nothing was written: the next read finds no active charter rather than
    // throwing when it tries to parse a row that was never valid.
    const loaded = await loadActiveCharter(BUSINESS, getPool());
    expect(loaded).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A charter stored under a pre-connections schema version must fail loudly
// and legibly on the read path too — not just on a fresh parse. Reaching
// `BusinessCharter.parse` directly on a stale row produces a raw ZodError,
// which reads exactly like the alarm for a tampered charter. The row is
// inserted directly rather than through `installCharter`, since install now
// refuses schemaVersion '1.0' itself — this simulates a charter that was
// written before the bump and never re-signed.

describe('loadActiveCharter refuses a stale schema version legibly', () => {
  it('names the schema version and the remedy, not a zod issue path', async () => {
    const charter = buildCharter();
    const stale = { ...charter, schemaVersion: '1.0' };

    await getPool().query(
      `INSERT INTO charter_versions (
         charter_version, business_id, effective_from, supersedes,
         charter, policy_bundle, content_hash,
         signed_by, signed_at, signature_method
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        stale.charterVersion,
        BUSINESS,
        stale.effectiveFrom,
        stale.supersedes ?? null,
        JSON.stringify(stale),
        JSON.stringify({}),
        stale.signature.contentHash,
        stale.signature.signedByPersonId,
        stale.signature.signedAt,
        stale.signature.method,
      ],
    );
    await getPool().query(
      `INSERT INTO charter_active (business_id, charter_version, activated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (business_id)
       DO UPDATE SET charter_version = EXCLUDED.charter_version,
                     activated_at    = now()`,
      [BUSINESS, stale.charterVersion],
    );

    // Asserts on the remedy text, not on "schemaVersion" — that word also
    // appears in zod's own serialized issue path, so a bare /schemaVersion/
    // match would pass equally against the raw ZodError this guard replaced.
    await expect(loadActiveCharter(BUSINESS, getPool())).rejects.toThrow(
      /must be re-signed/,
    );
  });
});

// ---------------------------------------------------------------------------
// The browser gate. Until now `browser.click` and `browser.fill` were
// read-only, so they short-circuited the gate at step 4 and a hijacked session
// could finish a checkout without ever touching the gated `browser.submit_order`.

describe('browser gate', () => {
  it('lets an approved session click and type without friction', async () => {
    const bundle = await install();

    // The point of classifying these was never to make ordinary browsing
    // painful. A boss-initiated session still clicks freely.
    const decision = await evaluateToolCall(
      'browser.click',
      { selector: '#next-page' },
      ctx(bundle, { agent: 'ops.web', provenance: 'boss' }),
    );

    expect(decision.outcome).toBe('allow');
  });

  it('stops a session that has read an untrusted page from clicking at all', async () => {
    const bundle = await install();

    // This is the hijack. Once the chain's provenance is open_web, the
    // provenance ceiling caps it at draft_only — a ceiling that existed all
    // along and that click/fill were skipping past.
    const decision = await evaluateToolCall(
      'browser.click',
      { selector: '#place-order' },
      ctx(bundle, { agent: 'ops.web', provenance: 'open_web' }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('draft_only:persist_as_draft');
  });

  it('treats a click that carries money as the purchase it is', async () => {
    const bundle = await install();

    // Classified on the amount the caller carries, never on the button's text:
    // the page is written by whoever controls the site, so matching a label
    // would be reading the attacker's own input as policy. supplier_a is
    // approved to ₪2,500 and this is ₪2,600.
    const decision = await evaluateToolCall(
      'browser.click',
      { selector: '#confirm', supplierId: 'supplier_a', amountMinor: 260_000 },
      ctx(bundle, { agent: 'ops.web' }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('budget_exceeded:supplier:supplier_a');
  });

  it('requires approval before an agent is handed a live session', async () => {
    const bundle = await install();

    const decision = await evaluateToolCall(
      'credential.request_session',
      { host: 'supplier-a.co.il' },
      ctx(bundle, { agent: 'ops.web' }),
    );

    expect(decision.outcome).toBe('queue_approval');
  });

  it('an outbound stop reaches clicks, not just sends', async () => {
    const bundle = await install();
    await trip('outbound', 'p_boss', 'עצירת יוצא', {
      businessId: BUSINESS,
      charterVersion: bundle.charterVersion,
    });

    const decision = await evaluateToolCall(
      'browser.click',
      { selector: '#anything' },
      ctx(bundle, { agent: 'ops.web' }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('kill_switch_active');

    await release('outbound', 'p_boss', 'סוף מבחן', {
      businessId: BUSINESS,
      charterVersion: bundle.charterVersion,
    });
  });
});
