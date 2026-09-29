/**
 * Key rotation must cover `oauth_grants`, not just `credentials` — the gap
 * `oauth-grants.ts`'s own header names as Task 2's job. Without this, a
 * `rotate` leaves every stored grant sealed under a key the installation no
 * longer holds, and nothing throws until the next refresh tries to read one.
 *
 * `runRotate` below is the same `runSecretKeyCli(['rotate', ...], deps())`
 * shape `secret-key.test.ts` already uses — same injected deps, same way of
 * feeding the passphrase — just named for this file's focus on grants.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, getPool } from '../db/pool.js';
import { putSecret, storedCredentials } from '../governance/credential-store.js';
import { KEY_BYTES, loadMasterKey, writeKeyState } from '../governance/master-key.js';
import {
  grantAad,
  readGrantBySystem,
  revokeGrant,
  writeGrant,
} from '../governance/oauth-grants.js';
import type { WriteGrantInput } from '../governance/oauth-grants.js';
import { decryptSecret, encryptSecret } from '../governance/secret-cipher.js';
import { resetDatabase } from '../test/db.js';
import { runSecretKeyCli } from './secret-key.js';
import type { SecretKeyCliDeps } from './secret-key.js';

const OPERATOR = 'operator@example.com';
const PASSPHRASE = 'correct horse battery staple';
const BUSINESS = config.businessId;

let DIR: string;
let KEY_PATH: string;

const GRANT: Omit<WriteGrantInput, 'businessId'> = {
  system: 'google-calendar',
  provider: 'google',
  credentialRef: 'GOOGLE_CALENDAR_MAIN',
  account: 'ops@example.com',
  scopes: ['calendar.readonly'],
  refreshToken: 'refresh-token-value',
  grantedBy: OPERATOR,
};

function deps(overrides: Partial<SecretKeyCliDeps> = {}): SecretKeyCliDeps {
  return {
    log: () => {},
    readPassphrase: async () => PASSPHRASE,
    keyPath: KEY_PATH,
    ...overrides,
  };
}

/** The CLI's `rotate`, with this file's key path and passphrase deps. */
async function runRotate(overrides: Partial<SecretKeyCliDeps> = {}): Promise<void> {
  await runSecretKeyCli(['rotate', OPERATOR], deps(overrides));
}

beforeEach(async () => {
  await resetDatabase();
  DIR = await mkdtemp(join(tmpdir(), 'secret-key-grants-cli-'));
  KEY_PATH = join(DIR, 'master.key');
});

afterEach(async () => {
  await rm(DIR, { recursive: true, force: true });
});

afterAll(async () => {
  await closePool();
});

describe('rotate re-encrypts oauth_grants', () => {
  it('re-encrypts OAuth grants too, so rotation does not kill every connection', async () => {
    const OLD_KEY = randomBytes(KEY_BYTES);
    await writeFile(KEY_PATH, OLD_KEY, { mode: 0o600 });
    await writeKeyState(OLD_KEY, 'KEY-old', { businessId: BUSINESS });
    await writeGrant({ businessId: BUSINESS, ...GRANT }, OLD_KEY);

    await runRotate();

    const newKey = await loadMasterKey(KEY_PATH);
    // The positive half first: the new key is genuinely different, so the read
    // below proves re-encryption and not that nothing happened.
    expect(newKey.equals(OLD_KEY)).toBe(false);
    expect((await readGrantBySystem(GRANT.system, BUSINESS, newKey))?.refreshToken).toBe(
      GRANT.refreshToken,
    );
    expect(await readGrantBySystem(GRANT.system, BUSINESS, OLD_KEY)).toBeNull();
  });

  /**
   * Task 1's soft-revoke keeps a revoked row for the record — a business
   * needs to know access EXISTED. A rotation that skipped revoked rows would
   * quietly turn that evidence into ciphertext nobody can ever open again,
   * because `readGrantBySystem`/`readGrantByRef` both refuse a revoked row on
   * every future read: there would be no way even to discover the row is now
   * unopenable, let alone recover it. The brief's own note names this
   * explicitly, so it is asserted here rather than left to be rediscovered.
   */
  it('re-encrypts a revoked grant too, so the evidence it existed does not go dark', async () => {
    const OLD_KEY = randomBytes(KEY_BYTES);
    await writeFile(KEY_PATH, OLD_KEY, { mode: 0o600 });
    await writeKeyState(OLD_KEY, 'KEY-old', { businessId: BUSINESS });
    await writeGrant({ businessId: BUSINESS, ...GRANT }, OLD_KEY);

    const revoked = await revokeGrant(GRANT.system, BUSINESS, OPERATOR);
    expect(revoked).toBe(true);
    // Positive half first: confirm the row is really gone from the read
    // paths pre-rotation, so the row we inspect after rotation is read a
    // different way on purpose, not because the normal path happens to work.
    expect(await readGrantBySystem(GRANT.system, BUSINESS, OLD_KEY)).toBeNull();

    await runRotate();

    const newKey = await loadMasterKey(KEY_PATH);
    expect(newKey.equals(OLD_KEY)).toBe(false);

    // The public read paths still refuse a revoked row after rotation — that
    // is unchanged and correct. What must have changed is the key the row
    // opens under, checked the same way `rotate` itself checks each row.
    const { rows } = await getPool().query<{ ciphertext: Buffer; nonce: Buffer }>(
      'SELECT ciphertext, nonce FROM oauth_grants WHERE business_id = $1 AND system = $2',
      [BUSINESS, GRANT.system],
    );
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) throw new Error('unreachable');
    expect(
      decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce }, OLD_KEY, grantAad(BUSINESS, GRANT.system)),
    ).toBeNull();
    expect(
      decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce }, newKey, grantAad(BUSINESS, GRANT.system)),
    ).toBe(GRANT.refreshToken);
  });

  /**
   * All-or-nothing across both tables, not just within `credentials`: a
   * grant row that cannot be opened with the key on file aborts the whole
   * rotation, and a credential that WOULD have rotated cleanly stays exactly
   * where it started. Proven by seeding a credential that rotation would
   * otherwise move, and confirming after the throw that it never moved — the
   * "prove it actually ran" half, since the corrupted row lives only in
   * `oauth_grants`, so a rollback here can only be the new loop's doing.
   */
  it('aborts the whole rotation, leaving credentials and grants untouched, when a grant fails to decrypt', async () => {
    const OLD_KEY = randomBytes(KEY_BYTES);
    await writeFile(KEY_PATH, OLD_KEY, { mode: 0o600 });
    await writeKeyState(OLD_KEY, 'KEY-old', { businessId: BUSINESS });
    await putSecret(
      { businessId: BUSINESS, ref: 'ONE', value: 'first-secret', updatedBy: OPERATOR },
      OLD_KEY,
    );
    await writeGrant({ businessId: BUSINESS, ...GRANT }, OLD_KEY);

    // A second grant row sealed under a key this installation never held —
    // the shape of a row that survived some earlier, incomplete migration.
    const wrongKey = randomBytes(KEY_BYTES);
    const corrupted = encryptSecret(
      'unreadable-token',
      wrongKey,
      grantAad(BUSINESS, 'other-system'),
    );
    await getPool().query(
      `INSERT INTO oauth_grants
         (business_id, system, provider, credential_ref, account, scopes,
          ciphertext, nonce, key_id, granted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        BUSINESS,
        'other-system',
        'other',
        'OTHER_SYSTEM_REF',
        'acct',
        [],
        corrupted.ciphertext,
        corrupted.nonce,
        'KEY-old',
        OPERATOR,
      ],
    );

    // Positive half first: both real rows are readable under OLD_KEY before
    // rotation is attempted at all, so the assertions after the throw prove
    // rollback, not a setup that never worked in the first place.
    expect((await storedCredentials(OLD_KEY).resolve('ONE', BUSINESS))?.value).toBe(
      'first-secret',
    );
    expect((await readGrantBySystem(GRANT.system, BUSINESS, OLD_KEY))?.refreshToken).toBe(
      GRANT.refreshToken,
    );

    await expect(runRotate()).rejects.toThrow(/הרשאת ה-OAuth/);

    const stillOldKey = await loadMasterKey(KEY_PATH);
    expect(stillOldKey.equals(OLD_KEY)).toBe(true);
    expect((await storedCredentials(OLD_KEY).resolve('ONE', BUSINESS))?.value).toBe(
      'first-secret',
    );
    expect((await readGrantBySystem(GRANT.system, BUSINESS, OLD_KEY))?.refreshToken).toBe(
      GRANT.refreshToken,
    );
  });
});
