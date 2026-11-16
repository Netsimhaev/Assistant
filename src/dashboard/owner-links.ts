/**
 * One-time links a technician issues to an owner (migration 071): an invite,
 * which creates the business's dashboard owner, and a password reset.
 *
 * **The token.** 32 random bytes, hex. The URL carries `<businessId>.<raw>` —
 * the same shape as the session cookie, so the dashboard knows which
 * `withBusiness` to open before it looks anything up — and the table holds
 * only `sha256(raw)`. A forged business part looks the hash up in the wrong
 * business and finds nothing.
 *
 * **One use, and only by whoever knows the address.** The redeemer must type
 * the login the link was issued for (compared through `normaliseLogin`, so
 * letter case does not matter). A wrong address is `login_mismatch` and does
 * not consume the link, nor does a weak password: both are checked before the
 * claim. The claim itself is one conditional UPDATE
 * (`used_at IS NULL AND expires_at > now`), so two concurrent redemptions
 * cannot both win.
 *
 * **Everything is one transaction.** The claim and what the link does —
 * create the owner, or set the password and revoke every session and trusted
 * device (`setPassword`) — commit together. A redemption that fails after the
 * claim (an owner already exists for that address, here or in another
 * business) rolls the claim back and is `invalid`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { transaction, type BusinessDb } from '../db/pool.js';
import { normaliseLogin } from '../tenancy/login.js';
import { createOwner, MIN_PASSWORD_LENGTH, setPassword } from './auth.js';

/** How long a link stays valid. */
export const LINK_HOURS = 72;

/** Raw link token size: 256 bits. Only its sha256 is stored. */
const LINK_TOKEN_BYTES = 32;

/** The username an invite creates — the business's one owner account. */
const INVITED_USERNAME = 'owner';

export type OwnerLinkKind = 'invite' | 'password_reset';

export type RedeemResult =
  | { ok: true; kind: OwnerLinkKind; username: string }
  | { ok: false; code: 'invalid' | 'login_mismatch' | 'expired' | 'used' | 'weak_password' };

const RAW_TOKEN_SHAPE = /^[0-9a-f]{64}$/;

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface LinkRow {
  kind: OwnerLinkKind;
  login: string;
  expires_at: Date;
  used_at: Date | null;
}

/**
 * Issue a link and return the URL path token `<businessId>.<raw>`. A newer
 * link of the same kind for the same login retires the older unused ones, in
 * the same transaction: only the link the owner was sent last works.
 */
export async function issueOwnerLink(
  db: BusinessDb,
  input: { kind: OwnerLinkKind; login: string; issuedBy: string },
  now: Date = new Date(),
): Promise<string> {
  const login = normaliseLogin(input.login);
  if (login.length === 0) throw new Error('issueOwnerLink: empty login');
  const raw = randomBytes(LINK_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(now.getTime() + LINK_HOURS * 3600_000);
  await transaction(db, async (tx) => {
    await tx.query(
      `UPDATE owner_links SET used_at = $4
        WHERE business_id = $1 AND kind = $2 AND login = $3 AND used_at IS NULL`,
      [tx.businessId, input.kind, login, now],
    );
    await tx.query(
      `INSERT INTO owner_links (business_id, link_hash, kind, login, created_at, expires_at, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tx.businessId, sha256(raw), input.kind, login, now, expiresAt, input.issuedBy],
    );
  });
  return `${db.businessId}.${raw}`;
}

async function loadLink(db: BusinessDb, rawToken: string, lock: boolean): Promise<LinkRow | null> {
  if (!RAW_TOKEN_SHAPE.test(rawToken)) return null;
  const { rows } = await db.query<LinkRow>(
    `SELECT kind, login, expires_at, used_at FROM owner_links
      WHERE business_id = $1 AND link_hash = $2${lock ? ' FOR UPDATE' : ''}`,
    [db.businessId, sha256(rawToken)],
  );
  return rows[0] ?? null;
}

function unusable(row: LinkRow | null, now: Date): 'invalid' | 'used' | 'expired' | null {
  if (row === null) return 'invalid';
  if (row.used_at !== null) return 'used';
  if (row.expires_at.getTime() <= now.getTime()) return 'expired';
  return null;
}

/**
 * Is the link live, and of which kind? Read only — the form page asks this
 * before it shows anything, and the route refuses a token presented on the
 * other kind's path before redeeming it.
 */
export async function ownerLinkState(
  db: BusinessDb,
  rawToken: string,
  now: Date = new Date(),
): Promise<{ ok: true; kind: OwnerLinkKind } | { ok: false; code: 'invalid' | 'used' | 'expired' }> {
  const row = await loadLink(db, rawToken, false);
  const code = unusable(row, now);
  if (code !== null || row === null) return { ok: false, code: code ?? 'invalid' };
  return { ok: true, kind: row.kind };
}

/** Thrown inside the transaction to roll the claim back; never escapes. */
class RedeemRefused extends Error {}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export async function redeemOwnerLink(
  db: BusinessDb,
  input: { rawToken: string; typedLogin: string; password: string },
  now: Date = new Date(),
): Promise<RedeemResult> {
  try {
    return await transaction(db, async (tx) => {
      const row = await loadLink(tx, input.rawToken, true);
      const code = unusable(row, now);
      if (code !== null || row === null) return { ok: false, code: code ?? 'invalid' };
      // Neither consumes the link.
      if (normaliseLogin(input.typedLogin) !== row.login) return { ok: false, code: 'login_mismatch' };
      if (input.password.length < MIN_PASSWORD_LENGTH) return { ok: false, code: 'weak_password' };

      const claimed = await tx.query(
        `UPDATE owner_links SET used_at = $3
          WHERE business_id = $1 AND link_hash = $2 AND used_at IS NULL AND expires_at > $3
          RETURNING kind`,
        [tx.businessId, sha256(input.rawToken), now],
      );
      if ((claimed.rowCount ?? 0) === 0) return { ok: false, code: 'used' };

      if (row.kind === 'invite') {
        const existing = await tx.query(
          `SELECT 1 FROM dashboard_users
            WHERE business_id = $1 AND (lower(login) = $2 OR username = $3)`,
          [tx.businessId, row.login, INVITED_USERNAME],
        );
        if (existing.rows.length > 0) throw new RedeemRefused();
        try {
          await createOwner(tx, { username: INVITED_USERNAME, login: row.login, password: input.password });
        } catch (err) {
          // The address is unique across the whole server (migration 066):
          // another business already signs in with it.
          if (isUniqueViolation(err)) throw new RedeemRefused();
          throw err;
        }
        return { ok: true, kind: 'invite', username: INVITED_USERNAME };
      }

      const user = await tx.query<{ username: string }>(
        `SELECT username FROM dashboard_users WHERE business_id = $1 AND lower(login) = $2`,
        [tx.businessId, row.login],
      );
      const username = user.rows[0]?.username;
      if (username === undefined) throw new RedeemRefused();
      // Revokes every session and trusted device, in this transaction.
      await setPassword(tx, { username, password: input.password });
      // Proving ownership of the address clears the password lock, as the
      // new password is the thing the lock was guarding.
      await tx.query(
        `UPDATE dashboard_users SET failed_attempts = 0, locked_until = NULL
          WHERE business_id = $1 AND username = $2`,
        [tx.businessId, username],
      );
      return { ok: true, kind: 'password_reset', username };
    });
  } catch (err) {
    if (err instanceof RedeemRefused) return { ok: false, code: 'invalid' };
    throw err;
  }
}
