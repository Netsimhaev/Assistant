/**
 * Route tests for the business calendar's OAuth ceremony: the provider named in
 * the SIGNED charter is the only one the ceremony may run for, checked at start
 * and again at the callback. Real HTTP server and Postgres, faked provider --
 * the same harness `mailbox-connect.test.ts` uses.
 */
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCalendarAmendment } from '../charter/amend-calendar.js';
import { signCharter } from '../charter/sign.js';
import { installCharter } from '../charter/store.js';
import { closePool, getPool, withBusiness } from '../db/pool.js';
import type { CalendarProvider } from '../calendar/calendar.js';
import type { CharterConnection } from '../domain/connection.js';
import { KEY_BYTES, writeKeyState } from '../governance/master-key.js';
import { readGrantBySystem } from '../governance/oauth-grants.js';
import { GOOGLE_CLIENT_ID_REF, GOOGLE_CLIENT_SECRET_REF } from '../orchestrator/adapters/google-token-http.js';
import { loadBindings } from '../orchestrator/bindings.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase } from '../test/db.js';
import { createOwner } from './auth.js';
import { createServer } from './server.js';
import { putPlatformSecret } from '../tenancy/platform-credentials.js';

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

beforeEach(async () => {
  await resetDatabase();
  keyDir = await mkdtemp(join(tmpdir(), 'calendar-oauth-'));
  keyPath = join(keyDir, 'master.key');
  key = randomBytes(KEY_BYTES);
  await writeFile(keyPath, key, { mode: 0o600 });
  await writeKeyState(key, 'KEY-test');
  for (const [ref, value] of [
    [GOOGLE_CLIENT_ID_REF, 'g-id'],
    [GOOGLE_CLIENT_SECRET_REF, 'g-secret'],
    ['MICROSOFT_OAUTH_CLIENT_ID', 'ms-id'],
    ['MICROSOFT_OAUTH_CLIENT_SECRET', 'ms-secret'],
  ] as const) {
    // The OAuth client is the server's, not the business's (spec §5.4).
    await putPlatformSecret(ref, value, key, 'test');
  }
  await createOwner({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
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

async function startServer(oauthFetch: typeof fetch): Promise<string> {
  server = createServer({
    businessId: BUSINESS,
    port: 0,
    credentialKeyPath: keyPath,
    dashboardBaseUrl: 'http://127.0.0.1:4173',
    oauthFetch,
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
  expect(res.status).toBe(302);
  const pair = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (!pair) throw new Error('no session cookie');
  return pair;
}

/** Installs a base charter, then the calendar amendment signed for `provider`. */
async function installSignedCalendar(provider: CalendarProvider, version: string): Promise<void> {
  const base = buildCharter({ version, connections: [OFFICE_CALENDAR] });
  await withBusiness(BUSINESS, (bdb) => installCharter(bdb, base)); // TENANCY-TODO(task 10)
  await withBusiness(BUSINESS, (bdb) => installCharter( // TENANCY-TODO(task 10)
    bdb,
    signCharter(buildCalendarAmendment(base, new Date(), provider), {
      signedByPersonId: USERNAME,
      method: 'dashboard_click',
    })
  ));
}

describe('calendar OAuth ceremony and the signed provider', () => {
  it('refuses a provider other than the one signed, and creates no state row', async () => {
    await installSignedCalendar('google', 'base-a');
    const calls: string[] = [];
    const baseUrl = await startServer((async (url: string | URL) => {
      calls.push(url.toString());
      throw new Error('no provider call expected');
    }) as typeof fetch);
    const cookie = await login(baseUrl);

    const res = await fetch(`${baseUrl}/oauth/calendar/start?provider=microsoft`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM oauth_states');
    expect(rows[0]?.['n']).toBe(0);
    expect(calls).toEqual([]);

    // The signed provider itself starts normally (read-write scopes).
    const ok = await fetch(`${baseUrl}/oauth/calendar/start?provider=google`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(ok.status).toBe(302);
    const scope = new URL(ok.headers.get('location') ?? '').searchParams.get('scope') ?? '';
    expect(scope).toContain('calendar.events');
  });

  it('re-checks the signed provider at callback time; a mismatch exchanges no token and writes nothing', async () => {
    await installSignedCalendar('microsoft', 'base-b');
    const calls: string[] = [];
    const baseUrl = await startServer((async (url: string | URL) => {
      calls.push(url.toString());
      throw new Error('no provider call expected');
    }) as typeof fetch);
    const cookie = await login(baseUrl);
    const start = await fetch(`${baseUrl}/oauth/calendar/start?provider=microsoft`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');

    // Between start and callback the charter is re-signed for Google.
    await installSignedCalendar('google', 'base-c');

    const res = await fetch(`${baseUrl}/oauth/callback?state=${state}&code=c`, { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
    expect(await withBusiness(BUSINESS, (bdb) => readGrantBySystem(bdb, 'calendar', key))).toBeNull();
    expect((await withBusiness(BUSINESS, (db) => loadBindings(db))).some((b) => b.system === 'calendar')).toBe(false);
  });
});
