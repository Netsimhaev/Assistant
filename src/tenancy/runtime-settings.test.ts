import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import {
  CAP_COLUMNS,
  CAP_NAMES,
  RuntimeSettingsError,
  capFor,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from './runtime-settings.js';

const A = 'test-settings-a';
const B = 'test-settings-b';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

describe('runtime settings', () => {
  it('a business with no row has every channel off and every cap at the server default', async () => {
    const settings = await withBusiness(A, (db) => loadRuntimeSettings(db));
    expect(settings.notifyTo).toBeNull();
    expect(settings.whatsappEnabled).toBe(false);
    expect(settings.inboxEnabled).toBe(false);
    for (const name of CAP_NAMES) {
      expect(settings.caps[name]).toBeNull();
      expect(capFor(settings, name)).toBe(config[name]);
    }
  });

  it('capFor falls back to the server default only when NULL', async () => {
    // A stored 0 is the owner turning the feature off — `||` would read it
    // as "unset" and hand back the server's 20.
    expect(config.documentReadsPerDay).toBeGreaterThan(0);
    const saved = await withBusiness(A, (db) =>
      saveRuntimeSettings(db, { caps: { documentReadsPerDay: 0, delegationsPerDay: 7 } }),
    );
    expect(capFor(saved, 'documentReadsPerDay')).toBe(0);
    expect(capFor(saved, 'delegationsPerDay')).toBe(7);
    expect(capFor(saved, 'mailReadsPerDay')).toBe(config.mailReadsPerDay);

    const loaded = await withBusiness(A, (db) => loadRuntimeSettings(db));
    expect(capFor(loaded, 'documentReadsPerDay')).toBe(0);

    // Cleared back to NULL: the default again.
    const cleared = await withBusiness(A, (db) => saveRuntimeSettings(db, { caps: { documentReadsPerDay: null } }));
    expect(capFor(cleared, 'documentReadsPerDay')).toBe(config.documentReadsPerDay);
    expect(capFor(cleared, 'delegationsPerDay')).toBe(7);
  });

  it('a patch changes only the fields it names, and keeps each business apart', async () => {
    await withBusiness(A, (db) => saveRuntimeSettings(db, { notifyTo: 'a@example.com', whatsappEnabled: true }));
    await withBusiness(B, (db) => saveRuntimeSettings(db, { notifyTo: 'b@example.com' }));
    await withBusiness(A, (db) => saveRuntimeSettings(db, { inboxEnabled: true }));

    const a = await withBusiness(A, (db) => loadRuntimeSettings(db));
    const b = await withBusiness(B, (db) => loadRuntimeSettings(db));
    expect(a).toMatchObject({ notifyTo: 'a@example.com', whatsappEnabled: true, inboxEnabled: true });
    expect(b).toMatchObject({ notifyTo: 'b@example.com', whatsappEnabled: false, inboxEnabled: false });
  });

  it('treats an empty text value as unset', async () => {
    const saved = await withBusiness(A, (db) => saveRuntimeSettings(db, { mailSystem: '  ', notifyTo: '' }));
    expect(saved.mailSystem).toBeNull();
    expect(saved.notifyTo).toBeNull();
  });

  it('refuses a negative or fractional cap and a bad port, writing nothing', async () => {
    await expect(
      withBusiness(A, (db) => saveRuntimeSettings(db, { caps: { documentsPerDay: -1 } })),
    ).rejects.toThrow(RuntimeSettingsError);
    await expect(
      withBusiness(A, (db) => saveRuntimeSettings(db, { caps: { documentsPerDay: 1.5 } })),
    ).rejects.toThrow(RuntimeSettingsError);
    await expect(
      withBusiness(A, (db) => saveRuntimeSettings(db, { notifySmtpPort: 0 })),
    ).rejects.toThrow(RuntimeSettingsError);
    const { rows } = await testDb().query('SELECT 1 FROM business_runtime_settings');
    expect(rows).toHaveLength(0);
  });

  it('names one column per cap, and every one exists in the table', async () => {
    const { rows } = await testDb().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'business_runtime_settings'`,
    );
    const columns = new Set(rows.map((r) => r.column_name));
    expect(CAP_NAMES).toHaveLength(12);
    for (const name of CAP_NAMES) expect(columns.has(CAP_COLUMNS[name])).toBe(true);
  });
});
