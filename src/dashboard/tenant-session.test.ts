/**
 * One dashboard for every business (spec §5.5): the login is an email that
 * is unique across the server and decides the business; the session cookie
 * carries `<businessId>.<token>` and is read inside that business's
 * `withBusiness`; a suspended business is refused at login and on every
 * request of a live session; an OAuth state minted for another business never
 * writes a grant.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { enqueueApproval } from '../governance/approvals.js';
import { canonicalHash } from '../util/canonical.js';
import type { ActionFacts } from '../domain/policy.js';
import type { RiskAssessment } from '../domain/risk.js';
import { resolveLogin } from '../tenancy/platform.js';
import { run as createOwnerRun } from '../cli/create-owner.js';
import type { PromptIo } from '../cli/prompt-io.js';
import { createOwner, parseSessionCookie, sessionCookieValue } from './auth.js';
import { createServer } from './server.js';

const A = 'tenant-a';
const B = 'tenant-b';
const A_LOGIN = 'dana@tenant-a.example';
const B_LOGIN = 'yossi@tenant-b.example';
const PASSWORD = 'correct horse battery staple';
const SUSPENDED = 'החשבון מושהה — פנה למנהל המערכת';

let server: Server | null = null;

beforeEach(async () => {
  await resetDatabase();
  await registerBusiness(A);
  await registerBusiness(B);
  await withBusiness(A, (db) => createOwner(db, { username: 'owner', login: A_LOGIN, password: PASSWORD }));
  await withBusiness(B, (db) => createOwner(db, { username: 'owner', login: B_LOGIN, password: PASSWORD }));
  for (const id of [A, B]) {
    await withBusiness(id, (db) => installCharter(db, buildCharter({ version: `gate-${id}` })));
  }
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

async function startServer(): Promise<string> {
  server = createServer({ port: 0 });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function postLogin(baseUrl: string, email: string, password: string): Promise<Response> {
  return fetch(`${baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ email, password }),
    redirect: 'manual',
  });
}

async function loginCookie(baseUrl: string, email: string): Promise<string> {
  const res = await postLogin(baseUrl, email, PASSWORD);
  expect(res.status).toBe(302);
  const pair = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (!pair) throw new Error('no session cookie');
  return pair;
}

function facts(proposedInput: unknown): ActionFacts {
  return {
    toolName: 'mail.send',
    actionClass: 'email.initiate',
    amountMinor: 0,
    amountDeclared: false,
    counterpartyId: null,
    counterpartyEmails: [],
    counterpartyPhones: [],
    counterpartyTags: [],
    provenance: 'boss',
    chainDepth: 0,
    provenanceChainDerived: false,
    dataClasses: [],
    leavesInstance: true,
    supplierId: null,
    discountPercent: 0,
    inputHash: canonicalHash(proposedInput),
  };
}

function risk(): RiskAssessment {
  return {
    actionId: 'A-test',
    actionClass: 'email.initiate',
    dimensions: {
      money: { amountMinor: 0, pctOfDailyCeiling: 0, score: 0 },
      reversibility: { class: 'reversible', score: 10 },
      externalVisibility: { audience: 'one_unknown', score: 20 },
      dataSensitivity: { classes: [], leavesInstance: false, score: 0 },
      novelty: { metric: null, z: 0, precedentIds: [], score: 0 },
      provenance: { level: 'boss', chainDepth: 0, score: 0 },
      charterFit: { verdict: 'within', citedRuleIds: [], score: 0 },
    },
    total: 15,
    band: 'sensitive',
    decidedBy: 'rules',
    explanation: 'בדיקה',
    suggestedApprovers: [],
  };
}

async function approvalFor(businessId: string, summary: string): Promise<void> {
  const proposedInput = { to: 'client@example.com', body: summary };
  await withBusiness(businessId, (db) => enqueueApproval(db, {
    jobId: null,
    facts: facts(proposedInput),
    risk: risk(),
    proposedInput,
    summary,
  }));
}

function fakeIo(secrets: string[]): PromptIo & { prints: string[]; errors: string[] } {
  const prints: string[] = [];
  const errors: string[] = [];
  let next = 0;
  return {
    prints,
    errors,
    print: (text) => prints.push(text),
    error: (text) => errors.push(text),
    readSecret: async () => {
      const value = secrets[next];
      next += 1;
      if (value === undefined) throw new Error('fakeIo: no more secrets queued');
      return value;
    },
  };
}

describe('one dashboard for every business', () => {
  it('two businesses on one server: each owner sees only their own approvals', async () => {
    await approvalFor(A, 'אישור של עסק אלף בלבד');
    await approvalFor(B, 'אישור של עסק בית בלבד');
    const baseUrl = await startServer();

    const aBody = await (await fetch(`${baseUrl}/`, { headers: { cookie: await loginCookie(baseUrl, A_LOGIN) } })).text();
    expect(aBody).toContain('אישור של עסק אלף בלבד');
    expect(aBody).not.toContain('אישור של עסק בית בלבד');

    const bBody = await (await fetch(`${baseUrl}/`, { headers: { cookie: await loginCookie(baseUrl, B_LOGIN) } })).text();
    expect(bBody).toContain('אישור של עסק בית בלבד');
    expect(bBody).not.toContain('אישור של עסק אלף בלבד');
  });

  it('login is case and whitespace insensitive', async () => {
    expect(await resolveLogin('  DANA@Tenant-A.Example \t')).toEqual({ businessId: A, status: 'active' });
    expect(await resolveLogin('nobody@tenant-a.example')).toBeNull();

    const baseUrl = await startServer();
    const res = await postLogin(baseUrl, '  Dana@TENANT-A.example  ', PASSWORD);
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^sid=${A}\\.[0-9a-f]+;`));
  });

  it('owner:create refuses an email already used by another business, in any case', async () => {
    await registerBusiness('tenant-c');
    const taken = fakeIo([PASSWORD, PASSWORD]);
    expect(await createOwnerRun(['--business', 'tenant-c', '--email', '  DANA@tenant-a.EXAMPLE '], taken)).toBe(1);
    expect(taken.errors).toEqual(['הכתובת כבר רשומה']);

    const malformed = fakeIo([PASSWORD, PASSWORD]);
    expect(await createOwnerRun(['--business', 'tenant-c', '--email', 'not-an-email'], malformed)).toBe(1);
    expect(malformed.errors).toHaveLength(1);

    const fresh = fakeIo([PASSWORD, PASSWORD]);
    expect(await createOwnerRun(['--business', 'tenant-c', '--email', 'Rina@Tenant-C.example'], fresh)).toBe(0);
    expect(await resolveLogin('rina@tenant-c.example')).toEqual({ businessId: 'tenant-c', status: 'active' });

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM dashboard_users WHERE business_id = 'tenant-c'`,
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('a forged cookie with another business id is a miss, not a session', async () => {
    const baseUrl = await startServer();
    const cookie = await loginCookie(baseUrl, A_LOGIN);
    const token = cookie.slice(`sid=${A}.`.length);
    expect(parseSessionCookie(cookie.slice('sid='.length))).toEqual({ businessId: A, token });

    const forged = await fetch(`${baseUrl}/`, { headers: { cookie: `sid=${sessionCookieValue(B, token)}` }, redirect: 'manual' });
    expect(forged.status).toBe(302);
    expect(forged.headers.get('location')).toBe('/login');

    const genuine = await fetch(`${baseUrl}/`, { headers: { cookie }, redirect: 'manual' });
    expect(genuine.status).toBe(200);
  });

  it('an old token-only cookie is treated as logged out', async () => {
    expect(parseSessionCookie('a'.repeat(64))).toBeNull();
    expect(parseSessionCookie('NOT_A_BUSINESS.abc')).toBeNull();
    expect(parseSessionCookie(`${A}.`)).toBeNull();

    const baseUrl = await startServer();
    const cookie = await loginCookie(baseUrl, A_LOGIN);
    const token = cookie.slice(`sid=${A}.`.length);
    const res = await fetch(`${baseUrl}/`, { headers: { cookie: `sid=${token}` }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('a suspended business is refused at login and on the next request of a live session', async () => {
    const baseUrl = await startServer();
    const cookie = await loginCookie(baseUrl, A_LOGIN);

    await registerBusiness(B, 'suspended');
    // Refused without a password check: a wrong password gets the same answer
    // and spends nothing from the account's failure budget.
    const refused = await postLogin(baseUrl, B_LOGIN, 'wrong password entirely');
    expect(refused.status).toBe(403);
    expect(refused.headers.get('set-cookie')).toBeNull();
    expect(await refused.text()).toContain(SUSPENDED);
    const { rows: counters } = await testDb().query<{ failed_attempts: number }>(
      `SELECT failed_attempts FROM dashboard_users WHERE business_id = $1`,
      [B],
    );
    expect(counters[0]?.failed_attempts).toBe(0);

    await registerBusiness(A, 'suspended');
    const live = await fetch(`${baseUrl}/`, { headers: { cookie }, redirect: 'manual' });
    expect(live.status).toBe(403);
    expect(await live.text()).toContain(SUSPENDED);
    // Nothing revoked: reactivating the business lets the same session in.
    const { rows: sessions } = await testDb().query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM dashboard_sessions WHERE business_id = $1`,
      [A],
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.revoked_at).toBeNull();
    await registerBusiness(A, 'active');
    expect((await fetch(`${baseUrl}/`, { headers: { cookie }, redirect: 'manual' })).status).toBe(200);
  });

  it('an OAuth callback whose state belongs to another business writes no grant', async () => {
    const baseUrl = await startServer();
    const cookie = await loginCookie(baseUrl, A_LOGIN);
    // A state row minted under business B, even bound to A's very session
    // value: business A's connection must not complete it.
    await testDb().query(
      `INSERT INTO oauth_states (state, business_id, system, session_id, code_verifier, expires_at)
       VALUES ('state-of-b', $1, 'office-calendar', $2, 'verifier', now() + interval '10 minutes')`,
      [B, cookie.slice('sid='.length)],
    );

    const res = await fetch(`${baseUrl}/oauth/callback?state=state-of-b&code=the-code`, { headers: { cookie } });
    expect(res.status).toBe(400);
    const { rows: grants } = await testDb().query(`SELECT 1 FROM oauth_grants`);
    expect(grants).toHaveLength(0);
    const { rows: states } = await testDb().query<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM oauth_states WHERE state = 'state-of-b'`,
    );
    expect(states[0]?.consumed_at).toBeNull();
  });

  it('unknown-login failures throttle server-wide and never lock a real account', async () => {
    const baseUrl = await startServer();
    for (let i = 0; i < 5; i += 1) {
      const res = await postLogin(baseUrl, `ghost-${i}@nowhere.example`, 'whatever password');
      expect(res.status).toBe(401);
    }
    const { rows: throttle } = await testDb().query<{ failed_attempts: number; locked_until: Date | null }>(
      `SELECT failed_attempts, locked_until FROM dashboard_unknown_user_throttle`,
    );
    expect(throttle).toHaveLength(1);
    expect(throttle[0]?.failed_attempts).toBe(5);
    expect(throttle[0]?.locked_until).not.toBeNull();

    // Locked for unknown names, and the reply is the same generic failure.
    const sixth = await postLogin(baseUrl, 'ghost-6@nowhere.example', 'whatever password');
    expect(sixth.status).toBe(401);
    expect(await sixth.text()).toContain('שם משתמש או סיסמה שגויים.');

    // Both real accounts, in either business, still log in.
    expect((await postLogin(baseUrl, A_LOGIN, PASSWORD)).status).toBe(302);
    expect((await postLogin(baseUrl, B_LOGIN, PASSWORD)).status).toBe(302);
  });
});
