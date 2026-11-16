import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { registerBusiness, resetDatabase, TEST_BUSINESS, testDb } from '../test/db.js';
import { createTestOwner, loginWithSecondFactor, ownerLogin, TEST_MASTER_KEY } from '../test/owner.js';
import { buildCharter } from '../test/fixtures.js';
import { currentStep, totpCode } from '../auth/totp.js';
import { installCharter } from '../charter/store.js';
import { writeKeyState } from '../governance/master-key.js';
import { listSecretRefs } from '../governance/credential-store.js';
import { loadRuntimeSettings } from '../tenancy/runtime-settings.js';
import { redeemOwnerLink } from '../dashboard/owner-links.js';
import { totpStatus } from '../dashboard/second-factor.js';
import { createServer as createDashboard } from '../dashboard/server.js';
import { LOGO_MAX_BYTES } from '../business/logo.js';
import { saveAddress } from '../business/profile.js';
import { createHeadStaff, staffBeginEnrolment, staffConfirmEnrolment, startStaffSession } from '../tenancy/staff.js';
import { createAdminServer } from './server.js';

const BASE = 'https://dashboard.example';
const LOCKED_COPY = 'העסק כבר נחתם על ידי בעל העסק. מעכשיו רק הוא מעדכן את הפרטים האלה.';
const NOT_IMAGE_COPY = 'הקובץ אינו תמונת PNG או JPEG.';
const TOO_LARGE_COPY = 'הקובץ גדול מ-1MB.';
const INSTANCE = 'INSTANCE-PROBE-7781';
const TOKEN = 'TOKEN-PROBE-a9f3c1e2';
const OWNER_PASSWORD = 'owner password long enough';

let panel: Server | null = null;
let dashboard: Server | null = null;
let ROOT = '';

beforeEach(async () => {
  await resetDatabase();
  await writeKeyState(TEST_MASTER_KEY, 'key-1', testDb());
  await registerBusiness(TEST_BUSINESS);
  ROOT = await mkdtemp(join(tmpdir(), 'panel-setup-'));
});

afterEach(async () => {
  for (const s of [panel, dashboard]) {
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  panel = null;
  dashboard = null;
  await rm(ROOT, { recursive: true, force: true });
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

async function startPanel(): Promise<string> {
  panel = createAdminServer({ port: 0, masterKey: TEST_MASTER_KEY, documentRoot: ROOT, dashboardBaseUrl: BASE });
  await once(panel, 'listening');
  return `http://127.0.0.1:${(panel.address() as AddressInfo).port}`;
}

async function startDashboard(): Promise<string> {
  dashboard = createDashboard({ port: 0, masterKey: TEST_MASTER_KEY });
  await once(dashboard, 'listening');
  return `http://127.0.0.1:${(dashboard.address() as AddressInfo).port}`;
}

async function signedIn(): Promise<{ cookie: string; staffId: string }> {
  const staffId = await createHeadStaff({
    login: 'head@company.example',
    displayName: 'טכנאי ראשי',
    password: 'head password long enough',
  });
  const { secretBase32 } = await staffBeginEnrolment(staffId, TEST_MASTER_KEY);
  const past = new Date(Date.now() - 90_000);
  expect(await staffConfirmEnrolment(staffId, totpCode(secretBase32, currentStep(past)), TEST_MASTER_KEY, past)).toBe(
    'ok',
  );
  const token = await startStaffSession(staffId, { pendingFactor: null });
  return { cookie: `asid=${token}`, staffId };
}

function csrfIn(html: string): string {
  const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
  if (!match?.[1]) throw new Error('no csrf field on the page');
  return match[1];
}

async function get(baseUrl: string, path: string, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: 'manual' });
}

async function post(baseUrl: string, path: string, form: Record<string, string> | URLSearchParams, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { cookie },
    body: form instanceof URLSearchParams ? form : new URLSearchParams(form),
    redirect: 'manual',
  });
}

async function upload(baseUrl: string, cookie: string, csrf: string, bytes: Buffer, filename: string): Promise<Response> {
  const form = new FormData();
  form.set('csrf', csrf);
  form.set('logo', new Blob([bytes]), filename);
  return fetch(`${baseUrl}/businesses/${TEST_BUSINESS}/logo`, {
    method: 'POST',
    headers: { cookie },
    body: form,
    redirect: 'manual',
  });
}

async function pageCsrf(baseUrl: string, cookie: string): Promise<string> {
  const res = await get(baseUrl, `/businesses/${TEST_BUSINESS}`, cookie);
  expect(res.status).toBe(200);
  return csrfIn(await res.text());
}

async function activity(): Promise<Array<{ action: string; detail: unknown }>> {
  const { rows } = await testDb().query<{ action: string; detail: unknown }>(
    'SELECT action, detail FROM platform_activity_log ORDER BY seq',
  );
  return rows;
}

function pngBytes(extra = 0): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const length = Buffer.from([0x00, 0x00, 0x00, 0x0d]);
  const type = Buffer.from('IHDR', 'ascii');
  const data = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const crc = Buffer.from([0x1f, 0x15, 0xc4, 0x89]);
  return Buffer.concat([signature, length, type, data, crc, Buffer.alloc(extra, 0)]);
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function install(): Promise<void> {
  await withBusiness(TEST_BUSINESS, (db) => installCharter(db, buildCharter({ version: 'panel-charter' })));
}

describe('WhatsApp', () => {
  it('stores both secrets, turns WhatsApp on, never echoes the values — and works after handover too', async () => {
    const { cookie, staffId } = await signedIn();
    const baseUrl = await startPanel();
    const csrf = await pageCsrf(baseUrl, cookie);

    const res = await post(baseUrl, `/businesses/${TEST_BUSINESS}/whatsapp`, { csrf, instanceId: INSTANCE, token: TOKEN }, cookie);
    expect(res.status).toBe(303);
    const posted = await res.text();
    expect(posted).not.toContain(INSTANCE);
    expect(posted).not.toContain(TOKEN);

    const refs = await withBusiness(TEST_BUSINESS, (db) => listSecretRefs(db));
    expect(refs.map((r) => r.ref)).toEqual(['GREEN_API_INSTANCE_ID', 'GREEN_API_TOKEN']);
    expect(refs.every((r) => r.updatedBy === `staff:${staffId}`)).toBe(true);
    expect((await withBusiness(TEST_BUSINESS, (db) => loadRuntimeSettings(db))).whatsappEnabled).toBe(true);

    const pageHtml = await (await get(baseUrl, `/businesses/${TEST_BUSINESS}`, cookie)).text();
    expect(pageHtml).toContain('שמור');
    expect(pageHtml).not.toContain(INSTANCE);
    expect(pageHtml).not.toContain(TOKEN);

    const log = await activity();
    expect(log.map((r) => r.action)).toEqual(['whatsapp_saved']);
    expect(JSON.stringify(log)).not.toContain(INSTANCE);
    expect(JSON.stringify(log)).not.toContain(TOKEN);
    const audit = await testDb().query<{ reason: string }>(
      "SELECT reason FROM audit_log WHERE business_id = $1 AND kind = 'staff_action'",
      [TEST_BUSINESS],
    );
    expect(JSON.stringify(audit.rows)).not.toContain(TOKEN);

    // A connection, not authority: still allowed after the owner signed.
    await install();
    const after = await post(
      baseUrl,
      `/businesses/${TEST_BUSINESS}/whatsapp`,
      { csrf, instanceId: 'INSTANCE-2', token: 'TOKEN-2' },
      cookie,
    );
    expect(after.status).toBe(303);
  });

  it('refuses a blank field and writes nothing', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const csrf = await pageCsrf(baseUrl, cookie);
    const res = await post(baseUrl, `/businesses/${TEST_BUSINESS}/whatsapp`, { csrf, instanceId: INSTANCE, token: ' ' }, cookie);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(INSTANCE);
    expect(await withBusiness(TEST_BUSINESS, (db) => listSecretRefs(db))).toEqual([]);
    expect(await activity()).toEqual([]);
  });

  it('refuses a forged CSRF token', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const res = await post(baseUrl, `/businesses/${TEST_BUSINESS}/whatsapp`, { csrf: 'ab', instanceId: INSTANCE, token: TOKEN }, cookie);
    expect(res.status).toBe(403);
    expect(await withBusiness(TEST_BUSINESS, (db) => listSecretRefs(db))).toEqual([]);
  });
});

function setupForm(csrf: string, rows: { boss?: string; contacts?: string[][]; colleagues?: string[][] }): URLSearchParams {
  const form = new URLSearchParams({ csrf, boss: rows.boss ?? '' });
  for (const [name, role, phone] of rows.contacts ?? []) {
    form.append('contact_name', name ?? '');
    form.append('contact_role', role ?? '');
    form.append('contact_phone', phone ?? '');
  }
  for (const [name, role, phone] of rows.colleagues ?? []) {
    form.append('colleague_name', name ?? '');
    form.append('colleague_role', role ?? '');
    form.append('colleague_phone', phone ?? '');
  }
  return form;
}

describe('setup package', () => {
  it('saves the package, shows it before handover, and only counts after it', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const csrf = await pageCsrf(baseUrl, cookie);

    const res = await post(
      baseUrl,
      `/businesses/${TEST_BUSINESS}/setup`,
      setupForm(csrf, {
        boss: '+972501111111',
        contacts: [
          ['רונית פרובה', 'ספקית', '+972502222222'],
          ['', '', ''],
        ],
        colleagues: [['דני פרובה', 'מזכיר', '+972503333333']],
      }),
      cookie,
    );
    expect(res.status).toBe(303);
    const stored = await testDb().query<{ boss_whatsapp: string; contacts: unknown[]; colleagues: unknown[] }>(
      'SELECT boss_whatsapp, contacts, colleagues FROM setup_packages WHERE business_id = $1',
      [TEST_BUSINESS],
    );
    expect(stored.rows[0]?.boss_whatsapp).toBe('+972501111111');
    expect(stored.rows[0]?.contacts).toHaveLength(1);
    expect(stored.rows[0]?.colleagues).toHaveLength(1);
    const log = await activity();
    expect(log.map((r) => r.action)).toEqual(['setup_package_saved']);
    expect(JSON.stringify(log)).not.toContain('פרובה');

    const before = await (await get(baseUrl, `/businesses/${TEST_BUSINESS}`, cookie)).text();
    expect(before).toContain('רונית פרובה');
    expect(before).toContain('דני פרובה');
    expect(before).toContain('+972501111111');

    await install();
    const after = await (await get(baseUrl, `/businesses/${TEST_BUSINESS}`, cookie)).text();
    expect(after).not.toContain('רונית פרובה');
    expect(after).not.toContain('דני פרובה');
    expect(after).not.toContain('+972501111111');
    expect(after).toContain('אנשי קשר שאושרו');
    expect(after).not.toContain(`action="/businesses/${TEST_BUSINESS}/setup"`);
  });

  it('refuses a half-filled row and a local phone number, writing nothing', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const csrf = await pageCsrf(baseUrl, cookie);
    const half = await post(
      baseUrl,
      `/businesses/${TEST_BUSINESS}/setup`,
      setupForm(csrf, { contacts: [['רונית', '', '+972502222222']] }),
      cookie,
    );
    expect(half.status).toBe(400);
    const local = await post(baseUrl, `/businesses/${TEST_BUSINESS}/setup`, setupForm(csrf, { boss: '0501234567' }), cookie);
    expect(local.status).toBe(400);
    expect(await local.text()).toContain('מספר טלפון בפורמט בינלאומי בלבד');
    const stored = await testDb().query('SELECT 1 FROM setup_packages WHERE business_id = $1', [TEST_BUSINESS]);
    expect(stored.rows).toHaveLength(0);
    expect(await activity()).toEqual([]);
  });
});

describe('stale tab after the owner signed (Review Focus 4)', () => {
  it('refuses setup, profile and logo with 409 and writes nothing', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    await withBusiness(TEST_BUSINESS, (db) => saveAddress(db, 'הרצל 1', 'staff:seed'));
    const csrf = await pageCsrf(baseUrl, cookie);
    const snapshot = async (): Promise<string> => {
      const a = await testDb().query('SELECT * FROM setup_packages WHERE business_id = $1', [TEST_BUSINESS]);
      const b = await testDb().query('SELECT * FROM business_profiles WHERE business_id = $1', [TEST_BUSINESS]);
      return JSON.stringify([a.rows, b.rows]);
    };
    const before = await snapshot();

    // The owner signs while the technician's tab is open.
    await install();

    const setup = await post(
      baseUrl,
      `/businesses/${TEST_BUSINESS}/setup`,
      setupForm(csrf, { boss: '+972501111111', contacts: [['רונית', 'ספקית', '+972502222222']] }),
      cookie,
    );
    expect(setup.status).toBe(409);
    expect(await setup.text()).toContain(LOCKED_COPY);

    const profile = await post(baseUrl, `/businesses/${TEST_BUSINESS}/profile`, { csrf, address: 'דיזנגוף 99' }, cookie);
    expect(profile.status).toBe(409);
    expect(await profile.text()).toContain(LOCKED_COPY);

    const logo = await upload(baseUrl, cookie, csrf, pngBytes(), 'logo.png');
    expect(logo.status).toBe(409);
    expect(await logo.text()).toContain(LOCKED_COPY);

    expect(await snapshot()).toBe(before);
    expect(await readdir(ROOT)).toEqual([]);
    expect(await activity()).toEqual([]);

    // And the page no longer offers those forms.
    const html = await (await get(baseUrl, `/businesses/${TEST_BUSINESS}`, cookie)).text();
    expect(html).not.toContain(`action="/businesses/${TEST_BUSINESS}/profile"`);
    expect(html).not.toContain(`action="/businesses/${TEST_BUSINESS}/logo"`);
  });
});

describe('profile and logo before handover', () => {
  it('saves the address', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const csrf = await pageCsrf(baseUrl, cookie);
    const res = await post(baseUrl, `/businesses/${TEST_BUSINESS}/profile`, { csrf, address: 'דיזנגוף 99' }, cookie);
    expect(res.status).toBe(303);
    const row = await testDb().query<{ address: string }>('SELECT address FROM business_profiles WHERE business_id = $1', [
      TEST_BUSINESS,
    ]);
    expect(row.rows[0]?.address).toBe('דיזנגוף 99');
    const log = await activity();
    expect(log.map((r) => r.action)).toEqual(['profile_saved']);
    expect(JSON.stringify(log)).not.toContain('דיזנגוף');
  });

  it('stores a PNG, refuses an SVG as not_image and 1 MB + 1 byte as too_large', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const csrf = await pageCsrf(baseUrl, cookie);

    const svg = await upload(baseUrl, cookie, csrf, SVG, 'logo.png');
    expect(svg.status).toBe(400);
    expect(await svg.text()).toContain(NOT_IMAGE_COPY);

    const big = await upload(baseUrl, cookie, csrf, pngBytes(LOGO_MAX_BYTES - pngBytes().length + 1), 'logo.png');
    expect(big.status).toBe(413);
    expect(await big.text()).toContain(TOO_LARGE_COPY);

    const none = await testDb().query('SELECT 1 FROM business_profiles WHERE business_id = $1', [TEST_BUSINESS]);
    expect(none.rows).toHaveLength(0);
    expect(await activity()).toEqual([]);

    const ok = await upload(baseUrl, cookie, csrf, pngBytes(), 'logo.jpg');
    expect(ok.status).toBe(303);
    const row = await testDb().query<{ logo_media_type: string }>(
      'SELECT logo_media_type FROM business_profiles WHERE business_id = $1',
      [TEST_BUSINESS],
    );
    expect(row.rows[0]?.logo_media_type).toBe('image/png');
    expect((await activity()).map((r) => r.action)).toEqual(['logo_saved']);
  });

  it('cuts off an upload past the bounded read (declared and streamed), writing nothing', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const csrf = await pageCsrf(baseUrl, cookie);
    const boundary = 'panelboundary7781';
    // Past LOGO_MAX_BYTES + 64 KiB: refused by the bounded read, never handed to the parser.
    const file = pngBytes(LOGO_MAX_BYTES + 128 * 1024);
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${csrf}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="logo"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const url = new URL(`${baseUrl}/businesses/${TEST_BUSINESS}/logo`);
    // The client stops writing as soon as the refusal arrives: the server answers
    // with Connection: close, and a socket closed over a large unread backlog is
    // reset by the OS before the client could read the 413.
    for (const declared of [true, false]) {
      const { status, text } = await new Promise<{ status: number; text: string }>((resolveIt, reject) => {
        let answered = false;
        const req = request(
          {
            host: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
              cookie,
              'content-type': `multipart/form-data; boundary=${boundary}`,
              ...(declared ? { 'content-length': String(body.length) } : {}),
            },
          },
          (res) => {
            answered = true;
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolveIt({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
          },
        );
        req.on('error', () => undefined); // the server closes the upload mid-body, on purpose
        // Declared: the length alone is refused before a byte is read, so one
        // small piece is enough. Streamed (chunked, no length): write just past
        // the bound and wait — the reader must count the bytes to refuse.
        const step = declared ? 4 * 1024 : 32 * 1024;
        const writeFrom = (at: number): void => {
          if (answered || at >= (declared ? body.length : LOGO_MAX_BYTES + 64 * 1024 + step)) return;
          req.write(body.subarray(at, at + step), () => setTimeout(() => writeFrom(at + step), declared ? 50 : 0));
        };
        writeFrom(0);
      });
      expect(status, `declared=${declared}`).toBe(413);
      expect(text).toContain(TOO_LARGE_COPY);
    }
    const none = await testDb().query('SELECT 1 FROM business_profiles WHERE business_id = $1', [TEST_BUSINESS]);
    expect(none.rows).toHaveLength(0);
    expect(await readdir(ROOT)).toEqual([]);
    expect(await activity()).toEqual([]);
  });

  it('refuses an upload with a forged CSRF token', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const res = await upload(baseUrl, cookie, 'ab', pngBytes(), 'logo.png');
    expect(res.status).toBe(403);
    expect(await readdir(ROOT)).toEqual([]);
  });
});

describe('owner reset link and Authenticator reset', () => {
  it('issues a reset link that redeems on the dashboard, shown once and never logged', async () => {
    await createTestOwner(TEST_BUSINESS, { username: 'owner', password: OWNER_PASSWORD });
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const csrf = await pageCsrf(baseUrl, cookie);

    const res = await post(baseUrl, `/businesses/${TEST_BUSINESS}/reset-link`, { csrf }, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    const match = new RegExp(`${BASE}/reset/${TEST_BUSINESS}\\.([0-9a-f]{64})`).exec(html);
    expect(match).not.toBeNull();
    const raw = match?.[1] ?? '';

    expect(JSON.stringify(await activity())).not.toContain(raw);
    expect((await activity()).map((r) => r.action)).toEqual(['reset_issued']);
    expect(await (await get(baseUrl, `/businesses/${TEST_BUSINESS}`, cookie)).text()).not.toContain(raw);

    const redeemed = await withBusiness(TEST_BUSINESS, (db) =>
      redeemOwnerLink(db, {
        rawToken: raw,
        typedLogin: ownerLogin(TEST_BUSINESS).toUpperCase(),
        password: 'a brand new password',
      }),
    );
    expect(redeemed).toEqual({ ok: true, kind: 'password_reset', username: 'owner' });
  });

  it('refuses a reset link while the business has no owner', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const csrf = await pageCsrf(baseUrl, cookie);
    const res = await post(baseUrl, `/businesses/${TEST_BUSINESS}/reset-link`, { csrf }, cookie);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('לבעל העסק עדיין אין חשבון');
    const links = await testDb().query('SELECT 1 FROM owner_links WHERE business_id = $1', [TEST_BUSINESS]);
    expect(links.rows).toHaveLength(0);
    expect(await activity()).toEqual([]);

    const totp = await post(baseUrl, `/businesses/${TEST_BUSINESS}/totp-reset`, { csrf }, cookie);
    expect(totp.status).toBe(409);
    expect(await activity()).toEqual([]);
  });

  it('a TOTP reset forces enrolment at the owner next request', async () => {
    await createTestOwner(TEST_BUSINESS, { username: 'owner', password: OWNER_PASSWORD });
    await install();
    const dashboardUrl = await startDashboard();
    const sid = await loginWithSecondFactor(dashboardUrl, TEST_BUSINESS, { password: OWNER_PASSWORD });
    expect((await get(dashboardUrl, '/', sid)).status).toBe(200);

    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const csrf = await pageCsrf(baseUrl, cookie);
    const res = await post(baseUrl, `/businesses/${TEST_BUSINESS}/totp-reset`, { csrf }, cookie);
    expect(res.status).toBe(303);
    expect((await activity()).map((r) => r.action)).toEqual(['totp_reset']);

    expect(await withBusiness(TEST_BUSINESS, (db) => totpStatus(db, 'owner'))).toBe('not_enrolled');
    const devices = await testDb().query<{ live: string; total: string }>(
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL) AS live, count(*) AS total
         FROM dashboard_trusted_devices WHERE business_id = $1 AND username = 'owner'`,
      [TEST_BUSINESS],
    );
    // The device the login used existed, and is revoked now.
    expect(Number(devices.rows[0]?.total)).toBeGreaterThan(0);
    expect(Number(devices.rows[0]?.live)).toBe(0);
    expect((await get(dashboardUrl, '/', sid)).headers.get('location')).toBe('/login');
    const login = await fetch(`${dashboardUrl}/login`, {
      method: 'POST',
      body: new URLSearchParams({ email: ownerLogin(TEST_BUSINESS), password: OWNER_PASSWORD }),
      redirect: 'manual',
    });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/2fa/enrol');
  });
});

describe('mailbox row', () => {
  it('shows the connection state and the link to send the owner, with no action', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const html = await (await get(baseUrl, `/businesses/${TEST_BUSINESS}`, cookie)).text();
    expect(html).toContain('לא מחובר');
    expect(html).toContain(`שלח לבעל העסק את הקישור: ${BASE}/connections`);
    expect(html).not.toContain(`action="/businesses/${TEST_BUSINESS}/mailbox"`);
  });
});
