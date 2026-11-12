import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { putSecret, resolveStoredSecret } from '../governance/credential-store.js';
import { KEY_BYTES, writeKeyState } from '../governance/master-key.js';
import { resetDatabase, testDb } from '../test/db.js';
import {
  PlatformCredentialError,
  platformSecrets,
  putPlatformSecret,
  removePlatformSecret,
  resolvePlatformSecret,
} from './platform-credentials.js';

const BUSINESS = 'test-platform-secrets';
const REF = 'GOOGLE_OAUTH_CLIENT_SECRET';
let KEY: Buffer;

beforeEach(async () => {
  await resetDatabase();
  KEY = randomBytes(KEY_BYTES);
  await writeKeyState(KEY, 'key-1');
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

describe('platform credentials', () => {
  it('stores and resolves a platform secret, and a rewrite replaces it', async () => {
    await putPlatformSecret(REF, 'first', KEY, 'test');
    expect(await resolvePlatformSecret(REF, KEY)).toBe('first');
    await putPlatformSecret(REF, 'second', KEY, 'test');
    expect(await platformSecrets(KEY).resolve(REF)).toBe('second');
    expect(await resolvePlatformSecret('MISSING_REF', KEY)).toBeNull();
  });

  it('never stores the value in a readable column', async () => {
    await putPlatformSecret(REF, 'plain-sentinel-value', KEY, 'test');
    const { rows } = await testDb().query<{ ciphertext: Buffer; key_id: string }>(
      'SELECT ciphertext, key_id FROM platform_credentials',
    );
    expect(rows[0]?.key_id).toBe('key-1');
    expect(rows[0]?.ciphertext.toString('utf8')).not.toContain('plain-sentinel-value');
  });

  it('refuses a ref outside the legal shape', async () => {
    await expect(putPlatformSecret('grant:mailbox', 'x', KEY, 'test')).rejects.toThrow(PlatformCredentialError);
    expect(await resolvePlatformSecret('key-check', KEY)).toBeNull();
  });

  it('platform secret does not open as a business secret and vice versa', async () => {
    await putPlatformSecret(REF, 'platform-value', KEY, 'test');
    await withBusiness(BUSINESS, (db) => putSecret(db, { ref: REF, value: 'business-value', updatedBy: 'test' }, KEY));

    // Positive half first: each store opens its own row under the same ref.
    expect(await resolvePlatformSecret(REF, KEY)).toBe('platform-value');
    expect((await withBusiness(BUSINESS, (db) => resolveStoredSecret(db, KEY, REF)))?.value).toBe('business-value');

    // Swap the sealed bytes between the two tables.
    const platform = await testDb().query<{ ciphertext: Buffer; nonce: Buffer }>(
      'SELECT ciphertext, nonce FROM platform_credentials WHERE ref = $1',
      [REF],
    );
    const business = await testDb().query<{ ciphertext: Buffer; nonce: Buffer }>(
      'SELECT ciphertext, nonce FROM credentials WHERE business_id = $1 AND ref = $2',
      [BUSINESS, REF],
    );
    const p = platform.rows[0];
    const b = business.rows[0];
    if (p === undefined || b === undefined) throw new Error('both rows were just written');
    await testDb().query('UPDATE platform_credentials SET ciphertext = $2, nonce = $3 WHERE ref = $1', [
      REF,
      b.ciphertext,
      b.nonce,
    ]);
    await testDb().query(
      'UPDATE credentials SET ciphertext = $3, nonce = $4 WHERE business_id = $1 AND ref = $2',
      [BUSINESS, REF, p.ciphertext, p.nonce],
    );

    expect(await resolvePlatformSecret(REF, KEY)).toBeNull();
    expect(await withBusiness(BUSINESS, (db) => resolveStoredSecret(db, KEY, REF))).toBeNull();
  });

  it('a wrong key opens nothing', async () => {
    await putPlatformSecret(REF, 'v', KEY, 'test');
    expect(await resolvePlatformSecret(REF, randomBytes(KEY_BYTES))).toBeNull();
  });

  it('removes a secret and reports whether one was there', async () => {
    await putPlatformSecret(REF, 'v', KEY, 'test');
    expect(await removePlatformSecret(REF, KEY)).toBe(true);
    expect(await removePlatformSecret(REF, KEY)).toBe(false);
    expect(await resolvePlatformSecret(REF, KEY)).toBeNull();
  });
});
