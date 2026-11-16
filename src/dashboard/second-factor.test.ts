import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { createTestOwner, ownerLogin, owesVerify } from '../test/owner.js';
import { resetDatabase, testDb } from '../test/db.js';
import { currentStep, totpCode } from '../auth/totp.js';
import { decryptSecret, encryptSecret } from '../governance/secret-cipher.js';
import {
  login,
  LOCK_MINUTES,
  MAX_FAILED,
  setPassword,
  startSession,
  verifySession,
  verifySessionDetails,
} from './auth.js';
import {
  beginEnrolment,
  confirmEnrolment,
  isTrustedDevice,
  issueTrustedDevice,
  resetSecondFactor,
  revokeTrustedDevices,
  setPendingFactor,
  totpStatus,
  TotpAlreadyEnrolledError,
  TRUSTED_DEVICE_DAYS,
  verifySecondFactor,
} from './second-factor.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
const KEY = randomBytes(32);
const NOW = new Date('2026-11-16T10:00:00.000Z');

beforeEach(async () => {
  await resetDatabase();
  await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
});

afterAll(async () => {
  await closePool();
});

/** Enrols the owner at `NOW` and returns the plain secret. */
async function enrol(): Promise<string> {
  return withBusiness(BUSINESS, async (db) => {
    const { secretBase32 } = await beginEnrolment(db, USERNAME, KEY);
    const result = await confirmEnrolment(db, USERNAME, totpCode(secretBase32, currentStep(NOW)), KEY, NOW);
    expect(result).toBe('ok');
    return secretBase32;
  });
}

/** A six-digit code that is not the right one for any accepted step around `at`. */
function wrongCode(secret: string, at: Date): string {
  const step = currentStep(at);
  const valid = new Set([step - 1, step, step + 1].map((s) => totpCode(secret, s)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

describe('enrol and confirm', () => {
  it('starts not enrolled, enrols on a correct code, and refuses a second enrolment', async () => {
    expect(await withBusiness(BUSINESS, (db) => totpStatus(db, USERNAME))).toBe('not_enrolled');

    const secret = await withBusiness(BUSINESS, async (db) => {
      const { secretBase32 } = await beginEnrolment(db, USERNAME, KEY);
      expect(secretBase32).toMatch(/^[A-Z2-7]{32}$/);
      // Pending, not enrolled yet.
      expect(await totpStatus(db, USERNAME)).toBe('not_enrolled');
      return secretBase32;
    });

    const result = await withBusiness(BUSINESS, (db) =>
      confirmEnrolment(db, USERNAME, totpCode(secret, currentStep(NOW)), KEY, NOW),
    );
    expect(result).toBe('ok');
    expect(await withBusiness(BUSINESS, (db) => totpStatus(db, USERNAME))).toBe('enrolled');

    const { rows } = await testDb().query<{ totp_last_step: string; totp_enrolled_at: Date | null }>(
      `SELECT totp_last_step, totp_enrolled_at FROM dashboard_users WHERE business_id = $1 AND username = $2`,
      [BUSINESS, USERNAME],
    );
    expect(Number(rows[0]?.totp_last_step)).toBe(currentStep(NOW));
    expect(rows[0]?.totp_enrolled_at).not.toBeNull();

    await expect(withBusiness(BUSINESS, (db) => beginEnrolment(db, USERNAME, KEY))).rejects.toBeInstanceOf(
      TotpAlreadyEnrolledError,
    );
  });

  it('replaces the pending secret when enrolment is begun again', async () => {
    const first = await withBusiness(BUSINESS, (db) => beginEnrolment(db, USERNAME, KEY));
    const second = await withBusiness(BUSINESS, (db) => beginEnrolment(db, USERNAME, KEY));
    expect(second.secretBase32).not.toBe(first.secretBase32);
    // The first secret no longer confirms.
    const stale = await withBusiness(BUSINESS, (db) =>
      confirmEnrolment(db, USERNAME, totpCode(first.secretBase32, currentStep(NOW)), KEY, NOW),
    );
    expect(stale).toBe('bad_code');
  });

  it('beginning again (a page reload) does not lift an active lock', async () => {
    const { secretBase32 } = await withBusiness(BUSINESS, (db) => beginEnrolment(db, USERNAME, KEY));
    const wrong = wrongCode(secretBase32, NOW);
    for (let i = 0; i < MAX_FAILED; i += 1) {
      expect(await withBusiness(BUSINESS, (db) => confirmEnrolment(db, USERNAME, wrong, KEY, NOW))).toBe('bad_code');
    }
    const { secretBase32: fresh } = await withBusiness(BUSINESS, (db) => beginEnrolment(db, USERNAME, KEY));
    const { rows } = await testDb().query<{ totp_failed_attempts: number; totp_locked_until: Date | null }>(
      'SELECT totp_failed_attempts, totp_locked_until FROM dashboard_users WHERE business_id = $1 AND username = $2',
      [BUSINESS, USERNAME],
    );
    expect(rows[0]?.totp_failed_attempts).toBe(MAX_FAILED);
    expect(rows[0]?.totp_locked_until).not.toBeNull();
    const right = totpCode(fresh, currentStep(NOW));
    expect(await withBusiness(BUSINESS, (db) => confirmEnrolment(db, USERNAME, right, KEY, NOW))).toBe('locked');
  });

  it('beginning again does not reset the count of wrong codes either', async () => {
    const { secretBase32 } = await withBusiness(BUSINESS, (db) => beginEnrolment(db, USERNAME, KEY));
    for (let i = 0; i < MAX_FAILED - 1; i += 1) {
      await withBusiness(BUSINESS, (db) => confirmEnrolment(db, USERNAME, wrongCode(secretBase32, NOW), KEY, NOW));
    }
    const { secretBase32: fresh } = await withBusiness(BUSINESS, (db) => beginEnrolment(db, USERNAME, KEY));
    expect(
      await withBusiness(BUSINESS, (db) => confirmEnrolment(db, USERNAME, wrongCode(fresh, NOW), KEY, NOW)),
    ).toBe('bad_code');
    const right = totpCode(fresh, currentStep(NOW));
    expect(await withBusiness(BUSINESS, (db) => confirmEnrolment(db, USERNAME, right, KEY, NOW))).toBe('locked');
  });

  it('confirm without a pending secret is a bad code, not an exception', async () => {
    expect(await withBusiness(BUSINESS, (db) => confirmEnrolment(db, USERNAME, '123456', KEY, NOW))).toBe(
      'bad_code',
    );
  });

  it('verify before enrolment is not_enrolled, even with a pending secret', async () => {
    const { secretBase32 } = await withBusiness(BUSINESS, (db) => beginEnrolment(db, USERNAME, KEY));
    expect(
      await withBusiness(BUSINESS, (db) =>
        verifySecondFactor(db, USERNAME, totpCode(secretBase32, currentStep(NOW)), KEY, NOW),
      ),
    ).toBe('not_enrolled');
  });
});

describe('verifySecondFactor', () => {
  it('accepts the next code and rejects a replay of the code just used', async () => {
    const secret = await enrol();
    const later = new Date(NOW.getTime() + 60_000);
    const code = totpCode(secret, currentStep(later));
    expect(await withBusiness(BUSINESS, (db) => verifySecondFactor(db, USERNAME, code, KEY, later))).toBe('ok');
    expect(await withBusiness(BUSINESS, (db) => verifySecondFactor(db, USERNAME, code, KEY, later))).toBe(
      'bad_code',
    );
  });

  it('rejects the enrolment code itself (its step is already spent)', async () => {
    const secret = await enrol();
    expect(
      await withBusiness(BUSINESS, (db) =>
        verifySecondFactor(db, USERNAME, totpCode(secret, currentStep(NOW)), KEY, NOW),
      ),
    ).toBe('bad_code');
  });

  it('locks after the password-lock count of wrong codes, even for a correct code, until the lock expires', async () => {
    const secret = await enrol();
    const at = new Date(NOW.getTime() + 60_000);
    for (let i = 0; i < MAX_FAILED - 1; i += 1) {
      expect(
        await withBusiness(BUSINESS, (db) => verifySecondFactor(db, USERNAME, wrongCode(secret, at), KEY, at)),
      ).toBe('bad_code');
    }
    // The attempt that reaches the threshold still reads as a bad code; the
    // account is locked from the next one.
    expect(
      await withBusiness(BUSINESS, (db) => verifySecondFactor(db, USERNAME, wrongCode(secret, at), KEY, at)),
    ).toBe('bad_code');

    const right = totpCode(secret, currentStep(at));
    expect(await withBusiness(BUSINESS, (db) => verifySecondFactor(db, USERNAME, right, KEY, at))).toBe('locked');

    const afterLock = new Date(at.getTime() + LOCK_MINUTES * 60_000 + 1_000);
    expect(
      await withBusiness(BUSINESS, (db) =>
        verifySecondFactor(db, USERNAME, totpCode(secret, currentStep(afterLock)), KEY, afterLock),
      ),
    ).toBe('ok');
  });

  it('a corrupt stored secret is a bad code, never an exception', async () => {
    await enrol();
    await testDb().query(
      `UPDATE dashboard_users SET totp_ciphertext = $3 WHERE business_id = $1 AND username = $2`,
      [BUSINESS, USERNAME, randomBytes(40)],
    );
    const at = new Date(NOW.getTime() + 60_000);
    expect(await withBusiness(BUSINESS, (db) => verifySecondFactor(db, USERNAME, '123456', KEY, at))).toBe(
      'bad_code',
    );
  });

  it('a different key cannot open the secret (bad code)', async () => {
    const secret = await enrol();
    const at = new Date(NOW.getTime() + 60_000);
    expect(
      await withBusiness(BUSINESS, (db) =>
        verifySecondFactor(db, USERNAME, totpCode(secret, currentStep(at)), randomBytes(32), at),
      ),
    ).toBe('bad_code');
  });
});

describe('the secret at rest', () => {
  it('is not stored in clear, and is bound to its business in the AAD', async () => {
    const secret = await enrol();
    const { rows } = await testDb().query<{ totp_ciphertext: Buffer; totp_nonce: Buffer }>(
      `SELECT totp_ciphertext, totp_nonce FROM dashboard_users WHERE business_id = $1 AND username = $2`,
      [BUSINESS, USERNAME],
    );
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.totp_ciphertext.includes(Buffer.from(secret, 'utf8'))).toBe(false);

    const sealed = { ciphertext: row.totp_ciphertext, nonce: row.totp_nonce };
    expect(decryptSecret(sealed, KEY, { businessId: BUSINESS, ref: `totp:${USERNAME}` })).toBe(secret);
    expect(decryptSecret(sealed, KEY, { businessId: 'other-business', ref: `totp:${USERNAME}` })).toBeNull();
  });

  it('refuses a half-set secret at the schema level', async () => {
    await expect(
      testDb().query(
        `UPDATE dashboard_users SET totp_ciphertext = $3 WHERE business_id = $1 AND username = $2`,
        [BUSINESS, USERNAME, randomBytes(40)],
      ),
    ).rejects.toThrow();
  });
});

describe('trusted devices', () => {
  it('a fresh token is trusted; another token is not', async () => {
    const token = await withBusiness(BUSINESS, (db) => issueTrustedDevice(db, USERNAME, NOW));
    expect(await withBusiness(BUSINESS, (db) => isTrustedDevice(db, USERNAME, token, NOW))).toBe(true);
    expect(
      await withBusiness(BUSINESS, (db) => isTrustedDevice(db, USERNAME, randomBytes(32).toString('hex'), NOW)),
    ).toBe(false);
    expect(await withBusiness(BUSINESS, (db) => isTrustedDevice(db, 'someone-else', token, NOW))).toBe(false);
  });

  it('stores only the hash of the token', async () => {
    const token = await withBusiness(BUSINESS, (db) => issueTrustedDevice(db, USERNAME, NOW));
    const { rows } = await testDb().query<{ device_hash: string }>(
      `SELECT device_hash FROM dashboard_trusted_devices WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.device_hash).not.toContain(token);
  });

  it('is no longer trusted after resetSecondFactor', async () => {
    await enrol();
    const token = await withBusiness(BUSINESS, (db) => issueTrustedDevice(db, USERNAME, NOW));
    await withBusiness(BUSINESS, (db) => resetSecondFactor(db, USERNAME));
    expect(await withBusiness(BUSINESS, (db) => isTrustedDevice(db, USERNAME, token, NOW))).toBe(false);
  });

  it('is no longer trusted after setPassword', async () => {
    const token = await withBusiness(BUSINESS, (db) => issueTrustedDevice(db, USERNAME, NOW));
    await withBusiness(BUSINESS, (db) => setPassword(db, { username: USERNAME, password: 'a brand new password' }));
    expect(await withBusiness(BUSINESS, (db) => isTrustedDevice(db, USERNAME, token, NOW))).toBe(false);
  });

  it(`expires after ${TRUSTED_DEVICE_DAYS} days`, async () => {
    expect(TRUSTED_DEVICE_DAYS).toBe(30);
    const token = await withBusiness(BUSINESS, (db) => issueTrustedDevice(db, USERNAME, NOW));
    const later = new Date(NOW.getTime() + 31 * 86_400_000);
    expect(await withBusiness(BUSINESS, (db) => isTrustedDevice(db, USERNAME, token, later))).toBe(false);
  });

  it("one account's device does not satisfy another account of the same business", async () => {
    await createTestOwner(BUSINESS, { username: 'second', password: PASSWORD });
    const ofOwner = await withBusiness(BUSINESS, (db) => issueTrustedDevice(db, USERNAME, NOW));
    const ofSecond = await withBusiness(BUSINESS, (db) => issueTrustedDevice(db, 'second', NOW));
    expect(await withBusiness(BUSINESS, (db) => isTrustedDevice(db, 'second', ofOwner, NOW))).toBe(false);
    expect(await withBusiness(BUSINESS, (db) => isTrustedDevice(db, USERNAME, ofSecond, NOW))).toBe(false);
    expect(await withBusiness(BUSINESS, (db) => isTrustedDevice(db, USERNAME, ofOwner, NOW))).toBe(true);
    expect(await withBusiness(BUSINESS, (db) => isTrustedDevice(db, 'second', ofSecond, NOW))).toBe(true);
  });

  it('revokeTrustedDevices returns how many it revoked', async () => {
    await withBusiness(BUSINESS, (db) => issueTrustedDevice(db, USERNAME, NOW));
    await withBusiness(BUSINESS, (db) => issueTrustedDevice(db, USERNAME, NOW));
    expect(await withBusiness(BUSINESS, (db) => revokeTrustedDevices(db, USERNAME))).toBe(2);
    expect(await withBusiness(BUSINESS, (db) => revokeTrustedDevices(db, USERNAME))).toBe(0);
  });
});

describe('resetSecondFactor', () => {
  it('clears enrolment and revokes an open session', async () => {
    await enrol();
    const result = await withBusiness(BUSINESS, (db) =>
      login(db, { pendingFactorFor: owesVerify, login: ownerLogin(BUSINESS, USERNAME), password: PASSWORD }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const token = result.sessionId;
    expect(await withBusiness(BUSINESS, (db) => verifySession(db, token))).not.toBeNull();

    await withBusiness(BUSINESS, (db) => resetSecondFactor(db, USERNAME));

    expect(await withBusiness(BUSINESS, (db) => verifySession(db, token))).toBeNull();
    expect(await withBusiness(BUSINESS, (db) => totpStatus(db, USERNAME))).toBe('not_enrolled');
    const { rows } = await testDb().query<Record<string, unknown>>(
      `SELECT totp_ciphertext, totp_nonce, totp_enrolled_at, totp_last_step, totp_failed_attempts, totp_locked_until
         FROM dashboard_users WHERE business_id = $1 AND username = $2`,
      [BUSINESS, USERNAME],
    );
    expect(rows[0]).toEqual({
      totp_ciphertext: null,
      totp_nonce: null,
      totp_enrolled_at: null,
      totp_last_step: null,
      totp_failed_attempts: 0,
      totp_locked_until: null,
    });
  });
});

describe('the pending factor on a session', () => {
  it('is carried by startSession, read by verifySessionDetails, and cleared by setPendingFactor', async () => {
    const token = await withBusiness(BUSINESS, (db) => startSession(db, USERNAME, { pendingFactor: 'enroll' }));
    expect((await withBusiness(BUSINESS, (db) => verifySessionDetails(db, token)))?.pendingFactor).toBe('enroll');

    await withBusiness(BUSINESS, (db) => setPendingFactor(db, token, 'verify'));
    expect((await withBusiness(BUSINESS, (db) => verifySessionDetails(db, token)))?.pendingFactor).toBe('verify');

    await withBusiness(BUSINESS, (db) => setPendingFactor(db, token, null));
    expect((await withBusiness(BUSINESS, (db) => verifySessionDetails(db, token)))?.pendingFactor).toBeNull();
  });

  it('has no default: a session that owes nothing must say so, and a call without it mints nothing', async () => {
    const token = await withBusiness(BUSINESS, (db) => startSession(db, USERNAME, { pendingFactor: null }));
    expect((await withBusiness(BUSINESS, (db) => verifySessionDetails(db, token)))?.pendingFactor).toBeNull();

    await testDb().query('DELETE FROM dashboard_sessions WHERE business_id = $1', [BUSINESS]);
    await expect(
      withBusiness(BUSINESS, (db) =>
        // @ts-expect-error — pendingFactor is required; omitting it must not compile.
        startSession(db, USERNAME, {}),
      ),
    ).rejects.toThrow(/pendingFactor is required/);
    const { rows } = await testDb().query('SELECT 1 FROM dashboard_sessions WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });
});

/**
 * Hold the owner's row with `FOR UPDATE` on a migrator connection, start
 * `act` (whose final UPDATE then blocks on the row lock), run `meanwhile`
 * on the locking connection and commit. The blocked UPDATE re-checks its
 * WHERE against the row as `meanwhile` left it — exactly the window between
 * `loadTotp` and `acceptStep` that a concurrent request could land in.
 */
async function interleave<T>(
  act: () => Promise<T>,
  meanwhile: (q: (sql: string, params: unknown[]) => Promise<unknown>) => Promise<void>,
): Promise<T> {
  const client = await testDb().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT 1 FROM dashboard_users WHERE business_id = $1 AND username = $2 FOR UPDATE`,
      [BUSINESS, USERNAME],
    );
    const pending = act();
    // Wait until the act's UPDATE is actually waiting on our row lock.
    for (let i = 0; ; i += 1) {
      const { rows } = await testDb().query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_locks WHERE NOT granted`,
      );
      if (Number(rows[0]?.n ?? 0) > 0) break;
      if (i > 200) throw new Error('interleave: the act never blocked on the row lock');
      await new Promise((r) => setTimeout(r, 10));
    }
    await meanwhile((sql, params) => client.query(sql, params));
    await client.query('COMMIT');
    return await pending;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe('accepting a step is bound to what was read', () => {
  it('a confirm with an old pending secret cannot enrol a newer one written in between', async () => {
    const { secretBase32: old } = await withBusiness(BUSINESS, (db) => beginEnrolment(db, USERNAME, KEY));
    const fresh = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const sealed = encryptSecret(fresh, KEY, { businessId: BUSINESS, ref: `totp:${USERNAME}` });

    const result = await interleave(
      () => withBusiness(BUSINESS, (db) => confirmEnrolment(db, USERNAME, totpCode(old, currentStep(NOW)), KEY, NOW)),
      async (q) => {
        await q(
          `UPDATE dashboard_users SET totp_ciphertext = $3, totp_nonce = $4, totp_last_step = NULL
            WHERE business_id = $1 AND username = $2`,
          [BUSINESS, USERNAME, sealed.ciphertext, sealed.nonce],
        );
      },
    );
    expect(result).toBe('bad_code');
    expect(await withBusiness(BUSINESS, (db) => totpStatus(db, USERNAME))).toBe('not_enrolled');
  });

  it('a correct code does not get through a lock set in between', async () => {
    const secret = await enrol();
    const at = new Date(NOW.getTime() + 60_000);
    const result = await interleave(
      () => withBusiness(BUSINESS, (db) => verifySecondFactor(db, USERNAME, totpCode(secret, currentStep(at)), KEY, at)),
      async (q) => {
        await q(
          `UPDATE dashboard_users SET totp_failed_attempts = $3, totp_locked_until = $4
            WHERE business_id = $1 AND username = $2`,
          [BUSINESS, USERNAME, MAX_FAILED, new Date(at.getTime() + LOCK_MINUTES * 60_000)],
        );
      },
    );
    expect(result).not.toBe('ok');
    const { rows } = await testDb().query<{ totp_last_step: string | null }>(
      `SELECT totp_last_step FROM dashboard_users WHERE business_id = $1 AND username = $2`,
      [BUSINESS, USERNAME],
    );
    // The step was not spent by the refused attempt.
    expect(Number(rows[0]?.totp_last_step)).toBe(currentStep(NOW));
  });

  it('two concurrent verifications with the same valid code: exactly one is ok', async () => {
    const secret = await enrol();
    const at = new Date(NOW.getTime() + 60_000);
    const code = totpCode(secret, currentStep(at));
    const results = await Promise.all([
      withBusiness(BUSINESS, (db) => verifySecondFactor(db, USERNAME, code, KEY, at)),
      withBusiness(BUSINESS, (db) => verifySecondFactor(db, USERNAME, code, KEY, at)),
    ]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'bad_code')).toHaveLength(1);
  });
});
