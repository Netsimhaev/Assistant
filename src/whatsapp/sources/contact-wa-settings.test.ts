import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../../db/pool.js';
import { resetDatabase, TEST_BUSINESS } from '../../test/db.js';
import { INVOICE_SETTINGS_REFUSALS, loadContactWaSettings, saveAutoReplyEnabled, saveExternalSources } from './invoice-settings.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('contact whatsapp settings (phase 2 columns)', () => {
  it('defaults to off with no sources, and the switch round trips', async () => {
    expect(await withBusiness(TEST_BUSINESS, (db) => loadContactWaSettings(db))).toEqual({
      autoReplyEnabled: false,
      externalSources: [],
    });
    await withBusiness(TEST_BUSINESS, (db) => saveAutoReplyEnabled(db, true, 'owner'));
    expect((await withBusiness(TEST_BUSINESS, (db) => loadContactWaSettings(db))).autoReplyEnabled).toBe(true);
  });

  it('refuses external sources when there is no readable active charter, saving nothing', async () => {
    const r = await withBusiness(TEST_BUSINESS, (db) =>
      saveExternalSources(db, [{ systemId: 's', operation: 'o', param: 'p', field: 'f' }]),
    );
    expect(r).toEqual({ ok: false, error: INVOICE_SETTINGS_REFUSALS.charterUnreadable });
    expect((await withBusiness(TEST_BUSINESS, (db) => loadContactWaSettings(db))).externalSources).toEqual([]);
  });
});
