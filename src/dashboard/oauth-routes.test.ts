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
import { closePool, getPool } from '../db/pool.js';
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
    // M11: extend the "no secrets" assertion beyond the two tokens above to
    // the app's own client secret — on the page and in the permanent record.
    expect(body).not.toContain('test-client-secret');
    for (const row of audit) expect(row.reason).not.toContain('test-client-secret');
  });

  /**
   * I2 — the session-binding check has no coverage today: every existing
   * test reuses one cookie for both `/start` and the callback, so
   * `consumed.sessionId !== session.sessionId` could be deleted and every
   * other test here would stay green. A second, independent login (NOT a
   * revoke of the first — `login` never revokes prior sessions, only a
   * password change does) begins consent under cookie A and completes the
   * callback under cookie B.
   */
  it('refuses a callback completed from a different session than the one that began it (I2)', async () => {
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookieA = await loginWithPassword(baseUrl);
    const cookieB = await loginWithPassword(baseUrl);
    expect(cookieB).not.toBe(cookieA);
    const state = await beginConsent(baseUrl, cookieA);

    const res = await fetch(`${baseUrl}/oauth/callback?state=${state}&code=auth-code-value`, {
      headers: { cookie: cookieB },
    });
    expect(res.status).toBe(400);
    expect(await readGrantBySystem(SYSTEM, BUSINESS, key)).toBeNull();
  });

  /**
   * I3 — the fake used everywhere else grants exactly the scope that was
   * requested, so `scopes: exchange.grantedScopes` could be swapped for the
   * requested constant and stay green. This fake grants something else
   * entirely, and the grant must record THAT, not the calendar-readonly
   * scope the `/start` redirect actually asked for.
   */
  it('records what the provider granted, not what was requested (I3)', async () => {
    const grantedInstead = 'https://example.com/a-completely-different-scope';
    const baseUrl = await startServer({
      oauthFetch: (async (url: string | URL, init?: RequestInit) => {
        const href = url.toString();
        if (href.includes('oauth2.googleapis.com/token')) {
          return jsonResponse(200, {
            access_token: 'access-token-value',
            refresh_token: 'refresh-token-value',
            scope: grantedInstead,
          });
        }
        return successfulProviderFetch()(url as string, init);
      }) as typeof fetch,
    });
    const cookie = await loginWithPassword(baseUrl);
    const state = await beginConsent(baseUrl, cookie);

    const res = await fetch(`${baseUrl}/oauth/callback?state=${state}&code=auth-code-value`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    const grant = await readGrantBySystem(SYSTEM, BUSINESS, key);
    expect(grant?.scopes).toEqual([grantedInstead]);
    expect(grant?.scopes).not.toContain('https://www.googleapis.com/auth/calendar.readonly');
  });

  it('refuses with a readable message, and writes nothing, when the provider returns no refresh token (M11)', async () => {
    const baseUrl = await startServer({
      oauthFetch: (async (url: string | URL, init?: RequestInit) => {
        const href = url.toString();
        if (href.includes('oauth2.googleapis.com/token')) {
          // No `refresh_token` field at all — the exact shape `buildConsentUrl`'s
          // own docblock says a stale, already-approved consent can produce
          // even with `access_type=offline` requested.
          return jsonResponse(200, { access_token: 'access-token-value', scope: 'x' });
        }
        return successfulProviderFetch()(url as string, init);
      }) as typeof fetch,
    });
    const cookie = await loginWithPassword(baseUrl);
    const state = await beginConsent(baseUrl, cookie);

    const res = await fetch(`${baseUrl}/oauth/callback?state=${state}&code=auth-code-value`, {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    expect(await readGrantBySystem(SYSTEM, BUSINESS, key)).toBeNull();
  });

  it('refuses without a session, before even reading the query string (M11)', async () => {
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const res = await fetch(`${baseUrl}/oauth/callback?state=anything&code=anything`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
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

  /**
   * I4 — "still revokes locally even when the provider fails" (below) passes
   * under EITHER ordering: a provider-first implementation that catches the
   * throw and then still calls `revokeGrant` would pass it too. This test
   * pins the order from inside the fake itself: the provider handler reads
   * the row directly and records what it saw AT THE MOMENT it was called.
   */
  it('has already revoked the local row by the time the provider is called (I4)', async () => {
    let revokedAtWhenProviderWasCalled: Date | null | undefined;
    const orderedFetch = (async (url: string | URL, init?: RequestInit) => {
      const href = url.toString();
      if (href.includes('oauth2.googleapis.com/revoke')) {
        const { rows } = await getPool().query<{ revoked_at: Date | null }>(
          'SELECT revoked_at FROM oauth_grants WHERE business_id = $1 AND system = $2',
          [BUSINESS, SYSTEM],
        );
        revokedAtWhenProviderWasCalled = rows[0]?.revoked_at ?? null;
        return new Response('', { status: 200 });
      }
      return successfulProviderFetch()(url as string, init);
    }) as typeof fetch;

    const baseUrl = await startServer({ oauthFetch: orderedFetch });
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
    expect(revokedAtWhenProviderWasCalled).not.toBeNull();
  });

  /**
   * I5 — the audit row must distinguish "nothing was live" from "we could
   * not check because the key would not open". A live grant existed here;
   * the master key file is corrupted just before the revoke request, so the
   * route can neither decrypt the grant nor attempt provider revocation —
   * and the record must say exactly that, never the unrelated "no live
   * grant was found" sentence (which would tell the owner, falsely, that
   * nothing is left to worry about upstream).
   */
  it('records that the key could not be checked, never that no grant existed (I5)', async () => {
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);
    await grantedSystem(baseUrl, cookie);

    // Corrupt the key file (wrong length) so `loadMasterKey` throws on the
    // revoke request specifically, after a perfectly good grant was written.
    await writeFile(keyPath, randomBytes(16));

    const sessionId = sessionIdFromCookie(cookie);
    const res = await fetch(`${baseUrl}/oauth/${SYSTEM}/revoke`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: issueCsrfToken(sessionId) }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);

    // The local revoke does not need the key at all, and must still happen.
    const { rows } = await getPool().query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM oauth_grants WHERE business_id = $1 AND system = $2',
      [BUSINESS, SYSTEM],
    );
    expect(rows[0]?.revoked_at).not.toBeNull();

    const audit = await queryAudit({ businessId: BUSINESS, kind: 'credential_change' });
    const revokeRow = audit.find((row) => row.reason.includes('revoked locally'));
    expect(revokeRow?.reason).toContain('master key');
    expect(revokeRow?.reason).not.toContain('no live grant was found');
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
