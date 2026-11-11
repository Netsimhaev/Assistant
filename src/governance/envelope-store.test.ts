import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { AgentEnvelope } from '../domain/envelope.js';
import type { EnvelopeConstraints } from '../domain/envelope.js';
import {
  attachChildJob,
  countPairExchanges,
  delegationsToday,
  loadEnvelope,
  priorQuadruples,
  writeEnvelope,
} from './envelope-store.js';

const BUSINESS = 'test-business';

const CONSTRAINTS: EnvelopeConstraints = {
  charterVersion: 'v1',
  provenanceCeiling: 'staff',
  autonomyCeiling: 'approve_required',
  moneyCeilingMinor: 5000,
  deadlineAt: '2026-09-24T12:00:00.000Z',
};

/** A valid envelope, overridable field by field so each test states only what it cares about. */
function anEnvelope(overrides: Partial<AgentEnvelope> = {}): AgentEnvelope {
  const id = overrides.id ?? `ENV-${ulid()}`;
  return {
    v: 1,
    id,
    correlationId: 'JOB-root',
    causalChain: [id],
    from: 'comms.email',
    to: 'know.reader',
    kind: 'help_request',
    intent: 'summarise_document',
    payload: { note: 'hello' },
    contextRefs: [{ kind: 'document', documentId: 'doc-1' }],
    constraints: CONSTRAINTS,
    hops: 1,
    idempotencyKey: `IDEM-${ulid()}`,
    createdAt: '2026-09-23T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('writeEnvelope / loadEnvelope', () => {
  it('round-trips an envelope through the database unchanged', async () => {
    const envelope = anEnvelope();
    const written = await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, envelope, { parentJobId: 'JOB-root' }));
    expect(written.status).toBe('stored');

    const loaded = await withBusiness(BUSINESS, (bdb) => loadEnvelope(bdb, envelope.id));
    const parsed = AgentEnvelope.parse(loaded);
    expect(parsed).toEqual(envelope);
    expect(Array.isArray(parsed.causalChain)).toBe(true);
    expect(typeof parsed.constraints).toBe('object');
  });

  it('returns duplicate and stores nothing on a repeated idempotency key', async () => {
    const envelope = anEnvelope();
    const first = await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, envelope, { parentJobId: 'JOB-root' }));
    expect(first.status).toBe('stored');

    const second = await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, envelope, { parentJobId: 'JOB-root' }));
    expect(second.status).toBe('duplicate');

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_envelopes WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows[0]?.n).toBe('1');
  });
});

describe('priorQuadruples', () => {
  it('prior quadruples are scoped to one correlation', async () => {
    const shared: Partial<AgentEnvelope> = {
      from: 'comms.email',
      to: 'know.reader',
      intent: 'summarise_document',
      contextRefs: [{ kind: 'document', documentId: 'doc-1' }],
    };
    const inFirst = anEnvelope({ correlationId: 'JOB-a', ...shared });
    const inSecond = anEnvelope({ correlationId: 'JOB-b', ...shared });
    await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, inFirst, { parentJobId: 'JOB-a' }));
    await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, inSecond, { parentJobId: 'JOB-b' }));

    const quadruples = await withBusiness(BUSINESS, (bdb) => priorQuadruples(bdb, 'JOB-a'));
    expect(quadruples).toHaveLength(1);
    expect(quadruples[0]).toMatchObject({
      from: 'comms.email',
      to: 'know.reader',
      intent: 'summarise_document',
    });
  });

  /**
   * Fix round 2, item 4. `resumeDelegatedJobs` (Task 7) writes a `result`
   * envelope answering a request in the OPPOSITE direction — same
   * correlation, `from`/`to` swapped. Without `kind = 'help_request'` here,
   * that answer counts as a fresh request from the child back to the
   * parent, and a genuine reverse request would land on guard 4
   * (`no_new_information`) as though it had already been asked.
   */
  it('excludes a result envelope even though it shares the correlation and would otherwise match', async () => {
    const correlationId = 'JOB-root';
    const request = anEnvelope({
      correlationId,
      from: 'comms.email',
      to: 'know.reader',
      intent: 'summarise_document',
    });
    await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, request, { parentJobId: correlationId }));
    const answer = anEnvelope({
      correlationId,
      kind: 'result',
      from: 'know.reader',
      to: 'comms.email',
      intent: 'summarise_document',
    });
    await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, answer, { parentJobId: correlationId }));

    const quadruples = await withBusiness(BUSINESS, (bdb) => priorQuadruples(bdb, correlationId));
    expect(quadruples).toHaveLength(1);
    expect(quadruples[0]).toMatchObject({ from: 'comms.email', to: 'know.reader' });
  });
});

describe('countPairExchanges', () => {
  it('counts exchanges for one pair on one intent only', async () => {
    const correlationId = 'JOB-root';
    const first = anEnvelope({ correlationId, from: 'comms.email', to: 'know.reader', intent: 'summarise_document' });
    const second = anEnvelope({ correlationId, from: 'comms.email', to: 'know.reader', intent: 'summarise_document' });
    const otherIntent = anEnvelope({ correlationId, from: 'comms.email', to: 'know.reader', intent: 'draft_reply' });
    // Same pair, same intent, but a DIFFERENT correlation — must not be
    // counted alongside `correlationId`'s exchanges. Without this the test
    // cannot distinguish a correlation-scoped query from an unscoped one.
    const otherCorrelation = anEnvelope({
      correlationId: 'JOB-unrelated',
      from: 'comms.email',
      to: 'know.reader',
      intent: 'summarise_document',
    });
    await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, first, { parentJobId: correlationId }));
    await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, second, { parentJobId: correlationId }));
    await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, otherIntent, { parentJobId: correlationId }));
    await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, otherCorrelation, { parentJobId: 'JOB-unrelated' }));

    const count = await withBusiness(BUSINESS, (bdb) => countPairExchanges(
      bdb,
      correlationId,
      'comms.email',
      'know.reader',
      'summarise_document'
    ));
    expect(count).toBe(2);
  });

  /**
   * Same defect as `priorQuadruples`'s own test above, guard 5's side: a
   * `result` envelope answering A→B must not count toward how many times B
   * has asked A back, or a genuine reverse exchange hits the oscillation
   * guard sooner than it earned.
   */
  it('excludes a result envelope from the reverse-direction count', async () => {
    const correlationId = 'JOB-root';
    const answer = anEnvelope({
      correlationId,
      kind: 'result',
      from: 'know.reader',
      to: 'comms.email',
      intent: 'summarise_document',
    });
    await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, answer, { parentJobId: correlationId }));

    const count = await withBusiness(BUSINESS, (bdb) => countPairExchanges(
      bdb,
      correlationId,
      'know.reader',
      'comms.email',
      'summarise_document'
    ));
    expect(count).toBe(0);
  });
});

describe('delegationsToday', () => {
  it('delegationsToday counts audit rows and not envelope rows', async () => {
    // No `AuditKind` member for `'delegation'` exists yet (a later task adds
    // one) — inserted directly so this test is not blocked on that task.
    await testDb().query(
      `INSERT INTO audit_log (
         business_id, actor, kind, charter_version, provenance, input_hash, reason, prev_hash, hash
       ) VALUES ($1, 'orchestrator', 'delegation', 'v1', 'boss', 'h', 'האצלה לדוגמה', $2, $3)`,
      [BUSINESS, '0'.repeat(64), '1'.repeat(64)],
    );

    expect(await withBusiness(BUSINESS, (bdb) => delegationsToday(bdb))).toBe(1);

    // An envelope with no matching audit row must not move the count.
    const envelope = anEnvelope();
    await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, envelope, { parentJobId: 'JOB-root' }));
    expect(await withBusiness(BUSINESS, (bdb) => delegationsToday(bdb))).toBe(1);
  });
});

describe('attachChildJob', () => {
  it('attachChildJob fills the column the resumer reads', async () => {
    const envelope = anEnvelope();
    await withBusiness(BUSINESS, (bdb) => writeEnvelope(bdb, envelope, { parentJobId: 'JOB-root' }));

    await withBusiness(BUSINESS, (bdb) => attachChildJob(bdb, envelope.id, 'JOB-child'));

    const { rows } = await testDb().query<{ child_job_id: string | null }>(
      `SELECT child_job_id FROM agent_envelopes WHERE business_id = $1 AND envelope_id = $2`,
      [BUSINESS, envelope.id],
    );
    expect(rows[0]?.child_job_id).toBe('JOB-child');
  });
});
