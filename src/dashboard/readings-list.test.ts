import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob } from '../orchestrator/jobs.js';
import { recentReadings } from './readings-list.js';

const BUSINESS = 'biz-readings';
const OTHER_BUSINESS = 'biz-readings-other';

/**
 * `sha256` is derived from the document id rather than being a fixed
 * constant: `documents_business_sha_idx` is unique on `(business_id, sha256)`,
 * so a shared literal meant one seeded document per business per test and any
 * test needing two collided on insert.
 */
async function seedDocument(businessId: string, documentId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO documents
       (document_id, business_id, source, original_name, media_type, byte_size,
        sha256, stored_path, status)
     VALUES ($1, $2, 'manual', 'חוזה.txt', 'text/plain', 10,
             rpad(md5($1), 64, '0'), 'p/1.txt', 'extracted')`,
    [documentId, businessId],
  );
}

/** A `read` reading, with its content — the ordinary, successful case. */
async function seedReading(businessId: string, documentId: string, readingId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO document_readings
       (reading_id, business_id, document_id, status, reason, content,
        provenance, model, prompt_version, brief_hash)
     VALUES ($1, $2, $3, 'read', NULL, $4::jsonb,
             'unknown_external', 'test', 'v1', 'h')`,
    [readingId, businessId, documentId, JSON.stringify({ summary: 'סיכום', findings: [], intents: [] })],
  );
}

/**
 * An `unreadable` reading — `content` is NULL, `reason` carries the failure.
 * `document_readings_content_present` (migration 013) is what forces this
 * shape: `content IS NULL` if and only if `status = 'unreadable'`.
 */
async function seedUnreadableReading(
  businessId: string,
  documentId: string,
  readingId: string,
  reason: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO document_readings
       (reading_id, business_id, document_id, status, reason, content,
        provenance, model, prompt_version, brief_hash)
     VALUES ($1, $2, $3, 'unreadable', $4, NULL,
             'unknown_external', 'test', 'v1', 'h')`,
    [readingId, businessId, documentId, reason],
  );
}

async function seedProposal(params: {
  proposalId: string;
  businessId: string;
  readingId: string;
  jobId?: string | null;
  headline: string;
  stance: string;
  /** Overrides `created_at`, so a test can force a tiebreak or an ordering. */
  createdAt?: string;
  /** The proposal's `action`. `null` (the default) is a stance with nothing to approve. */
  action?: unknown;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO proposals
       (proposal_id, business_id, reading_id, job_id, status, reason, content, raw,
        model, prompt_version, created_at)
     VALUES ($1, $2, $3, $4, 'proposed', NULL, $5::jsonb, '', 'test', 'v1',
             COALESCE($6::timestamptz, now()))`,
    [
      params.proposalId,
      params.businessId,
      params.readingId,
      params.jobId ?? null,
      JSON.stringify({
        headline: params.headline,
        stance: params.stance,
        reasons: [{ text: 'המחיר השתנה', findingLabel: 'מחיר' }],
        action: params.action ?? null,
      }),
      params.createdAt ?? null,
    ],
  );
}

/**
 * A minimal `approval_requests` row. Only `approval_id` and `job_id` matter
 * to `recentReadings` — the rest exist only to satisfy this table's `NOT
 * NULL` columns, which carry no shape constraint on `risk` or
 * `proposed_input` beyond that.
 */
async function seedApproval(params: {
  approvalId: string;
  businessId: string;
  jobId: string;
  createdAt?: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO approval_requests
       (approval_id, business_id, job_id, action_class, summary, detail,
        risk, proposed_tool, proposed_input, input_hash, expires_at, created_at)
     VALUES ($1, $2, $3, 'email.initiate', 'בדיקה', 'בדיקה',
             '{}'::jsonb, 'mail.send', '{}'::jsonb, 'hash',
             now() + interval '1 day', COALESCE($4::timestamptz, now()))`,
    [params.approvalId, params.businessId, params.jobId, params.createdAt ?? null],
  );
}

/** The full chain: a document, a `read` reading, and a proposal for it. */
async function seed(businessId: string, documentId: string, stance: string): Promise<void> {
  await seedDocument(businessId, documentId);
  await seedReading(businessId, documentId, `RD-${documentId}`);
  await seedProposal({
    proposalId: `PR-${documentId}`,
    businessId,
    readingId: `RD-${documentId}`,
    headline: 'אני נגד חתימה',
    stance,
  });
}

describe('recentReadings', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('returns the reading with its proposal stance and reasons', async () => {
    await seed(BUSINESS, 'DOC-1', 'advise_against');
    const rows = await recentReadings(10, { businessId: BUSINESS });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stance).toBe('advise_against');
    expect(rows[0]?.headline).toBe('אני נגד חתימה');
    expect(rows[0]?.reasons).toEqual(['המחיר השתנה']);
  });

  // M2: `approvalId === null` alone cannot tell "the stance proposed nothing"
  // apart from "something was proposed and no card came of it" — and the
  // screen rendered the first sentence for both.
  it('reports whether the proposal carried an action, separately from whether a card exists', async () => {
    await seedDocument(BUSINESS, 'DOC-NOACT');
    await seedReading(BUSINESS, 'DOC-NOACT', 'RD-DOC-NOACT');
    await seedProposal({
      proposalId: 'PR-DOC-NOACT',
      businessId: BUSINESS,
      readingId: 'RD-DOC-NOACT',
      headline: 'אני נגד חתימה',
      stance: 'advise_against',
    });

    await seedDocument(BUSINESS, 'DOC-ACT');
    await seedReading(BUSINESS, 'DOC-ACT', 'RD-DOC-ACT');
    await seedProposal({
      proposalId: 'PR-DOC-ACT',
      businessId: BUSINESS,
      readingId: 'RD-DOC-ACT',
      headline: 'אשלח מייל אישור',
      stance: 'act',
      action: {
        headline: 'אשלח מייל לדנה',
        purpose: 'לאשר קבלה',
        intent: 'reply_to_sender',
        agent: 'comms.email',
        toolName: 'mail.send',
        input: { to: 'dana@example.com' },
        expectedActionClass: 'email.initiate',
      },
    });

    const rows = await recentReadings(10, { businessId: BUSINESS });
    const byDocument = new Map(rows.map((r) => [r.documentId, r]));

    // Neither has a card — no job, so no approval. What separates them is
    // whether anything was proposed at all.
    expect(byDocument.get('DOC-NOACT')?.approvalId).toBeNull();
    expect(byDocument.get('DOC-NOACT')?.hasAction).toBe(false);
    expect(byDocument.get('DOC-ACT')?.approvalId).toBeNull();
    expect(byDocument.get('DOC-ACT')?.hasAction).toBe(true);
  });

  it('never returns another business\'s reading', async () => {
    await seed(BUSINESS, 'DOC-1', 'advise_against');
    expect(await recentReadings(10, { businessId: 'other' })).toEqual([]);
  });

  // C1: `document_readings.content` is NULL exactly when `status =
  // 'unreadable'` (migration 013's `document_readings_content_present`), and
  // `read.ts` genuinely writes rows like this on every failed read. A screen
  // titled "what I read" that 500s — or silently drops the row — the moment
  // one exists is answering neither its title's question nor CLAUDE.md's rule
  // that an unreadable result is stored, not discarded.
  it('renders an unreadable reading using its stored reason, not the summary it does not have', async () => {
    await seedDocument(BUSINESS, 'DOC-2');
    await seedUnreadableReading(BUSINESS, 'DOC-2', 'RD-DOC-2', 'הקובץ פגום ולא ניתן לפתיחה');

    const rows = await recentReadings(10, { businessId: BUSINESS });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toContain('הקובץ פגום ולא ניתן לפתיחה');
    expect(rows[0]?.stance).toBeNull();
    expect(rows[0]?.headline).toBeNull();
    expect(rows[0]?.reasons).toEqual([]);
  });

  // I2: the approval-link path — the reason this screen exists — was never
  // exercised by a real reading -> proposal -> job -> approval chain.
  it('carries the approval id through a full reading -> proposal -> job -> approval chain', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const job = await createJob({ charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS });

    await seedDocument(BUSINESS, 'DOC-3');
    await seedReading(BUSINESS, 'DOC-3', 'RD-DOC-3');
    await seedProposal({
      proposalId: 'PR-DOC-3',
      businessId: BUSINESS,
      readingId: 'RD-DOC-3',
      jobId: job.jobId,
      headline: 'אשלח מייל אישור',
      stance: 'act',
    });
    await seedApproval({ approvalId: 'AP-DOC-3', businessId: BUSINESS, jobId: job.jobId });

    const rows = await recentReadings(10, { businessId: BUSINESS });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.approvalId).toBe('AP-DOC-3');
  });

  // I1's tiebreaker, exercised directly: two approvals for the same job
  // sharing a `created_at` (clock resolution) must not leave Postgres free to
  // pick either — `a.approval_id DESC` breaks the tie deterministically, the
  // same way `documentForApproval` already breaks its own proposal tie.
  it('breaks a same-timestamp approval tie deterministically, by approval id', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const job = await createJob({ charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS });

    await seedDocument(BUSINESS, 'DOC-TIE');
    await seedReading(BUSINESS, 'DOC-TIE', 'RD-DOC-TIE');
    await seedProposal({
      proposalId: 'PR-DOC-TIE',
      businessId: BUSINESS,
      readingId: 'RD-DOC-TIE',
      jobId: job.jobId,
      headline: 'הצעה',
      stance: 'act',
    });
    const tiedAt = new Date().toISOString();
    await seedApproval({ approvalId: 'AP-A', businessId: BUSINESS, jobId: job.jobId, createdAt: tiedAt });
    await seedApproval({ approvalId: 'AP-B', businessId: BUSINESS, jobId: job.jobId, createdAt: tiedAt });

    const rows = await recentReadings(10, { businessId: BUSINESS });
    // 'AP-B' > 'AP-A' lexicographically, so `ORDER BY ... a.approval_id DESC`
    // must pick it — and must pick the SAME one on every run.
    expect(rows[0]?.approvalId).toBe('AP-B');
  });

  // Minor: the cross-business test above proves only the entry-point
  // `WHERE r.business_id = $1` — it says nothing about whether the LATERAL
  // joins scope themselves. A foreign-business proposal pointing at a
  // *visible* reading, timestamped later than the real one, would win
  // `ORDER BY created_at DESC` if the lateral's own
  // `pr.business_id = r.business_id` clause were ever dropped.
  it("is not fooled by a foreign business's later proposal on the same reading", async () => {
    await seed(BUSINESS, 'DOC-4', 'advise_against');
    await seedProposal({
      proposalId: 'PR-FOREIGN',
      businessId: OTHER_BUSINESS,
      readingId: 'RD-DOC-4',
      headline: 'הצעה זרה',
      stance: 'act',
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const rows = await recentReadings(10, { businessId: BUSINESS });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.headline).toBe('אני נגד חתימה');
    expect(rows[0]?.stance).toBe('advise_against');
  });

  // Same concern, for the approval lateral's own `a.business_id = r.business_id`.
  it("is not fooled by a foreign business's later approval on the same job", async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const job = await createJob({ charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS });

    await seedDocument(BUSINESS, 'DOC-5');
    await seedReading(BUSINESS, 'DOC-5', 'RD-DOC-5');
    await seedProposal({
      proposalId: 'PR-DOC-5',
      businessId: BUSINESS,
      readingId: 'RD-DOC-5',
      jobId: job.jobId,
      headline: 'אשלח מייל אישור',
      stance: 'act',
    });
    await seedApproval({ approvalId: 'AP-REAL', businessId: BUSINESS, jobId: job.jobId });
    // A different business's approval, naming the same job id — nothing at
    // the database level stops this (`approval_requests.job_id` carries no
    // foreign key at all, let alone a business-scoped one) — timestamped
    // later than the real approval.
    await seedApproval({
      approvalId: 'AP-FOREIGN',
      businessId: OTHER_BUSINESS,
      jobId: job.jobId,
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const rows = await recentReadings(10, { businessId: BUSINESS });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.approvalId).toBe('AP-REAL');
  });
});
