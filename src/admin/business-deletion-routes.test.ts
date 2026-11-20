/**
 * Deleting a whole business from the panel (spec 2026-11-19, plan Task 4):
 * who sees the button, the confirmation page and its plain-Hebrew lists, a
 * wrong name (refused before any Google access is revoked), a full deletion,
 * a file failure and its retry, CSRF, and an owner's old cookie afterwards.
 */
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { TEST_MASTER_KEY } from '../test/owner.js';
import { currentStep, totpCode } from '../auth/totp.js';
import { createOwner, sessionCookieValue, startSession } from '../dashboard/auth.js';
import { createServer as createDashboardServer } from '../dashboard/server.js';
import { writeGrant } from '../governance/oauth-grants.js';
import { writeKeyState } from '../governance/master-key.js';
import { logStaffAction } from '../tenancy/activity-log.js';
import {
  assertNotDeleting,
  DELETION_REFUSAL_HE,
  deleteBusinessFiles,
  deleteBusinessRows,
  finishDeletion,
  withBusinessWriteGuard,
} from '../tenancy/business-deletion.js';
import { BusinessDeletingError, setBusinessStatus } from '../tenancy/businesses.js';
import { putSecret } from '../governance/credential-store.js';
import { withBusinessTransaction } from '../db/pool.js';
import { businessFolders } from '../tenancy/paths.js';
import {
  createHeadStaff,
  inviteStaff,
  redeemStaffLink,
  staffBeginEnrolment,
  staffConfirmEnrolment,
  startStaffSession,
} from '../tenancy/staff.js';
import { createAdminServer, type AdminOptions } from './server.js';

const ACME = 'acme-del';
const ACME_NAME = 'מספרת אקמי';
const OTHER = 'other-biz';

const mutableConfig = config as { documentRoot: string; documentInboxRoot: string | null };
const original = { documentRoot: config.documentRoot, documentInboxRoot: config.documentInboxRoot };
let tempRoots: string[] = [];

let server: Server | null = null;
let dashboard: Server | null = null;

interface Call {
  url: string;
}
let fetchCalls: Call[] = [];
const stubFetch = (async (input: string | URL | Request) => {
  fetchCalls.push({ url: String(input) });
  return new Response('', { status: 200 });
}) as typeof fetch;

beforeAll(async () => {
  const docRoot = await mkdtemp(join(tmpdir(), 'paneldel-doc-'));
  const inboxRoot = await mkdtemp(join(tmpdir(), 'paneldel-inbox-'));
  tempRoots = [docRoot, inboxRoot];
  mutableConfig.documentRoot = docRoot;
  mutableConfig.documentInboxRoot = inboxRoot;
});

beforeEach(async () => {
  await resetDatabase();
  fetchCalls = [];
  await testDb().query(
    `INSERT INTO businesses (business_id, display_name, status, suspended_at) VALUES ($1, $2, 'suspended', now())`,
    [ACME, ACME_NAME],
  );
  await registerBusiness(OTHER, 'active');
  await writeKeyState(TEST_MASTER_KEY, 'KEY-test', testDb());
});

afterEach(async () => {
  for (const s of [server, dashboard]) {
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  server = null;
  dashboard = null;
  for (const id of [ACME, OTHER]) {
    const f = businessFolders(id);
    for (const p of [f.document, f.inbox, f.save]) if (p !== null) await rm(p, { recursive: true, force: true });
  }
});

afterAll(async () => {
  mutableConfig.documentRoot = original.documentRoot;
  mutableConfig.documentInboxRoot = original.documentInboxRoot;
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
  await closePlatformPool();
  await closePool();
});

async function startPanel(seams: AdminOptions['deletionTestSeams'] = { fetchImpl: stubFetch }): Promise<string> {
  server = createAdminServer({
    port: 0,
    masterKey: TEST_MASTER_KEY,
    documentRoot: 'unused-in-these-tests',
    dashboardBaseUrl: 'https://dashboard.example',
    deletionTestSeams: seams,
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

async function colleague(headId: string): Promise<{ cookie: string; staffId: string }> {
  const { staffId, token } = await inviteStaff({ login: 'col@company.example', displayName: 'עמית', issuedBy: headId });
  const r = await redeemStaffLink({ rawToken: token, typedLogin: 'col@company.example', password: 'colleague password long' });
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

/** The CSRF token of this session, read from the confirmation page (or any page). */
async function csrfFor(baseUrl: string, cookie: string): Promise<string> {
  return csrfIn(await (await get(baseUrl, '/', cookie)).text());
}

async function statusOf(id: string): Promise<string | null> {
  const { rows } = await testDb().query<{ status: string }>('SELECT status FROM businesses WHERE business_id = $1', [id]);
  return rows[0]?.status ?? null;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await testDb().query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function putFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'x');
}

async function googleGrant(businessId: string): Promise<void> {
  await withBusiness(businessId, (db) =>
    writeGrant(
      db,
      {
        system: 'calendar',
        provider: 'google',
        credentialRef: 'CALENDAR',
        account: 'owner@example.com',
        scopes: ['s'],
        refreshToken: `refresh-token-${businessId}`,
        grantedBy: 'owner',
      },
      TEST_MASTER_KEY,
    ),
  );
}

/** Some rows and files for ACME: an owner, a Google grant, an audit row, files in both folders. */
async function seedAcme(): Promise<void> {
  await withBusiness(ACME, (db) => createOwner(db, { username: 'owner', login: 'owner@acme.example', password: 'owner password long enough' }));
  await withBusiness(ACME, (db) =>
    writeGrant(
      db,
      {
        system: 'mailbox',
        provider: 'google',
        credentialRef: 'MAILBOX',
        account: 'owner@acme.example',
        scopes: ['s'],
        refreshToken: 'refresh-token-acme',
        grantedBy: 'owner',
      },
      TEST_MASTER_KEY,
    ),
  );
  const f = businessFolders(ACME);
  await putFile(join(f.document, 'a', 'one.txt'));
  if (f.inbox !== null) await putFile(join(f.inbox, 'working', 'two.txt'));
}

describe('who sees the button', () => {
  it('a head sees the link on a suspended business; not on an active one', async () => {
    const baseUrl = await startPanel();
    const { cookie } = await head();
    const page = await (await get(baseUrl, `/businesses/${ACME}`, cookie)).text();
    expect(page).toContain(`href="/businesses/${ACME}/delete"`);
    expect(page).toContain('מחיקת העסק');
    const active = await (await get(baseUrl, `/businesses/${OTHER}`, cookie)).text();
    expect(active).not.toContain(`/businesses/${OTHER}/delete`);
  });

  it('a non-head sees no link and gets 403 on GET and POST', async () => {
    const baseUrl = await startPanel();
    const h = await head();
    const { cookie } = await colleague(h.staffId);
    const page = await (await get(baseUrl, `/businesses/${ACME}`, cookie)).text();
    expect(page).not.toContain(`/businesses/${ACME}/delete`);
    expect((await get(baseUrl, `/businesses/${ACME}/delete`, cookie)).status).toBe(403);
    const csrf = await csrfFor(baseUrl, cookie);
    await googleGrant(ACME);
    // A WRONG name: without the route's head gate this would be a 400
    // name_mismatch (the name check comes before the tenancy calls).
    const refused = await post(baseUrl, `/businesses/${ACME}/delete`, { csrf, name: 'not the name' }, cookie);
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain(DELETION_REFUSAL_HE.name_mismatch);
    expect((await post(baseUrl, `/businesses/${ACME}/delete/files`, { csrf }, cookie)).status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
    expect(await statusOf(ACME)).toBe('suspended');
  });

  it('an active business: no form on GET, and POST is refused with nothing revoked or deleted', async () => {
    const baseUrl = await startPanel();
    const { cookie } = await head();
    const res = await get(baseUrl, `/businesses/${OTHER}/delete`, cookie);
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain('name="name"');
    const csrf = await csrfFor(baseUrl, cookie);
    await googleGrant(OTHER);
    // A WRONG name: the status refusal must come first, with no provider call.
    const refused = await post(baseUrl, `/businesses/${OTHER}/delete`, { csrf, name: 'not the name' }, cookie);
    expect(refused.status).toBe(409);
    const body = await refused.text();
    expect(body).toContain(DELETION_REFUSAL_HE.not_suspended);
    expect(body).not.toContain(DELETION_REFUSAL_HE.name_mismatch);
    expect(await statusOf(OTHER)).toBe('active');
    expect(fetchCalls).toHaveLength(0);
  });

  it('an unknown business is 404 with no form', async () => {
    const baseUrl = await startPanel();
    const { cookie } = await head();
    const res = await get(baseUrl, '/businesses/nobody-here/delete', cookie);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('name="name"');
  });
});

describe('the confirmation page', () => {
  it('shows the name, the deleted and not-deleted lists, and says Google is revoked first', async () => {
    const baseUrl = await startPanel();
    const { cookie } = await head();
    const res = await get(baseUrl, `/businesses/${ACME}/delete`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(ACME_NAME);
    expect(html).toContain('name="name"');
    expect(html).toContain('לא יימחק');
    expect(html).toContain('גיבויים');
    expect(html).toContain('Microsoft');
    expect(html).toContain('תיקיית השמירה');
    expect(html).toContain('Google');
    expect(html).toContain('לא תוחזר');
  });
});

describe('a wrong name', () => {
  it('re-renders with the refusal, deletes nothing and revokes nothing', async () => {
    await seedAcme();
    const baseUrl = await startPanel();
    const { cookie } = await head();
    const csrf = csrfIn(await (await get(baseUrl, `/businesses/${ACME}/delete`, cookie)).text());
    const res = await post(baseUrl, `/businesses/${ACME}/delete`, { csrf, name: `${ACME_NAME}x` }, cookie);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain(DELETION_REFUSAL_HE.name_mismatch);
    expect(html).toContain('name="name"');
    expect(fetchCalls).toHaveLength(0);
    expect(await statusOf(ACME)).toBe('suspended');
    expect(await count('SELECT count(*) AS n FROM dashboard_users WHERE business_id = $1', [ACME])).toBe(1);
    expect(await exists(join(businessFolders(ACME).document, 'a', 'one.txt'))).toBe(true);
  });

  it('a pass in flight is refused before anything is revoked', async () => {
    await seedAcme();
    await testDb().query('UPDATE businesses SET pass_started_at = now() WHERE business_id = $1', [ACME]);
    const baseUrl = await startPanel();
    const { cookie } = await head();
    const csrf = csrfIn(await (await get(baseUrl, `/businesses/${ACME}/delete`, cookie)).text());
    const res = await post(baseUrl, `/businesses/${ACME}/delete`, { csrf, name: ACME_NAME }, cookie);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(DELETION_REFUSAL_HE.pass_in_flight);
    expect(fetchCalls).toHaveLength(0);
    expect(await statusOf(ACME)).toBe('suspended');
  });
});

describe('a successful delete', () => {
  it('revokes Google, deletes rows and files, shows counts only, and records nothing', async () => {
    await seedAcme();
    const baseUrl = await startPanel();
    const { cookie, staffId } = await head();
    // Something the head did on this business earlier — it goes with the business.
    await logStaffAction({ staffId, action: 'business_suspend', businessId: ACME, detail: {} });
    const csrf = csrfIn(await (await get(baseUrl, `/businesses/${ACME}/delete`, cookie)).text());
    const res = await post(baseUrl, `/businesses/${ACME}/delete`, { csrf, name: `  ${ACME_NAME} ` }, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('העסק נמחק');
    expect(html).not.toContain(ACME_NAME);
    expect(html).not.toContain(ACME);
    expect(fetchCalls.map((c) => c.url)).toEqual(['https://oauth2.googleapis.com/revoke']);

    expect(await statusOf(ACME)).toBeNull();
    expect(await count('SELECT count(*) AS n FROM platform_activity_log WHERE business_id = $1', [ACME])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM audit_log WHERE business_id = $1', [ACME])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM dashboard_users WHERE business_id = $1', [ACME])).toBe(0);
    expect(await exists(businessFolders(ACME).document)).toBe(false);
    // Nothing recorded for the deletion itself, anywhere.
    expect(await count('SELECT count(*) AS n FROM platform_activity_log', [])).toBe(0);

    const list = await (await get(baseUrl, '/', cookie)).text();
    expect(list).not.toContain(`/businesses/${ACME}"`);
    expect(list).toContain(`/businesses/${OTHER}"`);
  });
});

describe('a file failure', () => {
  it('shows the retry form and keeps status deleting; a retry with the seam fixed finishes', async () => {
    await seedAcme();
    const docFolder = businessFolders(ACME).document;
    let failDoc = true;
    const baseUrl = await startPanel({
      fetchImpl: stubFetch,
      rm: async (path, options) => {
        if (failDoc && path === docFolder) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        await rm(path, options);
      },
    });
    const { cookie } = await head();
    const csrf = csrfIn(await (await get(baseUrl, `/businesses/${ACME}/delete`, cookie)).text());
    const res = await post(baseUrl, `/businesses/${ACME}/delete`, { csrf, name: ACME_NAME }, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('השורות נמחקו, אבל 1 תיקיות לא נמחקו');
    expect(html).toContain('תיקיית המסמכים: 1');
    expect(html).not.toContain('DOCUMENT_ROOT');
    expect(html).toContain('רשומות שנמחקו');
    expect(html).toContain(`action="/businesses/${ACME}/delete/files"`);
    expect(await statusOf(ACME)).toBe('deleting');

    // The business page now shows only the note and the retry form.
    const page = await (await get(baseUrl, `/businesses/${ACME}`, cookie)).text();
    expect(page).toContain(`action="/businesses/${ACME}/delete/files"`);
    expect(page).not.toContain(`/businesses/${ACME}/resume`);
    // And GET on the delete page shows only the retry form.
    const del = await (await get(baseUrl, `/businesses/${ACME}/delete`, cookie)).text();
    expect(del).toContain(`action="/businesses/${ACME}/delete/files"`);
    expect(del).not.toContain('name="name"');
    // A resume of a business being deleted is refused.
    const resume = await post(baseUrl, `/businesses/${ACME}/resume`, { csrf }, cookie);
    expect(resume.status).toBe(409);
    expect(await statusOf(ACME)).toBe('deleting');

    failDoc = false;
    const retry = await post(baseUrl, `/businesses/${ACME}/delete/files`, { csrf }, cookie);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('העסק נמחק');
    expect(await statusOf(ACME)).toBeNull();
    expect(await exists(docFolder)).toBe(false);
  });

  it('the retry on a business that is not being deleted is refused', async () => {
    const baseUrl = await startPanel();
    const { cookie } = await head();
    const csrf = await csrfFor(baseUrl, cookie);
    const res = await post(baseUrl, `/businesses/${ACME}/delete/files`, { csrf }, cookie);
    expect(res.status).toBe(409);
    expect(await statusOf(ACME)).toBe('suspended');
  });
});

describe('CSRF', () => {
  it('a POST without the token is 403 and nothing happens', async () => {
    await seedAcme();
    const baseUrl = await startPanel();
    const { cookie } = await head();
    expect((await post(baseUrl, `/businesses/${ACME}/delete`, { name: ACME_NAME }, cookie)).status).toBe(403);
    expect((await post(baseUrl, `/businesses/${ACME}/delete/files`, {}, cookie)).status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
    expect(await statusOf(ACME)).toBe('suspended');
  });
});

describe('an old owner cookie', () => {
  it('reads as not signed in once the business is deleted', async () => {
    await seedAcme();
    const token = await withBusiness(ACME, (db) => startSession(db, 'owner', { pendingFactor: null }));
    const sid = `sid=${sessionCookieValue(ACME, token)}`;

    dashboard = createDashboardServer({ masterKey: TEST_MASTER_KEY, port: 0 });
    await once(dashboard, 'listening');
    const dashUrl = `http://127.0.0.1:${(dashboard.address() as AddressInfo).port}`;
    // Before: the session is found (it owes enrolment), so it is not sent to sign-in.
    const before = await fetch(`${dashUrl}/`, { headers: { cookie: sid }, redirect: 'manual' });
    expect(before.headers.get('location')).not.toBe('/login');

    const baseUrl = await startPanel();
    const { cookie } = await head();
    const csrf = csrfIn(await (await get(baseUrl, `/businesses/${ACME}/delete`, cookie)).text());
    expect((await post(baseUrl, `/businesses/${ACME}/delete`, { csrf, name: ACME_NAME }, cookie)).status).toBe(200);
    expect(await statusOf(ACME)).toBeNull();

    const res = await fetch(`${dashUrl}/`, { headers: { cookie: sid }, redirect: 'manual' });
    // The dashboard's redirect is a 302 — a redirect to sign-in, never a 500.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('serialising panel writes with the deletion', () => {
  it('setBusinessStatus never resumes a business being deleted', async () => {
    await testDb().query(`UPDATE businesses SET status = 'deleting' WHERE business_id = $1`, [ACME]);
    await expect(setBusinessStatus(ACME, 'active')).rejects.toBeInstanceOf(BusinessDeletingError);
    await expect(setBusinessStatus(ACME, 'suspended')).rejects.toBeInstanceOf(BusinessDeletingError);
    expect(await statusOf(ACME)).toBe('deleting');
  });

  it('a write holding the guard makes the deletion wait, and its row is deleted with the rest', async () => {
    const { staffId } = await head();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const write = withBusinessWriteGuard(ACME, async (tx) => {
      await putSecret(tx, { ref: 'GREEN_API_TOKEN', value: 'late-secret', updatedBy: 'test' }, TEST_MASTER_KEY);
      entered();
      await gate;
    });
    await inside;
    let settled = false;
    const deletion = deleteBusinessRows({ businessId: ACME, staffId, typedName: ACME_NAME }).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    release();
    await write;
    const result = await deletion;
    expect(result.ok).toBe(true);
    expect(await count('SELECT count(*) AS n FROM credentials WHERE business_id = $1', [ACME])).toBe(0);
  });

  it('a write after the deletion is refused and writes nothing', async () => {
    const { staffId, cookie } = await head();
    expect((await deleteBusinessRows({ businessId: ACME, staffId, typedName: ACME_NAME })).ok).toBe(true);
    await expect(
      withBusinessWriteGuard(ACME, (tx) =>
        putSecret(tx, { ref: 'GREEN_API_TOKEN', value: 'late-secret', updatedBy: 'test' }, TEST_MASTER_KEY),
      ),
    ).rejects.toBeInstanceOf(BusinessDeletingError);
    const baseUrl = await startPanel();
    const csrf = await csrfFor(baseUrl, cookie);
    const res = await post(baseUrl, `/businesses/${ACME}/whatsapp`, { csrf, instanceId: 'i', token: 't' }, cookie);
    expect(res.status).toBe(409);
    const ext = await post(baseUrl, `/businesses/${ACME}/external/crm/secret`, { csrf, kind: 'key', value: 'v' }, cookie);
    expect(ext.status).toBe(409);
    expect(await count('SELECT count(*) AS n FROM credentials WHERE business_id = $1', [ACME])).toBe(0);
    expect(await statusOf(ACME)).toBe('deleting');
  });

  it('the guard refuses to run outside a transaction', async () => {
    await expect(withBusiness(ACME, (db) => assertNotDeleting(db))).rejects.toThrow(/inside a transaction/);
    await withBusinessTransaction(ACME, (tx) => assertNotDeleting(tx));
  });

  it('finishDeletion removes a row that slipped in before it frees the id', async () => {
    const { staffId } = await head();
    expect((await deleteBusinessRows({ businessId: ACME, staffId, typedName: ACME_NAME })).ok).toBe(true);
    await testDb().query(
      `INSERT INTO business_profiles (business_id, display_name, updated_by) VALUES ($1, 'יתום', 'test')`,
      [ACME],
    );
    expect((await deleteBusinessFiles(ACME)).ok).toBe(true);
    expect(await finishDeletion(ACME)).toBe(true);
    expect(await count('SELECT count(*) AS n FROM business_profiles WHERE business_id = $1', [ACME])).toBe(0);
    expect(await statusOf(ACME)).toBeNull();
  });
});
