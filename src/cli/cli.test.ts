import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { login, verifySession } from '../dashboard/auth.js';
import { closePool } from '../db/pool.js';
import { createBusiness } from '../tenancy/businesses.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { main as businessMain } from './business.js';
import { BUSINESS_ARG_EXIT_CODE, MISSING_BUSINESS_MESSAGE, unknownBusinessMessage } from './business-arg.js';
import { run as createOwnerRun } from './create-owner.js';
import { main as ingestMain } from './ingest-doc.js';
import { main as killMain } from './kill.js';
import { run as ownerPasswordRun } from './owner-password.js';
import type { PromptIo } from './prompt-io.js';
import { main as secretMain } from './secret.js';
import { main as seedJobMain } from './seed-job.js';
import { main as setRampMain } from './set-ramp.js';

const USERNAME = 'owner';
/** Every business-scoped command in this file runs with this flag. */
const BIZ = ['--business', TEST_BUSINESS];
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
  // `resetDatabase` empties `businesses`, and every command refuses an
  // unregistered business (`business-arg.ts`).
  await createBusiness(TEST_BUSINESS, 'עסק בדיקה');
});

afterAll(async () => {
  await closePool();
});

describe('owner:create', () => {
  it('refuses a password passed as an argument, citing shell history', async () => {
    const io = fakeIo([]);
    const code = await createOwnerRun([USERNAME, '--password=x', ...BIZ], io);
    expect(code).toBe(2);
    expect(io.errors).toHaveLength(1);
    expect(io.errors[0]).toContain('היסטוריית הפקודות');
  });

  it('creates the account via the prompt path', async () => {
    const io = fakeIo([PASSWORD, PASSWORD]);
    const code = await createOwnerRun([USERNAME, ...BIZ], io);
    expect(code).toBe(0);

    const result = await login({ username: USERNAME, password: PASSWORD, businessId: TEST_BUSINESS });
    expect(result.ok).toBe(true);
  });

  it('prints exactly eight recovery codes, each a distinct value', async () => {
    const io = fakeIo([PASSWORD, PASSWORD]);
    const code = await createOwnerRun([USERNAME, ...BIZ], io);
    expect(code).toBe(0);

    const codeLines = io.prints.filter((line) => /^\s*\d+\.\s/.test(line));
    expect(codeLines).toHaveLength(8);
    expect(new Set(codeLines).size).toBe(8);
  });

  it('rejects mismatched password confirmation without creating the account', async () => {
    const io = fakeIo(['first password', 'a different password']);
    const code = await createOwnerRun([USERNAME, ...BIZ], io);
    expect(code).toBe(1);

    const result = await login({ username: USERNAME, password: 'first password', businessId: TEST_BUSINESS });
    expect(result).toEqual({ ok: false, code: 'bad_credentials' });
  });

  it('refuses a second account with a clear message instead of a raw DB error', async () => {
    const first = fakeIo([PASSWORD, PASSWORD]);
    expect(await createOwnerRun([USERNAME, ...BIZ], first)).toBe(0);

    const second = fakeIo(['another password', 'another password']);
    const code = await createOwnerRun([USERNAME, ...BIZ], second);
    expect(code).toBe(1);
    expect(second.errors[0]).toContain('כבר קיים');
  });
});

describe('owner:password', () => {
  let creationIo: ReturnType<typeof fakeIo>;

  beforeEach(async () => {
    creationIo = fakeIo([PASSWORD, PASSWORD]);
    await createOwnerRun([USERNAME, ...BIZ], creationIo);
  });

  it('refuses a password passed as an argument, citing shell history', async () => {
    const io = fakeIo([]);
    const code = await ownerPasswordRun([USERNAME, '--password=x', ...BIZ], io);
    expect(code).toBe(2);
    expect(io.errors[0]).toContain('היסטוריית הפקודות');
  });

  it('changes the password and revokes every open session', async () => {
    const session = await login({ username: USERNAME, password: PASSWORD, businessId: TEST_BUSINESS });
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const newPassword = 'a brand new password';
    const io = fakeIo([newPassword, newPassword]);
    const code = await ownerPasswordRun([USERNAME, ...BIZ], io);
    expect(code).toBe(0);

    expect(await verifySession(session.sessionId, { businessId: TEST_BUSINESS })).toBeNull();

    const withOld = await login({ username: USERNAME, password: PASSWORD, businessId: TEST_BUSINESS });
    expect(withOld).toEqual({ ok: false, code: 'bad_credentials' });

    const withNew = await login({ username: USERNAME, password: newPassword, businessId: TEST_BUSINESS });
    expect(withNew.ok).toBe(true);
  });

  it('re-issues recovery codes on reset, replacing the old set entirely', async () => {
    const codePattern = /^\s*\d+\.\s/;
    const oldCodes = creationIo.prints.filter((line) => codePattern.test(line));
    expect(oldCodes).toHaveLength(8);

    const newPassword = 'a brand new password';
    const io = fakeIo([newPassword, newPassword]);
    const code = await ownerPasswordRun([USERNAME, ...BIZ], io);
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
    const code = await ownerPasswordRun(['no-such-owner', ...BIZ], io);
    expect(code).toBe(1);
    expect(io.errors[0]).toContain('אין חשבון');
  });
});

/**
 * `--business <id>` (spec §5.8, plan Task 7). Every business-scoped command
 * refuses without it, and refuses an id no business is registered under —
 * exit code 2, the Hebrew line the brief names, and NOTHING written. Each
 * family is driven through its real entry function, so a command that read
 * the flag too late (after a write, or after a prompt) fails here.
 */
describe('--business', () => {
  const UNKNOWN = 'no-such-business';

  function io(): { log: (l: string) => void; error: (l: string) => void; lines: string[]; errors: string[] } {
    const lines: string[] = [];
    const errors: string[] = [];
    return { lines, errors, log: (l) => lines.push(l), error: (l) => errors.push(l) };
  }

  /** Row counts of every table any of these commands could write. */
  async function written(): Promise<Record<string, number>> {
    const tables = [
      'dashboard_users', 'kill_switch', 'audit_log', 'credentials', 'autonomy_ramp',
      'documents', 'jobs', 'job_plans',
    ];
    const out: Record<string, number> = {};
    for (const t of tables) {
      const { rows } = await testDb().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`);
      out[t] = Number(rows[0]?.n ?? 0);
    }
    return out;
  }

  const NOTHING = {
    dashboard_users: 0, kill_switch: 0, audit_log: 0, credentials: 0, autonomy_ramp: 0,
    documents: 0, jobs: 0, job_plans: 0,
  };

  /** Run one command with the given business args, and assert the refusal. */
  async function expectRefused(
    run: (businessArgs: string[], out: ReturnType<typeof io>) => Promise<number>,
    businessArgs: string[],
    message: string,
  ): Promise<void> {
    const out = io();
    const code = await run(businessArgs, out);
    expect(code).toBe(BUSINESS_ARG_EXIT_CODE);
    expect(code).toBe(2);
    expect(out.errors).toEqual([message]);
    expect(out.lines).toEqual([]);
    expect(await written()).toEqual(NOTHING);
  }

  const promptIo = (out: ReturnType<typeof io>): PromptIo => ({
    print: out.log,
    error: out.error,
    readSecret: async () => {
      throw new Error('prompted before --business was checked');
    },
  });

  const families: Array<[string, (b: string[], out: ReturnType<typeof io>) => Promise<number>]> = [
    ['owner:create', (b, out) => createOwnerRun([USERNAME, ...b], promptIo(out))],
    ['owner:password', (b, out) => ownerPasswordRun([USERNAME, ...b], promptIo(out))],
    ['kill', (b, out) => killMain(['stop', 'all', 'operator', 'drill', ...b], out)],
    [
      'secret',
      (b, out) => secretMain(['put', 'OFFICE_MAIL', 'operator', ...b], {
        ...out,
        readSecret: async () => {
          throw new Error('read the secret before --business was checked');
        },
      }),
    ],
    ['ramp:set', (b, out) => setRampMain(['email.reply', 'auto_notify', ...b], out)],
    [
      'doc:ingest',
      (b, out) => ingestMain(
        [fileURLToPath(new URL('../documents/fixtures/tiny.xlsx', import.meta.url)), ...b],
        out,
      ),
    ],
    ['job:seed', (b, out) => seedJobMain(['--to', 'dana@example.com', ...b], out)],
  ];

  for (const [name, run] of families) {
    describe(name, () => {
      it('refuses to run without --business', async () => {
        await expectRefused(run, [], MISSING_BUSINESS_MESSAGE);
      });

      it('refuses a malformed business id', async () => {
        await expectRefused(run, ['--business', 'Bad Id!'], MISSING_BUSINESS_MESSAGE);
      });

      it('refuses an unknown business', async () => {
        await expectRefused(run, ['--business', UNKNOWN], unknownBusinessMessage(UNKNOWN));
      });
    });
  }

  /**
   * The `sdk:*` scripts run on import (each is a live, billed call), so they
   * cannot be driven from a test. What is checked instead: every one of them
   * enters through `runForBusiness` — the entry the families above prove —
   * and none still reads a configured default business.
   */
  describe('sdk:*', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { scripts: Record<string, string> };
    // Every `sdk:*` npm script, by the file it runs — taken from package.json,
    // not from a list here, so a new script is checked without anyone
    // remembering to add it.
    const scripts = Object.entries(pkg.scripts)
      .filter(([name]) => name.startsWith('sdk:'))
      .map(([, command]) => command.replace(/^tsx\s+/, ''));
    const onDisk = readdirSync(`${root}src/sdk`).filter((f) => /^run-.*\.ts$/.test(f));

    it('finds the scripts it claims to check', () => {
      expect(scripts.length).toBeGreaterThanOrEqual(10);
      // And no run-*.ts script sits outside package.json, unchecked.
      expect(onDisk.map((f) => `src/sdk/${f}`).sort()).toEqual([...scripts].sort());
    });

    it('refuses to run without --business: every script enters through runForBusiness', () => {
      for (const file of scripts) {
        const source = readFileSync(`${root}${file}`, 'utf8');
        expect(source, file).toMatch(/runForBusiness\(\s*process\.argv\.slice\(2\)/);
        expect(source, file).not.toMatch(/config\.businessId/);
      }
    });
  });

  describe('business', () => {
    it('refuses to run without a business id, with exit code 2', async () => {
      const out = io();
      expect(await businessMain(['suspend'], out)).toBe(2);
      expect(out.errors).toHaveLength(1);
    });

    it('refuses an unknown or malformed business id, with exit code 2', async () => {
      const unknown = io();
      expect(await businessMain(['suspend', UNKNOWN], unknown)).toBe(2);
      expect(unknown.errors).toEqual([unknownBusinessMessage(UNKNOWN)]);

      const malformed = io();
      expect(await businessMain(['resume', 'Bad Id!'], malformed)).toBe(2);
      const { rows } = await testDb().query<{ status: string }>(
        'SELECT status FROM businesses WHERE business_id = $1',
        [TEST_BUSINESS],
      );
      expect(rows[0]?.status).toBe('active');
    });

    it('keeps exit code 1 for a refusal that is not about the id', async () => {
      const out = io();
      expect(await businessMain(['create', TEST_BUSINESS, 'שוב'], out)).toBe(1);
    });
  });
});
