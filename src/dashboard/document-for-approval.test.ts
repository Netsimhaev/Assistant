import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { assessRisk } from '../policy/risk.js';
import { canonicalHash } from '../util/canonical.js';
import { createJob } from '../orchestrator/jobs.js';
import { enqueueApproval } from '../governance/approvals.js';
import { insertOrGetDocument } from '../documents/store.js';
import { saveReading } from '../documents/reading-store.js';
import { saveProposal, type ProposalRecord } from '../orchestrator/proposal-store.js';
import { documentForApproval } from './document-for-approval.js';

import type { ActionFacts, PolicyBundle } from '../domain/policy.js';
import type { Proposal } from '../domain/proposal.js';

const BUSINESS = 'test-business';
const OTHER_BUSINESS = 'other-business';
const SOURCE = { ordinal: 0, locator: null };
const MAIL_INPUT = { to: 'dana@example.com', body: 'שלום' };

const ACTING_PROPOSAL: Proposal = {
  stance: 'act',
  headline: 'אשיב לדנה',
  reasons: [{ text: 'התנאים הורעו', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: {
    headline: 'אשלח מייל לדנה',
    purpose: 'כדי לאשר את התנאים',
    intent: 'reply_to_sender',
    agent: 'comms.email',
    toolName: 'mail.send',
    input: { to: 'dana@example.com', inReplyTo: 'msg-1' },
    expectedActionClass: 'email.reply',
  },
  clarifyingQuestion: null,
};

async function install(businessId: string): Promise<PolicyBundle> {
  return installCharter(buildCharter(), { businessId });
}

/** Real `ActionFacts`, matching the shape `governance/consume.test.ts` builds. */
function factsFor(input: unknown): ActionFacts {
  return {
    toolName: 'mail.send',
    actionClass: 'email.initiate',
    provenance: 'boss',
    chainDepth: 0,
    provenanceChainDerived: false,
    inputHash: canonicalHash(input),
    amountMinor: 0,
    amountDeclared: false,
    counterpartyId: null,
    counterpartyEmails: ['dana@example.com'],
    counterpartyPhones: [],
    counterpartyTags: [],
    dataClasses: [],
    leavesInstance: true,
    supplierId: null,
    discountPercent: 0,
  };
}

async function riskFor(input: unknown, bundle: PolicyBundle) {
  return assessRisk(factsFor(input), bundle);
}

/** A document with a stored reading, both real rows, both under the same business. */
async function aDocumentAndReading(
  businessId: string,
): Promise<{ documentId: string; readingId: string }> {
  return aReadingAcross(businessId, businessId);
}

/**
 * A document and a reading of it, filed under two possibly-different
 * businesses. Neither `document_readings.document_id` nor
 * `proposals.reading_id` is scoped by `(business_id, ...)` in its foreign
 * key — only by the bare id (see `documents/store.ts`'s note on
 * `document_artifacts.document_id` for the same shape) — so nothing in the
 * schema itself stops a reading from naming a document that belongs to a
 * different business. That gap is exactly what lets these fixtures isolate
 * one join predicate at a time below.
 */
async function aReadingAcross(
  documentBusinessId: string,
  readingBusinessId: string,
): Promise<{ documentId: string; readingId: string }> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument(
    {
      documentId,
      source: 'manual',
      originalName: 'הצעת-מחיר.txt',
      mediaType: 'text/plain',
      sha256: ulid().padEnd(64, '0'),
      byteSize: 20,
      storedPath: `${documentBusinessId}/${documentId}/original.txt`,
    },
    { businessId: documentBusinessId },
  );
  const { record } = await saveReading(
    {
      readingId: `RDG-${ulid()}`,
      documentId,
      status: 'read',
      reason: null,
      content: {
        summary: 'הצעת מחיר מספק.',
        findings: [{ label: 'תנאי תשלום', value: '30 יום', sourceRef: SOURCE }],
        intents: [
          { intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' },
        ],
        unreadable: [],
      },
      provenance: 'boss',
      model: 'haiku',
      promptVersion: 'v1',
      briefHash: ulid().padEnd(64, '0'),
    },
    { businessId: readingBusinessId },
  );
  return { documentId, readingId: record.readingId };
}

async function aJob(businessId: string, bundle: PolicyBundle, title: string) {
  return createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId,
    title,
  });
}

async function aProposal(
  businessId: string,
  readingId: string,
  jobId: string,
): Promise<ProposalRecord> {
  return saveProposal(
    {
      proposalId: `PR-${ulid()}`,
      readingId,
      jobId,
      status: 'proposed',
      reason: null,
      content: ACTING_PROPOSAL,
      raw: '{}',
      model: 'haiku',
      promptVersion: 'v1',
    },
    { businessId },
  );
}

async function anApproval(
  businessId: string,
  jobId: string | null,
  bundle: PolicyBundle,
  input: unknown = MAIL_INPUT,
): Promise<string> {
  return enqueueApproval(
    {
      jobId,
      facts: factsFor(input),
      risk: await riskFor(input, bundle),
      proposedInput: input,
      summary: 'שליחת מייל',
    },
    { businessId },
  );
}

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('documentForApproval', () => {
  it('returns the document behind the proposal made for the approval\'s job', async () => {
    const bundle = await install(BUSINESS);
    const { documentId, readingId } = await aDocumentAndReading(BUSINESS);
    const job = await aJob(BUSINESS, bundle, 'טיפול בהצעת מחיר');
    await aProposal(BUSINESS, readingId, job.jobId);
    const approvalId = await anApproval(BUSINESS, job.jobId, bundle);

    const result = await documentForApproval(approvalId, { businessId: BUSINESS });

    expect(result).not.toBeNull();
    expect(result?.document.documentId).toBe(documentId);
    // I4: the proposal's own intent travels with the document, because that
    // is what decides whether the card may carry a sign form at all.
    expect(result?.intent).toBe('reply_to_sender');
  });

  it('reports a null intent when the proposal carries no action', async () => {
    const bundle = await install(BUSINESS);
    const { readingId } = await aDocumentAndReading(BUSINESS);
    const job = await aJob(BUSINESS, bundle, 'הצעה בלי פעולה');
    await saveProposal(
      {
        proposalId: `PR-${ulid()}`,
        readingId,
        jobId: job.jobId,
        status: 'proposed',
        reason: null,
        content: { ...ACTING_PROPOSAL, stance: 'advise_against', action: null },
        raw: '{}',
        model: 'haiku',
        promptVersion: 'v1',
      },
      { businessId: BUSINESS },
    );
    const approvalId = await anApproval(BUSINESS, job.jobId, bundle);

    const result = await documentForApproval(approvalId, { businessId: BUSINESS });

    // The document still resolves — the card should still say what it is
    // about — but there is no intent, so nothing may be signed.
    expect(result?.document).not.toBeUndefined();
    expect(result?.intent).toBeNull();
  });

  it('reports a null intent when the stored intent is not a member of the enum', async () => {
    // The value comes out of JSONB written from a model's answer. A name the
    // closed enum does not know must arrive as `null` — the reading that
    // means "no sign form" — never as a string that survives to be compared
    // against an allowlist somewhere further downstream.
    const bundle = await install(BUSINESS);
    const { readingId } = await aDocumentAndReading(BUSINESS);
    const job = await aJob(BUSINESS, bundle, 'כוונה שאינה בסכמה');
    const proposal = await aProposal(BUSINESS, readingId, job.jobId);
    await getPool().query(
      `UPDATE proposals
          SET content = jsonb_set(content, '{action,intent}', '"sign_everything"')
        WHERE proposal_id = $1`,
      [proposal.proposalId],
    );
    const approvalId = await anApproval(BUSINESS, job.jobId, bundle);

    const result = await documentForApproval(approvalId, { businessId: BUSINESS });

    expect(result?.document).not.toBeUndefined();
    expect(result?.intent).toBeNull();
  });

  it('returns null when the job has no proposal', async () => {
    const bundle = await install(BUSINESS);
    const job = await aJob(BUSINESS, bundle, 'משימה בלי הצעה');
    const approvalId = await anApproval(BUSINESS, job.jobId, bundle);

    const result = await documentForApproval(approvalId, { businessId: BUSINESS });

    expect(result).toBeNull();
  });

  it('returns null when the approval has no job at all', async () => {
    const bundle = await install(BUSINESS);
    const approvalId = await anApproval(BUSINESS, null, bundle);

    const result = await documentForApproval(approvalId, { businessId: BUSINESS });

    expect(result).toBeNull();
  });

  it('does not leak a document across the business boundary', async () => {
    // Proposal, reading and document all live under BUSINESS while the
    // approval lives under OTHER_BUSINESS, so every one of `p`, `r` and `d`'s
    // scoping predicates disagrees with `a.business_id` here at once. That
    // makes this a coarse end-to-end boundary check, not proof that each
    // predicate individually holds — the three dedicated tests below isolate
    // `p`, `r` and `d` one at a time for that.
    const bundle = await install(BUSINESS);
    const otherBundle = await install(OTHER_BUSINESS);
    const { readingId } = await aDocumentAndReading(BUSINESS);
    const job = await aJob(BUSINESS, bundle, 'שייך לעסק אחר');
    await aProposal(BUSINESS, readingId, job.jobId);

    // An approval filed under a different business that happens to name the
    // same job id (approval_requests.job_id carries no foreign key, so
    // nothing in the schema itself prevents this).
    const approvalId = await anApproval(OTHER_BUSINESS, job.jobId, otherBundle);

    const result = await documentForApproval(approvalId, { businessId: OTHER_BUSINESS });

    expect(result).toBeNull();
  });

  it('does not leak a document reached through a proposal filed under another business', async () => {
    const bundle = await install(BUSINESS);
    // The approval, the reading and the document all live under BUSINESS —
    // so both `r.business_id = a.business_id` and `d.business_id =
    // a.business_id` already hold. Only the proposal disagrees: it is filed
    // under OTHER_BUSINESS even though it points at BUSINESS's own reading
    // (proposals.reading_id has no business-scoped foreign key either — see
    // `aReadingAcross`'s note). Only `p.business_id = a.business_id` can
    // exclude it.
    const { readingId } = await aDocumentAndReading(BUSINESS);
    const job = await aJob(BUSINESS, bundle, 'הצעה של עסק אחר');
    await aProposal(OTHER_BUSINESS, readingId, job.jobId);
    const approvalId = await anApproval(BUSINESS, job.jobId, bundle);

    const result = await documentForApproval(approvalId, { businessId: BUSINESS });

    expect(result).toBeNull();
  });

  it('returns the most recent proposal\'s document when a job has two', async () => {
    const bundle = await install(BUSINESS);
    const job = await aJob(BUSINESS, bundle, 'שתי הצעות');
    const older = await aDocumentAndReading(BUSINESS);
    const newer = await aDocumentAndReading(BUSINESS);

    const olderProposal = await aProposal(BUSINESS, older.readingId, job.jobId);
    // Backdate it so ordering does not depend on wall-clock resolution
    // between two inserts issued microseconds apart.
    await getPool().query(
      `UPDATE proposals SET created_at = now() - interval '1 hour' WHERE proposal_id = $1`,
      [olderProposal.proposalId],
    );
    await aProposal(BUSINESS, newer.readingId, job.jobId);

    const approvalId = await anApproval(BUSINESS, job.jobId, bundle);

    const result = await documentForApproval(approvalId, { businessId: BUSINESS });

    expect(result?.document.documentId).toBe(newer.documentId);
    expect(result?.document.documentId).not.toBe(older.documentId);
  });

  it('breaks a created_at tie by proposal_id, deterministically (M4)', async () => {
    // Two proposals on one job that land on the exact same `created_at` —
    // the case `p.created_at DESC` alone cannot order, and the case M4's
    // signing flow needs resolved the same way twice (once for the card,
    // once for the POST). Without `p.proposal_id DESC` as a tiebreaker,
    // which of the two documents comes back is whatever order Postgres
    // happens to produce for tied sort keys — unspecified, not "the older
    // one" or "the newer one".
    const bundle = await install(BUSINESS);
    const job = await aJob(BUSINESS, bundle, 'תיקו בזמן היצירה');
    const a = await aDocumentAndReading(BUSINESS);
    const b = await aDocumentAndReading(BUSINESS);

    const proposalA = await aProposal(BUSINESS, a.readingId, job.jobId);
    const proposalB = await aProposal(BUSINESS, b.readingId, job.jobId);
    // Force an exact tie — one explicit, shared timestamp for both rows,
    // not "however close together the two inserts landed".
    await getPool().query(
      `UPDATE proposals SET created_at = now() WHERE proposal_id IN ($1, $2)`,
      [proposalA.proposalId, proposalB.proposalId],
    );

    // `proposal_id` is a ulid (`PR-${ulid()}`, monotonic on creation order),
    // so proposalB — created second — has the lexicographically higher id.
    // Assert that directly rather than assume it, so this test does not
    // silently start asserting the wrong thing if `aProposal`'s id scheme
    // ever changes.
    expect(proposalB.proposalId > proposalA.proposalId).toBe(true);

    const approvalId = await anApproval(BUSINESS, job.jobId, bundle);
    const result = await documentForApproval(approvalId, { businessId: BUSINESS });

    expect(result?.document.documentId).toBe(b.documentId);
    expect(result?.document.documentId).not.toBe(a.documentId);
  });

  it('does not leak a document whose reading belongs to another business', async () => {
    const bundle = await install(BUSINESS);
    // The approval and the proposal both live under BUSINESS — so
    // `p.business_id = a.business_id` already holds and cannot be the
    // predicate that excludes this row. Only the reading disagrees: it is
    // filed under OTHER_BUSINESS even though the document it reads is
    // BUSINESS's own. Only `r.business_id = a.business_id` can exclude it.
    const { readingId } = await aReadingAcross(BUSINESS, OTHER_BUSINESS);
    const job = await aJob(BUSINESS, bundle, 'קריאה של עסק אחר');
    await aProposal(BUSINESS, readingId, job.jobId);
    const approvalId = await anApproval(BUSINESS, job.jobId, bundle);

    const result = await documentForApproval(approvalId, { businessId: BUSINESS });

    expect(result).toBeNull();
  });

  it('does not leak a document that belongs to another business', async () => {
    const bundle = await install(BUSINESS);
    // The approval, the proposal and the reading all live under BUSINESS —
    // so both `p.business_id = a.business_id` and `r.business_id =
    // a.business_id` already hold. Only the document disagrees: it is
    // filed under OTHER_BUSINESS even though the reading that names it is
    // BUSINESS's own. Only `d.business_id = a.business_id` can exclude it.
    const { readingId } = await aReadingAcross(OTHER_BUSINESS, BUSINESS);
    const job = await aJob(BUSINESS, bundle, 'מסמך של עסק אחר');
    await aProposal(BUSINESS, readingId, job.jobId);
    const approvalId = await anApproval(BUSINESS, job.jobId, bundle);

    const result = await documentForApproval(approvalId, { businessId: BUSINESS });

    expect(result).toBeNull();
  });
});
