import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { createTestOwner, ownerLogin } from '../test/owner.js';
import { resetDatabase, testDb } from '../test/db.js';
import {
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
    await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  });

  it('logs in with the correct password', async () => {
    const result = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.sessionId).toBe('string');
      expect(result.sessionId.length).toBeGreaterThan(0);
    }
  });

  it('does not log in with the wrong password', async () => {
    const result = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: 'wrong password' }));
    expect(result).toEqual({ ok: false, code: 'bad_credentials' });
  });

  it('does not log in for a username that does not exist', async () => {
    const result = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, 'nobody'), password: PASSWORD }));
    expect(result).toEqual({ ok: false, code: 'bad_credentials' });
  });

  it('counts failures for a username that has no row, against the shared bucket', async () => {
    // The per-user UPDATE matches nothing when there is no row, so this
    // branch used to be an unthrottled scrypt call for anyone who could
    // reach the port. Its failures now land in
    // dashboard_unknown_user_throttle instead.
    for (let i = 0; i < 5; i += 1) {
      const result = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, 'nobody'), password: PASSWORD }));
      expect(result).toEqual({ ok: false, code: 'bad_credentials' });
    }

    const { rows } = await testDb().query<{ failed_attempts: number; locked_until: Date | null }>(
      // One row for the whole server since migration 066.
      `SELECT failed_attempts, locked_until FROM dashboard_unknown_user_throttle`,
    );
    expect(rows[0]?.failed_attempts).toBe(5);
    expect(rows[0]?.locked_until).not.toBeNull();

    // Still `bad_credentials`, never a distinct code: whether a username
    // exists must not become readable from the reply.
    expect(await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, 'nobody'), password: PASSWORD }))).toEqual({
      ok: false,
      code: 'bad_credentials',
    });

    // And the real account is untouched by all of it.
    const real = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD }));
    expect(real.ok).toBe(true);
  });

  it('locks the account after five wrong attempts', async () => {
    for (let i = 0; i < 5; i += 1) {
      await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: 'wrong password' }));
    }
    const result = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: 'wrong password' }));
    expect(result).toEqual({ ok: false, code: 'locked' });
  });

  it('a locked account refuses even the correct password', async () => {
    for (let i = 0; i < 5; i += 1) {
      await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: 'wrong password' }));
    }
    const result = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD }));
    expect(result).toEqual({ ok: false, code: 'locked' });
  });

  it('the lock expires', async () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: 'wrong password', now: start }));
    }
    const stillLocked = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD, now: new Date(start.getTime() + 5 * 60_000) }));
    expect(stillLocked).toEqual({ ok: false, code: 'locked' });

    const afterCooldown = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD, now: new Date(start.getTime() + 16 * 60_000) }));
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
        withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: 'wrong password' })),
      ),
    );
    const result = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD }));
    expect(result).toEqual({ ok: false, code: 'locked' });
  });
});

describe('sessions', () => {
  beforeEach(async () => {
    await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  });

  it('verifies a fresh session', async () => {
    const result = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const verified = await withBusiness(BUSINESS, (db) => verifySession(db, result.sessionId));
    expect(verified).toEqual({ username: USERNAME });
  });

  it('does not verify a revoked session', async () => {
    const result = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const revokedCount = await withBusiness(BUSINESS, (db) => revokeAllSessions(db, USERNAME));
    expect(revokedCount).toBe(1);

    const verified = await withBusiness(BUSINESS, (db) => verifySession(db, result.sessionId));
    expect(verified).toBeNull();
  });

  it('does not verify an expired session', async () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    const result = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD, now: start }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const verified = await withBusiness(BUSINESS, (db) => verifySession(db, result.sessionId, { now: new Date(start.getTime() + 13 * 3600_000) }));
    expect(verified).toBeNull();
  });

  it('does not verify a session token that was never issued', async () => {
    const verified = await withBusiness(BUSINESS, (db) => verifySession(db, '0'.repeat(64)));
    expect(verified).toBeNull();
  });
});

describe('tenant isolation', () => {
  const OTHER_BUSINESS = 'test-business-other';

  it('a user in one business is invisible to a login under another', async () => {
    await createTestOwner(OTHER_BUSINESS, { username: USERNAME, password: PASSWORD });

    const result = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(OTHER_BUSINESS, USERNAME), password: PASSWORD }));
    expect(result).toEqual({ ok: false, code: 'bad_credentials' });
  });

  it('a session created under one business is invisible to a lookup under another', async () => {
    await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
    await createTestOwner(OTHER_BUSINESS, { username: USERNAME, password: PASSWORD });

    const result = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Same raw token, wrong tenant scope: must not resolve.
    expect(await withBusiness(OTHER_BUSINESS, (db) => verifySession(db, result.sessionId))).toBeNull();
    // Right tenant: still resolves.
    expect(await withBusiness(BUSINESS, (db) => verifySession(db, result.sessionId))).toEqual({
      username: USERNAME,
    });
  });
});

describe('setPassword', () => {
  beforeEach(async () => {
    await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  });

  it('revokes every open session', async () => {
    const first = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD }));
    const second = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    await withBusiness(BUSINESS, (db) => setPassword(db, { username: USERNAME, password: 'a brand new password' }));

    expect(await withBusiness(BUSINESS, (db) => verifySession(db, first.sessionId))).toBeNull();
    expect(await withBusiness(BUSINESS, (db) => verifySession(db, second.sessionId))).toBeNull();
  });

  it('lets a subsequent login use the new password and rejects the old one', async () => {
    await withBusiness(BUSINESS, (db) => setPassword(db, { username: USERNAME, password: 'a brand new password' }));

    const withOld = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD }));
    expect(withOld).toEqual({ ok: false, code: 'bad_credentials' });

    const withNew = await withBusiness(BUSINESS, (db) => login(db, { login: ownerLogin(BUSINESS, USERNAME), password: 'a brand new password' }));
    expect(withNew.ok).toBe(true);
  });
});
