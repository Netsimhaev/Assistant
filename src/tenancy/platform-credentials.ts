/**
 * The server's own secrets — the Google and Microsoft OAuth client id and
 * secret, which belong to the APPLICATION and to no business (spec §5.4).
 *
 * **Sealed under `platform:<ref>`, and that is the control.** A business
 * secret is sealed under `{ businessId, ref }` with a ref matching
 * `CREDENTIAL_REF_PATTERN` (`^[A-Z0-9_]+$`); a grant under `grant:<system>`;
 * the key check under `key-check`. The ref here carries a lowercase,
 * colon-bearing prefix none of them can take, and the business half is empty
 * — a string no business id (`^[a-z0-9-]{3,63}$`) can be. So the same `ref`
 * string stored in both tables seals under two disjoint authenticated data,
 * and a row moved from one table to the other fails to open instead of
 * opening as the wrong thing. The same trick `key-check` and `grant:` already
 * rely on. Do NOT "clean" the prefix to uppercase.
 *
 * Access goes through `withPlatform`: the table has no `business_id`, so a
 * business-scoped connection is the wrong door to it.
 *
 * No value ever reaches a log line, an error message or a return value other
 * than `resolvePlatformSecret`'s own.
 */
import { withPlatform } from '../db/platform-pool.js';
import { acquireAdvisoryLock } from '../db/pool.js';
import { liveKeyId, ROTATION_LOCK_SCOPE } from '../governance/credential-store.js';
import { verifyKeyState } from '../governance/master-key.js';
import { decryptSecret, encryptSecret } from '../governance/secret-cipher.js';
import type { SecretAad } from '../governance/secret-cipher.js';
import { CREDENTIAL_REF_PATTERN } from '../orchestrator/credentials.js';

/** The AAD prefix of every platform secret. See the module docblock. */
export const PLATFORM_AAD_PREFIX = 'platform:';

/** The authenticated data a platform secret is sealed under. */
export function platformAad(ref: string): SecretAad {
  return { businessId: '', ref: `${PLATFORM_AAD_PREFIX}${ref}` };
}

/** A refusal by this store — a malformed ref. Never names a value. */
export class PlatformCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformCredentialError';
  }
}

function assertLegalRef(ref: string): void {
  if (!CREDENTIAL_REF_PATTERN.test(ref)) {
    throw new PlatformCredentialError(
      `הפניית סוד אינה בצורה חוקית (${ref}) — מותרים אותיות גדולות, ספרות וקו תחתון בלבד`,
    );
  }
}

/**
 * The read side, as the OAuth token exchanges consume it: a ref in, the value
 * or `null` out. Resolved fresh on every call, so a rotated client secret
 * takes effect on the next refresh without a restart.
 */
export interface PlatformSecretSource {
  resolve(ref: string): Promise<string | null>;
}

/** A `PlatformSecretSource` over the encrypted table, under `key`. */
export function platformSecrets(key: Buffer): PlatformSecretSource {
  return { resolve: (ref) => resolvePlatformSecret(ref, key) };
}

interface SealedRow {
  ciphertext: Buffer;
  nonce: Buffer;
}

/**
 * Store one platform secret, replacing whatever was under that ref.
 *
 * The key is verified against the installation's key state first, and the
 * key id is read from the table rather than accepted from the caller, under
 * `ROTATION_LOCK_SCOPE` — the same three rules `putSecret` keeps, for the same reason: a row labelled with
 * one key and sealed with another opens for nobody.
 */
export async function putPlatformSecret(ref: string, value: string, key: Buffer): Promise<void> {
  assertLegalRef(ref);
  await withPlatform(async (db) => {
    await db.query('BEGIN');
    try {
      // The lock `putSecret` and key rotation share: reading the live key id
      // and writing the sealed row are two statements, and a rotation between
      // them would seal this row under a key it is not labelled with.
      await acquireAdvisoryLock(db, ROTATION_LOCK_SCOPE);
      await verifyKeyState(key, { db });
      const keyId = await liveKeyId(db);
      const sealed = encryptSecret(value, key, platformAad(ref));
      await db.query(
        `INSERT INTO platform_credentials (ref, key_id, nonce, ciphertext)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (ref) DO UPDATE
           SET key_id = EXCLUDED.key_id,
               nonce = EXCLUDED.nonce,
               ciphertext = EXCLUDED.ciphertext,
               updated_at = now()`,
        [ref, keyId, sealed.nonce, sealed.ciphertext],
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * The value under `ref`, or `null` — absent, a wrong key, altered bytes, or a
 * ref outside the legal shape — undistinguished, as `resolveStoredSecret`
 * does: the caller's response to each is the same "not configured".
 */
export async function resolvePlatformSecret(ref: string, key: Buffer): Promise<string | null> {
  if (!CREDENTIAL_REF_PATTERN.test(ref)) return null;
  const row = await withPlatform(async (db) => {
    const { rows } = await db.query<SealedRow>(
      'SELECT ciphertext, nonce FROM platform_credentials WHERE ref = $1',
      [ref],
    );
    return rows[0];
  });
  if (row === undefined) return null;
  return decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce }, key, platformAad(ref));
}

/** Remove one platform secret; whether a row was actually removed. */
export async function removePlatformSecret(ref: string): Promise<boolean> {
  assertLegalRef(ref);
  return withPlatform(async (db) => {
    const result = await db.query('DELETE FROM platform_credentials WHERE ref = $1', [ref]);
    return (result.rowCount ?? 0) > 0;
  });
}
