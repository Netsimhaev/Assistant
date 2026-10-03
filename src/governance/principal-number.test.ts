import { describe, expect, it } from 'vitest';
import { buildCharter } from '../test/fixtures.js';
import { authorityNumberKey, isPrincipalSender, principalWhatsAppKey } from './principal-number.js';

function charterWithPrincipalNumber(number: string | undefined) {
  const base = buildCharter();
  const people = base.people.map((p, i) =>
    i === 0 ? { ...p, isPrincipal: true, channels: number === undefined ? {} : { whatsapp: number } } : p,
  );
  return { ...base, people };
}

describe('authorityNumberKey', () => {
  it('normalises the forms a real charter carries', () => {
    expect(authorityNumberKey('+972541234567')).toBe('972541234567');
    expect(authorityNumberKey('+972-54-123-4567')).toBe('972541234567');
    expect(authorityNumberKey(' +972 54 1234567 ')).toBe('972541234567');
  });

  /**
   * An authority list must not accept a national form. `054...` and
   * `+972 54...` are the same person to a human and different strings here,
   * and guessing a country code for an authority check is inventing authority.
   */
  it('refuses anything that is not a full international number', () => {
    expect(authorityNumberKey('0541234567')).toBeNull();
    expect(authorityNumberKey('541234567')).toBeNull();
    expect(authorityNumberKey('')).toBeNull();
    expect(authorityNumberKey('not a number')).toBeNull();
    expect(authorityNumberKey('+972')).toBeNull();
  });
});

describe('isPrincipalSender', () => {
  it('resolves the principal and nobody else', () => {
    const charter = charterWithPrincipalNumber('+972541234567');
    expect(isPrincipalSender(charter, '+972541234567')).toBe(true);
    expect(isPrincipalSender(charter, '+972549999999')).toBe(false);
  });

  /**
   * THE TRAP THIS MODULE EXISTS FOR. `phoneKey` in
   * `src/governance/typed-recipients.ts` compares the last NINE digits, and
   * it is right where it sits: both sides it compares are charter data the
   * owner curated (its own docblock says so), and its call site
   * (`knownToCharter`) is itself an authority-granting check that accepts
   * that cost on purpose. That justification does not transfer to an inbound
   * WhatsApp sender number, which nobody curated — a different number
   * sharing nine trailing digits would be read as the owner.
   */
  it('does not resolve a different number that shares its last nine digits', () => {
    const charter = charterWithPrincipalNumber('+972541234567');
    // Israeli +972-54-123-4567 and a US number ending in the same nine digits.
    expect(isPrincipalSender(charter, '+1541234567')).toBe(false);
    expect(isPrincipalSender(charter, '+999541234567')).toBe(false);
  });

  it('treats a charter with no principal number as having no authorised sender', () => {
    const charter = charterWithPrincipalNumber(undefined);
    expect(principalWhatsAppKey(charter)).toBeNull();
    expect(isPrincipalSender(charter, '+972541234567')).toBe(false);
  });

  /** Positive check: an unparseable sender is not the principal. Never the reverse. */
  it('refuses a sender whose own number does not normalise', () => {
    const charter = charterWithPrincipalNumber('+972541234567');
    expect(isPrincipalSender(charter, '0541234567')).toBe(false);
    expect(isPrincipalSender(charter, '')).toBe(false);
  });
});
