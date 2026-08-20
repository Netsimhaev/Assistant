import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import { recordUnknownUserFailure, unknownUserLocked } from './unknown-user-throttle.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
/**
 * Exported because the dashboard server needs the same number twice: once to
 * compute a session's `expires_at` (here) and once to set the cookie's
 * `Max-Age` (server.ts) — hardcoding it a second time invites the two to
 * drift.
 */
export const SESSION_HOURS = 12;
/** Raw session token size. 256 bits — comfortably more than a browser cookie needs to resist guessing. */
const TOKEN_BYTES = 32;

export async function hashPassword(plain: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(plain, salt, KEY_LENGTH);
  return { hash: derived.toString('hex'), salt };
}

/**
 * Compared in constant time. A plain `===` on hex strings leaks how many
 * leading characters matched through timing, which is enough to recover a
 * hash byte by byte given enough attempts.
 */
export async function verifyPassword(
  plain: string,
  hash: string,
  salt: string,
): Promise<boolean> {
  const derived = await scrypt(plain, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * A fixed salt/hash pair that never matches any real password or recovery
 * code. `login` runs a verification against this when the username does not
 * exist, so a "no such user" response costs the same scrypt work as a
 * "wrong password" response. Without this, the two cases are distinguishable
 * by response time alone, which lets an attacker enumerate usernames on a
 * system that is meant to have exactly one.
 *
 * Exported so `redeemRecoveryCode` can pay the same decoy cost when a
 * username has no recovery codes issued — reusing this pair rather than
 * minting a second one keeps there being exactly one "costs real work but
 * matches nothing" constant in the system.
 */
export const DECOY_SALT = '0'.repeat(32);
export const DECOY_HASH = '0'.repeat(KEY_LENGTH * 2);

/**
 * Session tokens are hashed with a fast digest, deliberately NOT scrypt.
 *
 * A session is checked on every request that touches the dashboard, so its
 * cost is paid constantly, not once at login. scrypt's slowness defends a
 * password against an attacker who gets to guess repeatedly against a
 * low-entropy secret; a 128-bit-plus random token has nothing for that
 * defence to buy — there is no dictionary to search — so paying scrypt's
 * cost here would only tax every legitimate request. sha256 still keeps the
 * raw token out of the database: `dashboard_sessions.session_id` stores this
 * hash, never the token itself, so a leaked backup is not a working session.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface UserRow {
  password_hash: string;
  password_salt: string;
  locked_until: Date | null;
}

interface UserRecord {
  passwordHash: string;
  passwordSalt: string;
  lockedUntil: Date | null;
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    lockedUntil: row.locked_until,
  };
}

interface SessionRow {
  username: string;
  expires_at: Date;
  revoked_at: Date | null;
  must_change_password: boolean;
}

export async function createOwner(input: {
  username: string;
  password: string;
  businessId?: string;
}): Promise<void> {
  const businessId = input.businessId ?? config.businessId;
  const { hash, salt } = await hashPassword(input.password);
  await getPool().query(
    `INSERT INTO dashboard_users (business_id, username, password_hash, password_salt)
     VALUES ($1, $2, $3, $4)`,
    [businessId, input.username, hash, salt],
  );
}

export async function login(input: {
  username: string;
  password: string;
  businessId?: string;
  now?: Date;
}): Promise<{ ok: true; sessionId: string } | { ok: false; code: 'bad_credentials' | 'locked' }> {
  const businessId = input.businessId ?? config.businessId;
  const now = input.now ?? new Date();
  const db = getPool();

  const { rows } = await db.query<UserRow>(
    `SELECT password_hash, password_salt, locked_until
       FROM dashboard_users
      WHERE business_id = $1 AND username = $2`,
    [businessId, input.username],
  );
  const row = rows[0];

  if (!row) {
    // A username with no row has no counter of its own, so its failures go
    // to the shared unknown-username bucket
    // (./unknown-user-throttle.js). Without it, the UPDATE further down
    // matched nothing and this branch was an unthrottled scrypt call for
    // anyone who could reach the port — one call rather than recovery's
    // eight, but still unbounded, and still the owner's only way in.
    //
    // A locked bucket returns before the decoy runs. That is the same trade
    // the per-user lock already makes ('locked' is answered without touching
    // a hash), and it is what a throttle is: still paying the cost would
    // defeat the point. Reported as `bad_credentials`, never a distinct
    // code — an unknown username must not become distinguishable by its
    // reply.
    const throttle = {
      kind: 'login' as const,
      maxFailed: MAX_FAILED,
      lockMinutes: LOCK_MINUTES,
      businessId,
      now,
    };
    if (await unknownUserLocked(throttle)) return { ok: false, code: 'bad_credentials' };

    // Pay the same scrypt cost a real user would, so "no such user" and
    // "wrong password" are not distinguishable by timing.
    await verifyPassword(input.password, DECOY_HASH, DECOY_SALT);
    await recordUnknownUserFailure(throttle);
    return { ok: false, code: 'bad_credentials' };
  }

  const user = toUserRecord(row);

  // Lazily clear an expired lock on the next attempt rather than running a
  // sweep — there is exactly one account in stage 0, and the next login is
  // the only moment that matters. Resetting failed_attempts alongside
  // locked_until means the cooldown grants a fresh five attempts, not "one
  // more try before an instant re-lock".
  //
  // The `locked_until <= $3` predicate is re-checked by Postgres in the
  // WHERE clause, not trusted from the JS-side read above: if a concurrent
  // failed attempt re-locked the account between our SELECT and this
  // UPDATE, the predicate no longer holds and the statement becomes a
  // no-op instead of clobbering the fresh lock a moment after it was set.
  if (user.lockedUntil !== null && user.lockedUntil.getTime() <= now.getTime()) {
    const cleared = await db.query(
      `UPDATE dashboard_users SET failed_attempts = 0, locked_until = NULL
        WHERE business_id = $1 AND username = $2 AND locked_until <= $3`,
      [businessId, input.username, now],
    );
    if ((cleared.rowCount ?? 0) > 0) {
      user.lockedUntil = null;
    }
    // If the UPDATE was a no-op, `user.lockedUntil` is left at the stale
    // (expired, by our own read) timestamp — still non-null, so the check
    // below still reports "locked", which happens to be correct: a no-op
    // here means someone else's fresh lock won the race.
  }

  // A locked account refuses even the correct password — checked before
  // spending scrypt on the password at all. This means a known-but-locked
  // account returns 'locked' cheaply, while an unknown username still pays
  // the decoy scrypt cost above. That is not a reintroduction of the
  // username-enumeration timing gap the decoy exists to close: the two
  // cases already return different codes ('locked' vs 'bad_credentials'),
  // so there is nothing hidden left for response time to leak. Do not
  // "fix" this by paying scrypt here too — it would just be a cost with no
  // corresponding secret to protect.
  if (user.lockedUntil !== null) {
    return { ok: false, code: 'locked' };
  }

  const valid = await verifyPassword(input.password, user.passwordHash, user.passwordSalt);

  if (!valid) {
    // The increment happens in SQL, not JavaScript. Reading failed_attempts,
    // adding one in application code, and writing the sum back is a classic
    // read-modify-write race: fire N wrong-password attempts concurrently
    // and every one of them reads the same stale count and writes back the
    // same count + 1, so the counter advances by one instead of by N — the
    // lockout threshold is never reached and the rate limit stops existing
    // under any concurrency at all. `failed_attempts = failed_attempts + 1`
    // computed by Postgres inside a single UPDATE is safe: Postgres holds a
    // row lock for the duration of the UPDATE, so concurrent attempts
    // against the same row serialise and each one sees the previous one's
    // committed increment rather than a stale snapshot.
    const lockUntilIfThresholdReached = new Date(now.getTime() + LOCK_MINUTES * 60_000);
    await db.query(
      `UPDATE dashboard_users
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE
                WHEN failed_attempts + 1 >= $3 THEN $4
                ELSE locked_until
              END
        WHERE business_id = $1 AND username = $2`,
      [businessId, input.username, MAX_FAILED, lockUntilIfThresholdReached],
    );
    return { ok: false, code: 'bad_credentials' };
  }

  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3600_000);

  await withTransaction(async (tx) => {
    // A successful login resets both counters: the failed-attempt streak
    // and any lock are exactly what a correct password should clear, and
    // leaving either behind would fail the very next legitimate request.
    await tx.query(
      `UPDATE dashboard_users
          SET failed_attempts = 0, locked_until = NULL, last_login_at = $3
        WHERE business_id = $1 AND username = $2`,
      [businessId, input.username, now],
    );
    await tx.query(
      `INSERT INTO dashboard_sessions (session_id, business_id, username, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tokenHash, businessId, input.username, now, expiresAt],
    );
  });

  return { ok: true, sessionId: token };
}

async function loadSession(
  sessionId: string,
  options: { businessId?: string; now?: Date },
): Promise<{ username: string; mustChangePassword: boolean } | null> {
  const businessId = options.businessId ?? config.businessId;
  const now = options.now ?? new Date();

  const { rows } = await getPool().query<SessionRow>(
    `SELECT username, expires_at, revoked_at, must_change_password
       FROM dashboard_sessions
      WHERE session_id = $1 AND business_id = $2`,
    [hashToken(sessionId), businessId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at.getTime() <= now.getTime()) return null;

  return { username: row.username, mustChangePassword: row.must_change_password };
}

export async function verifySession(
  sessionId: string,
  options: { businessId?: string; now?: Date } = {},
): Promise<{ username: string } | null> {
  const result = await loadSession(sessionId, options);
  return result ? { username: result.username } : null;
}

/**
 * Same lookup as `verifySession`, plus whether this particular session was
 * minted mid recovery-code login and has not yet been through a password
 * change. `verifySession` keeps its narrower `{ username }` shape because
 * every existing caller already asserts an exact match against it
 * (`toEqual({ username })`); adding a field there would break all of them.
 * The dashboard is the one caller that needs the extra bit, to redirect
 * everywhere except `/password` until it clears.
 */
export async function verifySessionDetails(
  sessionId: string,
  options: { businessId?: string; now?: Date } = {},
): Promise<{ username: string; mustChangePassword: boolean } | null> {
  return loadSession(sessionId, options);
}

/**
 * Mint a session without a password check.
 *
 * Two callers need this, and neither has a password to verify: the dashboard
 * after a recovery code was just redeemed (proof of ownership already came
 * from `redeemRecoveryCode`, which also revoked every prior session — this
 * only writes the new one `login`'s success path would have written), and
 * the dashboard again right after `setPassword` completes, so the owner who
 * just finished the forced password change lands back in the app instead of
 * at a login form.
 */
export async function startSession(
  username: string,
  options: { businessId?: string; now?: Date; mustChangePassword?: boolean } = {},
): Promise<string> {
  const businessId = options.businessId ?? config.businessId;
  const now = options.now ?? new Date();
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3600_000);

  await getPool().query(
    `INSERT INTO dashboard_sessions
       (session_id, business_id, username, created_at, expires_at, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hashToken(token), businessId, username, now, expiresAt, options.mustChangePassword ?? false],
  );

  return token;
}

export async function revokeAllSessions(
  username: string,
  options: { businessId?: string; tx?: Queryable } = {},
): Promise<number> {
  const businessId = options.businessId ?? config.businessId;
  // Accepts an optional transaction so a caller (recovery-code redemption,
  // for one) can revoke sessions atomically with whatever else it is doing —
  // e.g. claiming the code and writing the audit entry — rather than leaving
  // a window where the code is spent but a stolen session survives it.
  const db = options.tx ?? getPool();
  const result = await db.query(
    `UPDATE dashboard_sessions SET revoked_at = now()
      WHERE business_id = $1 AND username = $2 AND revoked_at IS NULL`,
    [businessId, username],
  );
  return result.rowCount ?? 0;
}

export async function setPassword(input: {
  username: string;
  password: string;
  businessId?: string;
}): Promise<void> {
  const businessId = input.businessId ?? config.businessId;
  const { hash, salt } = await hashPassword(input.password);

  // Hashing the new password and revoking every open session happen in one
  // transaction: a session opened under the old password must not survive a
  // password change, and a failure partway through must not leave the
  // account with a new password but an old, still-valid session.
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE dashboard_users SET password_hash = $3, password_salt = $4
        WHERE business_id = $1 AND username = $2`,
      [businessId, input.username, hash, salt],
    );
    await tx.query(
      `UPDATE dashboard_sessions SET revoked_at = now()
        WHERE business_id = $1 AND username = $2 AND revoked_at IS NULL`,
      [businessId, input.username],
    );
  });
}
