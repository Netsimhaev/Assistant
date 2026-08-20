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

describe('first contact escalates unless the boss named the counterparty', () => {
  async function bundle(): Promise<PolicyBundle> {
    return installCharter(buildCharter(), { businessId: BUSINESS });
  }

  it('does not escalate when the boss is the origin of the chain', async () => {
    const BUNDLE = await bundle();
    const risk = await assessRisk(firstContact('boss', true), BUNDLE);
    expect(risk.band).toBe('routine');
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

  // The point of this one: `boss` is on the exempt list, and it still is not
  // enough on its own. Without a caller claiming the level was reduced over
  // THIS action's chain, a `boss` stamped once on the job says nothing about
  // who chose this recipient — which is the whole injection path — so the
  // escalation must stay on.
  it('escalates a boss origin nobody derived for this action\'s own chain', async () => {
    const BUNDLE = await bundle();
    const risk = await assessRisk(firstContact('boss', false), BUNDLE);
    expect(risk.band).toBe('sensitive');
  });

  // Nothing in the system sets the signal yet, so the path a real call takes
  // — through `buildFacts`, which defaults it to false — must escalate too.
  // Asserting it on hand-built facts alone would pass even if `buildFacts`
  // defaulted the signal the other way.
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

  it('still escalates a boss-origin first contact that carries money', async () => {
    const BUNDLE = await bundle();
    // The exemption only lifts the first-contact escalation; it does not
    // touch the money-weighted total. ₪500 against the fixture's ₪10,000
    // daily ceiling stays under ROUTINE_MAX_TOTAL on its own (score 22 of
    // 25), so it would pass this assertion even with the exemption applied
    // too broadly. ₪5,000 (half the daily ceiling) clears it.
    const facts = { ...firstContact('boss', true), amountMinor: 500_000, amountDeclared: true };
    const risk = await assessRisk(facts, BUNDLE);
    expect(risk.band).not.toBe('routine');
  });
});
