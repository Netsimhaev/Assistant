/** Route tests for connecting WhatsApp to clients and suppliers (phase 1). */
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryAudit } from '../audit/log.js';
import { WHATSAPP_CONTACTS_SYSTEM } from '../charter/amend-whatsapp-contacts.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import { KEY_BYTES, writeKeyState } from '../governance/master-key.js';
import { putSecret } from '../governance/credential-store.js';
import { GREEN_API_INSTANCE_ID_REF, GREEN_API_TOKEN_REF } from '../orchestrator/runtime.js';
import { loadBindings } from '../orchestrator/bindings.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase, testDb } from '../test/db.js';
import { createTestOwner, TEST_MASTER_KEY, loginWithSecondFactor } from '../test/owner.js';
import { issueCsrfToken } from './csrf.js';
import { WHATSAPP_CONTACTS_AUTHORISATION_TEXT } from './whatsapp-contacts-connect.js';
import { createServer } from './server.js';

const BUSINESS = 'test-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

let server: Server | null = null;
let keyDir: string;
let keyPath: string;
let masterKey: Buffer;

beforeEach(async () => {
  await resetDatabase();
  keyDir = await mkdtemp(join(tmpdir(), 'wac-connect-'));
  keyPath = join(keyDir, 'master.key');
  const key = randomBytes(KEY_BYTES);
  masterKey = key;
  await writeFile(keyPath, key, { mode: 0o600 });
  await writeKeyState(key, 'KEY-test', testDb());
  await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await rm(keyDir, { recursive: true, force: true });
});
afterAll(async () => {
  await closePool();
});

async function startServer(): Promise<string> {
  server = createServer({ masterKey: TEST_MASTER_KEY, port: 0, credentialKeyPath: keyPath, dashboardBaseUrl: 'http://127.0.0.1:4173' });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const login = (b: string) => loginWithSecondFactor(b, BUSINESS, { username: USERNAME, password: PASSWORD });
function csrfFor(cookie: string): string {
  const id = cookie.split('=')[1];
  if (id === undefined) throw new Error('bad cookie');
  return issueCsrfToken(id);
}
const post = (b: string, cookie: string, path: string, f: Record<string, string>) =>
  fetch(`${b}${path}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(f), redirect: 'manual' });
const activeVersion = async () => (await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb)))?.charter.charterVersion ?? '';

describe('whatsapp-contacts connection', () => {
  it('the status page shows the phase-1 authorisation text', async () => {
    const b = await startServer();
    const cookie = await login(b);
    const html = await (await fetch(`${b}/connections/whatsapp-contacts`, { headers: { cookie } })).text();
    expect(html).toContain(WHATSAPP_CONTACTS_AUTHORISATION_TEXT);
    expect(html).toContain('action="/connections/whatsapp-contacts/sign"');
  });

  it('signs: the charter gains the connection, a live binding is written, an audit row exists', async () => {
    const b = await startServer();
    const cookie = await login(b);
    const res = await post(b, cookie, '/connections/whatsapp-contacts/sign', { csrf: csrfFor(cookie), base: await activeVersion() });
    expect(res.status).toBe(303);
    const after = await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb));
    expect(after?.charter.connections.map((c) => c.system)).toContain(WHATSAPP_CONTACTS_SYSTEM);
    expect(after?.charter.data.subprocessorsAllowed).toContain('green-api');
    const bindings = await withBusiness(BUSINESS, (bdb) => loadBindings(bdb));
    expect(bindings.find((x) => x.system === WHATSAPP_CONTACTS_SYSTEM)?.status).toBe('live');
    expect((await withBusiness(BUSINESS, (bdb) => queryAudit(bdb))).some((r) => r.kind === 'charter_change')).toBe(true);
  });

  it('a stale base re-renders and installs nothing', async () => {
    const b = await startServer();
    const cookie = await login(b);
    const res = await post(b, cookie, '/connections/whatsapp-contacts/sign', { csrf: csrfFor(cookie), base: 'old' });
    expect(res.status).toBe(409);
    expect((await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb)))?.charter.connections.map((c) => c.system)).not.toContain(WHATSAPP_CONTACTS_SYSTEM);
    expect(await withBusiness(BUSINESS, (bdb) => loadBindings(bdb))).toEqual([]);
  });

  it('does not say active until the GREEN-API secrets are stored', async () => {
    const b = await startServer();
    const cookie = await login(b);
    await post(b, cookie, '/connections/whatsapp-contacts/sign', { csrf: csrfFor(cookie), base: await activeVersion() });
    const before = await (await fetch(`${b}/connections/whatsapp-contacts`, { headers: { cookie } })).text();
    expect(before).toContain('חתום — ממתין לחיבור וואטסאפ');
    expect(before).not.toContain('<b>פעיל</b>');
    await withBusiness(BUSINESS, async (bdb) => {
      await putSecret(bdb, { ref: GREEN_API_INSTANCE_ID_REF, value: 'i', updatedBy: 'test' }, masterKey);
      await putSecret(bdb, { ref: GREEN_API_TOKEN_REF, value: 't', updatedBy: 'test' }, masterKey);
    });
    const after = await (await fetch(`${b}/connections/whatsapp-contacts`, { headers: { cookie } })).text();
    expect(after).toContain('<b>פעיל</b>');
  });

  it('refuses a bad CSRF token', async () => {
    const b = await startServer();
    const cookie = await login(b);
    expect((await post(b, cookie, '/connections/whatsapp-contacts/sign', { csrf: 'nope', base: await activeVersion() })).status).toBe(403);
  });

  it('reverts: the connection is removed and the binding disconnected', async () => {
    const b = await startServer();
    const cookie = await login(b);
    await post(b, cookie, '/connections/whatsapp-contacts/sign', { csrf: csrfFor(cookie), base: await activeVersion() });
    const res = await post(b, cookie, '/connections/whatsapp-contacts/revert', { csrf: csrfFor(cookie), base: await activeVersion() });
    expect(res.status).toBe(303);
    expect((await withBusiness(BUSINESS, (bdb) => loadActiveCharter(bdb)))?.charter.connections.map((c) => c.system)).not.toContain(WHATSAPP_CONTACTS_SYSTEM);
    const bindings = await withBusiness(BUSINESS, (bdb) => loadBindings(bdb));
    expect(bindings.find((x) => x.system === WHATSAPP_CONTACTS_SYSTEM)?.status).toBe('disconnected');
  });
});
