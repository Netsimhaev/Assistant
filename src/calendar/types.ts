export type AttendeeResponse = 'accepted' | 'declined' | 'tentative' | 'needs_action';

export interface CalendarInfo {
  calendarId: string;
  name: string;
  primary: boolean;
  canWrite: boolean;
}

export interface CalendarEvent {
  calendarId: string;
  eventId: string;
  title: string;
  /** ISO instants; all-day events: local-midnight instants in the charter zone. */
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  description: string | null;
  organizerIsSelf: boolean;
  busy: boolean;
  selfDeclined: boolean;
  /** Graph create transactionId (replay detection); Google: null. */
  transactionId: string | null;
  attendees: { email: string; response: AttendeeResponse }[];
}

export interface EventWrite {
  title: string;
  start: string;
  end: string;
  location: string | null;
  description: string | null;
  attendees: string[];
}

export type CalendarFailure = {
  failure: 'auth' | 'transient' | 'rejected' | 'not_found';
  status: number;
  message: string;
};

export interface CalendarHttp {
  request(i: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    accessToken: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal: AbortSignal;
  }): Promise<{ status: number; body: unknown }>;
}

export interface CalendarClient {
  listCalendars(token: string, signal: AbortSignal): Promise<CalendarInfo[] | CalendarFailure>;
  listEvents(
    token: string,
    q: { calendarId: string; fromIso: string; toIso: string; timeZone: string; maxEvents: number },
    signal: AbortSignal,
  ): Promise<{ events: CalendarEvent[]; truncated: boolean } | CalendarFailure>;
  getEvent(
    token: string,
    calendarId: string,
    eventId: string,
    timeZone: string,
    signal: AbortSignal,
  ): Promise<CalendarEvent | CalendarFailure>;
  createEvent(
    token: string,
    calendarId: string,
    write: EventWrite,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<{ eventId: string } | CalendarFailure>;
  updateEvent(
    token: string,
    calendarId: string,
    eventId: string,
    patch: Partial<EventWrite>,
    signal: AbortSignal,
  ): Promise<{ eventId: string } | CalendarFailure>;
  deleteEvent(
    token: string,
    calendarId: string,
    eventId: string,
    signal: AbortSignal,
  ): Promise<{ eventId: string } | CalendarFailure>;
}

export function isCalendarFailure(v: unknown): v is CalendarFailure {
  return typeof v === 'object' && v !== null && 'failure' in v;
}

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export function ok2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** 401/403 auth; 404/410 not_found; 0 (network), 429, 5xx transient; any other 4xx rejected. */
export function failureFromStatus(status: number, body: unknown): CalendarFailure {
  let detail = '';
  const error = asRecord(body)['error'];
  if (typeof error === 'string') detail = error;
  else {
    const m = asRecord(error)['message'];
    if (typeof m === 'string') detail = m;
  }
  const suffix = detail === '' ? '' : `: ${detail}`;
  if (status === 401 || status === 403) {
    return { failure: 'auth', status, message: `calendar auth rejected (${status})${suffix}` };
  }
  if (status === 404 || status === 410) {
    return { failure: 'not_found', status, message: `calendar item not found (${status})${suffix}` };
  }
  if (status === 0 || status === 429 || status >= 500) {
    return { failure: 'transient', status, message: `calendar provider unavailable (${status})${suffix}` };
  }
  return { failure: 'rejected', status, message: `calendar provider rejected the request (${status})${suffix}` };
}

/** Default HTTP: global fetch with a bearer token; a network failure is status 0; an empty body is null. */
export function defaultCalendarHttp(): CalendarHttp {
  return {
    async request(input) {
      try {
        const headers: Record<string, string> = { ...input.headers, Authorization: `Bearer ${input.accessToken}` };
        const init: RequestInit = { method: input.method, headers, signal: input.signal };
        if (input.body !== undefined) {
          headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(input.body);
        }
        const response = await fetch(input.url, init);
        let body: unknown = null;
        const text = await response.text().catch(() => '');
        if (text !== '') {
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
        }
        return { status: response.status, body };
      } catch (error) {
        return { status: 0, body: { error: { message: error instanceof Error ? error.message : String(error) } } };
      }
    },
  };
}

/** An unexpected throw from the injected HTTP becomes a transient failure. */
export async function guarded<T>(fn: () => Promise<T | CalendarFailure>): Promise<T | CalendarFailure> {
  try {
    return await fn();
  } catch (error) {
    return { failure: 'transient', status: 0, message: error instanceof Error ? error.message : String(error) };
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/**
 * Calendar descriptions may arrive as HTML (Outlook, Google). The owner-facing
 * rendering is plain text, so turn line breaks into newlines, drop every other
 * tag, decode the basic entities and trim. Entities are decoded last, so an
 * escaped "&lt;b&gt;" stays literal text rather than becoming a tag.
 */
export function toPlainText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, name: string) => ENTITIES[name] ?? '')
    .trim();
}

export function plainOrNull(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const p = toPlainText(s);
  return p === '' ? null : p;
}
