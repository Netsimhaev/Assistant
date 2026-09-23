import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { KEY_BYTES, MasterKeyError, loadMasterKey, verifyKeyState, writeKeyState } from './master-key.js';

const BUSINESS = 'test-business';

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

describe('verifyKeyState / writeKeyState', () => {
  /**
   * Spec §5.1 — a wrong or damaged key must be caught at startup, BEFORE any
   * real secret is touched. Without this, a replaced key file surfaces as a
   * customer's email failing at three in the morning rather than as a
   * refusal to start.
   */
  it('accepts the key that wrote the key state', async () => {
    const keyA = randomBytes(KEY_BYTES);
    await writeKeyState(keyA, 'key-a', { businessId: BUSINESS });

    await expect(verifyKeyState(keyA, { businessId: BUSINESS })).resolves.toBeUndefined();
  });

  it('refuses a different key against a stored key state', async () => {
    const keyA = randomBytes(KEY_BYTES);
    const keyB = randomBytes(KEY_BYTES);
    await writeKeyState(keyA, 'key-a', { businessId: BUSINESS });

    await expect(verifyKeyState(keyB, { businessId: BUSINESS })).rejects.toThrow(MasterKeyError);
  });

  it('accepts any key when no key state has been written yet', async () => {
    const key = randomBytes(KEY_BYTES);

    await expect(verifyKeyState(key, { businessId: BUSINESS })).resolves.toBeUndefined();
  });
});
