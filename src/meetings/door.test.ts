/**
 * The meeting door through the instruction door (calendar scheduling §7.2–§7.4):
 * extraction (injected) → snapshot → deterministic plan → holds → ONE boss
 * confirmation, and on "כן" the existing runner under `confirmedCommandCovers`.
 * Real Postgres; the extractor, the calendar client and the credential source
 * are injected — the real model is never called.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR_SYSTEM, HOLD_TITLE_PREFIX } from '../calendar/calendar.js';
import type { CalendarClient, CalendarEvent, EventWrite } from '../calendar/types.js';
import { calendarConnection } from '../charter/amend-calendar.js';
import { installCharter } from '../charter/store.js';
import { closePool, getPool } from '../db/pool.js';
import { loadAutonomyMode } from '../governance/autonomy-mode.js';
import { loadConfirmation } from '../governance/instruction-confirmations.js';
import { createCalendarAdapter } from '../orchestrator/adapters/calendar.js';
import { AdapterRegistry } from '../orchestrator/adapters/registry.js';
import { upsertBinding } from '../orchestrator/bindings.js';
import { applyConfirmation } from '../orchestrator/command-confirm.js';
import { envCredentials } from '../orchestrator/credentials.js';
import { runInstruction, type InstructionOutcome } from '../orchestrator/instruct.js';
import { loadJob } from '../orchestrator/jobs.js';
import { loadPlanBody } from '../orchestrator/plan-store.js';
import { runDueJobs } from '../orchestrator/run-due.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { CONFIRMED_COMMAND_EXEMPTION_MARKER } from '../policy/confirmed-command.js';
import type { ExtractorOutcome, MeetingExtractor } from '../sdk/meeting-extractor.js';
import type { PlanOutcome, PlanRequest } from '../sdk/planner.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { localParts, localToInstant } from '../util/local-time.js';
import { CALENDAR_NOT_CONNECTED_REPLY, HOLD_FAILED_REPLY, MEETING_NOT_UNDERSTOOD_REPLY } from './door.js';
import { sweepHolds } from './holds.js';
import type { MeetingRequest } from './request.js';
import { MEETING_DEFAULTS, saveMeetingSettings } from './settings.js';

const BUSINESS = 'test-business';
const TZ = 'Asia/Jerusalem';
const PREFIX = 'TEST_CRED_';
const CREDENTIALS = envCredentials({ [`${PREFIX}OAUTH_CALENDAR`]: 'tok' }, PREFIX);

function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

/** The first Sunday–Thursday at least two days from today (real clock: the confirmation window is). */
function workDay(after = 2): string {
  let date = addDays(localParts(new Date(), TZ).date, after);
  for (;;) {
    const weekday = localParts(localToInstant(date, '12:00', TZ), TZ).weekday;
    if (weekday !== 'fri' && weekday !== 'sat') return date;
    date = addDays(date, 1);
  }
}

const at = (date: string, hhmm: string): string => localToInstant(date, hhmm, TZ).toISOString();

interface Call {
  op: 'create' | 'update' | 'delete' | 'get' | 'list';
  args: unknown[];
}

/** A stateful recording calendar: one writable primary calendar. */
function fakeCalendar(initial: CalendarEvent[] = [], opts: { failCreateAfter?: number } = {}) {
  const events: CalendarEvent[] = initial.map((e) => ({ ...e }));
  const calls: Call[] = [];
  let created = 0;
  const toEvent = (calendarId: string, eventId: string, w: EventWrite): CalendarEvent => ({
    calendarId,
    eventId,
    title: w.title,
    start: w.start,
    end: w.end,
    allDay: false,
    location: w.location,
    description: w.description,
    organizerIsSelf: true,
    busy: true,
    selfDeclined: false,
    transactionId: null,
    attendees: w.attendees.map((email) => ({ email, response: 'needs_action' as const })),
  });
  const client: CalendarClient = {
    async listCalendars() {
      return [{ calendarId: 'primary', name: 'ראשי', primary: true, canWrite: true }];
    },
    async listEvents(_token, q) {
      calls.push({ op: 'list', args: [q] });
      const from = Date.parse(q.fromIso);
      const to = Date.parse(q.toIso);
      return {
        events: events.filter(
          (e) => e.calendarId === q.calendarId && Date.parse(e.start) < to && Date.parse(e.end) > from,
        ),
        truncated: false,
      };
    },
    async getEvent(_token, calendarId, eventId) {
      calls.push({ op: 'get', args: [calendarId, eventId] });
      const found = events.find((e) => e.calendarId === calendarId && e.eventId === eventId);
      return found ? { ...found } : { failure: 'not_found', status: 404, message: 'gone' };
    },
    async createEvent(_token, calendarId, write) {
      calls.push({ op: 'create', args: [calendarId, write] });
      created += 1;
      if (opts.failCreateAfter !== undefined && created > opts.failCreateAfter) {
        return { failure: 'transient', status: 503, message: 'busy' };
      }
      const eventId = `ev-${created}`;
      events.push(toEvent(calendarId, eventId, write));
      return { eventId };
    },
    async updateEvent(_token, calendarId, eventId, patch) {
      calls.push({ op: 'update', args: [calendarId, eventId, patch] });
      const found = events.find((e) => e.calendarId === calendarId && e.eventId === eventId);
      if (!found) return { failure: 'not_found', status: 404, message: 'gone' };
      if (patch.title !== undefined) found.title = patch.title;
      if (patch.start !== undefined) found.start = patch.start;
      if (patch.end !== undefined) found.end = patch.end;
      if (patch.location !== undefined) found.location = patch.location;
      if (patch.description !== undefined) found.description = patch.description;
      if (patch.attendees !== undefined) {
        found.attendees = patch.attendees.map((email) => ({ email, response: 'needs_action' as const }));
      }
      return { eventId };
    },
    async deleteEvent(_token, calendarId, eventId) {
      calls.push({ op: 'delete', args: [calendarId, eventId] });
      const i = events.findIndex((e) => e.calendarId === calendarId && e.eventId === eventId);
      if (i < 0) return { failure: 'not_found', status: 404, message: 'gone' };
      events.splice(i, 1);
      return { eventId };
    },
  };
  return { client, calls, events };
}

function event(over: Partial<CalendarEvent> & { eventId: string; start: string; end: string }): CalendarEvent {
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

function extractorOf(...outcomes: ExtractorOutcome[]): { extractor: MeetingExtractor; texts: string[] } {
  const texts: string[] = [];
  let i = 0;
  const extractor: MeetingExtractor = async ({ text }) => {
    texts.push(text);
    const outcome = outcomes[Math.min(i, outcomes.length - 1)] as ExtractorOutcome;
    i += 1;
    return outcome;
  };
  return { extractor, texts };
}

function createRequest(date: string, over: { email?: string | null; phone?: string | null } = {}): MeetingRequest {
  return {
    ops: [
      {
        kind: 'create',
        client: { name: 'דני כהן', email: over.email ?? null, phone: over.phone ?? null },
        location: 'הרצל 5, רמת גן',
        clientNotes: 'להביא חוזה',
        internalNote: 'לא-לשכוח-לגבות-חוב',
        window: { fromDate: date, toDate: date, fromTime: null, toTime: null },
        durationMinutes: 60,
      },
    ],
  };
}

const NO_PLANNER = async (): Promise<PlanOutcome> => {
  throw new Error('the general planner must not run on a meeting instruction');
};

async function setup(): Promise<void> {
  await installCharter(
    buildCharter({ version: 'meeting-door', connections: [calendarConnection('google')] }),
    { businessId: BUSINESS },
  );
  await upsertBinding(
    {
      system: CALENDAR_SYSTEM,
      status: 'live',
      endpoint: null,
      credentialRef: 'OAUTH_CALENDAR',
      provider: 'google',
      lastOkAt: null,
      lastError: null,
    },
    { businessId: BUSINESS, by: 'test' },
  );
  const saved = await saveMeetingSettings(
    { ...MEETING_DEFAULTS, locationKind: 'travel', workStart: '09:00', workEnd: '18:00', gapMinutes: 30 },
    { businessId: BUSINESS },
  );
  expect(saved).toEqual({ ok: true });
}

async function instruct(
  text: string,
  client: CalendarClient,
  extractor: MeetingExtractor,
  extra: { planner?: (r: PlanRequest) => Promise<PlanOutcome> } = {},
): Promise<InstructionOutcome> {
  return runInstruction(
    { text },
    {
      businessId: BUSINESS,
      textOrigin: 'typed',
      channel: 'dashboard',
      planner: extra.planner ?? NO_PLANNER,
      meetingExtractor: extractor,
      calendar: { runtime: { credentials: CREDENTIALS }, client },
    },
  );
}

function runtimeWith(client: CalendarClient): Runtime {
  return {
    registry: new AdapterRegistry([
      createCalendarAdapter({ system: CALENDAR_SYSTEM, provider: 'google', timeZone: async () => TZ, client }),
    ]),
    credentials: CREDENTIALS,
    warnings: [],
  };
}

async function holds(): Promise<{ hold_id: string; job_id: string; event_id: string; state: string }[]> {
  const { rows } = await getPool().query<{ hold_id: string; job_id: string; event_id: string; state: string }>(
    'SELECT hold_id, job_id, event_id, state FROM meeting_holds WHERE business_id = $1 ORDER BY created_at',
    [BUSINESS],
  );
  return rows;
}

beforeEach(async () => {
  await resetDatabase();
  await setup();
});
afterAll(async () => {
  await closePool();
});

describe('runMeetingOperation through runInstruction', () => {
  it('books a new meeting: hold created, one confirmation, plan bound', async () => {
    const day = workDay();
    const cal = fakeCalendar();
    const { extractor } = extractorOf({
      status: 'extracted',
      request: createRequest(day, { email: 'dani@example.com', phone: '052-1234567' }),
    });
    const outcome = await instruct(
      `תקבעי פגישה עם דני כהן dani@example.com 052-1234567 ביום ${day}`,
      cal.client,
      extractor,
    );

    expect(outcome.status).toBe('needs_confirmation');
    if (outcome.status !== 'needs_confirmation') return;
    expect(outcome.optionCount).toBe(1);

    // The hold: no attendee, the prefixed title, at the planned 09:00 slot, in the primary calendar.
    const creates = cal.calls.filter((c) => c.op === 'create');
    expect(creates).toHaveLength(1);
    const [calendarId, write] = creates[0]?.args as [string, EventWrite];
    expect(calendarId).toBe('primary');
    expect(write.attendees).toEqual([]);
    expect(write.title.startsWith(HOLD_TITLE_PREFIX)).toBe(true);
    expect(write.start).toBe(at(day, '09:00'));
    const [hold] = await holds();
    expect(hold?.state).toBe('held');
    expect(hold?.job_id).toBe(outcome.jobId);

    // The bound plan carries the hold id in the create step — and the internal note nowhere.
    const stored = await loadPlanBody(outcome.jobId, { businessId: BUSINESS });
    const step = stored?.plan.steps[0];
    expect(step?.input['holdEventId']).toBe(hold?.event_id);
    expect(step?.input['attendees']).toEqual(['dani@example.com']);
    expect(JSON.stringify(stored?.plan)).not.toContain('לא-לשכוח-לגבות-חוב');

    const job = await loadJob(outcome.jobId, { businessId: BUSINESS });
    expect(job?.phase).toBe('plan');
    const confirmation = await loadConfirmation(outcome.jobId, { businessId: BUSINESS });
    expect(confirmation?.state).toBe('pending');
    expect(confirmation?.options[0]?.planHash).toBe(stored?.planHash);
    // The summary is shown, and the step echo is still there under it.
    expect(outcome.question).toContain('קביעה: דני כהן');
    expect(outcome.question).toContain('תצא הזמנה אל dani@example.com');
    expect(outcome.question).toContain('כלי: calendar.write');
    expect(outcome.question.indexOf('קביעה:')).toBeLessThan(outcome.question.indexOf('כלי: calendar.write'));

    const { rows } = await getPool().query<{ event_id: string; internal_note: string; state: string }>(
      'SELECT event_id, internal_note, state FROM meetings WHERE business_id = $1 AND job_id = $2',
      [BUSINESS, outcome.jobId],
    );
    expect(rows).toEqual([{ event_id: hold?.event_id, internal_note: 'לא-לשכוח-לגבות-חוב', state: 'proposed' }]);
  });

  it('on yes the job runs and the hold is converted, not duplicated', async () => {
    const day = workDay();
    const cal = fakeCalendar();
    const { extractor } = extractorOf({ status: 'extracted', request: createRequest(day, { email: 'dani@example.com' }) });
    const outcome = await instruct(`תקבעי פגישה עם דני כהן dani@example.com ביום ${day}`, cal.client, extractor);
    if (outcome.status !== 'needs_confirmation') throw new Error(`expected a confirmation, got ${outcome.status}`);
    const confirmation = await loadConfirmation(outcome.jobId, { businessId: BUSINESS });
    const planHash = confirmation?.options[0]?.planHash as string;
    const [hold] = await holds();

    expect(
      await applyConfirmation(outcome.jobId, { kind: 'confirm', planHash }, 'dashboard:owner', { businessId: BUSINESS }),
    ).toBe('executing');
    const ran = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(cal.client) });
    expect(ran.ran).toEqual([{ jobId: outcome.jobId, status: 'done', detail: null }]);

    const updates = cal.calls.filter((c) => c.op === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args[1]).toBe(hold?.event_id);
    expect((updates[0]?.args[2] as EventWrite).attendees).toEqual(['dani@example.com']);
    expect(cal.calls.filter((c) => c.op === 'create')).toHaveLength(1); // the hold, nothing more
    expect(cal.events).toHaveLength(1);
    expect(cal.events[0]?.title).toBe('דני כהן');
  });

  it('on no the hold is released by the sweep', async () => {
    const day = workDay();
    const cal = fakeCalendar();
    const { extractor } = extractorOf({ status: 'extracted', request: createRequest(day) });
    const outcome = await instruct(`תקבעי פגישה עם דני כהן ביום ${day}`, cal.client, extractor);
    if (outcome.status !== 'needs_confirmation') throw new Error(`expected a confirmation, got ${outcome.status}`);

    expect(await applyConfirmation(outcome.jobId, { kind: 'cancel' }, 'dashboard:owner', { businessId: BUSINESS })).toBe(
      'cancelled',
    );
    expect(await sweepHolds({ businessId: BUSINESS, runtime: { credentials: CREDENTIALS }, client: cal.client })).toEqual({
      released: 1,
      failed: 0,
    });
    expect((await holds())[0]?.state).toBe('released');
    expect(cal.events).toHaveLength(0);
  });

  it('asks which meeting when two events match the client name', async () => {
    const day = workDay();
    const cal = fakeCalendar([
      event({ eventId: 'a', title: 'דני כהן', start: at(day, '10:00'), end: at(day, '11:00'), location: 'הרצל 5' }),
      event({ eventId: 'b', title: 'דני כהן — המשך', start: at(day, '14:00'), end: at(day, '15:00') }),
    ]);
    const next = workDay(4);
    const { extractor } = extractorOf({
      status: 'extracted',
      request: {
        ops: [
          {
            kind: 'move',
            clientName: 'דני כהן',
            onDate: null,
            window: { fromDate: next, toDate: next, fromTime: null, toTime: null },
          },
        ],
      },
    });
    const outcome = await instruct('תזיזי את הפגישה עם דני כהן', cal.client, extractor);

    expect(outcome.status).toBe('needs_answer');
    if (outcome.status !== 'needs_answer') return;
    expect(outcome.question).toContain('יש כמה פגישות עם דני כהן');
    expect(outcome.question).toContain('1. ');
    expect(outcome.question).toContain('2. ');
    expect(outcome.question).toContain('10:00–11:00');
    expect(outcome.question).toContain('📍 הרצל 5');
    expect(await holds()).toEqual([]);
    expect((await loadJob(outcome.jobId, { businessId: BUSINESS }))?.phase).toBe('understand');
  });

  it('answers no_slot with the day listing and alternatives', async () => {
    const day = workDay();
    const cal = fakeCalendar([
      event({ eventId: 'full', title: 'סדנה', start: at(day, '08:00'), end: at(day, '19:00') }),
    ]);
    const { extractor } = extractorOf({ status: 'extracted', request: createRequest(day) });
    const outcome = await instruct(`תקבעי פגישה עם דני כהן ביום ${day}`, cal.client, extractor);

    expect(outcome.status).toBe('needs_answer');
    if (outcome.status !== 'needs_answer') return;
    expect(outcome.question).toContain('סדנה');
    expect(outcome.question).toContain('החלון מלא. אפשר: להזיז מישהו ("תזיזי את X"), לבקש מועדים אחרים — הפנויים הקרובים: ');
    expect(outcome.question).toContain(' — או לתת מועד אחר.');
    expect(outcome.question).toMatch(/הפנויים הקרובים: יום .+ \d{2}:\d{2}–\d{2}:\d{2}/u);
    expect(cal.calls.filter((c) => c.op === 'create')).toHaveLength(0);
  });

  it('refuses when the calendar is not connected, without creating a hold', async () => {
    await getPool().query(`DELETE FROM connection_bindings WHERE business_id = $1`, [BUSINESS]);
    const day = workDay();
    const cal = fakeCalendar();
    const { extractor } = extractorOf({ status: 'extracted', request: createRequest(day) });
    const outcome = await instruct(`תקבעי פגישה עם דני כהן ביום ${day}`, cal.client, extractor);

    expect(outcome).toEqual({ status: 'refused', reason: CALENDAR_NOT_CONNECTED_REPLY });
    expect(cal.calls).toEqual([]);
    expect(await holds()).toEqual([]);
    const { rows } = await getPool().query<{ phase: string }>('SELECT phase FROM jobs WHERE business_id = $1', [BUSINESS]);
    expect(rows.map((r) => r.phase)).toEqual(['failed']);
  });

  it('refuses in Hebrew when the extractor throws, and fails the job', async () => {
    const cal = fakeCalendar();
    const extractor: MeetingExtractor = async () => {
      throw new Error('sdk down');
    };
    const outcome = await instruct('תקבעי פגישה עם דני מחר', cal.client, extractor);
    expect(outcome).toEqual({ status: 'refused', reason: MEETING_NOT_UNDERSTOOD_REPLY });
    expect(cal.calls).toEqual([]);
  });

  it('a hold failure releases the holds already placed and refuses', async () => {
    const day = workDay();
    const cal = fakeCalendar([], { failCreateAfter: 1 });
    const request: MeetingRequest = {
      ops: [
        ...createRequest(day).ops,
        {
          kind: 'create',
          client: { name: 'רונית לוי', email: null, phone: null },
          location: null,
          clientNotes: null,
          internalNote: null,
          window: { fromDate: day, toDate: day, fromTime: null, toTime: null },
          durationMinutes: 60,
        },
      ],
    };
    const { extractor } = extractorOf({ status: 'extracted', request });
    const outcome = await instruct(`תקבעי פגישות עם דני כהן ורונית לוי ביום ${day}`, cal.client, extractor);

    expect(outcome).toEqual({ status: 'refused', reason: HOLD_FAILED_REPLY });
    const rows = await holds();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('released');
    expect(cal.events).toHaveLength(0);
  });

  it('תני אחר releases the hold and offers the next slot', async () => {
    const day = workDay();
    const cal = fakeCalendar();
    const original = `תקבעי פגישה עם דני כהן ביום ${day}`;
    const { extractor, texts } = extractorOf({ status: 'extracted', request: createRequest(day) });
    const first = await instruct(original, cal.client, extractor);
    if (first.status !== 'needs_confirmation') throw new Error(`expected a confirmation, got ${first.status}`);
    const [firstHold] = await holds();

    const second = await instruct('תני אחר', cal.client, extractor);
    expect(second.status).toBe('needs_confirmation');
    if (second.status !== 'needs_confirmation') return;

    // The old question is gone and its hold released.
    expect((await loadConfirmation(first.jobId, { businessId: BUSINESS }))?.state).toBe('cancelled');
    expect((await loadJob(first.jobId, { businessId: BUSINESS }))?.phase).toBe('closed');
    const rows = await holds();
    expect(rows.find((h) => h.hold_id === firstHold?.hold_id)?.state).toBe('released');
    // The original text was extracted again, and the next slot is after the turned-down one.
    expect(texts).toEqual([original, original]);
    const stored = await loadPlanBody(second.jobId, { businessId: BUSINESS });
    expect(stored?.plan.steps[0]?.input['start']).toBe(at(day, '10:00'));
    const live = rows.filter((h) => h.state === 'held');
    expect(live).toHaveLength(1);
    expect(live[0]?.job_id).toBe(second.jobId);

    // A second "תני אחר" keeps turning down every slot so far, from the original text.
    const third = await instruct('תני מועד אחר', cal.client, extractor);
    if (third.status !== 'needs_confirmation') throw new Error(`expected a confirmation, got ${third.status}`);
    const thirdPlan = await loadPlanBody(third.jobId, { businessId: BUSINESS });
    expect(thirdPlan?.plan.steps[0]?.input['start']).toBe(at(day, '11:00'));
    expect(texts).toEqual([original, original, original]);
  });

  it('returns null for a non-meeting instruction so the general planner runs', async () => {
    const cal = fakeCalendar();
    const { extractor, texts } = extractorOf({ status: 'not_meeting' });
    const requests: PlanRequest[] = [];
    const planner = async (r: PlanRequest): Promise<PlanOutcome> => {
      requests.push(r);
      return {
        status: 'planned',
        plan: { goal: 'שאלה', assumptions: [], clarifyingQuestion: 'מה בדיוק?', steps: [], estimatedCostMinor: 0 },
      } as PlanOutcome;
    };
    const outcome = await instruct('תקבעי תזכורת לשלם חשבון מחר', cal.client, extractor, { planner });
    expect(texts).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(outcome.status).toBe('needs_answer');
    expect(cal.calls).toEqual([]);

    // Not even the extractor for text with no action verb.
    await instruct('מה המצב עם החשבונית של דנה', cal.client, extractor, { planner });
    expect(texts).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  it('a confirmed meeting runs under confirmedCommandCovers with the dial off', async () => {
    expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('off');
    const day = workDay();
    const cal = fakeCalendar();
    const { extractor } = extractorOf({ status: 'extracted', request: createRequest(day, { email: 'dani@example.com' }) });
    const outcome = await instruct(`תקבעי פגישה עם דני כהן dani@example.com ביום ${day}`, cal.client, extractor);
    if (outcome.status !== 'needs_confirmation') throw new Error(`expected a confirmation, got ${outcome.status}`);
    const planHash = (await loadConfirmation(outcome.jobId, { businessId: BUSINESS }))?.options[0]?.planHash as string;
    await applyConfirmation(outcome.jobId, { kind: 'confirm', planHash }, 'dashboard:owner', { businessId: BUSINESS });
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(cal.client) });

    const { rows } = await getPool().query<{ kind: string; reason: string }>(
      `SELECT kind, reason FROM audit_log WHERE job_id = $1 AND kind IN ('intent_to_act', 'policy_denial') ORDER BY seq`,
      [outcome.jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('intent_to_act');
    expect(rows[0]?.reason.endsWith(` ${CONFIRMED_COMMAND_EXEMPTION_MARKER}`)).toBe(true);
    expect((await loadJob(outcome.jobId, { businessId: BUSINESS }))?.phase).not.toBe('failed');
  });
});
