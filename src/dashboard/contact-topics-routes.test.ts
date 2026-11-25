import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { createTestOwner, loginWithSecondFactor, TEST_MASTER_KEY } from '../test/owner.js';
import { listTopics } from '../whatsapp/contact-topics.js';
import { CONTACT_TOPICS_PATH } from './contact-topics-routes.js';
import { issueCsrfToken } from './csrf.js';
import { createServer } from './server.js';

const BUSINESS = 'wa-topics-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
let server: Server | null = null;

beforeEach(async () => {
  await resetDatabase();
  await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({ version: 'v-topics-1' })));
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

async function start() {
  server = createServer({ masterKey: TEST_MASTER_KEY, port: 0 });
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = await loginWithSecondFactor(baseUrl, BUSINESS, { username: USERNAME, password: PASSWORD });
  const csrf = issueCsrfToken(cookie.split('=')[1] ?? '');
  const post = (fields: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return fetch(`${baseUrl}${CONTACT_TOPICS_PATH}`, { method: 'POST', headers: { cookie }, body, redirect: 'manual' });
  };
  return { baseUrl, cookie, csrf, post };
}

const topics = () => withBusiness(BUSINESS, (db) => listTopics(db, { includeRetired: true }));

describe('topics screen', () => {
  it('creates a topic via POST and lists it', async () => {
    const { baseUrl, cookie, csrf, post } = await start();
    const res = await post({ csrf, action: 'create', name: 'שעות פעילות', description: 'מתי פתוח', appliesTo: 'both', sources: ['calendar_busy', 'bogus'] });
    expect(res.status).toBe(200);
    const [t] = await topics();
    expect(t?.name).toBe('שעות פעילות');
    expect(t?.sources).toEqual(['calendar_busy']);
    const html = await (await fetch(`${baseUrl}${CONTACT_TOPICS_PATH}`, { headers: { cookie } })).text();
    expect(html).toContain('שעות פעילות');
    expect(html).toContain('יומן (פנוי/תפוס)');
  });

  it('refuses a POST without a valid CSRF token and writes nothing', async () => {
    const { post } = await start();
    const res = await post({ csrf: 'bad', action: 'create', name: 'x', appliesTo: 'both' });
    expect(res.status).toBe(403);
    expect(await topics()).toHaveLength(0);
  });

  it('toggles auto-reply and retire hides the topic', async () => {
    const { baseUrl, cookie, csrf, post } = await start();
    await post({ csrf, action: 'create', name: 'נושא א', description: '', appliesTo: 'client' });
    const id = (await topics())[0]?.topicId ?? '';
    expect((await post({ csrf, action: 'toggle', topicId: id, on: '1' })).status).toBe(200);
    expect((await topics())[0]?.autoReply).toBe(true);
    expect((await post({ csrf, action: 'toggle', topicId: id, on: '0' })).status).toBe(200);
    expect((await topics())[0]?.autoReply).toBe(false);
    expect((await post({ csrf, action: 'retire', topicId: id })).status).toBe(200);
    expect((await topics())[0]?.retiredAt).not.toBeNull();
    const html = await (await fetch(`${baseUrl}${CONTACT_TOPICS_PATH}`, { headers: { cookie } })).text();
    expect(html).not.toContain('נושא א');
  });

  it('edits a topic and rejects an empty name', async () => {
    const { csrf, post } = await start();
    await post({ csrf, action: 'create', name: 'ישן', description: '', appliesTo: 'client' });
    const id = (await topics())[0]?.topicId ?? '';
    expect((await post({ csrf, action: 'edit', topicId: id, name: 'חדש', description: 'ד', appliesTo: 'supplier', sources: ['public'] })).status).toBe(200);
    const t = (await topics())[0];
    expect([t?.name, t?.appliesTo, t?.sources]).toEqual(['חדש', 'supplier', ['public']]);
    expect((await post({ csrf, action: 'edit', topicId: id, name: ' ', appliesTo: 'supplier' })).status).toBe(400);
    expect((await topics())[0]?.name).toBe('חדש');
  });

  it('cannot touch another business’s topic', async () => {
    const { csrf, post } = await start();
    await testDb().query(
      `INSERT INTO contact_topics (business_id, topic_id, name, description, applies_to, sources, auto_reply, created_by)
       VALUES ('other-biz', 'T-OTHER', 'זר', '', 'both', '{}', false, 'x')`,
    );
    expect((await post({ csrf, action: 'toggle', topicId: 'T-OTHER', on: '1' })).status).toBe(404);
    const { rows } = await testDb().query(`SELECT auto_reply FROM contact_topics WHERE topic_id = 'T-OTHER'`);
    expect(rows[0]?.auto_reply).toBe(false);
  });

  it('answers 404 and changes nothing when editing or retiring another business topic', async () => {
    const { csrf, post } = await start();
    await testDb().query(
      `INSERT INTO contact_topics (business_id, topic_id, name, description, applies_to, sources, auto_reply, created_by)
       VALUES ('other-biz', 'T-OTHER', 'זר', '', 'both', '{}', false, 'x')`,
    );
    expect((await post({ csrf, action: 'edit', topicId: 'T-OTHER', name: 'פרוץ', appliesTo: 'client' })).status).toBe(404);
    expect((await post({ csrf, action: 'retire', topicId: 'T-OTHER' })).status).toBe(404);
    const { rows } = await testDb().query(`SELECT name, retired_at FROM contact_topics WHERE topic_id = 'T-OTHER'`);
    expect([rows[0]?.name, rows[0]?.retired_at]).toEqual(['זר', null]);
  });

  it('refuses a toggle with a bad CSRF token', async () => {
    const { csrf, post } = await start();
    await post({ csrf, action: 'create', name: 'א', description: '', appliesTo: 'client' });
    const id = (await topics())[0]?.topicId ?? '';
    expect((await post({ csrf: 'bad', action: 'toggle', topicId: id, on: '1' })).status).toBe(403);
    expect((await topics())[0]?.autoReply).toBe(false);
  });
});
