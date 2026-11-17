import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { TEST_MASTER_KEY } from '../test/owner.js';
import { currentStep, totpCode } from '../auth/totp.js';
import { STAFF_ACTIONS, logStaffAction } from '../tenancy/activity-log.js';
import {
  createHeadStaff,
  inviteStaff,
  listStaff,
  redeemStaffLink,
  staffBeginEnrolment,
  staffConfirmEnrolment,
  startStaffSession,
} from '../tenancy/staff.js';
import { createAdminServer } from './server.js';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { escapeHtml } from '../util/html.js';
import { ADMIN_BASE_URL_MISSING, adminBaseUrlFor } from './staff-routes.js';
import { STAFF_ACTION_LABELS } from './views.js';

const NOT_HEAD = 'רק מנהל ראשי יכול לנהל את הצוות.';

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

async function enrolled(staffId: string): Promise<string> {
  const { secretBase32 } = await staffBeginEnrolment(staffId, TEST_MASTER_KEY);
  const past = new Date(Date.now() - 90_000);
  expect(await staffConfirmEnrolment(staffId, totpCode(secretBase32, currentStep(past)), TEST_MASTER_KEY, past)).toBe(
    'ok',
  );
  return `asid=${await startStaffSession(staffId, { pendingFactor: null })}`;
}

async function head(): Promise<{ cookie: string; staffId: string }> {
  const staffId = await createHeadStaff({
    login: 'head@company.example',
    displayName: 'טכנאי ראשי',
    password: 'head password long enough',
  });
  return { staffId, cookie: await enrolled(staffId) };
}

/** A plain colleague, invited by the head and redeemed through the store. */
async function colleague(headId: string): Promise<{ cookie: string; staffId: string }> {
  const { staffId, token } = await inviteStaff({ login: 'col@company.example', displayName: 'עמית', issuedBy: headId });
  const r = await redeemStaffLink({
    rawToken: token,
    typedLogin: 'col@company.example',
    password: 'colleague password long',
  });
  expect(r.ok).toBe(true);
  return { staffId, cookie: await enrolled(staffId) };
}

function csrfIn(html: string): string {
  const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
  if (!match?.[1]) throw new Error('no csrf field on the page');
  return match[1];
}

async function get(baseUrl: string, path: string, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: 'manual' });
}

async function post(baseUrl: string, path: string, form: Record<string, string>, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { cookie },
    body: new URLSearchParams(form),
    redirect: 'manual',
  });
}

async function activity(): Promise<{ action: string; detail: unknown }[]> {
  const { rows } = await testDb().query<{ action: string; detail: unknown }>(
    'SELECT action, detail FROM platform_activity_log ORDER BY seq',
  );
  return rows;
}

describe('staff management', () => {
  it('refuses every staff POST from a non-head with 403 and writes nothing', async () => {
    const h = await head();
    const c = await colleague(h.staffId);
    const baseUrl = await startPanel();
    const page = await get(baseUrl, '/staff', c.cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain('/staff/invite');
    const csrf = csrfIn(html);
    const before = (await listStaff()).length;

    const attempts: [string, Record<string, string>][] = [
      ['/staff/invite', { csrf, name: 'חדש', email: 'new@company.example' }],
      [`/staff/${h.staffId}/remove`, { csrf }],
      [`/staff/${h.staffId}/reset-factor`, { csrf }],
    ];
    for (const [path, form] of attempts) {
      const res = await post(baseUrl, path, form, c.cookie);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(NOT_HEAD);
    }
    expect((await listStaff()).length).toBe(before);
    expect((await listStaff()).every((s) => !s.removed)).toBe(true);
    expect(await activity()).toEqual([]);
  });

  it('a head invites; the invitee joins, enrols and signs in; the link is shown once and the email is not logged', async () => {
    const h = await head();
    const baseUrl = await startPanel();
    const csrf = csrfIn(await (await get(baseUrl, '/staff', h.cookie)).text());

    const res = await post(baseUrl, '/staff/invite', { csrf, name: 'דנה', email: 'Dana@Company.example' }, h.cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    const link = /class="invite-link">([^<]+)</.exec(html)?.[1] ?? '';
    expect(link).toMatch(new RegExp(`^${baseUrl}/join/[0-9a-f]{64}$`));

    // Shown once: the list afterwards has no link.
    expect(await (await get(baseUrl, '/staff', h.cookie)).text()).not.toContain('/join/');

    const rows = await activity();
    expect(rows.map((r) => r.action)).toEqual(['staff_invited']);
    expect(JSON.stringify(rows)).not.toMatch(/dana|דנה/i);

    // Join through the link.
    const token = link.split('/join/')[1] ?? '';
    const joinCsrf = csrfIn(await (await fetch(`${baseUrl}/join/${token}`)).text());
    const joined = await fetch(`${baseUrl}/join/${token}`, {
      method: 'POST',
      body: new URLSearchParams({
        csrf: joinCsrf,
        email: 'dana@company.example',
        password: 'dana password long enough',
        confirm: 'dana password long enough',
      }),
      redirect: 'manual',
    });
    expect(joined.status).toBe(303);
    expect(joined.headers.get('location')).toBe('/2fa/enrol');
    const pre = (joined.headers.getSetCookie().find((c) => c.startsWith('asid=')) ?? '').split(';')[0] ?? '';
    const enrolHtml = await (await get(baseUrl, '/2fa/enrol', pre)).text();
    const secret = /class="totp-secret">([A-Z2-7 ]+)</.exec(enrolHtml)?.[1]?.replace(/ /g, '') ?? '';
    const done = await post(
      baseUrl,
      '/2fa/enrol',
      { csrf: csrfIn(enrolHtml), code: totpCode(secret, currentStep(new Date())) },
      pre,
    );
    expect(done.status).toBe(303);
    const full = (done.headers.getSetCookie().find((c) => c.startsWith('asid=')) ?? '').split(';')[0] ?? '';
    const staffPage = await get(baseUrl, '/staff', full);
    expect(staffPage.status).toBe(200);
    expect(await staffPage.text()).toContain('דנה');
  });

  /** Final review T11: a Host header the attacker may set never becomes a link origin. */
  it('adminBaseUrlFor: loopback hosts (including [::1]) are http; any other Host without ADMIN_BASE_URL is null', () => {
    const req = (host: string) => ({ headers: { host } }) as unknown as IncomingMessage;
    expect(adminBaseUrlFor(req('127.0.0.1:8788'), undefined)).toBe('http://127.0.0.1:8788');
    expect(adminBaseUrlFor(req('localhost'), undefined)).toBe('http://localhost');
    expect(adminBaseUrlFor(req('[::1]:8788'), undefined)).toBe('http://[::1]:8788');
    expect(adminBaseUrlFor(req('panel.company.example'), undefined)).toBeNull();
    expect(adminBaseUrlFor(req('evil.example'), '')).toBeNull();
    expect(adminBaseUrlFor(req('evil.example'), 'https://panel.example/x')).toBe('https://panel.example');
  });

  it('refuses to issue an invite when the link origin is unknown, in Hebrew, issuing nothing', async () => {
    const h = await head();
    const baseUrl = await startPanel();
    const csrf = csrfIn(await (await get(baseUrl, '/staff', h.cookie)).text());
    // `fetch` will not send a custom Host; node:http will.
    const body = new URLSearchParams({ csrf, name: 'דנה', email: 'd@company.example' }).toString();
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const r = httpRequest(
        `${baseUrl}/staff/invite`,
        {
          method: 'POST',
          headers: {
            cookie: h.cookie,
            host: 'panel.company.example',
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (text += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
        },
      );
      r.on('error', reject);
      r.end(body);
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain(escapeHtml(ADMIN_BASE_URL_MISSING));
    expect((await listStaff()).map((s) => s.login)).toEqual(['head@company.example']);
  });

  it('prefers ADMIN_BASE_URL when it is set', async () => {
    const h = await head();
    const baseUrl = await startPanel();
    process.env['ADMIN_BASE_URL'] = 'https://panel.example';
    try {
      const csrf = csrfIn(await (await get(baseUrl, '/staff', h.cookie)).text());
      const html = await (
        await post(baseUrl, '/staff/invite', { csrf, name: 'דנה', email: 'd@company.example' }, h.cookie)
      ).text();
      expect(html).toMatch(/https:\/\/panel\.example\/join\/[0-9a-f]{64}/);
    } finally {
      delete process.env['ADMIN_BASE_URL'];
    }
  });

  it('refuses a bad CSRF token and bad invite input without writing', async () => {
    const h = await head();
    const baseUrl = await startPanel();
    const csrf = csrfIn(await (await get(baseUrl, '/staff', h.cookie)).text());
    const forged = await post(baseUrl, '/staff/invite', { csrf: '00', name: 'x', email: 'x@company.example' }, h.cookie);
    expect(forged.status).toBe(403);
    const bad = await post(baseUrl, '/staff/invite', { csrf, name: 'x', email: 'not-an-email' }, h.cookie);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('כתובת מייל לא תקינה.');
    expect(await activity()).toEqual([]);
    expect((await listStaff()).length).toBe(1);
  });

  /** Final review M5: a staff name is typed text; bidi controls never reach the page. */
  it('renders staff names with bidi controls stripped — on the team list, the header and the log', async () => {
    const h = await head();
    const { staffId } = await inviteStaff({ login: 'rlo@company.example', displayName: 'דנה‮טכנאית', issuedBy: h.staffId });
    await logStaffAction({ staffId, action: 'business_open', businessId: 'biz-one' });
    const baseUrl = await startPanel();
    const team = await (await get(baseUrl, '/staff', h.cookie)).text();
    expect(team).toContain('דנהטכנאית');
    expect(team).not.toContain('‮');
    const log = await (await get(baseUrl, '/log', h.cookie)).text();
    expect(log).toContain('דנהטכנאית');
    expect(log).not.toContain('‮');
  });

  it('refuses removing the last head, in Hebrew, and logs nothing', async () => {
    const h = await head();
    const baseUrl = await startPanel();
    const csrf = csrfIn(await (await get(baseUrl, '/staff', h.cookie)).text());
    const res = await post(baseUrl, `/staff/${h.staffId}/remove`, { csrf }, h.cookie);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('אי אפשר להסיר את ראש הצוות האחרון.');
    expect((await listStaff())[0]?.removed).toBe(false);
    expect(await activity()).toEqual([]);
  });

  it('removes a colleague, then refuses removing or resetting them again', async () => {
    const h = await head();
    const c = await colleague(h.staffId);
    const baseUrl = await startPanel();
    const csrf = csrfIn(await (await get(baseUrl, '/staff', h.cookie)).text());
    const res = await post(baseUrl, `/staff/${c.staffId}/remove`, { csrf }, h.cookie);
    expect(res.status).toBe(303);
    expect((await listStaff()).find((s) => s.staffId === c.staffId)?.removed).toBe(true);
    // The removed colleague's session is gone.
    expect((await get(baseUrl, '/staff', c.cookie)).status).toBe(303);

    for (const path of [`/staff/${c.staffId}/remove`, `/staff/${c.staffId}/reset-factor`, '/staff/ST-nope/reset-factor']) {
      expect((await post(baseUrl, path, { csrf }, h.cookie)).status).toBe(404);
    }
    expect((await activity()).map((r) => r.action)).toEqual(['staff_removed']);
  });

  it('resets a colleague second factor: they must enrol again, and it is logged', async () => {
    const h = await head();
    const c = await colleague(h.staffId);
    const baseUrl = await startPanel();
    const csrf = csrfIn(await (await get(baseUrl, '/staff', h.cookie)).text());
    expect(await (await get(baseUrl, '/staff', h.cookie)).text()).toContain('✓');
    const res = await post(baseUrl, `/staff/${c.staffId}/reset-factor`, { csrf }, h.cookie);
    expect(res.status).toBe(303);
    expect((await listStaff()).find((s) => s.staffId === c.staffId)?.enrolled).toBe(false);
    expect((await activity()).map((r) => r.action)).toEqual(['totp_reset']);
  });
});

describe('activity log', () => {
  it('lists the actions with a Hebrew label, staff name and business id', async () => {
    const h = await head();
    await logStaffAction({ staffId: h.staffId, action: 'business_open', businessId: 'alpha-shop' });
    await logStaffAction({ staffId: h.staffId, action: 'staff_invited', businessId: null });
    const baseUrl = await startPanel();
    const res = await get(baseUrl, '/log', h.cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('טכנאי ראשי');
    expect(html).toContain('alpha-shop');
    expect(html).toContain(STAFF_ACTION_LABELS.business_open);
    expect(html).toContain(STAFF_ACTION_LABELS.staff_invited);
    expect(html.indexOf(STAFF_ACTION_LABELS.staff_invited)).toBeLessThan(html.indexOf(STAFF_ACTION_LABELS.business_open));
  });

  it('has a non-empty Hebrew label for every staff action', () => {
    expect(Object.keys(STAFF_ACTION_LABELS).sort()).toEqual([...STAFF_ACTIONS].sort());
    for (const a of STAFF_ACTIONS) expect(STAFF_ACTION_LABELS[a].length).toBeGreaterThan(0);
  });
});
