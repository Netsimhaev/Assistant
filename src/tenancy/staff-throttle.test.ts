/**
 * The panel's unknown-login bucket (migration 074) and the removed-member
 * guard on `issueStaffDevice`.
 *
 * `verifyPassword` is wrapped in a spy that still calls the real one, so a
 * test can tell "refused after paying scrypt" from "refused without it" — the
 * whole point of the bucket. A timing assertion would be flaky; counting calls
 * is not.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { LOCK_MINUTES, MAX_FAILED } from '../auth/password.js';

const spy = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../auth/password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/password.js')>();
  return {
    ...actual,
    verifyPassword: async (...args: Parameters<typeof actual.verifyPassword>) => {
      spy.calls += 1;
      return actual.verifyPassword(...args);
    },
  };
});

const { createHeadStaff, inviteStaff, issueStaffDevice, removeStaff, StaffError, staffLogin } = await import(
  './staff.js'
);

const NOW = new Date('2026-11-16T10:00:00.000Z');
const HEAD_LOGIN = 'head@company.example';
const HEAD_PASSWORD = 'head password long enough';

beforeEach(async () => {
  await resetDatabase();
  spy.calls = 0;
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

async function unknown(now = NOW): Promise<unknown> {
  return staffLogin({ login: 'nobody@nowhere.example', password: 'whatever it is', now });
}

describe('unknown-login throttle for staff', () => {
  it('pays scrypt up to the limit, then refuses without it', async () => {
    for (let i = 0; i < MAX_FAILED; i += 1) {
      expect(await unknown()).toEqual({ ok: false, code: 'bad_credentials' });
    }
    expect(spy.calls).toBe(MAX_FAILED);

    expect(await unknown()).toEqual({ ok: false, code: 'bad_credentials' });
    expect(await unknown()).toEqual({ ok: false, code: 'bad_credentials' });
    expect(spy.calls).toBe(MAX_FAILED);
  });

  it('opens again once the lock has expired', async () => {
    for (let i = 0; i < MAX_FAILED; i += 1) await unknown();
    const later = new Date(NOW.getTime() + LOCK_MINUTES * 60_000 + 1000);
    spy.calls = 0;
    expect(await unknown(later)).toEqual({ ok: false, code: 'bad_credentials' });
    expect(spy.calls).toBe(1);
  });

  it('counts removed and unredeemed members in the same bucket', async () => {
    const head = await createHeadStaff({ login: HEAD_LOGIN, displayName: 'ראש צוות', password: HEAD_PASSWORD });
    await inviteStaff({ login: 'invited@company.example', displayName: 'מוזמן', issuedBy: head });
    for (let i = 0; i < MAX_FAILED; i += 1) {
      await staffLogin({ login: 'invited@company.example', password: 'anything at all', now: NOW });
    }
    const { rows } = await testDb().query<{ failed_attempts: number }>(
      'SELECT failed_attempts FROM platform_staff_unknown_login_throttle',
    );
    expect(rows[0]?.failed_attempts).toBe(MAX_FAILED);
  });

  it('never locks a real member, and never touches the owner bucket', async () => {
    await createHeadStaff({ login: HEAD_LOGIN, displayName: 'ראש צוות', password: HEAD_PASSWORD });
    for (let i = 0; i < MAX_FAILED + 2; i += 1) await unknown();
    const ok = await staffLogin({ login: HEAD_LOGIN, password: HEAD_PASSWORD, now: NOW });
    expect(ok.ok).toBe(true);
    const owner = await testDb().query('SELECT 1 FROM dashboard_unknown_user_throttle');
    expect(owner.rows).toHaveLength(0);
  });

  it('is out of the app account’s reach', async () => {
    const { rows } = await testDb().query<{ ok: boolean }>(
      `SELECT has_table_privilege('assistant_app', 'platform_staff_unknown_login_throttle', 'SELECT') AS ok`,
    );
    expect(rows[0]?.ok).toBe(false);
  });
});

describe('issueStaffDevice', () => {
  it('writes no device row for a removed member', async () => {
    const head = await createHeadStaff({ login: HEAD_LOGIN, displayName: 'ראש צוות', password: HEAD_PASSWORD });
    const { staffId } = await inviteStaff({ login: 'tech@company.example', displayName: 'טכנאי', issuedBy: head });
    await removeStaff(staffId, { by: head });
    await expect(issueStaffDevice(staffId, NOW)).rejects.toThrow(StaffError);
    const { rows } = await testDb().query('SELECT 1 FROM platform_staff_devices WHERE staff_id = $1', [staffId]);
    expect(rows).toHaveLength(0);
  });

  it('writes no device row for an unknown member', async () => {
    await expect(issueStaffDevice('ST-NOPE', NOW)).rejects.toThrow(StaffError);
  });
});
