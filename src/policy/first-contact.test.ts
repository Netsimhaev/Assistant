import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { ActionFacts, PolicyBundle } from '../domain/policy.js';
import type { TrustLevel } from '../domain/trust.js';
import { buildFacts } from './facts.js';
import { assessRisk } from './risk.js';

const BUSINESS = 'test-business';

/**
 * Facts for a first contact: an address nothing in the charter resolves.
 *
 * `chainDerived` is passed explicitly at every call site rather than
 * defaulted, because it is the whole subject of these tests: the exemption
 * is supposed to need both a trusted origin AND a caller's claim that the
 * origin was computed for this action's own causal chain.
 */
function firstContact(provenance: TrustLevel, chainDerived: boolean): ActionFacts {
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

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('first contact escalates, and no origin is exempt from that', () => {
  async function bundle(): Promise<PolicyBundle> {
    return installCharter(buildCharter(), { businessId: BUSINESS });
  }

  /**
   * The change of 10/09, and the reason for it.
   *
   * `boss` was the sole member of the exempt set: a chain the owner started,
   * which had read no external content, did not escalate on a recipient
   * nothing vouched for. That was invisible while the ramp held every
   * outbound class at `draft_only` — the gate denied on autonomy long before
   * the risk band was consulted. Raising `email.reply` to `auto_notify` made
   * it live, and the shape it took was a real message leaving for an address
   * no one had ever confirmed, with no card.
   *
   * The owner's rule is that a recipient counts as named when they typed it
   * themselves — and that path is already served, by the standing
   * authorisation the instruction door writes, which cancels this same
   * risk-band term for exactly the recipients the instruction named. So the
   * exemption bought nothing the owner had asked for and carried a case they
   * had not: a recipient chosen by something other than them.
   */
  it('escalates a boss origin derived for this action’s own chain', async () => {
    const BUNDLE = await bundle();
    const risk = await assessRisk(firstContact('boss', true), BUNDLE);
    expect(risk.band).toBe('sensitive');
  });

  it('escalates when the chain passed through an inbound email', async () => {
    const BUNDLE = await bundle();
    const risk = await assessRisk(firstContact('unknown_external', true), BUNDLE);
    expect(risk.band).toBe('sensitive');
  });

  it('escalates for staff, which is not on the exempt list', async () => {
    const BUNDLE = await bundle();
    const risk = await assessRisk(firstContact('staff', true), BUNDLE);
    expect(risk.band).toBe('sensitive');
  });

  // Kept after the exempt set was emptied, and worth keeping: it pins the
  // second condition independently of the first. If someone re-populates the
  // set later, this is the test that still says a `boss` stamped once on the
  // job means nothing about who chose *this* recipient — which is the whole
  // injection path.
  it('escalates a boss origin nobody derived for this action\'s own chain', async () => {
    const BUNDLE = await bundle();
    const risk = await assessRisk(firstContact('boss', false), BUNDLE);
    expect(risk.band).toBe('sensitive');
  });

  // `runPlan` does set the signal now, for a boss job whose plan reads no
  // external content. Every other path — the SDK gate hook, `executeStep`
  // called on its own — leaves it unset, and `buildFacts` defaults it to
  // false. Asserting it on hand-built facts alone would pass even if
  // `buildFacts` defaulted the signal the other way.
  it('escalates a boss-origin first contact built by buildFacts', async () => {
    const BUNDLE = await bundle();
    const facts = buildFacts(
      'mail.send',
      { to: 'stranger@example.com', body: 'שלום' },
      { provenance: 'boss', chainDepth: 0, counterpartyTags: [] },
    );
    expect(facts.provenanceChainDerived).toBe(false);
    const risk = await assessRisk(facts, BUNDLE);
    expect(risk.band).toBe('sensitive');
  });

  // Rewritten when the exempt set was emptied. It used to send money to a
  // recipient nothing resolved — which, now that first contact escalates for
  // every origin, would come out `sensitive` whatever the amount was, and
  // the assertion would have held with the money dimension deleted entirely.
  // The recipient is therefore one the charter resolves, so the first-contact
  // rule stays silent and the amount is the only thing that can escalate.
  it('escalates on the amount alone, for a recipient the charter does resolve', async () => {
    const BUNDLE = await installCharter(
      buildCharter({ version: '2026-08-15.money-only', knownCounterpartyEmailDomain: 'example.com' }),
      { businessId: BUSINESS },
    );
    const known = { ...firstContact('boss', true), counterpartyEmails: ['dana@example.com'] };

    // The control, and the half that makes the next assertion mean something:
    // with no amount, this same call is routine. ₪500 against the fixture's
    // ₪10,000 daily ceiling also stays under the routine total (22 of 25),
    // so the escalation below is genuinely the money and not the recipient.
    expect((await assessRisk(known, BUNDLE)).band).toBe('routine');

    // ₪5,000 — half the daily ceiling — clears it.
    const withMoney = { ...known, amountMinor: 500_000, amountDeclared: true };
    expect((await assessRisk(withMoney, BUNDLE)).band).not.toBe('routine');
  });
});
