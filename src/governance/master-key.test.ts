import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { putSecret, storedCredentials } from './credential-store.js';
import { encryptSecret } from './secret-cipher.js';
import {
  KEY_BYTES,
  MasterKeyError,
  isModeTooOpen,
  loadMasterKey,
  verifyKeyState,
  writeKeyState,
} from './master-key.js';

let DIR: string;

beforeEach(async () => {
  await resetDatabase();
  DIR = await mkdtemp(join(tmpdir(), 'master-key-'));
});

afterEach(async () => {
  await rm(DIR, { recursive: true, force: true });
});

afterAll(async () => {
  await closePool();
});

/** Writes with 0600 so tests not aimed at the permission check never trip it. */
async function writeKeyFile(bytes: Buffer): Promise<string> {
  const path = join(DIR, 'master.key');
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

describe('loadMasterKey', () => {
  it('reads a 32-byte key file', async () => {
    const key = randomBytes(KEY_BYTES);
    const path = await writeKeyFile(key);

    const loaded = await loadMasterKey(path);

    expect(loaded.equals(key)).toBe(true);
  });

  it('refuses a key file that is the wrong length', async () => {
    const path = await writeKeyFile(randomBytes(16));

    await expect(loadMasterKey(path)).rejects.toThrow(MasterKeyError);
    await expect(loadMasterKey(path)).rejects.toThrow(/16/);
  });

  it('refuses when the file does not exist', async () => {
    const path = join(DIR, 'nowhere.key');

    await expect(loadMasterKey(path)).rejects.toThrow(MasterKeyError);
  });

  /**
   * Spec §4.2 — permissions. On a POSIX filesystem a key readable by everyone
   * is a key that is not protected, and the install must refuse rather than
   * run with it. Windows reports a different mode, so the check is skipped
   * there — via `skipIf`, which vitest reports as SKIPPED rather than
   * passed, so the missing coverage stays visible instead of reading green.
   */
  it.skipIf(process.platform === 'win32')(
    'refuses a world-readable key file on POSIX',
    async () => {
      const path = await writeKeyFile(randomBytes(KEY_BYTES));
      await chmod(path, 0o644);

      await expect(loadMasterKey(path)).rejects.toThrow(MasterKeyError);
    },
  );
});

/**
 * The decision itself — "is this mode too open?" — is a pure function of an
 * integer, so it gets full coverage here on every platform, independent of
 * whether the current OS's `fs.stat().mode` actually carries POSIX bits.
 * That leaves the filesystem test above (skipped on win32) to cover only the
 * wiring: does `assertKeyFilePermissions` call this with the real mode.
 */
describe('isModeTooOpen', () => {
  it.each([
    [0o600, false],
    [0o400, false],
    [0o640, true],
    [0o644, true],
    [0o660, true],
    [0o700, false],
    [0o777, true],
  ])('mode %o -> %s', (mode, expected) => {
    expect(isModeTooOpen(mode)).toBe(expected);
  });
});

describe('verifyKeyState / writeKeyState', () => {
  /**
   * Spec §5.1 — a wrong or damaged key must be caught at startup, BEFORE any
   * real secret is touched. Without this, a replaced key file surfaces as a
   * customer's email failing at three in the morning rather than as a
   * refusal to start.
   */
  it('accepts the key that wrote the key state', async () => {
    const keyA = randomBytes(KEY_BYTES);
    await writeKeyState(keyA, 'key-a', testDb());

    await expect(verifyKeyState(keyA, testDb())).resolves.toBeUndefined();
  });

  it('refuses a different key against a stored key state', async () => {
    const keyA = randomBytes(KEY_BYTES);
    const keyB = randomBytes(KEY_BYTES);
    await writeKeyState(keyA, 'key-a', testDb());

    await expect(verifyKeyState(keyB, testDb())).rejects.toThrow(MasterKeyError);
  });

  /**
   * The key state is the server's one row (spec §5.9). Before it was, each
   * business had a row of its own, and a business with none failed the check
   * on its own connection — so a business created after the key could not
   * store or resolve a secret. Checked on the business's own connection, the
   * way a dashboard request runs it.
   */
  it('passes the key check for a freshly created business, which then resolves its secrets', async () => {
    const key = randomBytes(KEY_BYTES);
    await writeKeyState(key, 'key-server', testDb());
    const fresh = 'test-business-created-after-key';
    await registerBusiness(fresh);

    await expect(withBusiness(fresh, (db) => verifyKeyState(key, db))).resolves.toBeUndefined();
    await withBusiness(fresh, (db) => putSecret(db, { ref: 'FRESH', value: 'fresh-secret', updatedBy: 'test' }, key));
    expect((await storedCredentials(key).resolve('FRESH', fresh))?.value).toBe('fresh-secret');
  });

  it('writes one row for the server, however often it is written', async () => {
    await writeKeyState(randomBytes(KEY_BYTES), 'key-1', testDb());
    const key = randomBytes(KEY_BYTES);
    await writeKeyState(key, 'key-2', testDb());

    const { rows } = await testDb().query<{ key_id: string; check_business_id: string }>(
      'SELECT key_id, check_business_id FROM server_key_state',
    );
    expect(rows).toEqual([{ key_id: 'key-2', check_business_id: '' }]);
    await expect(verifyKeyState(key, testDb())).resolves.toBeUndefined();
  });

  /**
   * Migration 067 carries the old business row across without re-sealing it
   * (a migration never holds the key), so its check value is sealed for the
   * business the installation was configured for, named in
   * `check_business_id`. It must still verify — and only under that name.
   */
  it('verifies a carried-over key state under the business it was sealed for', async () => {
    const key = randomBytes(KEY_BYTES);
    const sealed = encryptSecret('credential-broker-key-check', key, { businessId: 'dev-business', ref: 'key-check' });
    await testDb().query(
      `INSERT INTO server_key_state (singleton, key_id, check_nonce, check_value, check_business_id)
       VALUES (true, 'key-legacy', $1, $2, 'dev-business')`,
      [sealed.nonce, sealed.ciphertext],
    );
    await expect(verifyKeyState(key, testDb())).resolves.toBeUndefined();
    await expect(verifyKeyState(randomBytes(KEY_BYTES), testDb())).rejects.toThrow(MasterKeyError);

    await testDb().query(`UPDATE server_key_state SET check_business_id = 'other-business'`);
    await expect(verifyKeyState(key, testDb())).rejects.toThrow(MasterKeyError);
  });

  it('accepts any key when no key state has been written yet', async () => {
    const key = randomBytes(KEY_BYTES);

    await expect(verifyKeyState(key, testDb())).resolves.toBeUndefined();
  });
});
