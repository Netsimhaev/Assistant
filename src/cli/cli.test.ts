import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { login, verifySession } from '../dashboard/auth.js';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { run as createOwnerRun } from './create-owner.js';
import { run as ownerPasswordRun } from './owner-password.js';
import type { PromptIo } from './prompt-io.js';

const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

/**
 * A `PromptIo` fake: `readSecret` hands back the next queued answer instead
 * of touching a real terminal, and every `print`/`error` call is recorded
 * so a test can assert on exactly what a human running this by hand would
 * have seen.
 */
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
  await closePool();
});

describe('owner:create', () => {
  it('refuses a password passed as an argument, citing shell history', async () => {
    const io = fakeIo([]);
    const code = await createOwnerRun([USERNAME, '--password=x'], io);
    expect(code).toBe(2);
    expect(io.errors).toHaveLength(1);
    expect(io.errors[0]).toContain('היסטוריית הפקודות');
  });

  it('creates the account via the prompt path', async () => {
    const io = fakeIo([PASSWORD, PASSWORD]);
    const code = await createOwnerRun([USERNAME], io);
    expect(code).toBe(0);

    const result = await login({ username: USERNAME, password: PASSWORD, businessId: config.businessId });
    expect(result.ok).toBe(true);
  });

  it('prints exactly eight recovery codes, each a distinct value', async () => {
    const io = fakeIo([PASSWORD, PASSWORD]);
    const code = await createOwnerRun([USERNAME], io);
    expect(code).toBe(0);

    const codeLines = io.prints.filter((line) => /^\s*\d+\.\s/.test(line));
    expect(codeLines).toHaveLength(8);
    expect(new Set(codeLines).size).toBe(8);
  });

  it('rejects mismatched password confirmation without creating the account', async () => {
    const io = fakeIo(['first password', 'a different password']);
    const code = await createOwnerRun([USERNAME], io);
    expect(code).toBe(1);

    const result = await login({ username: USERNAME, password: 'first password', businessId: config.businessId });
    expect(result).toEqual({ ok: false, code: 'bad_credentials' });
  });

  it('refuses a second account with a clear message instead of a raw DB error', async () => {
    const first = fakeIo([PASSWORD, PASSWORD]);
    expect(await createOwnerRun([USERNAME], first)).toBe(0);

    const second = fakeIo(['another password', 'another password']);
    const code = await createOwnerRun([USERNAME], second);
    expect(code).toBe(1);
    expect(second.errors[0]).toContain('כבר קיים');
  });
});

describe('owner:password', () => {
  let creationIo: ReturnType<typeof fakeIo>;

  beforeEach(async () => {
    creationIo = fakeIo([PASSWORD, PASSWORD]);
    await createOwnerRun([USERNAME], creationIo);
  });

  it('refuses a password passed as an argument, citing shell history', async () => {
    const io = fakeIo([]);
    const code = await ownerPasswordRun([USERNAME, '--password=x'], io);
    expect(code).toBe(2);
    expect(io.errors[0]).toContain('היסטוריית הפקודות');
  });

  it('changes the password and revokes every open session', async () => {
    const session = await login({ username: USERNAME, password: PASSWORD, businessId: config.businessId });
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const newPassword = 'a brand new password';
    const io = fakeIo([newPassword, newPassword]);
    const code = await ownerPasswordRun([USERNAME], io);
    expect(code).toBe(0);

    expect(await verifySession(session.sessionId, { businessId: config.businessId })).toBeNull();

    const withOld = await login({ username: USERNAME, password: PASSWORD, businessId: config.businessId });
    expect(withOld).toEqual({ ok: false, code: 'bad_credentials' });

    const withNew = await login({ username: USERNAME, password: newPassword, businessId: config.businessId });
    expect(withNew.ok).toBe(true);
  });

  it('re-issues recovery codes on reset, replacing the old set entirely', async () => {
    const codePattern = /^\s*\d+\.\s/;
    const oldCodes = creationIo.prints.filter((line) => codePattern.test(line));
    expect(oldCodes).toHaveLength(8);

    const newPassword = 'a brand new password';
    const io = fakeIo([newPassword, newPassword]);
    const code = await ownerPasswordRun([USERNAME], io);
    expect(code).toBe(0);

    const newCodes = io.prints.filter((line) => codePattern.test(line));
    expect(newCodes).toHaveLength(8);
    // Not just "eight lines printed" — the strengthened assertion: this
    // would still pass a command that reprinted the same eight codes it
    // handed out at creation, which the weaker length-only check above did
    // not rule out.
    const overlap = newCodes.filter((line) => oldCodes.includes(line));
    expect(overlap).toHaveLength(0);
  });

  it('refuses to reset a password for an account that does not exist', async () => {
    const io = fakeIo([]);
    const code = await ownerPasswordRun(['no-such-owner'], io);
    expect(code).toBe(1);
    expect(io.errors[0]).toContain('אין חשבון');
  });
});
