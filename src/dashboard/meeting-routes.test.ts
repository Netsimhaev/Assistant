/**
 * The meeting settings screen: `/meetings/settings`. Real HTTP server and
 * Postgres; the calendar client and credential source are the test seams.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR_SYSTEM } from '../calendar/calendar.js';
import type { CalendarClient, CalendarEvent, CalendarInfo } from '../calendar/types.js';
import { calendarConnection } from '../charter/amend-calendar.js';
import { installCharter } from '../charter/store.js';
import { closePool, getPool } from '../db/pool.js';
import { localParts, localToInstant } from '../util/local-time.js';
import { upsertBinding } from '../orchestrator/bindings.js';
import type { CredentialSource } from '../orchestrator/credentials.js';
import { loadMeetingSettings, saveMeetingSettings, MEETING_DEFAULTS } from '../meetings/settings.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase } from '../test/db.js';
import { createOwner } from './auth.js';
import { issueCsrfToken } from './csrf.js';
import { createServer } from './server.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

let server: Server | null = null;

const CALENDARS: CalendarInfo[] = [
  { calendarId: 'primary-id', name: 'העסק', primary: true, canWrite: true },
  { calendarId: 'family-id', name: 'משפחה', primary: false, canWrite: true },
  { calendarId: 'holidays-id', name: 'חגים‮', primary: false, canWrite: false },
];

const CREDENTIALS: CredentialSource = {
  async resolve(ref) {
    return { ref, value: 'access-token' } as never;
  },
};

function clientListing(result: CalendarInfo[] | { failure: 'transient'; status: number; message: string }): CalendarClient {
  return { listCalendars: async () => result } as unknown as CalendarClient;
}

beforeEach(async () => {
  await resetDatabase();
  await createOwner({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
  await installCharter(buildCharter({ version: 'gate-charter' }), { businessId: BUSINESS });
});
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});
afterAll(async () => {
  await closePool();
});

async function bindCalendar(): Promise<void> {
  await upsertBinding(
    { system: CALENDAR_SYSTEM, status: 'live', endpoint: null, credentialRef: 'OAUTH_CALENDAR', provider: 'google', lastOkAt: null, lastError: null },
    { businessId: BUSINESS, by: 'test' },
  );
}

async function start(client?: CalendarClient, credentials: CredentialSource = CREDENTIALS): Promise<string> {
  server = createServer({
    businessId: BUSINESS,
    port: 0,
    ...(client !== undefined ? { calendarClient: client } : {}),
    calendarCredentials: credentials,
  });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ username: USERNAME, password: PASSWORD }),
    redirect: 'manual',
  });
  const pair = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (!pair) throw new Error('no session cookie');
  return pair;
}

function csrfFor(cookie: string): string {
  const sessionId = cookie.split('=')[1];
  if (sessionId === undefined) throw new Error('bad cookie');
  return issueCsrfToken(sessionId);
}

function post(baseUrl: string, cookie: string, fields: [string, string][]): Promise<Response> {
  return fetch(`${baseUrl}/meetings/settings`, {
    method: 'POST',
    headers: { cookie },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

function baseFields(cookie: string, over: Record<string, string> = {}): [string, string][] {
  const fields: Record<string, string> = {
    csrf: csrfFor(cookie),
    locationKind: 'travel',
    fixedAddress: '',
    gapMinutes: '30',
    defaultDurationMinutes: '60',
    workStart: '',
    workEnd: '',
    reminderHours: '24',
    reminderHoursSoon: '2',
    ...over,
  };
  return Object.entries(fields);
}

describe('GET /meetings/settings', () => {
  it('requires a session', async () => {
    const baseUrl = await start();
    const res = await fetch(`${baseUrl}/meetings/settings`, { redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('settings page disables write for a read-only calendar and strips bidi from names', async () => {
    await bindCalendar();
    const baseUrl = await start(clientListing(CALENDARS));
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/meetings/settings`, { headers: { cookie } })).text();
    expect(html).toMatch(/name="write" value="holidays-id"[^>]*disabled/);
    expect(html).not.toMatch(/name="write" value="family-id"[^>]*disabled/);
    expect(html).not.toContain('‮');
    expect(html).toContain('משפחה');
  });

  it('says the calendar is not connected, and still renders the other fields', async () => {
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/meetings/settings`, { headers: { cookie } })).text();
    expect(html).toContain('היומן לא מחובר');
    expect(html).toContain('name="gapMinutes"');
    expect(html).not.toContain('name="read"');
  });

  it('says so when the calendars cannot be listed', async () => {
    await bindCalendar();
    const baseUrl = await start(clientListing({ failure: 'transient', status: 503, message: 'down' }));
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/meetings/settings`, { headers: { cookie } })).text();
    expect(html).toContain('לא הצלחתי לקרוא עכשיו את רשימת היומנים');
  });
});

describe('read set round trip', () => {
  it('shows no checkbox ticked for the default (all calendars) and keeps [] when saved as it stands', async () => {
    await bindCalendar();
    await saveMeetingSettings({ ...MEETING_DEFAULTS, readCalendarIds: [], locationKind: 'travel' }, { businessId: BUSINESS });
    const baseUrl = await start(clientListing(CALENDARS));
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/meetings/settings`, { headers: { cookie } })).text();
    expect(html).toContain('name="read"');
    expect(html).not.toMatch(/name="read"[^>]*checked/);
    const res = await post(baseUrl, cookie, baseFields(cookie, { calendarsListed: '1', write: 'primary-id' }));
    expect(res.status).toBe(303);
    expect((await loadMeetingSettings({ businessId: BUSINESS })).readCalendarIds).toEqual([]);
  });

  it('round-trips an explicit selection unchanged', async () => {
    await bindCalendar();
    await saveMeetingSettings(
      { ...MEETING_DEFAULTS, readCalendarIds: ['primary-id', 'family-id'], writeCalendarId: 'primary-id', locationKind: 'travel' },
      { businessId: BUSINESS },
    );
    const baseUrl = await start(clientListing(CALENDARS));
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/meetings/settings`, { headers: { cookie } })).text();
    expect(html).toMatch(/name="read" value="primary-id" checked/);
    expect(html).toMatch(/name="read" value="family-id" checked/);
    expect(html).not.toMatch(/name="read" value="holidays-id" checked/);
    const res = await post(baseUrl, cookie, [
      ...baseFields(cookie, { calendarsListed: '1', write: 'primary-id' }),
      ['read', 'primary-id'],
      ['read', 'family-id'],
    ]);
    expect(res.status).toBe(303);
    const s = await loadMeetingSettings({ businessId: BUSINESS });
    expect(s.readCalendarIds).toEqual(['primary-id', 'family-id']);
    expect(s.writeCalendarId).toBe('primary-id');
  });
});

describe('credential failure', () => {
  it('says the stored permission could not be opened, not "not connected"', async () => {
    await bindCalendar();
    const baseUrl = await start(clientListing(CALENDARS), {
      async resolve() {
        throw new Error('vault down');
      },
    });
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/meetings/settings`, { headers: { cookie } })).text();
    expect(html).toContain('לא הצלחתי לפתוח את ההרשאה השמורה ליומן');
    expect(html).not.toContain('היומן לא מחובר');
  });
});

describe('POST /meetings/settings', () => {
  it('saves the other fields when the calendar is not connected, keeping the stored calendar choice', async () => {
    await saveMeetingSettings(
      { ...MEETING_DEFAULTS, readCalendarIds: ['family-id'], writeCalendarId: 'family-id', locationKind: 'travel' },
      { businessId: BUSINESS },
    );
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const res = await post(baseUrl, cookie, baseFields(cookie, { gapMinutes: '45' }));
    expect(res.status).toBe(303);
    const s = await loadMeetingSettings({ businessId: BUSINESS });
    expect(s.gapMinutes).toBe(45);
    expect(s.readCalendarIds).toEqual(['family-id']);
    expect(s.writeCalendarId).toBe('family-id');
  });

  it('saves a read set and a write calendar chosen from the account', async () => {
    await bindCalendar();
    const baseUrl = await start(clientListing(CALENDARS));
    const cookie = await login(baseUrl);
    const res = await post(baseUrl, cookie, [
      ...baseFields(cookie, { calendarsListed: '1', write: 'primary-id' }),
      ['read', 'primary-id'],
      ['read', 'family-id'],
    ]);
    expect(res.status).toBe(303);
    const s = await loadMeetingSettings({ businessId: BUSINESS });
    expect(s.readCalendarIds).toEqual(['primary-id', 'family-id']);
    expect(s.writeCalendarId).toBe('primary-id');
  });

  it('refuses a read-only write calendar, an id outside the account, and a primary left unread', async () => {
    await bindCalendar();
    const baseUrl = await start(clientListing(CALENDARS));
    const cookie = await login(baseUrl);
    const readOnly = await post(baseUrl, cookie, [...baseFields(cookie, { calendarsListed: '1', write: 'holidays-id' }), ['read', 'holidays-id']]);
    expect(readOnly.status).toBe(400);
    expect(await readOnly.text()).toContain('לקריאה בלבד');
    const unknown = await post(baseUrl, cookie, [...baseFields(cookie, { calendarsListed: '1', write: '' }), ['read', 'nope']]);
    expect(unknown.status).toBe(400);
    const primaryUnread = await post(baseUrl, cookie, [...baseFields(cookie, { calendarsListed: '1', write: '' }), ['read', 'family-id']]);
    expect(primaryUnread.status).toBe(400);
    expect((await loadMeetingSettings({ businessId: BUSINESS })).locationKind).toBeNull();
  });

  it('refuses in Hebrew without writing: bad CSRF, fixed without address, non-numbers', async () => {
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    expect((await post(baseUrl, cookie, [['csrf', 'nope'], ['locationKind', 'travel']])).status).toBe(403);
    const fixed = await post(baseUrl, cookie, baseFields(cookie, { locationKind: 'fixed' }));
    expect(fixed.status).toBe(400);
    expect(await fixed.text()).toContain('כתובת');
    const nan = await post(baseUrl, cookie, baseFields(cookie, { gapMinutes: '12abc' }));
    expect(nan.status).toBe(400);
    expect(await nan.text()).toContain('מספרים שלמים');
    expect((await loadMeetingSettings({ businessId: BUSINESS })).locationKind).toBeNull();
  });
});

// =============================================================================
// The meetings screen: /meetings, /meetings/new, /meetings/:id/mark
// =============================================================================

const TZ = 'Asia/Jerusalem';
const RLO = String.fromCharCode(0x202e);

function addDaysTo(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

/** The first Sunday-Thursday at least `after` days out. */
function workDayAfter(after: number): string {
  let date = addDaysTo(localParts(new Date(), TZ).date, after);
  for (;;) {
    const weekday = localParts(localToInstant(date, '12:00', TZ), TZ).weekday;
    if (weekday !== 'fri' && weekday !== 'sat') return date;
    date = addDaysTo(date, 1);
  }
}

function calEvent(over: Partial<CalendarEvent> & { eventId: string; start: string; end: string }): CalendarEvent {
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

function recordingCalendar(initial: CalendarEvent[] = []) {
  const events = [...initial];
  const created: unknown[] = [];
  const client = {
    async listCalendars() {
      return [{ calendarId: 'primary', name: 'ראשי', primary: true, canWrite: true }];
    },
    async listEvents(_t: unknown, q: { fromIso: string; toIso: string }) {
      const from = Date.parse(q.fromIso);
      const to = Date.parse(q.toIso);
      return { events: events.filter((e) => Date.parse(e.start) < to && Date.parse(e.end) > from), truncated: false };
    },
    async createEvent(_t: unknown, calendarId: string, write: { title: string; start: string; end: string }) {
      created.push(write);
      const eventId = `ev-${created.length}`;
      events.push(calEvent({ eventId, calendarId, title: write.title, start: write.start, end: write.end }));
      return { eventId };
    },
    async getEvent() {
      return { failure: 'not_found', status: 404, message: 'gone' };
    },
    async deleteEvent() {
      return { eventId: 'x' };
    },
  } as unknown as CalendarClient;
  return { client, created };
}

async function setupMeetings(): Promise<void> {
  await installCharter(buildCharter({ version: 'meetings-screen', connections: [calendarConnection('google')] }), {
    businessId: BUSINESS,
  });
  await bindCalendar();
  await saveMeetingSettings(
    { ...MEETING_DEFAULTS, locationKind: 'travel', workStart: '09:00', workEnd: '18:00', gapMinutes: 30 },
    { businessId: BUSINESS },
  );
}

function meetingsPost(
  baseUrl: string,
  cookie: string,
  path: string,
  fields: Record<string, string>,
  withCsrf = true,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { cookie },
    body: new URLSearchParams({ ...(withCsrf ? { csrf: csrfFor(cookie) } : {}), ...fields }),
    redirect: 'manual',
  });
}

async function insertMeeting(over: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    meeting_id: `m-${Math.random().toString(36).slice(2, 10)}`,
    business_id: BUSINESS,
    job_id: 'job-x',
    step_id: `s-${Math.random().toString(36).slice(2, 10)}`,
    calendar_id: 'primary',
    event_id: 'ev-x',
    operation: 'create',
    client_name: 'דני כהן',
    client_email: 'dani@client.example',
    state: 'active',
    response: 'needs_action',
    ...over,
  };
  const keys = Object.keys(row);
  await getPool().query(
    `INSERT INTO meetings (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    keys.map((k) => row[k]),
  );
  return row['meeting_id'] as string;
}

async function insertMail(from: string, subject: string, receivedAt: Date): Promise<void> {
  await getPool().query(
    `INSERT INTO mail_messages (mail_id, business_id, provider_message_id, thread_id, from_address, subject, received_at)
     VALUES ($1,$2,$1,'t',$3,$4,$5)`,
    [`mail-${Math.random().toString(36).slice(2, 10)}`, BUSINESS, from, subject, receivedAt],
  );
}

function formFields(over: Record<string, string> = {}): Record<string, string> {
  const day = workDayAfter(2);
  return {
    name: 'דני כהן',
    email: 'dani@client.example',
    phone: '050-1234567',
    location: 'הרצל 5, רמת גן',
    clientNotes: 'להביא חוזה',
    internalNote: 'לא לשכוח לגבות חוב',
    fromDate: day,
    toDate: day,
    fromTime: '',
    toTime: '',
    duration: '60',
    ...over,
  };
}

describe('the meetings screen', () => {
  it('the form books through the instruction door with the typed email verified', async () => {
    await setupMeetings();
    const cal = recordingCalendar();
    const baseUrl = await start(cal.client);
    const cookie = await login(baseUrl);

    const res = await meetingsPost(
      baseUrl,
      cookie,
      '/meetings/new',
      formFields({ clientNotes: 'x'.repeat(1000), internalNote: 'y'.repeat(1000) }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/meetings');

    const pool = getPool();
    const { rows: meetings } = await pool.query(
      `SELECT client_email, client_email_verified, client_phone, state, operation FROM meetings WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(meetings).toHaveLength(1);
    expect(meetings[0]).toMatchObject({
      client_email: 'dani@client.example',
      client_email_verified: true,
      client_phone: '050-1234567',
      state: 'proposed',
      operation: 'create',
    });
    const { rows: instr } = await pool.query(`SELECT text, text_origin FROM boss_instructions WHERE business_id = $1`, [BUSINESS]);
    expect(instr).toHaveLength(1);
    expect(instr[0].text_origin).toBe('typed');
    expect(instr[0].text).toContain('dani@client.example');
    expect(instr[0].text).toContain('050-1234567');
    expect(instr[0].text.length).toBeLessThanOrEqual(4000);
    // The tentative hold was placed; nothing else is written before the owner says yes.
    expect(cal.created).toHaveLength(1);

    // The question waits at the top of the screen, with the shared confirm route.
    const html = await (await fetch(`${baseUrl}/meetings`, { headers: { cookie } })).text();
    expect(html).toContain('פגישות שממתינות לאישורך');
    expect(html).toMatch(/action="\/instruct\/[^"]+\/confirm"/);
  });

  it('refuses a bad form in Hebrew, keeping the entered values and booking nothing', async () => {
    await setupMeetings();
    const baseUrl = await start(recordingCalendar().client);
    const cookie = await login(baseUrl);
    const day = workDayAfter(2);

    const cases: [Record<string, string>, string][] = [
      [{ name: '' }, 'שם הלקוח'],
      [{ fromDate: addDaysTo(day, 1), toDate: day }, 'תאריך ההתחלה'],
      [{ fromTime: '15:00', toTime: '14:00' }, 'שעת ההתחלה'],
      [{ fromTime: '9:5' }, 'HH:MM'],
      [{ duration: '4' }, 'משך הפגישה'],
      [{ email: 'not-an-email' }, 'כתובת המייל'],
    ];
    for (const [over, expected] of cases) {
      const res = await meetingsPost(baseUrl, cookie, '/meetings/new', formFields({ location: 'בדיקה-ערך', ...over }));
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain(expected);
      expect(html).toContain('בדיקה-ערך');
    }
    const { rows } = await getPool().query(`SELECT 1 FROM boss_instructions WHERE business_id = $1`, [BUSINESS]);
    expect(rows).toHaveLength(0);
  });

  it('shows tomorrow with response icons', async () => {
    await setupMeetings();
    const tomorrow = addDaysTo(localParts(new Date(), TZ).date, 1);
    const at = (hhmm: string): string => localToInstant(tomorrow, hhmm, TZ).toISOString();
    const att = (response: 'accepted' | 'declined' | 'needs_action') => [{ email: 'c@x.example', response }];
    const cal = recordingCalendar([
      calEvent({ eventId: 'e1', title: 'א', start: at('09:00'), end: at('10:00'), location: 'משרד', attendees: att('accepted') }),
      calEvent({ eventId: 'e2', title: 'ב', start: at('11:00'), end: at('12:00'), attendees: att('declined') }),
      calEvent({ eventId: 'e3', title: 'ג', start: at('13:00'), end: at('14:00'), attendees: att('needs_action') }),
      calEvent({ eventId: 'e4', title: 'ד', start: at('15:00'), end: at('16:00') }),
      calEvent({ eventId: 'e5', title: `ה${RLO}`, start: at('16:30'), end: at('17:00'), selfDeclined: true }),
    ]);
    await insertMeeting({ event_id: 'e4', client_name: 'דנה לוי', response: 'not_updated' });
    const baseUrl = await start(cal.client);
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/meetings`, { headers: { cookie } })).text();
    expect(html).toContain('09:00–10:00');
    expect(html).toContain('✅ אישר');
    expect(html).toContain('❌ דחה');
    expect(html).toContain('⏳ ממתין לתשובה');
    expect(html).toContain('⚠️ לא עודכן');
    expect(html).toContain('דנה לוי');
    expect(html).toContain('❌ דחית');
    expect(html).toContain('משרד');
    expect(html).not.toContain(RLO);
  });

  it("shows a client's mail reply with mark buttons and marking sets the response", async () => {
    await setupMeetings();
    const id = await insertMeeting();
    const later = new Date(Date.now() + 60_000);
    await insertMail('Dani@Client.example', `מאשר${RLO} ביום ג׳`, later);
    await insertMail('someone@else.example', 'לא קשור', later);
    await insertMail('dani@client.example', 'לפני ההזמנה', new Date(Date.now() - 3_600_000));
    const baseUrl = await start(recordingCalendar().client);
    const cookie = await login(baseUrl);

    const html = await (await fetch(`${baseUrl}/meetings`, { headers: { cookie } })).text();
    expect(html).toContain('מאשר ביום ג׳');
    expect(html).not.toContain(RLO);
    expect(html).not.toContain('לא קשור');
    expect(html).not.toContain('לפני ההזמנה');
    expect(html).toContain(`/meetings/${id}/mark`);

    const res = await meetingsPost(baseUrl, cookie, `/meetings/${id}/mark`, { response: 'accepted' });
    expect(res.status).toBe(303);
    const { rows } = await getPool().query(`SELECT response, response_at FROM meetings WHERE meeting_id = $1`, [id]);
    expect(rows[0].response).toBe('accepted');
    expect(rows[0].response_at).not.toBeNull();

    const { rows: audit } = await getPool().query(
      `SELECT reason, kind FROM audit_log WHERE business_id = $1 AND reason LIKE 'meeting_response_marked:%'`,
      [BUSINESS],
    );
    expect(audit).toEqual([{ reason: 'meeting_response_marked:accepted', kind: 'tool_call' }]);

    const after = await (await fetch(`${baseUrl}/meetings`, { headers: { cookie } })).text();
    expect(after).not.toContain('ביום ג׳');
  });

  it("mark refuses another business's meeting, a meeting not active, and any other response", async () => {
    await setupMeetings();
    const foreign = await insertMeeting({ business_id: 'other-business' });
    const proposed = await insertMeeting({ state: 'proposed' });
    const mine = await insertMeeting();
    const baseUrl = await start(recordingCalendar().client);
    const cookie = await login(baseUrl);

    expect((await meetingsPost(baseUrl, cookie, `/meetings/${foreign}/mark`, { response: 'declined' })).status).toBe(404);
    expect((await meetingsPost(baseUrl, cookie, `/meetings/${proposed}/mark`, { response: 'declined' })).status).toBe(404);
    expect((await meetingsPost(baseUrl, cookie, `/meetings/${mine}/mark`, { response: 'tentative' })).status).toBe(400);
    expect((await meetingsPost(baseUrl, cookie, `/meetings/${mine}/mark`, {})).status).toBe(400);
    const { rows } = await getPool().query(`SELECT response FROM meetings`);
    expect(rows.every((r) => r.response === 'needs_action')).toBe(true);
    const { rows: audit } = await getPool().query(`SELECT 1 FROM audit_log WHERE reason LIKE 'meeting_response_marked:%'`);
    expect(audit).toHaveLength(0);
  });

  it('every POST requires CSRF', async () => {
    await setupMeetings();
    const id = await insertMeeting();
    const cal = recordingCalendar();
    const baseUrl = await start(cal.client);
    const cookie = await login(baseUrl);

    expect((await meetingsPost(baseUrl, cookie, '/meetings/new', formFields(), false)).status).toBe(403);
    expect((await meetingsPost(baseUrl, cookie, `/meetings/${id}/mark`, { response: 'accepted' }, false)).status).toBe(403);
    const { rows } = await getPool().query(`SELECT response FROM meetings WHERE meeting_id = $1`, [id]);
    expect(rows[0].response).toBe('needs_action');
    expect(cal.created).toHaveLength(0);
    const { rows: instr } = await getPool().query(`SELECT 1 FROM boss_instructions`);
    expect(instr).toHaveLength(0);
  });

  it('requires a session', async () => {
    const baseUrl = await start();
    expect((await fetch(`${baseUrl}/meetings`, { redirect: 'manual' })).status).toBe(302);
    expect((await fetch(`${baseUrl}/meetings/new`, { method: 'POST', redirect: 'manual' })).status).toBe(302);
  });
});
