import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { createJob, loadJob, transition } from '../orchestrator/jobs.js';
import { enqueueApproval, getApproval } from '../governance/approvals.js';
import type { ActionFacts } from '../domain/policy.js';
import type { RiskAssessment } from '../domain/risk.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { Proposal } from '../domain/proposal.js';
import { canonicalHash } from '../util/canonical.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { insertOrGetDocument } from '../documents/store.js';
import { saveReading } from '../documents/reading-store.js';
import { saveProposal } from '../orchestrator/proposal-store.js';
import { loadSignature } from '../governance/signatures.js';
import { queryAudit } from '../audit/log.js';
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

async function startServer(
  businessId: string,
  options: { trustProxy?: boolean; documentRoot?: string } = {},
): Promise<string> {
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

// --- Fixtures for the document -> reading -> proposal -> job -> approval
// chain that `documentForApproval` walks, mirroring
// `document-for-approval.test.ts`'s helpers but writing real bytes to disk
// under a temp `documentRoot` so `verifyDocumentUnchanged` has something
// real to hash.

const SOURCE = { ordinal: 0, locator: null };

const ACTING_PROPOSAL: Proposal = {
  stance: 'act',
  headline: 'אחתום על המסמך',
  reasons: [{ text: 'התנאים תקינים', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: {
    headline: 'אשלח מייל אישור',
    purpose: 'לאשר את קבלת המסמך',
    intent: 'reply_to_sender',
    agent: 'comms.email',
    toolName: 'mail.send',
    input: { to: 'dana@example.com', body: 'אושר' },
    expectedActionClass: 'email.initiate',
  },
  clarifyingQuestion: null,
};

/** A document row backed by a real file under `docRoot`, as intake leaves it. */
async function aDocument(
  businessId: string,
  docRoot: string,
  bytes: Buffer,
  originalName = 'חוזה עם קבלן.docx',
): Promise<{ documentId: string; sha256: string }> {
  const documentId = `DOC-${ulid()}`;
  const rel = `${businessId}/${documentId}/original.txt`;
  await mkdir(join(docRoot, businessId, documentId), { recursive: true });
  await writeFile(join(docRoot, rel), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await insertOrGetDocument(
    {
      documentId,
      source: 'manual',
      originalName,
      mediaType: 'text/plain',
      sha256,
      byteSize: bytes.length,
      storedPath: rel,
    },
    { businessId },
  );
  return { documentId, sha256 };
}

async function aReadingOf(documentId: string, businessId: string): Promise<string> {
  const { record } = await saveReading(
    {
      readingId: `RDG-${ulid()}`,
      documentId,
      status: 'read',
      reason: null,
      content: {
        summary: 'תקציר',
        findings: [],
        intents: [{ intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' }],
        unreadable: [],
      },
      provenance: 'boss',
      model: 'haiku',
      promptVersion: 'v1',
      briefHash: ulid().padEnd(64, '0'),
    },
    { businessId },
  );
  return record.readingId;
}

/** A fresh job + proposal + pending approval pointing at an existing reading. */
async function anApprovalForReading(
  businessId: string,
  bundle: PolicyBundle,
  readingId: string,
): Promise<{ approvalId: string; jobId: string }> {
  const job = await createJob({ charterVersion: bundle.charterVersion, provenance: 'boss', businessId });
  for (const to of ['understand', 'plan', 'await_approval'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId });
  }
  await saveProposal(
    {
      proposalId: `PR-${ulid()}`,
      readingId,
      jobId: job.jobId,
      status: 'proposed',
      reason: null,
      content: ACTING_PROPOSAL,
      raw: '{}',
      model: 'haiku',
      promptVersion: 'v1',
    },
    { businessId },
  );
  const approvalId = await makeApproval({ businessId, jobId: job.jobId });
  return { approvalId, jobId: job.jobId };
}

/** The full chain in one call: a document with real bytes, backing a pending approval. */
async function aSignableApproval(
  businessId: string,
  docRoot: string,
  bytes: Buffer,
): Promise<{ approvalId: string; jobId: string; documentId: string; sha256: string }> {
  const bundle = await installCharter(buildCharter(), { businessId });
  const { documentId, sha256 } = await aDocument(businessId, docRoot, bytes);
  const readingId = await aReadingOf(documentId, businessId);
  const { approvalId, jobId } = await anApprovalForReading(businessId, bundle, readingId);
  return { approvalId, jobId, documentId, sha256 };
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

/** The proposed-input `<textarea>`'s raw (still-escaped) content, as the browser would see it. */
function extractInputTextarea(html: string): string {
  const match = /<textarea name="input"[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
  if (!match?.[1]) throw new Error(`no input textarea found in body: ${html.slice(0, 200)}`);
  return match[1];
}

/**
 * Reverses `escapeHtml` (src/dashboard/views.ts), the way a browser decoding
 * a `<textarea>`'s content would. `&amp;` must decode last: decoding it
 * first would turn `&amp;lt;` into `&lt;` and then, on the next pass, into
 * `<` — a double-decode escapeHtml never produced and this helper must not
 * invent.
 */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
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

describe('signing an approval', () => {
  let docRoot: string;

  beforeEach(async () => {
    docRoot = await mkdtemp(join(tmpdir(), 'sign-'));
  });

  afterEach(async () => {
    await rm(docRoot, { recursive: true, force: true });
  });

  it('signing an unchanged document records a signature, an audit row, and approves', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const { approvalId, jobId, documentId, sha256 } = await aSignableApproval(
      BUSINESS,
      docRoot,
      Buffer.from('הסכם שיווק — גרסה סופית', 'utf8'),
    );
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    const signRes = await fetch(`${baseUrl}/a/${approvalId}/sign`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, documentId }),
      redirect: 'manual',
    });
    expect(signRes.status).toBe(302);

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('approved');

    const signature = await loadSignature(documentId, { businessId: BUSINESS });
    expect(signature).not.toBeNull();
    expect(signature?.signedBy).toBe(USERNAME);
    expect(signature?.approvalId).toBe(approvalId);
    // M1: the row records what was actually re-hashed at signing time, not
    // just that *some* signature exists.
    expect(signature?.signedSha256).toBe(sha256);

    const audit = await queryAudit({ businessId: BUSINESS, kind: 'signature' });
    expect(audit.length).toBe(1);
    expect(audit[0]?.jobId).toBe(jobId);
    expect(audit[0]?.reason).toContain(`signature:${documentId}`);
    expect(audit[0]?.reason).toContain(`for approval ${approvalId}`);

    const updatedJob = await loadJob(jobId, { businessId: BUSINESS });
    expect(updatedJob?.phase).toBe('execute');
  });

  it('refuses to sign an approval already denied in another tab, and writes no signature', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const { approvalId, documentId } = await aSignableApproval(
      BUSINESS,
      docRoot,
      Buffer.from('הסכם שיווק — טאב שני', 'utf8'),
    );
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    // Tab 1: deny.
    const denyRes = await fetch(`${baseUrl}/a/${approvalId}/deny`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });
    expect(denyRes.status).toBe(302);
    expect((await getApproval(approvalId, { businessId: BUSINESS }))?.state).toBe('denied');

    // Tab 2, stale: sign the same, now-denied approval. `documentId` matches
    // the real document — this must be refused on the approval's state
    // alone, not incidentally by some other check.
    const signRes = await fetch(`${baseUrl}/a/${approvalId}/sign`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, documentId }),
      redirect: 'manual',
    });
    expect(signRes.status).toBe(400);
    // D1 (round 2): this refusal has no `document` to render `signForm`
    // with, so it must render at card level or it silently vanishes —
    // the owner would otherwise see a normal-looking card with the sign
    // button simply gone, no explanation.
    expect(await signRes.text()).toContain('הבקשה כבר הוכרעה');

    expect(await loadSignature(documentId, { businessId: BUSINESS })).toBeNull();
    expect((await getApproval(approvalId, { businessId: BUSINESS }))?.state).toBe('denied');
    expect(await queryAudit({ businessId: BUSINESS, kind: 'signature' })).toEqual([]);
  });

  it('refuses to sign a document that changed on disk, and leaves the approval pending', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const { approvalId, documentId } = await aSignableApproval(
      BUSINESS,
      docRoot,
      Buffer.from('הסכם שיווק — גרסה מקורית', 'utf8'),
    );
    // The bytes on disk diverge from what was hashed at intake.
    const rel = `${BUSINESS}/${documentId}/original.txt`;
    await writeFile(join(docRoot, rel), Buffer.from('הסכם שיווק — נוסח שהוחלף', 'utf8'));

    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    const signRes = await fetch(`${baseUrl}/a/${approvalId}/sign`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, documentId }),
      redirect: 'manual',
    });
    expect(signRes.status).toBe(400);

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('pending');
    expect(await loadSignature(documentId, { businessId: BUSINESS })).toBeNull();
  });

  it('refuses to sign when the stored file is unreadable, with text distinct from "missing"', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const bytes = Buffer.from('הסכם שיווק — עוד גרסה', 'utf8');
    // One charter install, reused for both documents below — installCharter
    // writes a fixed, deterministic charter_version id (buildCharter's own),
    // and a second install under the same business would collide on it.
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    const unreadableDoc = await aDocument(BUSINESS, docRoot, bytes);
    const unreadableReading = await aReadingOf(unreadableDoc.documentId, BUSINESS);
    const unreadable = await anApprovalForReading(BUSINESS, bundle, unreadableReading);

    // Swap the file for a directory of the same name — a real EISDIR, not
    // ENOENT, distinguishing "unreadable" from "missing" the way
    // verify.test.ts does at the unit level.
    const filePath = join(docRoot, BUSINESS, unreadableDoc.documentId, 'original.txt');
    await rm(filePath, { force: true });
    await mkdir(filePath);

    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const cardRes = await fetch(`${baseUrl}/a/${unreadable.approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    const signRes = await fetch(`${baseUrl}/a/${unreadable.approvalId}/sign`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, documentId: unreadableDoc.documentId }),
      redirect: 'manual',
    });
    expect(signRes.status).toBe(400);
    const unreadableBody = await signRes.text();

    const approval = await getApproval(unreadable.approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('pending');

    // Now check the "missing" refusal reads differently, on a fresh document.
    // Distinct bytes: `insertOrGetDocument` dedupes on (business_id, sha256),
    // so reusing the same content would silently return the first document's
    // row instead of inserting a second one.
    const missingDoc = await aDocument(BUSINESS, docRoot, Buffer.from('הסכם שיווק — מסמך שני', 'utf8'));
    const missingReading = await aReadingOf(missingDoc.documentId, BUSINESS);
    const missing = await anApprovalForReading(BUSINESS, bundle, missingReading);
    await rm(join(docRoot, BUSINESS, missingDoc.documentId), { recursive: true, force: true });
    const missingCardRes = await fetch(`${baseUrl}/a/${missing.approvalId}`, { headers: { cookie } });
    const missingCsrf = extractCsrf(await missingCardRes.text());
    const missingRes = await fetch(`${baseUrl}/a/${missing.approvalId}/sign`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: missingCsrf, documentId: missingDoc.documentId }),
      redirect: 'manual',
    });
    expect(missingRes.status).toBe(400);
    const missingBody = await missingRes.text();

    // I2: assert the substance, not that two full pages differ (they always
    // do — approval id, timestamps and CSRF token vary too). `EISDIR` proves
    // `verifyResult.cause` actually reaches the rendered page for the
    // `unreadable` branch, and its absence from `missing`'s page proves the
    // two `VerifyOutcome` arms produce genuinely different refusal text, not
    // just different surrounding pages.
    expect(unreadableBody).toContain('EISDIR');
    expect(missingBody).not.toContain('EISDIR');
    expect(unreadableBody).toContain('לא ניתן היה לקרוא את הקובץ השמור');
    expect(missingBody).toContain('נעדר מהדיסק');
    expect(unreadableBody).not.toContain('נעדר מהדיסק');
    expect(missingBody).not.toContain('לא ניתן היה לקרוא את הקובץ השמור');
  });

  it('refuses to sign an approval that has no document behind it', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const job = await jobAwaitingApproval(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    const signRes = await fetch(`${baseUrl}/a/${approvalId}/sign`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });
    expect(signRes.status).toBe(400);
    // D1 (round 2): a regression the first pass introduced — this refusal
    // has no `document` either, and used to render (misplaced, in the
    // approve form) before this file's first fix; the first fix moved the
    // text into `signForm`, which never renders here at all, so the owner
    // got no message instead of a misplaced one.
    expect(await signRes.text()).toContain('לא נמצא מסמך המשויך לבקשה זו');

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('pending');
  });

  it('refuses a second signature on the same document, leaving the first intact', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const bytes = Buffer.from('הסכם שיווק — נחתם פעם אחת בלבד', 'utf8');
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const { documentId } = await aDocument(BUSINESS, docRoot, bytes);
    const readingId1 = await aReadingOf(documentId, BUSINESS);
    const first = await anApprovalForReading(BUSINESS, bundle, readingId1);
    const readingId2 = await aReadingOf(documentId, BUSINESS);
    const second = await anApprovalForReading(BUSINESS, bundle, readingId2);

    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const firstCardRes = await fetch(`${baseUrl}/a/${first.approvalId}`, { headers: { cookie } });
    const firstCsrf = extractCsrf(await firstCardRes.text());
    const firstSignRes = await fetch(`${baseUrl}/a/${first.approvalId}/sign`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: firstCsrf, documentId }),
      redirect: 'manual',
    });
    expect(firstSignRes.status).toBe(302);
    const firstSignature = await loadSignature(documentId, { businessId: BUSINESS });
    expect(firstSignature).not.toBeNull();

    const secondCardRes = await fetch(`${baseUrl}/a/${second.approvalId}`, { headers: { cookie } });
    const secondCsrf = extractCsrf(await secondCardRes.text());
    const secondSignRes = await fetch(`${baseUrl}/a/${second.approvalId}/sign`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf: secondCsrf, documentId }),
      redirect: 'manual',
    });
    expect(secondSignRes.status).toBe(400);
    // F3, spec §8: "the message says when and who". A refusal that only says
    // "already signed" sends the owner to a DBA to find out by whom.
    const secondBody = await secondSignRes.text();
    expect(secondBody).toContain(USERNAME);
    expect(secondBody).toContain(String(new Date().getUTCFullYear()));

    const secondApproval = await getApproval(second.approvalId, { businessId: BUSINESS });
    expect(secondApproval?.state).toBe('pending');

    const stillFirst = await loadSignature(documentId, { businessId: BUSINESS });
    expect(stillFirst?.signatureId).toBe(firstSignature?.signatureId);
  });

  it('refuses a sign without a CSRF token, exactly as approve does', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const approvalId = await makeApproval({ businessId: BUSINESS });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/a/${approvalId}/sign`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({}),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('pending');
  });

  it('renders the resolved document id on the sign form', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const { approvalId, documentId } = await aSignableApproval(
      BUSINESS,
      docRoot,
      Buffer.from('הסכם שיווק — שדה מוסתר', 'utf8'),
    );
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const body = await cardRes.text();

    expect(body).toContain(`name="documentId" value="${documentId}"`);
  });

  // M4: the sign form names the document the owner was looking at when the
  // card was rendered. A POST that names a different one — the page was
  // stale, or a request was hand-crafted — must not sign whatever document
  // `documentForApproval` happens to resolve to right now.
  it('refuses to sign when the submitted documentId does not match the resolved document', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const { approvalId, documentId } = await aSignableApproval(
      BUSINESS,
      docRoot,
      Buffer.from('הסכם שיווק — אי-התאמת מסמך', 'utf8'),
    );
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    const signRes = await fetch(`${baseUrl}/a/${approvalId}/sign`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, documentId: `DOC-${ulid()}` }),
      redirect: 'manual',
    });
    expect(signRes.status).toBe(400);

    expect(await loadSignature(documentId, { businessId: BUSINESS })).toBeNull();
    expect((await getApproval(approvalId, { businessId: BUSINESS }))?.state).toBe('pending');
  });

  // F2: the filename is chosen by whoever sent the document. It is the only
  // thing on the card naming what is about to be signed, and `escapeHtml`
  // does not touch bidi controls — so on an RTL page a sender can make a name
  // render as something other than what it is. The card must also show
  // something derived from the bytes themselves.
  it('shows a hash prefix beside the name and strips bidi controls from it', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const bytes = Buffer.from('הסכם שיווק — שם עוין', 'utf8');
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    // U+202E RIGHT-TO-LEFT OVERRIDE, then a name that renders reversed.
    const { documentId, sha256 } = await aDocument(
      BUSINESS,
      docRoot,
      bytes,
      'invoice‮gpj.exe',
    );
    const readingId = await aReadingOf(documentId, BUSINESS);
    const { approvalId } = await anApprovalForReading(BUSINESS, bundle, readingId);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const body = await (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();

    expect(body).toContain(sha256.slice(0, 12));
    expect(body).not.toContain('‮');
    // The visible characters of the name survive; only the control is gone.
    expect(body).toContain('invoice');
  });

  // F6, spec §8 and §9: no document behind the approval, no sign control at
  // all. The route refuses such a POST (tested above), but the button must
  // never be on the page to begin with.
  it('renders no sign control on a card with no document behind it', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const job = await jobAwaitingApproval(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const body = await (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();

    expect(body).toContain(`/a/${approvalId}/approve`);
    expect(body).not.toContain(`/a/${approvalId}/sign`);
    expect(body).not.toContain('name="documentId"');
    expect(body).not.toContain('חתום ואשר');
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

  it('escapes a closing </textarea> so a payload cannot break out of the field early', async () => {
    // `<script>` alone proves nothing about the textarea specifically — a
    // textarea's content is RCDATA, and the one sequence that actually ends
    // it early is its own closing tag. This is the payload that matters.
    const baseUrl = await startServer(BUSINESS);
    const payload = '</textarea><script>alert(1)</script>';
    const approvalId = await makeApproval({
      businessId: BUSINESS,
      proposedInput: { note: payload },
    });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain('name="input"');
    expect(body).not.toContain(payload);
    expect(body).toContain('&lt;/textarea&gt;');
    expect(body).toContain('&lt;script&gt;');
  });

  it('lets the escaped textarea content be submitted back verbatim as a plain approval, not an edit', async () => {
    // Proves the un-escaping half: a browser decodes entities before putting
    // the text in the form submission, so this reproduces exactly what an
    // owner who opens the card and clicks approve without touching anything
    // actually sends.
    const baseUrl = await startServer(BUSINESS);
    const original = { note: 'שלום <b>עולם</b> & "מרכאות" \'גרש\'' };
    const approvalId = await makeApproval({ businessId: BUSINESS, proposedInput: original });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const html = await cardRes.text();
    const csrf = extractCsrf(html);
    const submitted = unescapeHtml(extractInputTextarea(html));

    const decideRes = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, input: submitted }),
      redirect: 'manual',
    });
    expect(decideRes.status).toBe(302);

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('approved');
    expect(approval?.editedInput).toBeNull();
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
    expect(body).toContain('אינו אובייקט JSON תקין');
    // What the owner typed comes back, not the original — losing an
    // in-progress edit on a typo would be its own kind of data loss.
    expect(body).toContain('{not valid json');

    const approval = await getApproval(approvalId, { businessId: BUSINESS });
    expect(approval?.state).toBe('pending');
  });

  it('preserves the typed note on a refusal too, not just the payload', async () => {
    const baseUrl = await startServer(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    const decideRes = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, input: '{not valid json', note: 'הערה חשובה שאסור לאבד' }),
      redirect: 'manual',
    });
    expect(decideRes.status).toBe(400);
    const body = await decideRes.text();
    expect(body).toContain('הערה חשובה שאסור לאבד');
  });

  it.each([
    ['null', 'null'],
    ['an array', '["a","b"]'],
    ['a bare string', '"just a string"'],
    ['a number', '42'],
  ])(
    'refuses a valid-JSON-but-non-object edit (%s), the same as malformed JSON, and never executes it',
    async (_label, raw) => {
      const baseUrl = await startServer(BUSINESS);
      const job = await jobAwaitingApproval(BUSINESS);
      const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId });
      const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

      const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
      const csrf = extractCsrf(await cardRes.text());

      const decideRes = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
        method: 'POST',
        headers: { cookie },
        body: new URLSearchParams({ csrf, input: raw }),
        redirect: 'manual',
      });
      expect(decideRes.status).toBe(400);
      const body = await decideRes.text();
      expect(body).toContain('אינו אובייקט JSON תקין');

      // Not just refused at the door — nothing was bound, decided, or
      // handed to the job. `null` in particular used to sail through into
      // `approved_with_edit` and then get silently ignored by the executor,
      // which is the failure mode this test exists to close off.
      const approval = await getApproval(approvalId, { businessId: BUSINESS });
      expect(approval?.state).toBe('pending');
      expect(approval?.editedInput).toBeNull();
      const jobAfter = await loadJob(job.jobId, { businessId: BUSINESS });
      expect(jobAfter?.phase).toBe('await_approval');
    },
  );

  it('refuses an oversized edit with a readable message instead of a 500', async () => {
    const baseUrl = await startServer(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const cardRes = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const csrf = extractCsrf(await cardRes.text());

    const huge = 'x'.repeat(70 * 1024);
    const decideRes = await fetch(`${baseUrl}/a/${approvalId}/approve`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, input: huge }),
      redirect: 'manual',
    });
    expect(decideRes.status).toBe(400);
    const body = await decideRes.text();
    expect(body).toContain('גדול מדי');

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
