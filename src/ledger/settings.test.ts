import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import {
  LEDGER_DEFAULTS,
  addCriticalRule,
  listCriticalRules,
  loadLedgerSettings,
  matchesCriticalRule,
  removeCriticalRule,
  saveLedgerSettings,
  type CriticalRule,
  type NewCriticalRule,
  type LedgerSettings,
} from './settings.js';

const B = 'biz-a';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const save = (s: LedgerSettings) => withBusiness(B, (db) => saveLedgerSettings(db, s, { updatedBy: 'owner' }));

describe('ledger settings', () => {
  it('returns defaults when the row is absent and writes nothing', async () => {
    const s = await withBusiness(B, (db) => loadLedgerSettings(db));
    expect(s).toEqual(LEDGER_DEFAULTS);
    expect(s.toEmail).toBe(true);
    expect(s.toWhatsApp).toBe(false);
    const { rows } = await testDb().query('SELECT 1 FROM ledger_settings');
    expect(rows).toHaveLength(0);
  });

  it('refuses a save with no channel, in Hebrew, writing nothing', async () => {
    await expect(save({ ...LEDGER_DEFAULTS, toEmail: false, toScreen: false, toWhatsApp: false })).rejects.toThrow(
      'חובה לבחור לפחות דרך תזכורת אחת',
    );
    const { rows } = await testDb().query('SELECT 1 FROM ledger_settings');
    expect(rows).toHaveLength(0);
  });

  it('refuses act on money_out', async () => {
    await expect(
      save({ ...LEDGER_DEFAULTS, modes: { ...LEDGER_DEFAULTS.modes, money_out: 'act' } }),
    ).rejects.toThrow('כסף יוצא — רק תזכורת, עד שיהיה כלי תשלום');
    const { rows } = await testDb().query('SELECT 1 FROM ledger_settings');
    expect(rows).toHaveLength(0);
  });

  it('refuses out-of-range numbers', async () => {
    const msg = 'יש לבחור ערכים תקינים';
    await expect(save({ ...LEDGER_DEFAULTS, dailyHour: 24 })).rejects.toThrow(msg);
    await expect(save({ ...LEDGER_DEFAULTS, meetingLeadMinutes: 0 })).rejects.toThrow(msg);
    await expect(save({ ...LEDGER_DEFAULTS, checkinEveryDays: 31 })).rejects.toThrow(msg);
    await expect(save({ ...LEDGER_DEFAULTS, meetingLeadMinutesCritical: [10081] })).rejects.toThrow(msg);
    await expect(save({ ...LEDGER_DEFAULTS, nudgeAfterBusinessDays: 1.5 })).rejects.toThrow(msg);
  });

  it('round-trips and writes all six mode keys', async () => {
    const s: LedgerSettings = {
      ...LEDGER_DEFAULTS,
      modes: { ...LEDGER_DEFAULTS.modes, warm_leads: 'act' },
      toWhatsApp: true,
      toEmail: false,
      meetingLeadMinutes: 30,
      meetingLeadMinutesCritical: [2880, 120, 15],
      dailyHour: 7,
    };
    await save(s);
    expect(await withBusiness(B, (db) => loadLedgerSettings(db))).toEqual(s);
    const { rows } = await testDb().query('SELECT modes FROM ledger_settings');
    expect(Object.keys(rows[0].modes).sort()).toEqual([
      'awaiting_reply',
      'meetings',
      'money_in',
      'money_out',
      'projects',
      'warm_leads',
    ]);
  });

  it('loads money_out as remind when the stored modes JSON lacks the key', async () => {
    await testDb().query(
      `INSERT INTO ledger_settings (business_id, modes, to_whatsapp, to_email, to_screen, meeting_lead_minutes,
         meeting_lead_minutes_critical, due_lead_days_critical, nudge_after_business_days, checkin_every_days,
         checkin_every_days_critical, daily_hour, updated_by)
       VALUES ($1, '{"meetings":"act","bogus":"act"}', false, true, true, 60, '{1440,60}', 3, 3, 2, 1, 8, 'x')`,
      [B],
    );
    const s = await withBusiness(B, (db) => loadLedgerSettings(db));
    expect(s.modes.money_out).toBe('remind');
    // M3: a stored act on meetings is coerced to remind (no counterparty nudge exists).
    expect(s.modes.meetings).toBe('remind');
    expect(s.modes.money_in).toBe('remind');
  });

  it('M3: refuses act on meetings and on projects, in Hebrew, writing nothing', async () => {
    const msg = 'בפגישות ובעבודות פתוחות אין עדיין פעולה מול הצד השני — רק תזכורת';
    await expect(save({ ...LEDGER_DEFAULTS, modes: { ...LEDGER_DEFAULTS.modes, meetings: 'act' } })).rejects.toThrow(msg);
    await expect(save({ ...LEDGER_DEFAULTS, modes: { ...LEDGER_DEFAULTS.modes, projects: 'act' } })).rejects.toThrow(msg);
    const { rows } = await testDb().query('SELECT 1 FROM ledger_settings');
    expect(rows).toHaveLength(0);
    // The saver did run: act on a family that has a nudge is accepted.
    await save({ ...LEDGER_DEFAULTS, modes: { ...LEDGER_DEFAULTS.modes, awaiting_reply: 'act' } });
    expect((await withBusiness(B, (db) => loadLedgerSettings(db))).modes.awaiting_reply).toBe('act');
  });

  it('M3: a stored act on projects loads as remind; act on warm_leads is kept', async () => {
    await testDb().query(
      `INSERT INTO ledger_settings (business_id, modes, to_whatsapp, to_email, to_screen, meeting_lead_minutes,
         meeting_lead_minutes_critical, due_lead_days_critical, nudge_after_business_days, checkin_every_days,
         checkin_every_days_critical, daily_hour, updated_by)
       VALUES ($1, '{"projects":"act","warm_leads":"act","money_out":"remind"}', false, true, true, 60, '{1440,60}', 3, 3, 2, 1, 8, 'x')`,
      [B],
    );
    const s = await withBusiness(B, (db) => loadLedgerSettings(db));
    expect(s.modes.projects).toBe('remind');
    expect(s.modes.warm_leads).toBe('act');
  });
});

describe('critical rules', () => {
  it('adds, lists (scoped by business) and removes', async () => {
    const r = await withBusiness(B, (db) => addCriticalRule(db, { kind: 'counterparty', match: 'DANA@X.co' }, { by: 'owner' }));
    expect(r.ruleId).toMatch(/^LC-/);
    expect(r).toMatchObject({ kind: 'counterparty', match: 'dana@x.co' });
    await withBusiness(B, (db) => addCriticalRule(db, { kind: 'family', family: 'money_in' }, { by: 'owner' }));
    await withBusiness('other', (db) => addCriticalRule(db, { kind: 'amount_over', amountMinor: 500000 }, { by: 'owner' }));
    expect(await withBusiness(B, (db) => listCriticalRules(db))).toHaveLength(2);
    await withBusiness('other', (db) => removeCriticalRule(db, r.ruleId));
    expect(await withBusiness(B, (db) => listCriticalRules(db))).toHaveLength(2);
    await withBusiness(B, (db) => removeCriticalRule(db, r.ruleId));
    expect(await withBusiness(B, (db) => listCriticalRules(db))).toHaveLength(1);
  });

  it('refuses an empty counterparty match and a non-positive-integer amount, in Hebrew', async () => {
    const o = { businessId: B, by: 'owner' };
    await expect(withBusiness(B, (db) => addCriticalRule(db, { kind: 'counterparty', match: '   ' }, o))).rejects.toThrow(/[א-ת]/);
    await expect(withBusiness(B, (db) => addCriticalRule(db, { kind: 'amount_over', amountMinor: 0 }, o))).rejects.toThrow(/[א-ת]/);
    await expect(withBusiness(B, (db) => addCriticalRule(db, { kind: 'amount_over', amountMinor: 1.5 }, o))).rejects.toThrow(/[א-ת]/);
    await expect(withBusiness(B, (db) => addCriticalRule(db, { kind: 'amount_over', amountMinor: -5 }, o))).rejects.toThrow(/[א-ת]/);
    expect(await withBusiness(B, (db) => listCriticalRules(db))).toHaveLength(0);
  });
});

describe('matchesCriticalRule', () => {
  const item = (o: Partial<Parameters<typeof matchesCriticalRule>[0]> = {}): Parameters<typeof matchesCriticalRule>[0] => ({
    family: 'money_in',
    amountMinor: null,
    counterpartyName: null,
    counterpartyEmail: null,
    counterpartyDomain: null,
    ...o,
  });
  const rule = (r: NewCriticalRule): CriticalRule => ({ ruleId: 'LC-1', ...r }) as CriticalRule;

  it('matches by family', () => {
    expect(matchesCriticalRule(item(), [rule({ kind: 'family', family: 'money_in' })])).toBe(true);
    expect(matchesCriticalRule(item(), [rule({ kind: 'family', family: 'projects' })])).toBe(false);
    expect(matchesCriticalRule(item(), [])).toBe(false);
  });

  it('amount_over is strict', () => {
    const r = [rule({ kind: 'amount_over', amountMinor: 500000 })];
    expect(matchesCriticalRule(item({ amountMinor: 500000 }), r)).toBe(false);
    expect(matchesCriticalRule(item({ amountMinor: 500001 }), r)).toBe(true);
    expect(matchesCriticalRule(item({ amountMinor: null }), r)).toBe(false);
  });

  it('counterparty matches email case-insensitively, domain label-anchored, and name', () => {
    const e = [rule({ kind: 'counterparty', match: 'dana@x.co' })];
    expect(matchesCriticalRule(item({ counterpartyEmail: 'DANA@X.co' }), e)).toBe(true);
    expect(matchesCriticalRule(item({ counterpartyEmail: 'other@x.co' }), e)).toBe(false);
    const d = [rule({ kind: 'counterparty', match: 'x.co' })];
    expect(matchesCriticalRule(item({ counterpartyEmail: 'a@sub.x.co' }), d)).toBe(true);
    expect(matchesCriticalRule(item({ counterpartyDomain: 'sub.x.co' }), d)).toBe(true);
    expect(matchesCriticalRule(item({ counterpartyEmail: 'a@notx.co' }), d)).toBe(false);
    const n = [rule({ kind: 'counterparty', match: 'דנה כהן' })];
    expect(matchesCriticalRule(item({ counterpartyName: 'דנה כהן' }), n)).toBe(true);
    expect(matchesCriticalRule(item({ counterpartyName: 'דנה' }), n)).toBe(false);
  });
});
