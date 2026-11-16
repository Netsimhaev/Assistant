import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { resetDatabase } from '../test/db.js';
import { listStaff, staffLogin } from '../tenancy/staff.js';
import type { PromptIo } from './prompt-io.js';
import { ENROL_ON_FIRST_PANEL_LOGIN_NOTE, HEAD_EXISTS_MESSAGE, run } from './staff.js';

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
