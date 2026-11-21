import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { activeCharterVersion, installCharter } from '../charter/store.js';
import { addColleague, listColleagues } from '../business/colleagues.js';
import { recallMemories, writeMemory } from '../memory/store.js';
import { createJob } from '../orchestrator/jobs.js';
import { createTestOwner, TEST_MASTER_KEY, loginWithSecondFactor } from '../test/owner.js';
import { createServer } from './server.js';
import { PEOPLE_INTRO } from './people-routes.js';
import { CONTACT_PHONE_TAKEN } from '../business/settings-contacts.js';
import { escapeHtml } from './views.js';
import { documentsAwaitingRead } from '../documents/store.js';

const ingestOverride = vi.hoisted(() => ({ reason: null as string | null }));
vi.mock('../documents/ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../documents/ingest.js')>();
  return {
    ...actual,
    ingestDocument: (...args: Parameters<typeof actual.ingestDocument>) =>
      ingestOverride.reason === null
        ? actual.ingestDocument(...args)
        : Promise.resolve({ status: 'rejected', reason: ingestOverride.reason, documentId: 'DOC-X' }),
  };
});

const BUSINESS = 'people-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
const PEOPLE = '/settings/people';

let server: Server | null = null;
let docRoot = '';

beforeEach(async () => {
  docRoot = await mkdtemp(join(tmpdir(), 'people-docs-'));
  await resetDatabase();
  await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({ version: 'v-people-1' })));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await rm(docRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await closePool();
});

async function start(): Promise<{ baseUrl: string; cookie: string }> {
  server = createServer({ masterKey: TEST_MASTER_KEY, port: 0, documentRoot: docRoot });
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = await loginWithSecondFactor(baseUrl, BUSINESS, { username: USERNAME, password: PASSWORD });
  return { baseUrl, cookie };
}

const get = (baseUrl: string, cookie: string, path: string) =>
  fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: 'manual' });

function csrfOf(html: string): string {
  const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
  if (!match?.[1]) throw new Error('no csrf');
  return match[1];
}

async function post(baseUrl: string, cookie: string, path: string, fields: Record<string, string>) {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(fields), redirect: 'manual' });
}

async function csrf(baseUrl: string, cookie: string): Promise<string> {
  return csrfOf(await (await get(baseUrl, cookie, PEOPLE)).text());
}

interface EntityRow {
  subject_key: string;
  body: Record<string, unknown>;
  provenance: string;
  source_ref: string | null;
  retired_at: Date | null;
}

async function entities(): Promise<EntityRow[]> {
  const { rows } = await testDb().query<EntityRow>(
    `SELECT subject_key, body, provenance, source_ref, retired_at FROM memories
      WHERE business_id = $1 AND kind = 'entity' ORDER BY created_at, memory_id`,
    [BUSINESS],
  );
  return rows;
}

/** An entity written outside this screen: a learned contact (no settings source). */
async function seedEntity(subjectKey: string, body: Record<string, unknown>, sourceRef: string | null): Promise<void> {
  await withBusiness(BUSINESS, async (db) => {
    const version = await activeCharterVersion(db);
    if (version === null) throw new Error('no charter');
    const job = await createJob(db, { charterVersion: version, provenance: 'unknown_external', title: 'seed' });
    await writeMemory(db, { jobId: job.jobId, kind: 'entity', subjectKey, body, sourceRef });
  });
}

describe('/settings/people', () => {
  it('shows the intro copy and is linked from the home page', async () => {
    const { baseUrl, cookie } = await start();
    const res = await get(baseUrl, cookie, PEOPLE);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(escapeHtml(PEOPLE_INTRO));
    expect(PEOPLE_INTRO).toBe(
      'העוזרת מכירה את האנשים כאן ויודעת מה התפקיד שלהם. הוראות היא מקבלת רק ממך. כדי שאיש קשר ייחשב "מוכר" (מענה בלי כרטיס אישור), הוסף אותו ב"ערוך את הכללים".',
    );
    const home = await (await get(baseUrl, cookie, '/')).text();
    expect(home).toContain('href="/settings/people">אנשים</a>');
    expect(home).toContain('href="/settings/profile">פרטי העסק</a>');
  });

  it('adds a colleague, then edits it, then removes it', async () => {
    const { baseUrl, cookie } = await start();
    const add = await post(baseUrl, cookie, `${PEOPLE}/colleague/add`, {
      csrf: await csrf(baseUrl, cookie),
      name: 'יוסי',
      role: 'מנהל עבודה',
      phone: '+972 50-111-0003',
    });
    expect(add.status).toBe(303);
    let list = await withBusiness(BUSINESS, (db) => listColleagues(db));
    expect(list.map((c) => [c.name, c.role, c.phone])).toEqual([['יוסי', 'מנהל עבודה', '+972501110003']]);
    const id = list[0]?.colleagueId ?? '';
    expect(await (await get(baseUrl, cookie, PEOPLE)).text()).toContain('יוסי');

    const edit = await post(baseUrl, cookie, `${PEOPLE}/colleague/edit`, {
      csrf: await csrf(baseUrl, cookie),
      id,
      name: 'יוסי לוי',
      role: 'שותף',
      phone: '+972501110004',
    });
    expect(edit.status).toBe(303);
    list = await withBusiness(BUSINESS, (db) => listColleagues(db));
    expect(list.map((c) => [c.colleagueId, c.name, c.role, c.phone])).toEqual([[id, 'יוסי לוי', 'שותף', '+972501110004']]);

    const remove = await post(baseUrl, cookie, `${PEOPLE}/colleague/remove`, { csrf: await csrf(baseUrl, cookie), id });
    expect(remove.status).toBe(303);
    expect(await withBusiness(BUSINESS, (db) => listColleagues(db))).toEqual([]);
  });

  it('refuses an invalid phone in Hebrew and writes nothing', async () => {
    const { baseUrl, cookie } = await start();
    const colleague = await post(baseUrl, cookie, `${PEOPLE}/colleague/add`, {
      csrf: await csrf(baseUrl, cookie),
      name: 'יוסי',
      role: 'מנהל עבודה',
      phone: '050-1110003',
    });
    expect(colleague.status).toBe(400);
    expect(await colleague.text()).toContain('מספר טלפון בפורמט בינלאומי בלבד');
    expect(await withBusiness(BUSINESS, (db) => listColleagues(db))).toEqual([]);

    const contact = await post(baseUrl, cookie, `${PEOPLE}/contact/add`, {
      csrf: await csrf(baseUrl, cookie),
      name: 'רונית',
      role: 'לקוחה',
      phone: 'not a phone',
    });
    expect(contact.status).toBe(400);
    expect(await contact.text()).toContain('מספר טלפון בפורמט בינלאומי בלבד');
    expect(await entities()).toEqual([]);
  });

  it('a contact add writes an entity under a boss job, keyed by the canonical phone', async () => {
    const { baseUrl, cookie } = await start();
    const res = await post(baseUrl, cookie, `${PEOPLE}/contact/add`, {
      csrf: await csrf(baseUrl, cookie),
      name: 'רונית כהן',
      role: 'לקוחה',
      phone: '+972-50-111-0001',
    });
    expect(res.status).toBe(303);
    const rows = await entities();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject_key: '+972501110001',
      body: { name: 'רונית כהן', role: 'לקוחה', phone: '+972501110001' },
      provenance: 'boss',
      source_ref: 'settings_people',
      retired_at: null,
    });
    const { rows: jobs } = await testDb().query<{ provenance: string; phase: string }>(
      'SELECT provenance, phase FROM jobs WHERE business_id = $1',
      [BUSINESS],
    );
    expect(jobs).toEqual([{ provenance: 'boss', phase: 'closed' }]);
    expect(await (await get(baseUrl, cookie, PEOPLE)).text()).toContain('רונית כהן');
  });

  it('editing a contact keeps the key; changing its phone retires the old key and writes the new one', async () => {
    await seedEntity('+972501110001', { name: 'רונית', role: 'לקוחה', phone: '+972501110001' }, 'setup_package');
    const { baseUrl, cookie } = await start();
    const edit = await post(baseUrl, cookie, `${PEOPLE}/contact/edit`, {
      csrf: await csrf(baseUrl, cookie),
      key: '+972501110001',
      name: 'רונית כהן',
      role: 'לקוחה ותיקה',
      phone: '+972501110001',
    });
    expect(edit.status).toBe(303);
    let live = (await entities()).filter((r) => r.retired_at === null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ subject_key: '+972501110001', provenance: 'boss', source_ref: 'settings_people' });
    expect(live[0]?.body).toEqual({ name: 'רונית כהן', role: 'לקוחה ותיקה', phone: '+972501110001' });

    const move = await post(baseUrl, cookie, `${PEOPLE}/contact/edit`, {
      csrf: await csrf(baseUrl, cookie),
      key: '+972501110001',
      name: 'רונית כהן',
      role: 'לקוחה ותיקה',
      phone: '+972501110009',
    });
    expect(move.status).toBe(303);
    live = (await entities()).filter((r) => r.retired_at === null);
    expect(live.map((r) => r.subject_key)).toEqual(['+972501110009']);
    expect((await entities()).length).toBe(3);
  });

  it('a contact removal retires it: recall excludes it and the row still exists', async () => {
    const { baseUrl, cookie } = await start();
    await post(baseUrl, cookie, `${PEOPLE}/contact/add`, {
      csrf: await csrf(baseUrl, cookie),
      name: 'רונית',
      role: 'לקוחה',
      phone: '+972501110001',
    });
    const remove = await post(baseUrl, cookie, `${PEOPLE}/contact/remove`, {
      csrf: await csrf(baseUrl, cookie),
      key: '+972501110001',
    });
    expect(remove.status).toBe(303);
    const recalled = await withBusiness(BUSINESS, (db) => recallMemories(db, { subjectKey: '+972501110001' }));
    expect(recalled).toEqual([]);
    const rows = await entities();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.retired_at).not.toBeNull();
    const { rows: jobs } = await testDb().query<{ provenance: string; phase: string }>(
      'SELECT provenance, phase FROM jobs WHERE business_id = $1 ORDER BY created_at',
      [BUSINESS],
    );
    expect(jobs).toEqual([
      { provenance: 'boss', phase: 'closed' },
      { provenance: 'boss', phase: 'closed' },
    ]);
    expect(await (await get(baseUrl, cookie, PEOPLE)).text()).not.toContain('רונית');
  });

  /** Final review I3: a write on a phone another managed contact holds would silently retire it. */
  it('refuses to add, or move a phone onto, a number another managed contact holds — writing nothing', async () => {
    await seedEntity('+972501110001', { name: 'רונית', role: 'לקוחה', phone: '+972501110001' }, 'setup_package');
    await seedEntity('+972501110002', { name: 'משה', role: 'ספק', phone: '+972501110002' }, 'settings_people');
    const before = await entities();
    const { baseUrl, cookie } = await start();

    const add = await post(baseUrl, cookie, `${PEOPLE}/contact/add`, {
      csrf: await csrf(baseUrl, cookie),
      name: 'מישהו אחר',
      role: 'לקוח',
      phone: '+972-50-111-0001',
    });
    expect(add.status).toBe(400);
    expect(await add.text()).toContain(escapeHtml(CONTACT_PHONE_TAKEN));

    const move = await post(baseUrl, cookie, `${PEOPLE}/contact/edit`, {
      csrf: await csrf(baseUrl, cookie),
      key: '+972501110002',
      name: 'משה',
      role: 'ספק',
      phone: '+972501110001',
    });
    expect(move.status).toBe(400);
    expect(CONTACT_PHONE_TAKEN).toBe('כבר יש איש קשר עם המספר הזה.');

    const after = await entities();
    expect(after).toEqual(before);
    const { rows: jobs } = await testDb().query("SELECT 1 FROM jobs WHERE business_id = $1 AND provenance = 'boss'", [
      BUSINESS,
    ]);
    expect(jobs).toEqual([]);
  });

  it('a contact add on the phone of a learned (not managed) entity still supersedes it', async () => {
    await seedEntity('+972501110001', { name: 'רונית מהמייל', phone: '+972501110001' }, null);
    const { baseUrl, cookie } = await start();
    const add = await post(baseUrl, cookie, `${PEOPLE}/contact/add`, {
      csrf: await csrf(baseUrl, cookie),
      name: 'רונית כהן',
      role: 'לקוחה',
      phone: '+972501110001',
    });
    expect(add.status).toBe(303);
    const live = (await entities()).filter((r) => r.retired_at === null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ source_ref: 'settings_people', provenance: 'boss' });
  });

  it('does not list or touch an entity this screen or the setup did not write', async () => {
    await seedEntity('dana@example.com', { name: 'דנה מהמייל', email: 'dana@example.com' }, null);
    const { baseUrl, cookie } = await start();
    expect(await (await get(baseUrl, cookie, PEOPLE)).text()).not.toContain('דנה מהמייל');
    const remove = await post(baseUrl, cookie, `${PEOPLE}/contact/remove`, {
      csrf: await csrf(baseUrl, cookie),
      key: 'dana@example.com',
    });
    expect(remove.status).toBe(404);
    const edit = await post(baseUrl, cookie, `${PEOPLE}/contact/edit`, {
      csrf: await csrf(baseUrl, cookie),
      key: 'dana@example.com',
      name: 'x',
      role: 'y',
      phone: '+972501110001',
    });
    expect(edit.status).toBe(404);
    const rows = await entities();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.retired_at).toBeNull();
  });

  it('renders names and roles with bidi controls stripped', async () => {
    await seedEntity('+972501110002', { name: 'משה‮ לוי', role: 'ספק‮', phone: '+972501110002' }, 'setup_package');
    await withBusiness(BUSINESS, (db) => addColleague(db, { name: 'יוסי‮', role: 'מנהל', phone: '+972501110003' }));
    const { baseUrl, cookie } = await start();
    const html = await (await get(baseUrl, cookie, PEOPLE)).text();
    expect(html).toContain('משה לוי');
    expect(html).not.toContain('‮');
  });

  it('refuses a POST without CSRF and writes nothing', async () => {
    const { baseUrl, cookie } = await start();
    const colleague = await post(baseUrl, cookie, `${PEOPLE}/colleague/add`, { name: 'יוסי', role: 'מנהל', phone: '+972501110003' });
    expect(colleague.status).toBe(403);
    const contact = await post(baseUrl, cookie, `${PEOPLE}/contact/add`, {
      csrf: 'deadbeef',
      name: 'רונית',
      role: 'לקוחה',
      phone: '+972501110001',
    });
    expect(contact.status).toBe(403);
    expect(await withBusiness(BUSINESS, (db) => listColleagues(db))).toEqual([]);
    expect(await entities()).toEqual([]);
  });
});

describe('/settings/people — contact kind and email', () => {
  it('saves kind and email, re-renders them, and stores them in the entity body', async () => {
    const { baseUrl, cookie } = await start();
    const add = await post(baseUrl, cookie, `${PEOPLE}/contact/add`, {
      csrf: await csrf(baseUrl, cookie),
      name: 'דנה',
      role: 'לקוחה',
      phone: '+972501110009',
      kind: 'supplier',
      email: 'dana@example.com',
    });
    expect(add.status).toBe(303);
    const row = (await entities())[0];
    expect(row?.body).toMatchObject({ kind: 'supplier', email: 'dana@example.com' });
    const html = await (await get(baseUrl, cookie, PEOPLE)).text();
    expect(html).toContain('value="dana@example.com"');
    expect(html).toMatch(/<option value="supplier" selected>/);
  });

  it('rejects an invalid email with a Hebrew message and writes nothing', async () => {
    const { baseUrl, cookie } = await start();
    const res = await post(baseUrl, cookie, `${PEOPLE}/contact/add`, {
      csrf: await csrf(baseUrl, cookie),
      name: 'דנה',
      role: 'לקוחה',
      phone: '+972501110009',
      kind: 'client',
      email: 'not-an-email',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('כתובת המייל אינה תקינה');
    expect(await entities()).toEqual([]);
  });

  it('a contact without kind or email still saves', async () => {
    const { baseUrl, cookie } = await start();
    const res = await post(baseUrl, cookie, `${PEOPLE}/contact/add`, {
      csrf: await csrf(baseUrl, cookie),
      name: 'דנה',
      role: 'לקוחה',
      phone: '+972501110009',
      kind: '',
      email: '',
    });
    expect(res.status).toBe(303);
    expect((await entities())[0]?.body).toEqual({ name: 'דנה', role: 'לקוחה', phone: '+972501110009' });
  });
});

describe('attach invoice to a contact', () => {
  const PHONE = '+972501110009';

  async function addContact(baseUrl: string, cookie: string): Promise<string> {
    await post(baseUrl, cookie, `${PEOPLE}/contact/add`, {
      csrf: await csrf(baseUrl, cookie),
      name: 'דנה',
      role: 'לקוחה',
      phone: PHONE,
      kind: 'client',
    });
    return PHONE;
  }

  async function uploadInvoice(baseUrl: string, cookie: string, fields: Record<string, string>) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('invoice', new Blob(['חשבונית 1234 סכום 500']), 'inv.txt');
    return fetch(`${baseUrl}${PEOPLE}/contact/invoice`, { method: 'POST', headers: { cookie }, body: form, redirect: 'manual' });
  }

  const rowsOf = async () =>
    (
      await testDb().query<{ contact_key: string; assigned_by: string }>(
        `SELECT contact_key, assigned_by FROM contact_documents WHERE business_id = $1`,
        [BUSINESS],
      )
    ).rows;

  it('an upload assigned in the dashboard appears for that contact', async () => {
    const { baseUrl, cookie } = await start();
    const key = await addContact(baseUrl, cookie);
    const res = await uploadInvoice(baseUrl, cookie, { csrf: await csrf(baseUrl, cookie), key });
    expect(res.status).toBe(303);
    expect(await rowsOf()).toEqual([{ contact_key: '972501110009', assigned_by: 'owner_upload' }]);
    const { rows } = await testDb().query<{ source: string }>(`SELECT source FROM documents WHERE business_id = $1`, [BUSINESS]);
    expect(rows.map((r) => r.source)).toEqual(['instruction']);
    expect(await withBusiness(BUSINESS, (db) => documentsAwaitingRead(db, 10))).toEqual([]);
  });

  it('assigning requires CSRF and a managed contact key', async () => {
    const { baseUrl, cookie } = await start();
    const key = await addContact(baseUrl, cookie);
    const bad = await uploadInvoice(baseUrl, cookie, { csrf: 'deadbeef', key });
    expect(bad.status).toBe(403);
    const unknown = await uploadInvoice(baseUrl, cookie, { csrf: await csrf(baseUrl, cookie), key: '+972509999999' });
    expect(unknown.status).toBe(404);
    expect(await rowsOf()).toEqual([]);
  });

  it('renders an ingest rejection reason HTML-escaped', async () => {
    const { baseUrl, cookie } = await start();
    const key = await addContact(baseUrl, cookie);
    ingestOverride.reason = '<script>alert(1)</script>';
    try {
      const res = await uploadInvoice(baseUrl, cookie, { csrf: await csrf(baseUrl, cookie), key });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).not.toContain('<script>alert(1)');
      expect(body).toContain('&lt;script&gt;');
    } finally {
      ingestOverride.reason = null;
    }
  });
});
