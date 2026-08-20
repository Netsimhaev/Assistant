import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  createOwner,
  hashPassword,
  login,
  revokeAllSessions,
  setPassword,
  verifyPassword,
  verifySession,
} from './auth.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('hashPassword / verifyPassword', () => {
  it('accepts the correct plaintext against its own hash', async () => {
    const { hash, salt } = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash, salt)).toBe(true);
  });

  it('rejects the wrong plaintext', async () => {
    const { hash, salt } = await hashPassword(PASSWORD);
    expect(await verifyPassword('wrong password', hash, salt)).toBe(false);
  });

  it('hashes the same password differently for two accounts (per-user salt)', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await createOwner({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
  });

  it('logs in with the correct password', async () => {
    const result = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.sessionId).toBe('string');
      expect(result.sessionId.length).toBeGreaterThan(0);
    }
  });

  it('does not log in with the wrong password', async () => {
    const result = await login({
      username: USERNAME,
      password: 'wrong password',
      businessId: BUSINESS,
    });
    expect(result).toEqual({ ok: false, code: 'bad_credentials' });
  });

  it('does not log in for a username that does not exist', async () => {
    const result = await login({
      username: 'nobody',
      password: PASSWORD,
      businessId: BUSINESS,
    });
    expect(result).toEqual({ ok: false, code: 'bad_credentials' });
  });

  it('counts failures for a username that has no row, against the shared bucket', async () => {
    // The per-user UPDATE matches nothing when there is no row, so this
    // branch used to be an unthrottled scrypt call for anyone who could
    // reach the port. Its failures now land in
    // dashboard_unknown_user_throttle instead.
    for (let i = 0; i < 5; i += 1) {
      const result = await login({ username: 'nobody', password: PASSWORD, businessId: BUSINESS });
      expect(result).toEqual({ ok: false, code: 'bad_credentials' });
    }

    const { rows } = await getPool().query<{ failed_attempts: number; locked_until: Date | null }>(
      `SELECT failed_attempts, locked_until FROM dashboard_unknown_user_throttle
        WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows[0]?.failed_attempts).toBe(5);
    expect(rows[0]?.locked_until).not.toBeNull();

    // Still `bad_credentials`, never a distinct code: whether a username
    // exists must not become readable from the reply.
    expect(await login({ username: 'nobody', password: PASSWORD, businessId: BUSINESS })).toEqual({
      ok: false,
      code: 'bad_credentials',
    });

    // And the real account is untouched by all of it.
    const real = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(real.ok).toBe(true);
  });

  it('locks the account after five wrong attempts', async () => {
    for (let i = 0; i < 5; i += 1) {
      await login({ username: USERNAME, password: 'wrong password', businessId: BUSINESS });
    }
    const result = await login({
      username: USERNAME,
      password: 'wrong password',
      businessId: BUSINESS,
    });
    expect(result).toEqual({ ok: false, code: 'locked' });
  });

  it('a locked account refuses even the correct password', async () => {
    for (let i = 0; i < 5; i += 1) {
      await login({ username: USERNAME, password: 'wrong password', businessId: BUSINESS });
    }
    const result = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(result).toEqual({ ok: false, code: 'locked' });
  });

  it('the lock expires', async () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      await login({
        username: USERNAME,
        password: 'wrong password',
        businessId: BUSINESS,
        now: start,
      });
    }
    const stillLocked = await login({
      username: USERNAME,
      password: PASSWORD,
      businessId: BUSINESS,
      now: new Date(start.getTime() + 5 * 60_000),
    });
    expect(stillLocked).toEqual({ ok: false, code: 'locked' });

    const afterCooldown = await login({
      username: USERNAME,
      password: PASSWORD,
      businessId: BUSINESS,
      now: new Date(start.getTime() + 16 * 60_000),
    });
    expect(afterCooldown.ok).toBe(true);
  });

  it('locks the account when five wrong attempts arrive concurrently', async () => {
    // A read-modify-write increment (SELECT failed_attempts, add one in
    // JavaScript, write it back) lets every one of these read the same
    // stale count and each write back the same incremented value — the
    // counter would advance by one instead of by five and the account
    // would never lock. The increment must happen inside a single SQL
    // UPDATE so Postgres's row lock serialises the five attempts.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        login({ username: USERNAME, password: 'wrong password', businessId: BUSINESS }),
      ),
    );
    const result = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(result).toEqual({ ok: false, code: 'locked' });
  });
});

describe('sessions', () => {
  beforeEach(async () => {
    await createOwner({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
  });

  it('verifies a fresh session', async () => {
    const result = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const verified = await verifySession(result.sessionId, { businessId: BUSINESS });
    expect(verified).toEqual({ username: USERNAME });
  });

  it('does not verify a revoked session', async () => {
    const result = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const revokedCount = await revokeAllSessions(USERNAME, { businessId: BUSINESS });
    expect(revokedCount).toBe(1);

    const verified = await verifySession(result.sessionId, { businessId: BUSINESS });
    expect(verified).toBeNull();
  });

  it('does not verify an expired session', async () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    const result = await login({
      username: USERNAME,
      password: PASSWORD,
      businessId: BUSINESS,
      now: start,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const verified = await verifySession(result.sessionId, {
      businessId: BUSINESS,
      now: new Date(start.getTime() + 13 * 3600_000),
    });
    expect(verified).toBeNull();
  });

  it('does not verify a session token that was never issued', async () => {
    const verified = await verifySession('0'.repeat(64), { businessId: BUSINESS });
    expect(verified).toBeNull();
  });
});

describe('tenant isolation', () => {
  const OTHER_BUSINESS = 'test-business-other';

  it('a user in one business is invisible to a login under another', async () => {
    await createOwner({ username: USERNAME, password: PASSWORD, businessId: OTHER_BUSINESS });

    const result = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(result).toEqual({ ok: false, code: 'bad_credentials' });
  });

  it('a session created under one business is invisible to a lookup under another', async () => {
    await createOwner({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    await createOwner({ username: USERNAME, password: PASSWORD, businessId: OTHER_BUSINESS });

    const result = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Same raw token, wrong tenant scope: must not resolve.
    expect(await verifySession(result.sessionId, { businessId: OTHER_BUSINESS })).toBeNull();
    // Right tenant: still resolves.
    expect(await verifySession(result.sessionId, { businessId: BUSINESS })).toEqual({
      username: USERNAME,
    });
  });
});

describe('setPassword', () => {
  beforeEach(async () => {
    await createOwner({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
  });

  it('revokes every open session', async () => {
    const first = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    const second = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    await setPassword({ username: USERNAME, password: 'a brand new password', businessId: BUSINESS });

    expect(await verifySession(first.sessionId, { businessId: BUSINESS })).toBeNull();
    expect(await verifySession(second.sessionId, { businessId: BUSINESS })).toBeNull();
  });

  it('lets a subsequent login use the new password and rejects the old one', async () => {
    await setPassword({ username: USERNAME, password: 'a brand new password', businessId: BUSINESS });

    const withOld = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(withOld).toEqual({ ok: false, code: 'bad_credentials' });

    const withNew = await login({
      username: USERNAME,
      password: 'a brand new password',
      businessId: BUSINESS,
    });
    expect(withNew.ok).toBe(true);
  });
});
