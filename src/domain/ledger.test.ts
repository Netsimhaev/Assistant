import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { LedgerFamily, LedgerStatus, isLedgerOverdue } from './ledger.js';
import { localToInstant } from '../util/local-time.js';
import { ledgerFamilyLabel, ledgerStatusLabel } from './labels.js';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

function insertSettings(whatsapp: boolean, email: boolean, screen: boolean, modes: object) {
  return getPool().query(
    `INSERT INTO ledger_settings
       (business_id, modes, to_whatsapp, to_email, to_screen, meeting_lead_minutes,
        meeting_lead_minutes_critical, due_lead_days_critical, nudge_after_business_days,
        checkin_every_days, checkin_every_days_critical, daily_hour, updated_by)
     VALUES ('b1', $1::jsonb, $2, $3, $4, 60, '{1440,60}', 3, 3, 7, 3, 8, 'test')`,
    [JSON.stringify(modes), whatsapp, email, screen],
  );
}

describe('ledger vocabulary', () => {
  it('lists the six families in order', () => {
    expect(LedgerFamily.options).toEqual([
      'money_in',
      'money_out',
      'meetings',
      'warm_leads',
      'awaiting_reply',
      'projects',
    ]);
  });

  it('has a Hebrew label for every family and status', () => {
    for (const f of LedgerFamily.options) expect(ledgerFamilyLabel[f].length).toBeGreaterThan(0);
    for (const s of LedgerStatus.options) expect(ledgerStatusLabel[s].length).toBeGreaterThan(0);
    expect(ledgerFamilyLabel.money_in).toBe('כסף נכנס');
    expect(ledgerStatusLabel.closed_by_evidence).toBe('נסגר לפי ראיה');
  });
});

describe('migration 052 constraints', () => {
  const okModes = { money_in: 'remind', money_out: 'remind' };

  it('accepts a valid settings row (the code under test runs)', async () => {
    await insertSettings(true, false, false, okModes);
    const r = await getPool().query('SELECT count(*)::int AS n FROM ledger_settings');
    expect(r.rows[0].n).toBe(1);
  });

  it('refuses settings with all three channels off', async () => {
    await expect(insertSettings(false, false, false, okModes)).rejects.toThrow(
      /ledger_settings_at_least_one_channel/,
    );
  });

  it('refuses money_out in act mode', async () => {
    await expect(insertSettings(true, false, false, { money_out: 'act' })).rejects.toThrow(
      /ledger_settings_money_out_remind_only/,
    );
  });
});

describe('isLedgerOverdue', () => {
  const TZ = 'Asia/Jerusalem';
  const L = (date: string, time: string) => localToInstant(date, time, TZ);
  const now = L('2026-11-04', '10:00');
  it('date-only: due today is not overdue (even past the daily hour); due yesterday is', () => {
    expect(isLedgerOverdue({ status: 'open', dueAt: L('2026-11-04', '08:00'), dueIsDateOnly: true }, now, TZ)).toBe(false);
    expect(isLedgerOverdue({ status: 'open', dueAt: L('2026-11-03', '08:00'), dueIsDateOnly: true }, now, TZ)).toBe(true);
  });
  it('timed: overdue once the instant has passed', () => {
    expect(isLedgerOverdue({ status: 'open', dueAt: L('2026-11-04', '09:59'), dueIsDateOnly: false }, now, TZ)).toBe(true);
    expect(isLedgerOverdue({ status: 'open', dueAt: L('2026-11-04', '10:01'), dueIsDateOnly: false }, now, TZ)).toBe(false);
  });
  it('only an open item with a due is overdue', () => {
    expect(isLedgerOverdue({ status: 'stuck', dueAt: L('2026-11-01', '08:00'), dueIsDateOnly: true }, now, TZ)).toBe(false);
    expect(isLedgerOverdue({ status: 'open', dueAt: null, dueIsDateOnly: false }, now, TZ)).toBe(false);
  });
});
