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
import { CONTACT_WHATSAPP_SETTINGS_PATH } from './contact-whatsapp-settings.js';

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
