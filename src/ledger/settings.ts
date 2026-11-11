/**
 * Per-business ledger settings and the owner's critical rules.
 *
 * Same shape as `action-update-settings.ts`: an absent row reads as the
 * defaults and reading never writes one; refusals are Hebrew sentences thrown
 * before any database write (the migration's CHECKs are the second layer).
 *
 * `meetings` and `projects` are `remind` too (M3): no counterparty nudge
 * exists for them, so `act` would do nothing; the saver refuses it in Hebrew
 * and the loader coerces a stored one.
 *
 * `money_out` is `remind` always. The DB CHECK `modes->>'money_out' = 'remind'`
 * also passes when the key is MISSING, so the loader fills every missing or
 * unknown family from the defaults and forces `money_out` to `remind`, and the
 * saver writes all six keys.
 */
import { monotonicFactory } from 'ulid';
import type { BusinessDb } from '../db/pool.js';
import { LedgerFamily, LedgerMode, type LedgerItem } from '../domain/ledger.js';
import { domainMatches } from '../util/address.js';

const ulid = monotonicFactory();

export interface LedgerSettings {
  modes: Record<LedgerFamily, LedgerMode>;
  toWhatsApp: boolean;
  toEmail: boolean;
  toScreen: boolean;
  meetingLeadMinutes: number;
  meetingLeadMinutesCritical: number[];
  dueLeadDaysCritical: number;
  nudgeAfterBusinessDays: number;
  checkinEveryDays: number;
  checkinEveryDaysCritical: number;
  dailyHour: number;
}

export const LEDGER_DEFAULTS: Readonly<LedgerSettings> = Object.freeze({
  modes: Object.freeze({
    money_in: 'remind',
    money_out: 'remind',
    meetings: 'remind',
    warm_leads: 'remind',
    awaiting_reply: 'remind',
    projects: 'remind',
  }) as Record<LedgerFamily, LedgerMode>,
  toWhatsApp: false,
  toEmail: true,
  toScreen: true,
  meetingLeadMinutes: 60,
  meetingLeadMinutesCritical: Object.freeze([1440, 60]) as unknown as number[],
  dueLeadDaysCritical: 3,
  nudgeAfterBusinessDays: 3,
  checkinEveryDays: 2,
  checkinEveryDaysCritical: 1,
  dailyHour: 8,
});

const NO_CHANNEL = 'חובה לבחור לפחות דרך תזכורת אחת';
const MONEY_OUT_ACT = 'כסף יוצא — רק תזכורת, עד שיהיה כלי תשלום';
/** M3: no counterparty nudge exists for these two, so `act` would do nothing. */
export const NO_ACT_FAMILIES_SENTENCE = 'בפגישות ובעבודות פתוחות אין עדיין פעולה מול הצד השני — רק תזכורת';
/** Families whose `act` mode does nothing (no counterparty nudge) — remind only. */
export const REMIND_ONLY_FAMILIES: readonly LedgerFamily[] = ['money_out', 'meetings', 'projects'];
const BAD_VALUES = 'יש לבחור ערכים תקינים';

interface SettingsRow {
  modes: unknown;
  to_whatsapp: boolean;
  to_email: boolean;
  to_screen: boolean;
  meeting_lead_minutes: number;
  meeting_lead_minutes_critical: number[];
  due_lead_days_critical: number;
  nudge_after_business_days: number;
  checkin_every_days: number;
  checkin_every_days_critical: number;
  daily_hour: number;
}

function modesFrom(raw: unknown): Record<LedgerFamily, LedgerMode> {
  const stored = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...LEDGER_DEFAULTS.modes };
  for (const family of LedgerFamily.options) {
    const parsed = LedgerMode.safeParse(Object.hasOwn(stored, family) ? stored[family] : undefined);
    if (parsed.success) out[family] = parsed.data;
  }
  for (const family of REMIND_ONLY_FAMILIES) out[family] = 'remind';
  return out;
}

function toSettings(row: SettingsRow): LedgerSettings {
  return {
    modes: modesFrom(row.modes),
    toWhatsApp: row.to_whatsapp,
    toEmail: row.to_email,
    toScreen: row.to_screen,
    meetingLeadMinutes: row.meeting_lead_minutes,
    meetingLeadMinutesCritical: [...row.meeting_lead_minutes_critical],
    dueLeadDaysCritical: row.due_lead_days_critical,
    nudgeAfterBusinessDays: row.nudge_after_business_days,
    checkinEveryDays: row.checkin_every_days,
    checkinEveryDaysCritical: row.checkin_every_days_critical,
    dailyHour: row.daily_hour,
  };
}

function defaults(): LedgerSettings {
  return {
    ...LEDGER_DEFAULTS,
    modes: { ...LEDGER_DEFAULTS.modes },
    meetingLeadMinutesCritical: [...LEDGER_DEFAULTS.meetingLeadMinutesCritical],
  };
}

export async function loadLedgerSettings(db: BusinessDb): Promise<LedgerSettings> {
  const { rows } = await db.query<SettingsRow>(
    `SELECT modes, to_whatsapp, to_email, to_screen, meeting_lead_minutes, meeting_lead_minutes_critical,
            due_lead_days_critical, nudge_after_business_days, checkin_every_days,
            checkin_every_days_critical, daily_hour
       FROM ledger_settings WHERE business_id = $1`,
    [db.businessId],
  );
  const row = rows[0];
  return row === undefined ? defaults() : toSettings(row);
}

const inRange = (n: unknown, lo: number, hi: number): boolean =>
  typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;

export async function saveLedgerSettings(
  db: BusinessDb,
  s: LedgerSettings,
  options: { updatedBy: string },
): Promise<void> {
  if (!(s.toWhatsApp || s.toEmail || s.toScreen)) throw new Error(NO_CHANNEL);
  if (s.modes.money_out === 'act') throw new Error(MONEY_OUT_ACT);
  if (s.modes.meetings === 'act' || s.modes.projects === 'act') throw new Error(NO_ACT_FAMILIES_SENTENCE);
  const valid =
    inRange(s.meetingLeadMinutes, 1, 10080) &&
    Array.isArray(s.meetingLeadMinutesCritical) &&
    s.meetingLeadMinutesCritical.every((m) => inRange(m, 1, 10080)) &&
    inRange(s.dueLeadDaysCritical, 1, 30) &&
    inRange(s.nudgeAfterBusinessDays, 1, 30) &&
    inRange(s.checkinEveryDays, 1, 30) &&
    inRange(s.checkinEveryDaysCritical, 1, 30) &&
    inRange(s.dailyHour, 0, 23);
  if (!valid) throw new Error(BAD_VALUES);

  const modes = modesFrom(s.modes);
  await db.query(
    `INSERT INTO ledger_settings (business_id, modes, to_whatsapp, to_email, to_screen, meeting_lead_minutes,
        meeting_lead_minutes_critical, due_lead_days_critical, nudge_after_business_days, checkin_every_days,
        checkin_every_days_critical, daily_hour, updated_by)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (business_id) DO UPDATE
       SET modes = EXCLUDED.modes,
           to_whatsapp = EXCLUDED.to_whatsapp,
           to_email = EXCLUDED.to_email,
           to_screen = EXCLUDED.to_screen,
           meeting_lead_minutes = EXCLUDED.meeting_lead_minutes,
           meeting_lead_minutes_critical = EXCLUDED.meeting_lead_minutes_critical,
           due_lead_days_critical = EXCLUDED.due_lead_days_critical,
           nudge_after_business_days = EXCLUDED.nudge_after_business_days,
           checkin_every_days = EXCLUDED.checkin_every_days,
           checkin_every_days_critical = EXCLUDED.checkin_every_days_critical,
           daily_hour = EXCLUDED.daily_hour,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
    [
      db.businessId,
      JSON.stringify(modes),
      s.toWhatsApp,
      s.toEmail,
      s.toScreen,
      s.meetingLeadMinutes,
      s.meetingLeadMinutesCritical,
      s.dueLeadDaysCritical,
      s.nudgeAfterBusinessDays,
      s.checkinEveryDays,
      s.checkinEveryDaysCritical,
      s.dailyHour,
      options.updatedBy,
    ],
  );
}

// ---------------------------------------------------------------- critical rules

export type CriticalRule = { ruleId: string } & (
  | { kind: 'family'; family: LedgerFamily }
  | { kind: 'amount_over'; amountMinor: number }
  | { kind: 'counterparty'; match: string }
);

/** Distributive Omit: plain Omit over a union collapses it to the common keys. */
export type NewCriticalRule = CriticalRule extends infer R ? (R extends unknown ? Omit<R, 'ruleId'> : never) : never;

interface RuleRow {
  rule_id: string;
  kind: string;
  family: string | null;
  amount_minor: string | number | null;
  match: string | null;
}

function toRule(row: RuleRow): CriticalRule | null {
  if (row.kind === 'family') {
    const family = LedgerFamily.safeParse(row.family);
    return family.success ? { ruleId: row.rule_id, kind: 'family', family: family.data } : null;
  }
  if (row.kind === 'amount_over' && row.amount_minor !== null) {
    return { ruleId: row.rule_id, kind: 'amount_over', amountMinor: Number(row.amount_minor) };
  }
  if (row.kind === 'counterparty' && row.match !== null) {
    return { ruleId: row.rule_id, kind: 'counterparty', match: row.match };
  }
  return null;
}

export async function listCriticalRules(db: BusinessDb): Promise<CriticalRule[]> {
  const { rows } = await db.query<RuleRow>(
    `SELECT rule_id, kind, family, amount_minor, match
       FROM ledger_critical_rules WHERE business_id = $1 ORDER BY rule_id`,
    [db.businessId],
  );
  return rows.flatMap((r) => {
    const rule = toRule(r);
    return rule === null ? [] : [rule];
  });
}

export async function addCriticalRule(
  db: BusinessDb,
  rule: NewCriticalRule,
  options: { by: string },
): Promise<CriticalRule> {
  let family: LedgerFamily | null = null;
  let amountMinor: number | null = null;
  let match: string | null = null;
  if (rule.kind === 'family') {
    const parsed = LedgerFamily.safeParse(rule.family);
    if (!parsed.success) throw new Error('סוג המשימה אינו מוכר');
    family = parsed.data;
  } else if (rule.kind === 'amount_over') {
    if (!Number.isInteger(rule.amountMinor) || rule.amountMinor <= 0) {
      throw new Error('הסכום חייב להיות מספר חיובי');
    }
    amountMinor = rule.amountMinor;
  } else {
    match = typeof rule.match === 'string' ? rule.match.trim().toLowerCase() : '';
    if (match === '') throw new Error('חובה להזין שם, כתובת או דומיין');
  }
  const ruleId = `LC-${ulid()}`;
  await db.query(
    `INSERT INTO ledger_critical_rules (rule_id, business_id, kind, family, amount_minor, match, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ruleId, db.businessId, rule.kind, family, amountMinor, match, options.by],
  );
  if (family !== null) return { ruleId, kind: 'family', family };
  if (amountMinor !== null) return { ruleId, kind: 'amount_over', amountMinor };
  return { ruleId, kind: 'counterparty', match: match ?? '' };
}

export async function removeCriticalRule(db: BusinessDb, ruleId: string): Promise<void> {
  await db.query(`DELETE FROM ledger_critical_rules WHERE rule_id = $1 AND business_id = $2`, [
    ruleId,
    db.businessId,
  ]);
}

export function matchesCriticalRule(
  item: Pick<LedgerItem, 'family' | 'amountMinor' | 'counterpartyName' | 'counterpartyEmail' | 'counterpartyDomain'>,
  rules: CriticalRule[],
): boolean {
  const email = item.counterpartyEmail?.trim().toLowerCase() ?? null;
  const name = item.counterpartyName?.trim().toLowerCase() ?? null;
  const emailDomain = email !== null && email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : null;
  const domains = [item.counterpartyDomain?.trim().toLowerCase() ?? null, emailDomain].filter(
    (d): d is string => d !== null && d !== '',
  );
  return rules.some((rule) => {
    if (rule.kind === 'family') return item.family === rule.family;
    if (rule.kind === 'amount_over') return item.amountMinor !== null && item.amountMinor > rule.amountMinor;
    const m = rule.match.trim().toLowerCase();
    if (m === '') return false;
    return email === m || name === m || domains.some((d) => domainMatches(d, m));
  });
}
