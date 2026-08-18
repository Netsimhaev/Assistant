import { describe, expect, it } from 'vitest';
import { buildCharter } from '../test/fixtures.js';
import { compileCharter } from './compile.js';
import { verifyCharterSignature } from './sign.js';

describe('charter signing', () => {
  it('verifies a charter that has not been touched', () => {
    expect(verifyCharterSignature(buildCharter()).valid).toBe(true);
  });

  it('detects a raised money ceiling', () => {
    const charter = buildCharter();
    const tampered = {
      ...charter,
      money: { ...charter.money, dailyCeilingMinor: 99_000_000 },
    };

    const result = verifyCharterSignature(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/does not match its signature/);
  });

  it('detects a loosened autonomy level', () => {
    const charter = buildCharter();
    const tampered = {
      ...charter,
      autonomy: {
        ...charter.autonomy,
        base: { ...charter.autonomy.base, 'payment.make': 'auto' as const },
      },
    };

    expect(verifyCharterSignature(tampered).valid).toBe(false);
  });

  it('refuses to compile an unverified charter', () => {
    const charter = buildCharter();
    const tampered = {
      ...charter,
      forbidden: [],
    };

    expect(() => compileCharter(tampered)).toThrow(/refusing to compile an unverified charter/);
  });
});

describe('charter compilation', () => {
  it('carries the signed hash into the bundle so the gate can bind to it', () => {
    const charter = buildCharter();
    const bundle = compileCharter(charter);

    expect(bundle.charterVersion).toBe(charter.charterVersion);
    expect(bundle.contentHash).toBe(charter.signature.contentHash);
  });

  it('compiles forbidden rules into denials the gate can cite', () => {
    const bundle = compileCharter(buildCharter());
    const forbidden = bundle.rules.filter((r) => r.kind === 'forbidden');

    expect(forbidden.map((r) => r.id)).toContain('forbidden:no_customer_data_export');
    expect(forbidden.every((r) => r.description.length > 0)).toBe(true);
  });

  it('sorts doNotContact by match key instead of flattening it', () => {
    const bundle = compileCharter(buildCharter());
    expect(bundle.doNotContact.entityIds).toContain('c_blocked');
    expect(bundle.doNotContact.entityIds).not.toContain('c_812');
  });

  it('compiles a domain block into the bucket the gate can actually match', () => {
    // The flattened form put every match key into one list compared against
    // `counterpartyId`, so this entry compiled and then matched nothing at all.
    const bundle = compileCharter(
      buildCharter({ doNotContactEmailDomain: 'Rival-Legal.CO.il' }),
    );

    expect(bundle.doNotContact.emailDomains).toEqual(['rival-legal.co.il']);
    // Normalised at compile time, because the gate normalises the payload the
    // same way — a block defeated by capitalisation is not a block.
    expect(bundle.doNotContact.entityIds).not.toContain('rival-legal.co.il');
  });

  it('lists known counterparties so the risk layer need not trust the payload', () => {
    const bundle = compileCharter(buildCharter());
    expect(bundle.knownCounterparties).toContain('c_812');
  });

  it('renders plain language stating the daily exposure in one sentence', () => {
    const bundle = compileCharter(buildCharter());
    // The owner signs this, so the number that bounds their worst day must be
    // in it, in words, not buried in JSON.
    expect(bundle.plainLanguage).toContain('₪10,000');
    expect(bundle.plainLanguage).toMatch(/החשיפה הכספית המקסימלית/);
  });

  it('gives every agent a prompt fragment carrying the business identity', () => {
    const bundle = compileCharter(buildCharter());
    for (const [agent, fragment] of Object.entries(bundle.promptFragments)) {
      expect(fragment, agent).toContain('דוגמה הנדסה');
    }
    // The quarantine agents must be told their input is data, not instructions.
    expect(bundle.promptFragments['intake.triage']).toMatch(/אינו אמין/);
    expect(bundle.promptFragments['know.reader']).toMatch(/אינו אמין/);
  });
});
