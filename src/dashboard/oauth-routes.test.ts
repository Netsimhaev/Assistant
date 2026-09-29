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
import { installCharter } from '../charter/store.js';
import type { CharterConnection } from '../domain/connection.js';
import { putSecret, removeSecret } from '../governance/credential-store.js';
import { KEY_BYTES, writeKeyState } from '../governance/master-key.js';
import {
  markNeedsReauth,
  readGrantBySystem,
  recordRefresh,
  revokeGrant,
  writeGrant,
} from '../governance/oauth-grants.js';
import {
  GOOGLE_CLIENT_ID_REF,
  GOOGLE_CLIENT_SECRET_REF,
} from '../orchestrator/adapters/google-token-http.js';
import { loadBindings, upsertBinding } from '../orchestrator/bindings.js';
import { closePool, getPool } from '../db/pool.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase } from '../test/db.js';
import { createOwner } from './auth.js';
import { issueCsrfToken } from './csrf.js';
import { createServer } from './server.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
const SYSTEM = 'office-calendar';
const DASHBOARD_BASE_URL = 'http://127.0.0.1:4173';

/**
 * The charter connection that makes `SYSTEM` eligible for the ceremony at
 * all (final fix wave, item 1a): `channel: 'api'` and `serves: ['calendar.
 * read']`, the exact shape `connectionAcceptsOAuthCeremony` requires.
 * Installed by a `beforeEach` in every describe block below that drives
 * `/start`, `/callback` or `/revoke` for `SYSTEM` — before item 1, none of
 * them needed a charter at all, because `handleOAuthStart` validated
 * nothing about `system`.
 */
const CALENDAR_CONNECTION: CharterConnection = {
  system: SYSTEM,
  label: 'יומן המשרד',
  channel: 'api',
  serves: ['calendar.read'],
  target: null,
  subprocessor: null,
};

/** A connection the ceremony must now refuse (final fix wave, item 1a): it serves `mail.send`, not a Google-calendar tool. */
const MAIL_ONLY_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

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
  beforeEach(async () => {
    await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION] }), { businessId: BUSINESS });
  });

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

  /**
   * Final fix wave, item 9. Before this fix, `handleOAuthStart` resolved only
   * `GOOGLE_CLIENT_ID_REF` and walked straight to Google's consent screen
   * once it found a value — an install holding the id but not the secret
   * sailed through this check, and only failed at the token exchange in
   * `handleOAuthCallback`, AFTER `state` was already consumed and burned. The
   * owner would have to start the whole ceremony over having learned nothing
   * they could not have been told up front. Both refs must be checked before
   * any redirect happens.
   */
  it('refuses to start when the client secret is not provisioned, even though the client id is', async () => {
    await removeSecret(GOOGLE_CLIENT_SECRET_REF, BUSINESS);
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);

    const res = await fetch(`${baseUrl}/oauth/${SYSTEM}/start`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain(GOOGLE_CLIENT_SECRET_REF);
    // No state row was written for a ceremony that never actually started —
    // nothing here for a later request to "resume" into a half-configured
    // exchange.
    const { rows } = await getPool().query('SELECT count(*)::text AS n FROM oauth_states');
    expect(rows[0]?.['n']).toBe('0');
  });

  it('refuses to start when the client id is not provisioned, even though the secret is', async () => {
    await removeSecret(GOOGLE_CLIENT_ID_REF, BUSINESS);
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);

    const res = await fetch(`${baseUrl}/oauth/${SYSTEM}/start`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain(GOOGLE_CLIENT_ID_REF);
  });

  /**
   * Final fix wave, item 1 (CRITICAL) — the trace: `renderConnections`
   * computed the row action from `status` alone, so `office-mail` (declared
   * by the seeded charter, never touched by any grant) got the same "לחיבור"
   * link as `office-calendar`; `handleOAuthStart` validated nothing about
   * `system` and walked the owner to Google for ANY path segment; the
   * callback then wrote `provider: 'google'` and a credential ref onto the
   * `office-mail` BINDING (`upsertBinding` is a whole-row replace) that
   * collided byte-for-byte with the static SMTP secret ref — poisoning
   * `mail.send` with `AmbiguousCredentialRefError`, permanently, since
   * revoking the grant does not restore the static secret. This test proves
   * the (a) half of the four-part fix: the ceremony itself refuses.
   */
  it('refuses to start the ceremony on a connection that does not serve a calendar tool (item 1a) — no state, no grant, no binding write', async () => {
    await installCharter(
      buildCharter({
        version: '2026-08-15.2-item1a',
        connections: [CALENDAR_CONNECTION, MAIL_ONLY_CONNECTION],
      }),
      { businessId: BUSINESS },
    );
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);

    const res = await fetch(`${baseUrl}/oauth/office-mail/start`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('office-mail');

    // Nothing happened at all: no state row minted, no grant, no binding
    // write — a refused ceremony must leave exactly the state it found.
    const { rows } = await getPool().query('SELECT count(*)::text AS n FROM oauth_states');
    expect(rows[0]?.['n']).toBe('0');
    expect(await readGrantBySystem('office-mail', BUSINESS, key)).toBeNull();
    const bindings = await loadBindings({ businessId: BUSINESS });
    expect(bindings.find((b) => b.system === 'office-mail')).toBeUndefined();
  });

  /**
   * The eligible system (`office-calendar`) must still work under the exact
   * same charter that just refused the mail one — otherwise the gate could
   * be "fixed" by refusing everything.
   */
  it('still starts the ceremony on a connection that does serve a calendar tool, under the same charter that refuses mail', async () => {
    await installCharter(
      buildCharter({
        version: '2026-08-15.2-item1a-positive',
        connections: [CALENDAR_CONNECTION, MAIL_ONLY_CONNECTION],
      }),
      { businessId: BUSINESS },
    );
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);

    const res = await fetch(`${baseUrl}/oauth/${SYSTEM}/start`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') ?? '').hostname).toBe('accounts.google.com');
  });

  /**
   * Final fix wave, item 1c — the derived ref must be INJECTIVE, not merely
   * deterministic. A system name outside the shape `credentialRefForSystem`
   * can fold reversibly (lowercase letters, digits, hyphen) is refused here,
   * before any state row is minted — not silently mapped into a ref that
   * could collide with another system's.
   */
  it('refuses a system name that cannot be mapped to a credential ref injectively', async () => {
    // `CALENDAR_CONNECTION` is deliberately NOT also declared here: the
    // charter schema itself refuses two connections both serving
    // `calendar.read` for the same (catch-all) target, so this connection
    // alone both satisfies eligibility (channel `api`, serves
    // `calendar.read`) and isolates the SHAPE refusal this test is about.
    await installCharter(
      buildCharter({
        version: '2026-08-15.2-item1c',
        connections: [
          {
            system: 'office.calendar',
            label: 'יומן עם נקודה בשם',
            channel: 'api',
            serves: ['calendar.read'],
            target: null,
            subprocessor: null,
          },
        ],
      }),
      { businessId: BUSINESS },
    );
    const baseUrl = await startServer({ oauthFetch: successfulProviderFetch() });
    const cookie = await loginWithPassword(baseUrl);

    const res = await fetch(`${baseUrl}/oauth/office.calendar/start`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('office.calendar');

    const { rows } = await getPool().query('SELECT count(*)::text AS n FROM oauth_states');
    expect(rows[0]?.['n']).toBe('0');
  });
});

describe('GET /oauth/callback', () => {
  beforeEach(async () => {
    await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION] }), { businessId: BUSINESS });
  });

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
    // `OAUTH_OFFICE_CALENDAR`, not the bare `OFFICE_CALENDAR` this used to be
    // (final fix wave, item 1c) — namespaced so it can never collide with an
    // operator-provisioned secret ref of the same shape.
    expect(binding?.credentialRef).toBe('OAUTH_OFFICE_CALENDAR');

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
  beforeEach(async () => {
    await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION] }), { businessId: BUSINESS });
  });

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

describe('GET /connections', () => {
  // `CALENDAR_CONNECTION` is the file-level constant declared near `SYSTEM`
  // above — reused here rather than redeclared, so this screen's tests and
  // the ceremony's own tests can never drift into asserting against two
  // different connection shapes for the same system.

  /**
   * A real, known, owned tool (`data.export` — `capabilities.ts` gives it an
   * agent) whose prefix this screen's grouping simply has no heading for.
   * The charter schema itself refuses a `serves` entry naming a tool that
   * does not exist at all (`isKnownToolName`, `domain/charter.ts`'s own
   * `superRefine`) or one owned by no agent (`isUnownedToolName`) — so
   * `groupForServes`'s "other" fallback can only ever be exercised by a
   * connection like this one, never by a literally made-up tool name.
   */
  const UNKNOWN_CONNECTION: CharterConnection = {
    system: 'mystery-system',
    label: 'מערכת מסתורית',
    channel: 'api',
    serves: ['data.export'],
    target: null,
    subprocessor: null,
  };

  it('requires a session, like every other route past login', async () => {
    const baseUrl = await startServer();
    const res = await fetch(`${baseUrl}/connections`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('shows a declared connection that was never authorised under its group heading, and never hides an unrecognised one', async () => {
    await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION, UNKNOWN_CONNECTION] }), {
      businessId: BUSINESS,
    });
    const baseUrl = await startServer();
    const cookie = await loginWithPassword(baseUrl);

    const res = await fetch(`${baseUrl}/connections`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();

    // The brief's own three assertions (task-6-brief.md, Step 1): a
    // declared-but-unauthorised connection shows its group heading and says
    // so in words, rather than being indistinguishable from "no such
    // connection exists at all".
    expect(body).toContain('חיבור יומן');
    expect(body).toContain('טרם אושר');

    // A tool family this project has no group for still gets a row, under
    // "אחר" — never silently dropped from the page.
    expect(body).toContain('אחר');
    expect(body).toContain('מערכת מסתורית');
  });

  /**
   * Final fix wave, item 1b. Before this fix the link was computed from
   * `status` alone, so `office-mail` — declared, never authorised — got the
   * identical "לחיבור" link `office-calendar` did, even though the server
   * would have refused the ceremony for it (item 1a). A link the server
   * refuses is a worse experience than no link.
   */
  it('hides the connect link for a connection that does not serve a calendar tool, while showing it for one that does', async () => {
    await installCharter(
      buildCharter({ connections: [CALENDAR_CONNECTION, MAIL_ONLY_CONNECTION] }),
      { businessId: BUSINESS },
    );
    const baseUrl = await startServer();
    const cookie = await loginWithPassword(baseUrl);
    const res = await fetch(`${baseUrl}/connections`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();

    // Positive half: both rows genuinely rendered, under their own labels.
    expect(body).toContain('חיבור יומן');
    expect(body).toContain('תיבת המשרד');

    expect(body).toContain(`/oauth/${SYSTEM}/start`);
    expect(body).not.toContain('/oauth/office-mail/start');
  });

  it("shows an authorised connection's account and granted scopes, offers a revoke control, and never renders the refresh token itself", async () => {
    await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION] }), { businessId: BUSINESS });
    const secretToken = 'super-secret-refresh-token-value-should-never-render';
    await writeGrant(
      {
        businessId: BUSINESS,
        system: SYSTEM,
        provider: 'google',
        credentialRef: 'OFFICE_CALENDAR',
        account: 'owner@example.com',
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        refreshToken: secretToken,
        grantedBy: USERNAME,
      },
      key,
    );

    const baseUrl = await startServer();
    const cookie = await loginWithPassword(baseUrl);
    const res = await fetch(`${baseUrl}/connections`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();

    // The positive half first (superpowers:verification-before-completion,
    // and this project's own "a negative test must prove the thing it tests
    // actually ran"): establish the row actually rendered with the grant's
    // real data before asserting what must be absent from it. An assertion
    // that a token string is missing from a page that never rendered the
    // grant at all would pass for the wrong reason.
    expect(body).toContain('owner@example.com');
    expect(body).toContain('calendar.readonly');
    expect(body).toContain('יש הרשאה');
    expect(body).toContain(`/oauth/${SYSTEM}/revoke`);

    // `listGrants` (the only source this screen reads from) takes no
    // decryption key and cannot return a token even by mistake — this
    // proves nothing else on the page smuggled it in either.
    expect(body).not.toContain(secretToken);
  });

  it('reads a grant needing reauth as "דורש אישור מחדש", and a revoked grant as not yet authorised again', async () => {
    await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION] }), { businessId: BUSINESS });
    await writeGrant(
      {
        businessId: BUSINESS,
        system: SYSTEM,
        provider: 'google',
        credentialRef: 'OFFICE_CALENDAR',
        account: 'owner@example.com',
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        refreshToken: 'refresh-token-value',
        grantedBy: USERNAME,
      },
      key,
    );
    await recordRefresh(SYSTEM, BUSINESS, null, key);
    await markNeedsReauth(SYSTEM, BUSINESS);

    const baseUrl = await startServer();
    const cookie = await loginWithPassword(baseUrl);

    const firstRead = await fetch(`${baseUrl}/connections`, { headers: { cookie } });
    const firstBody = await firstRead.text();
    // Positive half: the authorised row rendered with the account this test
    // actually wrote, before checking which status label it carries.
    expect(firstBody).toContain('owner@example.com');
    expect(firstBody).toContain('דורש אישור מחדש');
    expect(firstBody).not.toContain('יש הרשאה');

    await revokeGrant(SYSTEM, BUSINESS, USERNAME);

    const secondRead = await fetch(`${baseUrl}/connections`, { headers: { cookie } });
    const secondBody = await secondRead.text();
    expect(secondBody).toContain('טרם אושר');
    expect(secondBody).not.toContain('דורש אישור מחדש');
    expect(secondBody).not.toContain('יש הרשאה');
  });

  it('tells the owner the scheduler only reads connections at process startup', async () => {
    await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION] }), { businessId: BUSINESS });
    const baseUrl = await startServer();
    const cookie = await loginWithPassword(baseUrl);
    const res = await fetch(`${baseUrl}/connections`, { headers: { cookie } });
    const body = await res.text();
    // Matches `buildRuntime`'s own docblock and docs/live-thread-runbook.md
    // word for word on the load-bearing fact: a freshly authorised
    // connection has no effect until the scheduler process restarts.
    expect(body).toContain('פעם אחת בלבד, בעת ההפעלה');
  });

  /**
   * Final fix wave, item 5. Before this fix the page said a SINGLE sentence
   * covering both authorising and revoking a connection: both "take effect
   * only after the process restarts". That is true for authorising (the
   * adapter registry is built once) and FALSE for revoking — `revoked_at` is
   * checked on every resolve precisely so a revocation beats an approval the
   * owner gave a moment earlier, and the runbook (§10.3) already tells the
   * operator the very next call fails. This is the one place an owner reads
   * under pressure — cutting off access in an emergency — so the page must
   * say both halves, not the false one.
   */
  it('says authorising needs a restart AND that revoking takes effect immediately, not one sentence covering both', async () => {
    await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION] }), { businessId: BUSINESS });
    const baseUrl = await startServer();
    const cookie = await loginWithPassword(baseUrl);
    const res = await fetch(`${baseUrl}/connections`, { headers: { cookie } });
    const body = await res.text();
    // The authorising half — unchanged from the test above, restated here so
    // this test alone proves BOTH halves without relying on test order.
    expect(body).toContain('פעם אחת בלבד, בעת ההפעלה');
    expect(body).toMatch(/אושר.*יופעל מחדש|restart/);
    // The corrected half: revoking is NOT described the same way.
    expect(body).toMatch(/ביטול.*(מיד|באותו רגע)|revok.*immediat/);
  });

  /**
   * Final fix wave, item 4. `last_ok_at` had zero readers anywhere; `last_error`
   * had exactly one, gated on `binding.status === 'error'` — a status
   * `recordBindingOutcome` guarantees it never writes (its own docblock,
   * `binding-health.test.ts`) and the OAuth consent callback always sets to
   * `'live'`. So `lastError` was written on every failed adapter call and
   * rendered never. Both fields must show up on the page now, unconditionally
   * on `lastError` being non-null.
   */
  it('shows a recorded operational error even though the binding status is still "live", and shows the last successful call', async () => {
    await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION] }), { businessId: BUSINESS });
    await upsertBinding(
      {
        system: SYSTEM,
        status: 'live',
        endpoint: null,
        credentialRef: 'OFFICE_CALENDAR',
        provider: 'google',
        lastOkAt: '2026-09-20T08:00:00.000Z',
        lastError: 'ERROR-SENTINEL — הספק דחה את האסימון (401)',
      },
      { businessId: BUSINESS, by: USERNAME },
    );

    const baseUrl = await startServer();
    const cookie = await loginWithPassword(baseUrl);
    const res = await fetch(`${baseUrl}/connections`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();

    // Positive half: the binding row that carries these two fields actually
    // rendered at all, under its real status label.
    expect(body).toContain('פעיל');
    // The load-bearing assertion for item 4's `last_error` half: the message
    // renders even though `status` is `live`, not `error`.
    expect(body).toContain('ERROR-SENTINEL');
    // And the `last_ok_at` half: some rendering of the timestamp appears —
    // asserted as the ISO string `bindings.ts` produces via `esc`, not
    // reformatted.
    expect(body).toContain('2026-09-20T08:00:00.000Z');
  });

  it('survives a charter it cannot read instead of crashing, and says so', async () => {
    // A fresh row, not an UPDATE of an existing signed one — `charter_versions`
    // is append-only by design (001_spine.sql's own comment: "an amendment is
    // a new row, never an UPDATE"). This simulates a genuinely legacy row
    // signed under a schema version this code no longer understands, the same
    // shape `loadActiveCharter` documents as its one throwing case.
    const legacyVersion = 'legacy-unreadable-1';
    await getPool().query(
      `INSERT INTO charter_versions
         (charter_version, business_id, effective_from, charter, policy_bundle, content_hash, signed_by, signed_at, signature_method)
       VALUES ($1, $2, now(), $3, $4, $5, 'legacy', now(), 'test')`,
      [legacyVersion, BUSINESS, JSON.stringify({ schemaVersion: '0.1' }), JSON.stringify({}), 'a'.repeat(64)],
    );
    await getPool().query(
      `INSERT INTO charter_active (business_id, charter_version, activated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (business_id) DO UPDATE SET charter_version = EXCLUDED.charter_version, activated_at = now()`,
      [BUSINESS, legacyVersion],
    );

    const baseUrl = await startServer();
    const cookie = await loginWithPassword(baseUrl);
    const res = await fetch(`${baseUrl}/connections`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('לא ניתן לקרוא את התקנון');
  });

  it('says plainly that no charter is installed at all, rather than an empty page indistinguishable from "nothing declared"', async () => {
    // No `installCharter` call in this test at all — `charter_active` has no
    // row for this business.
    const baseUrl = await startServer();
    const cookie = await loginWithPassword(baseUrl);
    const res = await fetch(`${baseUrl}/connections`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('לא הותקן עדיין תקנון פעיל');
  });
});
