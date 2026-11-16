/**
 * The owner's second factor (Google Authenticator, RFC 6238) and the devices
 * that may skip it for thirty days. Replaces the recovery codes (migration
 * 070). The HTTP flow that uses this store lives in the dashboard server.
 *
 * **The secret is sealed with the master key**, AAD
 * `{ businessId, ref: 'totp:<username>' }` — lowercase with a colon, so it can
 * never collide with a real credential ref (`CREDENTIAL_REF_PATTERN`), the
 * same trick `key-check` and `grant:<system>` use. A row copied into another
 * business, or under another username, does not open.
 *
 * **Nothing here throws on a bad secret.** A sealed secret that does not open
 * (wrong key, moved row, altered bytes) or that is not valid base32 is a
 * `'bad_code'` on the login path, never an exception: the owner sees "wrong
 * code", the failure counter moves, and nothing about the stored row is told
 * to whoever provoked it.
 *
 * **Replay.** `totp_last_step` is the last accepted 30-second step, and
 * `matchTotp` refuses any step at or below it. The write that records a new
 * step is conditional (`totp_last_step IS NULL OR totp_last_step < $step`),
 * so of two concurrent requests carrying the same code only one wins.
 *
 * **Lockout** uses the password's numbers (`MAX_FAILED`, `LOCK_MINUTES` from
 * `auth.ts`), counted in SQL so concurrent wrong codes cannot under-count.
 */
import { createHash, randomBytes } from 'node:crypto';
import { transaction, type BusinessDb } from '../db/pool.js';
import { TRUSTED_DEVICE_DAYS } from '../auth/lifetimes.js';
import { generateTotpSecret, matchTotp } from '../auth/totp.js';
import { decryptSecret, encryptSecret, type SecretAad } from '../governance/secret-cipher.js';
import {
  LOCK_MINUTES,
  MAX_FAILED,
  revokeAllSessions,
  setSessionPendingFactor,
  type PendingFactor,
} from './auth.js';

/** How long a trusted device skips the second factor (shared with the staff store). */
export { TRUSTED_DEVICE_DAYS } from '../auth/lifetimes.js';

/** Raw trusted-device token size: 256 bits. Only its sha256 is stored. */
const DEVICE_TOKEN_BYTES = 32;

/** `beginEnrolment` on an account whose second factor is already set. */
export class TotpAlreadyEnrolledError extends Error {
  constructor() {
    super('second factor already enrolled');
    this.name = 'TotpAlreadyEnrolledError';
  }
}

function aadFor(db: BusinessDb, username: string): SecretAad {
  return { businessId: db.businessId, ref: `totp:${username}` };
}

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

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

async function loadTotp(db: BusinessDb, username: string): Promise<TotpState | null> {
  const { rows } = await db.query<TotpRow>(
    `SELECT totp_ciphertext, totp_nonce, totp_enrolled_at, totp_last_step, totp_locked_until
       FROM dashboard_users
      WHERE business_id = $1 AND username = $2`,
    [db.businessId, username],
  );
  const row = rows[0];
  return row ? toTotpState(row) : null;
}

/**
 * The step a code matches, or `null` — for a wrong code, a replayed step, a
 * secret that does not open, or one that does not decode. Never throws.
 */
function matchSealed(
  db: BusinessDb,
  username: string,
  state: TotpState,
  code: string,
  key: Buffer,
  now: Date,
): number | null {
  if (state.sealed === null) return null;
  const secret = decryptSecret(state.sealed, key, aadFor(db, username));
  if (secret === null) return null;
  try {
    return matchTotp(secret, code, now, state.lastStep);
  } catch {
    // A secret that opened but is not base32 — corrupt, not a code to report.
    return null;
  }
}

/**
 * Is the account's lock in force at `now`? An expired lock is cleared on the
 * way through, with the expiry re-checked in SQL so a fresh lock set by a
 * concurrent failure is not clobbered (the same pattern as the password).
 */
async function lockedNow(db: BusinessDb, username: string, state: TotpState, now: Date): Promise<boolean> {
  if (state.lockedUntil === null) return false;
  if (state.lockedUntil.getTime() > now.getTime()) return true;
  const cleared = await db.query(
    `UPDATE dashboard_users SET totp_failed_attempts = 0, totp_locked_until = NULL
      WHERE business_id = $1 AND username = $2 AND totp_locked_until <= $3`,
    [db.businessId, username, now],
  );
  // A no-op means someone else's fresh lock won the race, and it stands.
  return (cleared.rowCount ?? 0) === 0;
}

async function recordFailure(db: BusinessDb, username: string, now: Date): Promise<void> {
  const lockUntilIfThresholdReached = new Date(now.getTime() + LOCK_MINUTES * 60_000);
  await db.query(
    `UPDATE dashboard_users
        SET totp_failed_attempts = totp_failed_attempts + 1,
            totp_locked_until = CASE
              WHEN totp_failed_attempts + 1 >= $3 THEN $4
              ELSE totp_locked_until
            END
      WHERE business_id = $1 AND username = $2`,
    [db.businessId, username, MAX_FAILED, lockUntilIfThresholdReached],
  );
}

/**
 * Record an accepted step and clear the counters — only if no concurrent
 * request has already accepted this step or a later one, the secret is still
 * the one the code was matched against (`ciphertext`: a second
 * `beginEnrolment` in between must not let a code of the old pending secret
 * enrol the new one), and no lock has been set since the state was read.
 * `false` means this request lost a race, and is counted as a failure.
 */
async function acceptStep(
  db: BusinessDb,
  username: string,
  step: number,
  options: { enrolNow: Date | null; ciphertext: Buffer; now: Date },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE dashboard_users
        SET totp_last_step = $3,
            totp_failed_attempts = 0,
            totp_locked_until = NULL,
            totp_enrolled_at = COALESCE($4, totp_enrolled_at)
      WHERE business_id = $1 AND username = $2
        AND totp_ciphertext IS NOT NULL
        AND (totp_last_step IS NULL OR totp_last_step < $3)
        AND (($4::timestamptz IS NULL) = (totp_enrolled_at IS NOT NULL))
        AND totp_ciphertext = $5
        AND (totp_locked_until IS NULL OR totp_locked_until <= $6)`,
    [db.businessId, username, step, options.enrolNow, options.ciphertext, options.now],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function totpStatus(db: BusinessDb, username: string): Promise<'enrolled' | 'not_enrolled'> {
  const state = await loadTotp(db, username);
  return state?.enrolled === true ? 'enrolled' : 'not_enrolled';
}

/**
 * Write a fresh *pending* secret and return it for the QR. Calling it again
 * replaces the pending secret (the owner scanned nothing, or reloaded); it
 * refuses an enrolled account — re-enrolling is `resetSecondFactor`'s job,
 * never a page reload's. The replacement resets the step, which belongs to
 * the secret, but **not** the failure counter or the lock: those belong to
 * whoever is guessing, and a reload that cleared them would turn the lockout
 * into four guesses per page load, without end. An expired lock is cleared
 * lazily by the next confirm, as on the password.
 */
export async function beginEnrolment(
  db: BusinessDb,
  username: string,
  key: Buffer,
): Promise<{ secretBase32: string }> {
  const secretBase32 = generateTotpSecret();
  const sealed = encryptSecret(secretBase32, key, aadFor(db, username));
  const result = await db.query(
    `UPDATE dashboard_users
        SET totp_ciphertext = $3, totp_nonce = $4, totp_last_step = NULL
      WHERE business_id = $1 AND username = $2 AND totp_enrolled_at IS NULL`,
    [db.businessId, username, sealed.ciphertext, sealed.nonce],
  );
  if ((result.rowCount ?? 0) === 0) {
    const state = await loadTotp(db, username);
    if (state?.enrolled === true) throw new TotpAlreadyEnrolledError();
    throw new Error(`beginEnrolment: no dashboard account "${username}"`);
  }
  return { secretBase32 };
}

/**
 * Confirm a pending enrolment with the first code the app shows. On `ok` the
 * account is enrolled and that code's step is spent. No pending secret, an
 * already-enrolled account, or a wrong code — all `'bad_code'`.
 */
export async function confirmEnrolment(
  db: BusinessDb,
  username: string,
  code: string,
  key: Buffer,
  now: Date = new Date(),
): Promise<'ok' | 'bad_code' | 'locked'> {
  const state = await loadTotp(db, username);
  if (state === null || state.sealed === null || state.enrolled) return 'bad_code';
  if (await lockedNow(db, username, state, now)) return 'locked';

  const step = matchSealed(db, username, state, code, key, now);
  if (
    step !== null &&
    (await acceptStep(db, username, step, { enrolNow: now, ciphertext: state.sealed.ciphertext, now }))
  ) {
    return 'ok';
  }

  await recordFailure(db, username, now);
  return 'bad_code';
}

/** The second factor at sign-in. */
export async function verifySecondFactor(
  db: BusinessDb,
  username: string,
  code: string,
  key: Buffer,
  now: Date = new Date(),
): Promise<'ok' | 'bad_code' | 'locked' | 'not_enrolled'> {
  const state = await loadTotp(db, username);
  if (state === null || !state.enrolled) return 'not_enrolled';
  if (await lockedNow(db, username, state, now)) return 'locked';

  const step = matchSealed(db, username, state, code, key, now);
  if (
    step !== null &&
    state.sealed !== null &&
    (await acceptStep(db, username, step, { enrolNow: null, ciphertext: state.sealed.ciphertext, now }))
  ) {
    return 'ok';
  }

  await recordFailure(db, username, now);
  return 'bad_code';
}

/**
 * Forget the second factor entirely: the owner enrols again at the next
 * sign-in. Every open session and every trusted device goes with it, in one
 * transaction — a reset that left a stolen session or device alive would
 * leave the old factor's authority standing.
 */
export async function resetSecondFactor(db: BusinessDb, username: string): Promise<void> {
  await transaction(db, async (tx) => {
    await tx.query(
      `UPDATE dashboard_users
          SET totp_ciphertext = NULL, totp_nonce = NULL, totp_enrolled_at = NULL,
              totp_last_step = NULL, totp_failed_attempts = 0, totp_locked_until = NULL
        WHERE business_id = $1 AND username = $2`,
      [tx.businessId, username],
    );
    await revokeAllSessions(tx, username);
    await revokeTrustedDevices(tx, username);
  });
}

/** Mint a trusted-device token; only its sha256 is stored. Returns the raw token. */
export async function issueTrustedDevice(
  db: BusinessDb,
  username: string,
  now: Date = new Date(),
): Promise<string> {
  const token = randomBytes(DEVICE_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(now.getTime() + TRUSTED_DEVICE_DAYS * 86_400_000);
  await db.query(
    `INSERT INTO dashboard_trusted_devices (business_id, device_hash, username, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [db.businessId, sha256(token), username, now, expiresAt],
  );
  return token;
}

/** Is this token a live, unrevoked device of this account in this business? */
export async function isTrustedDevice(
  db: BusinessDb,
  username: string,
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (token.length === 0) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM dashboard_trusted_devices
      WHERE business_id = $1 AND device_hash = $2 AND username = $3
        AND revoked_at IS NULL AND expires_at > $4`,
    [db.businessId, sha256(token), username, now],
  );
  return rows.length > 0;
}

/** Revoke every live device of the account; returns how many. */
export async function revokeTrustedDevices(db: BusinessDb, username: string): Promise<number> {
  const result = await db.query(
    `UPDATE dashboard_trusted_devices SET revoked_at = now()
      WHERE business_id = $1 AND username = $2 AND revoked_at IS NULL`,
    [db.businessId, username],
  );
  return result.rowCount ?? 0;
}

/** Set or clear the second factor a session still owes. */
export async function setPendingFactor(
  db: BusinessDb,
  sessionToken: string,
  factor: PendingFactor | null,
): Promise<void> {
  await setSessionPendingFactor(db, sessionToken, factor);
}
