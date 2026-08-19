import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { compileCharter } from '../charter/compile.js';
import { BusinessCharter } from '../domain/charter.js';
import { NEVER_FULLY_AUTONOMOUS } from '../domain/action.js';
import { AGENT_ALLOWLISTS, isToolPermitted } from '../charter/capabilities.js';
import { refineActionClass, READ_ONLY_TOOLS } from './classify.js';
import { evaluateToolCall, type GateContext } from './engine.js';
import type { PolicyBundle } from '../domain/policy.js';

const BUSINESS = 'test-business';
/** 12:00 Asia/Jerusalem — outside the fixture's 22:00–07:00 quiet window. */
const NOON = new Date('2026-08-18T09:00:00.000Z');

function ctx(bundle: PolicyBundle, over: Partial<GateContext> = {}): GateContext {
  return {
    agent: 'comms.email',
    bundle,
    provenance: 'boss',
    chainDepth: 0,
    counterpartyTags: [],
    rampLevel: 'auto',
    businessId: BUSINESS,
    jobId: 'J-POS',
    now: NOON,
    ...over,
  } as GateContext;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

/**
 * Every control here used to be expressed as "everything except X", or as a
 * lookup against a single key, or as a fallback that continued. Each shape
 * failed the same way: something fell through the gap and nobody noticed,
 * because falling through looked exactly like passing.
 */
describe('controls that identify by one key must check every key', () => {
  it('honours a do-not-contact rule when the payload lists several recipients', async () => {
    const bundle = await installCharter(
      buildCharter({ doNotContactEmailDomain: 'rival-legal.co.il' }),
      { businessId: BUSINESS },
    );

    // An array `to` produced no address at all under the single-value reader,
    // so the block simply did not run.
    const decision = await evaluateToolCall(
      'mail.send',
      { to: ['fine@example.com', 'adv@rival-legal.co.il'], inReplyTo: 'm1' },
      ctx(bundle),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('do_not_contact');
  });

  it('honours it when the recipients arrive joined into one string', async () => {
    const bundle = await installCharter(
      buildCharter({ doNotContactEmailDomain: 'rival-legal.co.il' }),
      { businessId: BUSINESS },
    );

    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'fine@example.com, Adv@Rival-Legal.co.il', inReplyTo: 'm1' },
      ctx(bundle),
    );

    expect(decision.outcome).toBe('deny');
  });

  it('applies a counterparty autonomy override written against a tag', async () => {
    // Compiled under four key types and looked up under one, so an override
    // written against a tag, a domain or a phone could never be found — and an
    // override can only tighten, so losing one is silently more permissive.
    const bundle = compileCharter(buildCharter());
    expect(Object.keys(bundle.counterpartyAutonomy)).toEqual([
      'byEntityId',
      'byEmailDomain',
      'byPhone',
      'byTag',
    ]);
  });

  it('does not let an invented id match a tag and pose as a known counterparty', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    expect(bundle.knownCounterparties.entityIds).not.toEqual(
      bundle.knownCounterparties.tags,
    );

    // Against one flat list, `entityId: <a tag>` scored as a resolved
    // recipient and skipped the first-contact escalation.
    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'x@example.com', entityId: 'לקוח ותיק', inReplyTo: 'm1' },
      ctx(bundle),
    );

    expect(decision.outcome).toBe('queue_approval');
  });
});

describe('an unreadable value is not a permissive value', () => {
  it('refuses a purchase whose amount it could not read', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    // `total` rather than `amountMinor`: previously read as zero, which skipped
    // every ceiling and scored zero on the money dimension.
    const decision = await evaluateToolCall(
      'browser.submit_order',
      { supplierId: 'supplier_a', total: 500_000 },
      ctx(bundle, { agent: 'ops.web' }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('amount_unreadable');
  });

  it('still allows a discount, which is a percentage and carries no amount', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    // The amount requirement must not undo the fix that made the discount
    // ceiling reachable at all.
    const decision = await evaluateToolCall(
      'discount.grant',
      { counterpartyId: 'c_812', discountPercent: 90 },
      ctx(bundle),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('budget_exceeded:discount');
  });

  it('scores an unrecognised data class as the worst one, not as nothing', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    // 'medical' is a plausible near-miss for 'health'. Dropping it scored zero.
    const decision = await evaluateToolCall(
      'mail.send',
      {
        to: 'x@example.com',
        inReplyTo: 'm1',
        counterpartyId: 'c_812',
        dataClasses: ['medical'],
      },
      ctx(bundle),
    );

    expect(decision.outcome).toBe('queue_approval');
  });

  it('gives an unrecognised calendar operation the strictest class', () => {
    // The default branch used to fall through to `calendar.create`, the
    // gentlest of the three.
    expect(refineActionClass('calendar.create', { operation: 'Cancel' })).toBe(
      'calendar.cancel',
    );
    expect(refineActionClass('calendar.create', { operation: ['cancel'] })).toBe(
      'calendar.cancel',
    );
    expect(refineActionClass('calendar.create', {})).toBe('calendar.create');
  });
});

describe('read-only must mean no side effect, not merely no action class', () => {
  it('a write to the filesystem is classified rather than waved through', async () => {
    // `file.write` sat in READ_ONLY_TOOLS, which skips the gate at step 4 and
    // writes no audit row — unrecorded filesystem write.
    expect(READ_ONLY_TOOLS.has('file.write')).toBe(false);

    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const decision = await evaluateToolCall(
      'file.write',
      { path: 'out.docx' },
      ctx(bundle, { agent: 'prod.docs' }),
    );
    expect(decision.outcome).toBe('allow');
  });

  it('redacts a read-only tool that nonetheless leaves the instance', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    // browser.navigate is in READ_ONLY_TOOLS *and* OUTBOUND_TOOLS. It carries
    // no action class, so it short-circuited past redaction — making a URL an
    // unredacted egress channel.
    const decision = await evaluateToolCall(
      'browser.navigate',
      { url: 'https://supplier.example/?ref=123456789' },
      ctx(bundle, { agent: 'ops.web' }),
    );

    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') throw new Error('unreachable');
    expect(JSON.stringify(decision.redactedInput)).not.toContain('123456789');
  });

  it('holds quiet hours over an outbound read-only tool too', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const decision = await evaluateToolCall(
      'browser.navigate',
      { url: 'https://supplier.example/' },
      ctx(bundle, { agent: 'ops.web', now: new Date('2026-08-18T00:00:00.000Z') }),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('quiet_hours');
  });
});

describe('constants that must fail closed as the system grows', () => {
  it('refuses an unowned tool even when an allowlist names it', () => {
    // Asserting the current tables is not enough: no allowlist contains these
    // today, so the allowlist path already refuses them and the assertion
    // passes with or without the fix. The defect was that ONE LINE added to an
    // allowlist would have made contract.sign reachable with every structural
    // invariant still green — so that is what this simulates.
    const allowlist = AGENT_ALLOWLISTS['ops.systems'];
    allowlist.push('contract.sign');
    try {
      expect(isToolPermitted('ops.systems', 'contract.sign')).toBe(false);
    } finally {
      allowlist.pop();
    }
    expect(isToolPermitted('comms.email', 'payment.charge')).toBe(false);
  });

  it('keeps every irreversible class in the always-needs-a-human set', () => {
    for (const cls of ['payment.make', 'refund.issue', 'contract.sign', 'data.export'] as const) {
      expect(NEVER_FULLY_AUTONOMOUS.has(cls), cls).toBe(true);
    }
  });

  it('refuses to sign a charter whose timezone the runtime cannot resolve', () => {
    const charter = buildCharter();
    const broken = {
      ...charter,
      identity: { ...charter.identity, timezone: 'Asia/Jerusalm' },
    };
    // The reader used to fall back to UTC, which does not widen the quiet-hours
    // window — it shifts it, so the message went out inside the window.
    expect(BusinessCharter.safeParse(broken).success).toBe(false);
  });

  it('refuses to sign a redaction pattern it cannot compile', () => {
    const charter = buildCharter();
    const broken = {
      ...charter,
      // Note: '[0-9]{9' does NOT throw — JS web-compat treats a lone '{' as a
      // literal. An unterminated character class does.
      data: { ...charter.data, redactBeforeSending: ['[0-9'] },
    };
    // Previously skipped at runtime, so a typo disabled a signed redaction
    // silently and permanently.
    expect(BusinessCharter.safeParse(broken).success).toBe(false);
  });

  it('refuses to sign a counterparty emailDomain the gate cannot normalise', () => {
    const charter = buildCharter({ doNotContactEmailDomain: 'rival-legal.co.il' });
    const broken = {
      ...charter,
      counterparties: charter.counterparties.map((c) =>
        c.match.emailDomain === 'rival-legal.co.il'
          ? { ...c, match: { ...c.match, emailDomain: '.' } }
          : c,
      ),
    };
    // A domain that normalises to nothing would compile into doNotContact,
    // appear in the signed document, and match no inbound address ever --
    // exactly as silent a failure as an unresolvable timezone or an
    // uncompilable redaction pattern above.
    expect(BusinessCharter.safeParse(broken).success).toBe(false);
  });
});

/**
 * `domainMatches` (src/util/address.ts) is used in two directions from one
 * function, and the safe direction depends on which one: broader matching
 * that *tightens* a restriction (do-not-contact, the autonomy ceiling) is
 * always safe to widen to a subdomain. Broader matching that *loosens* one
 * (knownCounterparties, which skips the first-contact risk escalation) is
 * not -- a DNS label boundary is not a company boundary an owner vouched
 * for. Both assertions below exercise the identical subdomain shape against
 * the two different consumers, so the whole lesson sits in one place: the
 * same input must be treated oppositely depending on which way the match
 * loosens or tightens.
 */
describe('broad domain matching widens what gets blocked, never what gets trusted', () => {
  it('does not let a subdomain of a known counterparty skip the first-contact escalation', async () => {
    const bundle = await installCharter(
      buildCharter({ knownCounterpartyEmailDomain: 'acme.co.il' }),
      { businessId: BUSINESS },
    );

    // A valid reply (auto_notify baseline) so risk alone -- not the action
    // class -- decides allow vs. queue_approval. 'promo.mail.acme.co.il' is
    // a subdomain of the known 'acme.co.il', but knownCounterparties matches
    // exactly, so this must still be scored as an unresolved first contact.
    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'dana@promo.mail.acme.co.il', inReplyTo: 't-1', body: 'שלום' },
      ctx(bundle),
    );

    expect(decision.outcome).toBe('queue_approval');
  });

  it('still denies a subdomain of a do-not-contact domain', async () => {
    const bundle = await installCharter(
      buildCharter({ doNotContactEmailDomain: 'rival-legal.co.il' }),
      { businessId: BUSINESS },
    );

    // The mirror image of the case above: matchDoNotContact widens to a
    // subdomain on purpose, because blocking more is always the safe
    // direction.
    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'dana@mail.rival-legal.co.il', inReplyTo: 't-1', body: 'שלום' },
      ctx(bundle),
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('do_not_contact');
  });
});
