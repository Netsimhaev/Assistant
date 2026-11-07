/**
 * The calendar adapter: `calendar.read` and `calendar.write` for the one
 * calendar account a business may connect (`CALENDAR_SYSTEM`).
 *
 * Same skeleton as `google-calendar.ts` (which stays for legacy connections):
 * the `serves` check inside `execute`, the abort check first, a null credential
 * refused, the payload validated here with zod, and a returned result instead
 * of a throw.
 *
 * **Writes are never blindly retried.** A 401 on a write is `calendar_auth`
 * and not retryable (a read may retry it -- a fresh token may work and a read
 * costs nothing). A transient failure on a write is retryable only when the
 * provider demonstrably ANSWERED (429 / 5xx -- nothing was applied); a network
 * failure or a throw means the request may have landed, so it is
 * `delivery_unknown` and final.
 *
 * **Pre-write re-check (spec 6.3).** The slot was free when the owner was
 * asked, but time passed. For `create` and `move` the adapter lists the
 * target interval again and refuses with `slot_taken` when anything busy other
 * than the event being moved / converted sits in it. A re-check that cannot
 * complete (truncated list, failed read) refuses too: an unchecked slot is not
 * a free slot.
 *
 * **Messages here are fixed Hebrew sentences.** Provider error text can reach
 * the owner through the report and the dashboard, and it is written by a third
 * party, so it is never embedded in `AdapterResult.message`.
 */
import { z } from 'zod';
import type { CalendarProvider } from '../../calendar/calendar.js';
import { calendarClientFor } from '../../calendar/client-for.js';
import { isCalendarFailure } from '../../calendar/types.js';
import type { CalendarClient, CalendarFailure, EventWrite } from '../../calendar/types.js';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './types.js';

export const CALENDAR_SERVED_TOOLS = ['calendar.read', 'calendar.write'] as const;

/** An instant `Date.parse` accepts that states its offset (or `Z`). */
const IsoInstant = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)) && /(Z|[+-]\d{2}:?\d{2})$/i.test(s), {
    message: 'expected an ISO instant with an offset',
  });

const calendarId = z.string().min(1);
const eventId = z.string().min(1);

export const CalendarWriteInput = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('create'),
      calendarId,
      holdEventId: z.string().min(1).nullable(),
      title: z.string().min(1),
      start: IsoInstant,
      end: IsoInstant,
      location: z.string().nullable(),
      description: z.string().nullable(),
      attendees: z.array(z.string().email()),
    })
    .strict(),
  z.object({ operation: z.literal('move'), calendarId, eventId, start: IsoInstant, end: IsoInstant }).strict(),
  z
    .object({
      operation: z.literal('update'),
      calendarId,
      eventId,
      location: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      attendees: z.array(z.string().email()).optional(),
    })
    .strict(),
  z.object({ operation: z.literal('cancel'), calendarId, eventId }).strict(),
]);
export type CalendarWriteInput = z.infer<typeof CalendarWriteInput>;

export const CalendarReadInput = z
  .object({ calendarId, fromIso: IsoInstant, toIso: IsoInstant })
  .strict();

const RECHECK_MAX_EVENTS = 50;

const MSG = {
  unsupportedTool: 'מתאם היומן אינו משרת את הכלי הזה',
  aborted: 'הבקשה בוטלה לפני שהיומן נגע',
  noCredential: 'אין חיבור פעיל ליומן — לא נעשה דבר',
  invalidRead: 'פרטי קריאת היומן אינם תקינים',
  invalidWrite: 'פרטי הפעולה ביומן אינם תקינים — לא נכתב דבר',
  badInterval: 'סיום הפגישה חייב להיות אחרי תחילתה — לא נכתב דבר',
  zoneUnavailable: 'אזור הזמן של העסק לא נקרא — לא נכתב דבר',
  slotTaken: 'המועד נתפס בינתיים — לא נכתב דבר',
  recheckIncomplete: 'לא ניתן היה לוודא שהמועד פנוי — לא נכתב דבר',
  auth: 'החיבור ליומן נדחה — צריך לחבר אותו מחדש',
  notFound: 'האירוע לא נמצא ביומן',
  rejected: 'היומן דחה את הבקשה',
  unavailable: 'היומן אינו זמין כרגע',
  deliveryUnknown: 'לא ניתן לאשר אם הפעולה בוצעה ביומן',
} as const;

export interface CalendarAdapterOptions {
  system: string;
  provider: CalendarProvider;
  timeZone: () => Promise<string>;
  client?: CalendarClient;
}

function fail(retryable: boolean, code: string, message: string): AdapterResult {
  return { ok: false, retryable, code, message };
}

/** A failure on a READ (nothing can have been changed): auth and transient may retry. */
function readFailure(f: CalendarFailure): AdapterResult {
  switch (f.failure) {
    case 'auth':
      return fail(true, 'calendar_auth', MSG.auth);
    case 'transient':
      return fail(true, 'calendar_unavailable', MSG.unavailable);
    case 'not_found':
      return fail(false, 'event_not_found', MSG.notFound);
    case 'rejected':
      return fail(false, 'calendar_rejected', MSG.rejected);
  }
}

/**
 * A failure on a WRITE. `transient` is retryable only when the provider
 * answered with 429 / 5xx; status 0 (network) or anything else may have landed.
 */
function writeFailure(f: CalendarFailure): AdapterResult {
  switch (f.failure) {
    case 'auth':
      return fail(false, 'calendar_auth', MSG.auth);
    case 'transient':
      return f.status === 429 || f.status >= 500
        ? fail(true, 'calendar_unavailable', MSG.unavailable)
        : fail(false, 'delivery_unknown', MSG.deliveryUnknown);
    case 'not_found':
      return fail(false, 'event_not_found', MSG.notFound);
    case 'rejected':
      return fail(false, 'calendar_rejected', MSG.rejected);
  }
}

export function createCalendarAdapter(o: CalendarAdapterOptions): ExternalAdapter {
  const client = o.client ?? calendarClientFor(o.provider);

  async function read(call: AdapterCall, token: string): Promise<AdapterResult> {
    const parsed = CalendarReadInput.safeParse(call.input);
    if (!parsed.success) return fail(false, 'invalid_input', MSG.invalidRead);
    let timeZone: string;
    try {
      timeZone = await o.timeZone();
    } catch {
      return fail(true, 'timezone_unavailable', MSG.zoneUnavailable);
    }
    let result: Awaited<ReturnType<CalendarClient['listEvents']>>;
    try {
      result = await client.listEvents(token, { ...parsed.data, timeZone, maxEvents: 250 }, call.signal);
    } catch {
      return fail(true, 'calendar_unavailable', MSG.unavailable);
    }
    if (isCalendarFailure(result)) return readFailure(result);
    return { ok: true, output: { events: result.events, truncated: result.truncated }, externalId: null };
  }

  /** Returns a refusal when the interval is no longer free; `null` when it is. */
  async function recheck(
    call: AdapterCall,
    token: string,
    cal: string,
    start: string,
    end: string,
    ignore: ReadonlySet<string>,
  ): Promise<AdapterResult | null> {
    let timeZone: string;
    try {
      timeZone = await o.timeZone();
    } catch {
      return fail(true, 'timezone_unavailable', MSG.zoneUnavailable);
    }
    let listed: Awaited<ReturnType<CalendarClient['listEvents']>>;
    try {
      listed = await client.listEvents(
        token,
        { calendarId: cal, fromIso: start, toIso: end, timeZone, maxEvents: RECHECK_MAX_EVENTS },
        call.signal,
      );
    } catch {
      // A read: nothing was written, so a retry is safe.
      return fail(true, 'calendar_unavailable', MSG.unavailable);
    }
    if (isCalendarFailure(listed)) {
      // Auth stays final even though it was a read: same mapping as the write.
      return listed.failure === 'auth' ? writeFailure(listed) : readFailure(listed);
    }
    if (listed.truncated) return fail(false, 'slot_taken', MSG.recheckIncomplete);
    const s = Date.parse(start);
    const e = Date.parse(end);
    for (const ev of listed.events) {
      if (ignore.has(ev.eventId)) continue;
      if (!ev.busy || ev.selfDeclined) continue;
      if (Date.parse(ev.start) < e && Date.parse(ev.end) > s) return fail(false, 'slot_taken', MSG.slotTaken);
    }
    return null;
  }

  async function write(call: AdapterCall, token: string): Promise<AdapterResult> {
    const parsed = CalendarWriteInput.safeParse(call.input);
    if (!parsed.success) return fail(false, 'invalid_input', MSG.invalidWrite);
    const input = parsed.data;

    if ((input.operation === 'create' || input.operation === 'move') && Date.parse(input.end) <= Date.parse(input.start)) {
      return fail(false, 'invalid_input', MSG.badInterval);
    }

    let outcome: { eventId: string } | CalendarFailure;
    try {
      switch (input.operation) {
        case 'create': {
          const ignore = new Set<string>(input.holdEventId === null ? [] : [input.holdEventId]);
          const refusal = await recheck(call, token, input.calendarId, input.start, input.end, ignore);
          if (refusal !== null) return refusal;
          const body: EventWrite = {
            title: input.title,
            start: input.start,
            end: input.end,
            location: input.location,
            description: input.description,
            attendees: input.attendees,
          };
          outcome =
            input.holdEventId === null
              ? await client.createEvent(token, input.calendarId, body, call.idempotencyKey, call.signal)
              : await client.updateEvent(token, input.calendarId, input.holdEventId, body, call.signal);
          break;
        }
        case 'move': {
          const refusal = await recheck(call, token, input.calendarId, input.start, input.end, new Set([input.eventId]));
          if (refusal !== null) return refusal;
          outcome = await client.updateEvent(
            token,
            input.calendarId,
            input.eventId,
            { start: input.start, end: input.end },
            call.signal,
          );
          break;
        }
        case 'update': {
          const patch: Partial<EventWrite> = {};
          if (input.location !== undefined) patch.location = input.location;
          if (input.description !== undefined) patch.description = input.description;
          if (input.attendees !== undefined) patch.attendees = input.attendees;
          outcome = await client.updateEvent(token, input.calendarId, input.eventId, patch, call.signal);
          break;
        }
        case 'cancel':
          outcome = await client.deleteEvent(token, input.calendarId, input.eventId, call.signal);
          break;
      }
    } catch {
      // The request may have reached the provider; never retry it blindly.
      return fail(false, 'delivery_unknown', MSG.deliveryUnknown);
    }
    if (isCalendarFailure(outcome)) return writeFailure(outcome);
    return { ok: true, output: { operation: input.operation, eventId: outcome.eventId }, externalId: outcome.eventId };
  }

  return {
    system: o.system,
    channel: 'api',
    serves: CALENDAR_SERVED_TOOLS,

    async execute(call: AdapterCall): Promise<AdapterResult> {
      if (!(CALENDAR_SERVED_TOOLS as readonly string[]).includes(call.toolName)) {
        return fail(false, 'unsupported_tool', MSG.unsupportedTool);
      }
      if (call.signal.aborted) return fail(true, 'aborted', MSG.aborted);
      if (call.credential === null) return fail(false, 'credential_unavailable', MSG.noCredential);
      const token = call.credential.value;
      return call.toolName === 'calendar.read' ? read(call, token) : write(call, token);
    },
  };
}
