/**
 * The company's technicians — the platform staff who sign in to the operator
 * panel (migration 072). This is the panel's equivalent of the owner's
 * `dashboard/auth.ts`, `second-factor.ts` and `owner-links.ts`, on the
 * server's own tables and the platform pool: staff belong to no business.
 *
 * **Every function takes no db.** Each opens `withPlatform` itself, so the
 * panel (`src/admin/`, which may not import the platform pool) reaches staff
 * data only through the named functions here — the closed list of
 * cross-business operations (CLAUDE.md, "ריבוי עסקים").
 *
 * **The same lessons as the owner store, kept on purpose:**
 * - only the sha256 of a session, device or link token is stored;
 * - a session must say which second factor it owes (`pendingFactor`,
 *   required, no default — the only default that ever slipped in was "owes
 *   nothing", a password-only session); when the factor settles the token is
 *   rotated (`rotateStaffSession`), never upgraded in place;
 * - a code is accepted by ONE conditional UPDATE bound to the ciphertext that
 *   was read, refusing while locked and refusing any step at or below the last
 *   accepted one — two concurrent requests with one code, exactly one wins;
 * - a sealed secret that does not open, or does not decode, is `'bad_code'`,
 *   never an exception;
 * - beginning enrolment again replaces the pending secret but never clears
 *   the failure counter or the lock: those belong to whoever is guessing.
 *
 * **Roles.** Only a live head (`is_head`) invites or removes staff; the last
 * live head cannot be removed. Head changes are serialised under one advisory
 * lock, so two concurrent removals cannot each see "another head remains".
 *
 * The TOTP secret is sealed under `{ businessId: '', ref: 'staff-totp:<id>' }`
 * — an empty business no business id can be, and a lowercase colon-bearing
 * ref no credential ref can be (`CREDENTIAL_REF_PATTERN`). A row copied onto
 * another staff member, or into an owner's columns, does not open.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { Queryable } from '../db/pool.js';
import { withPlatform } from '../db/platform-pool.js';
import { LINK_HOURS, SESSION_HOURS, TRUSTED_DEVICE_DAYS } from '../auth/lifetimes.js';
import {
  DECOY_HASH,
  DECOY_SALT,
  hashPassword,
  LOCK_MINUTES,
  MAX_FAILED,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from '../auth/password.js';
import { generateTotpSecret, matchTotp } from '../auth/totp.js';
import { EMAIL_SHAPE } from '../governance/typed-recipients.js';
import { decryptSecret, encryptSecret, type SecretAad } from '../governance/secret-cipher.js';
import { normaliseLogin } from './login.js';

/** Raw token size for sessions, devices and links: 256 bits. Only sha256 is stored. */
const TOKEN_BYTES = 32;
const RAW_TOKEN_SHAPE = /^[0-9a-f]{64}$/;
/** Serialises every change to who is a head, and who exists. */
const STAFF_LOCK = "SELECT pg_advisory_xact_lock(hashtextextended('platform:staff', 0))";

/** A session that still owes its second factor; `null` is a full session. */
export type StaffPendingFactor = 'enroll' | 'verify';

/** A refusal by this store, in Hebrew for the technician. Never names a secret. */
export class StaffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffError';
  }
}

/** `createHeadStaff` while a live head exists. */
export class StaffHeadExistsError extends StaffError {
  constructor() {
    super('כבר קיים ראש צוות.');
    this.name = 'StaffHeadExistsError';
  }
}

/** `staffBeginEnrolment` on a staff member whose second factor is already set. */
export class StaffTotpAlreadyEnrolledError extends Error {
  constructor() {
    super('staff second factor already enrolled');
    this.name = 'StaffTotpAlreadyEnrolledError';
  }
}

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

function aadFor(staffId: string): SecretAad {
  return { businessId: '', ref: `staff-totp:${staffId}` };
}

/** One platform connection, one transaction. */
async function platformTx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  return withPlatform(async (db) => {
    await db.query('BEGIN');
    try {
      const result = await fn(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      // A failed rollback leaves the connection in a transaction, and
      // `withPlatform` destroys it rather than pooling it.
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new StaffError(`הסיסמה קצרה מדי — לפחות ${MIN_PASSWORD_LENGTH} תווים.`);
  }
}

function checkLogin(login: string): string {
  const normalised = normaliseLogin(login);
  if (!EMAIL_SHAPE.test(normalised)) throw new StaffError('כתובת מייל לא תקינה.');
  return normalised;
}

function checkName(displayName: string): string {
  const name = displayName.trim();
  if (name.length === 0) throw new StaffError('חסר שם.');
  return name;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/** Is `staffId` a live (not removed) head? Read on the caller's transaction. */
async function isLiveHead(db: Queryable, staffId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM platform_staff WHERE staff_id = $1 AND is_head AND removed_at IS NULL',
    [staffId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Staff records
// ---------------------------------------------------------------------------

/**
 * Create the first head. Refused while any live head exists — further staff
 * come in through `inviteStaff`, by a head. Run by `npm run staff --
 * create-head` on the server.
 */
export async function createHeadStaff(input: {
  login: string;
  displayName: string;
  password: string;
}): Promise<string> {
  const login = checkLogin(input.login);
  const displayName = checkName(input.displayName);
  checkPassword(input.password);
  const { hash, salt } = await hashPassword(input.password);
  const staffId = `ST-${ulid()}`;
  try {
    await platformTx(async (db) => {
      await db.query(STAFF_LOCK);
      if (await anyLiveHead(db)) throw new StaffHeadExistsError();
      await db.query(
        `INSERT INTO platform_staff (staff_id, login, display_name, password_hash, password_salt, is_head)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [staffId, login, displayName, hash, salt],
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new StaffError('הכתובת כבר רשומה.');
    throw err;
  }
  return staffId;
}

async function anyLiveHead(db: Queryable): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM platform_staff WHERE is_head AND removed_at IS NULL LIMIT 1');
  return rows.length > 0;
}

/** Does any live head exist? (`staff create-head` asks before it prompts.) */
export async function headExists(): Promise<boolean> {
  return withPlatform(anyLiveHead);
}

/**
 * A head invites a colleague: a staff row with no password, and a one-time
 * link (72 h) that sets it. Returns the raw token; only its sha256 is stored.
 */
export async function inviteStaff(
  input: { login: string; displayName: string; issuedBy: string },
  now: Date = new Date(),
): Promise<{ staffId: string; token: string }> {
  const login = checkLogin(input.login);
  const displayName = checkName(input.displayName);
  const staffId = `ST-${ulid()}`;
  const token = newToken();
  const expiresAt = new Date(now.getTime() + LINK_HOURS * 3600_000);
  try {
    await platformTx(async (db) => {
      await db.query(STAFF_LOCK);
      if (!(await isLiveHead(db, input.issuedBy))) throw new StaffError('רק ראש צוות מוסיף אנשי צוות.');
      await db.query(
        `INSERT INTO platform_staff (staff_id, login, display_name, created_at) VALUES ($1, $2, $3, $4)`,
        [staffId, login, displayName, now],
      );
      await db.query(
        `INSERT INTO platform_staff_links (link_hash, staff_id, created_at, expires_at, issued_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [sha256(token), staffId, now, expiresAt, input.issuedBy],
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new StaffError('הכתובת כבר רשומה.');
    throw err;
  }
  return { staffId, token };
}

export type StaffRedeemResult =
  | { ok: true; staffId: string }
  | { ok: false; code: 'invalid' | 'login_mismatch' | 'expired' | 'used' | 'weak_password' };

/**
 * Redeem an invite: the redeemer retypes the address (letter case does not
 * matter) and chooses a password. A wrong address or a weak password does not
 * consume the link. The claim is one conditional UPDATE, and the claim and the
 * password commit together. Every session and device of the member is revoked
 * — a password set by link replaces whatever came before.
 */
export async function redeemStaffLink(
  input: { rawToken: string; typedLogin: string; password: string },
  now: Date = new Date(),
): Promise<StaffRedeemResult> {
  if (!RAW_TOKEN_SHAPE.test(input.rawToken)) return { ok: false, code: 'invalid' };
  const hash = sha256(input.rawToken);
  return platformTx(async (db) => {
    const { rows } = await db.query<{
      staff_id: string;
      login: string;
      removed_at: Date | null;
      expires_at: Date;
      used_at: Date | null;
    }>(
      `SELECT l.staff_id, s.login, s.removed_at, l.expires_at, l.used_at
         FROM platform_staff_links l JOIN platform_staff s ON s.staff_id = l.staff_id
        WHERE l.link_hash = $1
        FOR UPDATE OF l`,
      [hash],
    );
    const row = rows[0];
    if (!row || row.removed_at !== null) return { ok: false, code: 'invalid' };
    if (row.used_at !== null) return { ok: false, code: 'used' };
    if (row.expires_at.getTime() <= now.getTime()) return { ok: false, code: 'expired' };
    if (normaliseLogin(input.typedLogin) !== normaliseLogin(row.login)) return { ok: false, code: 'login_mismatch' };
    if (input.password.length < MIN_PASSWORD_LENGTH) return { ok: false, code: 'weak_password' };

    const claimed = await db.query(
      `UPDATE platform_staff_links SET used_at = $2
        WHERE link_hash = $1 AND used_at IS NULL AND expires_at > $2`,
      [hash, now],
    );
    if ((claimed.rowCount ?? 0) === 0) return { ok: false, code: 'used' };

    const { hash: passwordHash, salt } = await hashPassword(input.password);
    await db.query(
      `UPDATE platform_staff
          SET password_hash = $2, password_salt = $3, failed_attempts = 0, locked_until = NULL
        WHERE staff_id = $1`,
      [row.staff_id, passwordHash, salt],
    );
    await revokeAll(db, row.staff_id, now);
    return { ok: true, staffId: row.staff_id };
  });
}

/** Revoke every session and trusted device of a member, on the caller's connection. */
async function revokeAll(db: Queryable, staffId: string, now: Date): Promise<void> {
  await db.query(
    'UPDATE platform_staff_sessions SET revoked_at = $2 WHERE staff_id = $1 AND revoked_at IS NULL',
    [staffId, now],
  );
  await db.query(
    'UPDATE platform_staff_devices SET revoked_at = $2 WHERE staff_id = $1 AND revoked_at IS NULL',
    [staffId, now],
  );
}

/**
 * Retire a member: `removed_at` is set, every session and device is revoked,
 * and any unused link is spent — in one transaction. Only a live head removes,
 * and the last live head is never removed.
 */
export async function removeStaff(staffId: string, options: { by: string }, now: Date = new Date()): Promise<void> {
  await platformTx(async (db) => {
    await db.query(STAFF_LOCK);
    if (!(await isLiveHead(db, options.by))) throw new StaffError('רק ראש צוות מסיר אנשי צוות.');
    const { rows } = await db.query<{ is_head: boolean }>(
      'SELECT is_head FROM platform_staff WHERE staff_id = $1 AND removed_at IS NULL',
      [staffId],
    );
    const target = rows[0];
    if (!target) throw new StaffError('איש הצוות לא נמצא.');
    if (target.is_head) {
      const heads = await db.query<{ n: string }>(
        'SELECT count(*) AS n FROM platform_staff WHERE is_head AND removed_at IS NULL',
      );
      if (Number(heads.rows[0]?.n ?? 0) <= 1) throw new StaffError('אי אפשר להסיר את ראש הצוות האחרון.');
    }
    await db.query('UPDATE platform_staff SET removed_at = $2 WHERE staff_id = $1', [staffId, now]);
    await revokeAll(db, staffId, now);
    await db.query('UPDATE platform_staff_links SET used_at = $2 WHERE staff_id = $1 AND used_at IS NULL', [
      staffId,
      now,
    ]);
  });
}

export interface StaffListing {
  staffId: string;
  displayName: string;
  login: string;
  isHead: boolean;
  enrolled: boolean;
  removed: boolean;
}

export async function listStaff(): Promise<StaffListing[]> {
  const { rows } = await withPlatform((db) =>
    db.query<{
      staff_id: string;
      display_name: string;
      login: string;
      is_head: boolean;
      enrolled: boolean;
      removed: boolean;
    }>(
      `SELECT staff_id, display_name, login, is_head,
              totp_enrolled_at IS NOT NULL AS enrolled,
              removed_at IS NOT NULL AS removed
         FROM platform_staff ORDER BY created_at, staff_id`,
    ),
  );
  return rows.map((r) => ({
    staffId: r.staff_id,
    displayName: r.display_name,
    login: r.login,
    isHead: r.is_head,
    enrolled: r.enrolled,
    removed: r.removed,
  }));
}

// ---------------------------------------------------------------------------
// Password login and sessions
// ---------------------------------------------------------------------------

/**
 * The password half of the panel login. Returns the member, never a session:
 * the panel decides the factor owed and calls `startStaffSession`.
 *
 * An unknown address, a removed member and an invited member who has not set
 * a password all pay the decoy scrypt and answer `bad_credentials` — none is
 * distinguishable from a wrong password. A locked member answers `locked`
 * without scrypt, as the owner login does. Counters move in SQL.
 */
export async function staffLogin(input: {
  login: string;
  password: string;
  now?: Date;
}): Promise<{ ok: true; staffId: string } | { ok: false; code: 'bad_credentials' | 'locked' }> {
  const now = input.now ?? new Date();
  return withPlatform(async (db) => {
    const { rows } = await db.query<{
      staff_id: string;
      password_hash: string | null;
      password_salt: string | null;
      locked_until: Date | null;
      removed_at: Date | null;
    }>(
      `SELECT staff_id, password_hash, password_salt, locked_until, removed_at
         FROM platform_staff WHERE lower(login) = $1`,
      [normaliseLogin(input.login)],
    );
    const row = rows[0];
    if (!row || row.removed_at !== null || row.password_hash === null || row.password_salt === null) {
      await verifyPassword(input.password, DECOY_HASH, DECOY_SALT);
      return { ok: false, code: 'bad_credentials' };
    }

    let locked = row.locked_until !== null;
    if (row.locked_until !== null && row.locked_until.getTime() <= now.getTime()) {
      // Cleared only if no fresh lock was set in between (re-checked in SQL).
      const cleared = await db.query(
        `UPDATE platform_staff SET failed_attempts = 0, locked_until = NULL
          WHERE staff_id = $1 AND locked_until <= $2`,
        [row.staff_id, now],
      );
      if ((cleared.rowCount ?? 0) > 0) locked = false;
    }
    if (locked) return { ok: false, code: 'locked' };

    if (!(await verifyPassword(input.password, row.password_hash, row.password_salt))) {
      await db.query(
        `UPDATE platform_staff
            SET failed_attempts = failed_attempts + 1,
                locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN $3 ELSE locked_until END
          WHERE staff_id = $1`,
        [row.staff_id, MAX_FAILED, new Date(now.getTime() + LOCK_MINUTES * 60_000)],
      );
      return { ok: false, code: 'bad_credentials' };
    }

    await db.query('UPDATE platform_staff SET failed_attempts = 0, locked_until = NULL WHERE staff_id = $1', [
      row.staff_id,
    ]);
    return { ok: true, staffId: row.staff_id };
  });
}

async function insertSession(
  db: Queryable,
  staffId: string,
  pendingFactor: StaffPendingFactor | null,
  now: Date,
): Promise<string> {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3600_000);
  await db.query(
    `INSERT INTO platform_staff_sessions (session_hash, staff_id, created_at, expires_at, pending_factor)
     VALUES ($1, $2, $3, $4, $5)`,
    [sha256(token), staffId, now, expiresAt, pendingFactor],
  );
  return token;
}

/**
 * Mint a session. `pendingFactor` is required, with no default: `null` (owes
 * nothing) must be said out loud. Refused at compile time and, past a cast,
 * at run time before any row is written. A removed member gets no session.
 */
export async function startStaffSession(
  staffId: string,
  options: { pendingFactor: StaffPendingFactor | null; now?: Date },
): Promise<string> {
  if ((options as { pendingFactor?: unknown } | undefined)?.pendingFactor === undefined) {
    throw new TypeError('startStaffSession: pendingFactor is required');
  }
  const now = options.now ?? new Date();
  return withPlatform(async (db) => {
    const { rows } = await db.query('SELECT 1 FROM platform_staff WHERE staff_id = $1 AND removed_at IS NULL', [
      staffId,
    ]);
    if (rows.length === 0) throw new StaffError('איש הצוות לא נמצא.');
    return insertSession(db, staffId, options.pendingFactor, now);
  });
}

/**
 * Replace a live session with a fresh token — used when the second factor
 * settles, so the token that existed before the factor (and may have been
 * seen) never becomes a full session. One transaction: the old one is revoked
 * by a conditional UPDATE, and only if that UPDATE took a row is a new one
 * minted. `null` for a token that is not live.
 */
export async function rotateStaffSession(
  token: string,
  options: { pendingFactor: StaffPendingFactor | null; now?: Date },
): Promise<string | null> {
  if ((options as { pendingFactor?: unknown } | undefined)?.pendingFactor === undefined) {
    throw new TypeError('rotateStaffSession: pendingFactor is required');
  }
  const now = options.now ?? new Date();
  return platformTx(async (db) => {
    const { rows } = await db.query<{ staff_id: string }>(
      `UPDATE platform_staff_sessions ss SET revoked_at = $2
         FROM platform_staff s
        WHERE ss.session_hash = $1 AND ss.revoked_at IS NULL AND ss.expires_at > $2
          AND s.staff_id = ss.staff_id AND s.removed_at IS NULL
        RETURNING ss.staff_id`,
      [sha256(token), now],
    );
    const staffId = rows[0]?.staff_id;
    if (staffId === undefined) return null;
    return insertSession(db, staffId, options.pendingFactor, now);
  });
}

export interface StaffSession {
  staffId: string;
  displayName: string;
  isHead: boolean;
  pendingFactor: StaffPendingFactor | null;
}

/** A live session of a member who has not been removed, or `null`. */
export async function verifyStaffSession(token: string, options: { now?: Date } = {}): Promise<StaffSession | null> {
  if (token.length === 0) return null;
  const now = options.now ?? new Date();
  const { rows } = await withPlatform((db) =>
    db.query<{ staff_id: string; display_name: string; is_head: boolean; pending_factor: StaffPendingFactor | null }>(
      `SELECT s.staff_id, s.display_name, s.is_head, ss.pending_factor
         FROM platform_staff_sessions ss JOIN platform_staff s ON s.staff_id = ss.staff_id
        WHERE ss.session_hash = $1 AND ss.revoked_at IS NULL AND ss.expires_at > $2
          AND s.removed_at IS NULL`,
      [sha256(token), now],
    ),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    staffId: row.staff_id,
    displayName: row.display_name,
    isHead: row.is_head,
    pendingFactor: row.pending_factor,
  };
}

export async function revokeStaffSession(token: string): Promise<void> {
  await withPlatform((db) =>
    db.query('UPDATE platform_staff_sessions SET revoked_at = now() WHERE session_hash = $1 AND revoked_at IS NULL', [
      sha256(token),
    ]),
  );
}

/** Set or clear the second factor a live session still owes. */
export async function setStaffPendingFactor(token: string, factor: StaffPendingFactor | null): Promise<void> {
  await withPlatform((db) =>
    db.query(
      'UPDATE platform_staff_sessions SET pending_factor = $2 WHERE session_hash = $1 AND revoked_at IS NULL',
      [sha256(token), factor],
    ),
  );
}

// ---------------------------------------------------------------------------
// Second factor
// ---------------------------------------------------------------------------

interface TotpRow {
  totp_ciphertext: Buffer | null;
  totp_nonce: Buffer | null;
  totp_enrolled_at: Date | null;
  totp_last_step: string | null;
  totp_locked_until: Date | null;
}

interface TotpState {
  sealed: { ciphertext: Buffer; nonce: Buffer } | null;
  enrolled: boolean;
  lastStep: number | null;
  lockedUntil: Date | null;
}

function toTotpState(row: TotpRow): TotpState {
  return {
    sealed:
      row.totp_ciphertext !== null && row.totp_nonce !== null
        ? { ciphertext: row.totp_ciphertext, nonce: row.totp_nonce }
        : null,
    enrolled: row.totp_enrolled_at !== null,
    // bigint comes back from pg as a string.
    lastStep: row.totp_last_step === null ? null : Number(row.totp_last_step),
    lockedUntil: row.totp_locked_until,
  };
}

/** The live member's TOTP state, or `null` for an unknown or removed member. */
async function loadTotp(db: Queryable, staffId: string): Promise<TotpState | null> {
  const { rows } = await db.query<TotpRow>(
    `SELECT totp_ciphertext, totp_nonce, totp_enrolled_at, totp_last_step, totp_locked_until
       FROM platform_staff WHERE staff_id = $1 AND removed_at IS NULL`,
    [staffId],
  );
  const row = rows[0];
  return row ? toTotpState(row) : null;
}

/** The step a code matches, or `null` — wrong, replayed, unopenable, or not base32. Never throws. */
function matchSealed(staffId: string, state: TotpState, code: string, key: Buffer, now: Date): number | null {
  if (state.sealed === null) return null;
  const secret = decryptSecret(state.sealed, key, aadFor(staffId));
  if (secret === null) return null;
  try {
    return matchTotp(secret, code, now, state.lastStep);
  } catch {
    return null;
  }
}

/** Is the lock in force? An expired lock is cleared, re-checked in SQL so a fresh one stands. */
async function lockedNow(db: Queryable, staffId: string, state: TotpState, now: Date): Promise<boolean> {
  if (state.lockedUntil === null) return false;
  if (state.lockedUntil.getTime() > now.getTime()) return true;
  const cleared = await db.query(
    `UPDATE platform_staff SET totp_failed_attempts = 0, totp_locked_until = NULL
      WHERE staff_id = $1 AND totp_locked_until <= $2`,
    [staffId, now],
  );
  return (cleared.rowCount ?? 0) === 0;
}

async function recordFailure(db: Queryable, staffId: string, now: Date): Promise<void> {
  await db.query(
    `UPDATE platform_staff
        SET totp_failed_attempts = totp_failed_attempts + 1,
            totp_locked_until = CASE
              WHEN totp_failed_attempts + 1 >= $2 THEN $3
              ELSE totp_locked_until
            END
      WHERE staff_id = $1`,
    [staffId, MAX_FAILED, new Date(now.getTime() + LOCK_MINUTES * 60_000)],
  );
}

/**
 * Record an accepted step — only if no concurrent request accepted this step
 * or a later one, the secret is still the one the code matched (`ciphertext`),
 * the enrolment state is the one expected, and no lock was set since the
 * read. `false` means the request lost a race and counts as a failure.
 */
async function acceptStep(
  db: Queryable,
  staffId: string,
  step: number,
  options: { enrolNow: Date | null; ciphertext: Buffer; now: Date },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE platform_staff
        SET totp_last_step = $2,
            totp_failed_attempts = 0,
            totp_locked_until = NULL,
            totp_enrolled_at = COALESCE($3, totp_enrolled_at)
      WHERE staff_id = $1 AND removed_at IS NULL
        AND totp_ciphertext IS NOT NULL
        AND (totp_last_step IS NULL OR totp_last_step < $2)
        AND (($3::timestamptz IS NULL) = (totp_enrolled_at IS NOT NULL))
        AND totp_ciphertext = $4
        AND (totp_locked_until IS NULL OR totp_locked_until <= $5)`,
    [staffId, step, options.enrolNow, options.ciphertext, options.now],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function staffTotpStatus(staffId: string): Promise<'enrolled' | 'not_enrolled'> {
  const state = await withPlatform((db) => loadTotp(db, staffId));
  return state?.enrolled === true ? 'enrolled' : 'not_enrolled';
}

/**
 * Write a fresh pending secret and return it for the QR. Again replaces the
 * pending secret and its step — never the failure counter or the lock.
 * Refuses an enrolled member: re-enrolling is `staffResetSecondFactor`'s job.
 */
export async function staffBeginEnrolment(staffId: string, key: Buffer): Promise<{ secretBase32: string }> {
  const secretBase32 = generateTotpSecret();
  const sealed = encryptSecret(secretBase32, key, aadFor(staffId));
  return withPlatform(async (db) => {
    const result = await db.query(
      `UPDATE platform_staff
          SET totp_ciphertext = $2, totp_nonce = $3, totp_last_step = NULL
        WHERE staff_id = $1 AND removed_at IS NULL AND totp_enrolled_at IS NULL`,
      [staffId, sealed.ciphertext, sealed.nonce],
    );
    if ((result.rowCount ?? 0) === 0) {
      const state = await loadTotp(db, staffId);
      if (state?.enrolled === true) throw new StaffTotpAlreadyEnrolledError();
      throw new StaffError('איש הצוות לא נמצא.');
    }
    return { secretBase32 };
  });
}

/** Confirm a pending enrolment with the first code the app shows. */
export async function staffConfirmEnrolment(
  staffId: string,
  code: string,
  key: Buffer,
  now: Date = new Date(),
): Promise<'ok' | 'bad_code' | 'locked'> {
  return withPlatform(async (db) => {
    const state = await loadTotp(db, staffId);
    if (state === null || state.sealed === null || state.enrolled) return 'bad_code';
    if (await lockedNow(db, staffId, state, now)) return 'locked';
    const step = matchSealed(staffId, state, code, key, now);
    if (
      step !== null &&
      (await acceptStep(db, staffId, step, { enrolNow: now, ciphertext: state.sealed.ciphertext, now }))
    ) {
      return 'ok';
    }
    await recordFailure(db, staffId, now);
    return 'bad_code';
  });
}

/** The second factor at sign-in. */
export async function staffVerifySecondFactor(
  staffId: string,
  code: string,
  key: Buffer,
  now: Date = new Date(),
): Promise<'ok' | 'bad_code' | 'locked' | 'not_enrolled'> {
  return withPlatform(async (db) => {
    const state = await loadTotp(db, staffId);
    if (state === null || !state.enrolled || state.sealed === null) return 'not_enrolled';
    if (await lockedNow(db, staffId, state, now)) return 'locked';
    const step = matchSealed(staffId, state, code, key, now);
    if (
      step !== null &&
      (await acceptStep(db, staffId, step, { enrolNow: null, ciphertext: state.sealed.ciphertext, now }))
    ) {
      return 'ok';
    }
    await recordFailure(db, staffId, now);
    return 'bad_code';
  });
}

/**
 * Forget the second factor: the member enrols again at the next sign-in.
 * Every session and trusted device goes with it, in one transaction.
 */
export async function staffResetSecondFactor(staffId: string, now: Date = new Date()): Promise<void> {
  await platformTx(async (db) => {
    await db.query(
      `UPDATE platform_staff
          SET totp_ciphertext = NULL, totp_nonce = NULL, totp_enrolled_at = NULL,
              totp_last_step = NULL, totp_failed_attempts = 0, totp_locked_until = NULL
        WHERE staff_id = $1`,
      [staffId],
    );
    await revokeAll(db, staffId, now);
  });
}

/** Mint a trusted-device token; only its sha256 is stored. Returns the raw token. */
export async function issueStaffDevice(staffId: string, now: Date = new Date()): Promise<string> {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + TRUSTED_DEVICE_DAYS * 86_400_000);
  await withPlatform((db) =>
    db.query(
      `INSERT INTO platform_staff_devices (device_hash, staff_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [sha256(token), staffId, now, expiresAt],
    ),
  );
  return token;
}

/** Is this token a live, unrevoked device of this (not removed) member? */
export async function isStaffDevice(staffId: string, token: string, now: Date = new Date()): Promise<boolean> {
  if (token.length === 0) return false;
  const { rows } = await withPlatform((db) =>
    db.query(
      `SELECT 1 FROM platform_staff_devices d JOIN platform_staff s ON s.staff_id = d.staff_id
        WHERE d.device_hash = $1 AND d.staff_id = $2
          AND d.revoked_at IS NULL AND d.expires_at > $3 AND s.removed_at IS NULL`,
      [sha256(token), staffId, now],
    ),
  );
  return rows.length > 0;
}
