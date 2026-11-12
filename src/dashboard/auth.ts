import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isValidBusinessId, transaction, type BusinessDb, type Queryable } from '../db/pool.js';
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

/**
 * What a row that must be bound to one session stores in place of the session
 * itself: the sha256 of the cookie value, never the value. `oauth_states.
 * session_id` holds this — a leaked backup of that table is then not a list
 * of working session cookies, exactly as `dashboard_sessions.session_id`
 * already holds a hash and never the token.
 */
export function sessionBinding(sessionValue: string): string {
  return hashToken(sessionValue);
}

/**
 * The login as it is stored and matched: trimmed and lower-cased, the same
 * normalisation `resolveLogin` (src/tenancy/platform.ts) and the unique index
 * on `lower(login)` (migration 066) use. One function, so the three cannot
 * disagree about whether `" Dana@X.example "` is `dana@x.example`.
 */
export function normaliseLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * The session cookie's value: `<businessId>.<token>` (spec §5.5).
 *
 * The business part tells the server which `withBusiness` to open; the token
 * is then looked up inside it. A business id cannot contain `.`
 * (`^[a-z0-9-]{3,63}$`), so the first `.` is always the separator.
 */
export function sessionCookieValue(businessId: string, token: string): string {
  return `${businessId}.${token}`;
}

/**
 * The cookie value split back into its business and token, or `null`.
 *
 * `null` for a value with no `.` — an old cookie from before migration 066,
 * which carried the token alone — and for a business part that is not a
 * valid id. Both are "logged out", never an error page: the caller sends the
 * owner to the login form (Review Focus 6). A well-formed business part does
 * not make the cookie trusted; the token must still be found under that
 * business, and a forged business part is simply a miss.
 */
export function parseSessionCookie(value: string): { businessId: string; token: string } | null {
  const dot = value.indexOf('.');
  if (dot === -1) return null;
  const businessId = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (token.length === 0 || !isValidBusinessId(businessId)) return null;
  return { businessId, token };
}

interface UserRow {
  username: string;
  password_hash: string;
  password_salt: string;
  locked_until: Date | null;
}

interface UserRecord {
  username: string;
  passwordHash: string;
  passwordSalt: string;
  lockedUntil: Date | null;
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    username: row.username,
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

/**
 * `login` is the email the owner signs in with, unique across the whole
 * server (migration 066); it is stored normalised. `username` is the
 * account's name inside its business — sessions, recovery codes and the
 * audit trail name it.
 */
export async function createOwner(
  db: BusinessDb,
  input: { username: string; login: string; password: string },
): Promise<void> {
  const { hash, salt } = await hashPassword(input.password);
  await db.query(
    `INSERT INTO dashboard_users (business_id, username, login, password_hash, password_salt)
     VALUES ($1, $2, $3, $4, $5)`,
    [db.businessId, input.username, normaliseLogin(input.login), hash, salt],
  );
}

/**
 * A password login whose address names no account: the dashboard calls this
 * when `resolveLogin` found nothing, on a connection with no business
 * (`withNoBusiness`), and `login` calls it when the row vanished.
 *
 * A login with no row has no counter of its own, so its failures go to the
 * shared unknown-login bucket (./unknown-user-throttle.js), one for the whole
 * server. Without it, the UPDATE in `login` matched nothing and this branch
 * was an unthrottled scrypt call for anyone who could reach the port — one
 * call rather than recovery's eight, but still unbounded, and still the
 * owner's only way in.
 *
 * A locked bucket returns before the decoy runs. That is the same trade the
 * per-user lock already makes ('locked' is answered without touching a hash),
 * and it is what a throttle is: still paying the cost would defeat the point.
 * Reported as `bad_credentials`, never a distinct code — an unknown login
 * must not become distinguishable by its reply.
 */
export async function loginUnknown(
  db: Queryable,
  password: string,
  now: Date = new Date(),
): Promise<{ ok: false; code: 'bad_credentials' }> {
  const throttle = {
    kind: 'login' as const,
    maxFailed: MAX_FAILED,
    lockMinutes: LOCK_MINUTES,
    now,
    db,
  };
  if (await unknownUserLocked(throttle)) return { ok: false, code: 'bad_credentials' };

  // Pay the same scrypt cost a real user would, so "no such user" and
  // "wrong password" are not distinguishable by timing.
  await verifyPassword(password, DECOY_HASH, DECOY_SALT);
  await recordUnknownUserFailure(throttle);
  return { ok: false, code: 'bad_credentials' };
}

/**
 * The password login, inside the business `resolveLogin` already found for
 * `input.login`. The failure counters and the lock are this business's own
 * row's (spec §5.5); the session is minted for the row's `username`.
 */
export async function login(
  db: BusinessDb,
  input: { login: string; password: string; now?: Date },
): Promise<
  { ok: true; sessionId: string; username: string } | { ok: false; code: 'bad_credentials' | 'locked' }
> {
  const businessId = db.businessId;
  const now = input.now ?? new Date();

  const { rows } = await db.query<UserRow>(
    `SELECT username, password_hash, password_salt, locked_until
       FROM dashboard_users
      WHERE business_id = $1 AND lower(login) = $2`,
    [businessId, normaliseLogin(input.login)],
  );
  const row = rows[0];

  // Normally unreachable — `resolveLogin` found this login in this business
  // a moment ago — but a row deleted in between is still an unknown login.
  if (!row) return loginUnknown(db, input.password, now);

  const user = toUserRecord(row);
  const username = user.username;

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
      [businessId, username, now],
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
      [businessId, username, MAX_FAILED, lockUntilIfThresholdReached],
    );
    return { ok: false, code: 'bad_credentials' };
  }

  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3600_000);

  await transaction(db, async (tx) => {
    // A successful login resets both counters: the failed-attempt streak
    // and any lock are exactly what a correct password should clear, and
    // leaving either behind would fail the very next legitimate request.
    await tx.query(
      `UPDATE dashboard_users
          SET failed_attempts = 0, locked_until = NULL, last_login_at = $3
        WHERE business_id = $1 AND username = $2`,
      [businessId, username, now],
    );
    await tx.query(
      `INSERT INTO dashboard_sessions (session_id, business_id, username, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tokenHash, businessId, username, now, expiresAt],
    );
  });

  return { ok: true, sessionId: token, username };
}

/**
 * Read inside the cookie's business (spec §5.5): `business_id = $2` is the
 * first layer, and RLS on `dashboard_sessions` the second. A cookie whose
 * business part was forged is looked up in the wrong business and is simply
 * not found.
 */
async function loadSession(
  db: BusinessDb,
  sessionId: string,
  options: { now?: Date },
): Promise<{ username: string; mustChangePassword: boolean } | null> {
  const businessId = db.businessId;
  const now = options.now ?? new Date();

  const { rows } = await db.query<SessionRow>(
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
  db: BusinessDb,
  sessionId: string,
  options: { now?: Date } = {},
): Promise<{ username: string } | null> {
  const result = await loadSession(db, sessionId, options);
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
  db: BusinessDb,
  sessionId: string,
  options: { now?: Date } = {},
): Promise<{ username: string; mustChangePassword: boolean } | null> {
  return loadSession(db, sessionId, options);
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
  db: BusinessDb,
  username: string,
  options: { now?: Date; mustChangePassword?: boolean } = {},
): Promise<string> {
  const businessId = db.businessId;
  const now = options.now ?? new Date();
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3600_000);

  await db.query(
    `INSERT INTO dashboard_sessions
       (session_id, business_id, username, created_at, expires_at, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hashToken(token), businessId, username, now, expiresAt, options.mustChangePassword ?? false],
  );

  return token;
}

/**
 * Revoke the one session this token names — used when a correct password
 * lands on a suspended business: `login` has already minted a session, and it
 * must not outlive the refusal. Every other session of the account is left as
 * it is (a suspension revokes nothing).
 */
export async function revokeSession(db: BusinessDb, token: string): Promise<void> {
  await db.query(
    `UPDATE dashboard_sessions SET revoked_at = now()
      WHERE session_id = $1 AND business_id = $2 AND revoked_at IS NULL`,
    [hashToken(token), db.businessId],
  );
}

export async function revokeAllSessions(db: BusinessDb, username: string): Promise<number> {
  // Takes the caller's connection, which may be a transaction, so a caller
  // (recovery-code redemption, for one) can revoke sessions atomically with
  // whatever else it is doing — e.g. claiming the code and writing the audit
  // entry — rather than leaving a window where the code is spent but a stolen
  // session survives it.
  const result = await db.query(
    `UPDATE dashboard_sessions SET revoked_at = now()
      WHERE business_id = $1 AND username = $2 AND revoked_at IS NULL`,
    [db.businessId, username],
  );
  return result.rowCount ?? 0;
}

/**
 * Does this plaintext match the account's current password?
 *
 * Used by the dashboard's password-change route, which must not let a stolen
 * session become a permanent takeover: without proof of the current
 * password, whoever holds a session cookie can rotate the password and lock
 * the owner out for good. Knowing the current one is the thing a session
 * thief does not have.
 *
 * Pays the decoy scrypt cost for a username with no row, exactly as `login`
 * does — the caller here always has a session, so there is no username to
 * enumerate, but a branch that returns instantly for a missing row is the
 * kind of asymmetry that becomes a leak the moment a caller changes.
 * Deliberately does NOT touch `failed_attempts`: this path is already behind
 * a valid session, and letting it spend login's budget would let a stolen
 * session lock the real owner out — the opposite of the point.
 */
export async function verifyCurrentPassword(
  db: BusinessDb,
  input: { username: string; password: string },
): Promise<boolean> {
  const { rows } = await db.query<UserRow>(
    `SELECT username, password_hash, password_salt, locked_until
       FROM dashboard_users
      WHERE business_id = $1 AND username = $2`,
    [db.businessId, input.username],
  );
  const row = rows[0];
  if (!row) {
    await verifyPassword(input.password, DECOY_HASH, DECOY_SALT);
    return false;
  }
  return verifyPassword(input.password, row.password_hash, row.password_salt);
}

export async function setPassword(
  db: BusinessDb,
  input: { username: string; password: string },
): Promise<void> {
  const businessId = db.businessId;
  const { hash, salt } = await hashPassword(input.password);

  // Hashing the new password and revoking every open session happen in one
  // transaction: a session opened under the old password must not survive a
  // password change, and a failure partway through must not leave the
  // account with a new password but an old, still-valid session.
  await transaction(db, async (tx) => {
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
