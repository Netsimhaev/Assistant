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

/** A document with a stored reading, both real rows. */
async function aDocumentAndReading(
  businessId: string,
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
      storedPath: `${businessId}/${documentId}/original.txt`,
    },
    { businessId },
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
    { businessId },
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
    expect(result?.documentId).toBe(documentId);
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

    expect(result?.documentId).toBe(newer.documentId);
    expect(result?.documentId).not.toBe(older.documentId);
  });
});
