/**
 * Pure free-time search (calendar scheduling, spec §6). Epoch-ms intervals;
 * all local-time reasoning goes through `util/local-time.ts` in the charter zone.
 */
import type { z } from 'zod';
import type { CharterOperations as CharterOperationsSchema, Weekday } from '../domain/charter.js';
import { localParts, localToInstant } from '../util/local-time.js';
import type { CalendarSnapshot } from './snapshot.js';

export interface Interval {
  start: number;
  end: number;
}

export type CharterOperations = z.infer<typeof CharterOperationsSchema>;
const MIN_MS = 60_000;
const SLOT_STEP_MS = 15 * MIN_MS;
const DEFAULT_START = '09:00';
const DEFAULT_END = '18:00';

function merge(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** Busy intervals (merged, sorted), each padded by the gap on both sides. */
export function busyIntervals(
  s: CalendarSnapshot,
  gapMinutes: number,
  ignoreEventIds: ReadonlySet<string> = new Set(),
): Interval[] {
  const pad = gapMinutes * MIN_MS;
  const raw: Interval[] = [];
  const listed = new Set<string>();
  for (const e of s.events) {
    listed.add(e.eventId);
    if (!e.busy || e.selfDeclined || ignoreEventIds.has(e.eventId)) continue;
    raw.push({ start: Date.parse(e.start) - pad, end: Date.parse(e.end) + pad });
  }
  for (const h of s.holds) {
    // A hold whose calendar event is already listed is the same busy time.
    if (listed.has(h.eventId) || ignoreEventIds.has(h.eventId)) continue;
    raw.push({ start: Date.parse(h.start) - pad, end: Date.parse(h.end) + pad });
  }
  return merge(raw.filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end)));
}

function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

/** Local work windows for each date in [fromDate, toDate]: workweek days minus holidays. */
export function workWindows(o: {
  fromDate: string;
  toDate: string;
  timeZone: string;
  operations: CharterOperations;
  workStart: string | null;
  workEnd: string | null;
  fromTime?: string | null;
  toTime?: string | null;
}): Interval[] {
  const holidays = new Set(o.operations.holidays.map((h) => h.date));
  const out: Interval[] = [];
  for (let date = o.fromDate, i = 0; date <= o.toDate && i < 400; date = addDays(date, 1), i += 1) {
    const weekday: Weekday = localParts(localToInstant(date, '12:00', o.timeZone), o.timeZone).weekday;
    if (!o.operations.workweek.includes(weekday) || holidays.has(date)) continue;
    let start = DEFAULT_START;
    let end = DEFAULT_END;
    const hours = o.operations.businessHours.find((b) => b.day === weekday);
    if (o.workStart !== null && o.workEnd !== null) {
      start = o.workStart;
      end = o.workEnd;
    } else if (hours !== undefined) {
      start = hours.open;
      end = hours.close;
    }
    if (o.fromTime != null && o.fromTime > start) start = o.fromTime;
    if (o.toTime != null && o.toTime < end) end = o.toTime;
    if (start >= end) continue;
    const a = localToInstant(date, start, o.timeZone).getTime();
    const b = localToInstant(date, end, o.timeZone).getTime();
    if (b > a) out.push({ start: a, end: b });
  }
  return out;
}

/** `work` minus `busy`. */
export function freeIntervals(work: Interval[], busy: Interval[]): Interval[] {
  const blocked = merge(busy);
  const out: Interval[] = [];
  for (const w of merge(work)) {
    let cursor = w.start;
    for (const b of blocked) {
      if (b.end <= cursor) continue;
      if (b.start >= w.end) break;
      if (b.start > cursor) out.push({ start: cursor, end: b.start });
      cursor = Math.max(cursor, b.end);
    }
    if (cursor < w.end) out.push({ start: cursor, end: w.end });
  }
  return out;
}

function roundUp(ms: number): number {
  return Math.ceil(ms / SLOT_STEP_MS) * SLOT_STEP_MS;
}

/**
 * Earliest-first slots: each free interval offers one, starting at its start
 * (a window start or a padded-busy end) — or at `notBefore` when that is later —
 * rounded up to 15 minutes, and only if the whole duration fits.
 * (Epoch rounding equals local rounding: every zone offset is a multiple of 15 min.)
 */
export function findSlots(free: Interval[], durationMinutes: number, limit: number, notBefore: number): Interval[] {
  const duration = durationMinutes * MIN_MS;
  const out: Interval[] = [];
  for (const f of [...free].sort((a, b) => a.start - b.start)) {
    if (out.length >= limit) break;
    const start = roundUp(Math.max(f.start, notBefore));
    if (start >= notBefore && start + duration <= f.end) out.push({ start, end: start + duration });
  }
  return out;
}
