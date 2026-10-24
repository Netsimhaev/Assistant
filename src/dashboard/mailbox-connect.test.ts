/**
 * Route tests for connecting the business mailbox: the status page, the
 * charter amendment the owner signs, and the OAuth callback that takes the
 * cursor. Real HTTP server, real Postgres, faked provider — the same harness
 * `oauth-routes.test.ts` uses.
 *
 * The order these tests pin: SIGN first (the charter gains the mailbox
 * connection; nothing is bound, so nothing reads or sends through it), THEN
 * the OAuth ceremony, whose callback writes the grant, the binding and the
 * cursor together. Nothing can read mail before the owner signed, because the
 * ceremony refuses to start on a charter without the mailbox connection.
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
import { MAILBOX_SUBPROCESSOR, buildMailboxAmendment } from '../charter/amend-mailbox.js';
import { signCharter } from '../charter/sign.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { closePool, getPool } from '../db/pool.js';
import type { CharterConnection } from '../domain/connection.js';
import { putSecret, removeSecret } from '../governance/credential-store.js';
import { KEY_BYTES, writeKeyState } from '../governance/master-key.js';
import { markNeedsReauth, readGrantBySystem } from '../governance/oauth-grants.js';
import { getCursor } from '../mail/inbox-store.js';
import type { MailProvider } from '../mail/mailbox.js';
import { MailboxCursorError, type MailboxClient } from '../mail/providers/types.js';
import {
  GOOGLE_CLIENT_ID_REF,
  GOOGLE_CLIENT_SECRET_REF,
} from '../orchestrator/adapters/google-token-http.js';
import { loadBindings } from '../orchestrator/bindings.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase } from '../test/db.js';
import { createOwner } from './auth.js';
import { issueCsrfToken } from './csrf.js';
import { createServer } from './server.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

const OFFICE_MAIL: CharterConnection = {
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
  keyDir = await mkdtemp(join(tmpdir(), 'mailbox-connect-'));
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
    await putSecret({ businessId: BUSINESS, ref, value, updatedBy: 'test' }, key);
  }
  await createOwner({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
  await installCharter(buildCharter({ connections: [OFFICE_MAIL] }), { businessId: BUSINESS });
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

interface FakeClientLog {
  calls: { provider: MailProvider; token: string }[];
}

function fakeClientFor(log: FakeClientLog, fail = false): (provider: MailProvider) => MailboxClient {
  return (provider) =>
    ({
      async initialCursor(token: string) {
        log.calls.push({ provider, token });
        if (fail) throw new MailboxCursorError({ failure: 'transient', status: 503, message: 'down' });
        return `cursor-${provider}`;
      },
    }) as unknown as MailboxClient;
}

async function startServer(
  options: { oauthFetch?: typeof fetch; mailboxClientFor?: (p: MailProvider) => MailboxClient } = {},
): Promise<string> {
  server = createServer({
    businessId: BUSINESS,
    port: 0,
    credentialKeyPath: keyPath,
    dashboardBaseUrl: 'http://127.0.0.1:4173',
    ...(options.oauthFetch !== undefined ? { oauthFetch: options.oauthFetch } : {}),
    ...(options.mailboxClientFor !== undefined ? { mailboxClientFor: options.mailboxClientFor } : {}),
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

function csrfFor(cookie: string): string {
  const sessionId = cookie.split('=')[1];
  if (sessionId === undefined) throw new Error('bad cookie');
  return issueCsrfToken(sessionId);
}

async function signForm(
  baseUrl: string,
  cookie: string,
  fields: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}/connections/mailbox/sign`, {
    method: 'POST',
    headers: { cookie },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function microsoftFetch(): typeof fetch {
  return (async (url: string | URL) => {
    const href = url.toString();
    if (href.includes('login.microsoftonline.com') && href.includes('/token')) {
      return jsonResponse(200, {
        access_token: 'ms-access',
        refresh_token: 'ms-refresh',
        expires_in: 3600,
        scope: 'Mail.ReadWrite Mail.Send User.Read offline_access',
      });
    }
    if (href.includes('graph.microsoft.com/v1.0/me')) {
      return jsonResponse(200, { mail: 'owner@contoso.example' });
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  }) as typeof fetch;
}

async function installSignedMailbox(provider: MailProvider): Promise<void> {
  const active = await loadActiveCharter(BUSINESS);
  if (active === null) throw new Error('no charter');
  const amendment = buildMailboxAmendment(active.charter, new Date(), provider);
  await installCharter(signCharter(amendment, { signedByPersonId: USERNAME, method: 'dashboard_click' }), {
    businessId: BUSINESS,
  });
}

describe('GET /connections/mailbox', () => {
  it('requires a session', async () => {
    const baseUrl = await startServer();
    const res = await fetch(`${baseUrl}/connections/mailbox`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('before signing: says not connected and offers Google and Microsoft, each through the sign page', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/connections/mailbox`, { headers: { cookie } })).text();
    expect(html).toContain('לא מחוברת');
    expect(html).toContain('href="/connections/mailbox/sign?provider=google"');
    expect(html).toContain('href="/connections/mailbox/sign?provider=microsoft"');
    // No ceremony can be offered before the owner signed.
    expect(html).not.toContain('/oauth/mailbox/start');
  });

  it('after signing, before the ceremony: offers the connect link for the signed provider only', async () => {
    await installSignedMailbox('microsoft');
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/connections/mailbox`, { headers: { cookie } })).text();
    expect(html).toContain('נחתם');
    expect(html).toContain('href="/oauth/mailbox/start?provider=microsoft"');
    expect(html).not.toContain('provider=google');
  });

  it('after the ceremony: active, with the account; and needs_reauth reads as such', async () => {
    await installSignedMailbox('microsoft');
    const baseUrl = await startServer({ oauthFetch: microsoftFetch(), mailboxClientFor: fakeClientFor({ calls: [] }) });
    const cookie = await login(baseUrl);
    const start = await fetch(`${baseUrl}/oauth/mailbox/start?provider=microsoft`, { headers: { cookie }, redirect: 'manual' });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    expect((await fetch(`${baseUrl}/oauth/callback?state=${state}&code=c`, { headers: { cookie } })).status).toBe(200);

    let html = await (await fetch(`${baseUrl}/connections/mailbox`, { headers: { cookie } })).text();
    expect(html).toContain('פעילה');
    expect(html).toContain('owner@contoso.example');

    await markNeedsReauth('mailbox', BUSINESS);
    html = await (await fetch(`${baseUrl}/connections/mailbox`, { headers: { cookie } })).text();
    expect(html).toContain('דורשת אישור מחדש');
    expect(html).toContain('href="/oauth/mailbox/start?provider=microsoft"');
  });
});

describe('GET /connections/mailbox/sign', () => {
  it('states what signing authorises, what it removes, and that the scheduler must restart', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/connections/mailbox/sign?provider=google`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('העוזרת תקרא כל מייל שנכנס לתיבה מרגע החיבור');
    expect(html).toContain('היא לא תמחק, לא תעביר, לא תסמן כנקרא ולא תסמן כספאם');
    expect(html).toContain('מייל יוצא — כולל תשובות להוראות שלך — יישלח מתיבת העסק במקום משרת השליחה');
    // Not an unconditional "only after your approval": under the `learn`
    // freedom level an earned reply can send without a card, and the page
    // says so rather than promising what the code does not hold.
    expect(html).toContain('אלא אם הגדרת ברמת החופש שהעוזרת רשאית לענות לבד');
    expect(html).toContain('תיבת המשרד'); // the connection that is dropped, by its signed label
    expect(html).toContain('Google');
    expect(html).toContain('יופעל מחדש');
    expect(html).toContain('name="csrf"');
    expect(html).toContain('name="provider" value="google"');
  });

  it('refuses an unknown provider', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/connections/mailbox/sign?provider=yahoo`, { headers: { cookie } });
    expect(res.status).toBe(400);
  });
});

describe('POST /connections/mailbox/sign', () => {
  it('POST /connections/mailbox/sign installs a charter whose active version serves mail.send only via mailbox', async () => {
    const before = await loadActiveCharter(BUSINESS);
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await signForm(baseUrl, cookie, {
      csrf: csrfFor(cookie),
      provider: 'google',
      base: before?.charter.charterVersion ?? '',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/connections/mailbox');

    const active = await loadActiveCharter(BUSINESS);
    expect(active?.charter.supersedes).toBe(before?.charter.charterVersion);
    expect(active?.charter.signature.signedByPersonId).toBe(USERNAME);
    expect(active?.charter.signature.method).toBe('dashboard_click');
    const servingSend = active?.charter.connections.filter((c) => c.serves.includes('mail.send')) ?? [];
    expect(servingSend.map((c) => c.system)).toEqual(['mailbox']);
    expect(servingSend[0]?.subprocessor).toBe(MAILBOX_SUBPROCESSOR.google);
    expect(active?.charter.connections.some((c) => c.system === 'office-mail')).toBe(false);

    // Signing binds nothing: no grant, no binding, no cursor — nothing reads
    // or sends through the mailbox until the ceremony completes.
    expect((await loadBindings({ businessId: BUSINESS })).some((b) => b.system === 'mailbox')).toBe(false);
    expect(await getCursor({ businessId: BUSINESS })).toBeNull();

    const audit = await queryAudit({ businessId: BUSINESS, kind: 'charter_change' });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.charterVersion).toBe(active?.charter.charterVersion);
  });

  it('refuses without a valid CSRF token and installs nothing', async () => {
    const before = await loadActiveCharter(BUSINESS);
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await signForm(baseUrl, cookie, {
      csrf: 'forged',
      provider: 'google',
      base: before?.charter.charterVersion ?? '',
    });
    expect(res.status).toBe(403);
    expect((await loadActiveCharter(BUSINESS))?.charter.charterVersion).toBe(before?.charter.charterVersion);
  });

  it('refuses when the active charter changed since the page was shown, and installs nothing', async () => {
    const before = await loadActiveCharter(BUSINESS);
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await signForm(baseUrl, cookie, { csrf: csrfFor(cookie), provider: 'google', base: 'some-older-version' });
    expect(res.status).toBe(409);
    expect((await loadActiveCharter(BUSINESS))?.charter.charterVersion).toBe(before?.charter.charterVersion);
  });

  it('refuses a second mailbox and installs nothing', async () => {
    await installSignedMailbox('google');
    const before = await loadActiveCharter(BUSINESS);
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await signForm(baseUrl, cookie, {
      csrf: csrfFor(cookie),
      provider: 'microsoft',
      base: before?.charter.charterVersion ?? '',
    });
    expect(res.status).toBe(409);
    expect((await loadActiveCharter(BUSINESS))?.charter.charterVersion).toBe(before?.charter.charterVersion);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM charter_versions WHERE business_id = $1', [BUSINESS]);
    expect(rows[0]?.['n']).toBe(2);
  });
});

describe('the OAuth ceremony for the signed mailbox', () => {
  it('refuses to start before the owner signed the amendment', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/oauth/mailbox/start?provider=google`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('refuses a provider other than the one the owner signed for', async () => {
    await installSignedMailbox('google');
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/oauth/mailbox/start?provider=microsoft`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(400);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM oauth_states');
    expect(rows[0]?.['n']).toBe(0);
  });

  it('the callback takes the cursor with the fresh access token and binds the mailbox live', async () => {
    await installSignedMailbox('microsoft');
    const log: FakeClientLog = { calls: [] };
    const baseUrl = await startServer({ oauthFetch: microsoftFetch(), mailboxClientFor: fakeClientFor(log) });
    const cookie = await login(baseUrl);
    const start = await fetch(`${baseUrl}/oauth/mailbox/start?provider=microsoft`, { headers: { cookie }, redirect: 'manual' });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const before = Date.now();
    const res = await fetch(`${baseUrl}/oauth/callback?state=${state}&code=c`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/connections/mailbox"');

    expect(log.calls).toEqual([{ provider: 'microsoft', token: 'ms-access' }]);
    const cursor = await getCursor({ businessId: BUSINESS });
    expect(cursor?.provider).toBe('microsoft');
    expect(cursor?.cursor).toBe('cursor-microsoft');
    expect(Date.parse(cursor?.connectedAt ?? '')).toBeGreaterThanOrEqual(before - 1000);

    const binding = (await loadBindings({ businessId: BUSINESS })).find((b) => b.system === 'mailbox');
    expect(binding).toEqual({
      system: 'mailbox',
      status: 'live',
      endpoint: null,
      credentialRef: 'OAUTH_MAILBOX',
      provider: 'microsoft',
      lastOkAt: null,
      lastError: null,
    });
  });

  it('writes nothing — no grant, no binding, no cursor — when the cursor cannot be taken', async () => {
    await installSignedMailbox('microsoft');
    const baseUrl = await startServer({ oauthFetch: microsoftFetch(), mailboxClientFor: fakeClientFor({ calls: [] }, true) });
    const cookie = await login(baseUrl);
    const start = await fetch(`${baseUrl}/oauth/mailbox/start?provider=microsoft`, { headers: { cookie }, redirect: 'manual' });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const res = await fetch(`${baseUrl}/oauth/callback?state=${state}&code=c`, { headers: { cookie } });
    expect(res.status).toBe(502);
    expect(await readGrantBySystem('mailbox', BUSINESS, key)).toBeNull();
    expect((await loadBindings({ businessId: BUSINESS })).some((b) => b.system === 'mailbox')).toBe(false);
    expect(await getCursor({ businessId: BUSINESS })).toBeNull();
  });
});

describe('GET /connections links to the mailbox page', () => {
  it('offers the mailbox page when no mailbox is declared', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/connections`, { headers: { cookie } })).text();
    expect(html).toContain('href="/connections/mailbox"');
  });

  it("the mailbox row's connect link goes to the mailbox page, never to a provider-less /oauth start", async () => {
    await installSignedMailbox('google');
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/connections`, { headers: { cookie } })).text();
    expect(html).toContain('href="/connections/mailbox"');
    expect(html).not.toContain('href="/oauth/mailbox/start"');
  });
});

/** Microsoft fetch whose account carries a bidi override (U+202E). */
function microsoftFetchWithAccount(account: string): typeof fetch {
  return (async (url: string | URL) => {
    const href = url.toString();
    if (href.includes('login.microsoftonline.com') && href.includes('/token')) {
      return jsonResponse(200, { access_token: 'ms-access', refresh_token: 'ms-refresh', expires_in: 3600, scope: 'Mail.Send' });
    }
    if (href.includes('graph.microsoft.com/v1.0/me')) return jsonResponse(200, { mail: account });
    throw new Error(`unexpected fetch in test: ${href}`);
  }) as typeof fetch;
}

async function completeCeremony(baseUrl: string, cookie: string): Promise<Response> {
  const start = await fetch(`${baseUrl}/oauth/mailbox/start?provider=microsoft`, { headers: { cookie }, redirect: 'manual' });
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
  return fetch(`${baseUrl}/oauth/callback?state=${state}&code=c`, { headers: { cookie } });
}

async function activeVersion(): Promise<string | undefined> {
  return (await loadActiveCharter(BUSINESS))?.charter.charterVersion;
}

describe('fix round 1: preflight before signing', () => {
  it('refuses the sign page and the sign POST when the provider client secret is missing, and installs nothing', async () => {
    await removeSecret('MICROSOFT_OAUTH_CLIENT_SECRET', BUSINESS);
    const before = await activeVersion();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const page = await fetch(`${baseUrl}/connections/mailbox/sign?provider=microsoft`, { headers: { cookie } });
    expect(page.status).toBe(409);
    expect(await page.text()).toContain('MICROSOFT_OAUTH_CLIENT_SECRET');
    const res = await signForm(baseUrl, cookie, { csrf: csrfFor(cookie), provider: 'microsoft', base: before ?? '' });
    expect(res.status).toBe(409);
    expect(await activeVersion()).toBe(before);
  });

  it('refuses when the credential key cannot be loaded', async () => {
    await rm(keyPath, { force: true });
    const before = await activeVersion();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await signForm(baseUrl, cookie, { csrf: csrfFor(cookie), provider: 'google', base: before ?? '' });
    expect(res.status).toBe(409);
    expect(await activeVersion()).toBe(before);
  });

  it('the sign page says the revert button returns sending to the previous server', async () => {
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const html = await (await fetch(`${baseUrl}/connections/mailbox/sign?provider=google`, { headers: { cookie } })).text();
    expect(html).toContain('„בטל את חיבור התיבה” במסך תיבת המייל מחזיר את השליחה לשרת השליחה הקודם');
  });
});

describe('fix round 1: the way back', () => {
  it('revert restores office-mail serving mail.send, as a new signed version with an audit row', async () => {
    const original = await loadActiveCharter(BUSINESS);
    await installSignedMailbox('microsoft');
    const signedVersion = await activeVersion();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);

    const status = await (await fetch(`${baseUrl}/connections/mailbox`, { headers: { cookie } })).text();
    expect(status).toContain('action="/connections/mailbox/revert"');

    const res = await fetch(`${baseUrl}/connections/mailbox/revert`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: csrfFor(cookie), base: signedVersion ?? '' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);

    const active = await loadActiveCharter(BUSINESS);
    expect(active?.charter.charterVersion).not.toBe(signedVersion);
    expect(active?.charter.charterVersion).not.toBe(original?.charter.charterVersion);
    expect(active?.charter.supersedes).toBe(signedVersion);
    expect(active?.charter.signature.signedByPersonId).toBe(USERNAME);
    expect(active?.charter.connections).toEqual(original?.charter.connections);
    expect(active?.charter.connections.find((c) => c.system === 'office-mail')?.serves).toEqual(['mail.send']);
    expect(active?.charter.data.subprocessorsAllowed).toEqual(original?.charter.data.subprocessorsAllowed);
    const audit = await queryAudit({ businessId: BUSINESS, kind: 'charter_change' });
    expect(audit.map((a) => a.charterVersion)).toContain(active?.charter.charterVersion);
  });

  it('revert is refused while the mailbox binding is live, and the page does not offer it', async () => {
    await installSignedMailbox('microsoft');
    const baseUrl = await startServer({ oauthFetch: microsoftFetch(), mailboxClientFor: fakeClientFor({ calls: [] }) });
    const cookie = await login(baseUrl);
    expect((await completeCeremony(baseUrl, cookie)).status).toBe(200);
    const before = await activeVersion();

    const status = await (await fetch(`${baseUrl}/connections/mailbox`, { headers: { cookie } })).text();
    expect(status).not.toContain('/connections/mailbox/revert');

    const res = await fetch(`${baseUrl}/connections/mailbox/revert`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: csrfFor(cookie), base: before ?? '' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(409);
    expect(await activeVersion()).toBe(before);
  });

  it('revert is offered again once the grant needs reauth, and the page says unread mail will not be read', async () => {
    await installSignedMailbox('microsoft');
    const baseUrl = await startServer({ oauthFetch: microsoftFetch(), mailboxClientFor: fakeClientFor({ calls: [] }) });
    const cookie = await login(baseUrl);
    expect((await completeCeremony(baseUrl, cookie)).status).toBe(200);
    await markNeedsReauth('mailbox', BUSINESS);
    const status = await (await fetch(`${baseUrl}/connections/mailbox`, { headers: { cookie } })).text();
    expect(status).toContain('action="/connections/mailbox/revert"');
    expect(status).toContain('מיילים שיגיעו עד שהתיבה תחובר מחדש לא ייקראו.');
  });

  it('revert is refused when the active charter has no mailbox', async () => {
    const before = await activeVersion();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/connections/mailbox/revert`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: csrfFor(cookie), base: before ?? '' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(409);
    expect(await activeVersion()).toBe(before);
  });

  it('revert refuses without a valid CSRF token', async () => {
    await installSignedMailbox('microsoft');
    const before = await activeVersion();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/connections/mailbox/revert`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: 'forged', base: before ?? '' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(await activeVersion()).toBe(before);
  });
});

/**
 * An install that lands AFTER the POST passed its pre-transaction checks.
 * The test holds the `charter_active` row locked, sends the POST (which then
 * waits on its own `FOR UPDATE`), moves the active pointer to another
 * version and commits. Only a check made under the lock sees the move.
 */
async function raceInstallAgainst(post: () => Promise<Response>): Promise<{ res: Response; other: string }> {
  const otherCharter = buildCharter({ version: 'concurrent-other', connections: [OFFICE_MAIL] });
  await installCharter(otherCharter, { businessId: BUSINESS, activate: false });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT charter_version FROM charter_active WHERE business_id = $1 FOR UPDATE', [BUSINESS]);
    const pending = post();
    // Wait until the POST is blocked on the row lock.
    for (let i = 0; i < 200; i += 1) {
      const { rows } = await getPool().query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
      );
      if ((rows[0]?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await client.query('UPDATE charter_active SET charter_version = $2 WHERE business_id = $1', [
      BUSINESS,
      otherCharter.charterVersion,
    ]);
    await client.query('COMMIT');
    return { res: await pending, other: otherCharter.charterVersion };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('fix round 1: the stale check holds under a concurrent install', () => {
  it('sign: an install that lands between the page and the POST is not superseded', async () => {
    const base = await activeVersion();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const { res, other } = await raceInstallAgainst(() =>
      signForm(baseUrl, cookie, { csrf: csrfFor(cookie), provider: 'google', base: base ?? '' }),
    );
    expect(res.status).toBe(409);
    expect(await activeVersion()).toBe(other);
  });

  it('revert: an install that lands between the page and the POST is not superseded', async () => {
    await installSignedMailbox('microsoft');
    const base = await activeVersion();
    const baseUrl = await startServer();
    const cookie = await login(baseUrl);
    const { res, other } = await raceInstallAgainst(() =>
      fetch(`${baseUrl}/connections/mailbox/revert`, {
        method: 'POST',
        headers: { cookie },
        body: new URLSearchParams({ csrf: csrfFor(cookie), base: base ?? '' }),
        redirect: 'manual',
      }),
    );
    expect(res.status).toBe(409);
    expect(await activeVersion()).toBe(other);
  });
});

describe('fix round 1: callback', () => {
  it('re-checks the signed provider at callback time; a mismatch writes nothing', async () => {
    await installSignedMailbox('microsoft');
    const baseUrl = await startServer({ oauthFetch: microsoftFetch(), mailboxClientFor: fakeClientFor({ calls: [] }) });
    const cookie = await login(baseUrl);
    const start = await fetch(`${baseUrl}/oauth/mailbox/start?provider=microsoft`, { headers: { cookie }, redirect: 'manual' });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');

    // Between start and callback the charter is re-signed for Google.
    const base = buildCharter({ version: 'rebase', connections: [OFFICE_MAIL] });
    await installCharter(base, { businessId: BUSINESS });
    await installCharter(
      signCharter(buildMailboxAmendment(base, new Date(), 'google'), { signedByPersonId: USERNAME, method: 'dashboard_click' }),
      { businessId: BUSINESS },
    );

    const res = await fetch(`${baseUrl}/oauth/callback?state=${state}&code=c`, { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(await readGrantBySystem('mailbox', BUSINESS, key)).toBeNull();
    expect((await loadBindings({ businessId: BUSINESS })).some((b) => b.system === 'mailbox')).toBe(false);
    expect(await getCursor({ businessId: BUSINESS })).toBeNull();
  });

  it('renders the provider-sourced account through escLabel (no bidi override reaches the page)', async () => {
    await installSignedMailbox('microsoft');
    const baseUrl = await startServer({
      oauthFetch: microsoftFetchWithAccount('owner\u202E@evil.example'),
      mailboxClientFor: fakeClientFor({ calls: [] }),
    });
    const cookie = await login(baseUrl);
    const res = await completeCeremony(baseUrl, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('owner@evil.example');
    expect(html).not.toContain('\u202E');
  });
});
