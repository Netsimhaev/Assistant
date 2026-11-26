import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { crmConnection, crmFixture } from '../test/external-fixtures.js';
import { issueCsrfToken } from './csrf.js';
import { loadContactWaSettings } from '../whatsapp/sources/invoice-settings.js';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { createTestOwner, loginWithSecondFactor, TEST_MASTER_KEY } from '../test/owner.js';
import { createServer } from './server.js';
import { insertSuggestion, shapeHashFor } from '../whatsapp/contact-suggestions.js';
import { SUGGESTION_APPLIED, SUGGESTION_FAILED } from '../whatsapp/suggestion-whatsapp.js';
import {
  AUTO_REPLY_MISSING_SIGNATURE,
  AUTO_REPLY_MISSING_TOGGLE,
  CONTACT_WHATSAPP_SETTINGS_PATH,
} from './contact-whatsapp-settings.js';

const BUSINESS = 'wa-settings-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

let server: Server | null = null;

beforeEach(async () => {
  await resetDatabase();
  await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({ version: 'v-wa-1' })));
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

describe('POST /settings/whatsapp-contacts', () => {
  it('refuses a bad CSRF token with 403 and writes nothing', async () => {
    server = createServer({ masterKey: TEST_MASTER_KEY, port: 0 });
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = await loginWithSecondFactor(baseUrl, BUSINESS, { username: USERNAME, password: PASSWORD });
    const res = await fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: 'bad', system: 'crm', operation: 'list_invoices', param: 'p', field: 'f' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    const { rows } = await testDb().query(`SELECT 1 FROM contact_whatsapp_settings WHERE business_id = $1`, [BUSINESS]);
    expect(rows).toHaveLength(0);
  });

  async function start() {
    await withBusiness(BUSINESS, (db) =>
      installCharter(db, buildCharter({ version: 'v-wa-2', externalSystems: [crmFixture()], connections: [crmConnection()] })),
    );
    server = createServer({ masterKey: TEST_MASTER_KEY, port: 0 });
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = await loginWithSecondFactor(baseUrl, BUSINESS, { username: USERNAME, password: PASSWORD });
    const sessionId = cookie.split('=')[1] ?? '';
    return { baseUrl, cookie, sessionId };
  }

  it('adds and removes an external sender source behind CSRF', async () => {
    const { baseUrl, cookie, sessionId } = await start();
    const csrf = issueCsrfToken(sessionId);
    const post = (fields: Record<string, string>) =>
      fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(fields), redirect: 'manual' });
    const add = await post({ csrf, action: 'add_source', system: 'crm', operation: 'get_customer', param: 'customer_id', field: 'data.name' });
    expect(add.status).toBe(200);
    const added = await withBusiness(BUSINESS, (db) => loadContactWaSettings(db));
    expect(added.externalSources).toEqual([{ systemId: 'crm', operation: 'get_customer', param: 'customer_id', field: 'data.name' }]);
    const bad = await post({ csrf: 'bad', action: 'remove_source', system: 'crm', operation: 'get_customer' });
    expect(bad.status).toBe(403);
    expect((await withBusiness(BUSINESS, (db) => loadContactWaSettings(db))).externalSources).toHaveLength(1);
    const rm = await post({ csrf, action: 'remove_source', system: 'crm', operation: 'get_customer' });
    expect(rm.status).toBe(200);
    expect((await withBusiness(BUSINESS, (db) => loadContactWaSettings(db))).externalSources).toEqual([]);
  });

  it('removes a source even when another remaining entry went stale', async () => {
    const { baseUrl, cookie, sessionId } = await start();
    await testDb().query(
      `INSERT INTO contact_whatsapp_settings (business_id, external_sources) VALUES ($1, $2::jsonb)
       ON CONFLICT (business_id) DO UPDATE SET external_sources = EXCLUDED.external_sources`,
      [
        BUSINESS,
        JSON.stringify([
          { systemId: 'crm', operation: 'gone_operation', param: 'customer_id', field: 'data.name' },
          { systemId: 'crm', operation: 'get_customer', param: 'customer_id', field: 'data.name' },
        ]),
      ],
    );
    const res = await fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: issueCsrfToken(sessionId), action: 'remove_source', system: 'crm', operation: 'get_customer' }),
    });
    expect(res.status).toBe(200);
    expect((await withBusiness(BUSINESS, (db) => loadContactWaSettings(db))).externalSources.map((s) => s.operation)).toEqual(['gone_operation']);
  });

  it('toggles auto-reply behind CSRF and says which switch is missing', async () => {
    const { baseUrl, cookie, sessionId } = await start();
    const post = (fields: Record<string, string>) =>
      fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(fields) });
    const before = await (await fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, { headers: { cookie } })).text();
    expect(before).toContain(AUTO_REPLY_MISSING_SIGNATURE);
    expect(before).toContain(AUTO_REPLY_MISSING_TOGGLE);
    expect((await post({ csrf: 'bad', action: 'auto_reply', enabled: '1' })).status).toBe(403);
    expect((await withBusiness(BUSINESS, (db) => loadContactWaSettings(db))).autoReplyEnabled).toBe(false);
    expect((await post({ csrf: issueCsrfToken(sessionId), action: 'auto_reply', enabled: '1' })).status).toBe(200);
    expect((await withBusiness(BUSINESS, (db) => loadContactWaSettings(db))).autoReplyEnabled).toBe(true);
    const on = await (await fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, { headers: { cookie } })).text();
    expect(on).not.toContain(AUTO_REPLY_MISSING_TOGGLE);
    expect(on).toContain(AUTO_REPLY_MISSING_SIGNATURE);
    await post({ csrf: issueCsrfToken(sessionId), action: 'auto_reply' });
    expect((await withBusiness(BUSINESS, (db) => loadContactWaSettings(db))).autoReplyEnabled).toBe(false);
  });

  it('refuses a source whose operation is not a signed read, saving nothing', async () => {
    const { baseUrl, cookie, sessionId } = await start();
    const res = await fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: issueCsrfToken(sessionId), action: 'add_source', system: 'crm', operation: 'update_customer', param: 'customer_id', field: 'data.name' }),
    });
    expect(res.status).toBe(400);
    expect((await withBusiness(BUSINESS, (db) => loadContactWaSettings(db))).externalSources).toEqual([]);
  });
});

describe('suggestions section', () => {
  async function startPlain() {
    server = createServer({ masterKey: TEST_MASTER_KEY, port: 0 });
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = await loginWithSecondFactor(baseUrl, BUSINESS, { username: USERNAME, password: PASSWORD });
    return { baseUrl, cookie, sessionId: cookie.split('=')[1] ?? '' };
  }
  const payload = { name: 'שעות פתיחה', description: 'שאלות על שעות', appliesTo: 'both', sources: [], decisionIds: ['a', 'b', 'c', 'd', 'e'] };
  async function seed(business: string, hash: string): Promise<string> {
    const s = await withBusiness(business, (db) => insertSuggestion(db, 'new_topic', payload as never, shapeHashFor({ kind: 'new_topic', name: hash })));
    return s?.suggestionId ?? '';
  }
  const topics = (business: string) =>
    testDb().query(`SELECT 1 FROM contact_topics WHERE business_id = $1`, [business]).then((r) => r.rows.length);

  it('lists an open suggestion with its text and no raw id', async () => {
    const id = await seed(BUSINESS, 'h-list');
    const { baseUrl, cookie } = await startPlain();
    const text = await (await fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, { headers: { cookie } })).text();
    expect(text).toContain('שעות פתיחה');
    expect(text).toContain('הצעות');
    expect(text.replace(/name="suggestionId" value="[^"]*"/g, '')).not.toContain(id);
  });

  it('accept creates the topic, reject leaves none', async () => {
    const id = await seed(BUSINESS, 'h-acc');
    const { baseUrl, cookie, sessionId } = await startPlain();
    const post = (f: Record<string, string>) =>
      fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(f) });
    expect((await post({ csrf: issueCsrfToken(sessionId), action: 'suggestion', suggestionId: id, decision: 'reject' })).status).toBe(200);
    expect(await topics(BUSINESS)).toBe(0);
    const id2 = await seed(BUSINESS, 'h-acc2');
    const res = await post({ csrf: issueCsrfToken(sessionId), action: 'suggestion', suggestionId: id2, decision: 'accept' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SUGGESTION_APPLIED);
    expect(await topics(BUSINESS)).toBe(1);
  });

  it("says the new-topic count is the owner's decisions", async () => {
    await seed(BUSINESS, 'h-count');
    const { baseUrl, cookie } = await startPlain();
    const text = await (await fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, { headers: { cookie } })).text();
    expect(text).toContain('5 הכרעות שלך');
    expect(text).not.toContain('תשובות שאישרת)');
  });

  it('an accept whose effect throws shows SUGGESTION_FAILED, not a 500, and leaves it open', async () => {
    // appliesTo the topic store refuses: the stale check passes, createTopic throws.
    const s = await withBusiness(BUSINESS, (db) =>
      insertSuggestion(db, 'new_topic', { ...payload, appliesTo: 'nobody' } as never, shapeHashFor({ kind: 'new_topic', name: 'h-throw' })),
    );
    const { baseUrl, cookie, sessionId } = await startPlain();
    const res = await fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, {
      method: 'POST', headers: { cookie },
      body: new URLSearchParams({ csrf: issueCsrfToken(sessionId), action: 'suggestion', suggestionId: s!.suggestionId, decision: 'accept' }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SUGGESTION_FAILED);
    expect(await topics(BUSINESS)).toBe(0);
    const { rows } = await testDb().query(`SELECT state FROM contact_suggestions WHERE suggestion_id = $1`, [s!.suggestionId]);
    expect(rows[0]?.state).toBe('open');
  });

  it('refuses a bad CSRF token and changes nothing', async () => {
    const id = await seed(BUSINESS, 'h-csrf');
    const { baseUrl, cookie } = await startPlain();
    const res = await fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, {
      method: 'POST', headers: { cookie },
      body: new URLSearchParams({ csrf: 'bad', action: 'suggestion', suggestionId: id, decision: 'accept' }),
    });
    expect(res.status).toBe(403);
    expect(await topics(BUSINESS)).toBe(0);
    const { rows } = await testDb().query(`SELECT state FROM contact_suggestions WHERE suggestion_id = $1`, [id]);
    expect(rows[0]?.state).toBe('open');
  });

  it("answers 404 for another business's suggestion and leaves it open", async () => {
    await createTestOwner('other-wa-business', { username: 'o2', password: PASSWORD });
    const foreign = await seed('other-wa-business', 'h-foreign');
    const { baseUrl, cookie, sessionId } = await startPlain();
    const res = await fetch(`${baseUrl}${CONTACT_WHATSAPP_SETTINGS_PATH}`, {
      method: 'POST', headers: { cookie },
      body: new URLSearchParams({ csrf: issueCsrfToken(sessionId), action: 'suggestion', suggestionId: foreign, decision: 'accept' }),
    });
    expect(res.status).toBe(404);
    const { rows } = await testDb().query(`SELECT state FROM contact_suggestions WHERE suggestion_id = $1`, [foreign]);
    expect(rows[0]?.state).toBe('open');
    expect(await topics('other-wa-business')).toBe(0);
  });
});
