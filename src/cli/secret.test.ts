import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, getPool, withBusiness } from '../db/pool.js';
import { writeKeyState } from '../governance/master-key.js';
import { resetDatabase, TEST_BUSINESS } from '../test/db.js';
import { main, runSecretCli, type SecretCliDeps } from './secret.js';
import { resolveStoredSecret } from '../governance/credential-store.js';
import { resolvePlatformSecret } from '../tenancy/platform-credentials.js';
import { closePlatformPool } from '../db/platform-pool.js';

const REF = 'OFFICE_MAIL';
const SECRET = 'hunter2-the-mailbox-password';
const OPERATOR = 'operator@example.com';
const KEY_ID = 'key-1';
const BUSINESS = TEST_BUSINESS;

/** `runSecretCli` on a connection for `business` — what `main` does after `--business`. */
function run(argv: string[], deps: SecretCliDeps, business: string = BUSINESS): Promise<void> {
  return withBusiness(business, (db) => runSecretCli(db, argv, deps));
}

let DIR: string;
let PREVIOUS_KEY_PATH: string | undefined;

function collector(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line: string) => lines.push(line), lines };
}

/** A `readSecret` that never touches argv — the stand-in for stdin. */
function reads(value: string): () => Promise<string> {
  return async () => value;
}

beforeEach(async () => {
  await resetDatabase();
  DIR = await mkdtemp(join(tmpdir(), 'secret-cli-'));
  const keyPath = join(DIR, 'master.key');
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
  PREVIOUS_KEY_PATH = process.env['CREDENTIAL_KEY_PATH'];
  process.env['CREDENTIAL_KEY_PATH'] = keyPath;

  // The key state is per-installation and holds one row under
  // `config.businessId` — the same default `putSecret` reads it under, and
  // the same one `credential-store.test.ts` uses.
  const { readFile } = await import('node:fs/promises');
  const key = await readFile(keyPath);
  await writeKeyState(key, KEY_ID);
});

afterEach(async () => {
  if (PREVIOUS_KEY_PATH === undefined) {
    delete process.env['CREDENTIAL_KEY_PATH'];
  } else {
    process.env['CREDENTIAL_KEY_PATH'] = PREVIOUS_KEY_PATH;
  }
  await rm(DIR, { recursive: true, force: true });
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

/**
 * Every column of every `audit_log` row, concatenated — with the column list
 * read out of `information_schema`, never written here.
 *
 * This used to hand-list seventeen columns, which made the claim below ("no
 * audit row contains the value") quietly narrower than it reads: a column
 * added to `audit_log` next year would sit outside the scan and the test
 * would stay green. `src/governance/erasure-invariants.test.ts` solves the
 * identical problem the identical way, and for the identical reason — the
 * dangerous gap is the place nobody thought of, so the schema has to be the
 * thing describing itself.
 *
 * Every column, not only the text-typed ones: this is a small table in a
 * freshly reset database, `::text` renders all of them, and a secret landing
 * in a column nobody expected to be text-shaped is exactly the surprise worth
 * catching.
 */
async function allAuditText(): Promise<string> {
  const db = getPool();
  const { rows: columns } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'audit_log'
      ORDER BY ordinal_position`,
  );
  // A scan over zero columns finds nothing and passes for the wrong reason —
  // the same vacuous-green failure mode `erasure-invariants.test.ts` guards
  // against. Seventeen today; this only has to stay comfortably above zero.
  expect(columns.length).toBeGreaterThan(10);

  const expression = columns
    .map((column) => `coalesce("${column.column_name}"::text,'')`)
    .join(" || '|' || ");
  const { rows } = await db.query<{ blob: string }>(
    `SELECT string_agg(${expression}, chr(10)) AS blob FROM audit_log`,
  );
  return rows[0]?.blob ?? '';
}

describe('runSecretCli', () => {
  it('stores a secret read from the input, not from argv', async () => {
    const { log } = collector();

    await run(['put', REF, OPERATOR], { log, readSecret: reads(SECRET) });

    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM credentials WHERE business_id = $1 AND ref = $2',
      [BUSINESS, REF],
    );
    expect(rows[0]?.n).toBe('1');

    // Resolved back through the real store, with the real key — proof the
    // value that was read from `readSecret` is what actually got sealed.
    const { storedCredentials } = await import('../governance/credential-store.js');
    const { loadMasterKey } = await import('../governance/master-key.js');
    const key = await loadMasterKey(process.env['CREDENTIAL_KEY_PATH'] as string);
    const handle = await storedCredentials(key).resolve(REF, BUSINESS);
    expect(handle?.value).toBe(SECRET);
  });

  /**
   * Spec §6.2 — an argument appears in shell history and in the machine's
   * process list, so the secret would leak at the exact moment of securing
   * it. A legitimate `put` carries exactly three argv elements (`put`,
   * `<ref>`, `<operator>`); a fourth can only be an attempt to smuggle the
   * secret itself onto the command line.
   */
  it('refuses a put that carries the secret as an argument', async () => {
    const { log } = collector();

    await expect(
      run(['put', REF, OPERATOR, SECRET], { log, readSecret: reads('unused') }),
    ).rejects.toThrow();

    const { rows } = await getPool().query<{ n: string }>('SELECT count(*)::text AS n FROM credentials');
    expect(rows[0]?.n).toBe('0');
  });

  /**
   * Spec §9.6 — no path prints a value. Asserted over EVERY line every
   * command emitted, for every command, not just the one that seemed risky.
   */
  it('never prints the secret, in any command', async () => {
    const { log, lines } = collector();

    await run(['put', REF, OPERATOR], { log, readSecret: reads(SECRET) });
    await run(['list', OPERATOR], { log, readSecret: reads('unused') });
    await run(['test', REF, OPERATOR], { log, readSecret: reads('unused') });
    await run(['remove', REF, OPERATOR], { log, readSecret: reads('unused') });

    for (const line of lines) {
      expect(line).not.toContain(SECRET);
    }
  });

  it('reports whether a ref resolves without revealing what it resolves to', async () => {
    await run(['put', REF, OPERATOR], { log: () => {}, readSecret: reads(SECRET) });

    const found = collector();
    await run(['test', REF, OPERATOR], { ...found, readSecret: reads('unused') });
    expect(found.lines.join('\n')).not.toContain(SECRET);
    expect(found.lines.some((l) => l.includes(REF))).toBe(true);

    const missing = collector();
    await run(['test', 'CALENDAR_TOKEN', OPERATOR], {
      ...missing,
      readSecret: reads('unused'),
    });
    // The two outcomes must actually read differently — otherwise "reports
    // whether it resolves" would be a report that never changes.
    expect(found.lines.join('\n')).not.toBe(missing.lines.join('\n'));
  });

  /**
   * The middle of the three audit cases: a resolve that FAILS is the
   * interesting event (a misspelled ref, or someone probing), so `test`
   * must write a row on that outcome exactly as it does on success — not
   * only when there is good news to record.
   */
  it('audits a test resolve that fails to resolve, not only one that succeeds', async () => {
    const before = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE kind = 'credential_change'`,
    );

    await run(['test', 'NEVER_STORED', OPERATOR], {
      log: () => {},
      readSecret: reads('unused'),
    });

    const after = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE kind = 'credential_change'`,
    );
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n) + 1);
  });

  /**
   * The business is the connection's (`db.businessId`, from `--business`) —
   * and unlike a ramp level, a secret written under the wrong business is a
   * secret another customer's `resolve` can reach (`credential-store.ts`'s own
   * docblock). A one-line regression that ignored the connection's business
   * and wrote under a configured default would pass every other test in this
   * file.
   */
  it("stores the secret under the connection's business, not the configured default", async () => {
    const OTHER_BUSINESS = 'other-business';
    expect(OTHER_BUSINESS).not.toBe(BUSINESS);
    expect(OTHER_BUSINESS).not.toBe(config.businessId);

    await run(['put', REF, OPERATOR], { log: () => {}, readSecret: reads(SECRET) }, OTHER_BUSINESS);

    const { rows } = await getPool().query<{ business_id: string; n: string }>(
      `SELECT business_id, count(*)::text AS n FROM credentials WHERE ref = $1 GROUP BY business_id`,
      [REF],
    );
    expect(rows).toEqual([{ business_id: OTHER_BUSINESS, n: '1' }]);
  });

  it('writes an audit row naming the business, the ref and the operator', async () => {
    await run(['put', REF, OPERATOR], { log: () => {}, readSecret: reads(SECRET) });

    const { rows } = await getPool().query<{ reason: string; on_behalf_of: string | null; business_id: string; kind: string }>(
      `SELECT reason, on_behalf_of, business_id, kind FROM audit_log WHERE kind = 'credential_change'`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('expected an audit row');
    expect(row.business_id).toBe(BUSINESS);
    expect(row.on_behalf_of).toBe(OPERATOR);
    expect(row.reason).toContain(REF);
    expect(row.reason).toContain(OPERATOR);
    expect(row.reason).toContain(BUSINESS);
  });

  it('writes no audit row that contains the value', async () => {
    await run(['put', REF, OPERATOR], { log: () => {}, readSecret: reads(SECRET) });
    await run(['list', OPERATOR], { log: () => {}, readSecret: reads('unused') });
    await run(['test', REF, OPERATOR], { log: () => {}, readSecret: reads('unused') });
    await run(['remove', REF, OPERATOR], { log: () => {}, readSecret: reads('unused') });

    const blob = await allAuditText();

    // The positive half, without which the line below passes just as well on
    // an empty scan: the sweep is demonstrably reading real rows, and the
    // things that BELONG in an audit row are in it.
    expect(blob).toContain(OPERATOR);
    expect(blob).toContain(REF);

    expect(blob).not.toContain(SECRET);
  });

  it('refuses an unknown command and names the valid ones', async () => {
    const { log } = collector();

    await expect(
      run(['bogus'], { log, readSecret: reads('unused') }),
    ).rejects.toThrow(/put/);
    await expect(
      run(['bogus'], { log, readSecret: reads('unused') }),
    ).rejects.toThrow(/list/);
    await expect(
      run(['bogus'], { log, readSecret: reads('unused') }),
    ).rejects.toThrow(/remove/);
    await expect(
      run(['bogus'], { log, readSecret: reads('unused') }),
    ).rejects.toThrow(/test/);
  });

  describe('list', () => {
    it('lists refs and audits the view without a specific ref', async () => {
      await run(['put', REF, OPERATOR], { log: () => {}, readSecret: reads(SECRET) });

      const { log, lines } = collector();
      await run(['list', OPERATOR], { log, readSecret: reads('unused') });

      expect(lines.some((l) => l.includes(REF))).toBe(true);

      const { rows } = await getPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log WHERE kind = 'credential_change' AND reason LIKE '%רשימת%'`,
      );
      expect(rows[0]?.n).toBe('1');
    });
  });

  describe('remove', () => {
    it('removes a stored secret so it no longer resolves', async () => {
      await run(['put', REF, OPERATOR], { log: () => {}, readSecret: reads(SECRET) });

      const { log } = collector();
      await run(['remove', REF, OPERATOR], { log, readSecret: reads('unused') });

      const { rows } = await getPool().query<{ n: string }>(
        'SELECT count(*)::text AS n FROM credentials WHERE business_id = $1 AND ref = $2',
        [BUSINESS, REF],
      );
      expect(rows[0]?.n).toBe('0');
    });

    it('audits a remove of a ref that was never stored', async () => {
      const { log } = collector();
      await run(['remove', 'NEVER_STORED', OPERATOR], { log, readSecret: reads('unused') });

      const { rows } = await getPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log WHERE kind = 'credential_change'`,
      );
      expect(rows[0]?.n).toBe('1');
    });
  });
});

describe('secret --platform', () => {
  const PLATFORM_REF = 'GOOGLE_OAUTH_CLIENT_SECRET';
  const PLATFORM_VALUE = 'platform-client-secret-SENTINEL';

  function io(value: string): { log: (l: string) => void; error: (l: string) => void; readSecret: () => Promise<string>; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { log: (l) => out.push(l), error: (l) => err.push(l), readSecret: reads(value), out, err };
  }

  it('puts, tests and removes a server secret without a business, never printing the value', async () => {
    const put = io(PLATFORM_VALUE);
    expect(await main(['--platform', 'put', PLATFORM_REF, OPERATOR], put)).toBe(0);
    const { readFile } = await import('node:fs/promises');
    const key = await readFile(process.env['CREDENTIAL_KEY_PATH'] as string);
    expect(await resolvePlatformSecret(PLATFORM_REF, key)).toBe(PLATFORM_VALUE);
    // Stored for the server, not for any business.
    expect(await withBusiness(BUSINESS, (db) => resolveStoredSecret(db, key, PLATFORM_REF))).toBeNull();

    const test = io('');
    expect(await main(['--platform', 'test', PLATFORM_REF, OPERATOR], test)).toBe(0);
    expect(test.out.join('\n')).toMatch(/נפתר בהצלחה/);

    const removed = io('');
    expect(await main(['--platform', 'remove', PLATFORM_REF, OPERATOR], removed)).toBe(0);
    expect(await resolvePlatformSecret(PLATFORM_REF, key)).toBeNull();

    for (const run of [put, test, removed]) expect([...run.out, ...run.err].join('\n')).not.toContain(PLATFORM_VALUE);
  });

  it('refuses --platform together with --business, and a value on the command line', async () => {
    const both = io(PLATFORM_VALUE);
    expect(await main(['--platform', '--business', BUSINESS, 'put', PLATFORM_REF, OPERATOR], both)).toBe(2);
    const argvValue = io(PLATFORM_VALUE);
    expect(await main(['--platform', 'put', PLATFORM_REF, OPERATOR, PLATFORM_VALUE], argvValue)).toBe(1);
    expect(argvValue.err.join('\n')).not.toContain(PLATFORM_VALUE);
    const { rows } = await getPool().query('SELECT 1 FROM platform_credentials');
    expect(rows).toHaveLength(0);
  });
});
