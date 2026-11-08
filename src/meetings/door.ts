/**
 * The instruction door's calendar entry (calendar scheduling, spec §7). In this
 * task: the schedule answer only. Called by `runInstruction` after the charter
 * load and BEFORE `createJob`, so a question about the schedule opens no job and
 * stores no instruction row — it is a read, answered in the channel it came in.
 */
import { resolveCalendarAccess } from '../calendar/client-for.js';
import { isCalendarFailure, type CalendarClient } from '../calendar/types.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { localParts, localToInstant } from '../util/local-time.js';
import { busyIntervals, freeIntervals, workWindows, type CharterOperations, type Interval } from './free-time.js';
import {
  loadMeetingResponses,
  parseScheduleQuery,
  renderSchedule,
  UNRECOGNIZED_RANGE_REPLY,
} from './query.js';
import { loadMeetingSettings } from './settings.js';
import { loadCalendarRange } from './snapshot.js';

export const WHATSAPP_MAX_CHARS = 4_000;
export const CALENDAR_NOT_CONNECTED_REPLY = 'היומן לא מחובר — אפשר לחבר אותו במסך החיבורים.';
export const CALENDAR_NEEDS_REAUTH_REPLY = 'היומן דורש אישור מחדש — אפשר לחבר אותו מחדש במסך החיבורים.';
export const CALENDAR_CREDENTIAL_REPLY = 'לא הצלחתי לפתוח את ההרשאה השמורה ליומן — אם זה חוזר, חבר את היומן מחדש.';
export const CALENDAR_READ_FAILED_REPLY = 'לא הצלחתי לקרוא את היומן עכשיו — אפשר לנסות שוב עוד מעט.';

const READ_TIMEOUT_MS = 20_000;

function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

export async function answerScheduleQuery(o: {
  text: string;
  businessId: string;
  timeZone: string;
  operations: CharterOperations;
  runtime: Pick<Runtime, 'credentials'>;
  now?: Date;
  client?: CalendarClient;
}): Promise<{ answered: string } | null> {
  const now = o.now ?? new Date();
  const range = parseScheduleQuery(o.text, now, o.timeZone);
  if (range === null) return null;
  if (range === 'unrecognized_range') return { answered: UNRECOGNIZED_RANGE_REPLY };

  const access = await resolveCalendarAccess({
    businessId: o.businessId,
    runtime: o.runtime,
    ...(o.client !== undefined ? { client: o.client } : {}),
  });
  if ('unavailable' in access) {
    return {
      answered:
        access.unavailable === 'needs_reauth'
          ? CALENDAR_NEEDS_REAUTH_REPLY
          : access.unavailable === 'credential_error'
            ? CALENDAR_CREDENTIAL_REPLY
            : CALENDAR_NOT_CONNECTED_REPLY,
    };
  }

  const settings = await loadMeetingSettings({ businessId: o.businessId });
  // A day either side: an event just outside the range still pads the edge of a work window.
  const fromMs = localToInstant(addDays(range.fromDate, -1), '00:00', o.timeZone).getTime();
  const toMs = localToInstant(addDays(range.toDate, 2), '00:00', o.timeZone).getTime();

  let snapshot;
  try {
    snapshot = await loadCalendarRange({
      access,
      businessId: o.businessId,
      settings,
      timeZone: o.timeZone,
      fromIso: new Date(fromMs).toISOString(),
      toIso: new Date(toMs).toISOString(),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    return { answered: CALENDAR_READ_FAILED_REPLY };
  }
  if (isCalendarFailure(snapshot)) {
    return { answered: snapshot.failure === 'auth' ? CALENDAR_NEEDS_REAUTH_REPLY : CALENDAR_READ_FAILED_REPLY };
  }

  const windows = workWindows({
    fromDate: range.fromDate,
    toDate: range.toDate,
    timeZone: o.timeZone,
    operations: o.operations,
    workStart: settings.workStart,
    workEnd: settings.workEnd,
  });
  // The part of today that has already gone is not free.
  const busy: Interval[] = [...busyIntervals(snapshot, settings.gapMinutes), { start: 0, end: now.getTime() }];
  const free = new Map<string, Interval[]>();
  const windowEnds = new Map<string, number>();
  for (const w of windows) {
    const date = localParts(new Date(w.start), o.timeZone).date;
    free.set(date, freeIntervals([w], busy));
    windowEnds.set(date, w.end);
  }

  const responses = await loadMeetingResponses(
    o.businessId,
    snapshot.events.map((e) => e.eventId),
  );
  return {
    answered: renderSchedule({
      range,
      snapshot,
      responses,
      free,
      windowEnds,
      timeZone: o.timeZone,
      maxChars: WHATSAPP_MAX_CHARS,
    }),
  };
}
