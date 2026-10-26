import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  ACTION_UPDATE_DEFAULTS,
  loadActionUpdateSettings,
  saveActionUpdateSettings,
} from './action-update-settings.js';

const BUSINESS = 'test-business';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('action update settings', () => {
  it('reads the defaults (email and screen, not WhatsApp) for a business that never chose, without writing a row', async () => {
    expect(ACTION_UPDATE_DEFAULTS).toEqual({ toWhatsApp: false, toEmail: true, toScreen: true });

    const settings = await loadActionUpdateSettings({ businessId: BUSINESS });
    expect(settings).toEqual({ toWhatsApp: false, toEmail: true, toScreen: true });

    const { rows } = await getPool().query('SELECT 1 FROM action_update_settings WHERE business_id = $1', [
      BUSINESS,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('round-trips a choice the owner made, and overwrites it on a second save', async () => {
    await saveActionUpdateSettings(
      { toWhatsApp: true, toEmail: false, toScreen: false },
      { businessId: BUSINESS, updatedBy: 'owner' },
    );
    expect(await loadActionUpdateSettings({ businessId: BUSINESS })).toEqual({
      toWhatsApp: true,
      toEmail: false,
      toScreen: false,
    });

    await saveActionUpdateSettings(
      { toWhatsApp: false, toEmail: true, toScreen: true },
      { businessId: BUSINESS, updatedBy: 'owner' },
    );
    expect(await loadActionUpdateSettings({ businessId: BUSINESS })).toEqual({
      toWhatsApp: false,
      toEmail: true,
      toScreen: true,
    });
  });

  it('keeps one business out of another', async () => {
    await saveActionUpdateSettings(
      { toWhatsApp: true, toEmail: false, toScreen: false },
      { businessId: BUSINESS, updatedBy: 'owner' },
    );
    expect(await loadActionUpdateSettings({ businessId: 'other-business' })).toEqual({
      ...ACTION_UPDATE_DEFAULTS,
    });
  });

  /**
   * The module's own refusal. Proven to be the MODULE that refused, not the
   * database: the message is the Hebrew one only the module throws, and no
   * row exists afterwards — not even an earlier valid choice was overwritten.
   */
  it('refuses to save with every channel off, before touching the database', async () => {
    await saveActionUpdateSettings(
      { toWhatsApp: true, toEmail: false, toScreen: false },
      { businessId: BUSINESS, updatedBy: 'owner' },
    );

    await expect(
      saveActionUpdateSettings(
        { toWhatsApp: false, toEmail: false, toScreen: false },
        { businessId: BUSINESS, updatedBy: 'owner' },
      ),
    ).rejects.toThrow(new Error('חובה לבחור לפחות דרך עדכון אחת'));

    expect(await loadActionUpdateSettings({ businessId: BUSINESS })).toEqual({
      toWhatsApp: true,
      toEmail: false,
      toScreen: false,
    });
  });

  /** The second layer: a raw INSERT that bypasses the module still cannot write "nowhere". */
  it('refuses an all-false row at the database level', async () => {
    await expect(
      getPool().query(
        `INSERT INTO action_update_settings (business_id, to_whatsapp, to_email, to_screen, updated_by)
         VALUES ($1, false, false, false, 'owner')`,
        [BUSINESS],
      ),
    ).rejects.toThrow(/action_update_settings_at_least_one_channel/);
  });
});
