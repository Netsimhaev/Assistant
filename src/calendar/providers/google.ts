import { createHash } from 'node:crypto';
import { localToInstant } from '../../util/local-time.js';
import {
  asRecord,
  defaultCalendarHttp,
  failureFromStatus,
  guarded,
  ok2xx,
  plainOrNull,
  str,
  type AttendeeResponse,
  type CalendarClient,
  type CalendarEvent,
  type CalendarHttp,
  type EventWrite,
} from '../types.js';

const BASE = 'https://www.googleapis.com/calendar/v3';
const PAGE_SIZE = 250;
const B32HEX = '0123456789abcdefghijklmnopqrstuv';

/** base32hex (RFC 4648 extended hex), lowercase, no padding. */
function base32hex(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32HEX[(value << (5 - bits)) & 31];
  return out;
}

/** Google event ids: 5-1024 chars of [a-v0-9]. Deterministic from the idempotency key. */
export function googleEventId(idempotencyKey: string): string {
  return ('a' + base32hex(createHash('sha256').update(idempotencyKey).digest())).slice(0, 40);
}

const RESPONSES: Record<string, AttendeeResponse> = {
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'tentative',
  needsAction: 'needs_action',
};

function instantOf(point: Record<string, unknown>, timeZone: string): { iso: string; allDay: boolean } | null {
  const date = str(point['date']);
  if (date !== null) return { iso: localToInstant(date, '00:00', timeZone).toISOString(), allDay: true };
  const dateTime = str(point['dateTime']);
  if (dateTime === null) return null;
  const ms = Date.parse(dateTime);
  return Number.isNaN(ms) ? null : { iso: new Date(ms).toISOString(), allDay: false };
}

function toEvent(calendarId: string, raw: unknown, timeZone: string): CalendarEvent | null {
  const e = asRecord(raw);
  const eventId = str(e['id']);
  const start = instantOf(asRecord(e['start']), timeZone);
  const end = instantOf(asRecord(e['end']), timeZone);
  if (eventId === null || start === null || end === null) return null;
  const attendeesRaw = Array.isArray(e['attendees']) ? e['attendees'] : [];
  let selfDeclined = false;
  const attendees: CalendarEvent['attendees'] = [];
  for (const a of attendeesRaw) {
    const r = asRecord(a);
    if (r['self'] === true && r['responseStatus'] === 'declined') selfDeclined = true;
    const email = str(r['email']);
    if (email === null) continue;
    attendees.push({ email, response: RESPONSES[String(r['responseStatus'])] ?? 'needs_action' });
  }
  return {
    calendarId,
    eventId,
    title: str(e['summary']) ?? '',
    start: start.iso,
    end: end.iso,
    allDay: start.allDay,
    location: str(e['location']),
    description: plainOrNull(e['description']),
    organizerIsSelf: asRecord(e['organizer'])['self'] === true,
    busy: e['transparency'] !== 'transparent',
    selfDeclined,
    transactionId: null,
    attendees,
  };
}

function bodyOf(w: Partial<EventWrite>): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (w.title !== undefined) b['summary'] = w.title;
  if (w.start !== undefined) b['start'] = { dateTime: w.start };
  if (w.end !== undefined) b['end'] = { dateTime: w.end };
  if (w.location !== undefined) b['location'] = w.location ?? '';
  if (w.description !== undefined) b['description'] = w.description ?? '';
  if (w.attendees !== undefined) b['attendees'] = w.attendees.map((email) => ({ email }));
  return b;
}

const cal = (id: string): string => `${BASE}/calendars/${encodeURIComponent(id)}`;

export function createGoogleCalendarClient(http: CalendarHttp = defaultCalendarHttp()): CalendarClient {
  return {
    listCalendars: (token, signal) =>
      guarded(async () => {
        const out: { calendarId: string; name: string; primary: boolean; canWrite: boolean }[] = [];
        let pageToken: string | null = null;
        do {
          const url: string = `${BASE}/users/me/calendarList?maxResults=250${pageToken === null ? '' : `&pageToken=${encodeURIComponent(pageToken)}`}`;
          const r: { status: number; body: unknown } = await http.request({ method: 'GET', url, accessToken: token, signal });
          if (!ok2xx(r.status)) return failureFromStatus(r.status, r.body);
          const body = asRecord(r.body);
          for (const item of Array.isArray(body['items']) ? body['items'] : []) {
            const c = asRecord(item);
            const id = str(c['id']);
            if (id === null) continue;
            const role = c['accessRole'];
            out.push({
              calendarId: id,
              name: str(c['summaryOverride']) ?? str(c['summary']) ?? id,
              primary: c['primary'] === true,
              canWrite: role === 'owner' || role === 'writer',
            });
          }
          pageToken = str(body['nextPageToken']);
        } while (pageToken !== null);
        return out;
      }),

    listEvents: (token, q, signal) =>
      guarded(async () => {
        const events: CalendarEvent[] = [];
        let truncated = false;
        let pageToken: string | null = null;
        do {
          const params = new URLSearchParams({
            singleEvents: 'true',
            orderBy: 'startTime',
            timeMin: q.fromIso,
            timeMax: q.toIso,
            timeZone: q.timeZone,
            maxResults: String(PAGE_SIZE),
          });
          if (pageToken !== null) params.set('pageToken', pageToken);
          const r: { status: number; body: unknown } = await http.request({
            method: 'GET',
            url: `${cal(q.calendarId)}/events?${params}`,
            accessToken: token,
            signal,
          });
          if (!ok2xx(r.status)) return failureFromStatus(r.status, r.body);
          const body = asRecord(r.body);
          for (const item of Array.isArray(body['items']) ? body['items'] : []) {
            const ev = toEvent(q.calendarId, item, q.timeZone);
            if (ev === null) continue;
            if (events.length >= q.maxEvents) {
              truncated = true;
              break;
            }
            events.push(ev);
          }
          pageToken = str(body['nextPageToken']);
          if (events.length >= q.maxEvents) {
            if (pageToken !== null) truncated = true;
            break;
          }
        } while (pageToken !== null);
        return { events, truncated };
      }),

    getEvent: (token, calendarId, eventId, timeZone, signal) =>
      guarded(async () => {
        const r = await http.request({
          method: 'GET',
          url: `${cal(calendarId)}/events/${encodeURIComponent(eventId)}?timeZone=${encodeURIComponent(timeZone)}`,
          accessToken: token,
          signal,
        });
        if (!ok2xx(r.status)) return failureFromStatus(r.status, r.body);
        const ev = toEvent(calendarId, r.body, timeZone);
        return ev ?? { failure: 'rejected' as const, status: r.status, message: 'calendar event could not be read' };
      }),

    createEvent: (token, calendarId, write, idempotencyKey, signal) =>
      guarded(async () => {
        const id = googleEventId(idempotencyKey);
        const r = await http.request({
          method: 'POST',
          url: `${cal(calendarId)}/events?sendUpdates=all`,
          accessToken: token,
          body: { id, ...bodyOf(write) },
          signal,
        });
        // 409: that id already exists, so this exact create already happened.
        if (r.status === 409) return { eventId: id };
        if (!ok2xx(r.status)) return failureFromStatus(r.status, r.body);
        return { eventId: str(asRecord(r.body)['id']) ?? id };
      }),

    updateEvent: (token, calendarId, eventId, patch, signal) =>
      guarded(async () => {
        const r = await http.request({
          method: 'PATCH',
          url: `${cal(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
          accessToken: token,
          body: bodyOf(patch),
          signal,
        });
        if (!ok2xx(r.status)) return failureFromStatus(r.status, r.body);
        return { eventId: str(asRecord(r.body)['id']) ?? eventId };
      }),

    deleteEvent: (token, calendarId, eventId, signal) =>
      guarded(async () => {
        const r = await http.request({
          method: 'DELETE',
          url: `${cal(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
          accessToken: token,
          signal,
        });
        if (!ok2xx(r.status)) return failureFromStatus(r.status, r.body);
        return { eventId };
      }),
  };
}
