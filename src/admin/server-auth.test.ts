import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { resetDatabase } from '../test/db.js';
import { TEST_MASTER_KEY } from '../test/owner.js';
import { currentStep, totpCode } from '../auth/totp.js';
import {
  createHeadStaff,
  inviteStaff,
  removeStaff,
  staffBeginEnrolment,
  staffConfirmEnrolment,
  startStaffSession,
  staffTotpStatus,
} from '../tenancy/staff.js';
import { createAdminServer } from './server.js';

const HEAD_LOGIN = 'head@company.example';
const HEAD_PASSWORD = 'head password long enough';
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'";

let server: Server | null = null;

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

async function startPanel(): Promise<string> {
  server = createAdminServer({
    port: 0,
    masterKey: TEST_MASTER_KEY,
    documentRoot: 'unused-in-these-tests',
    dashboardBaseUrl: 'https://dashboard.example',
  });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function cookieOf(res: Response, name: string): string | undefined {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
}

function csrfIn(html: string): string {
  const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
  if (!match?.[1]) throw new Error('no csrf field on the page');
  return match[1];
}

async function get(baseUrl: string, path: string, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...(cookie !== undefined ? { headers: { cookie } } : {}), redirect: 'manual' });
}

async function post(baseUrl: string, path: string, form: Record<string, string>, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    ...(cookie !== undefined ? { headers: { cookie } } : {}),
    body: new URLSearchParams(form),
    redirect: 'manual',
  });
}

/** Enrol `staffId` through the store, three steps back, so a code typed now is a later step. */
async function enrolInStore(staffId: string): Promise<string> {
  const { secretBase32 } = await staffBeginEnrolment(staffId, TEST_MASTER_KEY);
  const past = new Date(Date.now() - 90_000);
  expect(await staffConfirmEnrolment(staffId, totpCode(secretBase32, currentStep(past)), TEST_MASTER_KEY, past)).toBe(
    'ok',
  );
  return secretBase32;
}

/** A six-digit code outside the accepted window around now. */
function wrongCode(secret: string): string {
  const step = currentStep(new Date());
  const valid = new Set([step - 2, step - 1, step, step + 1, step + 2].map((s) => totpCode(secret, s)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

describe('panel sign-in', () => {
  it('signs a new head in through enrolment, rotating the session, and trusts the device after', async () => {
    const id = await createHeadStaff({ login: HEAD_LOGIN, displayName: 'ראש הצוות', password: HEAD_PASSWORD });
    const baseUrl = await startPanel();

    const login = await post(baseUrl, '/login', { email: 'HEAD@company.example', password: HEAD_PASSWORD });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/2fa/enrol');
    const preFactor = cookieOf(login, 'asid');
    expect(preFactor).toBeDefined();
    const setCookie = login.headers.getSetCookie().find((c) => c.startsWith('asid=')) ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=43200');

    // Owes the factor: everything else sends it to enrolment.
    const home = await get(baseUrl, '/', preFactor);
    expect(home.status).toBe(303);
    expect(home.headers.get('location')).toBe('/2fa/enrol');
    expect((await get(baseUrl, '/2fa', preFactor)).headers.get('location')).toBe('/2fa/enrol');

    const enrolPage = await get(baseUrl, '/2fa/enrol', preFactor);
    expect(enrolPage.status).toBe(200);
    const html = await enrolPage.text();
    const secret = /class="totp-secret">([A-Z2-7 ]+)</.exec(html)?.[1]?.replace(/ /g, '');
    expect(secret).toBeDefined();
    expect(html).toContain('<svg');

    // A wrong csrf is refused before the code is read.
    const forged = await post(baseUrl, '/2fa/enrol', { csrf: '00', code: '000000' }, preFactor);
    expect(forged.status).toBe(403);

    const code = totpCode(secret ?? '', currentStep(new Date()));
    const done = await post(baseUrl, '/2fa/enrol', { csrf: csrfIn(html), code }, preFactor);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/');
    const full = cookieOf(done, 'asid');
    const device = cookieOf(done, 'adev');
    expect(full).toBeDefined();
    expect(full).not.toBe(preFactor);
    const deviceSetCookie = done.headers.getSetCookie().find((c) => c.startsWith('adev=')) ?? '';
    expect(deviceSetCookie).toContain('SameSite=Strict');
    expect(deviceSetCookie).toContain('Max-Age=2592000');
    expect(await staffTotpStatus(id)).toBe('enrolled');

    // The pre-factor token never became a full session.
    expect((await get(baseUrl, '/', preFactor)).headers.get('location')).toBe('/login');

    const panel = await get(baseUrl, '/', full);
    expect(panel.status).toBe(200);
    const body = await panel.text();
    expect(body).toContain('פאנל המנהל');
    expect(body).toContain('עסקים');
    expect(body).toContain('צוות');
    expect(body).toContain('יומן פעולות');
    expect(body).toContain('dir="rtl"');
    // Past the factor, its screens are behind them.
    expect((await get(baseUrl, '/2fa/enrol', full)).headers.get('location')).toBe('/');

    // Logout revokes the session.
    const out = await post(baseUrl, '/logout', { csrf: csrfIn(body) }, full);
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('/login');
    expect((await get(baseUrl, '/', full)).headers.get('location')).toBe('/login');

    // On the trusted device the password alone is a full session.
    const again = await post(baseUrl, '/login', { email: HEAD_LOGIN, password: HEAD_PASSWORD }, device);
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe('/');
    expect((await get(baseUrl, '/', cookieOf(again, 'asid'))).status).toBe(200);
  });

  it('asks an enrolled member for a code on an untrusted device', async () => {
    const id = await createHeadStaff({ login: HEAD_LOGIN, displayName: 'ראש הצוות', password: HEAD_PASSWORD });
    const secret = await enrolInStore(id);
    const baseUrl = await startPanel();

    const login = await post(baseUrl, '/login', { email: HEAD_LOGIN, password: HEAD_PASSWORD });
    expect(login.headers.get('location')).toBe('/2fa');
    const asid = cookieOf(login, 'asid');
    expect((await get(baseUrl, '/2fa/enrol', asid)).headers.get('location')).toBe('/2fa');
    const verifyPage = await get(baseUrl, '/2fa', asid);
    expect(verifyPage.status).toBe(200);
    const csrf = csrfIn(await verifyPage.text());

    const wrong = await post(baseUrl, '/2fa', { csrf, code: wrongCode(secret) }, asid);
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('הקוד שגוי או שפג תוקפו');

    const ok = await post(baseUrl, '/2fa', { csrf, code: totpCode(secret, currentStep(new Date()) + 1) }, asid);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/');
    expect((await get(baseUrl, '/', cookieOf(ok, 'asid'))).status).toBe(200);
  });

  it('refuses a wrong password with a generic Hebrew message', async () => {
    await createHeadStaff({ login: HEAD_LOGIN, displayName: 'ראש הצוות', password: HEAD_PASSWORD });
    const baseUrl = await startPanel();
    const res = await post(baseUrl, '/login', { email: HEAD_LOGIN, password: 'not the password' });
    expect(res.status).toBe(401);
    expect(cookieOf(res, 'asid')).toBeUndefined();
    expect(await res.text()).toContain('כתובת מייל או סיסמה שגויים.');
    const unknown = await post(baseUrl, '/login', { email: 'nobody@x.example', password: 'not the password' });
    expect(unknown.status).toBe(401);
  });

  it('sends a full session of a member who is not enrolled to enrolment', async () => {
    const id = await createHeadStaff({ login: HEAD_LOGIN, displayName: 'ראש הצוות', password: HEAD_PASSWORD });
    const token = await startStaffSession(id, { pendingFactor: null });
    const baseUrl = await startPanel();
    const res = await get(baseUrl, '/', `asid=${token}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/2fa/enrol');
  });

  it("sends a removed member's session to /login", async () => {
    const head = await createHeadStaff({ login: HEAD_LOGIN, displayName: 'ראש הצוות', password: HEAD_PASSWORD });
    const { staffId, token: link } = await inviteStaff({
      login: 'tech@company.example',
      displayName: 'טכנאי',
      issuedBy: head,
    });
    const baseUrl = await startPanel();
    // Joins through the panel's own invite route.
    const joinPage = await get(baseUrl, `/join/${link}`);
    expect(joinPage.status).toBe(200);
    const joined = await post(baseUrl, `/join/${link}`, {
      csrf: csrfIn(await joinPage.text()),
      email: 'TECH@company.example',
      password: 'tech password long',
      confirm: 'tech password long',
    });
    expect(joined.status).toBe(303);
    expect(joined.headers.get('location')).toBe('/2fa/enrol');

    await enrolInStore(staffId);
    const asid = await startStaffSession(staffId, { pendingFactor: null });
    expect((await get(baseUrl, '/', `asid=${asid}`)).status).toBe(200);

    await removeStaff(staffId, { by: head });
    const res = await get(baseUrl, '/', `asid=${asid}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('refuses a join with a mismatched address and leaves the link usable', async () => {
    const head = await createHeadStaff({ login: HEAD_LOGIN, displayName: 'ראש הצוות', password: HEAD_PASSWORD });
    const { token: link } = await inviteStaff({ login: 'tech@company.example', displayName: 'טכנאי', issuedBy: head });
    const baseUrl = await startPanel();
    const csrf = csrfIn(await (await get(baseUrl, `/join/${link}`)).text());
    const wrong = await post(baseUrl, `/join/${link}`, {
      csrf,
      email: 'other@company.example',
      password: 'tech password long',
      confirm: 'tech password long',
    });
    expect(wrong.status).toBe(400);
    expect(cookieOf(wrong, 'asid')).toBeUndefined();
    const ok = await post(baseUrl, `/join/${link}`, {
      csrf,
      email: 'tech@company.example',
      password: 'tech password long',
      confirm: 'tech password long',
    });
    expect(ok.status).toBe(303);
    const reused = await post(baseUrl, `/join/${link}`, {
      csrf,
      email: 'tech@company.example',
      password: 'tech password long',
      confirm: 'tech password long',
    });
    expect(reused.status).toBe(400);
  });

  it('puts the security headers on every response, redirects included', async () => {
    const baseUrl = await startPanel();
    for (const res of [await get(baseUrl, '/login'), await get(baseUrl, '/'), await get(baseUrl, '/nope')]) {
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toBe(CSP);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('panel bind', () => {
  it('refuses 0.0.0.0 without allowNonLoopbackBind', () => {
    expect(() =>
      createAdminServer({
        host: '0.0.0.0',
        port: 0,
        masterKey: TEST_MASTER_KEY,
        documentRoot: 'x',
        dashboardBaseUrl: 'https://dashboard.example',
      }),
    ).toThrow(/ADMIN_ALLOW_PUBLIC_BIND/);
  });
});
