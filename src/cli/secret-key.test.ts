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
import { RotationAuditUnrecordedError, runSecretKeyCli } from './secret-key.js';
import type { SecretKeyCliDeps } from './secret-key.js';

const OPERATOR = 'operator@example.com';
const PASSPHRASE = 'correct horse battery staple';

let DIR: string;
let KEY_PATH: string;

function collector(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line: string) => lines.push(line), lines };
}

/** Whether a path is there at all — the check both survivability tests make. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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

/**
 * Spec §5.2 and §5.3 — the recovery copy and the one-time printout are two
 * of the three things standing between a lost key file and lost secrets.
 * Both used to be collected AFTER the key file was written and the
 * transaction had committed, so anything that threw at the passphrase prompt
 * — an empty line, an EOF, a Ctrl-D, all reachable from
 * `nodePromptIo.readSecret` — landed between the live key and its backup.
 *
 * These two tests are the behaviour, not the ordering: what they assert is
 * that a refused passphrase leaves the world exactly as it found it. Written
 * this way on purpose — an assertion on "the prompt is called first" would
 * pass again the moment someone reintroduced a write before it under a
 * different name.
 */
describe('a refused passphrase changes nothing', () => {
  it('leaves no key file, no key state and no recovery copy when create is given an empty passphrase', async () => {
    await expect(
      runSecretKeyCli(['create', OPERATOR], deps({ readPassphrase: reads('') })),
    ).rejects.toThrow(/סיסמה ריקה/);

    expect(await exists(KEY_PATH)).toBe(false);
    expect(await exists(`${KEY_PATH}.recovery`)).toBe(false);
    const { rows } = await getPool().query('SELECT 1 FROM credential_key_state');
    expect(rows).toHaveLength(0);

    // And the operator is not stuck: with a real passphrase the very next
    // `create` succeeds, rather than being refused by a guard that a
    // half-finished run had already tripped.
    await runSecretKeyCli(['create', OPERATOR], deps());
    expect(await exists(KEY_PATH)).toBe(true);
    expect(await exists(`${KEY_PATH}.recovery`)).toBe(true);
  });

  it('leaves the key, the rows and the recovery copy untouched when rotate is given an empty passphrase', async () => {
    await runSecretKeyCli(['create', OPERATOR], deps());
    const key = await loadMasterKey(KEY_PATH);
    await putSecret(
      { businessId: config.businessId, ref: 'ONE', value: 'first-secret', updatedBy: OPERATOR },
      key,
    );
    const recoveryBefore = await readFile(`${KEY_PATH}.recovery`, 'utf8');

    await expect(
      runSecretKeyCli(['rotate', OPERATOR], deps({ readPassphrase: reads('') })),
    ).rejects.toThrow(/סיסמה ריקה/);

    // Nothing rotated: the file on disk is still the key the rows are sealed
    // under, and the recovery copy is still a copy of THAT key — not of a
    // retired one, which is the state this ordering used to leave behind.
    const after = await loadMasterKey(KEY_PATH);
    expect(after.equals(key)).toBe(true);
    expect(await readFile(`${KEY_PATH}.recovery`, 'utf8')).toBe(recoveryBefore);
    await expect(verifyKeyState(key, { businessId: config.businessId })).resolves.toBeUndefined();
    expect((await storedCredentials(key).resolve('ONE', config.businessId))?.value).toBe(
      'first-secret',
    );

    // The recovery copy is not merely byte-identical, it still opens the
    // live key — the stale-copy failure was silent precisely because the
    // file looked fine.
    await rm(KEY_PATH);
    await runSecretKeyCli(['restore', OPERATOR], deps());
    expect((await loadMasterKey(KEY_PATH)).equals(key)).toBe(true);
  });
});

/**
 * Spec §6.4 — every action this tool takes is audited, always. The `create`
 * audit row used to be written last, after the key file, the key state and
 * the recovery file, so any throw in between left a key that exists with
 * nothing recording that it was ever made.
 */
describe('a key that exists is a key that was recorded', () => {
  it('writes the create audit row in the same transaction as the key state', async () => {
    await runSecretKeyCli(['create', OPERATOR], deps());

    const { rows } = await getPool().query<{ reason: string; on_behalf_of: string }>(
      "SELECT reason, on_behalf_of FROM audit_log WHERE kind = 'credential_change'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.on_behalf_of).toBe(OPERATOR);
    expect(rows[0]?.reason).toContain(OPERATOR);

    // The pairing, which is the actual claim: key state and audit row either
    // both exist or neither does.
    const { rows: state } = await getPool().query('SELECT 1 FROM credential_key_state');
    expect(state).toHaveLength(1);
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

/**
 * The boundary `killswitch.ts` and `erasure.ts` already named, at rotation's
 * only irreversible seam.
 *
 * `rotate` commits the re-encryption, writes the recovery copy and the live
 * key file, and only then appends its audit row — outside the transaction,
 * because holding the `audit:<business>` advisory lock for a whole
 * re-encryption pass would block every other audit writer. That leaves a
 * window where every secret has been re-encrypted and the record of it has
 * not been written. A raw database error there reads to the operator as "the
 * rotation failed", and an operator who believes that runs `rotate` again —
 * rotating a second time on top of a rotation nobody recorded.
 *
 * The audit failure is injected with a real constraint rather than a mock, so
 * `appendAudit` fails the way it would actually fail: inside its own INSERT.
 * `NOT VALID` so the rows `create` already wrote are not re-checked.
 */
describe('a rotation that committed says so even when its record does not', () => {
  it('throws RotationAuditUnrecordedError naming the key ids and the row count, with the rotation in force', async () => {
    await runSecretKeyCli(['create', OPERATOR], deps());
    const oldKey = await loadMasterKey(KEY_PATH);
    await putSecret(
      { businessId: config.businessId, ref: 'ONE', value: 'first-secret', updatedBy: OPERATOR },
      oldKey,
    );
    const { rows: before } = await getPool().query<{ key_id: string }>(
      'SELECT key_id FROM credential_key_state WHERE business_id = $1',
      [config.businessId],
    );
    const oldKeyId = before[0]?.key_id;
    expect(oldKeyId).toBeDefined();

    await getPool().query(
      `ALTER TABLE audit_log ADD CONSTRAINT tmp_reject_credential_change
         CHECK (kind <> 'credential_change') NOT VALID`,
    );

    let thrown: unknown;
    try {
      await runSecretKeyCli(['rotate', OPERATOR], deps());
    } catch (error) {
      thrown = error;
    } finally {
      await getPool().query('ALTER TABLE audit_log DROP CONSTRAINT tmp_reject_credential_change');
    }

    // 1. The typed error, not the raw database error underneath it.
    expect(thrown).toBeInstanceOf(RotationAuditUnrecordedError);
    if (!(thrown instanceof RotationAuditUnrecordedError)) throw new Error('unreachable');
    expect(thrown.rotationInForce).toBe(true);

    // 2. It names what an operator needs to rebuild the missing row — and the
    //    message carries it too, because `main()` prints `err.message` and
    //    nothing else.
    expect(thrown.outcome).toEqual({
      businessId: config.businessId,
      previousKeyId: oldKeyId,
      newKeyId: expect.stringMatching(/^KEY-/) as unknown as string,
      secretsReEncrypted: 1,
    });
    expect(thrown.message).toContain(oldKeyId as string);
    expect(thrown.message).toContain(thrown.outcome.newKeyId);
    expect(thrown.message).toContain('1');

    // Never the key, never a secret — the rule an error object is no more
    // exempt from than a log line.
    const newKey = await loadMasterKey(KEY_PATH);
    expect(thrown.message).not.toContain(newKey.toString('base64'));
    expect(thrown.message).not.toContain(oldKey.toString('base64'));
    expect(thrown.message).not.toContain('first-secret');

    // 3. The rotation really did take effect — the half that makes the error
    //    honest rather than merely typed. New key on disk, rows open under it
    //    and not under the retired one, key state agrees, recovery copy is a
    //    copy of the NEW key.
    expect(newKey.equals(oldKey)).toBe(false);
    await expect(verifyKeyState(newKey, { businessId: config.businessId })).resolves.toBeUndefined();
    expect((await storedCredentials(newKey).resolve('ONE', config.businessId))?.value).toBe(
      'first-secret',
    );
    expect(await storedCredentials(oldKey).resolve('ONE', config.businessId)).toBeNull();

    await rm(KEY_PATH);
    await runSecretKeyCli(['restore', OPERATOR], deps());
    expect((await loadMasterKey(KEY_PATH)).equals(newKey)).toBe(true);

    // And the record really is absent — otherwise this whole test could pass
    // against a rotation that quietly wrote its row after all.
    const { rows: audit } = await getPool().query(
      `SELECT 1 FROM audit_log WHERE kind = 'credential_change' AND reason LIKE '%הוחלף%'`,
    );
    expect(audit).toHaveLength(0);
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
