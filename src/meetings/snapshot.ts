/**
 * Calendar snapshot (calendar scheduling, spec §6): every chosen calendar for a
 * range, plus our own `held` placeholders. Any provider failure is returned as
 * the failure — a partial snapshot would offer slots over events never read.
 */
import type { CalendarAccess } from '../calendar/client-for.js';
import { isCalendarFailure, type CalendarEvent, type CalendarFailure, type CalendarInfo } from '../calendar/types.js';
import type { BusinessDb } from '../db/pool.js';
import type { MeetingSettings } from './settings.js';

export const SNAPSHOT_MAX_EVENTS = 500;

export interface CalendarSnapshot {
  fromIso: string;
  toIso: string;
  events: CalendarEvent[];
  calendars: CalendarInfo[];
  truncated: boolean;
  holds: { start: string; end: string; eventId: string }[];
}

interface HoldRow {
  event_id: string;
  start_at: Date;
  end_at: Date;
}

export async function loadCalendarRange(db: BusinessDb, o: {
  access: CalendarAccess;
  settings: MeetingSettings;
  timeZone: string;
  fromIso: string;
  toIso: string;
  signal: AbortSignal;
}): Promise<CalendarSnapshot | CalendarFailure> {
  const { client, token } = o.access;
  const all = await client.listCalendars(token, o.signal);
  if (isCalendarFailure(all)) return all;

  const wanted = o.settings.readCalendarIds;
  const calendars = wanted.length === 0 ? all : all.filter((c) => wanted.includes(c.calendarId));

  const events: CalendarEvent[] = [];
  let truncated = false;
  for (const calendar of calendars) {
    const remaining = SNAPSHOT_MAX_EVENTS - events.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const r = await client.listEvents(
      token,
      { calendarId: calendar.calendarId, fromIso: o.fromIso, toIso: o.toIso, timeZone: o.timeZone, maxEvents: remaining },
      o.signal,
    );
    if (isCalendarFailure(r)) return r;
    events.push(...r.events);
    if (r.truncated) truncated = true;
  }

  const { rows } = await db.query<HoldRow>(
    `SELECT event_id, start_at, end_at FROM meeting_holds
      WHERE business_id = $1 AND state = 'held' AND start_at < $3::timestamptz AND end_at > $2::timestamptz`,
    [db.businessId, o.fromIso, o.toIso],
  );
  const holds = rows.map((r) => ({ start: r.start_at.toISOString(), end: r.end_at.toISOString(), eventId: r.event_id }));

  return { fromIso: o.fromIso, toIso: o.toIso, events, calendars, truncated, holds };
}
