import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { createTestOwner, loginWithSecondFactor, TEST_MASTER_KEY } from '../test/owner.js';
import { issueCsrfToken } from './csrf.js';
import { PUBLIC_DOCUMENTS_PATH, PUBLIC_FOREIGN_WARNING } from './public-documents-routes.js';
import { createServer } from './server.js';

const BUSINESS = 'wa-pubdocs-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
let server: Server | null = null;

beforeEach(async () => {
  await resetDatabase();
  await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({ version: 'v-pub-1' })));
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

async function seed(business: string, id: string, source: string, name = `${id}.pdf`) {
  await testDb().query(
    `INSERT INTO documents (business_id, document_id, sha256, original_name, media_type, byte_size, source, status, stored_path)
     VALUES ($1, $2, $3, $4, 'text/plain', 10, $5, 'extracted', $6)`,
    [business, id, id.padEnd(64, '0'), name, source, `x/${id}`],
  );
}
const publicFor = async (id: string) =>
  (await testDb().query(`SELECT public_for FROM documents WHERE document_id = $1`, [id])).rows[0]?.public_for ?? null;

async function start() {
  server = createServer({ masterKey: TEST_MASTER_KEY, port: 0 });
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = await loginWithSecondFactor(baseUrl, BUSINESS, { username: USERNAME, password: PASSWORD });
  const csrf = issueCsrfToken(cookie.split('=')[1] ?? '');
  const post = (fields: Record<string, string>) =>
    fetch(`${baseUrl}${PUBLIC_DOCUMENTS_PATH}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams(fields), redirect: 'manual' });
  return { baseUrl, cookie, csrf, post };
}

describe('public documents screen', () => {
  it('lists documents and marks an owner-originated one public without a second confirm', async () => {
    await seed(BUSINESS, 'DOC-OWN', 'instruction', 'מחירון.pdf');
    const { baseUrl, cookie, csrf, post } = await start();
    const html = await (await fetch(`${baseUrl}${PUBLIC_DOCUMENTS_PATH}`, { headers: { cookie } })).text();
    expect(html).toContain('מחירון.pdf');
    expect((await post({ csrf, documentId: 'DOC-OWN', publicFor: 'client' })).status).toBe(200);
    expect(await publicFor('DOC-OWN')).toBe('client');
    expect((await post({ csrf, documentId: 'DOC-OWN', publicFor: '' })).status).toBe(200);
    expect(await publicFor('DOC-OWN')).toBeNull();
  });

  it('refuses a POST without CSRF', async () => {
    await seed(BUSINESS, 'DOC-OWN', 'instruction');
    const { post } = await start();
    expect((await post({ csrf: 'bad', documentId: 'DOC-OWN', publicFor: 'both' })).status).toBe(403);
    expect(await publicFor('DOC-OWN')).toBeNull();
  });

  it('requires confirmForeign for a mail document, checked server-side', async () => {
    await seed(BUSINESS, 'DOC-MAIL', 'mail');
    const { baseUrl, cookie, csrf, post } = await start();
    const html = await (await fetch(`${baseUrl}${PUBLIC_DOCUMENTS_PATH}`, { headers: { cookie } })).text();
    expect(html).toContain(PUBLIC_FOREIGN_WARNING.slice(0, 20));
    const refused = await post({ csrf, documentId: 'DOC-MAIL', publicFor: 'both' });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(PUBLIC_FOREIGN_WARNING.slice(0, 20));
    expect(await publicFor('DOC-MAIL')).toBeNull();
    expect((await post({ csrf, documentId: 'DOC-MAIL', publicFor: 'both', confirmForeign: '1' })).status).toBe(200);
    expect(await publicFor('DOC-MAIL')).toBe('both');
  });

  it('treats any non-owner source (inbox folder) as foreign', async () => {
    await seed(BUSINESS, 'DOC-MAN', 'manual');
    const { csrf, post } = await start();
    expect((await post({ csrf, documentId: 'DOC-MAN', publicFor: 'client' })).status).toBe(400);
    expect(await publicFor('DOC-MAN')).toBeNull();
  });

  it('returns 404 for another business’s document and leaves it untouched', async () => {
    await seed('other-biz', 'DOC-X', 'instruction');
    const { csrf, post } = await start();
    expect((await post({ csrf, documentId: 'DOC-X', publicFor: 'client' })).status).toBe(404);
    expect(await publicFor('DOC-X')).toBeNull();
  });
});
