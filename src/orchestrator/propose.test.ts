import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { compileCharter } from '../charter/compile.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { createJob } from '../orchestrator/jobs.js';
import type { TrustLevel } from '../domain/trust.js';
import type { Proposal } from '../domain/proposal.js';
import { insertOrGetDocument } from '../documents/store.js';
import { saveReading } from '../documents/reading-store.js';
import type { ProposeOutcome, ProposeRequest } from '../sdk/proposer.js';
import { proposeForReading } from './propose.js';

const BUSINESS = 'test-business';
const bundle = compileCharter(buildCharter());
const SOURCE = { ordinal: 0, locator: null };

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

const NO_ACTION_PROPOSAL: Proposal = {
  stance: 'no_action',
  headline: 'קראתי ואין מה לעשות',
  reasons: [{ text: 'אין דרישה במסמך', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: null,
  clarifyingQuestion: null,
};

/** A stub `options.proposer` that counts its calls and returns a fixed outcome. */
function stubProposer(outcome: ProposeOutcome) {
  const calls: ProposeRequest[] = [];
  const proposer = async (request: ProposeRequest): Promise<ProposeOutcome> => {
    calls.push(request);
    return outcome;
  };
  return { proposer, calls };
}

/** A document with a stored reading under a given provenance. Returns both ids. */
async function aReadingFor(
  provenance: TrustLevel,
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
        summary: 'הצעת מחיר מספק.',
        findings: [{ label: 'תנאי תשלום', value: '30 יום', sourceRef: SOURCE }],
        intents: [{ intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' }],
        unreadable: [],
      },
      provenance,
      model: 'haiku',
      promptVersion: 'v1',
      briefHash: ulid().padEnd(64, '0'),
    },
    { businessId: BUSINESS },
  );
  return { documentId, readingId: record.readingId };
}

async function aJob(provenance: TrustLevel, title: string) {
  return createJob({
    charterVersion: bundle.charterVersion,
    provenance,
    businessId: BUSINESS,
    title,
  });
}

beforeEach(async () => {
  await resetDatabase();
  await installCharter(buildCharter(), { businessId: BUSINESS });
});
afterAll(async () => {
  await closePool();
});

describe('proposeForReading', () => {
  it('turns a reading into a stored proposal and a compiled plan', async () => {
    const { documentId } = await aReadingFor('unknown_external');
    const job = await aJob('unknown_external', 'טיפול בהצעת מחיר');
    const { proposer } = stubProposer({ status: 'proposed', proposal: ACTING_PROPOSAL, raw: '{}' });

    const result = await proposeForReading(
      { documentId, jobId: job.jobId, bundle },
      { businessId: BUSINESS, proposer },
    );

    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') throw new Error('expected proposed');
    expect(result.proposal.stance).toBe('act');
    expect(result.record.status).toBe('proposed');
    expect(result.record.content?.headline).toBe('אשיב לדנה');
    expect(result.plan).not.toBeNull();
    expect(result.plan?.steps).toHaveLength(1);
    expect(result.plan?.steps[0]?.toolName).toBe('mail.send');
    expect(result.plan?.goal).toBe('אשיב לדנה');
  });

  it('stores a no_action proposal and compiles no plan', async () => {
    const { documentId } = await aReadingFor('unknown_external');
    const job = await aJob('unknown_external', 'משימה בלי פעולה');
    const { proposer } = stubProposer({ status: 'proposed', proposal: NO_ACTION_PROPOSAL, raw: '{}' });

    const result = await proposeForReading(
      { documentId, jobId: job.jobId, bundle },
      { businessId: BUSINESS, proposer },
    );

    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') throw new Error('expected proposed');
    expect(result.record.content?.stance).toBe('no_action');
    expect(result.plan).toBeNull();
  });

  it('stores an unproposable response instead of throwing', async () => {
    const { documentId } = await aReadingFor('unknown_external');
    const job = await aJob('unknown_external', 'תשובה שלא ניתן לפרש');
    const { proposer } = stubProposer({
      status: 'unproposable',
      reason: 'no JSON object in the response',
      raw: 'איזה בלגן',
    });

    const result = await proposeForReading(
      { documentId, jobId: job.jobId, bundle },
      { businessId: BUSINESS, proposer },
    );

    expect(result.status).toBe('unproposable');
    if (result.status !== 'unproposable') throw new Error('expected unproposable');
    expect(result.reason).toBe('no JSON object in the response');
    expect(result.record.status).toBe('unproposable');
    expect(result.record.content).toBeNull();
  });

  it('returns no_reading and calls the proposer zero times when there is no reading', async () => {
    const job = await aJob('unknown_external', 'משימה בלי קריאה');
    const { proposer, calls } = stubProposer({ status: 'proposed', proposal: ACTING_PROPOSAL, raw: '{}' });

    const result = await proposeForReading(
      { documentId: `DOC-${ulid()}`, jobId: job.jobId, bundle },
      { businessId: BUSINESS, proposer },
    );

    expect(result.status).toBe('no_reading');
    expect(calls).toHaveLength(0);
  });

  it("uses the job's own provenance, not one the caller supplied", async () => {
    // The reading is stored under `boss`; the job is stamped `unknown_external`.
    // `loadLatestReading` only matches within one provenance (migration 014),
    // so a lookup keyed on the job's own value must find nothing here.
    const { documentId } = await aReadingFor('boss');
    const job = await aJob('unknown_external', 'מסמך שהגיע מבחוץ');
    const { proposer, calls } = stubProposer({ status: 'proposed', proposal: ACTING_PROPOSAL, raw: '{}' });

    const result = await proposeForReading(
      { documentId, jobId: job.jobId, bundle },
      { businessId: BUSINESS, proposer },
    );

    expect(result.status).toBe('no_reading');
    expect(calls).toHaveLength(0);
  });

  it('rejects a job id that does not resolve, rather than treating it as no_reading', async () => {
    const { documentId } = await aReadingFor('unknown_external');
    const { proposer } = stubProposer({ status: 'proposed', proposal: ACTING_PROPOSAL, raw: '{}' });

    await expect(
      proposeForReading(
        { documentId, jobId: `J-${ulid()}`, bundle },
        { businessId: BUSINESS, proposer },
      ),
    ).rejects.toThrow();
  });

  it('passes the request through to the proposer with the job\'s provenance and no ramp yet', async () => {
    const { documentId } = await aReadingFor('boss');
    const job = await aJob('boss', 'הצעה לבוס');
    const { proposer, calls } = stubProposer({ status: 'proposed', proposal: ACTING_PROPOSAL, raw: '{}' });

    await proposeForReading({ documentId, jobId: job.jobId, bundle }, { businessId: BUSINESS, proposer });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provenance).toBe('boss');
    expect(calls[0]?.rampLevel).toBe('draft_only');
    expect(calls[0]?.reading.summary).toBe('הצעת מחיר מספק.');
  });

  it('actually persists the proposal row (real database, not the stub)', async () => {
    const { documentId } = await aReadingFor('unknown_external');
    const job = await aJob('unknown_external', 'בדיקת התמדה');
    const { proposer } = stubProposer({ status: 'proposed', proposal: ACTING_PROPOSAL, raw: '{}' });

    const result = await proposeForReading(
      { documentId, jobId: job.jobId, bundle },
      { businessId: BUSINESS, proposer },
    );
    if (result.status !== 'proposed') throw new Error('expected proposed');

    const { rows } = await getPool().query<{ proposal_id: string }>(
      'SELECT proposal_id FROM proposals WHERE proposal_id = $1',
      [result.record.proposalId],
    );
    expect(rows).toHaveLength(1);
  });
});
