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

  it('flattens doNotContact into a lookup the gate reads per call', () => {
    const bundle = compileCharter(buildCharter());
    expect(bundle.doNotContact).toContain('c_blocked');
    expect(bundle.doNotContact).not.toContain('c_812');
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
