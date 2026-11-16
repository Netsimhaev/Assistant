import { describe, expect, it } from 'vitest';
import { currentStep, generateTotpSecret, matchTotp, otpauthUri, totpCode } from './totp.js';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp', () => {
  it('matches RFC 6238 vectors', () => {
    expect(totpCode(SECRET, 1)).toBe('287082');
    expect(totpCode(SECRET, 37037036)).toBe('081804');
  });

  it('generates a 32-char base32 secret', () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('currentStep floors to 30s', () => {
    expect(currentStep(new Date(59_999))).toBe(1);
  });

  describe('matchTotp', () => {
    const now = new Date(1_700_000_000_000);
    const cur = currentStep(now);
    it('accepts -1, 0, +1', () => {
      for (const d of [-1, 0, 1]) {
        expect(matchTotp(SECRET, totpCode(SECRET, cur + d), now, null)).toBe(cur + d);
      }
    });
    it('rejects +-2', () => {
      for (const d of [-2, 2]) {
        expect(matchTotp(SECRET, totpCode(SECRET, cur + d), now, null)).toBeNull();
      }
    });
    it('rejects replay of an already used step', () => {
      expect(matchTotp(SECRET, totpCode(SECRET, cur), now, cur)).toBeNull();
      expect(matchTotp(SECRET, totpCode(SECRET, cur - 1), now, cur)).toBeNull();
    });
    it('rejects malformed codes', () => {
      for (const c of ['12345', '1234567', 'abcdef']) {
        expect(matchTotp(SECRET, c, now, null)).toBeNull();
      }
    });
    it('strips spaces', () => {
      const t = new Date(59_000);
      expect(matchTotp(SECRET, ' 287 082 ', t, null)).toBe(1);
    });
  });

  it('otpauthUri round-trips', () => {
    const u = new URL(otpauthUri({ issuer: 'My Co', account: 'a@b.co', secretBase32: SECRET }));
    expect(u.protocol).toBe('otpauth:');
    expect(u.searchParams.get('secret')).toBe(SECRET);
    expect(u.searchParams.get('issuer')).toBe('My Co');
    expect(u.searchParams.get('digits')).toBe('6');
    expect(u.searchParams.get('period')).toBe('30');
  });
});
