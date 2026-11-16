import { randomBytes } from 'node:crypto';
import { withBusiness } from '../db/pool.js';
import { createOwner, sessionCookieValue } from '../dashboard/auth.js';
import { beginEnrolment, confirmEnrolment, issueTrustedDevice, totpStatus } from '../dashboard/second-factor.js';
import { currentStep, totpCode } from '../auth/totp.js';
import { registerBusiness } from './db.js';

/**
 * The master key every test dashboard is started with (`createServer({
 * masterKey: TEST_MASTER_KEY })`), and that `loginWithSecondFactor` seals the
 * owner's second factor under. One per test process; never on disk.
 */
export const TEST_MASTER_KEY: Buffer = randomBytes(32);

/** The trusted-device cookie the dashboard reads (`tdev`). */
export const TRUSTED_DEVICE_COOKIE = 'tdev';

/**
 * The login address a test owner signs in with. One dashboard serves every
 * business and the address decides which (spec §5.5), so it is derived from
 * the business: two businesses' test owners never collide on the server-wide
 * unique login.
 */
export function ownerLogin(businessId: string, username = 'owner'): string {
  return `${username}@${businessId}.example`;
}

/**
 * Register the business (login resolves only registered, active businesses)
 * and create its dashboard owner, logging in as `ownerLogin(businessId, username)`
 * unless `login` says otherwise.
 */
export async function createTestOwner(
  businessId: string,
  input: { username: string; password: string; login?: string },
): Promise<void> {
  await registerBusiness(businessId);
  await withBusiness(businessId, (db) =>
    createOwner(db, {
      username: input.username,
      login: input.login ?? ownerLogin(businessId, input.username),
      password: input.password,
    }),
  );
}

/**
 * Enrol the owner's second factor through the store (not over HTTP), under
 * `TEST_MASTER_KEY`, three steps in the past so the step it spends never
 * blocks a code a test then types at the real current step. Returns the
 * secret. No-op returning `null` when the owner is already enrolled.
 */
export async function enrolTestOwner(businessId: string, username = 'owner'): Promise<string | null> {
  return withBusiness(businessId, async (db) => {
    if ((await totpStatus(db, username)) === 'enrolled') return null;
    const { secretBase32 } = await beginEnrolment(db, username, TEST_MASTER_KEY);
    const past = new Date(Date.now() - 90_000);
    const result = await confirmEnrolment(
      db,
      username,
      totpCode(secretBase32, currentStep(past)),
      TEST_MASTER_KEY,
      past,
    );
    if (result !== 'ok') throw new Error(`enrolTestOwner: confirmEnrolment said ${result}`);
    return secretBase32;
  });
}

/** A fresh trusted-device cookie pair (`tdev=<business>.<token>`) for the owner. */
export async function trustedDeviceCookie(businessId: string, username = 'owner'): Promise<string> {
  const token = await withBusiness(businessId, (db) => issueTrustedDevice(db, username));
  return `${TRUSTED_DEVICE_COOKIE}=${sessionCookieValue(businessId, token)}`;
}

/**
 * Sign in to a test dashboard past both factors, the way an owner on a
 * device it already trusts does: the second factor is enrolled through the
 * store, a trusted device is issued, and `POST /login` carries its cookie —
 * so the password alone yields a full session, with the gate intact. Returns
 * the `sid=...` cookie pair. The server must have been started with
 * `masterKey: TEST_MASTER_KEY`.
 */
export async function loginWithSecondFactor(
  baseUrl: string,
  businessId: string,
  input: { username?: string; password: string; login?: string },
): Promise<string> {
  const username = input.username ?? 'owner';
  await enrolTestOwner(businessId, username);
  const device = await trustedDeviceCookie(businessId, username);
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { cookie: device },
    body: new URLSearchParams({ email: input.login ?? ownerLogin(businessId, username), password: input.password }),
    redirect: 'manual',
  });
  if (res.status !== 303 || res.headers.get('location') !== '/') {
    throw new Error(`loginWithSecondFactor: expected 303 to /, got ${res.status} to ${res.headers.get('location')}`);
  }
  const sid = res.headers.getSetCookie().find((c) => c.startsWith('sid='));
  const pair = sid?.split(';')[0];
  if (!pair) throw new Error('loginWithSecondFactor: no session cookie');
  return pair;
}
