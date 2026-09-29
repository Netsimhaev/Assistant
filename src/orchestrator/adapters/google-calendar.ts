/**
 * The Google Calendar adapter: one external system, `calendar.read` only.
 *
 * Built on the exact skeleton `createMailAdapter` (`./mail.ts`) already
 * establishes: the same `serves` check inside `execute` (because
 * `AdapterRegistry.get` looks an adapter up by system name alone and does
 * not check it -- see that registry's own docblock), the same
 * `call.signal.aborted` check before anything else, and the same contract
 * that this function returns a result and never throws for anything short
 * of a genuine bug.
 *
 * **Read-only, on purpose.** `calendar.read` is the one tool this adapter
 * serves; nothing here writes, moves or cancels an event. That is also why
 * a 401 is classified `retryable: true` below -- a fresh access token minted
 * by `oauthCredentials` on the very next attempt may simply work, and
 * retrying a READ costs nothing beyond the read itself. A write must never
 * get this treatment (see `AdapterCall.idempotencyKey`'s own docblock on why
 * retrying on ambiguity is dangerous for anything that creates something).
 *
 * **The output is a narrowed list, never the raw provider body.** Google's
 * `events.list` response carries far more than anyone asked for --
 * `etag`, `htmlLink`, `organizer`, `attendees`, `iCalUID`, pagination
 * tokens, and so on. `extractEvents` below reads exactly `id`, `summary`,
 * `start` and `end` off each item and drops everything else, the same
 * discipline `readDocument`'s reading brief already applies to a document's
 * raw bytes.
 */
import { z } from 'zod';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './types.js';

/** The only tool this adapter serves; checked against `call.toolName` before anything runs. */
export const GOOGLE_CALENDAR_SERVED_TOOLS: readonly string[] = ['calendar.read'];

/** Google's calendar API base. Overridable only through `CalendarHttp` in tests. */
const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

const DEFAULT_CALENDAR_ID = 'primary';
const DEFAULT_MAX_RESULTS = 10;

/**
 * The seam between this adapter and Google's calendar API.
 *
 * An interface rather than a direct `fetch` call so every test drives a
 * recording implementation and no test ever reaches the real API. Returns a
 * result rather than throwing on a non-2xx status -- exactly how `fetch`
 * itself behaves -- so `execute` below is the one place that decides what a
 * given status means.
 */
export interface CalendarHttp {
  listEvents(input: {
    accessToken: string;
    calendarId: string;
    timeMinIso: string;
    maxResults: number;
    signal: AbortSignal;
  }): Promise<{ status: number; body: unknown }>;
}

/**
 * The tool's own payload shape. Nothing declares it upstream -- the planner
 * invents the payload from the tool's name, same as every local tool
 * (`local-tools.ts`'s own docblock) -- so this adapter validates its own
 * input rather than trusting it.
 */
export const CalendarReadInput: z.ZodType<{
  calendarId?: string | undefined;
  fromIso?: string | undefined;
  maxResults?: number | undefined;
}> = z.object({
  calendarId: z.string().min(1).optional(),
  fromIso: z.string().min(1).optional(),
  maxResults: z.number().int().positive().optional(),
});

export interface GoogleCalendarAdapterOptions {
  system: string;
  http?: CalendarHttp;
}

export function createGoogleCalendarAdapter(options: GoogleCalendarAdapterOptions): ExternalAdapter {
  const http = options.http ?? defaultCalendarHttp();

  return {
    system: options.system,
    channel: 'api',
    serves: GOOGLE_CALENDAR_SERVED_TOOLS,

    async execute(call: AdapterCall): Promise<AdapterResult> {
      // AdapterRegistry.get looks an adapter up by system name alone and
      // does not check `serves` -- a mis-wired binding could hand this
      // adapter a call for a tool it was never meant to run.
      if (!GOOGLE_CALENDAR_SERVED_TOOLS.includes(call.toolName)) {
        return {
          ok: false,
          retryable: false,
          code: 'unsupported_tool',
          message: `מתאם יומן Google אינו משרת את הכלי "${call.toolName}"`,
        };
      }

      // Nothing has happened yet, so refusing costs nothing external.
      if (call.signal.aborted) {
        return {
          ok: false,
          retryable: true,
          code: 'aborted',
          message: 'הבקשה בוטלה לפני שהיומן נקרא',
        };
      }

      if (call.credential === null) {
        return {
          ok: false,
          retryable: false,
          code: 'credential_unavailable',
          message: 'אין credential לחיבור — לא ניתן לקרוא את היומן',
        };
      }

      const parsedInput = CalendarReadInput.safeParse(call.input);
      if (!parsedInput.success) {
        const first = parsedInput.error.issues[0];
        const where = first === undefined ? '' : ` (${first.path.join('.') || 'root'}: ${first.message})`;
        return {
          ok: false,
          retryable: false,
          code: 'invalid_input',
          message: `מטען לא תקין לקריאת יומן${where}`,
        };
      }
      const { calendarId, fromIso, maxResults } = parsedInput.data;

      let response: { status: number; body: unknown };
      try {
        response = await http.listEvents({
          accessToken: call.credential.value,
          calendarId: calendarId ?? DEFAULT_CALENDAR_ID,
          timeMinIso: fromIso ?? new Date().toISOString(),
          maxResults: maxResults ?? DEFAULT_MAX_RESULTS,
          signal: call.signal,
        });
      } catch (error) {
        // The structural contract every adapter here keeps: a result, never
        // a throw. A `CalendarHttp` that throws instead of returning a
        // status is treated as a network failure -- nothing was read.
        return {
          ok: false,
          retryable: true,
          code: 'network_error',
          message: `כשל רשת בקריאת היומן: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (response.status >= 200 && response.status < 300) {
        return { ok: true, output: { events: extractEvents(response.body) }, externalId: null };
      }

      return classifyCalendarFailure(response.status, response.body);
    },
  };
}

/**
 * Turn a non-2xx status into a result.
 *
 * - **401** (expired or invalid access token): retryable, and ONLY because
 *   `calendar.read` is read-only (see module docblock) -- a freshly minted
 *   token on the next attempt may simply work.
 * - **403** (token valid, permission genuinely absent): terminal. The same
 *   token or the same business will not get a different answer.
 * - **429** (rate limited) and **5xx** (provider trouble): retryable --
 *   neither says anything about the request itself.
 * - Anything else this adapter does not specifically recognise (400, 404,
 *   ...): the restrictive answer, not the convenient one -- the same
 *   precedent `classifyTransportFailure`'s unrecognised-shape branch sets
 *   in the mail adapter.
 *
 * `providerMessage`, when present, is read from the response body's own
 * `error.message` field only -- never the body verbatim, and never
 * anything derived from the access token (which this function never even
 * receives).
 */
function classifyCalendarFailure(status: number, body: unknown): AdapterResult {
  const providerMessage = extractProviderMessage(body);
  const suffix = providerMessage === null ? '' : ` — ${providerMessage}`;

  if (status === 401) {
    return {
      ok: false,
      retryable: true,
      code: 'unauthorized',
      message: `Google דחה את האסימון (401)${suffix}`,
    };
  }
  if (status === 403) {
    return {
      ok: false,
      retryable: false,
      code: 'forbidden',
      message: `הגישה ליומן נדחתה (403)${suffix}`,
    };
  }
  if (status === 429 || status >= 500) {
    return {
      ok: false,
      retryable: true,
      code: 'provider_unavailable',
      message: `היומן אינו זמין כרגע (${status})${suffix}`,
    };
  }
  if (status === 0) {
    // The default `CalendarHttp` below reports an unreachable server this
    // way rather than throwing out of `listEvents`.
    return {
      ok: false,
      retryable: true,
      code: 'network_error',
      message: `כשל רשת בקריאת היומן${suffix}`,
    };
  }
  return {
    ok: false,
    retryable: false,
    code: 'provider_error',
    message: `הספק החזיר שגיאה (${status})${suffix}`,
  };
}

function extractProviderMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as Record<string, unknown>)['error'];
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return null;
}

const CalendarEventRaw = z.object({
  id: z.string().min(1),
  summary: z.string().optional(),
  start: z.unknown().optional(),
  end: z.unknown().optional(),
});

interface CalendarEvent {
  id: string;
  summary: string | null;
  start: unknown;
  end: unknown;
}

/** Reads `items` off the provider body and narrows each one -- see module docblock. */
function extractEvents(body: unknown): CalendarEvent[] {
  if (typeof body !== 'object' || body === null) return [];
  const items = (body as Record<string, unknown>)['items'];
  if (!Array.isArray(items)) return [];

  const events: CalendarEvent[] = [];
  for (const item of items) {
    const parsed = CalendarEventRaw.safeParse(item);
    if (!parsed.success) continue;
    events.push({
      id: parsed.data.id,
      summary: parsed.data.summary ?? null,
      start: parsed.data.start ?? null,
      end: parsed.data.end ?? null,
    });
  }
  return events;
}

/**
 * The default `CalendarHttp`: Node's own `fetch` against Google's calendar
 * API, with `Authorization: Bearer <accessToken>`.
 *
 * A `fetch` that throws (DNS failure, connection refused, timeout via the
 * caller's own `AbortSignal`) never reached Google at all -- reported as
 * `{ status: 0, ... }` rather than left to propagate, so `execute` above
 * has exactly one place (`classifyCalendarFailure`) that decides what a
 * failed call means.
 */
function defaultCalendarHttp(): CalendarHttp {
  return {
    async listEvents(input): Promise<{ status: number; body: unknown }> {
      const url = new URL(
        `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(input.calendarId)}/events`,
      );
      url.searchParams.set('timeMin', input.timeMinIso);
      url.searchParams.set('maxResults', String(input.maxResults));
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');

      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${input.accessToken}` },
          signal: input.signal,
        });
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        return { status: response.status, body };
      } catch (error) {
        return {
          status: 0,
          body: { error: { message: error instanceof Error ? error.message : String(error) } },
        };
      }
    },
  };
}
