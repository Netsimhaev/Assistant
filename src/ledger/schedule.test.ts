import { describe, expect, it } from 'vitest';
import type { LedgerItem } from '../domain/ledger.js';
import { localToInstant } from '../util/local-time.js';
import { dueSlots } from './schedule.js';
import { LEDGER_DEFAULTS } from './settings.js';

const TZ = 'Asia/Jerusalem';
const WORKWEEK = ['sun', 'mon', 'tue', 'wed', 'thu'] as const;
const L = (date: string, time: string): Date => localToInstant(date, time, TZ);

function item(over: Partial<LedgerItem>): LedgerItem {
  return {
    itemId: 'LI1', businessId: 'b', family: 'money_in', description: 'x', dueAt: null, dueIsDateOnly: false,
    importance: 'normal', importanceManual: false, counterpartyName: null, counterpartyEmail: null,
    counterpartyEmailVerified: false, counterpartyDomain: null, reference: null, amountMinor: null,
    stages: [], proposedStages: null, status: 'open', nudgeCount: 0, evidenceAfter: new Date(0),
    originJobId: 'j', createdAt: L('2026-11-01', '09:00'), updatedAt: new Date(0), closedAt: null, ...over,
  };
}
const run = (i: LedgerItem, now: Date, lastNudgeAt: Date | null = null, s = LEDGER_DEFAULTS) =>
  dueSlots(i, s, { now, timeZone: TZ, workweek: [...WORKWEEK], holidays: [], lastNudgeAt });

describe('dueSlots', () => {
  const meeting = item({ family: 'meetings', dueAt: L('2026-11-03', '10:00') });

  it('meeting yields before at 09:00 and nothing at 08:59', () => {
    expect(run(meeting, L('2026-11-03', '08:59'))).toEqual([]);
    const s = run(meeting, L('2026-11-03', '09:00'));
    expect(s.map((x) => x.kind)).toEqual(['before']);
    expect(s[0]!.at).toEqual(L('2026-11-03', '09:00'));
  });

  it('critical meeting yields a before slot per lead', () => {
    const c = { ...meeting, importance: 'critical' as const };
    const both = run(c, L('2026-11-03', '09:30'), null, { ...LEDGER_DEFAULTS, meetingLeadMinutesCritical: [120, 60] });
    expect(both.filter((x) => x.kind === 'before')).toHaveLength(2);
    // defaults [1440, 60]: the day-before slot is older than 24h at 09:30
    expect(run(c, L('2026-11-02', '10:30')).map((x) => x.kind)).toEqual(['before']);
  });

  it('held_check appears at 11:00', () => {
    expect(run(meeting, L('2026-11-03', '10:59')).some((x) => x.kind === 'held_check')).toBe(false);
    const s = run(meeting, L('2026-11-03', '11:00'));
    expect(s.find((x) => x.kind === 'held_check')!.at).toEqual(L('2026-11-03', '11:00'));
  });

  it('money_in due today yields due at 08:00 local', () => {
    const m = item({ dueAt: L('2026-11-03', '00:00'), dueIsDateOnly: true });
    expect(run(m, L('2026-11-03', '07:59'))).toEqual([]);
    const s = run(m, L('2026-11-03', '08:00'));
    expect(s.map((x) => x.kind)).toEqual(['due']);
    expect(s[0]!.at).toEqual(L('2026-11-03', '08:00'));
  });

  it('critical adds before dueLeadDaysCritical days earlier', () => {
    const m = item({ dueAt: L('2026-11-05', '00:00'), dueIsDateOnly: true, importance: 'critical' });
    expect(run(m, L('2026-11-02', '08:00')).map((x) => x.kind)).toEqual(['before']);
  });

  it('overdue next day yields overdue + nudge for money_in, then overdue only', () => {
    const m = item({ dueAt: L('2026-11-03', '00:00'), dueIsDateOnly: true });
    const s = run(m, L('2026-11-04', '08:00'));
    expect(s.map((x) => x.kind).sort()).toEqual(['nudge', 'overdue']);
    expect(s.every((x) => x.at.getTime() === L('2026-11-04', '08:00').getTime())).toBe(true);
    expect(run(m, L('2026-11-05', '08:00')).map((x) => x.kind)).toEqual(['overdue']);
  });

  it('awaiting_reply created Thu nudges on Tue (3 business days)', () => {
    const a = item({ family: 'awaiting_reply', createdAt: L('2026-11-05', '10:00') });
    expect(run(a, L('2026-11-09', '12:00'))).toEqual([]);
    const s = run(a, L('2026-11-10', '08:00'));
    expect(s.map((x) => x.kind)).toEqual(['nudge']);
    expect(s[0]!.at).toEqual(L('2026-11-10', '08:00'));
  });

  it('a cadence nudge missed by more than 24h is retried once, at the latest daily hour, under its ORIGINAL key', () => {
    // Created Thu 05/11 10:00 → due Tue 10/11 08:00.
    const a = item({ family: 'awaiting_reply', createdAt: L('2026-11-05', '10:00') });
    const originalKey = `nudge:${L('2026-11-10', '08:00').toISOString()}`;
    for (const [now, emitted] of [
      [L('2026-11-12', '10:00'), L('2026-11-12', '08:00')], // +2 days
      [L('2026-11-25', '07:00'), L('2026-11-24', '08:00')], // +15 days, before today's hour
    ] as const) {
      const nudges = run(a, now).filter((x) => x.kind === 'nudge');
      expect(nudges).toHaveLength(1);
      expect(nudges[0]!.slot).toBe(originalKey);
      expect(nudges[0]!.at).toEqual(emitted);
    }
    // Once claimed, lastNudgeAt moves to the claim and the next cadence follows from it.
    const claimedAt = L('2026-11-12', '10:00');
    expect(run(a, L('2026-11-12', '10:05'), claimedAt).filter((x) => x.kind === 'nudge')).toEqual([]);
    const next = run(a, L('2026-11-17', '08:00'), claimedAt).filter((x) => x.kind === 'nudge');
    expect(next.map((x) => x.slot)).toEqual([`nudge:${L('2026-11-17', '08:00').toISOString()}`]);
    // A warm lead behaves the same; money_in's one-time nudge is NOT retried.
    const w = item({ family: 'warm_leads', createdAt: L('2026-11-05', '10:00') });
    expect(run(w, L('2026-11-12', '10:00')).filter((x) => x.kind === 'nudge')).toHaveLength(1);
    const m = item({ dueAt: L('2026-11-03', '00:00'), dueIsDateOnly: true });
    expect(run(m, L('2026-11-06', '10:00')).filter((x) => x.kind === 'nudge')).toEqual([]);
  });

  it('project pace: 1/5 done at 60% elapsed yields pace; at 40% it does not', () => {
    const stages = [true, false, false, false, false].map((done, i) => ({ title: `s${i}`, done }));
    const p = item({
      family: 'projects', stages, createdAt: L('2026-11-01', '09:00'), dueAt: L('2026-11-11', '09:00'),
    });
    expect(run(p, L('2026-11-07', '09:00')).map((x) => x.kind)).toContain('pace');
    expect(run(p, L('2026-11-05', '09:00')).map((x) => x.kind)).not.toContain('pace');
  });

  it('project without stages gets pace slots at 50% and 80%', () => {
    const p = item({ family: 'projects', createdAt: L('2026-11-01', '09:00'), dueAt: L('2026-11-11', '09:00') });
    expect(run(p, L('2026-11-06', '09:00')).filter((x) => x.kind === 'pace')).toHaveLength(1);
    expect(run(p, L('2026-11-09', '09:00')).filter((x) => x.kind === 'pace')).toHaveLength(1);
  });

  it('project checkin every checkinEveryDays at dailyHour; no due/overdue without dueAt', () => {
    const p = item({ family: 'projects', createdAt: L('2026-11-01', '09:00') });
    const s = run(p, L('2026-11-03', '08:00'));
    expect(s.map((x) => x.kind)).toEqual(['checkin']);
    expect(s[0]!.at).toEqual(L('2026-11-03', '08:00'));
  });

  it('stuck item yields []', () => {
    const m = item({ dueAt: L('2026-11-03', '00:00'), status: 'stuck' });
    expect(run(m, L('2026-11-03', '09:00'))).toEqual([]);
    expect(run({ ...m, status: 'open' }, L('2026-11-03', '09:00')).length).toBeGreaterThan(0);
  });

  it('drops a slot 25h old, keeps one 23h old', () => {
    const m = item({ dueAt: L('2026-11-03', '00:00'), dueIsDateOnly: true });
    const base = L('2026-11-03', '08:00').getTime();
    expect(run(m, new Date(base + 25 * 3600_000)).some((x) => x.kind === 'due')).toBe(false);
    expect(run(m, new Date(base + 23 * 3600_000)).some((x) => x.kind === 'due')).toBe(true);
  });

  it('slot keys are stable across calls with different now', () => {
    const m = item({ dueAt: L('2026-11-03', '00:00'), dueIsDateOnly: true });
    const a = run(m, L('2026-11-03', '08:00'));
    const b = run(m, L('2026-11-03', '15:00'));
    expect(a.length).toBeGreaterThan(0);
    expect(b.map((x) => x.slot)).toEqual(a.map((x) => x.slot));
    expect(a[0]!.slot).toBe(`due:${a[0]!.at.toISOString()}`);
  });
});
