import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './secret-cipher.js';

const KEY = randomBytes(32);
const AAD = { businessId: 'biz-a', ref: 'OFFICE_MAIL' };

describe('the secret cipher', () => {
  it('returns exactly what was sealed', () => {
    const sealed = encryptSecret('hunter2', KEY, AAD);
    expect(decryptSecret(sealed, KEY, AAD)).toBe('hunter2');
  });

  it('never produces the same ciphertext twice for the same input', () => {
    const a = encryptSecret('hunter2', KEY, AAD);
    const b = encryptSecret('hunter2', KEY, AAD);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  /**
   * Spec §4.4 — the control this whole design rests on, and the one that does
   * NOT depend on our having written the queries correctly. A row lifted from
   * one customer into another's must fail to open, not open wrongly.
   */
  it('refuses to open a row under a different business', () => {
    const sealed = encryptSecret('hunter2', KEY, AAD);
    expect(decryptSecret(sealed, KEY, { ...AAD, businessId: 'biz-b' })).toBeNull();
  });

  it('refuses to open a row under a different ref', () => {
    const sealed = encryptSecret('hunter2', KEY, AAD);
    expect(decryptSecret(sealed, KEY, { ...AAD, ref: 'OTHER_MAIL' })).toBeNull();
  });

  it('refuses to open with the wrong key', () => {
    const sealed = encryptSecret('hunter2', KEY, AAD);
    expect(decryptSecret(sealed, randomBytes(32), AAD)).toBeNull();
  });

  /**
   * A tampered row must be REFUSED, never returned altered. GCM authenticates,
   * so this is a property of the mode — the test is here because relying on a
   * property nobody checked is how it gets swapped for one that lacks it.
   */
  it('refuses a ciphertext that was altered by a single byte', () => {
    const sealed = encryptSecret('hunter2', KEY, AAD);
    const tampered = Buffer.from(sealed.ciphertext);
    const first = tampered[0];
    if (first === undefined) throw new Error('empty ciphertext');
    tampered[0] = first ^ 0x01;
    expect(decryptSecret({ ...sealed, ciphertext: tampered }, KEY, AAD)).toBeNull();
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => encryptSecret('hunter2', randomBytes(16), AAD)).toThrow();
  });
});
