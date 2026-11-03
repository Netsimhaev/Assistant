/**
 * Which reminder slots are due for one ledger item. Pure: no DB, no clock.
 *
 * All day arithmetic is on LOCAL dates in the charter zone (never +24h on an
 * instant, which DST breaks). A slot key is `${kind}:${ISO instant}` of the
 * scheduled instant, so the same slot has the same key on every pass and the
 * claim row dedupes it. Slots older than 24h are dropped (no backfill) —
 * except the warm_leads/awaiting_reply cadence nudge, which is retried once at
 * the latest daily hour under its original key (a missed one would otherwise
 * freeze the cadence forever).
 */
import type { Weekday } from '../domain/charter.js';
import type { LedgerItem } from '../domain/ledger.js';
import { addBusinessDays, localParts, localToInstant } from '../util/local-time.js';
import type { LedgerSettings } from './settings.js';

export type SlotKind = 'before' | 'due' | 'nudge' | 'checkin' | 'held_check' | 'pace' | 'overdue';
export interface DueSlot {
  slot: string;
  kind: SlotKind;
  at: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const HELD_CHECK_AFTER_MIN = 60;
const MAX_DAY_LOOP = 4000;

function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

export function dueSlots(
  item: LedgerItem,
  s: LedgerSettings,
  o: { now: Date; timeZone: string; workweek: Weekday[]; holidays: string[]; lastNudgeAt: Date | null },
): DueSlot[] {
  if (item.status !== 'open') return [];
  const { now, timeZone } = o;
  const nowMs = now.getTime();
  const hh = `${String(s.dailyHour).padStart(2, '0')}:00`;
  const at = (date: string): Date => localToInstant(date, hh, timeZone);
  const out = new Map<string, DueSlot>();
  const add = (kind: SlotKind, when: Date): void => {
    const ms = when.getTime();
    if (!(ms <= nowMs && ms > nowMs - DAY_MS)) return;
    const slot = `${kind}:${when.toISOString()}`;
    out.set(slot, { slot, kind, at: when });
  };

  const today = localParts(now, timeZone).date;
  const critical = item.importance === 'critical';
  const dueDate = item.dueAt ? localParts(item.dueAt, timeZone).date : null;

  if (item.family === 'meetings') {
    if (item.dueAt) {
      const leads = critical ? s.meetingLeadMinutesCritical : [s.meetingLeadMinutes];
      for (const m of leads) add('before', new Date(item.dueAt.getTime() - m * MIN_MS));
      add('held_check', new Date(item.dueAt.getTime() + HELD_CHECK_AFTER_MIN * MIN_MS));
    }
  } else if (dueDate !== null) {
    add('due', at(dueDate));
    if (critical) add('before', at(addDays(dueDate, -s.dueLeadDaysCritical)));
    let firstOverdue = true;
    let day = addDays(dueDate, 1);
    for (let i = 0; day <= today && i < MAX_DAY_LOOP; i += 1, day = addDays(day, 1)) {
      const when = at(day);
      add('overdue', when);
      if (firstOverdue && item.family === 'money_in') add('nudge', when);
      firstOverdue = false;
    }
  }

  if (item.family === 'warm_leads' || item.family === 'awaiting_reply') {
    const when = addBusinessDays(o.lastNudgeAt ?? item.createdAt, s.nudgeAfterBusinessDays, {
      timeZone,
      workweek: o.workweek,
      holidays: o.holidays,
      hour: s.dailyHour,
    });
    if (when.getTime() <= nowMs - DAY_MS) {
      // Missed by more than 24h (scheduler down, daily cap): the cadence
      // would never move again, since only a claim moves lastNudgeAt. Emit
      // it once at the latest daily-hour instant ≤ now, under the ORIGINAL
      // slot key, so it still claims exactly once.
      const todayAt = at(today);
      const emitAt = todayAt.getTime() <= nowMs ? todayAt : at(addDays(today, -1));
      const slot = `nudge:${when.toISOString()}`;
      out.set(slot, { slot, kind: 'nudge', at: emitAt });
    } else {
      add('nudge', when);
    }
  }

  if (item.family === 'projects') {
    const every = critical ? s.checkinEveryDaysCritical : s.checkinEveryDays;
    const created = localParts(item.createdAt, timeZone).date;
    if (every > 0) {
      for (let k = 1; k < MAX_DAY_LOOP; k += 1) {
        const when = at(addDays(created, k * every));
        if (when.getTime() > nowMs) break;
        add('checkin', when);
      }
    }
    if (item.dueAt && item.dueAt.getTime() > item.createdAt.getTime()) {
      const start = item.createdAt.getTime();
      const span = item.dueAt.getTime() - start;
      if (item.stages.length > 0) {
        const done = item.stages.filter((st) => st.done).length / item.stages.length;
        const elapsed = (nowMs - start) / span;
        if (done + 0.25 < elapsed) add('pace', at(today));
      } else {
        for (const f of [0.5, 0.8]) add('pace', new Date(start + span * f));
      }
    }
  }

  return [...out.values()].sort((a, b) => a.at.getTime() - b.at.getTime() || a.kind.localeCompare(b.kind));
}
