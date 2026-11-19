/**
 * The panel's external-system screens (Stage D, Task 9): a technician writes
 * a definition as a draft and stores its secrets. Driven over HTTP against a
 * real panel server, like the other panel route tests.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { registerBusiness, resetDatabase, TEST_BUSINESS, testDb } from '../test/db.js';
import { TEST_MASTER_KEY } from '../test/owner.js';
import { buildCharter } from '../test/fixtures.js';
import { crmConnection, crmFixture } from '../test/external-fixtures.js';
import { currentStep, totpCode } from '../auth/totp.js';
import { installCharter } from '../charter/store.js';
import { writeKeyState } from '../governance/master-key.js';
import { listSecretRefs, storedCredentials } from '../governance/credential-store.js';
import { loadDrafts, saveDraft } from '../external/store.js';
import { createHeadStaff, staffBeginEnrolment, staffConfirmEnrolment, startStaffSession } from '../tenancy/staff.js';
import { createAdminServer } from './server.js';

const SECRET_VALUE = 'sk_live_PROBE_9f3a77c1';
const PATH = `/businesses/${TEST_BUSINESS}/external`;

let panel: Server | null = null;
let ROOT = '';

beforeEach(async () => {
  await resetDatabase();
  await writeKeyState(TEST_MASTER_KEY, 'key-1', testDb());
  await registerBusiness(TEST_BUSINESS);
  ROOT = await mkdtemp(join(tmpdir(), 'panel-external-'));
});

afterEach(async () => {
  if (panel) await new Promise<void>((resolve) => panel!.close(() => resolve()));
  panel = null;
  await rm(ROOT, { recursive: true, force: true });
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

async function startPanel(): Promise<string> {
  panel = createAdminServer({ port: 0, masterKey: TEST_MASTER_KEY, documentRoot: ROOT, dashboardBaseUrl: 'https://d.example' });
  await once(panel, 'listening');
  return `http://127.0.0.1:${(panel.address() as AddressInfo).port}`;
}

async function signedIn(): Promise<string> {
  const staffId = await createHeadStaff({
    login: 'head@company.example',
    displayName: 'טכנאי ראשי',
    password: 'head password long enough',
  });
  const { secretBase32 } = await staffBeginEnrolment(staffId, TEST_MASTER_KEY);
  const past = new Date(Date.now() - 90_000);
  expect(await staffConfirmEnrolment(staffId, totpCode(secretBase32, currentStep(past)), TEST_MASTER_KEY, past)).toBe('ok');
  return `asid=${await startStaffSession(staffId, { pendingFactor: null })}`;
}

function csrfIn(html: string): string {
  const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
  if (!match?.[1]) throw new Error('no csrf field on the page');
  return match[1];
}

async function get(base: string, path: string, cookie: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
}

async function post(base: string, path: string, form: Record<string, string>, cookie: string): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(form), redirect: 'manual' });
}

async function editCsrf(base: string, cookie: string, system = 'crm'): Promise<string> {
  const res = await get(base, `${PATH}/${system}`, cookie);
  expect(res.status).toBe(200);
  return csrfIn(await res.text());
}

async function activity(): Promise<Array<{ action: string; detail: Record<string, unknown> }>> {
  const { rows } = await testDb().query<{ action: string; detail: Record<string, unknown> }>(
    'SELECT action, detail FROM platform_activity_log ORDER BY seq',
  );
  return rows;
}

async function staffAuditRows(): Promise<string[]> {
  const { rows } = await testDb().query<{ row: string }>(
    `SELECT row_to_json(a)::text AS row FROM audit_log a WHERE business_id = $1 AND kind = 'staff_action'`,
    [TEST_BUSINESS],
  );
  return rows.map((r) => r.row);
}

async function drafts(): Promise<unknown[]> {
  return withBusiness(TEST_BUSINESS, (db) => loadDrafts(db));
}

describe('editing a draft', () => {
  it('refuses JSON that does not parse, writing nothing', async () => {
    const base = await startPanel();
    const cookie = await signedIn();
    const csrf = await editCsrf(base, cookie);
    const res = await post(base, `${PATH}/crm/save`, { csrf, definition: '{ "id": "crm", ' }, cookie);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('הטקסט אינו JSON תקין');
    // The typed text comes back so the technician can fix it.
    expect(html).toContain('{ &quot;id&quot;: &quot;crm&quot;, ');
    expect(await drafts()).toEqual([]);
    expect(await activity()).toEqual([]);
  });

  it('refuses a definition that fails the schema with the issue paths in Hebrew, writing nothing', async () => {
    const base = await startPanel();
    const cookie = await signedIn();
    const csrf = await editCsrf(base, cookie);
    const bad = { ...crmFixture(), baseUrl: 'http://api.crm.example.com', operations: [] };
    const res = await post(base, `${PATH}/crm/save`, { csrf, definition: JSON.stringify(bad) }, cookie);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('baseUrl');
    expect(html).toContain('operations');
    // zod's own messages are rendered through the Hebrew locale.
    expect(html).toMatch(/operations[^<]*:[^<]*[\u0590-\u05FF]/);
    // The definition's own messages are Hebrew too — the baseUrl one above all.
    expect(html).toContain('baseUrl: baseUrl חייב להיות כתובת https:');
    expect(html).not.toContain('must be an https');
    expect(await drafts()).toEqual([]);
    expect(await activity()).toEqual([]);
  });

  it('refuses a definition with a key the schema does not know, listing its path', async () => {
    const base = await startPanel();
    const cookie = await signedIn();
    const csrf = await editCsrf(base, cookie);
    const { idempotencyHeader, ...rest } = crmFixture();
    const typo = { ...rest, idempotencyHeaders: idempotencyHeader };
    const res = await post(base, `${PATH}/crm/save`, { csrf, definition: JSON.stringify(typo) }, cookie);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('שדות שלא זוהו: idempotencyHeaders');
    expect(await drafts()).toEqual([]);
    expect(await activity()).toEqual([]);
  });

  it('refuses an unknown key nested inside the webhook', async () => {
    const base = await startPanel();
    const cookie = await signedIn();
    const csrf = await editCsrf(base, cookie);
    const def = crmFixture() as unknown as { webhook: Record<string, unknown> };
    const events = def.webhook.events as Array<Record<string, unknown>>;
    events[1] = { type: 'payment.failed', label: 'תשלום נכשל', feilds: [] };
    def.webhook = { ...def.webhook, typepath: 'type' };
    const res = await post(base, `${PATH}/crm/save`, { csrf, definition: JSON.stringify(def) }, cookie);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('webhook.typepath');
    expect(html).toContain('webhook.events.1.feilds');
    expect(await drafts()).toEqual([]);
  });

  it('refuses a definition over the form size limit with its own message', async () => {
    const base = await startPanel();
    const cookie = await signedIn();
    const csrf = await editCsrf(base, cookie);
    const res = await post(base, `${PATH}/crm/save`, { csrf, definition: 'א'.repeat(20_000) }, cookie);
    expect(res.status).toBe(413);
    expect(await res.text()).toContain('ההגדרה גדולה מדי');
    expect(await drafts()).toEqual([]);
  });

  it('refuses a definition whose id differs from the route', async () => {
    const base = await startPanel();
    const cookie = await signedIn();
    const csrf = await editCsrf(base, cookie, 'books');
    const res = await post(base, `${PATH}/books/save`, { csrf, definition: JSON.stringify(crmFixture()) }, cookie);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('המזהה בהגדרה (crm) אינו תואם');
    expect(await drafts()).toEqual([]);
  });

  it('answers 404 for a route id that is not a system id', async () => {
    const base = await startPanel();
    const cookie = await signedIn();
    expect((await get(base, `${PATH}/Bad-Id`, cookie)).status).toBe(404);
    expect((await get(base, `/businesses/not-registered/external`, cookie)).status).toBe(404);
  });

  it('refuses a save without the CSRF token', async () => {
    const base = await startPanel();
    const cookie = await signedIn();
    const res = await post(base, `${PATH}/crm/save`, { definition: JSON.stringify(crmFixture()) }, cookie);
    expect(res.status).toBe(403);
    expect(await drafts()).toEqual([]);
  });

  it('saves a valid draft, logs counts and flags only, and previews it in Hebrew', async () => {
    const base = await startPanel();
    const cookie = await signedIn();
    const csrf = await editCsrf(base, cookie);
    const res = await post(base, `${PATH}/crm/save`, { csrf, definition: JSON.stringify(crmFixture()) }, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PATH}/crm`);

    const stored = await drafts();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ systemId: 'crm', definition: { baseUrl: 'https://api.crm.example.com/v1' } });

    const log = await activity();
    expect(log).toEqual([{ action: 'external_draft_saved', detail: { operations: 5, webhook: true, scan: true } }]);
    // Neither the activity row nor the business audit row carries the definition.
    const audits = await staffAuditRows();
    expect(audits).toHaveLength(1);
    for (const text of [JSON.stringify(log), ...audits]) {
      expect(text).not.toContain('api.crm.example.com');
      expect(text).not.toContain('מערכת הלקוחות');
      expect(text).not.toContain('list_customers');
    }

    const page = await (await get(base, `${PATH}/crm`, cookie)).text();
    expect(page).toContain('רשימת לקוחות (קריאה)');
    expect(page).toContain('החזר כספי (כסף)');
    expect(page).toContain('התראות נכנסות (webhook): לקוח חדש, תשלום נכשל');
    expect(page).toContain('סריקה כל 24 שעות: רשימת לקוחות');
    // The technician's own draft comes back in the textarea.
    expect(page).toContain('https://api.crm.example.com/v1');
    expect(page).toContain('מצב: טיוטה');
  });

  it('deletes a draft and logs it', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveDraft(db, { systemId: 'crm', definition: crmFixture(), staffId: 's' }));
    const base = await startPanel();
    const cookie = await signedIn();
    const csrf = await editCsrf(base, cookie);
    const res = await post(base, `${PATH}/crm/delete`, { csrf }, cookie);
    expect(res.status).toBe(303);
    expect(await drafts()).toEqual([]);
    expect(await activity()).toEqual([{ action: 'external_draft_deleted', detail: {} }]);

    // A second delete finds nothing and logs nothing.
    expect((await post(base, `${PATH}/crm/delete`, { csrf }, cookie)).status).toBe(303);
    expect(await activity()).toHaveLength(1);
  });
});

describe('what the technician sees of a signed system', () => {
  async function signCrm(): Promise<void> {
    await withBusiness(TEST_BUSINESS, (db) =>
      installCharter(db, buildCharter({ externalSystems: [crmFixture()], connections: [crmConnection()] })),
    );
  }

  it("shows 'חתום' for a draft equal to the signed definition and 'שינויים לא חתומים' for one that differs", async () => {
    await signCrm();
    const base = await startPanel();
    const cookie = await signedIn();
    let list = await (await get(base, PATH, cookie)).text();
    expect(list).toContain('חתום');
    expect(list).not.toContain('שינויים לא חתומים');

    const csrf = await editCsrf(base, cookie);
    await post(base, `${PATH}/crm/save`, { csrf, definition: JSON.stringify(crmFixture()) }, cookie);
    list = await (await get(base, PATH, cookie)).text();
    expect(list).not.toContain('שינויים לא חתומים');

    const changed = { ...crmFixture(), label: 'מערכת לקוחות אחרת' };
    await post(base, `${PATH}/crm/save`, { csrf, definition: JSON.stringify(changed) }, cookie);
    list = await (await get(base, PATH, cookie)).text();
    expect(list).toContain('שינויים לא חתומים');

    // The business page lists the same status, replacing the old placeholder.
    const businessPage = await (await get(base, `/businesses/${TEST_BUSINESS}`, cookie)).text();
    expect(businessPage).toContain('שינויים לא חתומים');
    expect(businessPage).not.toContain('ייבנה בשלב הבא');
    expect(businessPage).toContain(`href="${PATH}"`);
  });

  it('preloads the signed definition, labelled, when there is no draft — saving it unchanged stays signed', async () => {
    await signCrm();
    const base = await startPanel();
    const cookie = await signedIn();
    const page = await (await get(base, `${PATH}/crm`, cookie)).text();
    expect(page).toContain('ההגדרה החתומה — שינוי ייצור טיוטה חדשה שדורשת חתימה מחדש');
    expect(page).toContain('https://api.crm.example.com/v1');

    // The textarea's text, submitted as is.
    const match = /<textarea name="definition"[^>]*>([\s\S]*?)<\/textarea>/.exec(page);
    const text = (match?.[1] ?? '')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    expect(text).toContain('"baseUrl"');
    const res = await post(base, `${PATH}/crm/save`, { csrf: csrfIn(page), definition: text }, cookie);
    expect(res.status).toBe(303);
    expect(await drafts()).toHaveLength(1);
    const list = await (await get(base, PATH, cookie)).text();
    expect(list).toContain('<td>חתום</td>');
  });

  it('never shows events or reads on the external screens', async () => {
    await signCrm();
    await withBusiness(TEST_BUSINESS, async (db) => {
      await db.query(
        `INSERT INTO external_events (business_id, event_id, system_id, source, event_type, item_hash, fields)
         VALUES ($1, 'XE-1', 'crm', 'webhook', 'customer.created', 'h1', $2::jsonb)`,
        [db.businessId, JSON.stringify([{ label: 'שם', value: 'EVENT_PROBE_77' }])],
      );
      await db.query(
        `INSERT INTO external_reads (business_id, read_id, job_id, step_id, system_id, operation, fields)
         VALUES ($1, 'XR-1', 'J1', 's1', 'crm', 'get_customer', $2::jsonb)`,
        [db.businessId, JSON.stringify([{ label: 'שם', value: 'READ_PROBE_77' }])],
      );
    });
    const base = await startPanel();
    const cookie = await signedIn();
    for (const path of [PATH, `${PATH}/crm`, `/businesses/${TEST_BUSINESS}`]) {
      const page = await (await get(base, path, cookie)).text();
      expect(page).not.toContain('EVENT_PROBE_77');
      expect(page).not.toContain('READ_PROBE_77');
    }
  });
});

describe('secrets', () => {
  it('stores a secret under the derived ref and never shows or logs its value', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveDraft(db, { systemId: 'crm', definition: crmFixture(), staffId: 's' }));
    const base = await startPanel();
    const cookie = await signedIn();
    const csrf = await editCsrf(base, cookie);
    const res = await post(base, `${PATH}/crm/secret`, { csrf, kind: 'key', value: SECRET_VALUE }, cookie);
    expect(res.status).toBe(303);
    expect(await res.text()).not.toContain(SECRET_VALUE);

    const refs = await withBusiness(TEST_BUSINESS, (db) => listSecretRefs(db));
    expect(refs.map((r) => r.ref)).toEqual(['EXT_CRM_KEY']);
    const handle = await storedCredentials(TEST_MASTER_KEY).resolve('EXT_CRM_KEY', TEST_BUSINESS);
    expect(handle?.value).toBe(SECRET_VALUE);

    const page = await (await get(base, `${PATH}/crm`, cookie)).text();
    expect(page).toContain('✓ שמור');
    expect(page).not.toContain(SECRET_VALUE);

    const log = await activity();
    expect(log).toEqual([{ action: 'external_secret_saved', detail: { kind: 'key' } }]);
    for (const text of [JSON.stringify(log), ...(await staffAuditRows())]) expect(text).not.toContain(SECRET_VALUE);
  });

  it('refuses a secret for a system with neither a draft nor a signed definition', async () => {
    const base = await startPanel();
    const cookie = await signedIn();
    const csrf = await editCsrf(base, cookie);
    const res = await post(base, `${PATH}/crm/secret`, { csrf, kind: 'key', value: SECRET_VALUE }, cookie);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('אין עדיין טיוטה או הגדרה חתומה');
    expect(html).not.toContain(SECRET_VALUE);
    expect(await withBusiness(TEST_BUSINESS, (db) => listSecretRefs(db))).toEqual([]);
    expect(await activity()).toEqual([]);
  });

  it('refuses an empty value and a kind outside the closed list, storing nothing', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveDraft(db, { systemId: 'crm', definition: crmFixture(), staffId: 's' }));
    const base = await startPanel();
    const cookie = await signedIn();
    const csrf = await editCsrf(base, cookie);
    for (const form of [
      { csrf, kind: 'key', value: '   ' },
      { csrf, kind: 'token', value: SECRET_VALUE },
      { csrf, kind: 'constructor', value: SECRET_VALUE },
    ]) {
      const res = await post(base, `${PATH}/crm/secret`, form, cookie);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(SECRET_VALUE);
    }
    expect(await withBusiness(TEST_BUSINESS, (db) => listSecretRefs(db))).toEqual([]);
    expect(await activity()).toEqual([]);
  });

  it('accepts a secret after the system is signed', async () => {
    await withBusiness(TEST_BUSINESS, (db) =>
      installCharter(db, buildCharter({ externalSystems: [crmFixture()], connections: [crmConnection()] })),
    );
    const base = await startPanel();
    const cookie = await signedIn();
    const csrf = await editCsrf(base, cookie);
    const res = await post(base, `${PATH}/crm/secret`, { csrf, kind: 'hook', value: SECRET_VALUE }, cookie);
    expect(res.status).toBe(303);
    const refs = await withBusiness(TEST_BUSINESS, (db) => listSecretRefs(db));
    expect(refs.map((r) => r.ref)).toEqual(['EXT_CRM_HOOK']);
  });
});
