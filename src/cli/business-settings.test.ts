import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { loadRuntimeSettings } from '../tenancy/runtime-settings.js';
import { BUSINESS_ARG_EXIT_CODE } from './business-arg.js';
import { main, parseSettingsArgs } from './business-settings.js';

const BUSINESS = 'test-cli-settings';

function io(): { log: (l: string) => void; error: (l: string) => void; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { log: (l) => out.push(l), error: (l) => err.push(l), out, err };
}

beforeEach(async () => {
  await resetDatabase();
  await registerBusiness(BUSINESS);
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

describe('business:settings', () => {
  it('writes the flags it is given and prints the resulting row', async () => {
    const cli = io();
    const code = await main(
      [
        '--business', BUSINESS,
        '--notify-to', 'owner@example.com',
        '--smtp-host', 'smtp.example.com',
        '--smtp-port', '587',
        '--smtp-secure=off',
        '--whatsapp', 'on',
        '--inbox', 'off',
        '--cap', 'document_reads_per_day=0',
        '--cap', 'delegationsPerDay=5',
      ],
      cli,
    );
    expect(cli.err).toEqual([]);
    expect(code).toBe(0);

    const settings = await withBusiness(BUSINESS, (db) => loadRuntimeSettings(db));
    expect(settings).toMatchObject({
      notifyTo: 'owner@example.com',
      notifySmtpHost: 'smtp.example.com',
      notifySmtpPort: 587,
      notifySmtpSecure: false,
      whatsappEnabled: true,
      inboxEnabled: false,
    });
    expect(settings.caps.documentReadsPerDay).toBe(0);
    expect(settings.caps.delegationsPerDay).toBe(5);

    const printed = cli.out.join('\n');
    expect(printed).toContain('owner@example.com');
    expect(printed).toMatch(/document_reads_per_day\s+0/);
    expect(printed).toContain(`${config.mailReadsPerDay} (ברירת המחדל של השרת)`);
  });

  it('a cap set to default goes back to the server value', async () => {
    await main(['--business', BUSINESS, '--cap', 'documents_per_day=3'], io());
    await main(['--business', BUSINESS, '--cap', 'documents_per_day=default'], io());
    const settings = await withBusiness(BUSINESS, (db) => loadRuntimeSettings(db));
    expect(settings.caps.documentsPerDay).toBeNull();
  });

  it('with no flag writes nothing and prints the row', async () => {
    const cli = io();
    expect(await main(['--business', BUSINESS], cli)).toBe(0);
    const { rows } = await testDb().query('SELECT 1 FROM business_runtime_settings');
    expect(rows).toHaveLength(0);
    expect(cli.out.join('\n')).toContain('whatsapp_enabled             off');
  });

  it('refuses an unknown cap, a bad switch value and an unknown flag, writing nothing', async () => {
    expect(() => parseSettingsArgs(['--cap', 'no_such_cap=1'])).toThrow(/תקרה לא מוכרת/);
    expect(() => parseSettingsArgs(['--whatsapp', 'yes'])).toThrow(/on או off/);
    expect(() => parseSettingsArgs(['--smtp-port', '-1'])).toThrow(/מספר שלם/);
    expect(() => parseSettingsArgs(['--frobnicate', '1'])).toThrow(/דגל לא מוכר/);
    expect(() => parseSettingsArgs(['--smtp-host', '--inbox', 'on'])).toThrow(/חסר ערך/);

    const cli = io();
    expect(await main(['--business', BUSINESS, '--cap', 'no_such_cap=1'], cli)).toBe(1);
    const { rows } = await testDb().query('SELECT 1 FROM business_runtime_settings');
    expect(rows).toHaveLength(0);
  });

  it('refuses an unknown business before writing anything', async () => {
    const cli = io();
    expect(await main(['--business', 'test-no-such-business', '--whatsapp', 'on'], cli)).toBe(BUSINESS_ARG_EXIT_CODE);
    const { rows } = await testDb().query('SELECT 1 FROM business_runtime_settings');
    expect(rows).toHaveLength(0);
  });
});
