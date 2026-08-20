import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { ActionFacts, PolicyBundle } from '../domain/policy.js';
import type { TrustLevel } from '../domain/trust.js';
import { assessRisk } from './risk.js';

const BUSINESS = 'test-business';

/** Facts for a first contact: an address nothing in the charter resolves. */
function firstContact(provenance: TrustLevel): ActionFacts {
  return {
    toolName: 'mail.send',
    actionClass: 'email.initiate',
    provenance,
    chainDepth: 0,
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
    const risk = await assessRisk(firstContact('boss'), BUNDLE);
    expect(risk.band).toBe('routine');
  });

  it('escalates when the chain passed through an inbound email', async () => {
    const BUNDLE = await bundle();
    const risk = await assessRisk(firstContact('unknown_external'), BUNDLE);
    expect(risk.band).toBe('sensitive');
  });

  it('escalates for staff, which is not on the exempt list', async () => {
    const BUNDLE = await bundle();
    const risk = await assessRisk(firstContact('staff'), BUNDLE);
    expect(risk.band).toBe('sensitive');
  });

  it('still escalates a boss-origin first contact that carries money', async () => {
    const BUNDLE = await bundle();
    // The exemption only lifts the first-contact escalation; it does not
    // touch the money-weighted total. ₪500 against the fixture's ₪10,000
    // daily ceiling stays under ROUTINE_MAX_TOTAL on its own (score 22 of
    // 25), so it would pass this assertion even with the exemption applied
    // too broadly. ₪5,000 (half the daily ceiling) clears it.
    const facts = { ...firstContact('boss'), amountMinor: 500_000, amountDeclared: true };
    const risk = await assessRisk(facts, BUNDLE);
    expect(risk.band).not.toBe('routine');
  });
});
