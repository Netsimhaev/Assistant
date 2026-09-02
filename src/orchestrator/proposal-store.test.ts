import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { compileCharter } from '../charter/compile.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import type { Proposal } from '../domain/proposal.js';
import { insertOrGetDocument } from '../documents/store.js';
import { saveReading } from '../documents/reading-store.js';
import { createJob } from './jobs.js';
import { loadProposalsForReading, saveProposal, type NewProposal } from './proposal-store.js';

const BUSINESS = 'test-business';
const bundle = compileCharter(buildCharter());
const SOURCE = { ordinal: 0, locator: null };

const PROPOSAL: Proposal = {
  stance: 'act',
  headline: 'אשיב לדנה',
  reasons: [{ text: 'התנאים הורעו', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: null,
  clarifyingQuestion: null,
};

async function aReading(): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument({
    documentId, source: 'manual', originalName: 'x.txt', mediaType: 'text/plain',
    sha256: ulid().padEnd(64, '0'), byteSize: 10,
    storedPath: `${BUSINESS}/${documentId}/original.txt`,
  }, { businessId: BUSINESS });
  const { record } = await saveReading({
    readingId: `RDG-${ulid()}`, documentId, status: 'read', reason: null,
    content: { summary: 's', findings: [], intents: [{ intent: 'no_action', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' }], unreadable: [] },
    provenance: 'unknown_external', model: 'haiku', promptVersion: 'v1',
    briefHash: 'a'.repeat(64),
  }, { businessId: BUSINESS });
  return record.readingId;
}

async function aJob() {
  return createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'unknown_external',
    businessId: BUSINESS,
  });
}

// Every proposal needs a real job to satisfy the `job_id` foreign key, and
// most tests here don't care which one — they're exercising the reading
// relationship, not the job relationship. `DEFAULT_JOB_ID` is recreated fresh
// in `beforeEach` so tests stay isolated, and `newProposal` falls back to it
// unless a test overrides `jobId` itself (as the job-tracking test below does).
let DEFAULT_JOB_ID: string;

function newProposal(readingId: string, overrides: Partial<NewProposal> = {}): NewProposal {
  return {
    proposalId: `PRP-${ulid()}`, readingId, status: 'proposed', reason: null,
    content: PROPOSAL, raw: '{"stance": "act"}', model: 'sonnet', promptVersion: 'v1',
    jobId: DEFAULT_JOB_ID, ...overrides,
  };
}

beforeEach(async () => {
  await resetDatabase();
  await installCharter(buildCharter(), { businessId: BUSINESS });
  DEFAULT_JOB_ID = (await aJob()).jobId;
});
afterAll(async () => { await closePool(); });

describe('saveProposal', () => {
  it('stores a proposal and hands it back', async () => {
    const readingId = await aReading();
    const record = await saveProposal(newProposal(readingId), { businessId: BUSINESS });
    expect(record.status).toBe('proposed');
    expect(record.content?.headline).toBe('אשיב לדנה');
  });

  it('stores an unproposable outcome, because a failed attempt is a fact', async () => {
    const readingId = await aReading();
    const record = await saveProposal(
      newProposal(readingId, { status: 'unproposable', reason: 'no JSON object', content: null }),
      { businessId: BUSINESS },
    );
    expect(record.reason).toBe('no JSON object');
    expect(record.content).toBeNull();
  });

  it('stores a second proposal for the same reading rather than replacing the first', async () => {
    const readingId = await aReading();
    const first = await saveProposal(newProposal(readingId), { businessId: BUSINESS });
    const second = await saveProposal(newProposal(readingId), { businessId: BUSINESS });
    expect(second.proposalId).not.toBe(first.proposalId);
    const all = await loadProposalsForReading(readingId, { businessId: BUSINESS });
    expect(all).toHaveLength(2);
  });

  it('refuses a proposed row with no content', async () => {
    const readingId = await aReading();
    await expect(
      saveProposal(newProposal(readingId, { content: null }), { businessId: BUSINESS }),
    ).rejects.toThrow();
  });

  it('refuses an unproposable row that carries content', async () => {
    const readingId = await aReading();
    await expect(
      saveProposal(
        newProposal(readingId, { status: 'unproposable', reason: 'no JSON object', content: PROPOSAL }),
        { businessId: BUSINESS },
      ),
    ).rejects.toThrow();
  });

  it('does not cross the business boundary', async () => {
    const readingId = await aReading();
    await saveProposal(newProposal(readingId), { businessId: BUSINESS });
    expect(await loadProposalsForReading(readingId, { businessId: 'other' })).toEqual([]);
  });

  it('carries the raw model text back on a proposed row', async () => {
    const readingId = await aReading();
    const record = await saveProposal(
      newProposal(readingId, { raw: '{"stance": "act", "headline": "..."}' }),
      { businessId: BUSINESS },
    );
    expect(record.raw).toBe('{"stance": "act", "headline": "..."}');
  });

  it('carries the raw model text back on an unproposable row, for diagnosis', async () => {
    const readingId = await aReading();
    const record = await saveProposal(
      newProposal(readingId, {
        status: 'unproposable',
        reason: 'no JSON object',
        content: null,
        raw: 'זו לא תשובת JSON תקינה',
      }),
      { businessId: BUSINESS },
    );
    expect(record.raw).toBe('זו לא תשובת JSON תקינה');
  });

  it('records which job the proposal was made for', async () => {
    const readingId = await aReading();
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS,
    });
    const record = await saveProposal(
      newProposal(readingId, { jobId: job.jobId }), { businessId: BUSINESS },
    );
    expect(record.jobId).toBe(job.jobId);
    const all = await loadProposalsForReading(readingId, { businessId: BUSINESS });
    expect(all[0]?.jobId).toBe(job.jobId);
  });
});
