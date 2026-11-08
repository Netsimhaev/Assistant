import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { CharterOperations as CharterOperationsSchema } from '../domain/charter.js';
import type { CalendarEvent } from '../calendar/types.js';
import { busyIntervals, findSlots, freeIntervals, workWindows } from './free-time.js';
import type { CalendarSnapshot } from './snapshot.js';

type CharterOperations = z.infer<typeof CharterOperationsSchema>;
const TZ = 'Asia/Jerusalem';
const MIN = 60_000;

function ev(over: Partial<CalendarEvent> & { start: string; end: string }): CalendarEvent {
  return {
    calendarId: 'c', eventId: over.eventId ?? `e-${over.start}`, title: 't', allDay: false, location: null,
    description: null, organizerIsSelf: true, busy: true, selfDeclined: false, transactionId: null, attendees: [],
    ...over,
  };
}
function snap(events: CalendarEvent[], holds: CalendarSnapshot['holds'] = []): CalendarSnapshot {
  return { fromIso: '2026-11-01T00:00:00Z', toIso: '2026-12-01T00:00:00Z', events, calendars: [], truncated: false, holds };
}
const ops = (over: Partial<CharterOperations> = {}): CharterOperations =>
  ({ workweek: ['sun', 'mon', 'tue', 'wed', 'thu'], businessHours: [], holidays: [], ...over }) as CharterOperations;

describe('busyIntervals', () => {
  it('blocks the whole local day for a busy all-day event', () => {
    // Jerusalem is UTC+2 on 2026-11-10: local midnight = 22:00Z the day before.
    const b = busyIntervals(snap([ev({ allDay: true, start: '2026-11-09T22:00:00Z', end: '2026-11-10T22:00:00Z' })]), 0);
    expect(b).toEqual([{ start: Date.parse('2026-11-09T22:00:00Z'), end: Date.parse('2026-11-10T22:00:00Z') }]);
  });

  it('does not block for an all-day event marked free', () => {
    expect(busyIntervals(snap([ev({ allDay: true, busy: false, start: '2026-11-09T22:00:00Z', end: '2026-11-10T22:00:00Z' })]), 30)).toEqual([]);
  });

  it('does not block for an event the owner declined', () => {
    expect(busyIntervals(snap([ev({ selfDeclined: true, start: '2026-11-10T08:00:00Z', end: '2026-11-10T09:00:00Z' })]), 0)).toEqual([]);
  });

  it('splits an event that crosses local midnight across two days', () => {
    const b = busyIntervals(snap([ev({ start: '2026-11-10T21:00:00Z', end: '2026-11-10T23:00:00Z' })]), 0);
    const work = workWindows({ fromDate: '2026-11-10', toDate: '2026-11-12', timeZone: TZ, operations: ops(), workStart: '00:00', workEnd: '23:59' });
    const free = freeIntervals(work, b);
    // Busy 23:00 local on the 10th until 01:00 local on the 11th: day 10 ends there, day 11 resumes after.
    expect(free[0]!.end).toBe(Date.parse('2026-11-10T21:00:00Z'));
    expect(free[1]!.start).toBe(Date.parse('2026-11-10T23:00:00Z'));
  });

  it('pads every busy interval by the gap on both sides', () => {
    const b = busyIntervals(snap([ev({ start: '2026-11-10T08:00:00Z', end: '2026-11-10T09:00:00Z' })]), 30);
    expect(b).toEqual([{ start: Date.parse('2026-11-10T07:30:00Z'), end: Date.parse('2026-11-10T09:30:00Z') }]);
  });

  it('ignores the event being moved', () => {
    const e = ev({ eventId: 'mv', start: '2026-11-10T08:00:00Z', end: '2026-11-10T09:00:00Z' });
    expect(busyIntervals(snap([e]), 30, new Set(['mv']))).toEqual([]);
  });

  it('counts a hold once when its calendar event is also listed', () => {
    const e = ev({ eventId: 'h1', start: '2026-11-10T08:00:00Z', end: '2026-11-10T09:00:00Z' });
    const b = busyIntervals(snap([e], [{ start: e.start, end: e.end, eventId: 'h1' }]), 0);
    expect(b).toHaveLength(1);
  });
});

describe('workWindows', () => {
  it('keeps local work hours across the October DST change', () => {
    const w = workWindows({
      fromDate: '2026-10-24', toDate: '2026-10-26', timeZone: TZ,
      operations: ops({ workweek: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] }), workStart: '09:00', workEnd: '10:00',
    });
    expect(w.map((i) => new Date(i.start).toISOString())).toEqual([
      '2026-10-24T06:00:00.000Z', '2026-10-25T07:00:00.000Z', '2026-10-26T07:00:00.000Z',
    ]);
  });

  it('skips charter holidays and non-workweek days', () => {
    // 2026-11-13 Fri, 11-14 Sat, 11-15 Sun, 11-16 Mon (holiday), 11-17 Tue
    const w = workWindows({
      fromDate: '2026-11-13', toDate: '2026-11-17', timeZone: TZ,
      operations: ops({ holidays: [{ date: '2026-11-16', label: 'x' }] }), workStart: null, workEnd: null,
    });
    expect(w).toHaveLength(2);
    expect(new Date(w[0]!.start).toISOString()).toBe('2026-11-15T07:00:00.000Z');
  });

  it('uses charter business hours, then narrows by fromTime/toTime', () => {
    const o = ops({ businessHours: [{ day: 'sun', open: '08:00', close: '16:00' }] as CharterOperations['businessHours'] });
    const w = workWindows({ fromDate: '2026-11-15', toDate: '2026-11-15', timeZone: TZ, operations: o, workStart: null, workEnd: null, fromTime: '15:00' });
    expect(w).toEqual([{ start: Date.parse('2026-11-15T13:00:00Z'), end: Date.parse('2026-11-15T14:00:00Z') }]);
    expect(workWindows({ fromDate: '2026-11-15', toDate: '2026-11-15', timeZone: TZ, operations: o, workStart: null, workEnd: null, fromTime: '17:00' })).toEqual([]);
  });
});

describe('findSlots', () => {
  it('returns the earliest slot first and rounds to 15 minutes', () => {
    const t = (iso: string): number => Date.parse(iso);
    const work = [{ start: t('2026-11-15T07:00:00Z'), end: t('2026-11-15T16:00:00Z') }];
    const busy = busyIntervals(snap([ev({ start: '2026-11-15T07:30:00Z', end: '2026-11-15T08:10:00Z' })]), 30);
    const free = freeIntervals(work, busy);
    const slots = findSlots(free, 60, 5, 0);
    expect(slots[0]).toEqual({ start: t('2026-11-15T08:45:00Z'), end: t('2026-11-15T09:45:00Z') });
    expect(slots[0]!.start % (15 * MIN)).toBe(0);
  });

  it('never starts before notBefore and requires the whole duration to fit', () => {
    const free = [{ start: 0, end: 60 * MIN }, { start: 210 * MIN, end: 400 * MIN }];
    expect(findSlots(free, 90, 5, 0)).toEqual([{ start: 210 * MIN, end: 300 * MIN }]);
    expect(findSlots(free, 30, 5, 100 * MIN)[0]!.start).toBe(210 * MIN);
    expect(findSlots(free, 30, 1, 0)).toHaveLength(1);
  });
});
