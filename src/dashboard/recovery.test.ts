import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { createOwner, login } from './auth.js';
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

  it('shares the login lockout: enough wrong codes lock out a correct one too', async () => {
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });

    for (let i = 0; i < 5; i += 1) {
      const result = await redeemRecoveryCode({
        username: USERNAME,
        code: '0'.repeat(32),
        businessId: BUSINESS,
      });
      expect(result).toEqual({ ok: false, code: 'no_match' });
    }

    const result = await redeemRecoveryCode({
      username: USERNAME,
      code: codes[0]!,
      businessId: BUSINESS,
    });
    expect(result).toEqual({ ok: false, code: 'no_match' });
  });

  it('a locked account also refuses a normal login', async () => {
    await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });

    for (let i = 0; i < 5; i += 1) {
      await redeemRecoveryCode({ username: USERNAME, code: '0'.repeat(32), businessId: BUSINESS });
    }

    const loginResult = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
    expect(loginResult).toEqual({ ok: false, code: 'locked' });
  });
});
