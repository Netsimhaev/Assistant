import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool, withPlatform } from '../db/platform-pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { currentStep, totpCode } from '../auth/totp.js';
import { LOCK_MINUTES, MAX_FAILED } from '../auth/password.js';
import { LINK_HOURS, SESSION_HOURS, TRUSTED_DEVICE_DAYS } from '../auth/lifetimes.js';
import { decryptSecret, encryptSecret } from '../governance/secret-cipher.js';
import {
  createHeadStaff,
  inviteStaff,
  isStaffDevice,
  issueStaffDevice,
  listStaff,
  redeemStaffLink,
  removeStaff,
  revokeStaffSession,
  rotateStaffSession,
  setStaffPendingFactor,
  staffBeginEnrolment,
  staffConfirmEnrolment,
  StaffError,
  staffLogin,
  staffResetSecondFactor,
  StaffTotpAlreadyEnrolledError,
  staffTotpStatus,
  staffVerifySecondFactor,
  startStaffSession,
  verifyStaffSession,
} from './staff.js';
import { logStaffAction, recentStaffActions, STAFF_ACTIONS } from './activity-log.js';

const KEY = randomBytes(32);
const NOW = new Date('2026-11-16T10:00:00.000Z');
const HEAD_LOGIN = 'Head@Company.example';
const HEAD_PASSWORD = 'head password long enough';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

async function head(): Promise<string> {
  return createHeadStaff({ login: HEAD_LOGIN, displayName: 'ראש צוות', password: HEAD_PASSWORD });
}

/** Invite and redeem a non-head colleague; returns their id. */
async function colleague(by: string, login = 'tech@company.example'): Promise<string> {
  const { staffId, token } = await inviteStaff({ login, displayName: 'טכנאי', issuedBy: by });
  const redeemed = await redeemStaffLink({ rawToken: token, typedLogin: login, password: 'tech password long' });
  expect(redeemed).toEqual({ ok: true, staffId });
  return staffId;
}

/** Enrol `staffId` at `NOW` and return the plain secret. */
async function enrol(staffId: string): Promise<string> {
  const { secretBase32 } = await staffBeginEnrolment(staffId, KEY);
  expect(await staffConfirmEnrolment(staffId, totpCode(secretBase32, currentStep(NOW)), KEY, NOW)).toBe('ok');
  return secretBase32;
}

function wrongCode(secret: string, at: Date): string {
  const step = currentStep(at);
  const valid = new Set([step - 1, step, step + 1].map((s) => totpCode(secret, s)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

describe('head staff', () => {
  it('creates the head, who logs in by the normalised address', async () => {
    const id = await head();
    expect(await staffLogin({ login: 'head@company.example', password: HEAD_PASSWORD })).toEqual({
      ok: true,
      staffId: id,
    });
    const all = await listStaff();
    expect(all).toEqual([
      {
        staffId: id,
        displayName: 'ראש צוות',
        login: 'head@company.example',
        isHead: true,
        enrolled: false,
        removed: false,
      },
    ]);
    // Only the scrypt hash is stored.
    const { rows } = await testDb().query<{ password_hash: string }>('SELECT password_hash FROM platform_staff');
    expect(rows[0]?.password_hash).not.toContain(HEAD_PASSWORD);
  });

  it('refuses a second head while one exists', async () => {
    await head();
    await expect(
      createHeadStaff({ login: 'other@company.example', displayName: 'אחר', password: HEAD_PASSWORD }),
    ).rejects.toThrow(StaffError);
    expect(await listStaff()).toHaveLength(1);
  });

  it('refuses a weak password and a malformed address', async () => {
    await expect(createHeadStaff({ login: HEAD_LOGIN, displayName: 'x', password: 'short' })).rejects.toThrow(
      StaffError,
    );
    await expect(
      createHeadStaff({ login: 'not-an-email', displayName: 'x', password: HEAD_PASSWORD }),
    ).rejects.toThrow(StaffError);
    expect(await listStaff()).toHaveLength(0);
  });
});

describe('login', () => {
  it('wrong password counts, and the fifth locks even the right one', async () => {
    await head();
    for (let i = 0; i < MAX_FAILED; i += 1) {
      expect(await staffLogin({ login: HEAD_LOGIN, password: 'wrong', now: NOW })).toEqual({
        ok: false,
        code: 'bad_credentials',
      });
    }
    expect(await staffLogin({ login: HEAD_LOGIN, password: HEAD_PASSWORD, now: NOW })).toEqual({
      ok: false,
      code: 'locked',
    });
    const later = new Date(NOW.getTime() + LOCK_MINUTES * 60_000 + 1000);
    expect((await staffLogin({ login: HEAD_LOGIN, password: HEAD_PASSWORD, now: later })).ok).toBe(true);
  });

  it('an unknown address and an invited-but-unredeemed one are bad_credentials', async () => {
    const id = await head();
    expect(await staffLogin({ login: 'nobody@company.example', password: 'x' })).toEqual({
      ok: false,
      code: 'bad_credentials',
    });
    await inviteStaff({ login: 'pending@company.example', displayName: 'ממתין', issuedBy: id });
    expect(await staffLogin({ login: 'pending@company.example', password: '' })).toEqual({
      ok: false,
      code: 'bad_credentials',
    });
  });
});

describe('invite links', () => {
  it('redeems once, with the address typed in another letter case', async () => {
    const h = await head();
    const { staffId, token } = await inviteStaff({
      login: 'tech@company.example',
      displayName: 'טכנאי',
      issuedBy: h,
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const ok = await redeemStaffLink({ rawToken: token, typedLogin: 'TECH@Company.Example ', password: 'tech pass long' });
    expect(ok).toEqual({ ok: true, staffId });
    expect(await redeemStaffLink({ rawToken: token, typedLogin: 'tech@company.example', password: 'tech pass long' }))
      .toEqual({ ok: false, code: 'used' });
    expect((await staffLogin({ login: 'tech@company.example', password: 'tech pass long' })).ok).toBe(true);
    // Only the hash of the link is stored.
    const { rows } = await testDb().query<{ link_hash: string; issued_by: string }>(
      'SELECT link_hash, issued_by FROM platform_staff_links',
    );
    expect(rows[0]?.link_hash).not.toBe(token);
    expect(rows[0]?.issued_by).toBe(h);
  });

  it('a different address is login_mismatch and leaves the link unused', async () => {
    const h = await head();
    const { token } = await inviteStaff({ login: 'tech@company.example', displayName: 'ט', issuedBy: h });
    expect(await redeemStaffLink({ rawToken: token, typedLogin: 'other@company.example', password: 'tech pass long' }))
      .toEqual({ ok: false, code: 'login_mismatch' });
    expect(await redeemStaffLink({ rawToken: token, typedLogin: 'tech@company.example', password: 'short' })).toEqual({
      ok: false,
      code: 'weak_password',
    });
    expect((await redeemStaffLink({ rawToken: token, typedLogin: 'tech@company.example', password: 'tech pass long' })).ok)
      .toBe(true);
  });

  it('refuses an expired link and an unknown token', async () => {
    const h = await head();
    const { token } = await inviteStaff({ login: 'tech@company.example', displayName: 'ט', issuedBy: h }, NOW);
    const late = new Date(NOW.getTime() + LINK_HOURS * 3600_000 + 1000);
    expect(
      await redeemStaffLink({ rawToken: token, typedLogin: 'tech@company.example', password: 'tech pass long' }, late),
    ).toEqual({ ok: false, code: 'expired' });
    expect(
      await redeemStaffLink({ rawToken: 'f'.repeat(64), typedLogin: 'tech@company.example', password: 'tech pass long' }),
    ).toEqual({ ok: false, code: 'invalid' });
    expect(await redeemStaffLink({ rawToken: 'nonsense', typedLogin: 'x', password: 'tech pass long' })).toEqual({
      ok: false,
      code: 'invalid',
    });
  });

  it('only a live head invites', async () => {
    const h = await head();
    const tech = await colleague(h);
    await expect(inviteStaff({ login: 'third@company.example', displayName: 'ג', issuedBy: tech })).rejects.toThrow(
      StaffError,
    );
    await expect(inviteStaff({ login: HEAD_LOGIN, displayName: 'כפול', issuedBy: h })).rejects.toThrow(StaffError);
  });
});

describe('sessions', () => {
  it('a session carries who, whether head, and the factor it owes; pendingFactor is required', async () => {
    const id = await head();
    const token = await startStaffSession(id, { pendingFactor: 'enroll', now: NOW });
    expect(await verifyStaffSession(token, { now: NOW })).toEqual({
      staffId: id,
      displayName: 'ראש צוות',
      isHead: true,
      pendingFactor: 'enroll',
    });
    await setStaffPendingFactor(token, null);
    expect((await verifyStaffSession(token, { now: NOW }))?.pendingFactor).toBeNull();
    const after = new Date(NOW.getTime() + SESSION_HOURS * 3600_000 + 1);
    expect(await verifyStaffSession(token, { now: after })).toBeNull();
    // Only the hash of the token is stored.
    const { rows } = await testDb().query<{ session_hash: string }>('SELECT session_hash FROM platform_staff_sessions');
    expect(rows.map((r) => r.session_hash)).not.toContain(token);

    await expect(
      startStaffSession(id, {} as unknown as Parameters<typeof startStaffSession>[1]),
    ).rejects.toThrow(TypeError);
  });

  it('rotation revokes the old token and mints a new one with the factor settled', async () => {
    const id = await head();
    const old = await startStaffSession(id, { pendingFactor: 'verify' });
    const fresh = await rotateStaffSession(old, { pendingFactor: null });
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(old);
    expect(await verifyStaffSession(old)).toBeNull();
    expect((await verifyStaffSession(fresh as string))?.pendingFactor).toBeNull();
    // A dead token rotates into nothing.
    expect(await rotateStaffSession(old, { pendingFactor: null })).toBeNull();
    await revokeStaffSession(fresh as string);
    expect(await verifyStaffSession(fresh as string)).toBeNull();
  });
});

describe('second factor', () => {
  it('enrols, verifies, and rejects a replay of the code just used', async () => {
    const id = await head();
    expect(await staffTotpStatus(id)).toBe('not_enrolled');
    const secret = await enrol(id);
    expect(await staffTotpStatus(id)).toBe('enrolled');
    await expect(staffBeginEnrolment(id, KEY)).rejects.toThrow(StaffTotpAlreadyEnrolledError);

    const next = new Date(NOW.getTime() + 30_000);
    const code = totpCode(secret, currentStep(next));
    expect(await staffVerifySecondFactor(id, code, KEY, next)).toBe('ok');
    // Same code, same window: a replay.
    expect(await staffVerifySecondFactor(id, code, KEY, next)).toBe('bad_code');
    // The enrolment code was spent too.
    expect(await staffVerifySecondFactor(id, totpCode(secret, currentStep(NOW)), KEY, next)).toBe('bad_code');
  });

  it('accepts ±1 step and refuses ±2', async () => {
    const id = await head();
    const secret = await enrol(id);
    const at = new Date(NOW.getTime() + 10 * 30_000);
    const s = currentStep(at);
    expect(await staffVerifySecondFactor(id, totpCode(secret, s + 2), KEY, at)).toBe('bad_code');
    expect(await staffVerifySecondFactor(id, totpCode(secret, s - 1), KEY, at)).toBe('ok');
    expect(await staffVerifySecondFactor(id, totpCode(secret, s + 1), KEY, at)).toBe('ok');
  });

  it('of concurrent verifies with the same code exactly one is ok', async () => {
    const id = await head();
    const secret = await enrol(id);
    const at = new Date(NOW.getTime() + 60_000);
    const code = totpCode(secret, currentStep(at));
    // Hold the row so every request reads the same state and then queues on
    // its UPDATE: only the conditional write can tell them apart.
    const holder = await testDb().connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM platform_staff WHERE staff_id = $1 FOR UPDATE', [id]);
      const pending = Promise.all(Array.from({ length: 3 }, () => staffVerifySecondFactor(id, code, KEY, at)));
      await new Promise((resolve) => setTimeout(resolve, 500));
      await holder.query('COMMIT');
      const results = await pending;
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    } finally {
      holder.release();
    }
  });

  it('locks after MAX_FAILED wrong codes, and the right code is refused while locked', async () => {
    const id = await head();
    const secret = await enrol(id);
    const at = new Date(NOW.getTime() + 60_000);
    for (let i = 0; i < MAX_FAILED; i += 1) {
      expect(await staffVerifySecondFactor(id, wrongCode(secret, at), KEY, at)).toBe('bad_code');
    }
    expect(await staffVerifySecondFactor(id, totpCode(secret, currentStep(at)), KEY, at)).toBe('locked');
    const later = new Date(at.getTime() + LOCK_MINUTES * 60_000 + 31_000);
    expect(await staffVerifySecondFactor(id, totpCode(secret, currentStep(later)), KEY, later)).toBe('ok');
  });

  it('beginning enrolment again does not clear an active lock', async () => {
    const id = await head();
    const { secretBase32 } = await staffBeginEnrolment(id, KEY);
    for (let i = 0; i < MAX_FAILED; i += 1) {
      expect(await staffConfirmEnrolment(id, wrongCode(secretBase32, NOW), KEY, NOW)).toBe('bad_code');
    }
    const again = await staffBeginEnrolment(id, KEY);
    expect(
      await staffConfirmEnrolment(id, totpCode(again.secretBase32, currentStep(NOW)), KEY, NOW),
    ).toBe('locked');
  });

  it('a secret sealed for another staff member, or not base32, is bad_code — never a throw', async () => {
    const a = await head();
    const b = await colleague(a);
    await enrol(a);
    // Move a's sealed secret onto b's row: the AAD names a, so it does not open for b.
    await testDb().query(
      `UPDATE platform_staff SET (totp_ciphertext, totp_nonce, totp_enrolled_at) =
         (SELECT totp_ciphertext, totp_nonce, totp_enrolled_at FROM platform_staff WHERE staff_id = $1)
        WHERE staff_id = $2`,
      [a, b],
    );
    expect(await staffVerifySecondFactor(b, '123456', KEY, NOW)).toBe('bad_code');

    // A secret that opens but is not base32.
    const sealed = encryptSecret('not base32 !!', KEY, { businessId: '', ref: `staff-totp:${b}` });
    await testDb().query('UPDATE platform_staff SET totp_ciphertext = $1, totp_nonce = $2 WHERE staff_id = $3', [
      sealed.ciphertext,
      sealed.nonce,
      b,
    ]);
    expect(await staffVerifySecondFactor(b, '123456', KEY, NOW)).toBe('bad_code');
  });

  it('seals the secret under staff-totp:<staffId> with an empty business', async () => {
    const id = await head();
    const { secretBase32 } = await staffBeginEnrolment(id, KEY);
    const { rows } = await testDb().query<{ totp_ciphertext: Buffer; totp_nonce: Buffer }>(
      'SELECT totp_ciphertext, totp_nonce FROM platform_staff WHERE staff_id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) throw new Error('no row');
    const sealed = { ciphertext: row.totp_ciphertext, nonce: row.totp_nonce };
    expect(decryptSecret(sealed, KEY, { businessId: '', ref: `staff-totp:${id}` })).toBe(secretBase32);
    expect(decryptSecret(sealed, KEY, { businessId: '', ref: `totp:${id}` })).toBeNull();
  });

  it('reset forgets the factor and revokes every session and device', async () => {
    const id = await head();
    await enrol(id);
    const token = await startStaffSession(id, { pendingFactor: null });
    const device = await issueStaffDevice(id, NOW);
    expect(await isStaffDevice(id, device, NOW)).toBe(true);
    await staffResetSecondFactor(id);
    expect(await staffTotpStatus(id)).toBe('not_enrolled');
    expect(await verifyStaffSession(token)).toBeNull();
    expect(await isStaffDevice(id, device, NOW)).toBe(false);
  });

  it('a device is bound to its staff member and expires', async () => {
    const a = await head();
    const b = await colleague(a);
    const device = await issueStaffDevice(a, NOW);
    expect(await isStaffDevice(b, device, NOW)).toBe(false);
    const late = new Date(NOW.getTime() + TRUSTED_DEVICE_DAYS * 86_400_000 + 1);
    expect(await isStaffDevice(a, device, late)).toBe(false);
    const { rows } = await testDb().query<{ device_hash: string }>('SELECT device_hash FROM platform_staff_devices');
    expect(rows.map((r) => r.device_hash)).not.toContain(device);
  });
});

describe('removal', () => {
  it('a removed staff member cannot log in, and their session and device are dead', async () => {
    const h = await head();
    const tech = await colleague(h);
    const token = await startStaffSession(tech, { pendingFactor: null });
    const device = await issueStaffDevice(tech, NOW);
    await removeStaff(tech, { by: h });
    expect(await staffLogin({ login: 'tech@company.example', password: 'tech password long' })).toEqual({
      ok: false,
      code: 'bad_credentials',
    });
    expect(await verifyStaffSession(token)).toBeNull();
    expect(await isStaffDevice(tech, device, NOW)).toBe(false);
    expect((await listStaff()).find((s) => s.staffId === tech)?.removed).toBe(true);
  });

  it('refuses to remove the last head, and refuses a remover who is not a head', async () => {
    const h = await head();
    const tech = await colleague(h);
    await expect(removeStaff(h, { by: h })).rejects.toThrow(StaffError);
    await expect(removeStaff(tech, { by: tech })).rejects.toThrow(StaffError);
    expect((await listStaff()).every((s) => !s.removed)).toBe(true);
  });
});

describe('activity log', () => {
  it('appends and lists the latest with the staff display name', async () => {
    const h = await head();
    await logStaffAction({ staffId: h, action: 'business_open', businessId: 'biz-one' });
    await logStaffAction({ staffId: h, action: 'staff_invited', businessId: null, detail: { count: 1 } });
    const recent = await recentStaffActions(10);
    expect(recent.map((r) => [r.action, r.businessId, r.staffDisplayName])).toEqual([
      ['staff_invited', null, 'ראש צוות'],
      ['business_open', 'biz-one', 'ראש צוות'],
    ]);
    expect(recent[0]?.at).toBeInstanceOf(Date);
    expect(STAFF_ACTIONS).toContain('totp_reset');
  });

  it('refuses an action outside the closed list', async () => {
    const h = await head();
    await expect(
      logStaffAction({ staffId: h, action: 'drop_tables' as never, businessId: null }),
    ).rejects.toThrow();
  });

  it('the platform pool cannot UPDATE or DELETE it', async () => {
    const h = await head();
    await logStaffAction({ staffId: h, action: 'business_open', businessId: 'biz-one' });
    await expect(withPlatform((db) => db.query("UPDATE platform_activity_log SET action = 'x'"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(withPlatform((db) => db.query('DELETE FROM platform_activity_log'))).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('grants', () => {
  it('the app account reaches none of the staff tables', async () => {
    for (const table of [
      'platform_staff',
      'platform_staff_sessions',
      'platform_staff_devices',
      'platform_staff_links',
      'platform_activity_log',
    ]) {
      await expect(withBusiness(TEST_BUSINESS, (db) => db.query(`SELECT 1 FROM ${table}`))).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});
