import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { putSecret, resolveStoredSecret } from '../governance/credential-store.js';
import { KEY_BYTES, writeKeyState } from '../governance/master-key.js';
import { GOOGLE_CLIENT_ID_REF, GOOGLE_CLIENT_SECRET_REF } from '../orchestrator/adapters/google-token-http.js';
import { MICROSOFT_CLIENT_ID_REF } from '../orchestrator/adapters/microsoft-token-http.js';
import { GREEN_API_TOKEN_REF, NOTIFY_SMTP_PASS_REF } from '../orchestrator/runtime.js';
import { putPlatformSecret, resolvePlatformSecret } from '../tenancy/platform-credentials.js';
import { loadRuntimeSettings } from '../tenancy/runtime-settings.js';
import { registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { IMPORT_OPERATOR, main } from './import-env.js';

const BUSINESS = 'test-import-env';
let DIR: string;
let KEY: Buffer;
let KEY_PATH: string;

const SECRET_VALUES = {
  NOTIFY_MAIL: 'smtp-password-SENTINEL-1',
  [GOOGLE_CLIENT_ID_REF]: 'google-client-id-SENTINEL-2',
  [GOOGLE_CLIENT_SECRET_REF]: 'google-client-secret-SENTINEL-3',
  GREEN_API_TOKEN: 'green-token-SENTINEL-4',
};

function io(): { log: (l: string) => void; error: (l: string) => void; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { log: (l) => out.push(l), error: (l) => err.push(l), out, err };
}

async function store(ref: string, value: string): Promise<void> {
  await withBusiness(BUSINESS, (db) => putSecret(db, { ref, value, updatedBy: 'test' }, KEY));
}

beforeEach(async () => {
  await resetDatabase();
  await registerBusiness(BUSINESS);
  DIR = await mkdtemp(join(tmpdir(), 'import-env-'));
  KEY = randomBytes(KEY_BYTES);
  KEY_PATH = join(DIR, 'master.key');
  await writeFile(KEY_PATH, KEY, { mode: 0o600 });
  await writeKeyState(KEY, 'key-1', testDb());
});

afterEach(async () => {
  await rm(DIR, { recursive: true, force: true });
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

describe('tenancy:import-env', () => {
  it('import-env moves settings and OAuth clients and prints no secret value', async () => {
    for (const [ref, value] of Object.entries(SECRET_VALUES)) await store(ref, value);

    const env = {
      CREDENTIAL_KEY_PATH: KEY_PATH,
      APPROVAL_NOTIFY_TO: 'owner@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_FROM: 'assistant@example.com',
      SMTP_USER: 'assistant',
      MAIL_SYSTEM: 'office-mail',
      DOCUMENT_INBOX: '/srv/inbox',
      NOTIFY_CREDENTIAL_REF: 'NOTIFY_MAIL',
      GREEN_API_INSTANCE_REF: 'GREEN_API_INSTANCE',
      GREEN_API_TOKEN_REF: 'GREEN_API_TOKEN',
      DOCUMENT_READS_PER_DAY: '0',
      DELEGATIONS_PER_DAY: '9',
    };
    const cli = io();
    expect(await main(['--business', BUSINESS], cli, env)).toBe(0);
    expect(cli.err).toEqual([]);

    // Settings landed in the row.
    const settings = await withBusiness(BUSINESS, (db) => loadRuntimeSettings(db));
    expect(settings).toMatchObject({
      notifyTo: 'owner@example.com',
      notifySmtpHost: 'smtp.example.com',
      notifySmtpPort: 587,
      notifySmtpSecure: false,
      notifySmtpFrom: 'assistant@example.com',
      notifySmtpUser: 'assistant',
      mailSystem: 'office-mail',
      inboxEnabled: true,
      whatsappEnabled: true,
    });
    expect(settings.caps.documentReadsPerDay).toBe(0);
    expect(settings.caps.delegationsPerDay).toBe(9);
    expect(settings.caps.mailReadsPerDay).toBeNull();

    // The env-named SMTP password is copied to the fixed name, and the old ref stays.
    const fixed = await withBusiness(BUSINESS, (db) => resolveStoredSecret(db, KEY, NOTIFY_SMTP_PASS_REF));
    expect(fixed?.value).toBe(SECRET_VALUES.NOTIFY_MAIL);
    expect((await withBusiness(BUSINESS, (db) => resolveStoredSecret(db, KEY, 'NOTIFY_MAIL')))?.value).toBe(
      SECRET_VALUES.NOTIFY_MAIL,
    );
    // GREEN_API_TOKEN_REF already named the fixed ref — still resolvable there.
    expect((await withBusiness(BUSINESS, (db) => resolveStoredSecret(db, KEY, GREEN_API_TOKEN_REF)))?.value).toBe(
      SECRET_VALUES.GREEN_API_TOKEN,
    );

    // The OAuth clients moved: in the platform store, gone from the business.
    expect(await resolvePlatformSecret(GOOGLE_CLIENT_ID_REF, KEY)).toBe(SECRET_VALUES[GOOGLE_CLIENT_ID_REF]);
    expect(await resolvePlatformSecret(GOOGLE_CLIENT_SECRET_REF, KEY)).toBe(SECRET_VALUES[GOOGLE_CLIENT_SECRET_REF]);
    expect(await withBusiness(BUSINESS, (db) => resolveStoredSecret(db, KEY, GOOGLE_CLIENT_ID_REF))).toBeNull();

    const printed = [...cli.out, ...cli.err].join('\n');
    // Names, including what was missing (the instance secret and Microsoft).
    expect(printed).toContain(GOOGLE_CLIENT_ID_REF);
    expect(printed).toContain(MICROSOFT_CLIENT_ID_REF);
    expect(printed).toContain('GREEN_API_INSTANCE');
    expect(printed).toContain(`NOTIFY_MAIL → ${NOTIFY_SMTP_PASS_REF}`);
    // Never a value.
    for (const value of Object.values(SECRET_VALUES)) expect(printed).not.toContain(value);
  });

  it("turning the inbox on says the files now belong in <DOCUMENT_INBOX_ROOT>/<businessId>, and creates it", async () => {
    const root = await mkdtemp(join(tmpdir(), 'import-inbox-root-'));
    try {
      const cli = io();
      expect(
        await main(['--business', BUSINESS], cli, {
          CREDENTIAL_KEY_PATH: KEY_PATH,
          DOCUMENT_INBOX: '/srv/old-inbox',
          DOCUMENT_INBOX_ROOT: root,
        }),
      ).toBe(0);
      const folder = join(root, BUSINESS);
      expect((await stat(folder)).isDirectory()).toBe(true);
      const printed = cli.out.join('\n');
      expect(printed).toContain(folder);
      expect(printed).toContain('/srv/old-inbox');

      // Without the root: nothing is created, and the operator is told how.
      const unset = io();
      expect(await main(['--business', BUSINESS], unset, { CREDENTIAL_KEY_PATH: KEY_PATH, DOCUMENT_INBOX: '/srv/old-inbox' })).toBe(0);
      expect(unset.out.join('\n')).toContain(`<DOCUMENT_INBOX_ROOT>/${BUSINESS}`);
      expect(unset.out.join('\n')).toMatch(/DOCUMENT_INBOX_ROOT אינו מוגדר/);

      // No inbox in the env: no inbox lines at all.
      const none = io();
      expect(await main(['--business', BUSINESS], none, { CREDENTIAL_KEY_PATH: KEY_PATH })).toBe(0);
      expect(none.out.join('\n')).not.toMatch(/תיבת הקליטה/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never overwrites a different platform value, and leaves the business copy', async () => {
    await putPlatformSecret(GOOGLE_CLIENT_ID_REF, 'already-on-the-server', KEY, 'test');
    await store(GOOGLE_CLIENT_ID_REF, 'this-business-differs');
    const cli = io();
    expect(await main(['--business', BUSINESS], cli, { CREDENTIAL_KEY_PATH: KEY_PATH })).toBe(0);
    expect(await resolvePlatformSecret(GOOGLE_CLIENT_ID_REF, KEY)).toBe('already-on-the-server');
    expect((await withBusiness(BUSINESS, (db) => resolveStoredSecret(db, KEY, GOOGLE_CLIENT_ID_REF)))?.value).toBe(
      'this-business-differs',
    );
    const printed = cli.out.join('\n');
    expect(printed).toMatch(/התנגשות/);
    expect(printed).not.toContain('already-on-the-server');
    expect(printed).not.toContain('this-business-differs');
  });

  it('refuses without a key path and without --business, writing nothing', async () => {
    const noKey = io();
    expect(await main(['--business', BUSINESS], noKey, { APPROVAL_NOTIFY_TO: 'x@example.com' })).toBe(1);
    expect(noKey.err.join('\n')).toMatch(/CREDENTIAL_KEY_PATH/);
    const noBusiness = io();
    expect(await main([], noBusiness, { CREDENTIAL_KEY_PATH: KEY_PATH })).toBe(2);
  });

  it('writes a credential_change audit row for every secret it writes or removes, holding no value', async () => {
    await store('NOTIFY_MAIL', SECRET_VALUES.NOTIFY_MAIL);
    await store(GOOGLE_CLIENT_ID_REF, SECRET_VALUES[GOOGLE_CLIENT_ID_REF]);
    const cli = io();
    expect(
      await main(['--business', BUSINESS], cli, { CREDENTIAL_KEY_PATH: KEY_PATH, NOTIFY_CREDENTIAL_REF: 'NOTIFY_MAIL' }),
    ).toBe(0);

    const { rows } = await testDb().query<{ on_behalf_of: string; reason: string; row: string }>(
      `SELECT on_behalf_of, reason, a::text AS row FROM audit_log a
        WHERE business_id = $1 AND kind = 'credential_change' ORDER BY seq`,
      [BUSINESS],
    );
    // One put (the copy to the fixed name) and one remove (the OAuth client).
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.on_behalf_of === IMPORT_OPERATOR)).toBe(true);
    expect(rows[0]?.reason).toContain(NOTIFY_SMTP_PASS_REF);
    expect(rows[1]?.reason).toContain(GOOGLE_CLIENT_ID_REF);
    for (const r of rows) for (const value of Object.values(SECRET_VALUES)) expect(r.row).not.toContain(value);
  });

  it('refuses a key file that is not the one this installation sealed with, writing nothing', async () => {
    const wrongPath = join(DIR, 'wrong.key');
    await writeFile(wrongPath, randomBytes(KEY_BYTES), { mode: 0o600 });
    const cli = io();
    expect(await main(['--business', BUSINESS], cli, { CREDENTIAL_KEY_PATH: wrongPath, APPROVAL_NOTIFY_TO: 'x@example.com' })).toBe(1);
    const settings = await withBusiness(BUSINESS, (db) => loadRuntimeSettings(db));
    expect(settings.notifyTo).toBeNull();
  });
});
