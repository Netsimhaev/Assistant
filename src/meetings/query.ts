/**
 * The schedule answer (calendar scheduling, spec §7.1): "מה יש לי מחר?" is
 * recognised in code — never by a model — and answered in the owner-approved
 * WhatsApp layout (option A): a card per meeting, then a "פנוי" line.
 *
 * Read-only. Every piece of text that came from the calendar (a title, a
 * location, a note — a client may have written them in the invitation) goes
 * through `stripBidiControls` + `toOneLine` before it is placed in the answer.
 */
import type { CalendarEvent } from '../calendar/types.js';
import { getPool } from '../db/pool.js';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import { localParts, localToInstant } from '../util/local-time.js';
import type { Interval } from './free-time.js';
import type { CalendarSnapshot } from './snapshot.js';

/** The `meetings.response` column's values (migration 061). */
export type MeetingResponse = 'needs_action' | 'accepted' | 'declined' | 'tentative' | 'not_updated';

/** Local `YYYY-MM-DD`, both ends inclusive. */
export type QueryRange = { fromDate: string; toDate: string };

export const UNRECOGNIZED_RANGE_REPLY = 'לאיזה טווח? למשל "מחר", "השבוע" או "יום שלישי".';
export const CONTINUE_ON_DASHBOARD = 'המשך בדשבורד.';
export const TRUNCATED_SNAPSHOT_WARNING = '⚠️ ביומן יותר אירועים ממה שנקרא — ייתכן שחסרים.';

// --- Parsing ------------------------------------------------------------------

const QUESTION = /מה\s+יש\s+לי|מה\s+ה?לו"?ז|מה\s+ב?ה?יומן/u;
const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  ראשון: 0,
  שני: 1,
  שלישי: 2,
  רביעי: 3,
  חמישי: 4,
  שישי: 5,
  שבת: 6,
};
const WEEKDAY_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const WEEKDAY_LETTER: Readonly<Record<(typeof WEEKDAY_ORDER)[number], string>> = {
  sun: "א'",
  mon: "ב'",
  tue: "ג'",
  wed: "ד'",
  thu: "ה'",
  fri: "ו'",
  sat: "ש'",
};

function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isRealDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * `null`: not a schedule question at all. `'unrecognized_range'`: it is one,
 * but no range word was found. Otherwise the inclusive local range.
 */
export function parseScheduleQuery(text: string, now: Date, timeZone: string): QueryRange | 'unrecognized_range' | null {
  const normalised = stripBidiControls(text).replace(/[״”“]/gu, '"').replace(/[׳’‘]/gu, "'");
  if (!QUESTION.test(normalised)) return null;

  const today = localParts(now, timeZone);
  const todayIndex = WEEKDAY_ORDER.indexOf(today.weekday);
  const tokens = normalised.split(/[^\p{L}\p{N}/]+/u).filter((t) => t !== '');
  const has = (word: string): boolean => tokens.some((t) => t === word || t === `ל${word}` || t === `ב${word}`);
  const single = (date: string): QueryRange => ({ fromDate: date, toDate: date });

  const dm = /(\d{1,2})\/(\d{1,2})/u.exec(normalised);
  if (dm !== null) {
    const day = Number(dm[1]);
    const month = Number(dm[2]);
    const year = Number(today.date.slice(0, 4));
    if (!isRealDate(year, month, day)) return 'unrecognized_range';
    let date = `${year}-${pad2(month)}-${pad2(day)}`;
    // A date already past this year means the next occurrence.
    if (date < today.date) {
      if (!isRealDate(year + 1, month, day)) return 'unrecognized_range';
      date = `${year + 1}-${pad2(month)}-${pad2(day)}`;
    }
    return single(date);
  }

  if (has('מחרתיים')) return single(addDays(today.date, 2));
  if (has('מחר')) return single(addDays(today.date, 1));
  if (tokens.includes('היום')) return single(today.date);

  const weekIndex = tokens.findIndex((t) => t === 'שבוע' || t === 'בשבוע' || t === 'לשבוע');
  if (weekIndex >= 0 && tokens[weekIndex + 1] === 'הבא') {
    // Next Sunday through Saturday (today, if it is Saturday, is the last day of this week).
    const start = addDays(today.date, 7 - todayIndex);
    return { fromDate: start, toDate: addDays(start, 6) };
  }
  if (tokens.includes('השבוע')) return { fromDate: today.date, toDate: addDays(today.date, 6 - todayIndex) };

  for (const t of tokens) {
    const name = Object.hasOwn(WEEKDAY_INDEX, t) ? t : t.startsWith('ב') ? t.slice(1) : '';
    if (name !== '' && Object.hasOwn(WEEKDAY_INDEX, name)) {
      // The next occurrence, today included.
      return single(addDays(today.date, (((WEEKDAY_INDEX[name] as number) - todayIndex) % 7 + 7) % 7));
    }
  }
  return 'unrecognized_range';
}

// --- Responses ----------------------------------------------------------------

/** The assistant's own record of each meeting's invitee response, by calendar event id. */
export async function loadMeetingResponses(
  businessId: string,
  eventIds: readonly string[],
): Promise<Map<string, MeetingResponse>> {
  const out = new Map<string, MeetingResponse>();
  if (eventIds.length === 0) return out;
  const { rows } = await getPool().query<{ event_id: string; response: MeetingResponse }>(
    `SELECT DISTINCT ON (event_id) event_id, response FROM meetings
      WHERE business_id = $1 AND event_id = ANY($2::text[]) AND state IN ('proposed','active')
      ORDER BY event_id, updated_at DESC`,
    [businessId, [...eventIds]],
  );
  for (const r of rows) out.set(r.event_id, r.response);
  return out;
}

// --- Rendering ----------------------------------------------------------------

const RESPONSE_LABEL: Readonly<Record<MeetingResponse, string>> = {
  accepted: '✅ אישר',
  needs_action: '⏳ ממתין לתשובה',
  tentative: '⏳ ממתין לתשובה',
  declined: '❌ דחה',
  not_updated: '⚠️ לא עודכן',
};

function clean(value: string | null): string {
  return value === null ? '' : toOneLine(stripBidiControls(value));
}

function firstLine(value: string | null): string {
  if (value === null) return '';
  const line = value.split(/\r\n|[\r\n\u2028\u2029]/u).find((l) => toOneLine(l) !== '');
  return line === undefined ? '' : clean(line);
}

function responseLine(event: CalendarEvent, responses: ReadonlyMap<string, MeetingResponse>): string {
  const known = responses.get(event.eventId);
  if (known !== undefined) return `  ${RESPONSE_LABEL[known]}`;
  if (event.attendees.length === 0) return '';
  if (event.attendees.some((a) => a.response === 'declined')) return `  ${RESPONSE_LABEL.declined}`;
  if (event.attendees.every((a) => a.response === 'accepted')) return `  ${RESPONSE_LABEL.accepted}`;
  return `  ${RESPONSE_LABEL.needs_action}`;
}

function hhmm(ms: number, timeZone: string): string {
  return localParts(new Date(ms), timeZone).time;
}

function formatDate(date: string): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d}/${m}`;
}

function meetingsLabel(count: number): string {
  if (count === 0) return 'אין פגישות';
  return count === 1 ? 'פגישה אחת' : `${count} פגישות`;
}

function freeLine(free: readonly Interval[], windowEnd: number | undefined, timeZone: string): string {
  if (free.length === 0) return 'פנוי: —';
  const parts = free.map((f) =>
    windowEnd !== undefined && f.end === windowEnd
      ? `אחרי ${hhmm(f.start, timeZone)}`
      : `${hhmm(f.start, timeZone)}–${hhmm(f.end, timeZone)}`,
  );
  return `פנוי: ${parts.join(', ')}`;
}

function eventBlock(event: CalendarEvent, responses: ReadonlyMap<string, MeetingResponse>, timeZone: string): string {
  // `*` would close the bold run early in WhatsApp.
  const title = clean(event.title).replace(/\*/gu, '') || '(ללא כותרת)';
  const when = event.allDay
    ? 'כל היום'
    : `${hhmm(Date.parse(event.start), timeZone)}–${hhmm(Date.parse(event.end), timeZone)}`;
  return [
    `*${when} · ${title}*${responseLine(event, responses)}`,
    `📍 ${clean(event.location) || '—'}`,
    `📝 ${firstLine(event.description) || '—'}`,
  ].join('\n');
}

function datesOf(range: QueryRange): string[] {
  const out: string[] = [];
  for (let d = range.fromDate, i = 0; d <= range.toDate && i < 62; d = addDays(d, 1), i += 1) out.push(d);
  return out;
}

/**
 * `free` is keyed by local date; a day with NO key is not a work day and gets no
 * "פנוי" line, while a key with no intervals prints `פנוי: —`. `windowEnds`
 * (optional, epoch ms per date) lets the line say `אחרי HH:MM` when the free time
 * runs to the end of the work window; without it, ranges are always printed in full.
 */
export function renderSchedule(o: {
  range: QueryRange;
  snapshot: CalendarSnapshot;
  responses: ReadonlyMap<string, MeetingResponse>;
  free: ReadonlyMap<string, Interval[]>;
  timeZone: string;
  maxChars: number;
  windowEnds?: ReadonlyMap<string, number>;
}): string {
  const tz = o.timeZone;
  const tail = `\n\n${CONTINUE_ON_DASHBOARD}`;
  const warning = o.snapshot.truncated ? `\n\n${TRUNCATED_SNAPSHOT_WARNING}` : '';
  const budget = o.maxChars - warning.length - tail.length;

  const days: string[][] = [];
  for (const date of datesOf(o.range)) {
    const dayStart = localToInstant(date, '00:00', tz).getTime();
    const dayEnd = localToInstant(addDays(date, 1), '00:00', tz).getTime();
    const events = o.snapshot.events
      .filter((e) => !e.selfDeclined)
      .filter((e) => {
        const s = Date.parse(e.start);
        const en = Date.parse(e.end);
        return Number.isFinite(s) && Number.isFinite(en) && s < dayEnd && (en > dayStart || s >= dayStart);
      })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title));

    const weekday = localParts(new Date(dayStart + 12 * 3_600_000), tz).weekday;
    const pieces = [`*יום ${WEEKDAY_LETTER[weekday]} ${formatDate(date)} — ${meetingsLabel(events.length)}*`];
    for (const e of events) pieces.push(eventBlock(e, o.responses, tz));
    const free = o.free.get(date);
    if (free !== undefined) pieces.push(freeLine(free, o.windowEnds?.get(date), tz));
    days.push(pieces);
  }

  const whole = days.map((d) => d.join('\n\n')).join('\n\n');
  if (whole.length + warning.length <= o.maxChars) return whole + warning;

  // Over the limit: cut at a day boundary. A first day that alone does not fit is
  // cut at a meeting boundary instead — never in the middle of one.
  const kept: string[] = [];
  let used = 0;
  for (const day of days) {
    const text = day.join('\n\n');
    const add = (kept.length === 0 ? 0 : 2) + text.length;
    if (used + add <= budget) {
      kept.push(text);
      used += add;
      continue;
    }
    if (kept.length === 0) {
      const partial: string[] = [];
      let size = 0;
      for (const piece of day) {
        const grown = size + (partial.length === 0 ? 0 : 2) + piece.length;
        if (grown > budget) break;
        partial.push(piece);
        size = grown;
      }
      if (partial.length > 0) kept.push(partial.join('\n\n'));
    }
    break;
  }
  return kept.join('\n\n') + tail + warning;
}
