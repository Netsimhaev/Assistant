/**
 * The encrypted store for OAuth grants: where a connector's `credential_ref`
 * becomes a real refresh token for a real provider account.
 *
 * One row per `(business_id, system)` — one Google Calendar grant per
 * business, not per binding. The refresh token is sealed under the same
 * master key as `credentials` (`credential-store.ts`), read through the
 * same `credential_key_state` bookkeeping (`liveKeyId`, exported from that
 * module for exactly this reuse). That buys a shared key-id LABEL today —
 * not a shared rotation loop. `rotate` (`src/cli/secret-key.ts`) selects and
 * re-encrypts `credentials` only; `oauth_grants` does not appear in that
 * file at all. A key rotation as shipped at this commit would leave every
 * existing grant sealed under a key the installation no longer holds —
 * permanently unopenable. Wiring `oauth_grants` into `rotate` is Task 2's
 * job, not this one's. What keeps a grant row and a secret row from ever
 * being opened as each other is the AAD: a secret is sealed under
 * `{ businessId, ref }` where `ref` matches `CREDENTIAL_REF_PATTERN`
 * (`^[A-Z0-9_]+$`); a grant is sealed under `grantAad`, whose `ref` is
 * `grant:<system>` — lowercase and colon-bearing, a shape that pattern can
 * never match. That is a structural guarantee, not a naming convention: no
 * blocklist has to be kept in sync for it to hold.
 *
 * `businessId` is required everywhere here, with no fallback to
 * `config.businessId` — the same rule `CredentialSource.resolve`
 * (`src/orchestrator/credentials.ts`) states at length. An omitted business
 * would read silently as "the installation's own", which is exactly the
 * mechanism by which one business's connector would reach another's grant.
 */
import { acquireAdvisoryLock, getPool, withTransaction } from '../db/pool.js';
import type { Queryable } from '../db/pool.js';
import { ROTATION_LOCK_SCOPE, liveKeyId } from './credential-store.js';
import { verifyKeyState } from './master-key.js';
import { decryptSecret, encryptSecret } from './secret-cipher.js';
import type { SecretAad } from './secret-cipher.js';

/**
 * A refusal by this store: `recordRefresh` or `markNeedsReauth` matched no
 * live row — a wrong `system`/`businessId`, or a grant that was revoked.
 * Thrown rather than returned as a silent no-op, because both callers are
 * connector housekeeping with no human reading the return value; a `void`
 * that quietly did nothing would leave, for `markNeedsReauth`, the connector
 * believing it flagged the grant for re-consent while the owner is never
 * asked and the connection keeps failing in silence. `readDocument` draws
 * the same line against `markContentIngested`'s UPDATE, on the same ground:
 * an unresolved id is not a property of the row, and the caller must learn
 * that now. Never carries the refresh token's value.
 */
export class OAuthGrantError extends Error {}

/**
 * The AAD prefix every grant row is sealed under. Lowercase and
 * colon-bearing on purpose: `credentials.ref` is constrained to
 * `^[A-Z0-9_]+$`, so this string can never equal a real secret ref, and
 * neither row can be opened as the other. The same trick `key-check` and
 * `key-recovery` already rely on. Do NOT "clean" it to uppercase.
 */
export const GRANT_AAD_PREFIX = 'grant:';

export function grantAad(businessId: string, system: string): SecretAad {
  return { businessId, ref: `${GRANT_AAD_PREFIX}${system}` };
}

export interface OAuthGrantSummary {
  system: string;
  provider: string;
  credentialRef: string;
  account: string;
  scopes: string[];
  grantedAt: string;
  grantedBy: string;
  lastRefreshedAt: string | null;
  refreshCount: number;
  revokedAt: string | null;
  needsReauthAt: string | null;
}

export interface OAuthGrant extends OAuthGrantSummary {
  refreshToken: string;
}

export interface WriteGrantInput {
  businessId: string;
  system: string;
  provider: string;
  credentialRef: string;
  account: string;
  scopes: readonly string[];
  refreshToken: string;
  grantedBy: string;
}

interface GrantOptions {
  db?: Queryable;
}

interface SummaryRow {
  system: string;
  provider: string;
  credential_ref: string;
  account: string;
  scopes: string[];
  granted_at: Date;
  granted_by: string;
  last_refreshed_at: Date | null;
  refresh_count: number;
  revoked_at: Date | null;
  needs_reauth_at: Date | null;
}

interface SealedGrantRow extends SummaryRow {
  ciphertext: Buffer;
  nonce: Buffer;
}

function toSummary(row: SummaryRow): OAuthGrantSummary {
  return {
    system: row.system,
    provider: row.provider,
    credentialRef: row.credential_ref,
    account: row.account,
    scopes: row.scopes,
    grantedAt: row.granted_at.toISOString(),
    grantedBy: row.granted_by,
    lastRefreshedAt: row.last_refreshed_at === null ? null : row.last_refreshed_at.toISOString(),
    refreshCount: row.refresh_count,
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    needsReauthAt: row.needs_reauth_at === null ? null : row.needs_reauth_at.toISOString(),
  };
}

/**
 * Store one grant, replacing whatever this business held for that system.
 *
 * **Structural template: `putSecret` (`credential-store.ts`).** Same
 * advisory lock (`ROTATION_LOCK_SCOPE` — the SAME scope `putSecret` and
 * key rotation take, not a narrower one: it serialises two concurrent
 * refreshes, which would otherwise store a token the provider already
 * invalidated, against each other AND against key rotation, which reads the
 * live key id and writes rows in separate statements); same
 * `verifyKeyState` call before anything is sealed, so a wrong key file
 * produces a refusal rather than a row labelled with the live key id and
 * sealed with a different one; same `liveKeyId` read, from the exported
 * function in `credential-store.ts` rather than a second query against
 * `credential_key_state`, so there is exactly one place that decides which
 * key id a freshly sealed row is labelled with; same optional-`db`-or-own
 * -transaction shape, for tests that need to observe the statements this
 * function issues.
 *
 * The refresh token reaches the ciphertext column and nothing else: not a
 * log line, not an error message, not the returned value (there is none).
 */
export async function writeGrant(
  input: WriteGrantInput,
  key: Buffer,
  options: GrantOptions = {},
): Promise<void> {
  const write = async (db: Queryable): Promise<void> => {
    await acquireAdvisoryLock(db, ROTATION_LOCK_SCOPE);
    // Install-wide, exactly like `putSecret` — not `{ businessId: input.businessId, db }`.
    // The key is per-installation (see `liveKeyId`'s own docblock); checking
    // it against one row while `liveKeyId` reads another is the very
    // opens-for-nobody hazard both docblocks describe, just with the mismatch
    // moved one level up.
    await verifyKeyState(key, { db });
    const keyId = await liveKeyId(db);
    const sealed = encryptSecret(input.refreshToken, key, grantAad(input.businessId, input.system));

    await db.query(
      `INSERT INTO oauth_grants
         (business_id, system, provider, credential_ref, account, scopes,
          ciphertext, nonce, key_id, granted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (business_id, system) DO UPDATE
         SET provider = EXCLUDED.provider,
             credential_ref = EXCLUDED.credential_ref,
             account = EXCLUDED.account,
             scopes = EXCLUDED.scopes,
             ciphertext = EXCLUDED.ciphertext,
             nonce = EXCLUDED.nonce,
             key_id = EXCLUDED.key_id,
             granted_at = now(),
             granted_by = EXCLUDED.granted_by,
             last_refreshed_at = NULL,
             refresh_count = 0,
             revoked_at = NULL,
             needs_reauth_at = NULL`,
      [
        input.businessId,
        input.system,
        input.provider,
        input.credentialRef,
        input.account,
        [...input.scopes],
        sealed.ciphertext,
        sealed.nonce,
        keyId,
        input.grantedBy,
      ],
    );
  };
  if (options.db) {
    await write(options.db);
    return;
  }
  await withTransaction((tx) => write(tx));
}

const SELECT_GRANT = `
  SELECT system, provider, credential_ref, account, scopes,
         granted_at, granted_by, last_refreshed_at, refresh_count,
         revoked_at, needs_reauth_at, ciphertext, nonce
    FROM oauth_grants
`;

/**
 * Shared by `readGrantByRef` and `readGrantBySystem`: a revoked row is not
 * read (spec's soft-revoke: the row stays for the record, but a read
 * refuses it), and a decryption failure returns `null` rather than
 * throwing — a wrong key is a configuration fact here, exactly as
 * `storedCredentials` treats it, not a crash.
 */
function openGrant(row: SealedGrantRow, businessId: string, key: Buffer): OAuthGrant | null {
  const value = decryptSecret(
    { ciphertext: row.ciphertext, nonce: row.nonce },
    key,
    grantAad(businessId, row.system),
  );
  if (value === null) return null;
  return { ...toSummary(row), refreshToken: value };
}

export async function readGrantByRef(
  credentialRef: string,
  businessId: string,
  key: Buffer,
  options: GrantOptions = {},
): Promise<OAuthGrant | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<SealedGrantRow>(
    `${SELECT_GRANT} WHERE business_id = $1 AND credential_ref = $2 AND revoked_at IS NULL`,
    [businessId, credentialRef],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return openGrant(row, businessId, key);
}

export async function readGrantBySystem(
  system: string,
  businessId: string,
  key: Buffer,
  options: GrantOptions = {},
): Promise<OAuthGrant | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<SealedGrantRow>(
    `${SELECT_GRANT} WHERE business_id = $1 AND system = $2 AND revoked_at IS NULL`,
    [businessId, system],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return openGrant(row, businessId, key);
}

/**
 * What this business has granted, revoked or not — never a token. The type
 * alone makes that a guarantee: `listGrants` takes no key, so there is
 * nothing here it could decrypt with even by mistake.
 */
export async function listGrants(
  businessId: string,
  options: GrantOptions = {},
): Promise<OAuthGrantSummary[]> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<SummaryRow>(
    `SELECT system, provider, credential_ref, account, scopes,
            granted_at, granted_by, last_refreshed_at, refresh_count,
            revoked_at, needs_reauth_at
       FROM oauth_grants
      WHERE business_id = $1
      ORDER BY system`,
    [businessId],
  );
  return rows.map(toSummary);
}

/**
 * A provider-side refresh succeeded. Advances `refresh_count` and
 * `last_refreshed_at` unconditionally; the ciphertext is replaced only when
 * the provider actually rotated the refresh token (`rotatedRefreshToken`
 * non-null) — most providers reuse the same refresh token across access-
 * token refreshes, and re-sealing an unchanged value would just spend a
 * nonce for nothing.
 *
 * Both branches filter on `revoked_at IS NULL` and throw `OAuthGrantError`
 * when the `UPDATE` touches no row — a wrong `system`/`businessId`, or a
 * grant the owner already revoked. Without the filter, a refresh landing
 * after a revocation would re-seal a live provider token into a row both
 * read paths already refuse, and keep advancing `refreshCount` on a grant
 * nothing can ever read again. Without the `rowCount` check, that same
 * "no such row" would be silently indistinguishable from success.
 *
 * Key check is install-wide (`verifyKeyState(key, { db })`, no `businessId`)
 * — exactly `putSecret`'s call, and for the same reason `writeGrant`'s does:
 * it must ask the same question `liveKeyId` answers, not a different row of
 * `credential_key_state`.
 */
export async function recordRefresh(
  system: string,
  businessId: string,
  rotatedRefreshToken: string | null,
  key: Buffer,
  options: GrantOptions = {},
): Promise<void> {
  const write = async (db: Queryable): Promise<void> => {
    if (rotatedRefreshToken === null) {
      const result = await db.query(
        `UPDATE oauth_grants
            SET last_refreshed_at = now(), refresh_count = refresh_count + 1
          WHERE business_id = $1 AND system = $2 AND revoked_at IS NULL`,
        [businessId, system],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new OAuthGrantError(
          `לא נמצאה הרשאה פעילה למערכת (${system}) — לא ניתן לרשום ריענון`,
        );
      }
      return;
    }
    await acquireAdvisoryLock(db, ROTATION_LOCK_SCOPE);
    await verifyKeyState(key, { db });
    const keyId = await liveKeyId(db);
    const sealed = encryptSecret(rotatedRefreshToken, key, grantAad(businessId, system));
    const result = await db.query(
      `UPDATE oauth_grants
          SET ciphertext = $3, nonce = $4, key_id = $5,
              last_refreshed_at = now(), refresh_count = refresh_count + 1
        WHERE business_id = $1 AND system = $2 AND revoked_at IS NULL`,
      [businessId, system, sealed.ciphertext, sealed.nonce, keyId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new OAuthGrantError(
        `לא נמצאה הרשאה פעילה למערכת (${system}) — לא ניתן לרשום ריענון`,
      );
    }
  };
  if (options.db) {
    await write(options.db);
    return;
  }
  await withTransaction((tx) => write(tx));
}

/**
 * Soft revoke: the row stays (a business needs to know access EXISTED), but
 * `revoked_at` stops both read paths from returning it. Returns whether a
 * live row actually changed, so a caller can tell "revoked now" from
 * "there was nothing live to revoke".
 *
 * `by` identifies who revoked it. There is no `revoked_by` column in this
 * table — the schema this task ships carries only what the brief's
 * interface commits to on disk, and a revocation actor belongs on the
 * audit-log row a future caller writes around this call, not duplicated
 * here. Accepted now so that caller's shape does not have to change when
 * that lands.
 */
export async function revokeGrant(
  system: string,
  businessId: string,
  _by: string,
  options: GrantOptions = {},
): Promise<boolean> {
  const db = options.db ?? getPool();
  const result = await db.query(
    `UPDATE oauth_grants SET revoked_at = now()
       WHERE business_id = $1 AND system = $2 AND revoked_at IS NULL`,
    [businessId, system],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * The provider refused the refresh token: the owner must consent again.
 * Distinct from `revokeGrant`, which is the owner's own act — this is set
 * by the connector, not by a person, and does not touch `revoked_at`.
 *
 * Filters on `revoked_at IS NULL` and throws `OAuthGrantError` when the
 * `UPDATE` touches no row. This is the sharpest edge in the file: without
 * the check, a wrong `system`/`businessId` writes zero rows and returns
 * exactly like success — the connector believes it flagged the grant for
 * re-consent, the owner is never asked, and the connection keeps failing in
 * silence with nothing pointing at why.
 */
export async function markNeedsReauth(
  system: string,
  businessId: string,
  options: GrantOptions = {},
): Promise<void> {
  const db = options.db ?? getPool();
  const result = await db.query(
    `UPDATE oauth_grants SET needs_reauth_at = now()
       WHERE business_id = $1 AND system = $2 AND revoked_at IS NULL`,
    [businessId, system],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new OAuthGrantError(
      `לא נמצאה הרשאה פעילה למערכת (${system}) — לא ניתן לסמן לחידוש הרשאה`,
    );
  }
}
