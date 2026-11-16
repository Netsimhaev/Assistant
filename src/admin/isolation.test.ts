/**
 * The panel and the dashboard are two servers with two cookie names and two
 * session tables. A cookie of one must be nobody on the other, under either
 * name. Each half also proves its server was reachable: the legitimate cookie
 * gets 200, so a 3xx is the refusal and not a server that answered nothing.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createTestOwner, loginWithSecondFactor, TEST_MASTER_KEY } from '../test/owner.js';
import { currentStep, totpCode } from '../auth/totp.js';
import { createHeadStaff, staffBeginEnrolment, staffConfirmEnrolment, startStaffSession } from '../tenancy/staff.js';
import { createServer } from '../dashboard/server.js';
import { createAdminServer } from './server.js';

const BUSINESS = 'test-business';
const PASSWORD = 'correct horse battery staple';

const servers: Server[] = [];

beforeEach(async () => {
  await resetDatabase();
  await createTestOwner(BUSINESS, { username: 'owner', password: PASSWORD });
  await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({ version: 'iso-charter' })));
});

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function getHome(baseUrl: string, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}/`, { headers: { cookie }, redirect: 'manual' });
}

/** The value of an owner's `sid` cookie, past both factors. */
async function ownerSidValue(dashboardUrl: string): Promise<string> {
  const pair = await loginWithSecondFactor(dashboardUrl, BUSINESS, { password: PASSWORD });
  return pair.slice('sid='.length);
}

/** A full staff session token (enrolled, owes nothing). */
async function staffToken(): Promise<string> {
  const id = await createHeadStaff({ login: 'head@company.example', displayName: 'ראש', password: 'head password long' });
  const { secretBase32 } = await staffBeginEnrolment(id, TEST_MASTER_KEY);
  const past = new Date(Date.now() - 90_000);
  await staffConfirmEnrolment(id, totpCode(secretBase32, currentStep(past)), TEST_MASTER_KEY, past);
  return startStaffSession(id, { pendingFactor: null });
}

describe('panel and dashboard sessions do not cross', () => {
  it('(a) an owner sid is nobody on the panel', async () => {
    const dashboard = await listen(createServer({ port: 0, masterKey: TEST_MASTER_KEY }));
    const panel = await listen(
      createAdminServer({
        port: 0,
        masterKey: TEST_MASTER_KEY,
        documentRoot: 'unused',
        dashboardBaseUrl: 'https://dashboard.example',
      }),
    );
    const sid = await ownerSidValue(dashboard);
    // The owner's cookie is live on its own server.
    expect((await getHome(dashboard, `sid=${sid}`)).status).toBe(200);

    // The shape cases fail before any lookup. The bare token is well-formed
    // for the panel (64 hex), so its refusal must come from the session
    // lookup: the owner's token is not in the panel's session table.
    const bare = sid.split('.')[1] ?? '';
    expect(bare).toMatch(/^[0-9a-f]{64}$/);
    for (const cookie of [`asid=${sid}`, `sid=${sid}`, `asid=${bare}`]) {
      const res = await getHome(panel, cookie);
      expect(res.status, cookie).toBe(303);
      expect(res.headers.get('location'), cookie).toBe('/login');
    }

    // And the panel is reachable: a real staff session gets 200.
    expect((await getHome(panel, `asid=${await staffToken()}`)).status).toBe(200);
  });

  it('(b) a staff asid is nobody on the dashboard', async () => {
    const dashboard = await listen(createServer({ port: 0, masterKey: TEST_MASTER_KEY }));
    const panel = await listen(
      createAdminServer({
        port: 0,
        masterKey: TEST_MASTER_KEY,
        documentRoot: 'unused',
        dashboardBaseUrl: 'https://dashboard.example',
      }),
    );
    const asid = await staffToken();
    expect((await getHome(panel, `asid=${asid}`)).status).toBe(200);

    // `<business>.<staff token>` is well-formed for the dashboard, so its
    // refusal must come from the dashboard's own session lookup.
    for (const cookie of [`sid=${asid}`, `asid=${asid}`, `sid=${BUSINESS}.${asid}`]) {
      const res = await getHome(dashboard, cookie);
      // The dashboard's own redirect to /login is a 302 (unchanged here); a
      // refusal either way, never the page.
      expect([302, 303], cookie).toContain(res.status);
      expect(res.headers.get('location'), cookie).toBe('/login');
    }

    const owner = await getHome(dashboard, `sid=${await ownerSidValue(dashboard)}`);
    expect(owner.status).toBe(200);
    // Links carry tokens in the path: the dashboard sends no referrer either.
    expect(owner.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
