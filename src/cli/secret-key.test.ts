import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, getPool } from '../db/pool.js';
import { putSecret, storedCredentials } from '../governance/credential-store.js';
import { MasterKeyError, loadMasterKey, verifyKeyState } from '../governance/master-key.js';
import { resetDatabase } from '../test/db.js';
import { runSecretKeyCli } from './secret-key.js';
import type { SecretKeyCliDeps } from './secret-key.js';

const OPERATOR = 'operator@example.com';
const PASSPHRASE = 'correct horse battery staple';

let DIR: string;
let KEY_PATH: string;

function collector(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line: string) => lines.push(line), lines };
}

/** A `readPassphrase` that never touches argv or a terminal. */
function reads(value: string): () => Promise<string> {
  return async () => value;
}

function deps(overrides: Partial<SecretKeyCliDeps> = {}): SecretKeyCliDeps {
  return {
    log: () => {},
    readPassphrase: reads(PASSPHRASE),
    keyPath: KEY_PATH,
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDatabase();
  DIR = await mkdtemp(join(tmpdir(), 'secret-key-cli-'));
  KEY_PATH = join(DIR, 'master.key');
});

afterEach(async () => {
  await rm(DIR, { recursive: true, force: true });
});

afterAll(async () => {
  await closePool();
});

describe('runSecretKeyCli create', () => {
  /**
   * Spec §5.3 — shown once at creation, never again. A tool that can
   * reprint the key is a tool that will be asked to.
   */
  it('prints the key once at creation and has no command that prints it again', async () => {
    const { log, lines } = collector();
    await runSecretKeyCli(['create', OPERATOR], deps({ log }));

    const keyBase64 = (await readFile(KEY_PATH)).toString('base64');
    expect(lines.some((line) => line.includes(keyBase64))).toBe(true);

    // `rotate` mints a brand new key. It must never print either the old
    // value or the new one — the recovery copy is the durable backup, not
    // a second printout.
    const rotateLog = collector();
    await runSecretKeyCli(['rotate', OPERATOR], deps({ log: rotateLog.log }));
    const rotatedBase64 = (await readFile(KEY_PATH)).toString('base64');
    expect(rotatedBase64).not.toBe(keyBase64);
    expect(rotateLog.lines.some((line) => line.includes(keyBase64))).toBe(false);
    expect(rotateLog.lines.some((line) => line.includes(rotatedBase64))).toBe(false);

    // `restore` recovers a lost key file. It must not print it either.
    await rm(KEY_PATH);
    const restoreLog = collector();
    await runSecretKeyCli(['restore', OPERATOR], deps({ log: restoreLog.log }));
    const restoredBase64 = (await readFile(KEY_PATH)).toString('base64');
    expect(restoredBase64).toBe(rotatedBase64);
    expect(restoreLog.lines.some((line) => line.includes(restoredBase64))).toBe(false);

    // And there is no fourth command that could be asked to show it.
    await expect(
      runSecretKeyCli(['show', OPERATOR], deps({ log: () => {} })),
    ).rejects.toThrow();
  });

  /**
   * Spec §5.1 — the check row `verifyKeyState` reads must exist before any
   * later boot can recognise a good key from a bad one.
   */
  it('writes the key state so a later verification can recognise this key', async () => {
    await runSecretKeyCli(['create', OPERATOR], deps());

    const key = await loadMasterKey(KEY_PATH);
    await expect(verifyKeyState(key, { businessId: config.businessId })).resolves.toBeUndefined();

    const wrongKey = randomBytes(32);
    await expect(
      verifyKeyState(wrongKey, { businessId: config.businessId }),
    ).rejects.toThrow(MasterKeyError);
  });

  it('refuses to create a key where one already exists, rather than overwriting it', async () => {
    await runSecretKeyCli(['create', OPERATOR], deps());
    const original = await readFile(KEY_PATH);

    await expect(
      runSecretKeyCli(['create', OPERATOR], deps({ readPassphrase: reads('a different one') })),
    ).rejects.toThrow();

    const after = await readFile(KEY_PATH);
    expect(after.equals(original)).toBe(true);
  });

  /**
   * The file is not the only signal: the database can still hold the key
   * state row after the file itself was moved or deleted, and creating a
   * fresh key in that case would orphan every secret already sealed under
   * the one the database still expects.
   */
  it('refuses to create a key when a key state already exists for this business, even without the file', async () => {
    await runSecretKeyCli(['create', OPERATOR], deps());
    await rm(KEY_PATH);

    await expect(runSecretKeyCli(['create', OPERATOR], deps())).rejects.toThrow();
    await expect(stat(KEY_PATH)).rejects.toThrow();
  });
});

describe('runSecretKeyCli restore', () => {
  /**
   * Spec §5.2 — the recovery copy. Losing the key file must be a nuisance,
   * not a catastrophe; losing the passphrase as well is the catastrophe,
   * and that residue is stated rather than engineered away.
   */
  it('restores exactly the original key from the recovery copy', async () => {
    await runSecretKeyCli(['create', OPERATOR], deps());
    const original = await readFile(KEY_PATH);

    await rm(KEY_PATH);
    await runSecretKeyCli(['restore', OPERATOR], deps());

    const restored = await readFile(KEY_PATH);
    expect(restored.equals(original)).toBe(true);
  });

  it('refuses to restore with the wrong passphrase', async () => {
    await runSecretKeyCli(['create', OPERATOR], deps());
    await rm(KEY_PATH);

    await expect(
      runSecretKeyCli(
        ['restore', OPERATOR],
        deps({ readPassphrase: reads('nothing like the real one') }),
      ),
    ).rejects.toThrow();

    await expect(stat(KEY_PATH)).rejects.toThrow();
  });

  it('refuses to restore over a key file that already exists', async () => {
    await runSecretKeyCli(['create', OPERATOR], deps());
    const original = await readFile(KEY_PATH);

    await expect(runSecretKeyCli(['restore', OPERATOR], deps())).rejects.toThrow();

    const after = await readFile(KEY_PATH);
    expect(after.equals(original)).toBe(true);
  });
});

describe('runSecretKeyCli rotate', () => {
  /**
   * Spec §4.5 — rotation re-encrypts every row under the new key and leaves
   * none behind. A partial rotation is worse than none: some rows open
   * with the old key, some with the new, and no single key opens the
   * install.
   */
  it('re-encrypts every stored secret on rotation, leaving none under the old key', async () => {
    await runSecretKeyCli(['create', OPERATOR], deps());
    const oldKey = await loadMasterKey(KEY_PATH);

    await putSecret(
      { businessId: config.businessId, ref: 'ONE', value: 'first-secret', updatedBy: OPERATOR },
      oldKey,
    );
    await putSecret(
      { businessId: config.businessId, ref: 'TWO', value: 'second-secret', updatedBy: OPERATOR },
      oldKey,
    );

    const { rows: beforeRows } = await getPool().query<{ key_id: string }>(
      'SELECT key_id FROM credentials ORDER BY ref',
    );
    const oldKeyId = beforeRows[0]?.key_id;
    expect(oldKeyId).toBeDefined();

    await runSecretKeyCli(['rotate', OPERATOR], deps());
    const newKey = await loadMasterKey(KEY_PATH);
    expect(newKey.equals(oldKey)).toBe(false);

    const { rows: afterRows } = await getPool().query<{ ref: string; key_id: string }>(
      'SELECT ref, key_id FROM credentials ORDER BY ref',
    );
    expect(afterRows).toHaveLength(2);
    for (const row of afterRows) {
      expect(row.key_id).not.toBe(oldKeyId);
    }

    // Every row still resolves, now under the new key, with its value
    // untouched by the round trip.
    const one = await storedCredentials(newKey).resolve('ONE', config.businessId);
    const two = await storedCredentials(newKey).resolve('TWO', config.businessId);
    expect(one?.value).toBe('first-secret');
    expect(two?.value).toBe('second-secret');

    // And none of them open under the old key any more — this is the
    // "leaves none under the old key" half of the claim, not just "the new
    // key also works".
    expect(await storedCredentials(oldKey).resolve('ONE', config.businessId)).toBeNull();
    expect(await storedCredentials(oldKey).resolve('TWO', config.businessId)).toBeNull();

    // The database's own key state agrees with the file that now sits on
    // disk — startup's `verifyKeyState` would accept it.
    await expect(verifyKeyState(newKey, { businessId: config.businessId })).resolves.toBeUndefined();
  });

  it('refuses to rotate when the key file does not match the installation state', async () => {
    await runSecretKeyCli(['create', OPERATOR], deps());
    // Simulate a swapped-in wrong key file — the same corruption
    // `verifyKeyState` exists to catch at startup.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(KEY_PATH, randomBytes(32), { mode: 0o600 });

    await expect(runSecretKeyCli(['rotate', OPERATOR], deps())).rejects.toThrow(MasterKeyError);
  });
});

describe('runSecretKeyCli argument handling', () => {
  it('rejects an unknown command', async () => {
    await expect(runSecretKeyCli(['delete', OPERATOR], deps())).rejects.toThrow();
  });

  it('rejects a missing operator', async () => {
    await expect(runSecretKeyCli(['create'], deps())).rejects.toThrow();
  });
});
