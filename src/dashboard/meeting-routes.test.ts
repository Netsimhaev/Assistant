/**
 * The meeting settings screen: `/meetings/settings`. Real HTTP server and
 * Postgres; the calendar client and credential source are the test seams.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR_SYSTEM } from '../calendar/calendar.js';
import type { CalendarClient, CalendarInfo } from '../calendar/types.js';
import { installCharter } from '../charter/store.js';
import { closePool } from '../db/pool.js';
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

async function start(client?: CalendarClient): Promise<string> {
  server = createServer({
    businessId: BUSINESS,
    port: 0,
    ...(client !== undefined ? { calendarClient: client, calendarCredentials: CREDENTIALS } : { calendarCredentials: CREDENTIALS }),
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
