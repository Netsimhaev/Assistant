import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { loadProfile } from '../business/profile.js';
import { createTestOwner, TEST_MASTER_KEY, loginWithSecondFactor } from '../test/owner.js';
import { createServer } from './server.js';

const BUSINESS = 'profile-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';
const PROFILE = '/settings/profile';

/** The smallest valid PNG: signature, IHDR, IEND. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(32, 1),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  Buffer.from([0xff, 0xd9]),
]);

let server: Server | null = null;
let root = '';

beforeEach(async () => {
  await resetDatabase();
  await createTestOwner(BUSINESS, { username: USERNAME, password: PASSWORD });
  await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({ version: 'v-profile-1' })));
  root = await mkdtemp(join(tmpdir(), 'profile-routes-'));
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

async function upload(baseUrl: string, cookie: string, fields: Record<string, string>, file: Buffer, name: string) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('logo', new Blob([file]), name);
  return fetch(`${baseUrl}${PROFILE}/logo`, { method: 'POST', headers: { cookie }, body: form, redirect: 'manual' });
}

describe('/settings/profile', () => {
  it('saves the address', async () => {
    const { baseUrl, cookie } = await start();
    const csrf = csrfOf(await (await get(baseUrl, cookie, PROFILE)).text());
    const res = await fetch(`${baseUrl}${PROFILE}`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, address: 'הרצל 1, חולון' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect((await withBusiness(BUSINESS, (db) => loadProfile(db))).address).toBe('הרצל 1, חולון');
    expect(await (await get(baseUrl, cookie, PROFILE)).text()).toContain('הרצל 1, חולון');
  });

  it('uploads a logo and serves it inline with nosniff and its sniffed type', async () => {
    const { baseUrl, cookie } = await start();
    const csrf = csrfOf(await (await get(baseUrl, cookie, PROFILE)).text());
    // JPEG bytes under a .png name are stored and served as JPEG.
    const res = await upload(baseUrl, cookie, { csrf }, JPEG, 'logo.png');
    expect(res.status).toBe(303);
    const logo = await get(baseUrl, cookie, `${PROFILE}/logo`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/jpeg');
    expect(logo.headers.get('x-content-type-options')).toBe('nosniff');
    expect(logo.headers.get('content-disposition')).toBe('inline');
    expect(Buffer.from(await logo.arrayBuffer()).equals(JPEG)).toBe(true);

    await upload(baseUrl, cookie, { csrf }, PNG, 'logo.png');
    const png = await get(baseUrl, cookie, `${PROFILE}/logo`);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(await (await get(baseUrl, cookie, PROFILE)).text()).toContain(`src="${PROFILE}/logo"`);
  });

  it('refuses an SVG in Hebrew and stores nothing', async () => {
    const { baseUrl, cookie } = await start();
    const csrf = csrfOf(await (await get(baseUrl, cookie, PROFILE)).text());
    const res = await upload(baseUrl, cookie, { csrf }, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.png');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('PNG או JPEG');
    expect((await withBusiness(BUSINESS, (db) => loadProfile(db))).logo).toBeNull();
    expect((await get(baseUrl, cookie, `${PROFILE}/logo`)).status).toBe(404);
  });

  it('refuses a POST without CSRF and writes nothing', async () => {
    const { baseUrl, cookie } = await start();
    const res = await fetch(`${baseUrl}${PROFILE}`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ address: 'הרצל 1' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    const logo = await upload(baseUrl, cookie, { csrf: 'deadbeef' }, PNG, 'logo.png');
    expect(logo.status).toBe(403);
    expect(await withBusiness(BUSINESS, (db) => loadProfile(db))).toEqual({ address: null, logo: null });
  });
});
