import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { createOwner, login, setPassword } from './auth.js';
import { issueRecoveryCodes, redeemRecoveryCode, remainingCodes } from './recovery.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

beforeEach(async () => {
  await resetDatabase();
  await createOwner({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
});

afterAll(async () => {
  await closePool();
});

describe('issueRecoveryCodes', () => {
  it('issues eight codes and returns them once, each unique', async () => {
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
  });

  it('does not store the code in plaintext, nor any prefix of it', async () => {
    const [code] = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS, count: 1 });
    expect(code).toBeDefined();

    const { rows } = await getPool().query<{ code_hash: string; code_salt: string }>(
      `SELECT code_hash, code_salt FROM dashboard_recovery_codes
        WHERE business_id = $1 AND username = $2`,
      [BUSINESS, USERNAME],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row.code_hash).not.toBe(code);
    expect(row.code_hash).not.toContain(code);
    expect(code).not.toContain(row.code_hash);
    for (let i = 8; i <= code!.length; i += 8) {
      expect(row.code_hash).not.toContain(code!.slice(0, i));
    }
  });

  it('re-issuing voids every older code', async () => {
    const first = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    const firstCode = first[0]!;

    await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });

    const result = await redeemRecoveryCode({
      username: USERNAME,
      code: firstCode,
      businessId: BUSINESS,
    });
    expect(result).toEqual({ ok: false, code: 'no_match' });
  });

  it('a fresh set redeems fine after re-issuing', async () => {
    await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    const second = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });

    const result = await redeemRecoveryCode({
      username: USERNAME,
      code: second[0]!,
      businessId: BUSINESS,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('remainingCodes', () => {
  it('counts only unused codes', async () => {
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    expect(await remainingCodes(USERNAME, { businessId: BUSINESS })).toBe(8);

    await redeemRecoveryCode({ username: USERNAME, code: codes[0]!, businessId: BUSINESS });
    expect(await remainingCodes(USERNAME, { businessId: BUSINESS })).toBe(7);
  });

  it('is zero for an account with no codes issued', async () => {
    expect(await remainingCodes(USERNAME, { businessId: BUSINESS })).toBe(0);
  });
});

describe('redeemRecoveryCode', () => {
  it('redeems a valid code', async () => {
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    const result = await redeemRecoveryCode({
      username: USERNAME,
      code: codes[3]!,
      businessId: BUSINESS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('refuses the same code a second time', async () => {
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    const code = codes[0]!;

    const first = await redeemRecoveryCode({ username: USERNAME, code, businessId: BUSINESS });
    expect(first).toEqual({ ok: true });

    const second = await redeemRecoveryCode({ username: USERNAME, code, businessId: BUSINESS });
    expect(second).toEqual({ ok: false, code: 'already_used' });
  });

  it('refuses a code that was never issued', async () => {
    await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    const result = await redeemRecoveryCode({
      username: USERNAME,
      code: '0'.repeat(32),
      businessId: BUSINESS,
    });
    expect(result).toEqual({ ok: false, code: 'no_match' });
  });

  it('lets exactly one of two concurrent redemptions of the same code through', async () => {
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    const code = codes[0]!;

    const [first, second] = await Promise.all([
      redeemRecoveryCode({ username: USERNAME, code, businessId: BUSINESS }),
      redeemRecoveryCode({ username: USERNAME, code, businessId: BUSINESS }),
    ]);

    const results = [first, second];
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual({ ok: false, code: 'already_used' });
  });

  it('revokes every open session on redemption', async () => {
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });

    const first = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    const second = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const { rows: beforeRows } = await getPool().query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM dashboard_sessions WHERE business_id = $1 AND username = $2`,
      [BUSINESS, USERNAME],
    );
    expect(beforeRows).toHaveLength(2);
    expect(beforeRows.every((r) => r.revoked_at === null)).toBe(true);

    await redeemRecoveryCode({ username: USERNAME, code: codes[0]!, businessId: BUSINESS });

    const { rows: afterRows } = await getPool().query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM dashboard_sessions WHERE business_id = $1 AND username = $2`,
      [BUSINESS, USERNAME],
    );
    expect(afterRows).toHaveLength(2);
    expect(afterRows.every((r) => r.revoked_at !== null)).toBe(true);
  });

  it('appends an audit entry naming the source address on redemption', async () => {
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });

    await redeemRecoveryCode({
      username: USERNAME,
      code: codes[0]!,
      businessId: BUSINESS,
      sourceAddress: '203.0.113.42',
    });

    const { rows } = await getPool().query<{ kind: string; reason: string }>(
      `SELECT kind, reason FROM audit_log WHERE business_id = $1 ORDER BY seq DESC LIMIT 1`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.kind).toBe('incident');
    expect(entry.reason).toContain('203.0.113.42');
    expect(entry.reason).toContain(USERNAME);
  });

  it('does not audit a failed redemption', async () => {
    await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    await redeemRecoveryCode({
      username: USERNAME,
      code: '0'.repeat(32),
      businessId: BUSINESS,
    });

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('exhausting the recovery budget leaves password login working', async () => {
    // Recovery's own threshold (RECOVERY_MAX_FAILED = 10 in recovery.ts) is
    // deliberately not password login's (MAX_FAILED = 5 in auth.ts) — walk
    // past the recovery threshold and confirm login is untouched by it.
    for (let i = 0; i < 10; i += 1) {
      const result = await redeemRecoveryCode({
        username: USERNAME,
        code: '0'.repeat(32),
        businessId: BUSINESS,
      });
      expect(result).toEqual({ ok: false, code: 'no_match' });
    }

    const loginResult = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(loginResult.ok).toBe(true);
  });

  it('exhausting the password budget leaves recovery redemption working', async () => {
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });

    for (let i = 0; i < 5; i += 1) {
      const result = await login({ username: USERNAME, password: 'wrong password', businessId: BUSINESS });
      expect(result).toEqual({ ok: false, code: 'bad_credentials' });
    }
    const locked = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(locked).toEqual({ ok: false, code: 'locked' });

    const result = await redeemRecoveryCode({
      username: USERNAME,
      code: codes[0]!,
      businessId: BUSINESS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('recovery still locks after its own threshold', async () => {
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });

    for (let i = 0; i < 10; i += 1) {
      const result = await redeemRecoveryCode({
        username: USERNAME,
        code: '0'.repeat(32),
        businessId: BUSINESS,
      });
      expect(result).toEqual({ ok: false, code: 'no_match' });
    }

    // The recovery budget is now spent — even a genuinely valid code refuses.
    const result = await redeemRecoveryCode({
      username: USERNAME,
      code: codes[0]!,
      businessId: BUSINESS,
    });
    expect(result).toEqual({ ok: false, code: 'no_match' });
  });

  // Before the shared bucket existed, `recordFailedAttempt` was an UPDATE
  // against `dashboard_users` — which matches nothing for a username that has
  // no row. The counter never moved, the lock never engaged, and every
  // request bought up to eight scrypt calls from the server for free. The
  // decoy calls are deliberate and stay; what must not stay is their being
  // unbounded.
  it('throttles a username that has no row at all', async () => {
    const unknownBucket = async () => {
      const { rows } = await getPool().query<{
        recovery_failed_attempts: number;
        recovery_locked_until: Date | null;
      }>(
        `SELECT recovery_failed_attempts, recovery_locked_until
           FROM dashboard_unknown_user_throttle WHERE business_id = $1`,
        [BUSINESS],
      );
      return rows[0] ?? null;
    };

    expect(await unknownBucket()).toBeNull();

    for (let i = 0; i < 10; i += 1) {
      const result = await redeemRecoveryCode({
        username: 'nobody-by-that-name',
        code: '0'.repeat(32),
        businessId: BUSINESS,
      });
      expect(result).toEqual({ ok: false, code: 'no_match' });
    }

    const bucket = await unknownBucket();
    expect(bucket?.recovery_failed_attempts).toBe(10);
    expect(bucket?.recovery_locked_until).not.toBeNull();

    // Locked: the next attempt refuses before any hash is computed, which is
    // the whole point — the cost stops being available.
    const after = await redeemRecoveryCode({
      username: 'nobody-by-that-name',
      code: '0'.repeat(32),
      businessId: BUSINESS,
    });
    expect(after).toEqual({ ok: false, code: 'no_match' });
    expect((await unknownBucket())?.recovery_failed_attempts).toBe(10);
  });

  it('cannot be used to lock the real owner out of recovery', async () => {
    // The shared bucket must not become a denial-of-service on the account
    // it protects: the real username has a row of its own and spends its own
    // budget, so no amount of traffic aimed at names that do not exist can
    // touch it.
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });

    for (let i = 0; i < 15; i += 1) {
      await redeemRecoveryCode({
        username: `nobody-${i}`,
        code: '0'.repeat(32),
        businessId: BUSINESS,
      });
    }

    const result = await redeemRecoveryCode({
      username: USERNAME,
      code: codes[0]!,
      businessId: BUSINESS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('a successful redemption clears the password lockout too, immediately', async () => {
    // The whole point of recovery codes is to get back in when the password
    // is the thing that's gone wrong. If redeeming one didn't also clear
    // login's own lock, an owner who fat-fingered their password five times
    // would redeem a code, set a new password, and still sit locked out for
    // whatever's left of the fifteen-minute window — the escape hatch would
    // complete and leave them exactly where they started.
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });

    for (let i = 0; i < 5; i += 1) {
      await login({ username: USERNAME, password: 'wrong password', businessId: BUSINESS });
    }
    const locked = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(locked).toEqual({ ok: false, code: 'locked' });

    const redeemed = await redeemRecoveryCode({
      username: USERNAME,
      code: codes[0]!,
      businessId: BUSINESS,
    });
    expect(redeemed).toEqual({ ok: true });

    const newPassword = 'a brand new recovered password';
    await setPassword({ username: USERNAME, password: newPassword, businessId: BUSINESS });

    // No waiting out the lock: immediate success, same tick.
    const loginResult = await login({ username: USERNAME, password: newPassword, businessId: BUSINESS });
    expect(loginResult.ok).toBe(true);
  });
});
