import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { registerBusiness, resetDatabase, TEST_BUSINESS, testDb } from '../test/db.js';
import { createTestOwner, TEST_MASTER_KEY } from '../test/owner.js';
import { buildCharter } from '../test/fixtures.js';
import { currentStep, totpCode } from '../auth/totp.js';
import { installCharter } from '../charter/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { saveAddress } from '../business/profile.js';
import { createHeadStaff, staffBeginEnrolment, staffConfirmEnrolment, startStaffSession } from '../tenancy/staff.js';
import { createAdminServer } from './server.js';

const BASE = 'https://dashboard.example';
const NEW_ID = 'alpha-shop';
const NEW_NAME = 'מספרת אלפא';
const INVITE_COPY = 'העתק את הקישור ושלח אותו לבעל העסק. הקישור תקף ל-72 שעות ולשימוש אחד.';

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
    dashboardBaseUrl: BASE,
  });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A signed-in, enrolled head: the `asid=` cookie pair and the staff id. */
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

async function post(baseUrl: string, path: string, form: Record<string, string>, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { cookie },
    body: new URLSearchParams(form),
    redirect: 'manual',
  });
}

async function openBusiness(
  baseUrl: string,
  cookie: string,
  fields: Partial<Record<'id' | 'name' | 'email' | 'address', string>> = {},
): Promise<Response> {
  const form = await get(baseUrl, '/businesses/new', cookie);
  expect(form.status).toBe(200);
  return post(
    baseUrl,
    '/businesses/new',
    {
      csrf: csrfIn(await form.text()),
      id: fields.id ?? NEW_ID,
      name: fields.name ?? NEW_NAME,
      email: fields.email ?? 'Owner@Alpha.example',
      address: fields.address ?? 'רחוב הרצל 1, תל אביב',
    },
    cookie,
  );
}

describe('opening a business', () => {
  it('creates the business and a pending invite, and shows the link exactly once', async () => {
    const { cookie, staffId } = await signedIn();
    const baseUrl = await startPanel();

    const res = await openBusiness(baseUrl, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    const link = new RegExp(`${BASE}/invite/${NEW_ID}\\.([0-9a-f]{64})`).exec(html);
    expect(link).not.toBeNull();
    const raw = link?.[1] ?? '';
    expect(html).toContain(INVITE_COPY);

    const business = await testDb().query<{ display_name: string; status: string }>(
      'SELECT display_name, status FROM businesses WHERE business_id = $1',
      [NEW_ID],
    );
    expect(business.rows).toEqual([{ display_name: NEW_NAME, status: 'active' }]);
    const links = await testDb().query<{ kind: string; login: string; used_at: Date | null }>(
      'SELECT kind, login, used_at FROM owner_links WHERE business_id = $1',
      [NEW_ID],
    );
    expect(links.rows).toEqual([{ kind: 'invite', login: 'owner@alpha.example', used_at: null }]);
    const profile = await testDb().query<{ address: string }>(
      'SELECT address FROM business_profiles WHERE business_id = $1',
      [NEW_ID],
    );
    expect(profile.rows[0]?.address).toBe('רחוב הרצל 1, תל אביב');

    const log = await testDb().query<{ staff_id: string; action: string; business_id: string; detail: unknown }>(
      'SELECT staff_id, action, business_id, detail FROM platform_activity_log',
    );
    expect(log.rows.map((r) => [r.staff_id, r.action, r.business_id])).toEqual([[staffId, 'business_open', NEW_ID]]);
    expect(JSON.stringify(log.rows)).not.toContain('alpha.example');
    const audit = await testDb().query<{ kind: string; reason: string }>(
      'SELECT kind, reason FROM audit_log WHERE business_id = $1',
      [NEW_ID],
    );
    expect(audit.rows).toEqual([{ kind: 'staff_action', reason: 'business_open · טכנאי ראשי' }]);

    // Before the owner signs, the page shows the address the technician typed.
    expect(await (await get(baseUrl, `/businesses/${NEW_ID}`, cookie)).text()).toContain('רחוב הרצל 1, תל אביב');

    // Reloading anything afterwards never shows the token again.
    for (const path of ['/', `/businesses/${NEW_ID}`, '/businesses/new']) {
      const again = await get(baseUrl, path, cookie);
      expect(again.status).toBe(200);
      expect(await again.text()).not.toContain(raw);
    }
    // Re-posting the same form (a browser refresh of the result) is refused, and issues no second link.
    const repeat = await openBusiness(baseUrl, cookie);
    expect(repeat.status).toBe(400);
    expect(await repeat.text()).not.toMatch(/\/invite\//);
    const count = await testDb().query<{ n: string }>('SELECT count(*) AS n FROM owner_links');
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('refuses an owner email already held by any business, in Hebrew, creating nothing', async () => {
    await createTestOwner('other-biz', { username: 'owner', password: 'owner password long', login: 'taken@x.example' });
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();

    const res = await openBusiness(baseUrl, cookie, { email: 'TAKEN@X.example' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('כתובת המייל הזאת כבר משמשת לכניסה של עסק אחר.');
    const business = await testDb().query('SELECT 1 FROM businesses WHERE business_id = $1', [NEW_ID]);
    expect(business.rowCount).toBe(0);
    const links = await testDb().query('SELECT 1 FROM owner_links');
    expect(links.rowCount).toBe(0);
  });

  it('refuses a malformed id in Hebrew', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const res = await openBusiness(baseUrl, cookie, { id: 'Alpha Shop' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('מזהה עסק לא תקין');
    expect((await testDb().query('SELECT 1 FROM businesses')).rowCount).toBe(0);
  });

  it('refuses the form without a valid csrf token', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const res = await post(
      baseUrl,
      '/businesses/new',
      { csrf: '00', id: NEW_ID, name: NEW_NAME, email: 'o@alpha.example', address: '' },
      cookie,
    );
    expect(res.status).toBe(403);
    expect((await testDb().query('SELECT 1 FROM businesses')).rowCount).toBe(0);
  });

  it('a business with no owner yet can be sent a new invite from its page', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    await openBusiness(baseUrl, cookie);

    const page = await get(baseUrl, `/businesses/${NEW_ID}`, cookie);
    const html = await page.text();
    expect(html).toContain(`action="/businesses/${NEW_ID}/invite"`);
    const res = await post(
      baseUrl,
      `/businesses/${NEW_ID}/invite`,
      { csrf: csrfIn(html), email: 'Fixed@alpha.example' },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(new RegExp(`${BASE}/invite/${NEW_ID}\\.[0-9a-f]{64}`));
    expect(body).toContain(INVITE_COPY);
    // The invite sent to the first (mistyped) address stops working: only the newest is live.
    const live = await testDb().query<{ login: string }>(
      'SELECT login FROM owner_links WHERE business_id = $1 AND used_at IS NULL',
      [NEW_ID],
    );
    expect(live.rows).toEqual([{ login: 'fixed@alpha.example' }]);
    const actions = await testDb().query<{ action: string }>('SELECT action FROM platform_activity_log ORDER BY seq');
    expect(actions.rows.map((r) => r.action)).toEqual(['business_open', 'invite_issued']);
  });
});

describe('the invite form once an owner exists', () => {
  it('is not offered, and a posted invite is refused without issuing a link', async () => {
    await createTestOwner(TEST_BUSINESS, { username: 'owner', password: 'owner password long' });
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const html = await (await get(baseUrl, `/businesses/${TEST_BUSINESS}`, cookie)).text();
    expect(html).not.toContain(`action="/businesses/${TEST_BUSINESS}/invite"`);
    expect(html).toContain('בעל העסק נכנס');
    const res = await post(
      baseUrl,
      `/businesses/${TEST_BUSINESS}/invite`,
      { csrf: csrfIn(html), email: 'someone@new.example' },
      cookie,
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('לבעל העסק כבר יש חשבון');
    expect((await testDb().query('SELECT 1 FROM owner_links')).rowCount).toBe(0);
    expect((await testDb().query('SELECT 1 FROM platform_activity_log')).rowCount).toBe(0);
  });
});

describe('the business list', () => {
  it('shows a new business as setting up with 0/4 basics, and the open button', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    await openBusiness(baseUrl, cookie);

    const res = await get(baseUrl, '/', cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const header of ['עסק', 'מצב', 'חיבורים בסיסיים', 'מערכות']) expect(html).toContain(`<th>${header}</th>`);
    expect(html).toContain(NEW_NAME);
    expect(html).toContain('🟡 בהקמה');
    expect(html).toContain('0/4');
    expect(html).toContain('+ פתיחת עסק חדש');
    expect(html).toContain(`href="/businesses/${NEW_ID}"`);
  });
});

describe('suspend and resume', () => {
  it('writes an activity row and a business audit row, neither carrying the name; suspended wins on the list', async () => {
    const { cookie, staffId } = await signedIn();
    const baseUrl = await startPanel();
    await openBusiness(baseUrl, cookie);
    // Only what the suspend writes is under test: skip the opening's own rows.
    const skipOpen = "action <> 'business_open'";

    const page = await get(baseUrl, `/businesses/${NEW_ID}`, cookie);
    const csrf = csrfIn(await page.text());

    const forged = await post(baseUrl, `/businesses/${NEW_ID}/suspend`, { csrf: '00' }, cookie);
    expect(forged.status).toBe(403);

    const res = await post(baseUrl, `/businesses/${NEW_ID}/suspend`, { csrf }, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/businesses/${NEW_ID}`);
    const status = await testDb().query<{ status: string }>('SELECT status FROM businesses WHERE business_id = $1', [
      NEW_ID,
    ]);
    expect(status.rows[0]?.status).toBe('suspended');

    const log = await testDb().query<{ staff_id: string; action: string; business_id: string }>(
      `SELECT staff_id, action, business_id, detail FROM platform_activity_log WHERE ${skipOpen}`,
    );
    expect(log.rows.map((r) => [r.staff_id, r.action, r.business_id])).toEqual([[staffId, 'business_suspend', NEW_ID]]);
    const audit = await testDb().query<{ kind: string; actor: string; reason: string }>(
      `SELECT kind, actor, reason, input_hash FROM audit_log WHERE business_id = $1 AND reason NOT LIKE 'business\_open%'`,
      [NEW_ID],
    );
    expect(audit.rows.map((r) => [r.kind, r.reason])).toEqual([['staff_action', 'business_suspend · טכנאי ראשי']]);
    expect(JSON.stringify(log.rows)).not.toContain(NEW_NAME);
    expect(JSON.stringify(audit.rows)).not.toContain(NEW_NAME);

    const list = await (await get(baseUrl, '/', cookie)).text();
    expect(list).toContain('⏸ מושעה');
    expect(list).not.toContain('🟡 בהקמה');

    const resume = await post(baseUrl, `/businesses/${NEW_ID}/resume`, { csrf }, cookie);
    expect(resume.status).toBe(303);
    const after = await testDb().query<{ status: string }>('SELECT status FROM businesses WHERE business_id = $1', [
      NEW_ID,
    ]);
    expect(after.rows[0]?.status).toBe('active');
    const actions = await testDb().query<{ action: string }>(
      `SELECT action FROM platform_activity_log WHERE ${skipOpen} ORDER BY seq`,
    );
    expect(actions.rows.map((r) => r.action)).toEqual(['business_suspend', 'business_resume']);
  });

  it('an unregistered business is 404 on every business route', async () => {
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    expect((await get(baseUrl, '/businesses/no-such-biz', cookie)).status).toBe(404);
    const page = await get(baseUrl, '/businesses/new', cookie);
    const csrf = csrfIn(await page.text());
    expect((await post(baseUrl, '/businesses/no-such-biz/suspend', { csrf }, cookie)).status).toBe(404);
    expect((await testDb().query('SELECT 1 FROM platform_activity_log')).rowCount).toBe(0);
  });
});

describe('the business page shows states and counts, never content', () => {
  const PROBE = 'PROBE_q7z';

  it('renders the three sections and the snapshot without any seeded content', async () => {
    await registerBusiness(TEST_BUSINESS);
    await withBusiness(TEST_BUSINESS, (db) => saveAddress(db, `רחוב ${PROBE}`, 'staff-1'));
    const charter = buildCharter({ doNotContactEntityId: PROBE });
    await withBusiness(TEST_BUSINESS, (db) => installCharter(db, charter));
    await withBusiness(TEST_BUSINESS, async (db) => {
      const job = await createJob(db, { charterVersion: charter.charterVersion, provenance: 'boss', title: `משימה ${PROBE}` });
      await transition(db, job.jobId, { to: 'understand', actor: 'orchestrator', reason: `סיבה ${PROBE}` });
      await db.query(
        `INSERT INTO memories (memory_id, business_id, kind, subject_key, body, provenance, written_by_job, source_ref)
         VALUES ('M-probe', $1, 'entity', $2, $3::jsonb, 'boss', $4, 'setup_package')`,
        [db.businessId, PROBE, JSON.stringify({ name: PROBE }), job.jobId],
      );
    });
    await testDb().query(
      `INSERT INTO mail_messages
         (mail_id, business_id, provider_message_id, thread_id, from_address, subject, received_at, body_text, state)
       VALUES ('M-1', $1, 'pm-1', 'th-1', $2, $3, now(), $4, 'triaged')`,
      [TEST_BUSINESS, `dana_${PROBE}@example.com`.toLowerCase(), `נושא ${PROBE}`, `גוף ${PROBE}`],
    );
    await testDb().query(
      `INSERT INTO spend_ledger (business_id, job_id, idempotency_key, action_class, amount_minor, currency, at)
       VALUES ($1, 'J-x', 'k1', 'purchase.place', 12345, 'ILS', now())`,
      [TEST_BUSINESS],
    );

    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const res = await get(baseUrl, `/businesses/${TEST_BUSINESS}`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();

    // The sections, in order.
    const order = [
      '1 · פתיחת עסק',
      '2 · חיבורים בסיסיים (נדרשים כדי להתחיל לעבוד)',
      '3 · חיבור למערכות (פותח עבודה מלאה)',
      'תמונת מצב',
    ].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('ייבנה בשלב הבא');
    for (const label of ['משימות ב-7 ימים', 'אישורים ממתינים', 'עלות היום', 'פעילות אחרונה', 'כשלים ב-7 ימים']) {
      expect(html).toContain(label);
    }
    // The reads did reach the seeded data: one job, the spend in the charter's currency.
    expect(html).toMatch(/משימות ב-7 ימים<\/dt>\s*<dd>1<\/dd>/);
    expect(html).toContain('₪123.45');

    expect(html.toLowerCase()).not.toContain(PROBE.toLowerCase());
    const list = await (await get(baseUrl, '/', cookie)).text();
    expect(list.toLowerCase()).not.toContain(PROBE.toLowerCase());
  });

  it('shows the cost as — when there is no charter', async () => {
    await registerBusiness(TEST_BUSINESS);
    const { cookie } = await signedIn();
    const baseUrl = await startPanel();
    const html = await (await get(baseUrl, `/businesses/${TEST_BUSINESS}`, cookie)).text();
    expect(html).toMatch(/עלות היום<\/dt>\s*<dd>—<\/dd>/);
  });
});
