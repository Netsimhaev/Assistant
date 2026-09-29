/**
 * Route-level tests for the OAuth consent ceremony: a full HTTP server
 * (`createServer`), a real Postgres, and a faked provider `fetch` — the same
 * harness `server.test.ts` uses for every other dashboard route.
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
import { putSecret } from '../governance/credential-store.js';
import { KEY_BYTES, writeKeyState } from '../governance/master-key.js';
import { readGrantBySystem } from '../governance/oauth-grants.js';
import {
  GOOGLE_CLIENT_ID_REF,
  GOOGLE_CLIENT_SECRET_REF,
} from '../orchestrator/adapters/google-token-http.js';
import { loadBindings } from '../orchestrator/bindings.js';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { createOwner } from './auth.js';
import { issueCsrfToken } from './csrf.js';
import { createServer } from './server.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
const SYSTEM = 'office-calendar';
const DASHBOARD_BASE_URL = 'http://127.0.0.1:4173';

let server: Server | null = null;
let keyDir: string;
let keyPath: string;
let key: Buffer;

beforeEach(async () => {
  await resetDatabase();
  keyDir = await mkdtemp(join(tmpdir(), 'oauth-routes-'));
  keyPath = join(keyDir, 'master.key');
  key = randomBytes(KEY_BYTES);
  await writeFile(keyPath, key, { mode: 0o600 });
  // Install-wide, exactly like `oauth-grants.test.ts`'s own `beforeEach`:
  // `writeGrant`/`putSecret` check the key state under `config.businessId`
  // only, not `input.businessId` — one row here is enough regardless of
  // which business this file's requests are scoped to.
  await writeKeyState(key, 'KEY-test');
  await putSecret(
    { businessId: BUSINESS, ref: GOOGLE_CLIENT_ID_REF, value: 'test-client-id', updatedBy: 'test' },
    key,
  );
  await putSecret(
    { businessId: BUSINESS, ref: GOOGLE_CLIENT_SECRET_REF, value: 'test-client-secret', updatedBy: 'test' },
    key,
  );
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

async function startServer(options: { oauthFetch?: typeof fetch } = {}): Promise<string> {
  server = createServer({
    businessId: BUSINESS,
    port: 0,
    credentialKeyPath: keyPath,
    dashboardBaseUrl: DASHBOARD_BASE_URL,
    ...(options.oauthFetch !== undefined ? { oauthFetch: options.oauthFetch } : {}),
  });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function cookiePair(setCookieHeader: string | null): string {
  if (!setCookieHeader) throw new Error('no Set-Cookie header on response');
  const pair = setCookieHeader.split(';')[0];
  if (!pair) throw new Error('empty Set-Cookie header');
  return pair;
}

/** The cookie's own value IS the session id `loadSession` reads — see `server.ts`'s `loadSession`. */
function sessionIdFromCookie(cookie: string): string {
  const value = cookie.split('=')[1];
  if (value === undefined) throw new Error(`malformed cookie pair: ${cookie}`);
  return value;
}

async function loginWithPassword(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ username: USERNAME, password: PASSWORD }),
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return cookiePair(res.headers.get('set-cookie'));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A faked provider: token exchange, account lookup, and revocation all answer successfully. */
function successfulProviderFetch(): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    if (href.includes('oauth2.googleapis.com/token')) {
      const body = String(init?.body ?? '');
      expect(body).toContain('grant_type=authorization_code');
      return jsonResponse(200, {
        access_token: 'access-token-value',
        refresh_token: 'refresh-token-value',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/calendar.readonly',
      });
    }
    if (href.includes('calendar/v3/calendars/primary')) {
      return jsonResponse(200, { id: 'owner@example.com' });
    }
    if (href.includes('oauth2.googleapis.com/revoke')) {
      return new Response('', { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  }) as typeof fetch;
}

/** Starts the ceremony and returns the `state` value from the redirect Google would receive. */
async function beginConsent(baseUrl: string, cookie: string, system = SYSTEM): Promise<string> {
  const res = await fetch(`${baseUrl}/oauth/${system}/start`, {
    headers: { cookie },
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  const location = res.headers.get('location');
  if (!location) throw new Error('no Location header on the start redirect');
  const url = new URL(location);
  expect(url.hostname).toBe('accounts.google.com');
  const state = url.searchParams.get('state');
  if (!state) throw new Error('no state on the consent URL');
  return state;
}

describe('GET /oauth/:system/start', () => {
  it('redirects to Google carrying a fresh state and PKCE challenge, and requires a session', async () => {
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);

    const res = await fetch(`${baseUrl}/oauth/${SYSTEM}/start`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location') ?? '');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(`${DASHBOARD_BASE_URL}/oauth/callback`);
  });

  it('refuses without a session', async () => {
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const res = await fetch(`${baseUrl}/oauth/${SYSTEM}/start`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('GET /oauth/callback', () => {
  it('writes a grant and the binding provider on a correct state, and shows the restart note', async () => {
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);
    const state = await beginConsent(baseUrl, cookie);

    const res = await fetch(`${baseUrl}/oauth/callback?state=${state}&code=auth-code-value`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('owner@example.com');
    // Ruling 2: the success page must say the scheduler only reads bindings
    // at startup, so a newly authorised connection needs a restart.
    expect(body).toMatch(/scheduler|תזמון/);
    expect(body).toMatch(/הפעל(ה|ה מחדש|ת)|restart/);

    const grant = await readGrantBySystem(SYSTEM, BUSINESS, key);
    expect(grant?.provider).toBe('google');
    expect(grant?.account).toBe('owner@example.com');
    expect(grant?.scopes).toEqual(['https://www.googleapis.com/auth/calendar.readonly']);
    expect(grant?.refreshToken).toBe('refresh-token-value');
    // Never the token, anywhere in the rendered page.
    expect(body).not.toContain('refresh-token-value');
    expect(body).not.toContain('access-token-value');

    const bindings = await loadBindings({ businessId: BUSINESS });
    const binding = bindings.find((b) => b.system === SYSTEM);
    expect(binding?.provider).toBe('google');
    expect(binding?.status).toBe('live');
    expect(binding?.credentialRef).toBe('OFFICE_CALENDAR');

    const audit = await queryAudit({ businessId: BUSINESS, kind: 'credential_change' });
    expect(audit.some((row) => row.reason.includes(SYSTEM))).toBe(true);
  });

  /**
   * Step 5's required test: a fabricated `state` is refused and writes
   * nothing, while the correct one (still unconsumed) later succeeds.
   */
  it('refuses a fabricated state and writes no grant, while the real one still works', async () => {
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);
    const state = await beginConsent(baseUrl, cookie);

    const fabricated = await fetch(`${baseUrl}/oauth/callback?state=made-up-state&code=auth-code-value`, {
      headers: { cookie },
    });
    expect(fabricated.status).toBe(400);
    expect(await readGrantBySystem(SYSTEM, BUSINESS, key)).toBeNull();

    const real = await fetch(`${baseUrl}/oauth/callback?state=${state}&code=auth-code-value`, {
      headers: { cookie },
    });
    expect(real.status).toBe(200);
    expect(await readGrantBySystem(SYSTEM, BUSINESS, key)).not.toBeNull();
  });

  it('refuses the same state a second time (single-use)', async () => {
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);
    const state = await beginConsent(baseUrl, cookie);

    const first = await fetch(`${baseUrl}/oauth/callback?state=${state}&code=auth-code-value`, {
      headers: { cookie },
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/oauth/callback?state=${state}&code=auth-code-value`, {
      headers: { cookie },
    });
    expect(second.status).toBe(400);
  });

  /**
   * The callback must never trust the query string for WHICH system is
   * being authorised — only the stored row `state` resolves to. A `system`
   * query parameter is exactly the shape an attacker would forge to redirect
   * a legitimate-looking completion at a different system's binding.
   */
  it('ignores a forged `system` query parameter and uses the one the state row names', async () => {
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);
    const state = await beginConsent(baseUrl, cookie, SYSTEM);

    const res = await fetch(
      `${baseUrl}/oauth/callback?state=${state}&code=auth-code-value&system=some-other-system`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);

    expect(await readGrantBySystem(SYSTEM, BUSINESS, key)).not.toBeNull();
    expect(await readGrantBySystem('some-other-system', BUSINESS, key)).toBeNull();
  });

  it('renders a readable page, not a crash, when the provider reports access_denied', async () => {
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);
    const state = await beginConsent(baseUrl, cookie);

    const res = await fetch(`${baseUrl}/oauth/callback?state=${state}&error=access_denied`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(SYSTEM);
    expect(await readGrantBySystem(SYSTEM, BUSINESS, key)).toBeNull();
  });
});

describe('POST /oauth/:system/revoke', () => {
  async function grantedSystem(baseUrl: string, cookie: string): Promise<void> {
    const state = await beginConsent(baseUrl, cookie);
    const res = await fetch(`${baseUrl}/oauth/callback?state=${state}&code=auth-code-value`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  }

  it('revokes locally first, attempts the provider, and records one audit row', async () => {
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);
    await grantedSystem(baseUrl, cookie);

    const sessionId = sessionIdFromCookie(cookie);
    const res = await fetch(`${baseUrl}/oauth/${SYSTEM}/revoke`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: issueCsrfToken(sessionId) }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);

    // `readGrantBySystem` filters `revoked_at IS NULL` — a revoked grant is
    // no longer readable through the ordinary path, which is the point.
    expect(await readGrantBySystem(SYSTEM, BUSINESS, key)).toBeNull();

    const audit = await queryAudit({ businessId: BUSINESS, kind: 'credential_change' });
    expect(audit.some((row) => row.reason.includes('revoked'))).toBe(true);
  });

  it('refuses without a valid CSRF token, and does not revoke', async () => {
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);
    await grantedSystem(baseUrl, cookie);

    const res = await fetch(`${baseUrl}/oauth/${SYSTEM}/revoke`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: 'not-a-real-token' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(await readGrantBySystem(SYSTEM, BUSINESS, key)).not.toBeNull();
  });

  it('still revokes locally even when the provider-side attempt fails', async () => {
    const baseUrl = await startServer({
      oauthFetch: (async (url: string | URL, init?: RequestInit) => {
        const href = url.toString();
        if (href.includes('oauth2.googleapis.com/revoke')) {
          throw new Error('network down');
        }
        return successfulProviderFetch()(url as string, init);
      }) as typeof fetch,
    });
    const cookie = await loginWithPassword(baseUrl);
    await grantedSystem(baseUrl, cookie);

    const sessionId = sessionIdFromCookie(cookie);
    const res = await fetch(`${baseUrl}/oauth/${SYSTEM}/revoke`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: issueCsrfToken(sessionId) }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(await readGrantBySystem(SYSTEM, BUSINESS, key)).toBeNull();
  });
});
