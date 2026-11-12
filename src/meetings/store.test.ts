import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../calendar/types.js';
import { closePool, withBusiness } from '../db/pool.js';
import type { Plan } from '../domain/plan.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import type { PlannedChange } from './plan.js';
import { recordProposedMeetings } from './store.js';

const BUSINESS = TEST_BUSINESS;

const EVENT: CalendarEvent = {
  calendarId: 'primary',
  eventId: 'r1',
  title: 'רונית לוי',
  start: '2026-11-12T09:30:00.000Z',
  end: '2026-11-12T10:30:00.000Z',
  allDay: false,
  location: null,
  description: null,
  organizerIsSelf: true,
  busy: true,
  selfDeclined: false,
  transactionId: null,
  attendees: [],
};

const CHANGES: PlannedChange[] = [
  {
    op: 'move',
    event: EVENT,
    client: { name: 'רונית לוי', email: null, emailVerified: false, phone: null, phoneVerified: false },
    start: '2026-11-15T07:00:00.000Z',
    end: '2026-11-15T08:00:00.000Z',
  },
  {
    op: 'create',
    client: { name: 'דני כהן', email: 'dani@x.co', emailVerified: true, phone: '052-1', phoneVerified: false },
    calendarId: 'primary',
    start: '2026-11-17T08:00:00.000Z',
    end: '2026-11-17T09:00:00.000Z',
    location: null,
    clientNotes: null,
    internalNote: 'פנימי',
    needsHold: true,
  },
];

const PLAN: Plan = {
  goal: 'g',
  assumptions: [],
  clarifyingQuestion: null,
  estimatedCostMinor: 0,
  steps: [
    { id: 'm1', agent: 'sched.meetings', intent: 'meeting.move', toolName: 'calendar.write', dependsOn: [], expectedActionClass: 'calendar.move',
      input: { operation: 'move', calendarId: 'primary', eventId: 'r1', start: '2026-11-15T07:00:00.000Z', end: '2026-11-15T08:00:00.000Z' } },
    { id: 'm2', agent: 'sched.meetings', intent: 'meeting.create', toolName: 'calendar.write', dependsOn: ['m1'], expectedActionClass: 'calendar.create',
      input: { operation: 'create', calendarId: 'primary', holdEventId: 'hold-9' } },
  ],
};

interface Row {
  step_id: string;
  operation: string;
  event_id: string | null;
  client_name: string;
  client_email: string | null;
  client_email_verified: boolean;
  client_phone: string | null;
  internal_note: string | null;
  start_at: Date;
  state: string;
  response: string;
}

describe('recordProposedMeetings', () => {
  beforeEach(resetDatabase);
  afterAll(closePool);

  it('records proposed meeting rows keyed by job and step', async () => {
    await withBusiness(BUSINESS, (db) => recordProposedMeetings(db, { jobId: 'J-1', plan: PLAN, changes: CHANGES }));
    // A second call for the same job and steps writes nothing.
    await withBusiness(BUSINESS, (db) => recordProposedMeetings(db, { jobId: 'J-1', plan: PLAN, changes: CHANGES }));

    const { rows } = await testDb().query<Row>(
      `SELECT step_id, operation, event_id, client_name, client_email, client_email_verified, client_phone,
              internal_note, start_at, state, response
         FROM meetings WHERE business_id = $1 AND job_id = 'J-1' ORDER BY step_id`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      step_id: 'm1', operation: 'move', event_id: 'r1', client_name: 'רונית לוי', client_email: null,
      internal_note: null, state: 'proposed', response: 'not_updated',
    });
    expect(rows[0]!.start_at.toISOString()).toBe('2026-11-15T07:00:00.000Z');
    expect(rows[1]).toMatchObject({
      step_id: 'm2', operation: 'create', event_id: 'hold-9', client_email: 'dani@x.co', client_email_verified: true,
      client_phone: '052-1', internal_note: 'פנימי', state: 'proposed', response: 'needs_action',
    });
  });

  it('records the event attendee as the email of a move, falling back to the resolved one', async () => {
    const withAttendee: PlannedChange = {
      op: 'cancel',
      event: { ...EVENT, eventId: 'r2', attendees: [{ email: 'Ronit@Real.co', response: 'accepted' }] },
      client: { name: 'רונית לוי', email: 'ronit@memory.co', emailVerified: false, phone: null, phoneVerified: false },
    };
    const noAttendee: PlannedChange = {
      op: 'cancel',
      event: { ...EVENT, eventId: 'r3' },
      client: { name: 'רונית לוי', email: 'ronit@memory.co', emailVerified: false, phone: null, phoneVerified: false },
    };
    const step = (id: string, eventId: string): Plan['steps'][number] => ({
      id, agent: 'sched.meetings', intent: 'meeting.cancel', toolName: 'calendar.write', dependsOn: [], expectedActionClass: 'calendar.cancel',
      input: { operation: 'cancel', calendarId: 'primary', eventId },
    });
    await withBusiness(BUSINESS, (db) => recordProposedMeetings(db, {
      jobId: 'J-3',
      plan: { ...PLAN, steps: [step('m1', 'r2'), step('m2', 'r3')] },
      changes: [withAttendee, noAttendee],
    }));
    const { rows } = await testDb().query<{ step_id: string; client_email: string | null; response: string }>(
      `SELECT step_id, client_email, response FROM meetings WHERE business_id = $1 AND job_id = 'J-3' ORDER BY step_id`,
      [BUSINESS],
    );
    expect(rows).toEqual([
      { step_id: 'm1', client_email: 'Ronit@Real.co', response: 'needs_action' },
      { step_id: 'm2', client_email: 'ronit@memory.co', response: 'not_updated' },
    ]);
  });

  it('refuses a change list that does not match the plan steps', async () => {
    await expect(
      withBusiness(BUSINESS, (db) => recordProposedMeetings(db, { jobId: 'J-2', plan: PLAN, changes: CHANGES.slice(0, 1) })),
    ).rejects.toThrow();
  });
});
