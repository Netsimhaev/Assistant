/**
 * Per-business meeting settings (calendar scheduling, spec §10).
 *
 * Same shape as `ledger/settings.ts`: an absent row reads as the defaults and
 * reading never writes one; refusals are Hebrew sentences returned BEFORE any
 * database write (the migration's CHECKs are the second layer).
 *
 * `locationKind` is `null` until the owner sets it ("חובה בהקמה"): the table
 * column is NOT NULL, so a business with no row reads as `null` and a save
 * without it is refused. No setting here widens authority — they only shape
 * which slots the assistant proposes and when it reminds.
 */
import { getPool, type Queryable } from '../db/pool.js';

export type LocationKind = 'travel' | 'fixed' | 'mixed';

export interface MeetingSettings {
  locationKind: LocationKind | null;
  fixedAddress: string | null;
  gapMinutes: number;
  defaultDurationMinutes: number;
  /** `HH:MM`, both or neither. `null`: the charter's business hours, else 09:00-18:00. */
  workStart: string | null;
  workEnd: string | null;
  /** Empty = every calendar in the account. */
  readCalendarIds: string[];
  /** `null` = the primary calendar. */
  writeCalendarId: string | null;
  reminderHours: number;
  reminderHoursSoon: number;
}

export const MEETING_DEFAULTS: Readonly<MeetingSettings> = Object.freeze({
  locationKind: null,
  fixedAddress: null,
  gapMinutes: 30,
  defaultDurationMinutes: 60,
  workStart: null,
  workEnd: null,
  readCalendarIds: Object.freeze([]) as unknown as string[],
  writeCalendarId: null,
  reminderHours: 24,
  reminderHoursSoon: 2,
});

interface MeetingSettingsRow {
  location_kind: string;
  fixed_address: string | null;
  gap_minutes: number;
  default_duration_minutes: number;
  work_start: string | null;
  work_end: string | null;
  read_calendar_ids: string[];
  write_calendar_id: string | null;
  reminder_hours: number;
  reminder_hours_soon: number;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Postgres `time` arrives as `HH:MM:SS`; the settings carry `HH:MM`. */
function hhmm(value: string | null): string | null {
  return value === null ? null : value.slice(0, 5);
}

function locationKindOf(raw: string): LocationKind | null {
  return raw === 'travel' || raw === 'fixed' || raw === 'mixed' ? raw : null;
}

function toMeetingSettings(row: MeetingSettingsRow): MeetingSettings {
  return {
    locationKind: locationKindOf(row.location_kind),
    fixedAddress: row.fixed_address,
    gapMinutes: row.gap_minutes,
    defaultDurationMinutes: row.default_duration_minutes,
    workStart: hhmm(row.work_start),
    workEnd: hhmm(row.work_end),
    readCalendarIds: [...row.read_calendar_ids],
    writeCalendarId: row.write_calendar_id,
    reminderHours: row.reminder_hours,
    reminderHoursSoon: row.reminder_hours_soon,
  };
}

function defaults(): MeetingSettings {
  return { ...MEETING_DEFAULTS, readCalendarIds: [] };
}

export async function loadMeetingSettings(o: { businessId: string; db?: Queryable }): Promise<MeetingSettings> {
  const db = o.db ?? getPool();
  const { rows } = await db.query<MeetingSettingsRow>(
    `SELECT location_kind, fixed_address, gap_minutes, default_duration_minutes,
            work_start::text AS work_start, work_end::text AS work_end,
            read_calendar_ids, write_calendar_id, reminder_hours, reminder_hours_soon
       FROM meeting_settings WHERE business_id = $1`,
    [o.businessId],
  );
  const row = rows[0];
  return row === undefined ? defaults() : toMeetingSettings(row);
}

const MAX_ADDRESS_CHARS = 300;
const MAX_CALENDARS = 50;
const MAX_CALENDAR_ID_CHARS = 500;
const MAX_REMINDER_HOURS = 24 * 30;

const isInt = (n: unknown, lo: number, hi: number): boolean =>
  typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;

/** The Hebrew reason a settings value is refused, or `null` when it is fine. Pure: no database. */
export function meetingSettingsProblem(s: MeetingSettings): string | null {
  if (s.locationKind !== 'travel' && s.locationKind !== 'fixed' && s.locationKind !== 'mixed') {
    return 'חובה לבחור איפה נערכות הפגישות: אצל הלקוח, במקום קבוע, או גם וגם';
  }
  if (s.fixedAddress !== null && s.fixedAddress.length > MAX_ADDRESS_CHARS) {
    return `הכתובת ארוכה מדי (עד ${MAX_ADDRESS_CHARS} תווים)`;
  }
  if (s.locationKind === 'fixed' && (s.fixedAddress === null || s.fixedAddress.trim() === '')) {
    return 'פגישות במקום קבוע דורשות כתובת של המקום';
  }
  if (!isInt(s.gapMinutes, 0, 240)) return 'הרווח בין פגישות חייב להיות מספר שלם של דקות, בין 0 ל-240';
  if (!isInt(s.defaultDurationMinutes, 5, 600)) return 'משך פגישה רגיל חייב להיות בין 5 ל-600 דקות';

  if ((s.workStart === null) !== (s.workEnd === null)) {
    return 'יש להזין גם שעת התחלה וגם שעת סיום, או להשאיר את שתיהן ריקות';
  }
  if (s.workStart !== null && s.workEnd !== null) {
    if (!HHMM.test(s.workStart) || !HHMM.test(s.workEnd)) {
      return 'שעות העבודה חייבות להיות בפורמט שעה:דקות, למשל 09:00';
    }
    if (s.workStart >= s.workEnd) return 'שעת הסיום חייבת להיות אחרי שעת ההתחלה';
  }

  if (!Array.isArray(s.readCalendarIds) || s.readCalendarIds.length > MAX_CALENDARS) {
    return 'רשימת היומנים לקריאה אינה תקינה';
  }
  for (const id of s.readCalendarIds) {
    if (typeof id !== 'string' || id === '' || id.length > MAX_CALENDAR_ID_CHARS) {
      return 'רשימת היומנים לקריאה אינה תקינה';
    }
  }
  if (s.writeCalendarId !== null) {
    if (typeof s.writeCalendarId !== 'string' || s.writeCalendarId === '' || s.writeCalendarId.length > MAX_CALENDAR_ID_CHARS) {
      return 'יומן הפגישות אינו תקין';
    }
    if (s.readCalendarIds.length > 0 && !s.readCalendarIds.includes(s.writeCalendarId)) {
      return 'יומן הפגישות חייב להיות אחד מהיומנים שהעוזרת קוראת — אחרת היא לא תראה את מה שהיא עצמה קבעה';
    }
  }

  if (!isInt(s.reminderHours, 1, MAX_REMINDER_HOURS)) return 'זמן התזכורת חייב להיות מספר שלם וחיובי של שעות';
  if (!isInt(s.reminderHoursSoon, 1, MAX_REMINDER_HOURS)) {
    return 'זמן התזכורת לפגישה קרובה חייב להיות מספר שלם וחיובי של שעות';
  }
  return null;
}

export async function saveMeetingSettings(
  s: MeetingSettings,
  o: { businessId: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const reason = meetingSettingsProblem(s);
  if (reason !== null) return { ok: false, reason };

  const address = s.fixedAddress === null || s.fixedAddress.trim() === '' ? null : s.fixedAddress.trim();
  await getPool().query(
    `INSERT INTO meeting_settings (business_id, location_kind, fixed_address, gap_minutes, default_duration_minutes,
        work_start, work_end, read_calendar_ids, write_calendar_id, reminder_hours, reminder_hours_soon)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (business_id) DO UPDATE
       SET location_kind = EXCLUDED.location_kind,
           fixed_address = EXCLUDED.fixed_address,
           gap_minutes = EXCLUDED.gap_minutes,
           default_duration_minutes = EXCLUDED.default_duration_minutes,
           work_start = EXCLUDED.work_start,
           work_end = EXCLUDED.work_end,
           read_calendar_ids = EXCLUDED.read_calendar_ids,
           write_calendar_id = EXCLUDED.write_calendar_id,
           reminder_hours = EXCLUDED.reminder_hours,
           reminder_hours_soon = EXCLUDED.reminder_hours_soon,
           updated_at = now()`,
    [
      o.businessId,
      s.locationKind,
      address,
      s.gapMinutes,
      s.defaultDurationMinutes,
      s.workStart,
      s.workEnd,
      s.readCalendarIds,
      s.writeCalendarId,
      s.reminderHours,
      s.reminderHoursSoon,
    ],
  );
  return { ok: true };
}
