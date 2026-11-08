import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../calendar/types.js';
import type { Interval } from './free-time.js';
import {
  CONTINUE_ON_DASHBOARD,
  parseScheduleQuery,
  renderSchedule,
  TRUNCATED_SNAPSHOT_WARNING,
  type MeetingResponse,
} from './query.js';
import type { CalendarSnapshot } from './snapshot.js';

const TZ = 'Asia/Jerusalem';
// Wednesday 11/11/2026, 10:00 local (UTC+2).
const NOW = new Date('2026-11-11T08:00:00Z');

describe('parseScheduleQuery', () => {
  it('parses מחר, השבוע, שבוע הבא, ביום שלישי and 12/11 in Asia/Jerusalem', () => {
    const q = (t: string) => parseScheduleQuery(t, NOW, TZ);
    expect(q('מה יש לי מחר?')).toEqual({ fromDate: '2026-11-12', toDate: '2026-11-12' });
    expect(q('מה יש לי מחרתיים')).toEqual({ fromDate: '2026-11-13', toDate: '2026-11-13' });
    expect(q('מה יש לי היום')).toEqual({ fromDate: '2026-11-11', toDate: '2026-11-11' });
    expect(q('מה יש לי השבוע?')).toEqual({ fromDate: '2026-11-11', toDate: '2026-11-14' });
    expect(q('מה יש לי בשבוע הבא')).toEqual({ fromDate: '2026-11-15', toDate: '2026-11-21' });
    expect(q('מה יש לי ביום שלישי')).toEqual({ fromDate: '2026-11-17', toDate: '2026-11-17' });
    expect(q('מה הלו"ז בשלישי')).toEqual({ fromDate: '2026-11-17', toDate: '2026-11-17' });
    expect(q('מה ביומן ביום רביעי')).toEqual({ fromDate: '2026-11-11', toDate: '2026-11-11' }); // today included
    expect(q('מה יש לי ב-12/11')).toEqual({ fromDate: '2026-11-12', toDate: '2026-11-12' });
    expect(q('מה הלוז 8/11')).toEqual({ fromDate: '2027-11-08', toDate: '2027-11-08' }); // already past: next year
  });

  it('uses the charter zone for "today", not the process zone', () => {
    // 22:30Z on the 11th is already the 12th in Jerusalem.
    expect(parseScheduleQuery('מה יש לי היום', new Date('2026-11-11T22:30:00Z'), TZ)).toEqual({
      fromDate: '2026-11-12',
      toDate: '2026-11-12',
    });
  });

  it('returns null for a non-schedule instruction', () => {
    expect(parseScheduleQuery('תשלחי לדנה את ההצעה מחר', NOW, TZ)).toBeNull();
    expect(parseScheduleQuery('שלום', NOW, TZ)).toBeNull();
  });

  it('returns unrecognized_range only for the bare trigger (or fillers) with no range', () => {
    expect(parseScheduleQuery('מה יש לי?', NOW, TZ)).toBe('unrecognized_range');
    expect(parseScheduleQuery('מה הלוז', NOW, TZ)).toBe('unrecognized_range');
    expect(parseScheduleQuery('מה הלו"ז בבקשה', NOW, TZ)).toBe('unrecognized_range');
    expect(parseScheduleQuery('מה יש לי ב-31/02', NOW, TZ)).toBe('unrecognized_range');
    expect(parseScheduleQuery('מה יש לי שבוע', NOW, TZ)).toBe('unrecognized_range');
  });

  it('is not fooled by look-alikes: anything beyond the trigger and a range goes to the planner', () => {
    for (const text of [
      'כמה יש לי בחשבון היום?',
      'מה יש ליוסי מחר?',
      'מה יש לי לשלם השבוע',
      'מה הלוז של דני מחר',
      'סמה ביומן מחר',
      'מה יש לי במייל',
      'מה יש לי לעשות',
      'מה יש לי בקרוב',
      'מה יש לי מחר ותשלחי לדנה',
    ]) {
      expect(parseScheduleQuery(text, NOW, TZ), text).toBeNull();
    }
  });

  it('השבוע הבא and בשבוע הבא mean next week; weekday + הבא is the occurrence after the coming one', () => {
    const q = (t: string) => parseScheduleQuery(t, NOW, TZ);
    expect(q('מה יש לי השבוע הבא')).toEqual({ fromDate: '2026-11-15', toDate: '2026-11-21' });
    expect(q('מה יש לי בשבוע הבא')).toEqual({ fromDate: '2026-11-15', toDate: '2026-11-21' });
    expect(q('מה יש לי ביום שלישי הבא')).toEqual({ fromDate: '2026-11-24', toDate: '2026-11-24' });
    expect(q('מה יש לי ביום שלישי')).toEqual({ fromDate: '2026-11-17', toDate: '2026-11-17' });
    // "הבא" after a day word means nothing
    expect(q('מה יש לי מחר הבא')).toBeNull();
  });
});

function ev(over: Partial<CalendarEvent> & { start: string; end: string; title: string }): CalendarEvent {
  return {
    calendarId: 'c', eventId: over.eventId ?? `e-${over.start}`, allDay: false, location: null, description: null,
    organizerIsSelf: true, busy: true, selfDeclined: false, transactionId: null, attendees: [], ...over,
  };
}
function snap(events: CalendarEvent[], truncated = false): CalendarSnapshot {
  return { fromIso: '2026-11-01T00:00:00Z', toIso: '2026-12-01T00:00:00Z', events, calendars: [], truncated, holds: [] };
}
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+02:00`);
const iv = (date: string, a: string, b: string): Interval => ({ start: at(date, a), end: at(date, b) });
const iso = (date: string, hhmm: string) => new Date(at(date, hhmm)).toISOString();

const DAY = '2026-11-12';
const THREE: CalendarEvent[] = [
  ev({ eventId: 'a', title: 'דני כהן', start: iso(DAY, '09:00'), end: iso(DAY, '10:00'), location: 'הרצל 5, רמת גן', description: 'להביא חוזה חתום\nשורה שנייה' }),
  ev({ eventId: 'b', title: 'רונית לוי', start: iso(DAY, '11:30'), end: iso(DAY, '12:30'), location: 'במשרד' }),
  ev({ eventId: 'c', title: 'אלפא בע"מ', start: iso(DAY, '15:00'), end: iso(DAY, '16:00'), location: 'המלאכה 12, חולון', description: 'פגישת היכרות' }),
];
const RESPONSES = new Map<string, MeetingResponse>([['a', 'accepted'], ['b', 'needs_action']]);

describe('renderSchedule', () => {
  it('renders format A with the פנוי line', () => {
    const text = renderSchedule({
      range: { fromDate: DAY, toDate: DAY },
      snapshot: snap(THREE),
      responses: RESPONSES,
      free: new Map([[DAY, [iv(DAY, '10:00', '11:30'), iv(DAY, '12:30', '15:00'), iv(DAY, '16:00', '18:00')]]]),
      windowEnds: new Map([[DAY, at(DAY, '18:00')]]),
      timeZone: TZ,
      maxChars: 4000,
    });
    expect(text).toBe(
      [
        "*יום ה' 12/11 — 3 פגישות*",
        '',
        '*09:00–10:00 · דני כהן*  ✅ אישר',
        '📍 הרצל 5, רמת גן',
        '📝 להביא חוזה חתום',
        '',
        '*11:30–12:30 · רונית לוי*  ⏳ ממתין לתשובה',
        '📍 במשרד',
        '📝 —',
        '',
        '*15:00–16:00 · אלפא בע"מ*',
        '📍 המלאכה 12, חולון',
        '📝 פגישת היכרות',
        '',
        'פנוי: 10:00–11:30, 12:30–15:00, אחרי 16:00',
      ].join('\n'),
    );
  });

  it('renders אחרי HH:MM when free runs to close, and — when nothing is free', () => {
    const base = { range: { fromDate: DAY, toDate: DAY }, snapshot: snap([]), responses: new Map(), timeZone: TZ, maxChars: 4000 };
    const open = renderSchedule({ ...base, free: new Map([[DAY, [iv(DAY, '09:00', '18:00')]]]), windowEnds: new Map([[DAY, at(DAY, '18:00')]]) });
    expect(open).toBe("*יום ה' 12/11 — אין פגישות*\n\nפנוי: אחרי 09:00");
    // Free time that ends at a meeting, not at close, keeps its end.
    const closed = renderSchedule({ ...base, free: new Map([[DAY, [iv(DAY, '09:00', '12:00')]]]), windowEnds: new Map([[DAY, at(DAY, '18:00')]]) });
    expect(closed).toContain('פנוי: 09:00–12:00');
    const none = renderSchedule({ ...base, free: new Map([[DAY, []]]) });
    expect(none).toContain('פנוי: —');
  });

  it('derives the icon from the attendees when no meetings row exists, and none for solo events', () => {
    const events = [
      ev({ eventId: 'x', title: 'א', start: iso(DAY, '09:00'), end: iso(DAY, '10:00'), attendees: [{ email: 'a@x.co', response: 'declined' }] }),
      ev({ eventId: 'y', title: 'ב', start: iso(DAY, '10:00'), end: iso(DAY, '11:00'), attendees: [{ email: 'a@x.co', response: 'accepted' }] }),
      ev({ eventId: 'z', title: 'ג', start: iso(DAY, '11:00'), end: iso(DAY, '12:00'), attendees: [{ email: 'a@x.co', response: 'tentative' }] }),
      ev({ eventId: 'w', title: 'ד', start: iso(DAY, '12:00'), end: iso(DAY, '13:00') }),
      ev({ eventId: 'v', title: 'ה', start: iso(DAY, '13:00'), end: iso(DAY, '14:00') }),
    ];
    const text = renderSchedule({
      range: { fromDate: DAY, toDate: DAY }, snapshot: snap(events), responses: new Map([['v', 'not_updated']]),
      free: new Map(), timeZone: TZ, maxChars: 4000,
    });
    expect(text).toContain('*09:00–10:00 · א*  ❌ דחה');
    expect(text).toContain('*10:00–11:00 · ב*  ✅ אישר');
    expect(text).toContain('*11:00–12:00 · ג*  ⏳ ממתין לתשובה');
    expect(text).toContain('*12:00–13:00 · ד*\n');
    expect(text).toContain('*13:00–14:00 · ה*  ⚠️ לא עודכן');
  });

  it('shows all-day events', () => {
    const events = [
      ev({ title: 'חג', allDay: true, start: iso('2026-11-12', '00:00'), end: iso('2026-11-13', '00:00') }),
    ];
    const text = renderSchedule({ range: { fromDate: DAY, toDate: DAY }, snapshot: snap(events), responses: new Map(), free: new Map(), timeZone: TZ, maxChars: 4000 });
    expect(text).toContain("*יום ה' 12/11 — פגישה אחת*");
    expect(text).toContain('*כל היום · חג*');
  });

  it('lists an event the owner declined with ❌ דחית, outside the header count', () => {
    const events = [
      ev({ eventId: 'q', title: 'נדחה', selfDeclined: true, start: iso(DAY, '09:00'), end: iso(DAY, '10:00') }),
      ev({ eventId: 'r', title: 'נשאר', start: iso(DAY, '11:00'), end: iso(DAY, '12:00') }),
    ];
    const text = renderSchedule({ range: { fromDate: DAY, toDate: DAY }, snapshot: snap(events), responses: new Map(), free: new Map(), timeZone: TZ, maxChars: 4000 });
    expect(text).toContain("*יום ה' 12/11 — פגישה אחת*");
    expect(text).toContain('*09:00–10:00 · נדחה*  ❌ דחית');
    expect(text).toContain('*11:00–12:00 · נשאר*');
    const onlyDeclined = renderSchedule({ range: { fromDate: DAY, toDate: DAY }, snapshot: snap(events.slice(0, 1)), responses: new Map(), free: new Map(), timeZone: TZ, maxChars: 4000 });
    expect(onlyDeclined).toContain("*יום ה' 12/11 — אין פגישות*");
    expect(onlyDeclined).toContain('❌ דחית');
  });

  it('prints no פנוי line for a non-work day inside a range (Saturday in השבוע)', () => {
    const FRI = '2026-11-13';
    const SAT = '2026-11-14';
    const text = renderSchedule({
      range: { fromDate: FRI, toDate: SAT }, snapshot: snap([]), responses: new Map(),
      free: new Map([[FRI, [iv(FRI, '09:00', '18:00')]]]), timeZone: TZ, maxChars: 4000,
    });
    expect(text).toBe(["*יום ו' 13/11 — אין פגישות*", '', 'פנוי: 09:00–18:00', '', "*יום ש' 14/11 — אין פגישות*"].join('\n'));
  });

  it('returns just the pointer when not even the first day fits', () => {
    const text = renderSchedule({ range: { fromDate: DAY, toDate: DAY }, snapshot: snap(THREE), responses: RESPONSES, free: new Map(), timeZone: TZ, maxChars: 30 });
    expect(text).toBe(CONTINUE_ON_DASHBOARD);
  });

  it('falls through a bidi-only first description line to the next line', () => {
    const events = [ev({ title: 'א', start: iso(DAY, '09:00'), end: iso(DAY, '10:00'), description: [String.fromCharCode(0x202e, 0x200f), 'השורה האמיתית'].join('\n') })];
    const text = renderSchedule({ range: { fromDate: DAY, toDate: DAY }, snapshot: snap(events), responses: new Map(), free: new Map(), timeZone: TZ, maxChars: 4000 });
    expect(text).toContain('📝 השורה האמיתית');
  });

  it('cuts at a day boundary over the limit and appends the continuation line', () => {
    const days = ['2026-11-12', '2026-11-13', '2026-11-14'];
    const events = days.map((d, i) => ev({ eventId: `d${i}`, title: `פגישה ${i}`, start: iso(d, '09:00'), end: iso(d, '10:00') }));
    const range = { fromDate: days[0] as string, toDate: days[2] as string };
    const full = renderSchedule({ range, snapshot: snap(events), responses: new Map(), free: new Map(), timeZone: TZ, maxChars: 4000 });
    const oneDay = full.split('\n\n').slice(0, 2).join('\n\n').length; // header + one event = one day
    const text = renderSchedule({ range, snapshot: snap(events), responses: new Map(), free: new Map(), timeZone: TZ, maxChars: oneDay * 2 + 20 });
    expect(text.endsWith(CONTINUE_ON_DASHBOARD)).toBe(true);
    expect(text).toContain('פגישה 0');
    expect(text).toContain('פגישה 1');
    expect(text).not.toContain('פגישה 2');
    expect(text).not.toContain('14/11'); // never a header without its meetings
    expect(text.length).toBeLessThanOrEqual(oneDay * 2 + 20);
  });

  it('appends the truncated-snapshot warning', () => {
    const text = renderSchedule({ range: { fromDate: DAY, toDate: DAY }, snapshot: snap([], true), responses: new Map(), free: new Map(), timeZone: TZ, maxChars: 4000 });
    expect(text.endsWith(TRUNCATED_SNAPSHOT_WARNING)).toBe(true);
  });

  it('strips bidi controls from titles and locations, folds line breaks, and cannot break the bold run', () => {
    const events = [
      ev({ title: '\u202Eדני*\nכהן', start: iso(DAY, '09:00'), end: iso(DAY, '10:00'), location: 'הרצל\u202E 5\r\nקומה 2\u2067', description: '\n  \u202Eהערה\nשנייה' }),
    ];
    const text = renderSchedule({ range: { fromDate: DAY, toDate: DAY }, snapshot: snap(events), responses: new Map(), free: new Map(), timeZone: TZ, maxChars: 4000 });
    expect(text).not.toMatch(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/u);
    expect(text).toContain('*09:00–10:00 · דני כהן*');
    expect(text).toContain('📍 הרצל 5 קומה 2');
    expect(text).toContain('📝 הערה');
    expect(text).not.toContain('שנייה');
  });
});
