import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, getPool } from '../db/pool.js';
import { writeKeyState } from '../governance/master-key.js';
import { resetDatabase } from '../test/db.js';
import { runSecretCli } from './secret.js';

const REF = 'OFFICE_MAIL';
const SECRET = 'hunter2-the-mailbox-password';
const OPERATOR = 'operator@example.com';
const KEY_ID = 'key-1';

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
  await closePool();
});

/** Every text-bearing column of every `audit_log` row, concatenated. */
async function allAuditText(): Promise<string> {
  const { rows } = await getPool().query<{ blob: string }>(
    `SELECT string_agg(
       coalesce(business_id,'') || '|' || coalesce(job_id,'') || '|' ||
       coalesce(envelope_id,'') || '|' || coalesce(actor,'') || '|' ||
       coalesce(on_behalf_of,'') || '|' || coalesce(kind,'') || '|' ||
       coalesce(action_class,'') || '|' || coalesce(charter_version,'') || '|' ||
       coalesce(provenance,'') || '|' || coalesce(risk::text,'') || '|' ||
       coalesce(input_hash,'') || '|' || coalesce(output_hash,'') || '|' ||
       coalesce(artifacts::text,'') || '|' || coalesce(tokens::text,'') || '|' ||
       coalesce(reason,'') || '|' || coalesce(prev_hash,'') || '|' || coalesce(hash,''),
       E'\n'
     ) AS blob
     FROM audit_log`,
  );
  return rows[0]?.blob ?? '';
}

describe('runSecretCli', () => {
  it('stores a secret read from the input, not from argv', async () => {
    const { log } = collector();

    await runSecretCli(['put', REF, OPERATOR], { log, readSecret: reads(SECRET) });

    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM credentials WHERE business_id = $1 AND ref = $2',
      [config.businessId, REF],
    );
    expect(rows[0]?.n).toBe('1');

    // Resolved back through the real store, with the real key — proof the
    // value that was read from `readSecret` is what actually got sealed.
    const { storedCredentials } = await import('../governance/credential-store.js');
    const { loadMasterKey } = await import('../governance/master-key.js');
    const key = await loadMasterKey(process.env['CREDENTIAL_KEY_PATH'] as string);
    const handle = await storedCredentials(key).resolve(REF, config.businessId);
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
      runSecretCli(['put', REF, OPERATOR, SECRET], { log, readSecret: reads('unused') }),
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

    await runSecretCli(['put', REF, OPERATOR], { log, readSecret: reads(SECRET) });
    await runSecretCli(['list', OPERATOR], { log, readSecret: reads('unused') });
    await runSecretCli(['test', REF, OPERATOR], { log, readSecret: reads('unused') });

    for (const line of lines) {
      expect(line).not.toContain(SECRET);
    }
  });

  it('reports whether a ref resolves without revealing what it resolves to', async () => {
    await runSecretCli(['put', REF, OPERATOR], { log: () => {}, readSecret: reads(SECRET) });

    const found = collector();
    await runSecretCli(['test', REF, OPERATOR], { ...found, readSecret: reads('unused') });
    expect(found.lines.join('\n')).not.toContain(SECRET);
    expect(found.lines.some((l) => l.includes(REF))).toBe(true);

    const missing = collector();
    await runSecretCli(['test', 'CALENDAR_TOKEN', OPERATOR], {
      ...missing,
      readSecret: reads('unused'),
    });
    // The two outcomes must actually read differently — otherwise "reports
    // whether it resolves" would be a report that never changes.
    expect(found.lines.join('\n')).not.toBe(missing.lines.join('\n'));
  });

  it('writes an audit row naming the business, the ref and the operator', async () => {
    await runSecretCli(['put', REF, OPERATOR], { log: () => {}, readSecret: reads(SECRET) });

    const { rows } = await getPool().query<{ reason: string; on_behalf_of: string | null; business_id: string; kind: string }>(
      `SELECT reason, on_behalf_of, business_id, kind FROM audit_log WHERE kind = 'credential_change'`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('expected an audit row');
    expect(row.business_id).toBe(config.businessId);
    expect(row.on_behalf_of).toBe(OPERATOR);
    expect(row.reason).toContain(REF);
    expect(row.reason).toContain(OPERATOR);
    expect(row.reason).toContain(config.businessId);
  });

  it('writes no audit row that contains the value', async () => {
    await runSecretCli(['put', REF, OPERATOR], { log: () => {}, readSecret: reads(SECRET) });
    await runSecretCli(['list', OPERATOR], { log: () => {}, readSecret: reads('unused') });
    await runSecretCli(['test', REF, OPERATOR], { log: () => {}, readSecret: reads('unused') });
    await runSecretCli(['remove', REF, OPERATOR], { log: () => {}, readSecret: reads('unused') });

    expect(await allAuditText()).not.toContain(SECRET);
  });

  it('refuses an unknown command and names the valid ones', async () => {
    const { log } = collector();

    await expect(
      runSecretCli(['bogus'], { log, readSecret: reads('unused') }),
    ).rejects.toThrow(/put/);
    await expect(
      runSecretCli(['bogus'], { log, readSecret: reads('unused') }),
    ).rejects.toThrow(/list/);
    await expect(
      runSecretCli(['bogus'], { log, readSecret: reads('unused') }),
    ).rejects.toThrow(/remove/);
    await expect(
      runSecretCli(['bogus'], { log, readSecret: reads('unused') }),
    ).rejects.toThrow(/test/);
  });

  describe('list', () => {
    it('lists refs and audits the view without a specific ref', async () => {
      await runSecretCli(['put', REF, OPERATOR], { log: () => {}, readSecret: reads(SECRET) });

      const { log, lines } = collector();
      await runSecretCli(['list', OPERATOR], { log, readSecret: reads('unused') });

      expect(lines.some((l) => l.includes(REF))).toBe(true);

      const { rows } = await getPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log WHERE kind = 'credential_change' AND reason LIKE '%רשימת%'`,
      );
      expect(rows[0]?.n).toBe('1');
    });
  });

  describe('remove', () => {
    it('removes a stored secret so it no longer resolves', async () => {
      await runSecretCli(['put', REF, OPERATOR], { log: () => {}, readSecret: reads(SECRET) });

      const { log } = collector();
      await runSecretCli(['remove', REF, OPERATOR], { log, readSecret: reads('unused') });

      const { rows } = await getPool().query<{ n: string }>(
        'SELECT count(*)::text AS n FROM credentials WHERE business_id = $1 AND ref = $2',
        [config.businessId, REF],
      );
      expect(rows[0]?.n).toBe('0');
    });

    it('audits a remove of a ref that was never stored', async () => {
      const { log } = collector();
      await runSecretCli(['remove', 'NEVER_STORED', OPERATOR], { log, readSecret: reads('unused') });

      const { rows } = await getPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log WHERE kind = 'credential_change'`,
      );
      expect(rows[0]?.n).toBe('1');
    });
  });
});
