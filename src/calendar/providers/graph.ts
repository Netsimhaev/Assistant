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

const BASE = 'https://graph.microsoft.com/v1.0';
const PAGE_SIZE = 100;

const RESPONSES: Record<string, AttendeeResponse> = {
  accepted: 'accepted',
  organizer: 'accepted',
  declined: 'declined',
  tentativelyAccepted: 'tentative',
  notResponded: 'needs_action',
  none: 'needs_action',
};

/** Graph returns wall time in the Prefer zone (or UTC) with no offset. */
function instantOf(point: unknown, fallbackZone: string): string | null {
  const p = asRecord(point);
  const dt = str(p['dateTime']);
  if (dt === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/.exec(dt);
  if (m === null) return null;
  const zone = str(p['timeZone']) ?? fallbackZone;
  const date = m[1] ?? '';
  const time = m[2] ?? '';
  const sec = m[3] ?? '00';
  if (zone === 'UTC') return new Date(`${date}T${time}:${sec}.000Z`).toISOString();
  try {
    return localToInstant(date, time, zone).toISOString();
  } catch {
    // A zone name this runtime cannot resolve: the requested zone is the one Prefer asked for.
    return localToInstant(date, time, fallbackZone).toISOString();
  }
}

function toEvent(calendarId: string, raw: unknown, timeZone: string): CalendarEvent | null {
  const e = asRecord(raw);
  const eventId = str(e['id']);
  const start = instantOf(e['start'], timeZone);
  const end = instantOf(e['end'], timeZone);
  if (eventId === null || start === null || end === null) return null;
  const attendees: CalendarEvent['attendees'] = [];
  for (const a of Array.isArray(e['attendees']) ? e['attendees'] : []) {
    const r = asRecord(a);
    const email = str(asRecord(r['emailAddress'])['address']);
    if (email === null) continue;
    attendees.push({ email, response: RESPONSES[String(asRecord(r['status'])['response'])] ?? 'needs_action' });
  }
  return {
    calendarId,
    eventId,
    title: str(e['subject']) ?? '',
    start,
    end,
    allDay: e['isAllDay'] === true,
    location: str(asRecord(e['location'])['displayName']),
    description: plainOrNull(asRecord(e['body'])['content']),
    organizerIsSelf: e['isOrganizer'] === true,
    busy: e['showAs'] !== 'free',
    selfDeclined: asRecord(e['responseStatus'])['response'] === 'declined',
    transactionId: str(e['transactionId']),
    attendees,
  };
}

/**
 * An instant as Graph's zone-less `dateTime` in UTC. The adapter accepts any
 * offset (`+02:00` as well as `Z`), and stripping a `Z` alone would send a
 * `+02:00` instant labelled UTC — two hours off. Converted, never relabelled.
 */
function utcDateTime(instant: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error('calendar write: unreadable instant');
  return new Date(ms).toISOString().replace(/Z$/, '');
}

function bodyOf(w: Partial<EventWrite>): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (w.title !== undefined) b['subject'] = w.title;
  if (w.start !== undefined) b['start'] = { dateTime: utcDateTime(w.start), timeZone: 'UTC' };
  if (w.end !== undefined) b['end'] = { dateTime: utcDateTime(w.end), timeZone: 'UTC' };
  if (w.location !== undefined) b['location'] = { displayName: w.location ?? '' };
  if (w.description !== undefined) b['body'] = { contentType: 'text', content: w.description ?? '' };
  if (w.attendees !== undefined) {
    b['attendees'] = w.attendees.map((address) => ({ emailAddress: { address }, type: 'required' }));
  }
  return b;
}

const prefer = (tz: string): Record<string, string> => ({ Prefer: `outlook.timezone="${tz}", outlook.body-content-type="text"` });
const cal = (id: string): string => `${BASE}/me/calendars/${encodeURIComponent(id)}`;

/** Graph transactionId for a create, deterministic from the idempotency key. */
export function graphTransactionId(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 36);
}

export function createGraphCalendarClient(http: CalendarHttp = defaultCalendarHttp()): CalendarClient {
  return {
    listCalendars: (token, signal) =>
      guarded(async () => {
        const out: { calendarId: string; name: string; primary: boolean; canWrite: boolean }[] = [];
        let url: string | null = `${BASE}/me/calendars?$top=${PAGE_SIZE}`;
        while (url !== null) {
          const r: { status: number; body: unknown } = await http.request({ method: 'GET', url, accessToken: token, signal });
          if (!ok2xx(r.status)) return failureFromStatus(r.status, r.body);
          const body = asRecord(r.body);
          for (const item of Array.isArray(body['value']) ? body['value'] : []) {
            const c = asRecord(item);
            const id = str(c['id']);
            if (id === null) continue;
            out.push({
              calendarId: id,
              name: str(c['name']) ?? id,
              primary: c['isDefaultCalendar'] === true,
              canWrite: c['canEdit'] === true,
            });
          }
          url = str(body['@odata.nextLink']);
        }
        return out;
      }),

    listEvents: (token, q, signal) =>
      guarded(async () => {
        const events: CalendarEvent[] = [];
        let truncated = false;
        const params = new URLSearchParams({ startDateTime: q.fromIso, endDateTime: q.toIso, $top: String(PAGE_SIZE) });
        let url: string | null = `${cal(q.calendarId)}/calendarView?${params}`;
        while (url !== null) {
          const r: { status: number; body: unknown } = await http.request({
            method: 'GET',
            url,
            accessToken: token,
            headers: prefer(q.timeZone),
            signal,
          });
          if (!ok2xx(r.status)) return failureFromStatus(r.status, r.body);
          const body = asRecord(r.body);
          for (const item of Array.isArray(body['value']) ? body['value'] : []) {
            const ev = toEvent(q.calendarId, item, q.timeZone);
            if (ev === null) continue;
            if (events.length >= q.maxEvents) {
              truncated = true;
              break;
            }
            events.push(ev);
          }
          url = str(body['@odata.nextLink']);
          if (events.length >= q.maxEvents) {
            if (url !== null) truncated = true;
            break;
          }
        }
        return { events, truncated };
      }),

    getEvent: (token, calendarId, eventId, timeZone, signal) =>
      guarded(async () => {
        const r = await http.request({
          method: 'GET',
          url: `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`,
          accessToken: token,
          headers: prefer(timeZone),
          signal,
        });
        if (!ok2xx(r.status)) return failureFromStatus(r.status, r.body);
        const ev = toEvent(calendarId, r.body, timeZone);
        return ev ?? { failure: 'rejected' as const, status: r.status, message: 'calendar event could not be read' };
      }),

    createEvent: (token, calendarId, write, idempotencyKey, signal) =>
      guarded(async () => {
        const transactionId = graphTransactionId(idempotencyKey);
        const r = await http.request({
          method: 'POST',
          url: `${cal(calendarId)}/events`,
          accessToken: token,
          body: { transactionId, ...bodyOf(write) },
          signal,
        });
        if (!ok2xx(r.status)) return failureFromStatus(r.status, r.body);
        const id = str(asRecord(r.body)['id']);
        return id === null
          ? { failure: 'rejected' as const, status: r.status, message: 'calendar create returned no event id' }
          : { eventId: id };
      }),

    updateEvent: (token, calendarId, eventId, patch, signal) =>
      guarded(async () => {
        const r = await http.request({
          method: 'PATCH',
          url: `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`,
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
          url: `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`,
          accessToken: token,
          signal,
        });
        if (!ok2xx(r.status)) return failureFromStatus(r.status, r.body);
        return { eventId };
      }),
  };
}
