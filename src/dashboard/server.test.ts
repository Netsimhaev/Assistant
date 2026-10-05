import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { createJob, loadJob, transition } from '../orchestrator/jobs.js';
import { recordInbound, recordOutbound } from '../whatsapp/store.js';
import { bindPlanToJob } from '../orchestrator/plan-store.js';
import { Plan } from '../domain/plan.js';
import { writeMemory } from '../memory/store.js';
import { loadAutonomyMode } from '../governance/autonomy-mode.js';
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
import { saveNotJudged, saveVerdict, type NotJudgedReason } from '../governance/verdict-store.js';
import { queryAudit } from '../audit/log.js';
import {
  loadInstructionForJob,
  claimAnswer,
  pendingQuestions,
  recordQuestion,
  saveInstruction,
} from '../governance/instructions.js';
import { createOwner, login } from './auth.js';
import { issueRecoveryCodes, remainingCodes } from './recovery.js';
import {
  assertBindableHost,
  createServer,
  reasonForSupersededJob,
  renderInstructionOutcome,
} from './server.js';
import { renderInstruct } from './views.js';

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

/**
 * A completed step with no card behind it — exactly what
 * `listAutonomousActions` (`autonomous-actions.ts`) is built to find, seeded
 * directly rather than by running a plan through the scheduler: this file is
 * testing the ROUTE (session, CSRF, the row `recordCorrection` writes), which
 * `autonomous-actions.test.ts` already proves end to end through the real
 * gate. `job_step_results` is written directly, mirroring
 * `resume-plan.test.ts`'s own use of a raw insert for the same table.
 */
async function seedAutonomousAction(
  businessId: string,
  input: Record<string, unknown> = { to: 'dana@example.com', inReplyTo: 'thread-1', subject: 'תשובה', body: 'גוף' },
): Promise<{ jobId: string; stepId: string }> {
  const bundle = await installCharter(buildCharter({ version: `autonomy-actions-${ulid()}` }), { businessId });
  const job = await createJob({ charterVersion: bundle.charterVersion, provenance: 'boss', businessId });
  const plan = Plan.parse({
    goal: 'reply to a known customer',
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'reply to the customer',
        toolName: 'mail.send',
        input,
      },
    ],
  });
  const binding = await bindPlanToJob(job.jobId, plan, { businessId });
  if (binding.status !== 'stored') throw new Error(`unexpected plan binding status ${binding.status}`);

  await getPool().query(
    `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, external_id, status)
     VALUES ($1, $2, $3, $4, 'MSG-1', 'completed')`,
    [businessId, job.jobId, binding.planHash, 's1'],
  );

  return { jobId: job.jobId, stepId: 's1' };
}

// --- Fixtures for the document -> reading -> proposal -> job -> approval
// chain that `documentForApproval` walks, mirroring
// `document-for-approval.test.ts`'s helpers but writing real bytes to disk
// under a temp `documentRoot` so `verifyDocumentUnchanged` has something
// real to hash.

const SOURCE = { ordinal: 0, locator: null };

/**
 * A proposal whose intent IS a decision about the document — the only kind
 * that may carry a sign form (I4, `signable-intents.ts`). Every sign test
 * below builds on this: with a non-document-decision intent the form is not
 * rendered at all, so a test that meant to exercise signing would be
 * exercising its absence instead and passing for the wrong reason.
 */
const FILING_PROPOSAL: Proposal = {
  stance: 'act',
  headline: 'אתייק את המסמך',
  reasons: [{ text: 'התנאים תקינים', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: {
    headline: 'אתייק את המסמך בתיק הספק',
    purpose: 'לשמור את ההסכם במקומו',
    intent: 'file_document',
    agent: 'prod.docs',
    toolName: 'file.write',
    input: { path: 'suppliers/agreement.txt', body: 'אושר' },
    expectedActionClass: 'artifact.write',
  },
  clarifyingQuestion: null,
};

/**
 * A proposal about sending an email. It happens to hang off a reading of a
 * document — every conductor proposal does — but the owner's decision here is
 * about a message, not about accepting the document as binding.
 */
const MAILING_PROPOSAL: Proposal = {
  stance: 'act',
  headline: 'אשיב לדנה',
  reasons: [{ text: 'התנאים תקינים', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: {
    headline: 'אשלח מייל לדנה',
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
  proposal: Proposal = FILING_PROPOSAL,
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
      content: proposal,
      raw: '{}',
      model: 'haiku',
      promptVersion: 'v1',
    },
    { businessId },
  );
  const approvalId = await makeApproval({ businessId, jobId: job.jobId });
  return { approvalId, jobId: job.jobId };
}

/**
 * The conductor's own card shape, without touching disk: document -> reading
 * -> proposal -> job -> approval.
 *
 * `documentForApproval` is a pure DB join and never opens `stored_path`, so no
 * bytes are needed here — which is the point of having this beside
 * `aSignableApproval` rather than reusing it. What this shape carries that a
 * gate-raised or orphan card cannot is the `proposals` row, and that is what
 * the still-running note now keys off (`stillRunningNote` in `views.ts`).
 * `MAILING_PROPOSAL` deliberately, so no sign form is in the rendered page to
 * confuse a note assertion with a form assertion.
 */
async function aConductorRaisedApproval(
  businessId: string,
): Promise<{ approvalId: string; jobId: string }> {
  const bundle = await installCharter(buildCharter(), { businessId });
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument(
    {
      documentId,
      source: 'manual',
      originalName: 'הצעת מחיר.txt',
      mediaType: 'text/plain',
      sha256: createHash('sha256').update(documentId).digest('hex'),
      byteSize: 12,
      storedPath: `${businessId}/${documentId}/original.txt`,
    },
    { businessId },
  );
  const readingId = await aReadingOf(documentId, businessId);
  return anApprovalForReading(businessId, bundle, readingId, MAILING_PROPOSAL);
}

/** The full chain in one call: a document with real bytes, backing a pending approval. */
async function aSignableApproval(
  businessId: string,
  docRoot: string,
  bytes: Buffer,
  proposal: Proposal = FILING_PROPOSAL,
): Promise<{ approvalId: string; jobId: string; documentId: string; sha256: string }> {
  const bundle = await installCharter(buildCharter(), { businessId });
  const { documentId, sha256 } = await aDocument(businessId, docRoot, bytes);
  const readingId = await aReadingOf(documentId, businessId);
  const { approvalId, jobId } = await anApprovalForReading(businessId, bundle, readingId, proposal);
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

describe('GET /conversation', () => {
  it('refuses the conversation screen without a session', async () => {
    const baseUrl = await startServer(BUSINESS);

    const res = await fetch(`${baseUrl}/conversation`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('shows the full record behind a session, oldest first, labelled by sender', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    await recordInbound(
      {
        providerMessageId: 'wamid.owner.1',
        senderNumber: '+972501111111',
        senderKind: 'principal',
        body: 'תזכיר לי להתקשר לדנה',
        mediaKind: null,
        providerTimestamp: '2026-10-03T08:00:00.000Z',
      },
      { businessId: BUSINESS },
    );
    // A bidi override in a stranger's own message, the same class
    // `conversation-view.test.ts` already proves `escLabel` strips.
    await recordInbound(
      {
        providerMessageId: 'wamid.stranger.1',
        senderNumber: '+972509999999',
        senderKind: 'other',
        body: 'שלום‮גרר',
        mediaKind: null,
        providerTimestamp: '2026-10-03T08:05:00.000Z',
      },
      { businessId: BUSINESS },
    );
    await recordOutbound({ body: 'קיבלתי, אני מטפלת בזה', jobId: null }, { businessId: BUSINESS });

    const res = await fetch(`${baseUrl}/conversation`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('שיחת הוואטסאפ');
    expect(body).toContain('תזכיר לי להתקשר לדנה');
    expect(body).toContain('אתה (בעל העסק)');
    // The stranger's bidi override is stripped, but the message is shown
    // and labelled — never hidden, never silently ignored (decision 5).
    expect(body).not.toContain('‮');
    expect(body).toContain('שולח אחר');
    expect(body).toContain('קיבלתי, אני מטפלת בזה');
    expect(body).toContain('העוזרת');
    // The owner's own words first (oldest), then the stranger's, then the
    // assistant's reply last (newest) — chronological order on the page.
    const ownerIdx = body.indexOf('תזכיר לי להתקשר לדנה');
    const strangerIdx = body.indexOf('שולח אחר');
    const assistantIdx = body.indexOf('קיבלתי, אני מטפלת בזה');
    expect(ownerIdx).toBeLessThan(strangerIdx);
    expect(strangerIdx).toBeLessThan(assistantIdx);
    // The compose box posts to the existing /instruct door — no second one.
    expect(body).toContain('action="/instruct"');
  });

  it('says there is no conversation yet when nothing has been recorded', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/conversation`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('לא התקבלה אף הודעה');
  });

  /**
   * Fix round 1, Important 2: truncation must be detected honestly —
   * `fetched.length === CONVERSATION_LIMIT` is ALSO what a history of
   * exactly 200 messages looks like, so that is not a safe test. Seeding
   * exactly 200 rows proves the honest check (asking for one more than the
   * limit) does not false-positive on the boundary itself.
   */
  async function seedMessages(businessId: string, count: number): Promise<void> {
    await getPool().query(
      `INSERT INTO whatsapp_messages
         (id, business_id, direction, sender_number, sender_kind, body, provider_timestamp, state)
       SELECT 'WA-SEED-' || lpad(gs::text, 6, '0'), $1, 'inbound', '+972500000000', 'principal',
              'הודעה ' || gs, now() - (interval '1 second' * ($2 - gs)), 'handled'
       FROM generate_series(1, $2) AS gs`,
      [businessId, count],
    );
  }

  it('shows no truncation note when the history is exactly at the limit', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    await seedMessages(BUSINESS, 200);

    const res = await fetch(`${baseUrl}/conversation`, { headers: { cookie } });
    const body = await res.text();
    expect(body).not.toContain('מוצגות ההודעות האחרונות בלבד');
    // The single oldest message of exactly 200 is still shown — nothing was
    // dropped at the boundary itself. `>...<` anchors the match so "הודעה 1"
    // cannot be satisfied by "הודעה 10"/"הודעה 100" etc.
    expect(body).toContain('>הודעה 1<');
  });

  it('shows the truncation note and drops only the single oldest message past the limit', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    await seedMessages(BUSINESS, 201);

    const res = await fetch(`${baseUrl}/conversation`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain('מוצגות ההודעות האחרונות בלבד');
    // Message 1 (the oldest of 201) is the one dropped; message 2 (now the
    // oldest shown) and message 201 (the newest) both remain.
    expect(body).not.toContain('>הודעה 1<');
    expect(body).toContain('>הודעה 2<');
    expect(body).toContain('>הודעה 201<');
  });
});

describe('GET /readings', () => {
  it('serves the readings screen behind a session', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/readings`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('מה קראתי');
  });

  it('refuses the readings screen without a session', async () => {
    const baseUrl = await startServer(BUSINESS);

    const res = await fetch(`${baseUrl}/readings`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  // I3: the previous test only proved the page's own heading renders, which
  // says nothing about the row content — dropping STANCE_LABEL, mangling a
  // reason, or breaking escLabel would all still pass it. This seeds a real
  // reading -> proposal chain and checks what actually reached the page: the
  // Hebrew stance label (not the raw enum value), the headline, a reason, and
  // a bidi-hostile filename with its visible characters intact and its
  // override character gone — the same guarantee the approval card's own
  // sign form is tested for.
  it('renders the stance label, headline, a reason and a bidi-safe filename from a real reading', async () => {
    const baseUrl = await startServer(BUSINESS);
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    // `NewProposal.jobId` is required, not nullable — every proposal is made
    // in service of a real job (`proposeForReading` always loads or creates
    // one first). The job never reaches `await_approval`: an `advise_against`
    // with no alternative raises no approval at all, which is exactly the
    // "no card" case this test also checks for.
    const job = await createJob({ charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS });

    const documentId = `DOC-${ulid()}`;
    // U+202E RIGHT-TO-LEFT OVERRIDE, exactly the payload
    // `document-for-approval`'s own bidi test uses.
    const originalName = 'invoice‮gpj.exe';
    await insertOrGetDocument(
      {
        documentId,
        source: 'manual',
        originalName,
        mediaType: 'text/plain',
        sha256: createHash('sha256').update(documentId).digest('hex'),
        byteSize: 10,
        storedPath: `${BUSINESS}/${documentId}/original.txt`,
      },
      { businessId: BUSINESS },
    );

    const { record } = await saveReading(
      {
        readingId: `RDG-${ulid()}`,
        documentId,
        status: 'read',
        reason: null,
        content: {
          summary: 'תקציר קצר של החוזה',
          findings: [],
          intents: [],
          unreadable: [],
        },
        provenance: 'boss',
        model: 'haiku',
        promptVersion: 'v1',
        briefHash: ulid().padEnd(64, '0'),
      },
      { businessId: BUSINESS },
    );

    const proposal: Proposal = {
      stance: 'advise_against',
      headline: 'אני נגד חתימה על ההסכם',
      reasons: [{ text: 'המחיר השתנה מהותית מהסיכום המקורי', findingLabel: 'מחיר', sourceRef: SOURCE }],
      action: null,
      clarifyingQuestion: null,
    };
    await saveProposal(
      {
        proposalId: `PR-${ulid()}`,
        readingId: record.readingId,
        jobId: job.jobId,
        status: 'proposed',
        reason: null,
        content: proposal,
        raw: '{}',
        model: 'haiku',
        promptVersion: 'v1',
      },
      { businessId: BUSINESS },
    );

    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const res = await fetch(`${baseUrl}/readings`, { headers: { cookie } });
    const body = await res.text();

    // STANCE_LABEL['advise_against'] — the Hebrew label, not the raw enum.
    expect(body).toContain('ממליצה שלא');
    expect(body).not.toContain('advise_against');
    expect(body).toContain('אני נגד חתימה על ההסכם');
    expect(body).toContain('המחיר השתנה מהותית מהסיכום המקורי');
    expect(body).toContain('invoice');
    expect(body).not.toContain('‮');
    // No approval behind this proposal (job_id is null): the screen must say
    // so, not silently omit the row or link to nothing.
    expect(body).toContain('אין כרטיס — אין פעולה לאשר');
  });
});

describe('GET /instruct, POST /instruct', () => {
  // M2: this asserted `toContain('מה לעשות')`, which is also the pending
  // list's own link label to this page — and `fetch` follows redirects, so a
  // handler replaced by `redirect(res, '/')` still returned 200 with that
  // string in the body and the test still passed. `name="text"` is the box
  // itself, and appears on no other page.
  it('serves the instruction box behind a session', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/instruct`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="text"');
  });

  // The memory screen (`GET /memory`) was reachable only by typing the URL —
  // no page linked to it, the same way `/erase` is one hop from here. This
  // locks the link in place so a future edit to this nav row cannot drop it
  // silently: without this assertion, removing the link leaves every other
  // test on this file green.
  it('links to the memory screen, the same way it links to erasure', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/instruct`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain('<a href="/memory">מה נזכר</a>');
    expect(body).toContain('<a href="/erase">מה לשכוח</a>');
  });

  it('refuses the instruction box without a session', async () => {
    const baseUrl = await startServer(BUSINESS);

    const res = await fetch(`${baseUrl}/instruct`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('refuses a submitted instruction without a CSRF token', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/instruct`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ text: 'תשלחי לדנה' }),
    });
    expect(res.status).toBe(403);
  });

  // The brief for this test named '4,000' as the expected substring, but
  // `instruct.ts` interpolates `MAX_INSTRUCTION_CHARS` (a bare number) with
  // no locale formatting anywhere on this path — the refusal reads "...
  // מ-4000 תווים...", not "4,000". Asserting the comma form would fail
  // against the actual (correct) refusal text.
  //
  // Bare '4000' is not enough, though — found while re-verifying this round's
  // fixes: `renderInstruct`'s base form always renders
  // `<textarea ... maxlength="4000" ...>`, on every refusal, regardless of
  // which one fired. `toContain('4000')` alone would pass against ANY
  // refusal — "no active charter", an empty instruction, anything — purely
  // from that decorative markup. Asserting the fuller Hebrew phrase from the
  // actual refusal sentence ("ארוכה מ-4000 תווים") is what ties this to the
  // length check specifically, since that phrase appears nowhere else on the
  // page.
  //
  // A charter is installed here (fix round 1, M1): without one, `runInstruction`
  // refuses at `loadActiveCharter` before `createJob` for ANY input, so the
  // empty `boss_instructions` table would hold whether or not the length cap
  // ever fired. Installing a charter means the length check is what actually
  // has to fire first for this to pass.
  it('shows the refusal when the instruction is too long, and opens no job', async () => {
    const baseUrl = await startServer(BUSINESS);
    await installCharter(buildCharter(), { businessId: BUSINESS });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const boxPage = await fetch(`${baseUrl}/instruct`, { headers: { cookie } });
    const csrf = extractCsrf(await boxPage.text());

    const res = await fetch(`${baseUrl}/instruct`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, text: 'א'.repeat(4001) }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('ארוכה מ-4000 תווים');
    const { rows } = await getPool().query(`SELECT 1 FROM boss_instructions`);
    expect(rows).toHaveLength(0);
    // M3: an empty `boss_instructions` is also true if the cap is deleted and
    // `saveInstruction` throws instead — `runInstruction` catches that throw,
    // fails the job it already opened, and returns a refusal that reads
    // differently but still leaves this table empty. What the cap uniquely
    // buys is that no job is opened at all, so that is what is asserted.
    const jobs = await getPool().query(`SELECT 1 FROM jobs WHERE business_id = $1`, [BUSINESS]);
    expect(jobs.rows).toHaveLength(0);
  });

  /**
   * I3: a clarifying question has to survive the page it was born on.
   *
   * `GET /instruct` rendered the empty box with no lookup at all, so the
   * parked job's id and its question existed only in the HTML of the POST
   * response that created them. Reload, navigate away or close the tab, and
   * the job was orphaned in `understand` — a phase nothing in the scheduler
   * touches — with the owner unable to ever see what they were asked.
   *
   * Set up the way `runInstruction` leaves it: an instruction row carrying
   * the question, on a job parked in `understand`, with no answer yet.
   */
  it('shows a parked question and its answer form on a fresh GET', async () => {
    const baseUrl = await startServer(BUSINESS);
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    const instruction = await saveInstruction(
      { jobId: job.jobId, text: 'תשלחי לדנה את ההצעה' },
      { businessId: BUSINESS },
    );
    await recordQuestion(instruction.instructionId, 'לאיזו דנה — כהן או לוי?', {
      businessId: BUSINESS,
    });
    await transition(job.jobId, {
      to: 'understand',
      actor: 'orchestrator',
      reason: 'test setup',
      businessId: BUSINESS,
    });

    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const body = await (await fetch(`${baseUrl}/instruct`, { headers: { cookie } })).text();

    expect(body).toContain('לאיזו דנה — כהן או לוי?');
    // The question without a way to answer it is half the feature.
    expect(body).toContain(`action="/instruct/${job.jobId}/answer"`);
  });

  it('does not list a question that has already been answered', async () => {
    const baseUrl = await startServer(BUSINESS);
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    const answeredJob = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    const answeredInstruction = await saveInstruction(
      { jobId: answeredJob.jobId, text: 'תשלחי לדנה את ההצעה' },
      { businessId: BUSINESS },
    );
    await recordQuestion(answeredInstruction.instructionId, 'לאיזו דנה?', {
      businessId: BUSINESS,
    });
    await transition(answeredJob.jobId, {
      to: 'understand',
      actor: 'orchestrator',
      reason: 'test setup',
      businessId: BUSINESS,
    });
    // The answer is recorded but the re-run refused, so the job is still
    // parked in `understand`. Phase alone would keep listing this as an open
    // question the owner has in fact already answered.
    await claimAnswer(answeredInstruction.instructionId, 'דנה כהן', { businessId: BUSINESS });

    // A second, still-open question on a different parked job. Without it,
    // an assertion that the answered question is absent would hold just as
    // well if the whole listing were deleted — this proves the listing
    // filters on the answer instead of proving nothing is listed at all.
    const openJob = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    const openInstruction = await saveInstruction(
      { jobId: openJob.jobId, text: 'תזמיני פגישה עם רואה החשבון' },
      { businessId: BUSINESS },
    );
    await recordQuestion(openInstruction.instructionId, 'איזה יום מתאים?', {
      businessId: BUSINESS,
    });
    await transition(openJob.jobId, {
      to: 'understand',
      actor: 'orchestrator',
      reason: 'test setup',
      businessId: BUSINESS,
    });

    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const body = await (await fetch(`${baseUrl}/instruct`, { headers: { cookie } })).text();

    expect(body).not.toContain('לאיזו דנה?');
    expect(body).toContain('איזה יום מתאים?');
  });
});

describe('renderInstruct — grantNote (fix round 1, C1)', () => {
  // `runInstruction`'s `grantNote` is non-null exactly when a plan spanned
  // more than one action class and so authorised nothing at all — before this
  // fix it was computed and then thrown away, and the owner would later meet
  // an approval card for something they believed the instruction had already
  // covered. A pipeline-level test driving a real multi-class plan through an
  // injected planner belongs in `instruct.test.ts` (this dashboard route has
  // no way to inject a planner); at this layer, a view-level test on
  // `renderInstruct` itself is what the fix brief calls "enough" — and it
  // fails the moment the note's rendering branch is removed.
  it('renders the grant note, HTML-escaped', () => {
    const html = renderInstruct({
      csrf: 'tok',
      grantNote:
        'ההוראה נגעה ביותר ממחלקת פעולה אחת <script>alert(1)</script>, ולכן לא ניתנה הרשאה אוטומטית.',
    });
    expect(html).toContain('ההוראה נגעה ביותר ממחלקת פעולה אחת');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders no note block when grantNote is absent', () => {
    const html = renderInstruct({ csrf: 'tok' });
    expect(html).not.toContain('ולכן לא ניתנה הרשאה אוטומטית');
  });
});

/**
 * F2 / spec §7.2. `identityNote` is the second half of "proceeds without
 * memory ומציינת זאת": without it the owner reads an ordinary success and
 * assumes what is remembered about that person was taken into account. It is
 * rendered the same way `grantNote` above is, at the same layer and for the
 * same reason — this route cannot inject a planner, so the pipeline half of
 * this lives in `instruct.test.ts`.
 */
describe('renderInstruct - identityNote (spec 7.2)', () => {
  it('renders the identity note, escaped', () => {
    const html = renderInstruct({
      csrf: 'tok',
      identityNote: 'המשכתי בלי מה שאני זוכרת <script>alert(1)</script> על אותו אדם.',
    });
    expect(html).toContain('המשכתי בלי מה שאני זוכרת');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders no identity note block when there is none', () => {
    const html = renderInstruct({ csrf: 'tok' });
    expect(html).not.toContain('המשכתי בלי מה שאני זוכרת');
  });

  /**
   * The two notes answer different questions and can both be true of one
   * instruction, so one must not displace the other.
   */
  it('renders both notes together', () => {
    const html = renderInstruct({
      csrf: 'tok',
      grantNote: 'לא ניתנה הרשאה אוטומטית.',
      identityNote: 'המשכתי בלי מה שאני זוכרת על אותו אדם.',
    });
    expect(html).toContain('לא ניתנה הרשאה אוטומטית');
    expect(html).toContain('המשכתי בלי מה שאני זוכרת');
  });
});

/**
 * F-live-2, the wiring half. The note itself is `instruct.ts`'s (proved
 * there, through an injected planner); what this proves is that the
 * `needs_answer` branch of `renderInstructionOutcome` actually passes it on.
 * The two halves have to be separate: this route calls `runInstruction`
 * without a planner on purpose, so it can never produce a planner-authored
 * clarifying question under test, and a view-level test on `renderInstruct`
 * alone would stay green with the wiring deleted.
 *
 * `renderInstructionOutcome` only ever writes a status line and a body, so a
 * response that captures both is the whole environment it needs.
 */
describe('renderInstructionOutcome - the note on a needs_answer outcome', () => {
  function capture(outcome: Parameters<typeof renderInstructionOutcome>[2]): string {
    let body = '';
    const res = {
      writeHead: () => undefined,
      end: (chunk?: unknown) => {
        body = typeof chunk === 'string' ? chunk : '';
      },
    } as unknown as ServerResponse;

    renderInstructionOutcome(res, { sessionId: 'S1', username: 'owner', mustChangePassword: false }, outcome);
    return body;
  }

  it('renders the identity note beside the question card', () => {
    const html = capture({
      status: 'needs_answer',
      jobId: 'J-1',
      instructionId: 'INS-1',
      question: 'על איזו הצעה מדובר?',
      instructionText: 'תשיבי לרונית',
      identityNote: 'לא ידעתי לזהות את "רונית", ולכן המשכתי בלי מה שאני זוכרת עליה.',
    });

    expect(html).toContain('על איזו הצעה מדובר?');
    expect(html).toContain('המשכתי בלי מה שאני זוכרת עליה');
  });

  /**
   * The identity question's own return carries `null`, because that question
   * already is the notice. Nothing extra must appear beside it.
   */
  it('renders no note when the outcome carries none', () => {
    const html = capture({
      status: 'needs_answer',
      jobId: 'J-1',
      instructionId: 'INS-1',
      question: 'למי התכוונת ב"רונית"?',
      instructionText: 'תשיבי לרונית',
      identityNote: null,
    });

    expect(html).toContain('למי התכוונת');
    expect(html).not.toContain('המשכתי בלי מה שאני זוכרת');
  });
});

describe('reasonForSupersededJob (fix round 1, I2; narrowed in fix round 2, N1/N2)', () => {
  // Fix round 2: `reasonForSupersededJob` no longer accepts a `refused`
  // outcome at all — its parameter type is `Extract<..., { jobId: string }>`,
  // which `refused` (no `jobId` field) does not satisfy. That used to be a
  // runtime branch ("says no replacement was created..."); the route now
  // never calls this function on a `refused` outcome in the first place (see
  // `handleInstructAnswer`), so the "no replacement" case is a compile-time
  // impossibility rather than a string this function has to produce.
  it('names the replacement job when the re-run produced one', () => {
    expect(
      reasonForSupersededJob({
        status: 'planned',
        jobId: 'J-REPLACEMENT',
        instructionId: 'INS-1',
        granted: [],
        grantNote: null,
        identityNote: null,
      }),
    ).toContain('J-REPLACEMENT');

    expect(
      reasonForSupersededJob({
        status: 'needs_answer',
        jobId: 'J-ASKS-AGAIN',
        instructionId: 'INS-1',
        question: 'איזו דנה?',
        instructionText: 'תשלחי לדנה את ההצעה',
        identityNote: null,
      }),
    ).toContain('J-ASKS-AGAIN');
  });
});

describe('POST /instruct/:jobId/answer', () => {
  /**
   * A job parked in `understand` carrying a real instruction, wired up the
   * same way `runInstruction` itself would leave it while waiting on an
   * answer (a real `charter_versions` row, so `jobs.charter_version`'s FK is
   * satisfied, and the `intake → understand` move `saveInstruction` is
   * followed by in production).
   *
   * `installCharter` activates the charter it installs — there is no
   * "installed but inactive" variant in this helper (an earlier version of
   * this file deactivated it again with a `DELETE FROM charter_active` after
   * calling this, to keep `loadActiveCharter` missing; that line is gone).
   * So every test in this block that re-runs the pipeline for real DOES reach
   * `loadActiveCharter` with a hit, and would proceed toward the live
   * planner. What keeps these tests off the network instead is entirely the
   * length cap: every answer POSTed here is sized so the joined instruction
   * either exceeds `MAX_INSTRUCTION_CHARS` on its own or fails a guard before
   * `runInstruction` is ever called — `runInstruction` checks that cap before
   * `loadActiveCharter`, so a long-enough join refuses before the charter (or
   * the planner) is ever consulted. There is no other guard here doing that
   * job; a future test in this block that posts a short answer against a job
   * with an active charter WILL reach the live planner.
   *
   * A test that needs the job somewhere OTHER than `understand` (fix round 2,
   * N2's phase guard tests) transitions it further after calling this.
   */
  async function anInstructionJob(businessId: string, text: string): Promise<string> {
    const bundle = await installCharter(buildCharter(), { businessId });
    const job = await createJob({ charterVersion: bundle.charterVersion, provenance: 'boss', businessId });
    await saveInstruction({ jobId: job.jobId, text }, { businessId });
    await transition(job.jobId, { to: 'understand', actor: 'orchestrator', reason: 'test setup', businessId });
    return job.jobId;
  }

  it('refuses without a CSRF token', async () => {
    const baseUrl = await startServer(BUSINESS);
    const jobId = await anInstructionJob(BUSINESS, 'תשלחי לדנה את ההצעה');
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/instruct/${jobId}/answer`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ answer: 'דנה כהן' }),
    });
    expect(res.status).toBe(403);

    const stored = await loadInstructionForJob(jobId, { businessId: BUSINESS });
    expect(stored?.answer).toBeNull();
  });

  it('refuses without a session', async () => {
    const baseUrl = await startServer(BUSINESS);
    const jobId = await anInstructionJob(BUSINESS, 'תשלחי לדנה את ההצעה');

    const res = await fetch(`${baseUrl}/instruct/${jobId}/answer`, {
      method: 'POST',
      body: new URLSearchParams({ answer: 'דנה כהן' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  // The exact case the task calls out: `loadInstructionForJob` returns
  // `null` for a job that belongs to another business — a value, not a
  // throw — and the route has to turn that into a clean refusal itself.
  it("refuses to answer another business's job instead of throwing", async () => {
    const baseUrl = await startServer(BUSINESS);
    const otherJobId = await anInstructionJob(OTHER_BUSINESS, 'תשלחי לדנה את ההצעה');
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const boxPage = await fetch(`${baseUrl}/instruct`, { headers: { cookie } });
    const csrf = extractCsrf(await boxPage.text());

    const res = await fetch(`${baseUrl}/instruct/${otherJobId}/answer`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, answer: 'דנה כהן' }),
    });
    expect(res.status).toBe(404);

    const stored = await loadInstructionForJob(otherJobId, { businessId: OTHER_BUSINESS });
    expect(stored?.answer).toBeNull();
  });

  // Fix round 1, M2: the textarea's `required` is client-side only, and
  // `answer` (unlike `text`) carries no CHECK constraint. An empty answer
  // recorded as-is would overwrite any earlier answer and re-run the pipeline
  // on text byte-identical to the original instruction, so the planner would
  // ask the very same question again — forever. Refused before `claimAnswer`
  // runs at all: the stored answer stays `null`.
  it('refuses a whitespace-only answer without recording it', async () => {
    const baseUrl = await startServer(BUSINESS);
    const jobId = await anInstructionJob(BUSINESS, 'תשלחי לדנה את ההצעה');
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const boxPage = await fetch(`${baseUrl}/instruct`, { headers: { cookie } });
    const csrf = extractCsrf(await boxPage.text());

    const res = await fetch(`${baseUrl}/instruct/${jobId}/answer`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, answer: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('התשובה ריקה');

    const stored = await loadInstructionForJob(jobId, { businessId: BUSINESS });
    expect(stored?.answer).toBeNull();
    // The parked job is untouched — refused before the close-out transition
    // too, and still `understand` (fix round 2: `anInstructionJob` parks the
    // job there directly, matching where a real answer-pending job sits).
    const job = await loadJob(jobId, { businessId: BUSINESS });
    expect(job?.phase).toBe('understand');
  });

  // Fix round 1, M2: `answer` has no CHECK constraint bounding it the way
  // `text` does, so without this a hand-crafted POST could put up to
  // `MAX_BODY_BYTES` of it in the column.
  it('refuses an answer longer than the instruction cap without recording it', async () => {
    const baseUrl = await startServer(BUSINESS);
    const jobId = await anInstructionJob(BUSINESS, 'תשלחי לדנה את ההצעה');
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const boxPage = await fetch(`${baseUrl}/instruct`, { headers: { cookie } });
    const csrf = extractCsrf(await boxPage.text());

    const res = await fetch(`${baseUrl}/instruct/${jobId}/answer`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, answer: 'א'.repeat(4001) }),
    });
    expect(res.status).toBe(400);
    // Not bare '4000' — see the note above the instruction-length test:
    // `renderInstruct`'s base form always carries `maxlength="4000"`, on
    // every refusal. The full sentence this route's own error text produces
    // ("התשובה ארוכה מ-...") appears nowhere else on the page.
    expect(await res.text()).toContain('התשובה ארוכה מ-4000 תווים');

    const stored = await loadInstructionForJob(jobId, { businessId: BUSINESS });
    expect(stored?.answer).toBeNull();
  });

  // Fix round 1, I1: the reviewer's probe. `runInstruction` checks the length
  // cap BEFORE `loadActiveCharter`, so a ~3,990-character original plus a
  // 20-character answer crosses 4,000 only once both halves are joined.
  // Dropping either half from the join (the original text, or the answer)
  // would leave the joined length under the cap, so `instruct.ts`'s own
  // length-refusal branch — the ONLY place "ההוראה ארוכה מ-4000 תווים" comes
  // from — would never fire, and the response would carry different text
  // instead (or, since nothing here would then refuse before `createJob`,
  // would actually reach the live planner — see the mutation note in this
  // block's own verification below). Not bare '4000': that also sits in
  // `renderInstruct`'s decorative `maxlength="4000"`, present on every
  // refusal regardless of cause, which is what let an earlier version of
  // this exact test pass by coincidence when the join itself was broken —
  // caught only by manually re-verifying the mutation.
  it('joins the original instruction and the answer before re-running the pipeline', async () => {
    const baseUrl = await startServer(BUSINESS);
    const originalText = 'א'.repeat(3990);
    const jobId = await anInstructionJob(BUSINESS, originalText);
    const answer = 'ב'.repeat(20);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const boxPage = await fetch(`${baseUrl}/instruct`, { headers: { cookie } });
    const csrf = extractCsrf(await boxPage.text());

    const res = await fetch(`${baseUrl}/instruct/${jobId}/answer`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, answer }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('ההוראה ארוכה מ-4000 תווים');

    const stored = await loadInstructionForJob(jobId, { businessId: BUSINESS });
    expect(stored?.answer).toBe(answer);
  });

  /**
   * **Task 12, fix round 1, Important 3 rewrote this test, and the property it
   * was protecting still holds.** Fix round 2's N1 made a refused re-run leave
   * the parked job in `understand` so a second POST would not meet
   * `failed → failed` — an illegal transition that threw uncaught to the
   * top-level 500 handler. The no-500 property is what mattered and is
   * asserted below unchanged; what changed is how it is obtained.
   *
   * Leaving the job parked turned out to be the wrong half of the fix: the
   * answer is recorded BEFORE the re-run, so the parked job was already out of
   * `pendingQuestions` and `GET /instruct` could not list it. The owner was
   * left with an instruction permanently open, invisible on the screen built
   * to show open ones, and never reported — the
   * instruction-silently-disappears class, and against the owner's own rule
   * that an instruction stays open only until one side says it is finished.
   * The route now CLOSES it and says so, exactly as the WhatsApp door does, so
   * the second POST meets the PHASE GUARD and is refused with a readable
   * sentence instead of throwing.
   *
   * Both POSTs stay under the length cap's live-planner avoidance strategy
   * (see the note on `anInstructionJob`): each answer alone is well under
   * `MAX_INSTRUCTION_CHARS`, but joined with the ~3,990-character original
   * both cross it, so both refuse deterministically before `createJob` —
   * never reaching the planner.
   */
  it('closes the parked job when a re-run refuses, and refuses a second POST instead of 500ing', async () => {
    const baseUrl = await startServer(BUSINESS);
    const originalText = 'א'.repeat(3990);
    const jobId = await anInstructionJob(BUSINESS, originalText);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const boxPage = await fetch(`${baseUrl}/instruct`, { headers: { cookie } });
    const csrf = extractCsrf(await boxPage.text());

    const firstRes = await fetch(`${baseUrl}/instruct/${jobId}/answer`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, answer: 'ב'.repeat(20) }),
    });
    expect(firstRes.status).toBe(400);
    const firstBody = await firstRes.text();
    // The refusal itself, AND what became of the previous request — the owner
    // is never left to infer that it is still waiting when it is not.
    expect(firstBody).toContain('ההוראה ארוכה מ-4000 תווים');
    expect(firstBody).toContain('סגרתי את הבקשה הקודמת');

    const afterFirst = await loadJob(jobId, { businessId: BUSINESS });
    expect(afterFirst?.phase).toBe('closed');
    // Nothing is left for `GET /instruct` to show, which is the point: it
    // could not have shown it anyway (the answer is recorded), so the state
    // now matches what the owner can see.
    expect(await pendingQuestions({ businessId: BUSINESS })).toEqual([]);

    // The retry — same job, a different (still over-cap-when-joined) answer.
    // The property fix round 2 bought is unchanged: a readable refusal, never
    // a 500 from an illegal `failed → failed`. It now comes from the phase
    // guard rather than from the job having been left parked.
    const secondRes = await fetch(`${baseUrl}/instruct/${jobId}/answer`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, answer: 'ג'.repeat(20) }),
    });
    expect(secondRes.status).toBe(400);
    expect(await secondRes.text()).toContain('כבר אינה ממתינה לתשובה');

    const afterSecond = await loadJob(jobId, { businessId: BUSINESS });
    expect(afterSecond?.phase).toBe('closed');
  });

  // Fix round 2, N1 (the other side): once a re-run DOES produce a
  // replacement, the parked job is closed out — and a second POST against
  // the now-closed job must meet the phase guard, not attempt (and illegally
  // repeat) another close-out. Reaching a genuine `planned`/`needs_answer`
  // outcome through this route needs a live model call (see the module
  // docblock), so this simulates the post-success state directly: transition
  // the parked job to `failed` the same way `handleInstructAnswer` itself
  // would after a successful re-run, then POST again.
  it('refuses a second POST after the parked job has already been closed out', async () => {
    const baseUrl = await startServer(BUSINESS);
    const jobId = await anInstructionJob(BUSINESS, 'תשלחי לדנה את ההצעה');
    await transition(jobId, {
      to: 'failed',
      actor: 'human',
      reason: 'instruction door: answered; superseded by J-SIMULATED-REPLACEMENT',
      businessId: BUSINESS,
    });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const boxPage = await fetch(`${baseUrl}/instruct`, { headers: { cookie } });
    const csrf = extractCsrf(await boxPage.text());

    const res = await fetch(`${baseUrl}/instruct/${jobId}/answer`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, answer: 'תשובה כלשהי' }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('כבר אינה ממתינה לתשובה');

    // The guard fires before `claimAnswer` — the row from the original
    // answer (never set in this test) stays untouched, not overwritten.
    const stored = await loadInstructionForJob(jobId, { businessId: BUSINESS });
    expect(stored?.answer).toBeNull();
  });

  /**
   * I2: a POST that cannot take the job's claim is turned away and writes
   * nothing.
   *
   * The phase guard is a read, and `runInstruction` makes a live model call
   * before anything writes — nothing held a lock across that window. Two
   * POSTs (a double-click on the answer button, with a multi-second gap) both
   * passed the guard, both recorded an answer, and both created a job, a
   * grant, a binding and a promotion to `execute`. Then both transitioned the
   * parked job to `failed`, and the second met a job already `failed` and
   * threw uncaught to the 500 handler: two authorised, bound plans for one
   * answer, and an error suggesting nothing happened.
   *
   * **Why this test holds the claim itself instead of firing two POSTs at
   * once.** The racing form of this test was flaky, and the reason is worth
   * keeping: when the two requests do NOT overlap, the second one takes the
   * claim uncontested and the phase guard does not stop it either — a
   * `refused` re-run deliberately leaves the parked job in `understand`
   * (see `withJobClaim`'s docblock for why), so under `NODE_ENV=test`, where
   * `refuseUnderTest` makes every re-run refuse, BOTH serialised requests
   * legitimately run to the end and open a job. The racing test therefore
   * asserted on an overlap no test can schedule, and failed on whichever
   * machine happened to run the two back to back. Taking the route's own
   * advisory lock from this connection makes the contested case the only
   * case: the request below provably loses the claim.
   *
   * Unlike every other test in this block, this one deliberately posts a
   * SHORT answer, so nothing but the claim stands between the request and
   * `createJob` — which is what the job count at the end proves did not
   * happen. It still never touches the network.
   */
  it('turns away an answer while the job is already claimed, and writes nothing', async () => {
    const baseUrl = await startServer(BUSINESS);
    const jobId = await anInstructionJob(BUSINESS, 'תשלחי לדנה את ההצעה');
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const boxPage = await fetch(`${baseUrl}/instruct`, { headers: { cookie } });
    const csrf = extractCsrf(await boxPage.text());

    // The same scope string and the same key derivation the route uses.
    const scope = `instruct-answer:${BUSINESS}:${jobId}`;
    const holder = await getPool().connect();
    let response: Response;
    try {
      const taken = await holder.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [scope],
      );
      // Positive half: the lock is genuinely held while the POST runs. Without
      // this, a scope string that stopped matching the route's would leave
      // every assertion below passing for the wrong reason.
      expect(taken.rows[0]?.locked).toBe(true);

      response = await fetch(`${baseUrl}/instruct/${jobId}/answer`, {
        method: 'POST',
        headers: { cookie },
        body: new URLSearchParams({ csrf, answer: 'דנה כהן' }),
      });
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [scope]);
      holder.release();
    }

    // Refused with something the owner can read — never a 500.
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('כבר בטיפול');

    // Nothing was written: no answer recorded, and no second job opened. The
    // parked job is still the only one. Without the claim this request reaches
    // `claimAnswer` and `createJob` and both of these go red.
    const stored = await loadInstructionForJob(jobId, { businessId: BUSINESS });
    expect(stored?.answer).toBeNull();
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM jobs WHERE business_id = $1',
      [BUSINESS],
    );
    expect(rows[0]?.n).toBe('1');

    // And the job is still waiting, so the owner's resubmit lands on a job in
    // the phase the route requires.
    const job = await loadJob(jobId, { businessId: BUSINESS });
    expect(job?.phase).toBe('understand');
  });

  // Fix round 2, N2: the route must not be able to fail an unrelated,
  // in-flight job just because it shares a business and carries an
  // instruction row — which any successfully planned instruction does.
  // `execute → failed` is a legal transition, so without the phase guard this
  // would silently kill a running plan.
  it("refuses to answer a job that isn't parked (e.g. already executing), and leaves it untouched", async () => {
    const baseUrl = await startServer(BUSINESS);
    const jobId = await anInstructionJob(BUSINESS, 'תשלחי לדנה את ההצעה');
    for (const to of ['plan', 'execute'] as const) {
      await transition(jobId, { to, actor: 'orchestrator', reason: 'test setup', businessId: BUSINESS });
    }
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const boxPage = await fetch(`${baseUrl}/instruct`, { headers: { cookie } });
    const csrf = extractCsrf(await boxPage.text());

    const res = await fetch(`${baseUrl}/instruct/${jobId}/answer`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, answer: 'תשובה כלשהי' }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('כבר אינה ממתינה לתשובה');

    const job = await loadJob(jobId, { businessId: BUSINESS });
    expect(job?.phase).toBe('execute');
    const stored = await loadInstructionForJob(jobId, { businessId: BUSINESS });
    expect(stored?.answer).toBeNull();
  });

  /**
   * F3 / spec §7.2's loop bound, tested at the wire.
   *
   * `identityAsked: true` in `answerUnderClaim` is the single argument that
   * stops the identity question being asked again on every pass, forever.
   * The existing §7.2 test injects that option straight into
   * `runInstruction`, so it proves the OPTION works and nothing proves this
   * ROUTE passes it: reverting the argument to `{ businessId }` left
   * `server.test.ts` and `instruct.test.ts` entirely green.
   *
   * This test posts an answer that genuinely fails to narrow a real
   * ambiguity — two contacts named רונית, an answer naming neither — so the
   * second pass reaches the identity check with `ambiguities` non-empty. The
   * negative assertion alone would be worthless (the request could refuse
   * earlier for any reason and still not contain the question), so the
   * positive one is what makes it bite: the response must carry the
   * planner-failure refusal, which is only reachable by running PAST the
   * identity check. Without the argument the route returns the identity
   * question instead and both assertions flip.
   *
   * Like the concurrency test above, this posts a SHORT answer and so runs
   * past the length cap — and stays off the network the same way, through
   * `makePlan`'s `refuseUnderTest`.
   */
  it('does not ask the identity question again when answering through the route', async () => {
    const baseUrl = await startServer(BUSINESS);
    const jobId = await anInstructionJob(BUSINESS, 'תשיבי לרונית');

    // Two people one name — the ambiguity the answer below will not settle.
    const seedJob = await createJob({
      charterVersion: (await loadJob(jobId, { businessId: BUSINESS }))?.charterVersion ?? '',
      provenance: 'boss',
      businessId: BUSINESS,
    });
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-cohen-beta-log',
        body: { name: 'רונית כהן', company: 'בטא לוגיסטיקה' },
      },
      { businessId: BUSINESS },
    );
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-levi-gamma',
        body: { name: 'רונית לוי', company: 'גמא הרמה' },
      },
      { businessId: BUSINESS },
    );

    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
    const boxPage = await fetch(`${baseUrl}/instruct`, { headers: { cookie } });
    const csrf = extractCsrf(await boxPage.text());

    const res = await fetch(`${baseUrl}/instruct/${jobId}/answer`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, answer: 'אני לא זוכר' }),
    });
    const body = await res.text();

    // It ran the pipeline through to the planner, which is only possible
    // past the identity check.
    expect(body).toContain('קריאת המתכנן נכשלה');
    // And it did not ask a second time.
    expect(body).not.toContain('למי התכוונת');
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

// Task 11: `loadVerificationOutcome` is called by the ROUTE, at request time
// — never stashed when the card is created — so a verdict that shows up later shows
// up on the very next load, and a card whose verification never even started
// renders exactly as it always has.
describe('the gov.verify verdict on a card', () => {
  // Fix round 1, Important 6: printed VERBATIM, with one caveat sentence —
  // never reformatted. A prior version added thousands separators and could
  // not undo the other two transformations `ungroundedNumbers` entries
  // already carry (a stripped trailing decimal zero, a rewritten sign), and
  // it MANUFACTURED a false one of its own: grouping a phone-shaped token's
  // digits with commas asserts a magnitude the draft never had.
  it('shows the verdict when one exists, with its numbers printed verbatim and a caveat', async () => {
    const baseUrl = await startServer(BUSINESS);
    const job = await jobAwaitingApproval(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId });
    await saveVerdict(
      job.jobId,
      {
        criteria: [
          {
            id: 'answers_question',
            statement: 'הטיוטה עונה על מה שהמסמך מבקש',
            severity: 'must',
            passed: true,
            detail: 'הסכום תואם את הצעת המחיר',
          },
        ],
        ungroundedNumbers: ['12500', '-99'],
        answerTruncated: false,
        draftTruncated: false,
        fenceForgeryDetected: false,
      },
      { businessId: BUSINESS },
    );
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const body = await (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();

    // Verbatim — not reformatted with separators.
    expect(body).toContain('12500');
    expect(body).toContain('-99');
    expect(body).not.toContain('12,500');
    // The caveat sentence saying these are a normalised comparison form.
    expect(body).toContain('בצורתם המנורמלת להשוואה');
    expect(body).toContain('הסכום תואם את הצעת המחיר');
  });

  it('renders exactly as before when no verdict exists', async () => {
    const baseUrl = await startServer(BUSINESS);
    const job = await jobAwaitingApproval(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId });
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain('gov.verify');
    // The ordinary controls are untouched — a missing verdict removes only
    // its own block, nothing else on the card.
    expect(body).toContain(`/a/${approvalId}/approve`);
    expect(body).toContain(`/a/${approvalId}/deny`);
  });

  // Small (a): a hostile ungrounded-number entry, so the escaping on THAT
  // path is proven too — swapping `escLabel` for raw interpolation there
  // fails nothing if this is missing, because the criteria-text path alone
  // already exercises `escLabel`.
  it('escapes the verdict like every other untrusted label on this page', async () => {
    const baseUrl = await startServer(BUSINESS);
    const job = await jobAwaitingApproval(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId });
    await saveVerdict(
      job.jobId,
      {
        criteria: [
          {
            id: 'x',
            statement: '<script>alert(1)</script>',
            // U+202E RIGHT-TO-LEFT OVERRIDE inside a quoted fragment — the
            // exact category `escLabel` exists for (views.ts's own docblock),
            // quoting a draft written after reading a document someone else
            // sent.
            detail: 'מצטט מהטיוטה: <img src=x onerror=alert(1)>‮attack',
            severity: 'should',
            passed: false,
          },
        ],
        // Not a realistic normalised number, but the numbers path prints
        // whatever string is in the column — it must be escaped exactly like
        // any other untrusted field reaching this page.
        ungroundedNumbers: ['<b>1</b>‮2'],
        answerTruncated: false,
        draftTruncated: false,
      },
      { businessId: BUSINESS },
    );
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const body = await (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();

    expect(body).not.toContain('<script>');
    expect(body).not.toContain('<img src=x onerror=alert(1)>');
    expect(body).not.toContain('<b>1</b>');
    expect(body).not.toContain('‮');
  });

  // Small (b): all three `fenceForgeryDetected` states, each rendering a
  // distinct, own sentence — including the `true` branch, the actual
  // security signal, which no test previously rendered at all.
  describe('fenceForgeryDetected — three states, three sentences', () => {
    async function cardWith(
      businessId: string,
      overrides: { fenceForgeryDetected?: boolean } = {},
    ): Promise<{ baseUrl: string; approvalId: string }> {
      const baseUrl = await startServer(businessId);
      const job = await jobAwaitingApproval(businessId);
      const approvalId = await makeApproval({ businessId, jobId: job.jobId });
      await saveVerdict(
        job.jobId,
        {
          criteria: [{ id: 'x', statement: 'y', severity: 'must', passed: true, detail: 'z' }],
          ungroundedNumbers: [],
          answerTruncated: false,
          draftTruncated: false,
          ...overrides,
        },
        { businessId },
      );
      return { baseUrl, approvalId };
    }

    it('true — a warning naming the attempt', async () => {
      const { baseUrl, approvalId } = await cardWith(BUSINESS, { fenceForgeryDetected: true });
      const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
      const body = await (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();
      expect(body).toContain('זוהה');
    });

    it('false — a quiet confirmation that it was checked', async () => {
      const { baseUrl, approvalId } = await cardWith(BUSINESS, { fenceForgeryDetected: false });
      const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
      const body = await (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();
      expect(body).toContain('נבדק, ולא נמצא');
    });

    it('absent (a pre-field row) — "not known whether checked", never conflated with false', async () => {
      const baseUrl = await startServer(BUSINESS);
      const job = await jobAwaitingApproval(BUSINESS);
      const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId });
      // Bypasses `saveVerdict`'s TS type on purpose — a row written before
      // `fenceForgeryDetected` existed carries no such key at all.
      await getPool().query(
        `INSERT INTO verification_verdicts (business_id, job_id, verdict) VALUES ($1, $2, $3::jsonb)`,
        [
          BUSINESS,
          job.jobId,
          JSON.stringify({
            criteria: [{ id: 'x', statement: 'y', severity: 'must', passed: true, detail: 'z' }],
            ungroundedNumbers: [],
            answerTruncated: false,
            draftTruncated: false,
          }),
        ],
      );
      const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
      const body = await (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();
      expect(body).toContain('לא ידוע אם נבדק');
    });
  });

  // Fix round 1, Important 4: `Verdict.parse` throws on a row that fails to
  // validate, and this route is the only thing between that row and the
  // owner's entire decision surface (approve/deny/edit/note/sign all render
  // through the same function). A bad row must degrade to a note, never a
  // generic 500 that takes every control on the page down with it.
  it('renders a note instead of a 500 when the verdict row cannot be parsed', async () => {
    const baseUrl = await startServer(BUSINESS);
    const job = await jobAwaitingApproval(BUSINESS);
    const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId });
    // `criteria: []` violates `Verdict`'s own `.min(1)` — a row `saveVerdict`
    // itself could never produce, exactly the "corrupted or pre-migration
    // row" shape this guard exists for.
    await getPool().query(
      `INSERT INTO verification_verdicts (business_id, job_id, verdict) VALUES ($1, $2, $3::jsonb)`,
      [BUSINESS, job.jobId, JSON.stringify({ criteria: [] })],
    );
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('לא ניתן היה לקרוא');
    // The rest of the decision surface survives untouched.
    expect(body).toContain(`/a/${approvalId}/approve`);
    expect(body).toContain(`/a/${approvalId}/deny`);
  });

  // Task 5: `loadVerificationOutcome` replaces `loadVerdict` on the route, so
  // the card can tell apart three states instead of two — "still running"
  // (no row), the real verdict (already covered above), and "attempted and
  // did not finish" with one of three reasons. Absence must mean only one
  // thing, so each assertion below also checks the OTHER states' text is not
  // what rendered.
  it('says the check is still running when no row exists', async () => {
    const baseUrl = await startServer(BUSINESS);
    // A CONDUCTOR-raised card, not a bare job: the note is conditioned on a
    // verification actually being expected for this card, and only the
    // conductor path opens one. See `stillRunningNote` in `views.ts`.
    const { approvalId } = await aConductorRaisedApproval(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const body = await (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();

    expect(body).toContain('בבדיקה');
    // Not the not-judged sentence, and not a real verdict block.
    expect(body).not.toContain('הבדיקה לא הושלמה');
    expect(body).not.toContain('בדיקת איכות (gov.verify)');
  });

  /**
   * Final wave, Important 1: the note used to render on the ABSENCE of all
   * three verdict states, and that absence has more causes than "still
   * running". `beginVerification` has one caller — the conductor loop — so a
   * card the conductor never raised never gets a verification at all, and read
   * "בבדיקה" forever. Two classes, one test each, and both are shapes
   * production really produces.
   */
  describe('and says nothing at all on a card verification never reaches', () => {
    it('an orphan card — approval_requests.job_id IS NULL, the SDK path', async () => {
      const baseUrl = await startServer(BUSINESS);
      await installCharter(buildCharter(), { businessId: BUSINESS });
      const approvalId = await makeApproval({ businessId: BUSINESS, jobId: null });
      const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

      const body = await (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();

      // The card itself renders — this is about the note, not about a 404.
      expect(body).toContain(`/a/${approvalId}/approve`);
      expect(body).not.toContain('בבדיקה');
    });

    it('a gate-raised card with a job the conductor never handled', async () => {
      const baseUrl = await startServer(BUSINESS);
      // `enqueueApproval` at gate stage 10 on the instruction path: a real job
      // id, and no proposal behind it, because no document was ever read.
      const job = await jobAwaitingApproval(BUSINESS);
      const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId });
      const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

      const body = await (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();

      expect(body).toContain(`/a/${approvalId}/approve`);
      expect(body).not.toContain('בבדיקה');
    });
  });

  describe('not judged — attempted and did not finish, one sentence per reason', () => {
    async function cardWithReason(reason: NotJudgedReason): Promise<string> {
      const baseUrl = await startServer(BUSINESS);
      const job = await jobAwaitingApproval(BUSINESS);
      const approvalId = await makeApproval({ businessId: BUSINESS, jobId: job.jobId });
      await saveNotJudged(job.jobId, reason, { businessId: BUSINESS });
      const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);
      return (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();
    }

    it('failed — names the helper failure, not the other two reasons', async () => {
      const body = await cardWithReason('failed');
      expect(body).toContain('הבדיקה לא הושלמה');
      expect(body).toContain('נכשל בהרצת הבדיקה');
      expect(body).not.toContain('לא השיב בזמן שהוקצב');
      expect(body).not.toContain('לא הצליח לחלץ תוכן קריא');
    });

    it('timeout — names the deadline, not the other two reasons', async () => {
      const body = await cardWithReason('timeout');
      expect(body).toContain('הבדיקה לא הושלמה');
      expect(body).toContain('לא השיב בזמן שהוקצב');
      expect(body).not.toContain('נכשל בהרצת הבדיקה');
      expect(body).not.toContain('לא הצליח לחלץ תוכן קריא');
    });

    it('unreadable — names the unreadable document, not the other two reasons', async () => {
      const body = await cardWithReason('unreadable');
      expect(body).toContain('הבדיקה לא הושלמה');
      expect(body).toContain('לא הצליח לחלץ תוכן קריא');
      expect(body).not.toContain('נכשל בהרצת הבדיקה');
      expect(body).not.toContain('לא השיב בזמן שהוקצב');
    });

    // The distinction the whole third state exists for: it must never read
    // as "checked and found nothing wrong" — a real verdict's own block, or
    // the still-running note, rendering instead.
    it('never reads as a passing verdict or as still running', async () => {
      const body = await cardWithReason('timeout');
      expect(body).not.toContain('בדיקת איכות (gov.verify)');
      expect(body).not.toContain('פסיקת האימות תופיע כאן');
    });
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

  // I4. `views.ts` rendered the sign form whenever a document resolved, and
  // after the conductor shipped, `documentForApproval` resolves one for EVERY
  // conductor card — each has a proposal with a `job_id` and a reading with a
  // document behind it. So a card proposing to email Dana carried a form
  // whose own text says signing establishes that the document was received as
  // binding, and the row it writes cannot be undone: unique on
  // `(business_id, document_id)`, a second signature refused, the row
  // protected by `ON DELETE RESTRICT` since migration 020.
  it('renders no sign form on a card whose proposal is about sending an email', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const { approvalId } = await aSignableApproval(
      BUSINESS,
      docRoot,
      Buffer.from('הסכם שיווק — כרטיס של מייל', 'utf8'),
      MAILING_PROPOSAL,
    );
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const body = await (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();

    expect(body).not.toContain(`/a/${approvalId}/sign`);
    expect(body).not.toContain('חתום ואשר');
    expect(body).not.toContain('נתקבל כמחייב');
    // The card still names the document it is about — removing the form must
    // not remove the only thing on the page identifying what was read.
    expect(body).toContain('חוזה עם קבלן');
    expect(body).toContain('המסמך שהבקשה נוגעת אליו');
    // And the ordinary controls are untouched.
    expect(body).toContain(`/a/${approvalId}/approve`);
  });

  it('renders the sign form on a card whose proposal is a decision about the document', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const { approvalId } = await aSignableApproval(
      BUSINESS,
      docRoot,
      Buffer.from('הסכם שיווק — כרטיס של תיוק', 'utf8'),
      FILING_PROPOSAL,
    );
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const body = await (await fetch(`${baseUrl}/a/${approvalId}`, { headers: { cookie } })).text();

    expect(body).toContain(`/a/${approvalId}/sign`);
    expect(body).toContain('חתום ואשר');
  });

  // The button is not the control; the route is. A stale tab, a bookmark or a
  // hand-written POST reaches `/sign` with no form involved at all, and on
  // the other side of it is a permanent, un-deletable `signatures` row.
  it('refuses a signing POST on a card whose proposal is not a document decision', async () => {
    const baseUrl = await startServer(BUSINESS, { documentRoot: docRoot });
    const { approvalId, documentId } = await aSignableApproval(
      BUSINESS,
      docRoot,
      Buffer.from('הסכם שיווק — POST ישיר', 'utf8'),
      MAILING_PROPOSAL,
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
    expect(signRes.status).toBe(400);

    expect(await loadSignature(documentId, { businessId: BUSINESS })).toBeNull();
    expect((await getApproval(approvalId, { businessId: BUSINESS }))?.state).toBe('pending');
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
  // `SameSite=Lax`, not `Strict` — see `sessionCookie`'s own docblock in
  // `server.ts`. A `Strict` cookie is withheld on the cross-site top-level
  // navigation Google uses to return the owner to `/oauth/callback`, which
  // would silently discard every authorisation code before the ceremony
  // could ever complete in a real browser.
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
    expect(setCookie).toContain('SameSite=Lax');
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

describe('GET /autonomy — the owner’s dial', () => {
  it('redirects to login without a session', async () => {
    const baseUrl = await startServer(BUSINESS);
    const res = await fetch(`${baseUrl}/autonomy`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('shows the current mode and all three positions', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/autonomy`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    // The floor a fresh business has (`governance/autonomy-mode.ts`'s
    // `MODE_FLOOR`) before anyone has ever touched the dial.
    expect(body).toContain('כבוי');
    expect(body).toContain('value="off" checked');
    expect(body).toContain('value="ask"');
    expect(body).toContain('value="learn"');
  });

  it('changes the mode and writes an audit row', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const getRes = await fetch(`${baseUrl}/autonomy`, { headers: { cookie } });
    const csrf = extractCsrf(await getRes.text());

    const postRes = await fetch(`${baseUrl}/autonomy/mode`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, mode: 'learn' }),
      redirect: 'manual',
    });
    expect(postRes.status).toBe(302);
    expect(postRes.headers.get('location')).toBe('/autonomy');

    expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('learn');
  });

  it('refuses a mode change without a CSRF token', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/autonomy/mode`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ mode: 'learn' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('off');
  });
});

describe('GET /autonomy/actions — what she did on her own', () => {
  it('redirects to login without a session', async () => {
    const baseUrl = await startServer(BUSINESS);
    const res = await fetch(`${baseUrl}/autonomy/actions`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('lists a step that ran without a card', async () => {
    const { jobId } = await seedAutonomousAction(BUSINESS);
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/autonomy/actions`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(jobId);
    expect(body).toContain('dana@example.com');
    expect(body).toContain('זו הייתה טעות');
  });
});

/**
 * `POST /autonomy/actions/:jobId/:stepId/mark` — the three route tests the
 * brief requires, plus the CSRF mutation (Step 5): removing the CSRF check
 * from this route must turn the second test below red.
 */
describe('POST /autonomy/actions/:jobId/:stepId/mark', () => {
  it('redirects to login without a session', async () => {
    const { jobId, stepId } = await seedAutonomousAction(BUSINESS);
    const baseUrl = await startServer(BUSINESS);

    const res = await fetch(`${baseUrl}/autonomy/actions/${jobId}/${stepId}/mark`, {
      method: 'POST',
      body: new URLSearchParams({ note: 'לא היה צריך לצאת' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');

    const { rows } = await getPool().query('SELECT * FROM autonomy_marks WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });

  it('refuses a mark without a valid CSRF token', async () => {
    const { jobId, stepId } = await seedAutonomousAction(BUSINESS);
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const res = await fetch(`${baseUrl}/autonomy/actions/${jobId}/${stepId}/mark`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ note: 'לא היה צריך לצאת' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);

    const { rows } = await getPool().query('SELECT * FROM autonomy_marks WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });

  it('records a mark with a valid token, and does not touch the step it marks', async () => {
    const { jobId, stepId } = await seedAutonomousAction(BUSINESS);
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const listRes = await fetch(`${baseUrl}/autonomy/actions`, { headers: { cookie } });
    const csrf = extractCsrf(await listRes.text());

    const res = await fetch(`${baseUrl}/autonomy/actions/${jobId}/${stepId}/mark`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, note: 'לא היה צריך לצאת בלי לבדוק את הסכום' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/autonomy/actions');

    const { rows } = await getPool().query<{
      job_id: string;
      step_id: string;
      action_class: string;
      note: string;
      marked_by: string;
    }>('SELECT job_id, step_id, action_class, note, marked_by FROM autonomy_marks WHERE business_id = $1', [
      BUSINESS,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      job_id: jobId,
      step_id: stepId,
      action_class: 'email.reply',
      note: 'לא היה צריך לצאת בלי לבדוק את הסכום',
      marked_by: USERNAME,
    });

    // The mark does not undo or touch the step it describes (spec §8.4) —
    // the underlying completion row is untouched.
    const { rows: stepRows } = await getPool().query(
      'SELECT status, external_id FROM job_step_results WHERE business_id = $1 AND job_id = $2',
      [BUSINESS, jobId],
    );
    expect(stepRows).toEqual([{ status: 'completed', external_id: 'MSG-1' }]);
  });

  it('refuses to mark a job/step pair that is not in the autonomous list', async () => {
    const baseUrl = await startServer(BUSINESS);
    const cookie = await loginWithPassword(baseUrl, USERNAME, PASSWORD);

    const listRes = await fetch(`${baseUrl}/autonomy/actions`, { headers: { cookie } });
    const csrf = extractCsrf(await listRes.text());

    const res = await fetch(`${baseUrl}/autonomy/actions/J-nonexistent/s1/mark`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ csrf, note: 'טעות' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(400);

    const { rows } = await getPool().query('SELECT * FROM autonomy_marks WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });
});
