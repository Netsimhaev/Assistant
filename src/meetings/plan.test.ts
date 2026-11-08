import { describe, expect, it } from 'vitest';
import { HOLD_TITLE_PREFIX } from '../calendar/calendar.js';
import type { CalendarEvent, CalendarInfo } from '../calendar/types.js';
import { CalendarWriteInput } from '../orchestrator/adapters/calendar.js';
import { refineActionClass } from '../policy/classify.js';
import type { CharterOperations } from './free-time.js';
import {
  buildMeetingPlan,
  conflictRefusal,
  organizerRefusal,
  READ_ONLY_CALENDAR_REFUSAL,
  renderMeetingSummary,
  type MeetingPlanResult,
  type ResolvedClient,
} from './plan.js';
import type { MeetingRequest } from './request.js';
import { MEETING_DEFAULTS, type MeetingSettings } from './settings.js';
import type { CalendarSnapshot } from './snapshot.js';

const TZ = 'Asia/Jerusalem'; // UTC+2 in November 2026
// Sunday 2026-11-08, 10:00 local.
const NOW = new Date('2026-11-08T08:00:00Z');
const INTERNAL = 'לא-לשכוח-לגבות-חוב-7731';

const OPS = { workweek: ['sun', 'mon', 'tue', 'wed', 'thu'], businessHours: [], holidays: [] } as unknown as CharterOperations;
const SETTINGS: MeetingSettings = { ...MEETING_DEFAULTS, locationKind: 'travel', readCalendarIds: [], workStart: '09:00', workEnd: '18:00' };

const CALENDARS: CalendarInfo[] = [
  { calendarId: 'primary', name: 'ראשי', primary: true, canWrite: true },
  { calendarId: 'shared-ro', name: 'משותף', primary: false, canWrite: false },
];

function ev(over: Partial<CalendarEvent> & { eventId: string; start: string; end: string }): CalendarEvent {
  return {
    calendarId: 'primary',
    title: 'פגישה',
    allDay: false,
    location: null,
    description: null,
    organizerIsSelf: true,
    busy: true,
    selfDeclined: false,
    transactionId: null,
    attendees: [],
    ...over,
  };
}

function snap(events: CalendarEvent[], over: Partial<CalendarSnapshot> = {}): CalendarSnapshot {
  return {
    fromIso: '2026-11-08T00:00:00Z',
    toIso: '2026-11-30T00:00:00Z',
    events,
    calendars: CALENDARS,
    truncated: false,
    holds: [],
    ...over,
  };
}

const MEMORY: Record<string, ResolvedClient> = {
  'רונית לוי': { name: 'רונית לוי', email: 'ronit@beta.co.il', emailVerified: false, phone: null, phoneVerified: false },
  'דנה': { name: 'דנה', email: 'dana@mem.co', emailVerified: false, phone: '050-1112222', phoneVerified: false },
};
const resolveClient = (name: string): ResolvedClient =>
  MEMORY[name] ?? { name, email: null, emailVerified: false, phone: null, phoneVerified: false };

function build(request: MeetingRequest, snapshot: CalendarSnapshot, over: { holds?: Map<number, string>; settings?: MeetingSettings } = {}): MeetingPlanResult {
  return buildMeetingPlan({
    request,
    snapshot,
    settings: over.settings ?? SETTINGS,
    operations: OPS,
    timeZone: TZ,
    now: NOW,
    resolveClient,
    holdEventIds: over.holds ?? new Map(),
  });
}

function plan(r: MeetingPlanResult): Extract<MeetingPlanResult, { kind: 'plan' }> {
  if (r.kind !== 'plan') throw new Error(`expected plan, got ${JSON.stringify(r)}`);
  return r;
}

const create = (over: Partial<Extract<MeetingRequest['ops'][number], { kind: 'create' }>> = {}): MeetingRequest['ops'][number] => ({
  kind: 'create',
  client: { name: 'דני כהן', email: 'dani@x.co', phone: '052-3334444' },
  location: 'הרצל 5 רמת גן',
  clientNotes: 'להביא חוזה חתום',
  internalNote: INTERNAL,
  window: { fromDate: '2026-11-17', toDate: '2026-11-17', fromTime: '10:00', toTime: '12:00' },
  durationMinutes: 60,
  ...over,
});

describe('buildMeetingPlan', () => {
  it('builds one calendar.write create step with the hold id and the client as attendee', () => {
    const r = plan(build({ ops: [create()] }, snap([]), { holds: new Map([[0, 'hold-ev-1']]) }));
    expect(r.plan.steps).toHaveLength(1);
    const step = r.plan.steps[0]!;
    expect(step).toMatchObject({ id: 'm1', agent: 'sched.meetings', toolName: 'calendar.write', expectedActionClass: 'calendar.create', dependsOn: [] });
    expect(step.input).toEqual({
      operation: 'create',
      calendarId: 'primary',
      holdEventId: 'hold-ev-1',
      title: 'דני כהן',
      start: '2026-11-17T08:00:00.000Z',
      end: '2026-11-17T09:00:00.000Z',
      location: 'הרצל 5 רמת גן',
      description: 'להביא חוזה חתום\nטלפון: 052-3334444',
      attendees: ['dani@x.co'],
    });
    expect(r.summary).toContain("קביעה: דני כהן — יום ג' 17/11, 10:00–11:00, הרצל 5 רמת גן");
    expect(r.summary).toContain('תצא הזמנה אל dani@x.co');
    expect(r.summary).not.toContain('לא אומת');
  });

  it('shows the client-visible description in the summary, notes and phone, indented', () => {
    const r = plan(build({ ops: [create()] }, snap([])));
    const lines = r.summary.split('\n');
    expect(lines).toContain('    פרטים ללקוח: "להביא חוזה חתום');
    expect(lines).toContain('    טלפון: 052-3334444"');
    // A typed phone carries no marker.
    expect(r.summary).not.toContain('לא אומת');
    // No line of the description starts at column 0.
    expect(lines.filter((l) => l.startsWith('טלפון') || l.startsWith('להביא'))).toEqual([]);
    // No description → no line.
    const bare = plan(build({ ops: [create({ client: { name: 'יוסי', email: null, phone: null }, clientNotes: null })] }, snap([])));
    expect(bare.summary).not.toContain('פרטים ללקוח');
  });

  it('marks a phone from memory unverified on the details line', () => {
    const r = plan(build({ ops: [create({ client: { name: 'דנה', email: 'dana@typed.co', phone: null } })] }, snap([])));
    expect(r.summary).toContain('    טלפון: 050-1112222" (מהזיכרון — לא אומת)');
    // The email was typed: its notice carries no marker.
    expect(r.summary.split('\n')).toContain('תצא הזמנה אל dana@typed.co');
  });

  it('an edit of the client notes keeps the event\'s phone line and shows the result', () => {
    const s = snap([
      ev({ eventId: 'r1', title: 'רונית לוי', description: 'ישן\nטלפון: 054-9998888', start: '2026-11-12T09:30:00Z', end: '2026-11-12T10:30:00Z' }),
    ]);
    const r = plan(build({ ops: [{ kind: 'edit', clientNotes: 'חדש', clientName: 'רונית לוי', onDate: null }] }, s));
    expect(r.plan.steps[0]!.input['description']).toBe('חדש\nטלפון: 054-9998888');
    expect(r.summary).toContain('פרטים ללקוח: לפני "ישן\n    טלפון: 054-9998888" → אחרי "חדש\n    טלפון: 054-9998888"');
    // Clearing the notes leaves only the phone line.
    const cleared = plan(build({ ops: [{ kind: 'edit', clientNotes: null, clientName: 'רונית לוי', onDate: null }] }, s));
    expect(cleared.plan.steps[0]!.input['description']).toBe('טלפון: 054-9998888');
  });

  it('the no_slot day listing shows the working schedule, after an earlier cancel', () => {
    // Tue 17/11: יוסי 09:00–18:00 local is cancelled first; רונית's move then
    // needs Tue 09:00–10:00, which is taken by אלפא — no slot. The listing must
    // not show יוסי (cancelled in the same request).
    const s = snap([
      ev({ eventId: 'y', title: 'יוסי', start: '2026-11-17T09:00:00Z', end: '2026-11-17T16:00:00Z' }),
      ev({ eventId: 'a', title: 'אלפא', start: '2026-11-17T07:00:00Z', end: '2026-11-17T08:00:00Z' }),
      ev({ eventId: 'r', title: 'רונית לוי', start: '2026-11-19T07:00:00Z', end: '2026-11-19T08:00:00Z' }),
    ]);
    const r = build(
      {
        ops: [
          { kind: 'cancel', clientName: 'יוסי', onDate: null },
          { kind: 'move', clientName: 'רונית לוי', onDate: null, window: { fromDate: '2026-11-17', toDate: '2026-11-17', fromTime: '09:00', toTime: '10:00' } },
        ],
      },
      s,
    );
    expect(r.kind).toBe('no_slot');
    if (r.kind !== 'no_slot') return;
    expect(r.dayListing).toContain('אלפא');
    expect(r.dayListing).not.toContain('יוסי');
  });

  it('a create without email or notes gets no attendee and a null description, and the summary warns', () => {
    const r = plan(build({ ops: [create({ client: { name: 'יוסי', email: null, phone: null }, clientNotes: null })] }, snap([])));
    expect(r.plan.steps[0]!.input['attendees']).toEqual([]);
    expect(r.plan.steps[0]!.input['description']).toBeNull();
    expect(r.plan.steps[0]!.input['holdEventId']).toBeNull();
    expect(r.summary).toContain('⚠️ ליוסי אין כתובת מייל — הוא לא יקבל עדכון. תצטרך לעדכן אותו בעצמך.');
  });

  it('a hold placed on the slot does not block the rebuild with its id', () => {
    const holdEvent = ev({ eventId: 'hold-ev-1', title: `${HOLD_TITLE_PREFIX}דני כהן`, start: '2026-11-17T08:00:00Z', end: '2026-11-17T09:00:00Z' });
    const s = snap([holdEvent], { holds: [{ eventId: 'hold-ev-1', start: holdEvent.start, end: holdEvent.end }] });
    const r = plan(build({ ops: [create()] }, s, { holds: new Map([[0, 'hold-ev-1']]) }));
    expect(r.plan.steps[0]!.input['start']).toBe('2026-11-17T08:00:00.000Z');
  });

  it('never puts the internal note in a step input', () => {
    const request: MeetingRequest = {
      ops: [
        create(),
        { kind: 'edit', clientName: 'רונית לוי', onDate: null, location: 'משרד', clientNotes: 'חדש' },
      ],
    };
    const s = snap([ev({ eventId: 'r1', title: 'רונית לוי', start: '2026-11-12T09:30:00Z', end: '2026-11-12T10:30:00Z' })]);
    const r = plan(build(request, s));
    for (const step of r.plan.steps) expect(JSON.stringify(step.input)).not.toContain(INTERNAL);
    expect(JSON.stringify(r.plan)).not.toContain(INTERNAL);
    expect(r.summary).not.toContain(INTERNAL);
    const created = r.changes.find((c) => c.op === 'create');
    expect(created?.op === 'create' && created.internalNote).toBe(INTERNAL);
  });

  it('marks an email from memory unverified in the summary', () => {
    const r = plan(build({ ops: [create({ client: { name: 'דנה', email: null, phone: null } })] }, snap([])));
    expect(r.plan.steps[0]!.input['attendees']).toEqual(['dana@mem.co']);
    expect(r.summary).toContain('תצא הזמנה אל dana@mem.co (מהזיכרון — לא אומת)');
    expect(r.plan.steps[0]!.input['description']).toBe('להביא חוזה חתום\nטלפון: 050-1112222');
  });

  it('asks which meeting when two events match', () => {
    const s = snap([
      ev({ eventId: 'a', title: 'רונית לוי — חוזה', start: '2026-11-12T07:00:00Z', end: '2026-11-12T08:00:00Z' }),
      ev({ eventId: 'b', title: 'שיחה', start: '2026-11-15T07:00:00Z', end: '2026-11-15T08:00:00Z', attendees: [{ email: 'RONIT@beta.co.il', response: 'accepted' }] }),
      ev({ eventId: 'h', title: `${HOLD_TITLE_PREFIX}רונית לוי`, start: '2026-11-16T07:00:00Z', end: '2026-11-16T08:00:00Z' }),
    ]);
    const r = build({ ops: [{ kind: 'cancel', clientName: 'רונית לוי', onDate: null }] }, s);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates.map((c) => c.eventId)).toEqual(['a', 'b']);
    // onDate narrows it to one.
    expect(build({ ops: [{ kind: 'cancel', clientName: 'רונית לוי', onDate: '2026-11-15' }] }, s).kind).toBe('plan');
  });

  it('answers not_found when no event matches (holds never match)', () => {
    const s = snap([ev({ eventId: 'h', title: `${HOLD_TITLE_PREFIX}משה`, start: '2026-11-16T07:00:00Z', end: '2026-11-16T08:00:00Z' })]);
    expect(build({ ops: [{ kind: 'cancel', clientName: 'משה', onDate: null }] }, s)).toEqual({ kind: 'not_found', clientName: 'משה' });
  });

  it('refuses to plan a move of an event the owner does not organize', () => {
    const s = snap([
      ev({ eventId: 'x', title: 'רונית לוי', organizerIsSelf: false, attendees: [{ email: 'ronit@beta.co.il', response: 'accepted' }], start: '2026-11-12T07:00:00Z', end: '2026-11-12T08:00:00Z' }),
    ]);
    const r = build({ ops: [{ kind: 'move', clientName: 'רונית לוי', onDate: null, window: { fromDate: '2026-11-15', toDate: '2026-11-15', fromTime: null, toTime: null } }] }, s);
    expect(r).toEqual({ kind: 'refused', reason: organizerRefusal('רונית לוי') });
    expect(organizerRefusal('רונית לוי')).toBe('את הפגישה הזו קבע רונית לוי — את המועד צריך לשנות מולו.');
  });

  it('refuses an event in a calendar without write access', () => {
    const s = snap([ev({ eventId: 'x', calendarId: 'shared-ro', title: 'רונית לוי', start: '2026-11-12T07:00:00Z', end: '2026-11-12T08:00:00Z' })]);
    expect(build({ ops: [{ kind: 'cancel', clientName: 'רונית לוי', onDate: null }] }, s)).toEqual({ kind: 'refused', reason: READ_ONLY_CALENDAR_REFUSAL });
    // A create into a read-only write calendar is refused the same way.
    const ro: MeetingSettings = { ...SETTINGS, writeCalendarId: 'shared-ro' };
    expect(build({ ops: [create()] }, snap([]), { settings: ro })).toEqual({ kind: 'refused', reason: READ_ONLY_CALENDAR_REFUSAL });
  });

  it('refuses a reshuffle whose final schedule overlaps, naming both', () => {
    // Two calendars hold events with the SAME id. Moving "רונית לוי" ignores
    // that id in the search, so the slot search lands on the other calendar's
    // event — the final check (keyed by calendar AND id) refuses the plan.
    const calendars: CalendarInfo[] = [...CALENDARS, { calendarId: 'work', name: 'עבודה', primary: false, canWrite: true }];
    const s = snap(
      [
        ev({ eventId: 'same', title: 'רונית לוי', start: '2026-11-12T07:00:00Z', end: '2026-11-12T08:00:00Z' }),
        ev({ eventId: 'same', calendarId: 'work', title: 'ישיבת צוות', start: '2026-11-15T07:00:00Z', end: '2026-11-15T08:00:00Z' }),
      ],
      { calendars },
    );
    const r = build(
      { ops: [{ kind: 'move', clientName: 'רונית לוי', onDate: null, window: { fromDate: '2026-11-15', toDate: '2026-11-15', fromTime: '09:00', toTime: '10:00' } }] },
      s,
    );
    expect(r).toEqual({ kind: 'refused', reason: conflictRefusal('רונית לוי', 'ישיבת צוות') });
  });

  it('does not refuse an unrelated change because of the owner\'s own pre-existing overlap', () => {
    const s = snap([
      ev({ eventId: 'p', title: 'א', start: '2026-11-20T07:00:00Z', end: '2026-11-20T08:00:00Z' }),
      ev({ eventId: 'q', title: 'ב', start: '2026-11-20T07:30:00Z', end: '2026-11-20T08:30:00Z' }),
    ]);
    expect(build({ ops: [create()] }, s).kind).toBe('plan');
  });

  it('orders a vacate-then-fill reshuffle with dependsOn', () => {
    // רונית sits Tue 17/11 10:00–11:00. Move her to Sunday, put דני at 10:00 in her place.
    const s = snap([
      ev({ eventId: 'r1', title: 'רונית לוי', start: '2026-11-17T08:00:00Z', end: '2026-11-17T09:00:00Z', attendees: [{ email: 'ronit@beta.co.il', response: 'accepted' }] }),
      ev({ eventId: 'c1', title: 'יוסי', start: '2026-11-19T08:00:00Z', end: '2026-11-19T09:00:00Z' }),
    ]);
    const request: MeetingRequest = {
      ops: [
        create({ window: { fromDate: '2026-11-17', toDate: '2026-11-17', fromTime: '10:00', toTime: '11:00' } }),
        { kind: 'move', clientName: 'רונית לוי', onDate: null, window: { fromDate: '2026-11-15', toDate: '2026-11-15', fromTime: null, toTime: null } },
        { kind: 'cancel', clientName: 'יוסי', onDate: null },
      ],
    };
    const r = plan(build(request, s));
    expect(r.plan.steps.map((st) => [st.id, st.input['operation']])).toEqual([
      ['m1', 'cancel'],
      ['m2', 'move'],
      ['m3', 'create'],
    ]);
    expect(r.plan.steps[1]!.input).toEqual({ operation: 'move', calendarId: 'primary', eventId: 'r1', start: '2026-11-15T07:00:00.000Z', end: '2026-11-15T08:00:00.000Z' });
    // The create fills the interval the move vacated; the cancel was elsewhere.
    expect(r.plan.steps[2]!.dependsOn).toEqual(['m2']);
    expect(r.plan.steps[2]!.input['start']).toBe('2026-11-17T08:00:00.000Z');
    expect(r.plan.steps[1]!.dependsOn).toEqual([]);
    expect(r.summary).toContain("הזזה: רונית לוי — מיום ג' 17/11 10:00 ליום א' 15/11 09:00");
    expect(r.summary).toContain("ביטול: יוסי — יום ה' 19/11, 10:00–11:00");
    expect(r.summary).toContain('יצא עדכון אל ronit@beta.co.il');
    expect(r.summary).toContain('⚠️ ליוסי אין כתובת מייל');
  });

  it('never displaces a settled client: a full window is no_slot, not a move', () => {
    const s = snap([ev({ eventId: 'r1', title: 'רונית לוי', start: '2026-11-17T08:00:00Z', end: '2026-11-17T09:00:00Z' })]);
    const r = build({ ops: [create({ window: { fromDate: '2026-11-17', toDate: '2026-11-17', fromTime: '10:00', toTime: '11:00' } })] }, s);
    expect(r.kind).toBe('no_slot');
  });

  it('returns no_slot with three alternatives after the window', () => {
    // Tue 17/11 is busy all work day; Wed 18/11 is free.
    const s = snap([ev({ eventId: 'big', title: 'כנס', start: '2026-11-17T06:00:00Z', end: '2026-11-17T17:00:00Z' })]);
    const r = build({ ops: [create({ window: { fromDate: '2026-11-17', toDate: '2026-11-17', fromTime: null, toTime: null } })] }, s);
    expect(r.kind).toBe('no_slot');
    if (r.kind !== 'no_slot') return;
    expect(r.opIndex).toBe(0);
    expect(r.dayListing).toContain("יום ג' 17/11");
    expect(r.dayListing).toContain('כנס');
    // 60 min + 30 min gap: three on the same day, stepping 90 minutes.
    expect(r.alternatives.map((a) => new Date(a.start).toISOString())).toEqual([
      '2026-11-18T07:00:00.000Z',
      '2026-11-18T08:30:00.000Z',
      '2026-11-18T10:00:00.000Z',
    ]);
  });

  it('offers no alternative beyond the snapshot range', () => {
    const s = snap([ev({ eventId: 'big', title: 'כנס', start: '2026-11-17T06:00:00Z', end: '2026-11-17T17:00:00Z' })], { toIso: '2026-11-17T22:00:00Z' });
    const r = build({ ops: [create({ window: { fromDate: '2026-11-17', toDate: '2026-11-17', fromTime: null, toTime: null } })] }, s);
    expect(r.kind === 'no_slot' && r.alternatives).toEqual([]);
  });

  it('an edit becomes an update that shows before and after', () => {
    const s = snap([ev({ eventId: 'r1', title: 'רונית לוי', location: 'הרצל 5', start: '2026-11-12T09:30:00Z', end: '2026-11-12T10:30:00Z' })]);
    const r = plan(build({ ops: [{ kind: 'edit', clientName: 'רונית לוי', onDate: null, location: 'במשרד' }] }, s));
    expect(r.plan.steps[0]!.input).toEqual({ operation: 'update', calendarId: 'primary', eventId: 'r1', location: 'במשרד' });
    expect(r.plan.steps[0]!.expectedActionClass).toBe('calendar.update');
    expect(r.summary).toContain("עריכה: רונית לוי — יום ה' 12/11 11:30");
    expect(r.summary).toContain('מיקום: לפני "הרצל 5" → אחרי "במשרד"');
  });

  it('every step input parses with CalendarWriteInput and refines to its expectedActionClass', () => {
    const s = snap([
      ev({ eventId: 'r1', title: 'רונית לוי', start: '2026-11-17T08:00:00Z', end: '2026-11-17T09:00:00Z' }),
      ev({ eventId: 'c1', title: 'יוסי', start: '2026-11-19T08:00:00Z', end: '2026-11-19T09:00:00Z' }),
      ev({ eventId: 'e1', title: 'אלפא', start: '2026-11-19T12:00:00Z', end: '2026-11-19T13:00:00Z' }),
    ]);
    const request: MeetingRequest = {
      ops: [
        create(),
        { kind: 'move', clientName: 'רונית לוי', onDate: null, window: { fromDate: '2026-11-15', toDate: '2026-11-16', fromTime: null, toTime: null } },
        { kind: 'cancel', clientName: 'יוסי', onDate: null },
        { kind: 'edit', clientName: 'אלפא', onDate: null, clientNotes: null },
      ],
    };
    const r = plan(build(request, s, { holds: new Map([[0, 'h-0']]) }));
    const classes = r.plan.steps.map((st) => {
      expect(CalendarWriteInput.safeParse(st.input).success).toBe(true);
      expect(refineActionClass('calendar.create', st.input)).toBe(st.expectedActionClass);
      return st.expectedActionClass;
    });
    expect(classes.sort()).toEqual(['calendar.cancel', 'calendar.create', 'calendar.move', 'calendar.update']);
  });
});

describe('renderMeetingSummary', () => {
  it('uses the charter zone for times', () => {
    const text = renderMeetingSummary(
      [
        {
          op: 'create',
          client: { name: 'דני', email: null, emailVerified: false, phone: null, phoneVerified: false },
          calendarId: 'primary',
          start: '2026-11-17T08:00:00Z',
          end: '2026-11-17T09:00:00Z',
          location: null,
          clientNotes: null,
          internalNote: null,
          needsHold: true,
        },
      ],
      'America/New_York',
    );
    expect(text).toContain("קביעה: דני — יום ג' 17/11, 03:00–04:00");
  });
});
