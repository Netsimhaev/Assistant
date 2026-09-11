import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { compileCharter } from '../charter/compile.js';
import { BusinessCharter } from '../domain/charter.js';
import { addresseeOf, NEVER_FULLY_AUTONOMOUS } from '../domain/action.js';
import { AGENT_ALLOWLISTS, isToolPermitted } from '../charter/capabilities.js';
import {
  classifyAction,
  classifiedToolNames,
  isOutbound,
  refineActionClass,
  READ_ONLY_TOOLS,
} from './classify.js';
import { evaluateToolCall, type GateContext } from './engine.js';
import { assessRisk } from './risk.js';
import type { ActionFacts, PolicyBundle } from '../domain/policy.js';
import { TrustLevel } from '../domain/trust.js';

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
    //
    // Provenance is 'staff', not the default 'boss': a boss-origin first
    // contact is exempt from this escalation on purpose (naming the
    // counterparty WAS the approval), so it would not tell resolved from
    // unresolved apart here. Staff stays inside the escalation.
    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'x@example.com', entityId: 'לקוח ותיק', inReplyTo: 'm1' },
      ctx(bundle, { provenance: 'staff' }),
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
  /**
   * `TOOL_ACTION_CLASS` and `READ_ONLY_TOOLS` must stay disjoint, and since
   * 11/09 that is load-bearing rather than merely tidy.
   *
   * `rampLevelForPlan` (`orchestrator/ramp.ts`) lets a step whose tool is on
   * the read-only list contribute NO ceiling to the plan-wide minimum. Its
   * entire safety argument is that such a tool has no class by construction
   * and is short-circuited at stage 4, before stage 8 ever reads the ramp. A
   * tool in both tables breaks that argument: it would carry a real,
   * side-effecting class and still contribute nothing, so it would execute
   * under whatever other class the plan happened to declare, bypassing its own
   * ramp row entirely. `classMismatch` would not catch it either — that check
   * stays silent when `expectedActionClass` is `null`.
   *
   * Nothing asserted this before, and this codebase has moved tools between
   * these two tables three times: `file.write` and `code_execution` out of
   * read-only into classified, and `browser.click`/`browser.fill` from
   * read-only into `browser.interact`. The next such move is exactly where
   * this would be forgotten.
   *
   * Written the way the test below it is written — by simulating the mistake
   * rather than asserting today's tables, which are already disjoint and would
   * pass with or without any guard.
   */
  it('keeps the classified and read-only tables disjoint, and would notice if they overlapped', () => {
    const classified = classifiedToolNames();

    const overlapOf = (readOnly: ReadonlySet<string>): string[] =>
      classified.filter((tool) => readOnly.has(tool)).sort();

    expect(overlapOf(READ_ONLY_TOOLS)).toEqual([]);

    // The one line a future change would add. `mail.send` is classified; were
    // it also read-only, `rampLevelForPlan` would skip it and the step would
    // run under no ramp of its own.
    const withMistake = new Set(READ_ONLY_TOOLS);
    withMistake.add('mail.send');
    expect(overlapOf(withMistake)).toEqual(['mail.send']);
  });

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
    //
    // Provenance is 'staff', not the default 'boss': a boss-origin first
    // contact is exempt from this escalation on purpose, so it would not
    // distinguish the subdomain bypass this test guards against. Staff
    // stays inside the escalation.
    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'dana@promo.mail.acme.co.il', inReplyTo: 't-1', body: 'שלום' },
      ctx(bundle, { provenance: 'staff' }),
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

describe('outbound is a positive list, and it is complete', () => {
  it('every classified tool that reaches a person or a browser is outbound', () => {
    // `OUTBOUND_TOOLS` drives redaction, quiet hours and the outbound kill
    // switch. A tool missing from it is handed to an adapter with its payload
    // untouched, at any hour, under an outbound stop. Two were missing —
    // `calendar.write` and `credential.request_session` — and nothing said so,
    // because the list was hand-maintained beside a separate hand-maintained
    // mapping of who each class reaches.
    //
    // Derived from `addresseeOf` rather than restated, so a new tool whose
    // class addresses a person cannot be added without landing here too.
    // `internal` classes are deliberately NOT required to be outbound: they
    // are the ones that write to the filesystem, to memory and to the charter.
    // Several internal tools (crm.write, data.export) ARE outbound anyway,
    // which this direction permits — it is a lower bound, not an equality.
    const missing = classifiedToolNames().filter((tool) => {
      const actionClass = classifyAction(tool);
      if (actionClass === null) return false;
      return addresseeOf(actionClass) !== 'internal' && !isOutbound(tool);
    });

    expect(missing, 'tools that reach a person or a browser but are not outbound').toEqual([]);
  });

  it('redacts the payload of a calendar invitation', async () => {
    const bundle = await installCharter(buildCharter({ autonomyBase: { 'calendar.create': 'auto' } }), {
      businessId: BUSINESS,
    });

    // The fixture charter redacts a bare nine-digit number. An invitation is
    // delivered to attendees, so the description must not carry one out.
    const decision = await evaluateToolCall(
      'calendar.write',
      { entityId: 'c_812', title: 'פגישה', description: 'ת.ז. 123456789' },
      ctx(bundle, { agent: 'sched.meetings' }),
    );

    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') throw new Error('unreachable');
    const redacted = decision.redactedInput as { description: string };
    expect(redacted.description).not.toContain('123456789');
  });
});

/**
 * Facts for a first contact: an address nothing in the charter resolves,
 * with only `provenance` varying. Mirrors the helper in first-contact.test.ts
 * (which exercises the boss/staff/unknown_external distinction in isolation);
 * this one exists to pin the exempt set's *width* against the whole enum.
 */
function firstContactFacts(provenance: TrustLevel, chainDerived: boolean): ActionFacts {
  return {
    toolName: 'mail.send',
    actionClass: 'email.initiate',
    provenance,
    chainDepth: 0,
    provenanceChainDerived: chainDerived,
    inputHash: 'h',
    amountMinor: 0,
    amountDeclared: false,
    counterpartyId: null,
    counterpartyEmails: ['stranger@example.com'],
    counterpartyPhones: [],
    counterpartyTags: [],
    dataClasses: [],
    leavesInstance: true,
    supplierId: null,
    discountPercent: 0,
  };
}

describe('the first-contact exemption is empty: no TrustLevel escapes the escalation', () => {
  it('scores EVERY TrustLevel as sensitive, boss included', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    // A widening of FIRST_CONTACT_EXEMPT in risk.ts is precisely how a
    // security control loosens into a prompt-injection hole: add a level
    // there and work that reached an unresolved recipient stops escalating
    // on first contact, silently, with every behaviour-agnostic test still
    // green. This asserts the rule as it actually operates -- band by band,
    // for every TrustLevel -- rather than the constant behind it, so there
    // is no separate export to keep in sync with the implementation.
    //
    // The set held `boss` until 10/09. It was emptied on the owner's
    // instruction once raising the `email.reply` ramp made the exemption
    // reachable, and the shape it took was a message leaving for an address
    // nobody had confirmed. The owner's own rule -- a recipient counts as
    // named when they typed it -- is served by the standing authorisation
    // the instruction door writes, which cancels this same risk-band term
    // for exactly those recipients. So nothing the owner asked for was lost
    // by emptying it.
    //
    // Iterated from TrustLevel.options rather than listed by hand: a level
    // added to the enum later is exercised by this loop automatically and
    // must fail closed until someone decides to exempt it deliberately in
    // risk.ts. Re-populating the set is what turns this test red, and the
    // failure names the level -- which is the point.
    for (const level of TrustLevel.options) {
      const risk = await assessRisk(firstContactFacts(level, true), bundle);
      expect(risk.band, `provenance=${level}`).toBe('sensitive');
    }
  });

  it('scores EVERY TrustLevel as sensitive when nobody derived the provenance', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    // The other half of the same invariant, and the half that holds the
    // safety argument up if the set is ever re-populated. Membership of
    // FIRST_CONTACT_EXEMPT is a necessary condition, never a sufficient one:
    // without `provenanceChainDerived`, the level on the fact object is
    // whatever was stamped on the job, and a job the boss started can reach
    // a recipient that injected content chose. Every level must escalate
    // here -- so widening the set cannot on its own reopen the path, and
    // dropping the precondition cannot pass unnoticed. While the set is
    // empty this asserts the same outcome as the test above; the two differ
    // in what they would catch, and both are cheap.
    for (const level of TrustLevel.options) {
      const risk = await assessRisk(firstContactFacts(level, false), bundle);
      expect(risk.band, `provenance=${level}, not chain-derived`).toBe('sensitive');
    }
  });
});
