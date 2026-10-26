/**
 * Where the owner hears about an action the assistant performed on her own —
 * WhatsApp, email, the dashboard screen, or any combination, and never none.
 *
 * **At least one channel, in two layers.** An update that goes nowhere is an
 * autonomous action the owner never hears about, which is the one outcome
 * shadow mode exists to prevent. `saveActionUpdateSettings` refuses an
 * all-false choice before touching the database, with the Hebrew sentence the
 * screen shows; migration 047's `action_update_settings_at_least_one_channel`
 * CHECK makes the same row impossible to write from anywhere else.
 *
 * Same shape as `digest-settings.ts`: an absent row reads as the defaults,
 * and reading never writes one — writing on read would turn a question into
 * a decision.
 */
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';

export interface ActionUpdateSettings {
  toWhatsApp: boolean;
  toEmail: boolean;
  toScreen: boolean;
}

/**
 * Email and the screen, not WhatsApp. WhatsApp is not live on any install
 * today (`buildRuntime` reports it as a warning), so a default that chose it
 * would be a channel the owner believes is on and that reaches nobody.
 */
export const ACTION_UPDATE_DEFAULTS: Readonly<ActionUpdateSettings> = Object.freeze({
  toWhatsApp: false,
  toEmail: true,
  toScreen: true,
});

const AT_LEAST_ONE_CHANNEL = 'חובה לבחור לפחות דרך עדכון אחת';

interface SettingsRow {
  to_whatsapp: boolean;
  to_email: boolean;
  to_screen: boolean;
}

function toSettings(row: SettingsRow): ActionUpdateSettings {
  return {
    toWhatsApp: row.to_whatsapp,
    toEmail: row.to_email,
    toScreen: row.to_screen,
  };
}

export async function loadActionUpdateSettings(options: {
  businessId: string;
  db?: Queryable;
}): Promise<ActionUpdateSettings> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<SettingsRow>(
    `SELECT to_whatsapp, to_email, to_screen
       FROM action_update_settings WHERE business_id = $1`,
    [options.businessId],
  );
  const row = rows[0];
  return row === undefined ? { ...ACTION_UPDATE_DEFAULTS } : toSettings(row);
}

export async function saveActionUpdateSettings(
  settings: ActionUpdateSettings,
  options: { businessId: string; updatedBy: string; db?: Queryable },
): Promise<void> {
  if (!(settings.toWhatsApp || settings.toEmail || settings.toScreen)) {
    throw new Error(AT_LEAST_ONE_CHANNEL);
  }
  const db = options.db ?? getPool();
  await db.query(
    `INSERT INTO action_update_settings (business_id, to_whatsapp, to_email, to_screen, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id) DO UPDATE
       SET to_whatsapp = EXCLUDED.to_whatsapp,
           to_email = EXCLUDED.to_email,
           to_screen = EXCLUDED.to_screen,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
    [options.businessId, settings.toWhatsApp, settings.toEmail, settings.toScreen, options.updatedBy],
  );
}
