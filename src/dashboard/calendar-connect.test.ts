/**
 * Route tests for connecting the business calendar: status, the sign page and
 * its preflight, the signed amendment, and the way back. Real HTTP server and
 * Postgres — the harness `mailbox-connect.test.ts` uses.
 */
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryAudit } from '../audit/log.js';
import { CALENDAR_SYSTEM } from '../calendar/calendar.js';
import { buildCalendarAmendment } from '../charter/amend-calendar.js';
import { signCharter } from '../charter/sign.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import type { CharterConnection } from '../domain/connection.js';
import { putSecret } from '../governance/credential-store.js';
import { KEY_BYTES, writeKeyState } from '../governance/master-key.js';
import { GOOGLE_CLIENT_ID_REF, GOOGLE_CLIENT_SECRET_REF } from '../orchestrator/adapters/google-token-http.js';
import { upsertBinding } from '../orchestrator/bindings.js';
import { writeGrant } from '../governance/oauth-grants.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase } from '../test/db.js';
import { createOwner } from './auth.js';
import { issueCsrfToken } from './csrf.js';
import { CALENDAR_AUTHORISATION_TEXT } from './calendar-connect.js';
import { createServer } from './server.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

const OFFICE_CALENDAR: CharterConnection = {
  system: 'office-calendar',
  label: 'יומן המשרד',
  channel: 'api',
  serves: ['calendar.read'],
  target: null,
  subprocessor: null,
};

let server: Server | null = null;
let keyDir: string;
let keyPath: string;
let key: Buffer;

async function seedProviderApp(provider: 'google' | 'microsoft' | 'both'): Promise<void> {
  const refs: [string, string][] = [];
  if (provider !== 'microsoft') refs.push([GOOGLE_CLIENT_ID_REF, 'g-id'], [GOOGLE_CLIENT_SECRET_REF, 'g-secret']);
  if (provider !== 'google') refs.push(['MICROSOFT_OAUTH_CLIENT_ID', 'ms-id'], ['MICROSOFT_OAUTH_CLIENT_SECRET', 'ms-secret']);
  for (const [ref, value] of refs) await putSecret({ businessId: BUSINESS, ref, value, updatedBy: 'test' }, key);
}

beforeEach(async () => {
  await resetDatabase();
  keyDir = await mkdtemp(join(tmpdir(), 'calendar-connect-'));
  keyPath = join(keyDir, 'master.key');
  key = randomBytes(KEY_BYTES);
  await writeFile(keyPath, key, { mode: 0o600 });
  await writeKeyState(key, 'KEY-test');
  await createOwner({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
  await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ connections: [OFFICE_CALENDAR] }))); // TENANCY-TODO(task 10)
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await rm(keyDir, { recursive: true, force: true });
});
afterAll(async () => {
  await closePool();
});

async function startServer(): Promise<string> {
  server = createServer({ businessId: BUSINESS, port: 0, credentialKeyPath: keyPath, dashboardBaseUrl: 'http://127.0.0.1:4173' });
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

async function postForm(baseUrl: string, cookie: string, path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(fields), redirect: 'manual' });
}

async function installSignedCalendar(provider: 'google' | 'microsoft'): Promise<void> {
  const active = await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb)); // TENANCY-TODO(task 10)
  if (active === null) throw new Error('no charter');
  await withBusiness(BUSINESS, (bdb) => installCharter( // TENANCY-TODO(task 10)
    bdb,
    signCharter(buildCalendarAmendment(active.charter, new Date(), provider), { signedByPersonId: USERNAME, method: 'dashboard_click' })
  ));
}

async function connectLive(): Promise<void> {
  await writeGrant(
    {
      businessId: BUSINESS,
      system: CALENDAR_SYSTEM,
      provider: 'google',
      credentialRef: 'OAUTH_CALENDAR',
      account: 'owner@business.example',
      scopes: ['https://www.googleapis.com/auth/calendar'],
      refreshToken: 'refresh',
      grantedBy: USERNAME,
    },
    key,
  );
  await withBusiness(BUSINESS, (db) => upsertBinding(db, { system: CALENDAR_SYSTEM, status: 'live', endpoint: null, credentialRef: 'OAUTH_CALENDAR', provider: 'google', lastOkAt: null, lastError: null }, { by: 'test' }));
}

describe('calendar sign page', () => {
  it('shows the authorisation text and refuses without preflight', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);

    // No Google app credentials seeded: the preflight refuses, the page does not render a form.
    const refused = await fetch(`${baseUrl}/connections/calendar/sign?provider=google`, { headers: { cookie } });
    expect(refused.status).toBe(409);
    const refusedHtml = await refused.text();
    expect(refusedHtml).toContain('אי אפשר לחתום עדיין');
    expect(refusedHtml).toContain('היומן');
    expect(refusedHtml).not.toContain('חתימה על התוספת לתקנון');

    await seedProviderApp('google');
    const ok = await fetch(`${baseUrl}/connections/calendar/sign?provider=google`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    const html = await ok.text();
    // The text is on the page verbatim; the page escapes `"` so compare against the escaped form.
    expect(html).toContain(CALENDAR_AUTHORISATION_TEXT.replace(/"/g, '&quot;'));
    expect(html).toContain('office-calendar');
    expect(html).toContain('action="/connections/calendar/sign"');
  });

  it('rejects an unknown provider and a second signature', async () => {
    await seedProviderApp('both');
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    expect((await fetch(`${baseUrl}/connections/calendar/sign?provider=yahoo`, { headers: { cookie } })).status).toBe(400);
    await installSignedCalendar('google');
    expect((await fetch(`${baseUrl}/connections/calendar/sign?provider=google`, { headers: { cookie } })).status).toBe(409);
  });
});

describe('POST /connections/calendar/sign', () => {
  it('signs: the charter gains the calendar connection and an audit row is written', async () => {
    await seedProviderApp('google');
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const before = await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb)); // TENANCY-TODO(task 10)
    const res = await postForm(baseUrl, cookie, '/connections/calendar/sign', {
      csrf: csrfFor(cookie),
      provider: 'google',
      base: before?.charter.charterVersion ?? '',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/connections/calendar');
    const after = await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb)); // TENANCY-TODO(task 10)
    expect(after?.charter.connections.map((c) => c.system)).toContain(CALENDAR_SYSTEM);
    expect(after?.charter.connections.map((c) => c.system)).not.toContain('office-calendar');
    expect((await withBusiness(BUSINESS, (bdb) => queryAudit(bdb))).some((r) => r.kind === 'charter_change')).toBe(true); // TENANCY-TODO(task 10)
  });

  it('refuses a bad CSRF token and a stale base, writing nothing', async () => {
    await seedProviderApp('google');
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const base = (await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb)))?.charter.charterVersion ?? ''; // TENANCY-TODO(task 10)
    expect((await postForm(baseUrl, cookie, '/connections/calendar/sign', { csrf: 'nope', provider: 'google', base })).status).toBe(403);
    expect((await postForm(baseUrl, cookie, '/connections/calendar/sign', { csrf: csrfFor(cookie), provider: 'google', base: 'old' })).status).toBe(409);
    expect((await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb)))?.charter.connections.map((c) => c.system)).not.toContain(CALENDAR_SYSTEM); // TENANCY-TODO(task 10)
  });
});

describe('the way back', () => {
  it('reverts while the calendar is not live, restoring the legacy connection', async () => {
    await seedProviderApp('google');
    await installSignedCalendar('google');
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const status = await (await fetch(`${baseUrl}/connections/calendar`, { headers: { cookie } })).text();
    expect(status).toContain('בטל את חיבור היומן');
    const base = (await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb)))?.charter.charterVersion ?? ''; // TENANCY-TODO(task 10)
    const res = await postForm(baseUrl, cookie, '/connections/calendar/revert', { csrf: csrfFor(cookie), base });
    expect(res.status).toBe(303);
    const systems = (await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb)))?.charter.connections.map((c) => c.system) ?? []; // TENANCY-TODO(task 10)
    expect(systems).not.toContain(CALENDAR_SYSTEM);
    expect(systems).toContain('office-calendar');
  });

  it('never shows "active" next to the revert button: a grant with a non-live binding is not active', async () => {
    await seedProviderApp('google');
    await installSignedCalendar('google');
    await connectLive();
    await withBusiness(BUSINESS, (db) => upsertBinding(db, { system: CALENDAR_SYSTEM, status: 'disconnected', endpoint: null, credentialRef: 'OAUTH_CALENDAR', provider: 'google', lastOkAt: null, lastError: null }, { by: 'test' }));
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const status = await (await fetch(`${baseUrl}/connections/calendar`, { headers: { cookie } })).text();
    expect(status).toContain('action="/connections/calendar/revert"');
    expect(status).not.toContain('<b>פעיל</b>');
  });

  it('offers no revert, and refuses one, while the calendar is live', async () => {
    await seedProviderApp('google');
    await installSignedCalendar('google');
    await connectLive();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const status = await (await fetch(`${baseUrl}/connections/calendar`, { headers: { cookie } })).text();
    expect(status).not.toContain('action="/connections/calendar/revert"');
    expect(status).toContain('פעיל');
    const base = (await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb)))?.charter.charterVersion ?? ''; // TENANCY-TODO(task 10)
    const res = await postForm(baseUrl, cookie, '/connections/calendar/revert', { csrf: csrfFor(cookie), base });
    expect(res.status).toBe(409);
    expect((await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb)))?.charter.connections.map((c) => c.system)).toContain(CALENDAR_SYSTEM); // TENANCY-TODO(task 10)
  });
});

describe('the OAuth ceremony for the calendar', () => {
  it('gives the calendar its own wording for a bad provider, not the mail wording', async () => {
    await installSignedCalendar('google');
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/oauth/calendar/start?provider=yahoo`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('ספק יומן');
    expect(html).not.toContain('ספק דואר');
  });

  it('refuses a provider other than the signed one', async () => {
    await seedProviderApp('both');
    await installSignedCalendar('google');
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/oauth/calendar/start?provider=microsoft`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('היומן');
  });
});
