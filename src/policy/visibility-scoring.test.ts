import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { ActionFacts, PolicyBundle } from '../domain/policy.js';
import { assessRisk } from './risk.js';

const BUSINESS = 'test-business';

/**
 * `scoreVisibility` is the one place in the risk engine where a match makes the
 * outcome *less* restrictive: `one_known` scores 25 instead of 55 and, more
 * importantly, skips the first-contact escalation entirely. Everywhere else in
 * this codebase a broader match tightens something, and the any-of form is
 * correct. Here it is not — a control that loosens has to be satisfied by the
 * WORST recipient, never by the best one.
 */
function outbound(overrides: Partial<ActionFacts> = {}): ActionFacts {
  return {
    toolName: 'mail.send',
    actionClass: 'email.initiate',
    provenance: 'boss',
    chainDepth: 0,
    provenanceChainDerived: false,
    inputHash: 'h',
    amountMinor: 0,
    amountDeclared: false,
    counterpartyId: null,
    counterpartyEmails: [],
    counterpartyPhones: [],
    counterpartyTags: [],
    dataClasses: [],
    leavesInstance: true,
    supplierId: null,
    discountPercent: 0,
    ...overrides,
  };
}

let bundle: PolicyBundle;

beforeEach(async () => {
  await resetDatabase();
  bundle = await installCharter(
    buildCharter({ knownCounterpartyEmailDomain: 'acme.co.il' }),
    { businessId: BUSINESS },
  );
});

afterAll(async () => {
  await closePool();
});

describe('scoreVisibility', () => {
  it('does not let a known recipient vouch for an unknown co-recipient', async () => {
    const assessment = await assessRisk(
      outbound({ counterpartyEmails: ['dana@acme.co.il', 'attacker@evil.example'] }),
      bundle,
    );

    expect(assessment.dimensions.externalVisibility.audience).toBe('one_unknown');
  });

  it('does not let an identifier the charter knows vouch for an address it does not', async () => {
    const assessment = await assessRisk(
      outbound({ counterpartyId: 'c_812', counterpartyEmails: ['attacker@evil.example'] }),
      bundle,
    );

    expect(assessment.dimensions.externalVisibility.audience).toBe('one_unknown');
  });

  it('still resolves when every recipient is known', async () => {
    const assessment = await assessRisk(
      outbound({ counterpartyEmails: ['dana@acme.co.il', 'yossi@acme.co.il'] }),
      bundle,
    );

    expect(assessment.dimensions.externalVisibility.audience).toBe('one_known');
  });

  // An action that addresses a system rather than a person — `crm.write` with a
  // counterparty id and no address anywhere in the payload — must keep
  // resolving by identifier. Requiring an address there would escalate every
  // record-keeping write to a human, which is a different bug in the other
  // direction.
  it('still resolves by identifier when the action carries no address at all', async () => {
    const assessment = await assessRisk(
      outbound({ actionClass: 'crm.write', toolName: 'crm.write', counterpartyId: 'c_812' }),
      bundle,
    );

    expect(assessment.dimensions.externalVisibility.audience).toBe('one_known');
  });

  // `readEmails` reads `to`, `recipient` AND `email`, and its docblock says it
  // over-approximates on purpose because "a false positive there costs
  // nothing". Under `every` a false positive costs an approval, so a display
  // name sitting in `recipient` would drag a perfectly known address to
  // `one_unknown`. Only tokens that actually parse as an address can be
  // recipients — a string with no domain is never delivered to.
  it('is not dragged to unknown by a display name that is not an address', async () => {
    const assessment = await assessRisk(
      outbound({ counterpartyEmails: ['dana@acme.co.il', 'dana cohen'] }),
      bundle,
    );

    expect(assessment.dimensions.externalVisibility.audience).toBe('one_known');
  });

  // The every-address rule is about MESSAGING someone unidentified. A write to
  // a system of record addresses no one — `addresseeOf('crm.write')` is
  // `internal` — and the email in its payload is the row's content, not a
  // destination. Requiring it to resolve would put one approval in front of
  // every new lead ever filed, which is a different bug in the other direction.
  it('does not escalate a record-keeping write that merely contains an address', async () => {
    const assessment = await assessRisk(
      outbound({
        actionClass: 'crm.write',
        toolName: 'crm.write',
        counterpartyId: 'c_812',
        counterpartyEmails: ['newlead@unknown.example'],
      }),
      bundle,
    );

    expect(assessment.dimensions.externalVisibility.audience).toBe('one_known');
  });

  // The invariant behind all of the above, stated once so a future edit that
  // reintroduces `.some()` fails here even if it keeps the cases above green.
  // Strictly greater, not merely not-lower: under the defect the two scores are
  // EQUAL — the stranger is absorbed silently — so a `>=` assertion would pass
  // against the very bug it is meant to catch.
  it('raises the score when an unknown recipient is added to a known one', async () => {
    const known = await assessRisk(outbound({ counterpartyEmails: ['dana@acme.co.il'] }), bundle);
    const knownPlusStranger = await assessRisk(
      outbound({ counterpartyEmails: ['dana@acme.co.il', 'attacker@evil.example'] }),
      bundle,
    );

    expect(knownPlusStranger.dimensions.externalVisibility.score).toBeGreaterThan(
      known.dimensions.externalVisibility.score,
    );
  });
});
