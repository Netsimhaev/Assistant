/**
 * The meetings sweep: activation, abandonment, the §8.1 reset after a move,
 * responses read back from the calendar, and the owner's alerts.
 *
 * Fixed clock: NOW is Sunday 2026-11-08 10:00 Asia/Jerusalem. Meetings are
 * seeded straight into `meetings`, with a job, a bound plan hash and, where
 * the test needs one, a `job_step_results` row.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR_SYSTEM } from '../calendar/calendar.js';
import type { AttendeeResponse, CalendarClient, CalendarEvent } from '../calendar/types.js';
import { closePool, withBusiness } from '../db/pool.js';
import { saveActionUpdateSettings } from '../governance/action-update-settings.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { upsertBinding } from '../orchestrator/bindings.js';
import { createJob } from '../orchestrator/jobs.js';
import { resetDatabase, testDb } from '../test/db.js';
import { installMailboxCharter } from '../test/mailbox.js';
import { syncMeetings } from './sync.js';

const B = 'test-business';
const NOW = new Date('2026-11-08T08:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const runtime = { credentials: { resolve: async () => ({ value: 'tok' }) } } as never;

let charterVersion = '';

function fakeCalendar(responses: Map<string, { email: string; response: AttendeeResponse }[]>) {
  const gets: string[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('the sweep must not call this');
  };
  const client: CalendarClient = {
    listCalendars: unused,
    listEvents: unused,
    createEvent: unused,
    updateEvent: unused,
    deleteEvent: unused,
    async getEvent(_token, calendarId, eventId) {
      gets.push(eventId);
      if (eventId.startsWith('broken-')) return { failure: 'transient', status: 503, message: 'calendar down' };
      const attendees = responses.get(eventId);
      if (attendees === undefined) return { failure: 'not_found', status: 404, message: 'x' };
      const event: CalendarEvent = {
        calendarId,
        eventId,
        title: 'פגישה',
        start: '2026-11-10T08:00:00.000Z',
        end: '2026-11-10T09:00:00.000Z',
        allDay: false,
        location: 'המשרד',
        description: null,
        organizerIsSelf: true,
        busy: true,
        selfDeclined: false,
        transactionId: null,
        attendees,
      };
      return event;
    },
  };
  return { client, gets };
}

interface Seed {
  operation?: 'create' | 'move' | 'update' | 'cancel';
  state?: string;
  eventId?: string | null;
  email?: string | null;
  start?: Date;
  response?: string;
  updatedAt?: Date;
  phase?: string;
  step?: { status: 'completed' | 'unknown'; externalId: string | null } | null;
  name?: string;
}

async function seed(s: Seed = {}): Promise<{ meetingId: string; jobId: string }> {
  const job = await withBusiness(B, (db) => createJob(db, { charterVersion, provenance: 'boss', title: 'פגישה' }));
  await testDb().query('UPDATE jobs SET phase = $1 WHERE job_id = $2', [s.phase ?? 'execute', job.jobId]);
  await testDb().query(
    `INSERT INTO job_plans (business_id, job_id, plan_hash, plan) VALUES ($1, $2, 'h', '{}'::jsonb)`,
    [B, job.jobId],
  );
  if (s.step) {
    await testDb().query(
      `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, external_id, status, performed)
       VALUES ($1, $2, 'h', 's1', $3, $4, true)`,
      [B, job.jobId, s.step.externalId, s.step.status],
    );
  }
  const meetingId = `M-${job.jobId}`;
  const start = s.start ?? new Date(NOW.getTime() + 48 * HOUR);
  await testDb().query(
    `INSERT INTO meetings (meeting_id, business_id, job_id, step_id, calendar_id, event_id, operation, client_name,
        client_email, client_email_verified, start_at, end_at, state, response, updated_at)
     VALUES ($1, $2, $3, 's1', 'cal-1', $4, $5, $6, $7, true, $8, $9, $10, $11, $12)`,
    [
      meetingId,
      B,
      job.jobId,
      s.eventId === undefined ? 'ev-1' : s.eventId,
      s.operation ?? 'create',
      s.name ?? 'דני כהן',
      s.email === undefined ? 'dani@acme.co.il' : s.email,
      start,
      new Date(start.getTime() + HOUR),
      s.state ?? 'proposed',
      s.response ?? (s.email === null ? 'not_updated' : 'needs_action'),
      s.updatedAt ?? NOW,
    ],
  );
  return { meetingId, jobId: job.jobId };
}

async function row(meetingId: string) {
  const { rows } = await testDb().query<{
    state: string;
    event_id: string | null;
    response: string;
    response_at: Date | null;
    reminder_claimed_at: Date | null;
    reminder_job_id: string | null;
    declined_notified_at: Date | null;
    unanswered_notified_at: Date | null;
  }>('SELECT * FROM meetings WHERE meeting_id = $1', [meetingId]);
  const r = rows[0];
  if (r === undefined) throw new Error('no meeting');
  return r;
}

function recordingAlert(sent: { subject: string; body: string }[]) {
  return async (subject: string, body: string) => {
    sent.push({ subject, body });
    return { ok: true };
  };
}

async function connectCalendar(): Promise<void> {
  await withBusiness(B, (db) => upsertBinding(db, {
      system: CALENDAR_SYSTEM,
      status: 'live',
      endpoint: null,
      credentialRef: 'OAUTH_CALENDAR',
      provider: 'google',
      lastOkAt: null,
      lastError: null,
    }, { by: 'test' }));
}

beforeEach(async () => {
  await resetDatabase();
  charterVersion = (await installMailboxCharter(B)).charterVersion;
  await connectCalendar();
  // Reminders open a job only when the dial lets email.initiate reach a card;
  // the default `off` hands the owner the text instead (its own test below).
  await withBusiness(B, (bdb) => setAutonomyMode(bdb, 'ask', 'p_boss'));
});
afterAll(async () => {
  await closePool();
});

describe('proposed meetings', () => {
  it('activates a proposed meeting when its step completed and converts the hold', async () => {
    const { meetingId, jobId } = await seed({ eventId: 'hold-ev', step: { status: 'completed', externalId: 'hold-ev' } });
    await testDb().query(
      `INSERT INTO meeting_holds (hold_id, business_id, job_id, calendar_id, event_id, start_at, end_at)
       VALUES ('H-1', $1, $2, 'cal-1', 'hold-ev', $3, $4)`,
      [B, jobId, NOW, new Date(NOW.getTime() + HOUR)],
    );
    // A create without a hold takes the step's external id.
    const plain = await seed({ eventId: null, step: { status: 'completed', externalId: 'new-ev' } });
    const { client } = fakeCalendar(new Map());

    const result = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client }));

    expect(result.activated).toBe(2);
    expect((await row(meetingId)).state).toBe('active');
    expect((await row(meetingId)).event_id).toBe('hold-ev');
    expect((await row(plain.meetingId)).event_id).toBe('new-ev');
    const { rows } = await testDb().query<{ state: string }>(`SELECT state FROM meeting_holds WHERE hold_id = 'H-1'`);
    expect(rows[0]?.state).toBe('converted');
  });

  it('leaves a proposed meeting whose step has not run, and one whose step is unknown', async () => {
    const waiting = await seed({ step: null, phase: 'plan' });
    const unknown = await seed({ step: { status: 'unknown', externalId: null }, phase: 'followup' });
    const result = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client: fakeCalendar(new Map()).client }));
    expect(result).toMatchObject({ activated: 0, abandoned: 0 });
    expect((await row(waiting.meetingId)).state).toBe('proposed');
    expect((await row(unknown.meetingId)).state).toBe('proposed');
  });

  it('does not abandon an unknown write on a failed job, and alerts the owner once that it may have landed', async () => {
    const uncertain = await seed({ step: { status: 'unknown', externalId: null }, phase: 'failed', name: 'רונית' });
    const sent: { subject: string; body: string }[] = [];
    const client = fakeCalendar(new Map()).client;
    const first = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client, sendAlert: recordingAlert(sent) }));
    const second = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client, sendAlert: recordingAlert(sent) }));

    expect(first).toMatchObject({ abandoned: 0, uncertainAlerts: 1 });
    expect(second.uncertainAlerts).toBe(0);
    expect((await row(uncertain.meetingId)).state).toBe('proposed');
    expect(sent.map((s) => s.body)).toEqual(['ייתכן שהשינוי ביומן לרונית נשמר וייתכן שלא — כדאי לבדוק ביומן.']);
    const audit = await testDb().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE reason LIKE 'meeting_write_uncertain:%'`,
    );
    expect(audit.rows.map((r) => r.reason)).toEqual([`meeting_write_uncertain:${uncertain.meetingId}`]);
  });

  it('abandons a proposed meeting whose job failed', async () => {
    const failed = await seed({ phase: 'failed', step: null });
    const closed = await seed({ phase: 'closed', step: null });
    const result = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client: fakeCalendar(new Map()).client }));
    expect(result.abandoned).toBe(2);
    expect((await row(failed.meetingId)).state).toBe('abandoned');
    expect((await row(closed.meetingId)).state).toBe('abandoned');
  });

  it('resets the response to needs_action after a move', async () => {
    const old = await seed({ state: 'active', response: 'accepted', eventId: 'ev-9' });
    await testDb().query(`UPDATE meetings SET response_at = $2, declined_notified_at = $2 WHERE meeting_id = $1`, [
      old.meetingId,
      NOW,
    ]);
    const moved = await seed({ operation: 'move', eventId: 'ev-9', response: 'accepted', step: { status: 'completed', externalId: 'ev-9' } });
    await testDb().query(`UPDATE meetings SET unanswered_notified_at = $2 WHERE meeting_id = $1`, [moved.meetingId, NOW]);

    await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client: fakeCalendar(new Map([['ev-9', []]])).client }));

    expect((await row(old.meetingId)).state).toBe('done');
    const fresh = await row(moved.meetingId);
    expect(fresh.state).toBe('active');
    expect(fresh.response).toBe('needs_action');
    expect(fresh.response_at).toBeNull();
    expect(fresh.unanswered_notified_at).toBeNull();
  });

  it('a completed cancel goes straight to done, with the earlier rows of the event', async () => {
    const old = await seed({ state: 'active', eventId: 'ev-c' });
    const cancel = await seed({ operation: 'cancel', eventId: 'ev-c', step: { status: 'completed', externalId: 'ev-c' } });
    await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client: fakeCalendar(new Map()).client }));
    expect((await row(old.meetingId)).state).toBe('done');
    expect((await row(cancel.meetingId)).state).toBe('done');
  });

  it('marks a client without email not_updated and never reminds', async () => {
    const { meetingId } = await seed({ email: null, response: 'needs_action', step: { status: 'completed', externalId: 'ev-n' } });
    const sent: { subject: string; body: string }[] = [];
    const { client, gets } = fakeCalendar(new Map());
    // Long past every wait.
    await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client, sendAlert: recordingAlert(sent) }));
    const later = new Date(NOW.getTime() + 30 * HOUR);
    const result = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: later, client, sendAlert: recordingAlert(sent) }));

    const r = await row(meetingId);
    expect(r.state).toBe('active');
    expect(r.response).toBe('not_updated');
    expect(r.reminder_claimed_at).toBeNull();
    expect(result.remindersOpened).toBe(0);
    expect(sent).toEqual([]);
    expect(gets).toEqual([]);
  });
});

describe('responses and alerts', () => {
  it('reads an attendee response change from the calendar', async () => {
    const { meetingId } = await seed({ state: 'active', eventId: 'ev-r' });
    const other = await seed({ state: 'active', eventId: 'ev-o' });
    const { client } = fakeCalendar(
      new Map([
        ['ev-r', [{ email: 'someone@else.com', response: 'declined' }, { email: 'DANI@acme.co.il', response: 'accepted' }]],
        // The client is absent from this event: the response is kept.
        ['ev-o', [{ email: 'someone@else.com', response: 'accepted' }]],
      ]),
    );
    const result = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client }));
    expect(result.responsesChanged).toBe(1);
    const r = await row(meetingId);
    expect(r.response).toBe('accepted');
    expect(r.response_at?.toISOString()).toBe(NOW.toISOString());
    expect((await row(other.meetingId)).response).toBe('needs_action');
  });

  it('does not poll a meeting whose start has passed', async () => {
    await seed({ state: 'active', eventId: 'ev-p', start: new Date(NOW.getTime() - HOUR) });
    const { client, gets } = fakeCalendar(new Map([['ev-p', [{ email: 'dani@acme.co.il', response: 'declined' }]]]));
    const sent: { subject: string; body: string }[] = [];
    const result = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client, sendAlert: recordingAlert(sent) }));
    expect(gets).toEqual([]);
    expect(result).toMatchObject({ responsesChanged: 0, declinedAlerts: 0, unansweredAlerts: 0 });
    expect(sent).toEqual([]);
  });

  it('alerts the owner once on decline', async () => {
    const { meetingId } = await seed({ state: 'active', eventId: 'ev-d', name: 'דני‮ כהן\nשורה' });
    const { client } = fakeCalendar(new Map([['ev-d', [{ email: 'dani@acme.co.il', response: 'declined' }]]]));
    const sent: { subject: string; body: string }[] = [];
    const first = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client, sendAlert: recordingAlert(sent) }));
    const second = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client, sendAlert: recordingAlert(sent) }));

    expect(first.declinedAlerts).toBe(1);
    expect(second.declinedAlerts).toBe(0);
    expect(sent).toHaveLength(1);
    // Tuesday 2026-11-10 10:00 local; the name is cleaned of controls and newlines.
    expect(sent[0]?.body).toBe('❌ דני כהן שורה דחה את יום ג\' 10:00. כתבי לי מועד חדש או "תציעי מועדים".');
    expect((await row(meetingId)).declined_notified_at).not.toBeNull();
  });

  it('sends the decline alert over WhatsApp only when the owner chose it', async () => {
    await withBusiness(B, (bdb) => saveActionUpdateSettings(bdb, { toWhatsApp: true, toEmail: false, toScreen: true }, { updatedBy: 'owner' }));
    await seed({ state: 'active', eventId: 'ev-w' });
    const { client } = fakeCalendar(new Map([['ev-w', [{ email: 'dani@acme.co.il', response: 'declined' }]]]));
    const emails: { subject: string; body: string }[] = [];
    const texts: string[] = [];
    const messenger = {
      send: async (i: { text: string }) => {
        texts.push(i.text);
        return { ok: false, error: 'down' };
      },
    } as never;
    const result = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client, sendAlert: recordingAlert(emails), messenger }));
    expect(result.declinedAlerts).toBe(1);
    expect(emails).toEqual([]);
    expect(texts).toHaveLength(1);
  });

  it('a calendar that cannot be reached skips polling but still activates', async () => {
    await testDb().query(`DELETE FROM connection_bindings WHERE business_id = $1`, [B]);
    const active = await seed({ state: 'active', eventId: 'ev-x' });
    const proposed = await seed({ step: { status: 'completed', externalId: 'ev-y' }, eventId: null });
    const { client, gets } = fakeCalendar(new Map([['ev-x', [{ email: 'dani@acme.co.il', response: 'accepted' }]]]));
    const result = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client }));
    expect(gets).toEqual([]);
    expect(result.activated).toBe(1);
    expect((await row(active.meetingId)).response).toBe('needs_action');
    expect((await row(proposed.meetingId)).state).toBe('active');
  });
});

describe('unanswered meetings', () => {
  it('opens one reminder after 24h, and after 2h when the meeting is under a day away', async () => {
    // Two days away, activated 23h ago: not yet; at 24h: yes.
    const far = await seed({ state: 'active', eventId: 'ev-f', updatedAt: new Date(NOW.getTime() - 23 * HOUR) });
    // Ten hours away, activated 1h ago: not yet; at 2h: yes.
    const soon = await seed({
      state: 'active',
      eventId: 'ev-s',
      start: new Date(NOW.getTime() + 10 * HOUR),
      updatedAt: new Date(NOW.getTime() - HOUR),
      name: 'רונית',
    });
    const { client } = fakeCalendar(
      new Map([
        ['ev-f', [{ email: 'dani@acme.co.il', response: 'needs_action' }]],
        ['ev-s', [{ email: 'dani@acme.co.il', response: 'needs_action' }]],
      ]),
    );
    const sent: { subject: string; body: string }[] = [];
    const first = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client, sendAlert: recordingAlert(sent) }));
    expect(first.remindersOpened).toBe(0);
    expect(sent).toEqual([]);

    const later = new Date(NOW.getTime() + HOUR);
    const second = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: later, client, sendAlert: recordingAlert(sent) }));
    expect(second.remindersOpened).toBe(2);
    expect(second.unansweredAlerts).toBe(2);
    expect((await row(far.meetingId)).reminder_job_id).not.toBeNull();
    expect((await row(soon.meetingId)).reminder_job_id).not.toBeNull();
    expect(sent.map((s) => s.body).sort()).toEqual(
      ['⏳ דני כהן עדיין לא אישר את יום ג\' 10:00 — הכנתי תזכורת לאישורך.', '⏳ רונית עדיין לא אישר את יום א\' 20:00 — הכנתי תזכורת לאישורך.'].sort(),
    );
  });

  it('does not open a second reminder for the same meeting', async () => {
    const { meetingId } = await seed({ state: 'active', eventId: 'ev-1', updatedAt: new Date(NOW.getTime() - 25 * HOUR) });
    const { client } = fakeCalendar(new Map([['ev-1', [{ email: 'dani@acme.co.il', response: 'needs_action' }]]]));
    const sent: { subject: string; body: string }[] = [];
    const first = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client, sendAlert: recordingAlert(sent) }));
    const second = await withBusiness(B, (db) => syncMeetings(db, {
      runtime,
      now: new Date(NOW.getTime() + 30 * HOUR),
      client,
      sendAlert: recordingAlert(sent),
    }));
    expect(first.remindersOpened).toBe(1);
    expect(second.remindersOpened).toBe(0);
    expect(second.unansweredAlerts).toBe(0);
    expect(sent).toHaveLength(1);
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*) AS n FROM jobs WHERE business_id = $1 AND title LIKE 'תזכורת לפגישה:%'`,
      [B],
    );
    expect(Number(rows[0]?.n)).toBe(1);
    expect((await row(meetingId)).reminder_claimed_at).not.toBeNull();
  });

  it('tells the owner to update the client himself when no mailbox serves mail.send', async () => {
    await resetDatabase();
    const { installCharter } = await import('../charter/store.js');
    const { buildCharter } = await import('../test/fixtures.js');
    charterVersion = (await withBusiness(B, (bdb) => installCharter(bdb, buildCharter()))).charterVersion;
    await connectCalendar();
    await withBusiness(B, (bdb) => setAutonomyMode(bdb, 'ask', 'p_boss'));
    const { meetingId } = await seed({ state: 'active', eventId: 'ev-1', updatedAt: new Date(NOW.getTime() - 25 * HOUR) });
    const { client } = fakeCalendar(new Map([['ev-1', [{ email: 'dani@acme.co.il', response: 'needs_action' }]]]));
    const sent: { subject: string; body: string }[] = [];
    const result = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client, sendAlert: recordingAlert(sent) }));
    expect(result.remindersOpened).toBe(0);
    expect(result.unansweredAlerts).toBe(1);
    expect(sent[0]?.body).toBe("⏳ דני כהן עדיין לא אישר את יום ג' 10:00 — אין תיבת מייל מחוברת, כדאי לעדכן אותו בעצמך.");
    expect((await row(meetingId)).reminder_job_id).toBeNull();
  });

  it('under the default off dial opens no job and hands the owner the reminder text, once', async () => {
    await withBusiness(B, (bdb) => setAutonomyMode(bdb, 'off', 'p_boss'));
    const { meetingId } = await seed({ state: 'active', eventId: 'ev-1', updatedAt: new Date(NOW.getTime() - 25 * HOUR) });
    const { client } = fakeCalendar(new Map([['ev-1', [{ email: 'dani@acme.co.il', response: 'needs_action' }]]]));
    const sent: { subject: string; body: string }[] = [];
    const first = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client, sendAlert: recordingAlert(sent) }));
    const second = await withBusiness(B, (db) => syncMeetings(db, {
      runtime,
      now: new Date(NOW.getTime() + 30 * HOUR),
      client,
      sendAlert: recordingAlert(sent),
    }));

    expect(first).toMatchObject({ remindersOpened: 0, unansweredAlerts: 1 });
    expect(second.unansweredAlerts).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe(
      "⏳ דני כהן עדיין לא אישר את יום ג' 10:00. הנה תזכורת מוכנה לשליחה:\n" +
        "שלום דני כהן,\nרצינו לוודא שהפגישה ביום ג' 10/11 בשעה 10:00, המשרד, מתאימה לך. אפשר לאשר בהזמנת היומן או להשיב למייל הזה.",
    );
    const jobs = await testDb().query(`SELECT 1 FROM jobs WHERE business_id = $1 AND title LIKE 'תזכורת לפגישה:%'`, [B]);
    expect(jobs.rowCount).toBe(0);
    expect((await testDb().query('SELECT 1 FROM approval_requests WHERE business_id = $1', [B])).rowCount).toBe(0);
    const r = await row(meetingId);
    expect(r.reminder_claimed_at).not.toBeNull();
    expect(r.unanswered_notified_at).not.toBeNull();
    expect(r.reminder_job_id).toBeNull();
  });

  it('does not remind on a stale needs_action: the calendar read failed, or the calendar is unavailable', async () => {
    const failed = await seed({ state: 'active', eventId: 'broken-1', updatedAt: new Date(NOW.getTime() - 25 * HOUR) });
    const { client } = fakeCalendar(new Map());
    const sent: { subject: string; body: string }[] = [];
    const result = await withBusiness(B, (db) => syncMeetings(db, { runtime, now: NOW, client, sendAlert: recordingAlert(sent) }));
    expect(result).toMatchObject({ remindersOpened: 0, unansweredAlerts: 0 });
    expect(result.errored).toEqual([{ meetingId: failed.meetingId, error: 'calendar down' }]);
    expect((await row(failed.meetingId)).reminder_claimed_at).toBeNull();

    // A readable event, but no calendar connection at all this pass.
    await testDb().query(`DELETE FROM connection_bindings WHERE business_id = $1`, [B]);
    const ok = await seed({ state: 'active', eventId: 'ev-2', updatedAt: new Date(NOW.getTime() - 25 * HOUR) });
    const reachable = fakeCalendar(new Map([['ev-2', [{ email: 'dani@acme.co.il', response: 'needs_action' }]]]));
    const unavailable = await withBusiness(B, (db) => syncMeetings(db, {
      runtime,
      now: NOW,
      client: reachable.client,
      sendAlert: recordingAlert(sent),
    }));
    expect(reachable.gets).toEqual([]);
    expect(unavailable).toMatchObject({ remindersOpened: 0, unansweredAlerts: 0 });
    expect((await row(ok.meetingId)).reminder_claimed_at).toBeNull();
    expect(sent).toEqual([]);
  });
});
