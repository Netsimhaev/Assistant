import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { currentStep, totpCode } from '../auth/totp.js';
import { issueCsrfToken } from './csrf.js';
import { sessionCookieValue, setPassword, startSession } from './auth.js';
import { MAX_FAILED } from './auth.js';
import { totpStatus } from './second-factor.js';
import {
  createTestOwner,
  enrolTestOwner,
  loginWithSecondFactor,
  ownerLogin,
  TEST_MASTER_KEY,
  trustedDeviceCookie,
} from '../test/owner.js';
import { issueOwnerLink } from './owner-links.js';
import { createServer } from './server.js';
import { renderLogin } from './views.js';

const BUSINESS = 'test-business';
const OTHER = 'test-business-other';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

const ENROL_COPY = 'סרוק את הקוד באפליקציית Google Authenticator והקלד את הקוד בן שש הספרות שמופיע בה.';
const BAD_CODE_COPY = 'הקוד שגוי או שפג תוקפו. נסה שוב עם הקוד שמופיע עכשיו באפליקציה.';
const LOCKED_COPY = 'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.';

let server: Server | null = null;

beforeEach(async () => {
  await resetDatabase();
  await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({ version: 'gate-charter' })));
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

async function startServer(): Promise<string> {
  server = createServer({ port: 0, masterKey: TEST_MASTER_KEY });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function postLogin(baseUrl: string, cookie?: string, email = ownerLogin(BUSINESS, USERNAME)): Promise<Response> {
  return fetch(`${baseUrl}/login`, {
    method: 'POST',
    ...(cookie !== undefined ? { headers: { cookie } } : {}),
    body: new URLSearchParams({ email, password: PASSWORD }),
    redirect: 'manual',
  });
}

function sidOf(res: Response): string {
  const pair = res.headers.getSetCookie().find((c) => c.startsWith('sid='))?.split(';')[0];
  if (!pair) throw new Error('no sid cookie');
  return pair;
}

function csrfFor(sid: string): string {
  return issueCsrfToken(sid.slice('sid='.length));
}

async function get(baseUrl: string, path: string, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: 'manual' });
}

async function post(baseUrl: string, path: string, cookie: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { cookie },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

/** The secret as the enrolment page shows it, groups of four joined back. */
function secretFrom(html: string): string {
  const match = /<code class="totp-secret">([A-Z2-7 ]+)<\/code>/.exec(html);
  if (!match?.[1]) throw new Error(`no secret on the enrolment page: ${html.slice(0, 300)}`);
  return match[1].replace(/ /g, '');
}

function nowCode(secret: string): string {
  return totpCode(secret, currentStep(new Date()));
}

describe('first login: enrolment', () => {
  it('sends a not-enrolled owner to enrolment, holds every page there, and lets them in after a valid code', async () => {
    const baseUrl = await startServer();
    const login = await postLogin(baseUrl);
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/2fa/enrol');
    const sid = sidOf(login);

    for (const path of ['/', '/instruct', '/password', '/2fa']) {
      const res = await get(baseUrl, path, sid);
      expect(res.status, path).toBe(303);
      expect(res.headers.get('location'), path).toBe('/2fa/enrol');
    }

    const page = await get(baseUrl, '/2fa/enrol', sid);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(ENROL_COPY);
    expect(html).toContain('<svg');
    expect(html).toMatch(/<code class="totp-secret">[A-Z2-7]{4}( [A-Z2-7]{4}){7}<\/code>/);
    const secret = secretFrom(html);

    const wrong = await post(baseUrl, '/2fa/enrol', sid, { csrf: csrfFor(sid), code: '000000' === nowCode(secret) ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain(BAD_CODE_COPY);

    const done = await post(baseUrl, '/2fa/enrol', sid, { csrf: csrfFor(sid), code: nowCode(secret) });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/');
    const tdev = done.headers.getSetCookie().find((c) => c.startsWith('tdev='));
    expect(tdev).toBeDefined();
    expect(tdev).toMatch(new RegExp(`^tdev=${BUSINESS}\\.[0-9a-f]{64}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000$`));

    // A fresh session token replaces the pre-factor one (no fixation).
    const full = sidOf(done);
    expect(full).not.toBe(sid);
    expect((await get(baseUrl, '/', sid)).headers.get('location')).toBe('/login');
    expect((await get(baseUrl, '/', full)).status).toBe(200);
    // Fully signed in, the factor screens are behind it.
    expect((await get(baseUrl, '/2fa/enrol', full)).headers.get('location')).toBe('/');
    expect(await withBusiness(BUSINESS, (db) => totpStatus(db, USERNAME))).toBe('enrolled');
  });

  it('refuses an enrolment post without a valid CSRF token', async () => {
    const baseUrl = await startServer();
    const sid = sidOf(await postLogin(baseUrl));
    const secret = secretFrom(await (await get(baseUrl, '/2fa/enrol', sid)).text());
    const res = await post(baseUrl, '/2fa/enrol', sid, { csrf: 'nope', code: nowCode(secret) });
    expect(res.status).toBe(403);
    expect(await withBusiness(BUSINESS, (db) => totpStatus(db, USERNAME))).toBe('not_enrolled');
  });

  it('lets a gated session sign out', async () => {
    const baseUrl = await startServer();
    const sid = sidOf(await postLogin(baseUrl));
    const res = await post(baseUrl, '/logout', sid, { csrf: csrfFor(sid) });
    expect(res.headers.get('location')).toBe('/login');
    expect((await get(baseUrl, '/', sid)).headers.get('location')).toBe('/login');
  });
});

describe('a later login', () => {
  it('on a trusted device goes straight in', async () => {
    const baseUrl = await startServer();
    await enrolTestOwner(BUSINESS, USERNAME);
    const login = await postLogin(baseUrl, await trustedDeviceCookie(BUSINESS, USERNAME));
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/');
    expect((await get(baseUrl, '/', sidOf(login))).status).toBe(200);
  });

  it('without a trusted device owes a code, and a valid one lets it in and trusts the device', async () => {
    const baseUrl = await startServer();
    const secret = await enrolTestOwner(BUSINESS, USERNAME);
    if (secret === null) throw new Error('expected a fresh enrolment');
    const login = await postLogin(baseUrl);
    expect(login.headers.get('location')).toBe('/2fa');
    const sid = sidOf(login);

    expect((await get(baseUrl, '/', sid)).headers.get('location')).toBe('/2fa');
    // An enrolled owner is never offered a fresh secret.
    expect((await get(baseUrl, '/2fa/enrol', sid)).headers.get('location')).toBe('/2fa');
    const page = await get(baseUrl, '/2fa', sid);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain('totp-secret');

    const ok = await post(baseUrl, '/2fa', sid, { csrf: csrfFor(sid), code: nowCode(secret) });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/');
    expect(ok.headers.getSetCookie().some((c) => c.startsWith('tdev='))).toBe(true);
    // The pre-factor token is revoked; the fresh one is the full session.
    const full = sidOf(ok);
    expect(full).not.toBe(sid);
    expect((await get(baseUrl, '/', sid)).headers.get('location')).toBe('/login');
    expect((await get(baseUrl, '/', full)).status).toBe(200);
  });

  it('ignores a trusted-device cookie of another business, or a revoked one', async () => {
    const baseUrl = await startServer();
    await createTestOwner(OTHER, { username: USERNAME, password: PASSWORD });
    await enrolTestOwner(BUSINESS, USERNAME);
    await enrolTestOwner(OTHER, USERNAME);

    const foreign = await trustedDeviceCookie(OTHER, USERNAME);
    expect((await postLogin(baseUrl, foreign)).headers.get('location')).toBe('/2fa');

    const mine = await trustedDeviceCookie(BUSINESS, USERNAME);
    await withBusiness(BUSINESS, (db) => setPassword(db, { username: USERNAME, password: 'a brand new password' }));
    const after = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { cookie: mine },
      body: new URLSearchParams({ email: ownerLogin(BUSINESS, USERNAME), password: 'a brand new password' }),
      redirect: 'manual',
    });
    expect(after.headers.get('location')).toBe('/2fa');
  });

  it('a malformed trusted-device cookie is just no device', async () => {
    const baseUrl = await startServer();
    await enrolTestOwner(BUSINESS, USERNAME);
    for (const cookie of ['tdev=garbage', 'tdev=%zz', `tdev=${sessionCookieValue(BUSINESS, '')}`]) {
      expect((await postLogin(baseUrl, cookie)).headers.get('location'), cookie).toBe('/2fa');
    }
  });

  it('shows the bad-code message, then the lock message', async () => {
    const baseUrl = await startServer();
    const secret = await enrolTestOwner(BUSINESS, USERNAME);
    if (secret === null) throw new Error('expected a fresh enrolment');
    const sid = sidOf(await postLogin(baseUrl));
    const wrong = nowCode(secret) === '000000' ? '111111' : '000000';
    for (let i = 0; i < MAX_FAILED; i += 1) {
      const res = await post(baseUrl, '/2fa', sid, { csrf: csrfFor(sid), code: wrong });
      expect(res.status).toBe(401);
      expect(await res.text()).toContain(BAD_CODE_COPY);
    }
    const locked = await post(baseUrl, '/2fa', sid, { csrf: csrfFor(sid), code: nowCode(secret) });
    expect(locked.status).toBe(401);
    expect(await locked.text()).toContain(LOCKED_COPY);
    expect((await get(baseUrl, '/', sid)).headers.get('location')).toBe('/2fa');
  });
});

describe('a session from before the deploy', () => {
  it('with no pending factor, for an owner who never enrolled, is sent to enrolment', async () => {
    const baseUrl = await startServer();
    const token = await withBusiness(BUSINESS, (db) => startSession(db, USERNAME, { pendingFactor: null }));
    const { rows } = await testDb().query<{ pending_factor: string | null }>(
      `SELECT pending_factor FROM dashboard_sessions WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows[0]?.pending_factor).toBeNull();
    const sid = `sid=${sessionCookieValue(BUSINESS, token)}`;
    for (const path of ['/', '/instruct', '/memory', '/password']) {
      const res = await get(baseUrl, path, sid);
      expect(res.status, path).toBe(303);
      expect(res.headers.get('location'), path).toBe('/2fa/enrol');
    }
  });
});

describe('recovery codes are gone', () => {
  it('a code with no password is the generic login failure', async () => {
    const baseUrl = await startServer();
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      body: new URLSearchParams({ email: ownerLogin(BUSINESS, USERNAME), code: 'anything' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('שם משתמש או סיסמה שגויים.');
  });

  it('the login form has no recovery code', () => {
    expect(renderLogin()).not.toContain('קוד שחזור');
  });
});

describe('replay', () => {
  it('the code just used on /2fa is refused from another browser', async () => {
    const baseUrl = await startServer();
    const secret = await enrolTestOwner(BUSINESS, USERNAME);
    if (secret === null) throw new Error('expected a fresh enrolment');
    const code = nowCode(secret);

    const first = sidOf(await postLogin(baseUrl));
    expect((await post(baseUrl, '/2fa', first, { csrf: csrfFor(first), code })).headers.get('location')).toBe('/');

    const second = sidOf(await postLogin(baseUrl));
    const replay = await post(baseUrl, '/2fa', second, { csrf: csrfFor(second), code });
    expect(replay.status).toBe(401);
    expect(await replay.text()).toContain(BAD_CODE_COPY);
    expect((await get(baseUrl, '/', second)).headers.get('location')).toBe('/2fa');
  });
});

describe('the test helper', () => {
  it('loginWithSecondFactor yields a full session through the real gate', async () => {
    const baseUrl = await startServer();
    const sid = await loginWithSecondFactor(baseUrl, BUSINESS, { username: USERNAME, password: PASSWORD });
    expect((await get(baseUrl, '/', sid)).status).toBe(200);
  });
});

describe('a trusted device is per account', () => {
  it('the first owner device does not let a second owner of the same business skip the code', async () => {
    const baseUrl = await startServer();
    const SECOND = 'second';
    await createTestOwner(BUSINESS, { username: SECOND, password: PASSWORD });
    await enrolTestOwner(BUSINESS, USERNAME);
    await enrolTestOwner(BUSINESS, SECOND);
    const deviceOfFirst = await trustedDeviceCookie(BUSINESS, USERNAME);
    const res = await postLogin(baseUrl, deviceOfFirst, ownerLogin(BUSINESS, SECOND));
    expect(res.headers.get('location')).toBe('/2fa');
    // The same cookie still serves its own account.
    expect((await postLogin(baseUrl, deviceOfFirst)).headers.get('location')).toBe('/');
  });
});

describe('invite and reset links', () => {
  const INVITED = 'dana@shop.example';
  const NEW_PASSWORD = 'a fresh strong password';
  const INVALID_COPY = 'הקישור אינו תקף. בקש קישור חדש מאיש התמיכה.';
  const MISMATCH_COPY = 'כתובת המייל אינה תואמת את הקישור.';

  async function issue(kind: 'invite' | 'password_reset', loginAddress: string): Promise<string> {
    return withBusiness(BUSINESS, (db) => issueOwnerLink(db, { kind, login: loginAddress, issuedBy: 'staff-1' }));
  }

  function csrfOnPage(html: string): string {
    const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
    if (!match?.[1]) throw new Error(`no csrf on the link page: ${html.slice(0, 300)}`);
    return match[1];
  }

  async function submit(baseUrl: string, path: string, fields: Record<string, string>): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual' });
  }

  beforeEach(async () => {
    // The invitee's business has no owner yet.
    await testDb().query('DELETE FROM dashboard_users WHERE business_id = $1', [BUSINESS]);
  });

  it('a full invite creates the owner and sends the new session to enrolment', async () => {
    const baseUrl = await startServer();
    const token = await issue('invite', INVITED);
    const page = await fetch(`${baseUrl}/invite/${token}`, { redirect: 'manual' });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('name="confirm"');

    const res = await submit(baseUrl, `/invite/${token}`, {
      csrf: csrfOnPage(html),
      email: 'Dana@Shop.Example',
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/2fa/enrol');
    const sid = sidOf(res);
    expect(sid.startsWith(`sid=${BUSINESS}.`)).toBe(true);
    expect((await get(baseUrl, '/', sid)).headers.get('location')).toBe('/2fa/enrol');
    expect((await get(baseUrl, '/2fa/enrol', sid)).status).toBe(200);

    // One time only.
    const again = await fetch(`${baseUrl}/invite/${token}`, { redirect: 'manual' });
    expect(await again.text()).toContain(INVALID_COPY);
  });

  it('a different email is refused in Hebrew and the link still works', async () => {
    const baseUrl = await startServer();
    const token = await issue('invite', INVITED);
    const csrf = csrfOnPage(await (await fetch(`${baseUrl}/invite/${token}`)).text());
    const wrong = await submit(baseUrl, `/invite/${token}`, {
      csrf,
      email: 'someone@else.example',
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.headers.getSetCookie()).toHaveLength(0);
    expect(await wrong.text()).toContain(MISMATCH_COPY);
    const right = await submit(baseUrl, `/invite/${token}`, {
      csrf,
      email: INVITED,
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(right.headers.get('location')).toBe('/2fa/enrol');
  });

  it('refuses a post without the link-bound CSRF token, and consumes nothing', async () => {
    const baseUrl = await startServer();
    const token = await issue('invite', INVITED);
    const res = await submit(baseUrl, `/invite/${token}`, {
      csrf: 'nope',
      email: INVITED,
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(res.status).toBe(403);
    const other = await issue('invite', 'x@y.example');
    const csrfOfOther = csrfOnPage(await (await fetch(`${baseUrl}/invite/${other}`)).text());
    const crossed = await submit(baseUrl, `/invite/${token}`, {
      csrf: csrfOfOther,
      email: INVITED,
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(crossed.status).toBe(403);
    const { rows } = await testDb().query('SELECT 1 FROM dashboard_users WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });

  it('a reset token on the invite path is not a link, and nothing is consumed', async () => {
    const baseUrl = await startServer();
    await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
    const token = await issue('password_reset', ownerLogin(BUSINESS, USERNAME));
    const page = await fetch(`${baseUrl}/invite/${token}`, { redirect: 'manual' });
    expect(await page.text()).toContain(INVALID_COPY);
    const ok = await fetch(`${baseUrl}/reset/${token}`, { redirect: 'manual' });
    expect(ok.status).toBe(200);
  });

  it('malformed or unknown tokens are the invalid page, never an error', async () => {
    const baseUrl = await startServer();
    for (const path of ['/invite/garbage', `/invite/${BUSINESS}.`, '/reset/NOPE.zz', `/reset/${BUSINESS}.${'0'.repeat(64)}`]) {
      const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
      expect(res.status, path).toBe(400);
      expect(await res.text(), path).toContain(INVALID_COPY);
    }
  });

  it('a reset for an enrolled owner sets the password, revokes old sessions, and owes the code', async () => {
    const baseUrl = await startServer();
    await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
    const oldSid = await loginWithSecondFactor(baseUrl, BUSINESS, { username: USERNAME, password: PASSWORD });
    const token = await issue('password_reset', ownerLogin(BUSINESS, USERNAME));
    const csrf = csrfOnPage(await (await fetch(`${baseUrl}/reset/${token}`)).text());

    const mismatch = await submit(baseUrl, `/reset/${token}`, {
      csrf,
      email: ownerLogin(BUSINESS, USERNAME),
      password: NEW_PASSWORD,
      confirm: 'something else entirely',
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain('הסיסמאות אינן תואמות.');

    const res = await submit(baseUrl, `/reset/${token}`, {
      csrf,
      email: ownerLogin(BUSINESS, USERNAME).toUpperCase(),
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/2fa');
    expect((await get(baseUrl, '/', oldSid)).headers.get('location')).toBe('/login');
    expect((await get(baseUrl, '/', sidOf(res))).headers.get('location')).toBe('/2fa');
  });
});
