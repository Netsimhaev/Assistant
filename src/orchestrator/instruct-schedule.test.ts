/**
 * The schedule answer through the instruction door (calendar scheduling §7.1):
 * a read, answered before any job or instruction row exists. Real Postgres; the
 * calendar client and credential source are injected.
 */
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR_SYSTEM } from '../calendar/calendar.js';
import type { CalendarClient, CalendarEvent } from '../calendar/types.js';
import { installCharter } from '../charter/store.js';
import { createOwner } from '../dashboard/auth.js';
import { issueCsrfToken } from '../dashboard/csrf.js';
import { createServer } from '../dashboard/server.js';
import { closePool, getPool, withBusiness } from '../db/pool.js';
import { CALENDAR_NOT_CONNECTED_REPLY } from '../meetings/door.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase, TEST_BUSINESS } from '../test/db.js';
import { localParts, localToInstant } from '../util/local-time.js';
import { upsertBinding } from './bindings.js';
import type { CredentialSource } from './credentials.js';
import { runInstruction } from './instruct.js';

const BUSINESS = 'test-business';
const TZ = 'Asia/Jerusalem';

const CREDENTIALS: CredentialSource = {
  async resolve(ref) {
    return { ref, value: 'access-token' } as never;
  },
};

function tomorrowAt(hhmm: string): string {
  const [y, mo, d] = localParts(new Date(), TZ).date.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
  return localToInstant(date, hhmm, TZ).toISOString();
}

function clientWith(title: string): CalendarClient {
  const event: CalendarEvent = {
    calendarId: 'primary-id', eventId: 'evt-1', title, start: tomorrowAt('10:00'), end: tomorrowAt('11:00'),
    allDay: false, location: 'הרצל 5', description: null, organizerIsSelf: true, busy: true, selfDeclined: false,
    transactionId: null, attendees: [],
  };
  return {
    listCalendars: async () => [{ calendarId: 'primary-id', name: 'העסק', primary: true, canWrite: true }],
    listEvents: async () => ({ events: [event], truncated: false }),
  } as unknown as CalendarClient;
}

async function bindCalendar(): Promise<void> {
  await withBusiness(BUSINESS, (db) => upsertBinding(db, { system: CALENDAR_SYSTEM, status: 'live', endpoint: null, credentialRef: 'OAUTH_CALENDAR', provider: 'google', lastOkAt: null, lastError: null }, { by: 'test' }));
}

async function count(table: 'jobs' | 'boss_instructions'): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]?.n);
}

const SCHEDULE_OPTIONS = { businessId: BUSINESS, textOrigin: 'typed', channel: 'dashboard' } as const;

beforeEach(async () => {
  await resetDatabase();
  await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ version: 'gate-charter' })));
});
afterAll(async () => {
  await closePool();
});

describe('runInstruction: schedule answers', () => {
  it('answers a schedule question without creating a job or instruction row', async () => {
    await bindCalendar();
    const jobsBefore = await count('jobs');
    const instructionsBefore = await count('boss_instructions');
    const outcome = await withBusiness(TEST_BUSINESS, (db) => runInstruction(db, { text: 'מה יש לי מחר?' }, { ...SCHEDULE_OPTIONS, calendar: { runtime: { credentials: CREDENTIALS }, client: clientWith('דני כהן') } }));
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.text).toContain('*10:00–11:00 · דני כהן*');
    expect(outcome.text).toContain('📍 הרצל 5');
    expect(outcome.text).toContain('פנוי:');
    expect(await count('jobs')).toBe(jobsBefore);
    expect(await count('boss_instructions')).toBe(instructionsBefore);
  });

  it('asks for the range when the question has none, still without a job', async () => {
    const outcome = await withBusiness(TEST_BUSINESS, (db) => runInstruction(db, { text: 'מה יש לי?' }, { ...SCHEDULE_OPTIONS, calendar: { runtime: { credentials: CREDENTIALS } } }));
    expect(outcome).toEqual({ status: 'answered', text: 'לאיזה טווח? למשל "מחר", "השבוע" או "יום שלישי".' });
    expect(await count('jobs')).toBe(0);
  });

  it('says the calendar is not connected when there is no calendar binding', async () => {
    const outcome = await withBusiness(TEST_BUSINESS, (db) => runInstruction(db, { text: 'מה יש לי מחר' }, { ...SCHEDULE_OPTIONS, calendar: { runtime: { credentials: CREDENTIALS } } }));
    expect(outcome).toEqual({ status: 'answered', text: CALENDAR_NOT_CONNECTED_REPLY });
    expect(await count('jobs')).toBe(0);
  });

  it('does not route when the caller passes no calendar: the planner sees the text', async () => {
    let planned = 0;
    const outcome = await withBusiness(TEST_BUSINESS, (db) => runInstruction(db, { text: 'מה יש לי מחר?' }, {
        ...SCHEDULE_OPTIONS,
        planner: async () => {
          planned += 1;
          return { status: 'unparseable', raw: '', reason: 'test' };
        },
      }));
    expect(outcome.status).not.toBe('answered');
    expect(planned).toBeGreaterThan(0);
  });
});

describe('both doors pass the calendar', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  });

  it('the dashboard /instruct route answers a schedule question (no planner injected, no job)', async () => {
    await bindCalendar();
    await createOwner({ username: 'owner', password: 'correct horse battery staple', businessId: BUSINESS });
    server = createServer({
      businessId: BUSINESS,
      port: 0,
      calendarCredentials: CREDENTIALS,
      calendarClient: clientWith('לקוח מהדשבורד'),
    });
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'owner', password: 'correct horse battery staple' }),
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const sessionId = cookie.split('=')[1] as string;
    const res = await fetch(`${baseUrl}/instruct`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: issueCsrfToken(sessionId), text: 'מה יש לי מחר' }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('לקוח מהדשבורד');
    expect(await count('jobs')).toBe(0);
    expect(await count('boss_instructions')).toBe(0);
  });

  it('the dashboard answer route answers a schedule question without consuming the parked question', async () => {
    await bindCalendar();
    await createOwner({ username: 'owner', password: 'correct horse battery staple', businessId: BUSINESS });
    // A parked question: the planner asks for clarification.
    const parkedOutcome = await withBusiness(TEST_BUSINESS, (db) => runInstruction(db, { text: 'תשלחי לרונית מחר' }, {
        ...SCHEDULE_OPTIONS,
        planner: async () => ({
          status: 'planned',
          plan: {
            goal: 'לשלוח', assumptions: [], clarifyingQuestion: 'לאיזו רונית?', estimatedCostMinor: 0,
            steps: [{ id: 's1', agent: 'comms.email', intent: 'לשלוח', toolName: 'mail.send', input: { to: 'dana@example.com', subject: 'נ', body: 'ג' }, dependsOn: [], expectedActionClass: 'email.initiate' }],
          },
        }),
      }));
    if (parkedOutcome.status !== 'needs_answer') throw new Error(`expected a parked question, got ${parkedOutcome.status}`);
    const jobsBefore = await count('jobs');

    server = createServer({ businessId: BUSINESS, port: 0, calendarCredentials: CREDENTIALS, calendarClient: clientWith('לקוח מתשובה') });
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'owner', password: 'correct horse battery staple' }),
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const sessionId = cookie.split('=')[1] as string;
    const res = await fetch(`${baseUrl}/instruct/${parkedOutcome.jobId}/answer`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: issueCsrfToken(sessionId), answer: 'מה יש לי מחר' }),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('לקוח מתשובה');
    expect(html).toContain('לאיזו רונית?'); // the parked question is still on the page, still answerable
    const { rows } = await getPool().query<{ answer: string | null }>('SELECT answer FROM boss_instructions');
    expect(rows[0]?.answer).toBeNull();
    const job = await getPool().query<{ phase: string }>('SELECT phase FROM jobs WHERE job_id = $1', [parkedOutcome.jobId]);
    expect(['closed', 'failed', 'halted']).not.toContain(job.rows[0]?.phase);
    expect(await count('jobs')).toBe(jobsBefore);
  });

  it('the WhatsApp door, the scheduler and the dashboard hand the calendar on (behaviour: whatsapp-door-schedule.test.ts)', () => {
    const door = readFileSync('src/orchestrator/whatsapp-door.ts', 'utf8');
    expect(door).toMatch(/\.\.\.\(ctx\.calendar !== undefined \? \{ calendar: ctx\.calendar \} : \{\}\)/);
    // The answer pass keeps the calendar for the meeting door but turns the schedule routing off.
    expect(door).toMatch(/answered !== null\s*\?\s*\{ scheduleRouting: false, answerTo:/);
    expect(door).toMatch(/\.\.\.\(options\.calendar !== undefined \? \{ calendar: options\.calendar \} : \{\}\)/);
    const scheduler = readFileSync('src/orchestrator/scheduler.ts', 'utf8');
    expect(scheduler).toMatch(/runWhatsAppDoor\(db, \{[\s\S]*?calendar: \{ runtime \}/);
    const server = readFileSync('src/dashboard/server.ts', 'utf8').replace(/\r\n/g, '\n');
    expect((server.match(/\.\.\.\(calendar !== undefined \? \{ calendar \} : \{\}\)/g) ?? []).length).toBe(1);
    // The answer route: calendar for the meeting door, schedule routing off.
    expect(server).toMatch(/calendar !== undefined \? \{ calendar, scheduleRouting: false, answerTo: \{ jobId, answer \} \}/);
    expect(server).toMatch(/calendar: \(\) => calendarWiring\(meetingOptions\)/);
  });
});
