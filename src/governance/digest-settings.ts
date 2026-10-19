import { z } from 'zod';
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';

export const DigestSchedule = z.enum(['off', 'daily', 'weekly', 'both']);
export type DigestSchedule = z.infer<typeof DigestSchedule>;

export interface DigestSettings {
  schedule: DigestSchedule;
  dailyHour: number;
  weeklyDay: number;
  weeklyHour: number;
  toEmail: boolean;
  toWhatsApp: boolean;
  updatedAt: string;
  updatedBy: string;
}

/**
 * **Off, and every channel but the screen disabled.** Spec §4: a fresh
 * installation does not start sending before the owner asked — the same
 * default `autonomy_mode` ('off') and `DOCUMENT_INBOX` (absent) already hold,
 * and for the same reason: a switch that starts on is a switch nobody chose.
 *
 * Returned for a business with no row at all, and `loadDigestSettings` does
 * NOT write one. An absent row and a row saying 'off' mean the same thing to
 * every reader, and writing on read would turn a question into a decision.
 */
export const DIGEST_DEFAULTS: Readonly<DigestSettings> = Object.freeze({
  schedule: 'off',
  dailyHour: 8,
  weeklyDay: 0,
  weeklyHour: 8,
  toEmail: false,
  toWhatsApp: false,
  updatedAt: '',
  updatedBy: '',
});

interface SettingsRow {
  schedule: string;
  daily_hour: number;
  weekly_day: number;
  weekly_hour: number;
  to_email: boolean;
  to_whatsapp: boolean;
  updated_at: string;
  updated_by: string;
}

function toSettings(row: SettingsRow): DigestSettings {
  return {
    schedule: DigestSchedule.parse(row.schedule),
    dailyHour: row.daily_hour,
    weeklyDay: row.weekly_day,
    weeklyHour: row.weekly_hour,
    toEmail: row.to_email,
    toWhatsApp: row.to_whatsapp,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

const COLUMNS = `schedule, daily_hour, weekly_day, weekly_hour, to_email, to_whatsapp,
                 updated_at::text AS updated_at, updated_by`;

export async function loadDigestSettings(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<DigestSettings> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<SettingsRow>(
    `SELECT ${COLUMNS} FROM digest_settings WHERE business_id = $1`,
    [businessId],
  );

  const row = rows[0];
  return row === undefined ? { ...DIGEST_DEFAULTS } : toSettings(row);
}

export async function setDigestSettings(
  input: Omit<DigestSettings, 'updatedAt' | 'updatedBy'>,
  updatedBy: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<DigestSettings> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<SettingsRow>(
    `INSERT INTO digest_settings
       (business_id, schedule, daily_hour, weekly_day, weekly_hour, to_email, to_whatsapp, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (business_id) DO UPDATE
       SET schedule = EXCLUDED.schedule,
           daily_hour = EXCLUDED.daily_hour,
           weekly_day = EXCLUDED.weekly_day,
           weekly_hour = EXCLUDED.weekly_hour,
           to_email = EXCLUDED.to_email,
           to_whatsapp = EXCLUDED.to_whatsapp,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by
     RETURNING ${COLUMNS}`,
    [businessId, input.schedule, input.dailyHour, input.weeklyDay, input.weeklyHour,
     input.toEmail, input.toWhatsApp, updatedBy],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('digest settings vanished mid-upsert');
  return toSettings(row);
}
