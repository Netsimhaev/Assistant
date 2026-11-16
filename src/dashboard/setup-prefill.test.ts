import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { loadDraft, replaceDraft, saveSection } from '../charter/interview/draft-store.js';
import { completeAnswers } from '../charter/interview/test-answers.js';
import { saveSetupPackage, type SetupPackage } from '../business/setup-package.js';
import { saveAddress, saveLogo } from '../business/profile.js';
import { createTestOwner, TEST_MASTER_KEY, loginWithSecondFactor } from '../test/owner.js';
import { createServer } from './server.js';
import { SETUP_PEOPLE_SUMMARY_TITLE, UNCONFIRMED_SETUP_PEOPLE_NOTE } from './setup-views.js';
import { BOSS_PREFILL_NOTE, PROFILE_CHANGE_NOTE } from './setup-step-views.js';

const BUSINESS = 'setup-prefill-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
const BOSS = '+972541234567';

const PACKAGE: SetupPackage = {
  bossWhatsapp: BOSS,
  contacts: [
    { name: 'רונית כהן', role: 'לקוחה', phone: '+972501110001' },
    { name: 'משה‮ לוי', role: 'ספק', phone: '+972501110002' },
  ],
  colleagues: [{ name: 'יוסי', role: 'מנהל עבודה', phone: '+972501110003' }],
};

/** The smallest valid PNG: signature, IHDR, IEND. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

let server: Server | null = null;
let root = '';

beforeEach(async () => {
  await resetDatabase();
  await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  root = await mkdtemp(join(tmpdir(), 'setup-prefill-'));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await closePool();
});

async function start(): Promise<{ baseUrl: string; cookie: string }> {
  server = createServer({ masterKey: TEST_MASTER_KEY, port: 0, documentRoot: root });
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

/** Step 8's people form: its CSRF and the hash of the list it rendered. */
function formOf(html: string): { csrf: string; listHash: string } {
  const listHash = /name="listHash" value="([0-9a-f]+)"/.exec(html)?.[1];
  if (listHash === undefined) throw new Error('no listHash');
  return { csrf: csrfOf(html), listHash };
}

async function post(baseUrl: string, cookie: string, path: string, fields: Record<string, string | string[]>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { cookie }, body, redirect: 'manual' });
}

const seed = () => withBusiness(BUSINESS, (db) => saveSetupPackage(db, PACKAGE, 'tech'));

describe('the technician\'s setup data in the interview', () => {
  it('step 1 shows the address and the logo, read-only', async () => {
    await withBusiness(BUSINESS, (db) => saveAddress(db, 'רחוב הרצל 1, חולון', 'tech'));
    expect(await withBusiness(BUSINESS, (db) => saveLogo(db, PNG, root, 'tech'))).toBe('ok');
    const { baseUrl, cookie } = await start();
    const html = await (await get(baseUrl, cookie, '/setup/step/1')).text();
    expect(html).toContain('רחוב הרצל 1, חולון');
    expect(html).toContain('src="/setup/logo"');
    expect(html).toContain(PROFILE_CHANGE_NOTE);

    const logo = await get(baseUrl, cookie, '/setup/logo');
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(logo.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await logo.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('serves no logo when there is none', async () => {
    const { baseUrl, cookie } = await start();
    expect((await get(baseUrl, cookie, '/setup/logo')).status).toBe(404);
    expect(await (await get(baseUrl, cookie, '/setup/step/1')).text()).not.toContain(PROFILE_CHANGE_NOTE);
  });

  it('step 2 prefills the boss number with the note, until the draft has its own', async () => {
    await seed();
    const { baseUrl, cookie } = await start();
    const html = await (await get(baseUrl, cookie, '/setup/step/2')).text();
    expect(html).toContain(`name="whatsapp" value="${BOSS}"`);
    expect(html).toContain(BOSS_PREFILL_NOTE);

    await withBusiness(BUSINESS, (db) => saveSection(db, 'principal', { ...completeAnswers().principal, whatsapp: '+972509999999' }));
    const after = await (await get(baseUrl, cookie, '/setup/step/2')).text();
    expect(after).toContain('name="whatsapp" value="+972509999999"');
    expect(after).not.toContain(BOSS_PREFILL_NOTE);
  });

  it('step 8 lists contacts with an unchecked box and colleagues without one, labels escaped', async () => {
    await seed();
    const { baseUrl, cookie } = await start();
    const html = await (await get(baseUrl, cookie, '/setup/step/8')).text();
    expect(html).toContain('אנשי קשר וקולגות מההקמה');
    expect(html).toContain('מוכר (הוסף לרשימת המוכרים)');
    expect(html).toContain('אשר את הרשימה');
    expect(html).toContain('action="/setup/people"');
    expect((html.match(/name="known" value="\d+"/g) ?? []).length).toBe(2);
    expect(html).not.toMatch(/name="known" value="\d+" checked/);
    expect(html).toContain('יוסי');
    // The technician typed it: bidi controls stripped.
    expect(html).not.toContain('‮');
    expect(html).toContain('משה לוי');
  });

  it('POST /setup/people records the snapshot; the summary lists what signing adds', async () => {
    await seed();
    const { baseUrl, cookie } = await start();
    const { csrf, listHash } = formOf(await (await get(baseUrl, cookie, '/setup/step/8')).text());
    const res = await post(baseUrl, cookie, '/setup/people', { csrf, listHash, known: '0' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/setup/step/8');
    const draft = await withBusiness(BUSINESS, (db) => loadDraft(db));
    expect(draft?.answers.setupPeople?.contacts.map((c) => c.known)).toEqual([true, false]);

    const again = await (await get(baseUrl, cookie, '/setup/step/8')).text();
    expect(again).toMatch(/name="known" value="0" checked/);
  });

  it('the summary lists the people the signature will add', async () => {
    await seed();
    await withBusiness(BUSINESS, (db) => replaceDraft(db, completeAnswers(), null));
    const { baseUrl, cookie } = await start();
    const { csrf, listHash } = formOf(await (await get(baseUrl, cookie, '/setup/step/8')).text());
    await post(baseUrl, cookie, '/setup/people', { csrf, listHash, known: '0' });
    const summary = await get(baseUrl, cookie, '/setup/summary');
    expect(summary.status).toBe(200);
    const html = await summary.text();
    expect(html).toContain(SETUP_PEOPLE_SUMMARY_TITLE);
    expect(html).toContain('יוסי');
    expect(html).toContain('משה לוי');
    // Everyone in the package is in the snapshot: no leftover line.
    expect(html).not.toContain(UNCONFIRMED_SETUP_PEOPLE_NOTE);
  });

  it('the summary tells the owner about package people that signing will not add', async () => {
    await seed();
    await withBusiness(BUSINESS, (db) => replaceDraft(db, completeAnswers(), null));
    const { baseUrl, cookie } = await start();
    // Not confirmed at all.
    expect(await (await get(baseUrl, cookie, '/setup/summary')).text()).toContain(UNCONFIRMED_SETUP_PEOPLE_NOTE);
    // Confirmed, then the technician adds one more.
    const { csrf, listHash } = formOf(await (await get(baseUrl, cookie, '/setup/step/8')).text());
    await post(baseUrl, cookie, '/setup/people', { csrf, listHash });
    expect(await (await get(baseUrl, cookie, '/setup/summary')).text()).not.toContain(UNCONFIRMED_SETUP_PEOPLE_NOTE);
    await withBusiness(BUSINESS, (db) =>
      saveSetupPackage(db, { ...PACKAGE, colleagues: [...PACKAGE.colleagues, { name: 'חדש', role: 'עובד', phone: '+972501110010' }] }, 'tech'),
    );
    expect(await (await get(baseUrl, cookie, '/setup/summary')).text()).toContain(UNCONFIRMED_SETUP_PEOPLE_NOTE);
  });

  it('POST /setup/people refuses a list the technician changed after the page rendered', async () => {
    await seed();
    const { baseUrl, cookie } = await start();
    const { csrf, listHash } = formOf(await (await get(baseUrl, cookie, '/setup/step/8')).text());
    await withBusiness(BUSINESS, (db) =>
      saveSetupPackage(db, { ...PACKAGE, contacts: [PACKAGE.contacts[1]!, PACKAGE.contacts[0]!] }, 'tech'),
    );
    const res = await post(baseUrl, cookie, '/setup/people', { csrf, listHash, known: '0' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('הרשימה השתנתה');
    expect(await withBusiness(BUSINESS, (db) => loadDraft(db))).toBeNull();
  });

  it('POST /setup/people refuses a bad CSRF and bad indices, writing nothing', async () => {
    await seed();
    const { baseUrl, cookie } = await start();
    expect((await post(baseUrl, cookie, '/setup/people', { csrf: 'nope', known: '0' })).status).toBe(403);
    const { csrf, listHash } = formOf(await (await get(baseUrl, cookie, '/setup/step/8')).text());
    for (const bad of ['5', '-1', 'x', '1.5']) {
      expect((await post(baseUrl, cookie, '/setup/people', { csrf, listHash, known: bad })).status).toBe(400);
    }
    expect(await withBusiness(BUSINESS, (db) => loadDraft(db))).toBeNull();
  });
});
