import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, withBusiness } from '../db/pool.js';
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
  return withBusiness(BUSINESS, (db) => createJob(db, {
    charterVersion: bundle.charterVersion,
    provenance: 'unknown_external',
  }));
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
  await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
  DEFAULT_JOB_ID = (await aJob()).jobId;
});
afterAll(async () => { await closePool(); });

describe('saveProposal', () => {
  it('stores a proposal and hands it back', async () => {
    const readingId = await aReading();
    const record = await withBusiness(BUSINESS, (db) => saveProposal(db, newProposal(readingId)));
    expect(record.status).toBe('proposed');
    expect(record.content?.headline).toBe('אשיב לדנה');
  });

  it('stores an unproposable outcome, because a failed attempt is a fact', async () => {
    const readingId = await aReading();
    const record = await withBusiness(BUSINESS, (db) => saveProposal(db, newProposal(readingId, { status: 'unproposable', reason: 'no JSON object', content: null })));
    expect(record.reason).toBe('no JSON object');
    expect(record.content).toBeNull();
  });

  it('stores a second proposal for the same reading rather than replacing the first', async () => {
    const readingId = await aReading();
    const first = await withBusiness(BUSINESS, (db) => saveProposal(db, newProposal(readingId)));
    const second = await withBusiness(BUSINESS, (db) => saveProposal(db, newProposal(readingId)));
    expect(second.proposalId).not.toBe(first.proposalId);
    const all = await withBusiness(BUSINESS, (db) => loadProposalsForReading(db, readingId));
    expect(all).toHaveLength(2);
  });

  it('refuses a proposed row with no content', async () => {
    const readingId = await aReading();
    await expect(
      withBusiness(BUSINESS, (db) => saveProposal(db, newProposal(readingId, { content: null }))),
    ).rejects.toThrow();
  });

  it('refuses an unproposable row that carries content', async () => {
    const readingId = await aReading();
    await expect(
      withBusiness(BUSINESS, (db) => saveProposal(db, newProposal(readingId, { status: 'unproposable', reason: 'no JSON object', content: PROPOSAL }))),
    ).rejects.toThrow();
  });

  it('does not cross the business boundary', async () => {
    const readingId = await aReading();
    await withBusiness(BUSINESS, (db) => saveProposal(db, newProposal(readingId)));
    expect(await withBusiness('other', (db) => loadProposalsForReading(db, readingId))).toEqual([]);
  });

  it('carries the raw model text back on a proposed row', async () => {
    const readingId = await aReading();
    const record = await withBusiness(BUSINESS, (db) => saveProposal(db, newProposal(readingId, { raw: '{"stance": "act", "headline": "..."}' })));
    expect(record.raw).toBe('{"stance": "act", "headline": "..."}');
  });

  it('carries the raw model text back on an unproposable row, for diagnosis', async () => {
    const readingId = await aReading();
    const record = await withBusiness(BUSINESS, (db) => saveProposal(db, newProposal(readingId, {
        status: 'unproposable',
        reason: 'no JSON object',
        content: null,
        raw: 'זו לא תשובת JSON תקינה',
      })));
    expect(record.raw).toBe('זו לא תשובת JSON תקינה');
  });

  it('records which job the proposal was made for', async () => {
    const readingId = await aReading();
    const job = await withBusiness(BUSINESS, (db) => createJob(db, {
      charterVersion: bundle.charterVersion, provenance: 'boss', 
    }));
    const record = await withBusiness(BUSINESS, (db) => saveProposal(db, newProposal(readingId, { jobId: job.jobId })));
    expect(record.jobId).toBe(job.jobId);
    const all = await withBusiness(BUSINESS, (db) => loadProposalsForReading(db, readingId));
    expect(all[0]?.jobId).toBe(job.jobId);
  });
});
