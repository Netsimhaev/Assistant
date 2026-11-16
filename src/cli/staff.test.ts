import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { resetDatabase } from '../test/db.js';
import {
  createHeadStaff,
  listStaff,
  redeemStaffLink,
  staffBeginEnrolment,
  staffConfirmEnrolment,
  staffLogin,
  staffTotpStatus,
} from '../tenancy/staff.js';
import { recentStaffActions } from '../tenancy/activity-log.js';
import { currentStep, totpCode } from '../auth/totp.js';
import { randomBytes } from 'node:crypto';
import type { PromptIo } from './prompt-io.js';
import { ENROL_ON_FIRST_PANEL_LOGIN_NOTE, HEAD_EXISTS_MESSAGE, run, STAFF_NOT_FOUND_CLI } from './staff.js';

const PASSWORD = 'head password long enough';

function fakeIo(secrets: string[]): PromptIo & { prints: string[]; errors: string[] } {
  const prints: string[] = [];
  const errors: string[] = [];
  let next = 0;
  return {
    prints,
    errors,
    print: (text) => prints.push(text),
    error: (text) => errors.push(text),
    readSecret: async () => {
      const value = secrets[next];
      next += 1;
      if (value === undefined) throw new Error('fakeIo: no more secrets queued');
      return value;
    },
  };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

describe('staff create-head', () => {
  it('creates the head after the password is typed twice, and prints the authenticator note', async () => {
    const io = fakeIo([PASSWORD, PASSWORD]);
    expect(await run(['create-head', '--email', 'Head@Company.example', '--name', 'דנה'], io)).toBe(0);
    expect(io.prints).toContain(ENROL_ON_FIRST_PANEL_LOGIN_NOTE);
    expect(ENROL_ON_FIRST_PANEL_LOGIN_NOTE).toBe('בכניסה הראשונה לפאנל תתבקש לחבר את Google Authenticator.');
    const all = await listStaff();
    expect(all.map((s) => [s.login, s.displayName, s.isHead])).toEqual([['head@company.example', 'דנה', true]]);
    expect((await staffLogin({ login: 'head@company.example', password: PASSWORD })).ok).toBe(true);
  });

  it('refuses a second head before asking for a password', async () => {
    expect(await run(['create-head', '--email', 'a@company.example', '--name', 'א'], fakeIo([PASSWORD, PASSWORD]))).toBe(0);
    const io = fakeIo([]);
    expect(await run(['create-head', '--email', 'b@company.example', '--name', 'ב'], io)).toBe(1);
    expect(io.errors).toContain(HEAD_EXISTS_MESSAGE);
    expect(await listStaff()).toHaveLength(1);
  });

  it('refuses mismatched passwords, a password flag, and a missing name or email', async () => {
    const mismatch = fakeIo([PASSWORD, 'something else entirely']);
    expect(await run(['create-head', '--email', 'a@company.example', '--name', 'א'], mismatch)).toBe(1);
    expect(await run(['create-head', '--email', 'a@company.example', '--name', 'א', '--password', 'x'], fakeIo([]))).toBe(
      2,
    );
    expect(await run(['create-head', '--name', 'א'], fakeIo([]))).toBe(2);
    expect(await run(['create-head', '--email', 'a@company.example'], fakeIo([]))).toBe(2);
    expect(await run(['nonsense'], fakeIo([]))).toBe(2);
    expect(await listStaff()).toHaveLength(0);
  });

  it('refuses a weak password with a Hebrew message', async () => {
    const io = fakeIo(['short', 'short']);
    expect(await run(['create-head', '--email', 'a@company.example', '--name', 'א'], io)).toBe(1);
    expect(io.errors.join('\n')).toMatch(/סיסמה/);
    expect(await listStaff()).toHaveLength(0);
  });
});

describe('staff break-glass (final review I2)', () => {
  const KEY = randomBytes(32);

  it("reset-factor forgets a member's Authenticator and logs it as the command line", async () => {
    const id = await createHeadStaff({ login: 'head@company.example', displayName: 'דנה', password: PASSWORD });
    const { secretBase32 } = await staffBeginEnrolment(id, KEY);
    const now = new Date();
    expect(await staffConfirmEnrolment(id, totpCode(secretBase32, currentStep(now)), KEY, now)).toBe('ok');

    const io = fakeIo([]);
    expect(await run(['reset-factor', '--email', 'HEAD@company.example'], io)).toBe(0);
    expect(await staffTotpStatus(id)).toBe('not_enrolled');
    const actions = await recentStaffActions(5);
    expect(actions.map((r) => r.action)).toEqual(['totp_reset']);
  });

  it('reissue-link prints a one-time link once that lets the member set a new password', async () => {
    await createHeadStaff({ login: 'head@company.example', displayName: 'דנה', password: PASSWORD });
    const io = fakeIo([]);
    const previous = process.env['ADMIN_BASE_URL'];
    process.env['ADMIN_BASE_URL'] = 'https://panel.example';
    try {
      expect(await run(['reissue-link', '--email', 'head@company.example'], io)).toBe(0);
    } finally {
      if (previous === undefined) delete process.env['ADMIN_BASE_URL'];
      else process.env['ADMIN_BASE_URL'] = previous;
    }
    const line = io.prints.find((p) => p.includes('/join/'));
    const token = /\/join\/([0-9a-f]{64})/.exec(line ?? '')?.[1];
    expect(line).toContain('https://panel.example/join/');
    expect(token).toBeDefined();
    expect(io.prints.filter((p) => p.includes(token ?? 'never'))).toHaveLength(1);
    expect(
      await redeemStaffLink({ rawToken: token ?? '', typedLogin: 'head@company.example', password: 'a fresh password here' }),
    ).toMatchObject({ ok: true });
    expect((await staffLogin({ login: 'head@company.example', password: 'a fresh password here' })).ok).toBe(true);
    expect((await recentStaffActions(5)).map((r) => r.action)).toEqual(['staff_link_reissued']);
  });

  it('refuses an unknown address and a missing --email', async () => {
    const io = fakeIo([]);
    expect(await run(['reset-factor', '--email', 'nobody@company.example'], io)).toBe(1);
    expect(io.errors).toContain(STAFF_NOT_FOUND_CLI);
    expect(await run(['reissue-link', '--email', 'nobody@company.example'], fakeIo([]))).toBe(1);
    expect(await run(['reissue-link'], fakeIo([]))).toBe(2);
    expect(await recentStaffActions(5)).toEqual([]);
  });
});
