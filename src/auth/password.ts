/**
 * Password hashing and the password lock's numbers, shared by the owner's
 * dashboard login (`dashboard/auth.ts`) and the platform staff login
 * (`tenancy/staff.ts`).
 *
 * Its own module, depending on nothing in the app: the tenancy layer must not
 * depend on the dashboard (see `tenancy/login.ts`), and two copies of "how a
 * password is hashed" or "how many wrong tries lock an account" are two
 * places to drift. `dashboard/auth.ts` re-exports everything here, so its
 * existing importers are unchanged.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/**
 * The password lock: five wrong attempts, fifteen minutes. The second factor
 * (owner and staff) locks with exactly these numbers — one definition, not
 * several drifting apart.
 */
export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;

/**
 * The shortest password accepted — an owner's (`POST /password`, an invite
 * or reset link) and a staff member's (an invite link, `staff create-head`).
 */
export const MIN_PASSWORD_LENGTH = 10;

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
 * A fixed salt/hash pair that never matches any real password. A login whose
 * address names no account runs a verification against this, so a "no such
 * user" response costs the same scrypt work as a "wrong password" response.
 * Without it, the two are distinguishable by response time alone.
 */
export const DECOY_SALT = '0'.repeat(32);
export const DECOY_HASH = '0'.repeat(KEY_LENGTH * 2);
