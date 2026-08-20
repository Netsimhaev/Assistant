import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { createJob, loadJob, transition } from '../orchestrator/jobs.js';
import { enqueueApproval, getApproval } from '../governance/approvals.js';
import type { ActionFacts } from '../domain/policy.js';
import type { RiskAssessment } from '../domain/risk.js';
import { canonicalHash } from '../util/canonical.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createOwner, login } from './auth.js';
import { issueRecoveryCodes, remainingCodes } from './recovery.js';
import { createServer } from './server.js';

const BUSINESS = 'test-business';
const OTHER_BUSINESS = 'test-business-other';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

async function startServer(businessId: string): Promise<string> {
  server = createServer({ businessId, port: 0 });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function factsFixture(proposedInput: unknown, overrides: Partial<ActionFacts> = {}): ActionFacts {
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
    dataClasses: [],
    leavesInstance: true,
    supplierId: null,
    discountPercent: 0,
    inputHash: canonicalHash(proposedInput),
    ...overrides,
  };
}

function riskFixture(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
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
    ...overrides,
  };
}

async function makeApproval(options: {
  businessId: string;
  jobId?: string | null;
  proposedInput?: unknown;
  summary?: string;
}): Promise<string> {
  const proposedInput = options.proposedInput ?? { to: 'client@example.com', body: 'שלום' };
  return enqueueApproval(
    {
      jobId: options.jobId ?? null,
      facts: factsFixture(proposedInput),
      risk: riskFixture(),
      proposedInput,
      summary: options.summary ?? 'שליחת מייל ללקוח',
    },
    { businessId: options.businessId },
  );
}

async function jobAwaitingApproval(businessId: string) {
  const bundle = await installCharter(buildCharter(), { businessId });
  const job = await createJob({ charterVersion: bundle.charterVersion, provenance: 'boss', businessId });
  for (const to of ['understand', 'plan', 'await_approval'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId });
  }
  return job;
}

/** The `sid=...` cookie-pair from a Set-Cookie header, without its attributes. */
function cookiePair(setCookieHeader: string | null): string {
  if (!setCookieHeader) throw new Error('no Set-Cookie header on response');
  const pair = setCookieHeader.split(';')[0];
  if (!pair) throw new Error('empty Set-Cookie header');
  return pair;
}

async function loginWithPassword(baseUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ username, password }),
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return cookiePair(res.headers.get('set-cookie'));
}

function extractCsrf(html: string): string {
  const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
  if (!match?.[1]) throw new Error(`no csrf token found in body: ${html.slice(0, 200)}`);
  return match[1];
}

beforeEach(async () => {
  await createOwner({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
});

describe('GET /', () => {
  it('redirects to login without a session', async () => {
    const baseUrl = await startServer(BUSINESS);
    const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('shows the pending list to a valid session', async () => {
    const baseUrl = await startServer(BUSINESS);
    await makeApproval({ businessId: BUSINESS, summary: 'אשר הזמנה מיוחדת ממש כאן' });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('אשר הזמנה מיוחדת ממש כאן');
  });

  it('expires a session past its lifetime', async () => {
    const baseUrl = await startServer(BUSINESS);
    const farPast = new Date('2000-01-01T00:00:00.000Z');
    const result = await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS, now: farPast });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie: `sid=${result.sessionId}` },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('CSRF', () => {
  it('refuses an approve without a CSRF token', async () => {
    const baseUrl = await startServer(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({}),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('pending');
  });
});

describe('deciding an approval', () => {
  it('approves with a valid token', async () => {
    const baseUrl = await startServer(BUSINESS);
    const job = await jobAwaitingApproval(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    const decideRes = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });
    expect(decideRes.status).toBe(302);

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('approved');
    const updatedJob = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(updatedJob?.phase).toBe('execute');
  });

  it('denies with a valid token', async () => {
    const baseUrl = await startServer(BUSINESS);
    const job = await jobAwaitingApproval(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    const decideRes = await fetch(`${baseUrl}/a/${approvalId}/deny`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });
    expect(decideRes.status).toBe(302);

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('denied');
    const updatedJob = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(updatedJob?.phase).toBe('closed');
  });
});

describe('tenant isolation', () => {
  it("hides another business's approval", async () => {
    const baseUrl = await startServer(BUSINESS);
    const approvalId = await makeApproval({ businessId: OTHER_BUSINESS });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("refuses to decide another business's approval", async () => {
    const baseUrl = await startServer(BUSINESS);
    const approvalId = await makeApproval({ businessId: OTHER_BUSINESS });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    // No card page exists for this approval under this business (it 404s),
    // so the CSRF token comes from any other page rendered for the same
    // session — the token is bound to the session, not to one approval.
    const listRes = await fetch(`${baseUrl}/`, { headers: { cookie } });
    const csrf = extractCsrf(await listRes.text());

    const res = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });
    expect(res.status).toBe(404);

    const approval = await getApproval(approvalId, { businessId: OTHER_BUSINESS });
    expect(approval?.state).toBe('pending');
  });
});

describe('session cookie', () => {
  it('locks the session cookie down', async () => {
    const baseUrl = await startServer(BUSINESS);
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: USERNAME, password: PASSWORD }),
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
  });
});

describe('recovery-code login', () => {
  it('forces a password change after a recovery-code login', async () => {
    const baseUrl = await startServer(BUSINESS);
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    const code = codes[0];
    expect(code).toBeDefined();

    const loginRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: USERNAME, code: code! }),
      redirect: 'manual',
    });
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.get('location')).toBe('/password');
    const cookie = cookiePair(loginRes.headers.get('set-cookie'));

    const res = await fetch(`${baseUrl}/`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/password');
  });

  it('refuses to decide an approval while a password change is pending, even with a valid CSRF token', async () => {
    const baseUrl = await startServer(BUSINESS);
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    const code = codes[0];
    expect(code).toBeDefined();

    const loginRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: USERNAME, code: code! }),
      redirect: 'manual',
    });
    const cookie = cookiePair(loginRes.headers.get('set-cookie'));

    // /password is reachable precisely because the gate lets it through —
    // its CSRF token is the same session-wide token every other page for
    // this session would carry.
    const passwordPage = await fetch(`${baseUrl}/password`, { headers: { cookie } });
    const csrf = extractCsrf(await passwordPage.text());

    const approvalId = await makeApproval({ businessId: BUSINESS });

    const res = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/password');

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('pending');
  });

  it('shows how many recovery codes remain', async () => {
    const baseUrl = await startServer(BUSINESS);
    await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    const expected = await remainingCodes(USERNAME, { businessId: BUSINESS });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain(String(expected));
  });
});

describe('HTML escaping', () => {
  it('escapes HTML in the proposed input', async () => {
    const baseUrl = await startServer(BUSINESS);
    const payload = '<script>alert(1)</script>';
    const approvalId = await makeApproval({
      businessId: BUSINESS,
      proposedInput: { note: payload },
    });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain('&lt;script&gt;');
    expect(body).not.toContain(payload);
  });
});
