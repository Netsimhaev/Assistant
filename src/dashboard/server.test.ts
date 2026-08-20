import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
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
import { assertBindableHost, createServer } from './server.js';

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

async function startServer(businessId: string, options: { trustProxy?: boolean } = {}): Promise<string> {
  server = createServer({ businessId, port: 0, ...options });
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
    provenanceChainDerived: false,
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

describe('which interface it will bind', () => {
  // Tested through the predicate rather than by opening a socket: the point
  // is the refusal, and actually binding a public interface in a test suite
  // is the thing the refusal exists to stop.
  it('refuses a non-loopback host, loudly, and names the way out', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'dashboard.example.com', '']) {
      expect(() => assertBindableHost(host, false), host).toThrow(/refuses to bind/);
    }
    expect(() => assertBindableHost('0.0.0.0', false)).toThrow(/DASHBOARD_ALLOW_PUBLIC_BIND/);
  });

  it('allows every loopback form, and a public bind that was explicitly asked for', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) {
      expect(() => assertBindableHost(host, false), host).not.toThrow();
    }
    expect(() => assertBindableHost('0.0.0.0', true)).not.toThrow();
  });
});

describe('changing the password', () => {
  const NEW_PASSWORD = 'a whole new password entirely';

  async function csrfFor(baseUrl: string, cookie: string): Promise<string> {
    const page = await fetch(`${baseUrl}/password`, { headers: { cookie } });
    return extractCsrf(await page.text());
  }

  // The must-change gate sits AFTER this route, and this route sat behind
  // nothing but a session. Session theft was therefore permanent takeover:
  // rotate the password and the owner never gets back in.
  it('refuses without the current password', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const csrf = await csrfFor(baseUrl, cookie);

    const res = await fetch(`${baseUrl}/password`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, password: NEW_PASSWORD, confirm: NEW_PASSWORD }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);

    // Unchanged: the old password still works, the new one does not.
    expect((await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS })).ok).toBe(true);
    expect((await login({ username: USERNAME, password: NEW_PASSWORD, businessId: BUSINESS })).ok).toBe(false);
  });

  it('refuses with the wrong current password', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const csrf = await csrfFor(baseUrl, cookie);

    const res = await fetch(`${baseUrl}/password`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf, current: 'not the password', password: NEW_PASSWORD, confirm: NEW_PASSWORD,
      }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect((await login({ username: USERNAME, password: PASSWORD, businessId: BUSINESS })).ok).toBe(true);
  });

  it('accepts with the current password', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const csrf = await csrfFor(baseUrl, cookie);

    const res = await fetch(`${baseUrl}/password`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf, current: PASSWORD, password: NEW_PASSWORD, confirm: NEW_PASSWORD,
      }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect((await login({ username: USERNAME, password: NEW_PASSWORD, businessId: BUSINESS })).ok).toBe(true);
  });

  // The one path where there is no current password to ask for: the owner
  // just proved ownership with a recovery code, which is why they are here.
  it('does not ask for a current password on the forced change after a recovery code', async () => {
    const baseUrl = await startServer(BUSINESS);
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: USERNAME, code: codes[0]! }),
      redirect: 'manual',
    });
    const cookie = cookiePair(loginRes.headers.get('set-cookie'));

    const page = await fetch(`${baseUrl}/password`, { headers: { cookie } });
    const html = await page.text();
    expect(html).not.toContain('name="current"');

    const res = await fetch(`${baseUrl}/password`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        csrf: extractCsrf(html), password: NEW_PASSWORD, confirm: NEW_PASSWORD,
      }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect((await login({ username: USERNAME, password: NEW_PASSWORD, businessId: BUSINESS })).ok).toBe(true);
  });
});

describe('the address a recovery redemption is audited from', () => {
  /** The reason line of the incident entry `redeemRecoveryCode` writes. */
  async function redemptionAudit(businessId: string): Promise<string> {
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log
        WHERE business_id = $1 AND reason LIKE 'recovery code redeemed%'
        ORDER BY seq DESC LIMIT 1`,
      [businessId],
    );
    const reason = rows[0]?.reason;
    if (reason === undefined) throw new Error('no redemption audit entry');
    return reason;
  }

  async function redeem(baseUrl: string, code: string, forwardedFor: string): Promise<void> {
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'x-forwarded-for': forwardedFor },
      body: new URLSearchParams({ username: USERNAME, code }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  }

  it('records the proxy hop as a proxy hop, and never believes a header it was not told to trust', async () => {
    const baseUrl = await startServer(BUSINESS);
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    await redeem(baseUrl, codes[0]!, '203.0.113.9');

    const reason = await redemptionAudit(BUSINESS);
    // The header was sent by the client on an open socket. Believing it
    // would let whoever redeems a code choose what the only record of that
    // event says about where it came from.
    expect(reason).not.toContain('203.0.113.9');
    expect(reason).toContain('proxy hop');
  });

  it('records the nearest hop of a forwarded-for header when the deployment says to trust one', async () => {
    const baseUrl = await startServer(BUSINESS, { trustProxy: true });
    const codes = await issueRecoveryCodes({ username: USERNAME, businessId: BUSINESS });
    // Two entries: the left one is whatever the client sent, the right one
    // is what the trusted proxy appended. The right one is the answer.
    await redeem(baseUrl, codes[0]!, '198.51.100.7, 203.0.113.9');

    const reason = await redemptionAudit(BUSINESS);
    expect(reason).toContain('203.0.113.9');
    expect(reason).not.toContain('198.51.100.7');
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

  it('escapes a script payload inside the editable textarea too, not just the old read-only view', async () => {
    const baseUrl = await startServer(BUSINESS);
    const payload = '<script>alert(1)</script>';
    const approvalId = await makeApproval({
      businessId: BUSINESS,
      proposedInput: { note: payload },
    });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain('name="input"');
    expect(body).toContain('&lt;script&gt;');
    expect(body).not.toContain(payload);
  });
});

describe('editing before approval', () => {
  it('stores the edited payload and yields approved_with_edit when something actually changed', async () => {
    const baseUrl = await startServer(BUSINESS);
    const job = await jobAwaitingApproval(BUSINESS);
    const original = { to: 'client@example.com', body: 'טקסט מקורי' };
    const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId, proposedInput: original });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    const edited = { to: 'client@example.com', body: 'טקסט ערוך' };
    const decideRes = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, input: JSON.stringify(edited) }),
      redirect: 'manual',
    });
    expect(decideRes.status).toBe(302);

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('approved_with_edit');
    expect(approval?.editedInput).toEqual(edited);
    const updatedJob = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(updatedJob?.phase).toBe('execute');
  });

  it('approves plainly when the resubmitted payload is unchanged, even reformatted', async () => {
    const baseUrl = await startServer(BUSINESS);
    const original = { to: 'client@example.com', body: 'שלום' };
    const approvalId = await makeApproval({ businessId: BUSINESS, proposedInput: original });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    // Same content, different key order and whitespace — a re-serialisation,
    // not an edit, and must not be treated as one.
    const reformatted = '{\n  "body": "שלום",\n  "to":    "client@example.com"\n}';
    const decideRes = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, input: reformatted }),
      redirect: 'manual',
    });
    expect(decideRes.status).toBe(302);

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('approved');
    expect(approval?.editedInput).toBeNull();
  });

  it('refuses malformed JSON with a readable Hebrew message and leaves the approval pending', async () => {
    const baseUrl = await startServer(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    const decideRes = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, input: '{not valid json' }),
      redirect: 'manual',
    });
    expect(decideRes.status).toBe(400);
    const body = await decideRes.text();
    expect(body).toContain('אינו JSON תקין');
    // What the owner typed comes back, not the original — losing an
    // in-progress edit on a typo would be its own kind of data loss.
    expect(body).toContain('{not valid json');

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('pending');
  });

  it('refuses an edited approve without a CSRF token', async () => {
    const baseUrl = await startServer(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ input: JSON.stringify({ to: 'x@example.com' }) }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('pending');
  });

  it('refuses an edited approve without a session', async () => {
    const baseUrl = await startServer(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS });

    const res = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
      method: 'POST',
      body: new URLSearchParams({ input: JSON.stringify({ to: 'x@example.com' }) }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('pending');
  });
});
