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

/**
 * Trigger phrases, as WHOLE tokens ("סמה ביומן", "ליוסי" and "מה הלוז של דני" are not
 * schedule questions). `לו"ז` is folded to `לוז` before tokenising.
 */
const TRIGGERS: readonly (readonly string[])[] = [
  ['מה', 'יש', 'לי'],
  ['מה', 'הלוז'],
  ['מה', 'לוז'],
  ['מה', 'ביומן'],
  ['מה', 'יש', 'ביומן'],
];
/** Words that may sit beside the trigger without saying anything else. */
const FILLERS: ReadonlySet<string> = new Set(['בבקשה', 'לי', 'אז', 'נא', 'ב', 'ל', 'ביום', 'ליום', 'יום']);
const DATE_TOKEN = /^\d{1,2}\/\d{1,2}$/u;
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

type RangeItem =
  | { kind: 'date'; day: number; month: number }
  | { kind: 'offset'; days: number }
  | { kind: 'thisWeek'; next: boolean }
  | { kind: 'week'; next: boolean }
  | { kind: 'weekday'; index: number; next: boolean };

/** `היום`, `למחר`, `בשלישי` … : the word itself, or the word after one ב/ל prefix. */
function rangeWord(token: string): RangeItem | null {
  for (const word of [token, token.startsWith('ב') || token.startsWith('ל') ? token.slice(1) : '']) {
    if (word === '') continue;
    if (word === 'היום') return { kind: 'offset', days: 0 };
    if (word === 'מחר') return { kind: 'offset', days: 1 };
    if (word === 'מחרתיים') return { kind: 'offset', days: 2 };
    if (word === 'השבוע') return { kind: 'thisWeek', next: false };
    if (word === 'שבוע') return { kind: 'week', next: false };
    if (Object.hasOwn(WEEKDAY_INDEX, word)) return { kind: 'weekday', index: WEEKDAY_INDEX[word] as number, next: false };
  }
  return null;
}

/**
 * `null`: not a schedule question — it goes to the planner. The text counts as one
 * ONLY when, besides the trigger ("מה יש לי", "מה הלוז", "מה ביומן"), every token is a
 * range word, a range preposition, a date, or a filler: anything else ("מה יש לי
 * במייל", "מה הלוז של דני מחר", "כמה יש לי בחשבון היום") is some other request.
 * `'unrecognized_range'`: the bare trigger (or fillers only) with no range at all.
 * Otherwise the inclusive local range.
 */
export function parseScheduleQuery(text: string, now: Date, timeZone: string): QueryRange | 'unrecognized_range' | null {
  const folded = stripBidiControls(text).replace(/לו["״”“]ז/gu, 'לוז');
  const tokens = folded.split(/[^\p{L}\p{N}/]+/u).filter((t) => t !== '');

  let rest: string[] | null = null;
  for (let i = 0; i < tokens.length && rest === null; i += 1) {
    for (const trigger of TRIGGERS) {
      if (trigger.every((word, k) => tokens[i + k] === word)) {
        rest = [...tokens.slice(0, i), ...tokens.slice(i + trigger.length)];
        break;
      }
    }
  }
  if (rest === null) return null;

  let item = null as RangeItem | null;
  for (const token of rest) {
    if (token === 'הבא') {
      const current: RangeItem | null = item;
      if (current === null || current.kind === 'date' || current.kind === 'offset' || current.next) return null;
      item = { ...current, next: true };
      continue;
    }
    if (FILLERS.has(token)) continue;
    const parsed = DATE_TOKEN.test(token)
      ? ((m) => ({ kind: 'date', day: Number(m[0]), month: Number(m[1]) }) as RangeItem)(token.split('/'))
      : rangeWord(token);
    if (parsed === null || item !== null) return null;
    item = parsed;
  }
  if (item === null) return 'unrecognized_range';

  const today = localParts(now, timeZone);
  const todayIndex = WEEKDAY_ORDER.indexOf(today.weekday);
  const single = (date: string): QueryRange => ({ fromDate: date, toDate: date });
  // Next Sunday through Saturday.
  const nextWeek = (): QueryRange => {
    const start = addDays(today.date, 7 - todayIndex);
    return { fromDate: start, toDate: addDays(start, 6) };
  };

  switch (item.kind) {
    case 'date': {
      const year = Number(today.date.slice(0, 4));
      if (!isRealDate(year, item.month, item.day)) return 'unrecognized_range';
      let date = `${year}-${pad2(item.month)}-${pad2(item.day)}`;
      // A date already past this year means the next occurrence.
      if (date < today.date) {
        if (!isRealDate(year + 1, item.month, item.day)) return 'unrecognized_range';
        date = `${year + 1}-${pad2(item.month)}-${pad2(item.day)}`;
      }
      return single(date);
    }
    case 'offset':
      return single(addDays(today.date, item.days));
    case 'week':
      // "שבוע" alone says nothing about which week.
      return item.next ? nextWeek() : 'unrecognized_range';
    case 'thisWeek':
      return item.next ? nextWeek() : { fromDate: today.date, toDate: addDays(today.date, 6 - todayIndex) };
    case 'weekday': {
      // The next occurrence, today included; "… הבא" is the one after it.
      const coming = ((item.index - todayIndex) % 7 + 7) % 7;
      return single(addDays(today.date, coming + (item.next ? 7 : 0)));
    }
  }
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

/** First line with visible text: bidi controls are stripped BEFORE the emptiness test. */
function firstLine(value: string | null): string {
  if (value === null) return '';
  for (const line of value.split(/\r\n|[\r\n\u2028\u2029]/u)) {
    const cleaned = clean(line);
    if (cleaned !== '') return cleaned;
  }
  return '';
}

function responseLine(event: CalendarEvent, responses: ReadonlyMap<string, MeetingResponse>): string {
  // The owner declined it himself: still on the calendar, so still listed.
  if (event.selfDeclined) return '  ❌ דחית';
  const known = responses.get(event.eventId);
  if (known !== undefined) return `  ${RESPONSE_LABEL[known]}`;
  if (event.attendees.length === 0) return '';
  if (event.attendees.some((a) => a.response === 'declined')) return `  ${RESPONSE_LABEL.declined}`;
  if (event.attendees.every((a) => a.response === 'accepted')) return `  ${RESPONSE_LABEL.accepted}`;
  return `  ${RESPONSE_LABEL.needs_action}`;
}

/** Local `HH:MM` of an instant in the charter zone. */
export function hhmm(ms: number, timeZone: string): string {
  return localParts(new Date(ms), timeZone).time;
}

/** `יום ג' 17/11` — the local day of an instant, in the same form as the schedule headers. */
export function localDayLabel(ms: number, timeZone: string): string {
  const parts = localParts(new Date(ms), timeZone);
  return `יום ${WEEKDAY_LETTER[parts.weekday]} ${formatDate(parts.date)}`;
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
      .filter((e) => {
        const s = Date.parse(e.start);
        const en = Date.parse(e.end);
        return Number.isFinite(s) && Number.isFinite(en) && s < dayEnd && (en > dayStart || s >= dayStart);
      })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title));

    const weekday = localParts(new Date(dayStart + 12 * 3_600_000), tz).weekday;
    const pieces = [`*יום ${WEEKDAY_LETTER[weekday]} ${formatDate(date)} — ${meetingsLabel(events.filter((e) => !e.selfDeclined).length)}*`];
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
  // Not even the first day's header fits: just the pointer, with no leading blank lines.
  return [kept.join('\n\n'), CONTINUE_ON_DASHBOARD, ...(warning === '' ? [] : [TRUNCATED_SNAPSHOT_WARNING])]
    .filter((part) => part !== '')
    .join('\n\n');
}
