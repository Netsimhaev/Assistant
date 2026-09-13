import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { writeMemory } from '../memory/store.js';
import { recordSignature } from './signatures.js';
import type { ErasurePlan } from './erasure-plan.js';
import { buildErasurePlan } from './erasure-plan.js';
import { ErasureRefusedError, executeErasure } from './erasure.js';

const BUSINESS = 'test-business';
const RONIT = 'ronit@beta-log.example';

async function seed(): Promise<{ jobId: string }> {
  const bundle = await installCharter(buildCharter({ version: 'erase-exec' }), {
    businessId: BUSINESS,
  });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: `מייל אל ${RONIT}`,
  });
  await getPool().query(
    `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
     VALUES ($1, $2, 'email.reply', ARRAY[$3])`,
    [BUSINESS, job.jobId, RONIT],
  );
  await writeMemory(
    { jobId: job.jobId, kind: 'entity', subjectKey: RONIT, body: { name: 'רונית' } },
    { businessId: BUSINESS },
  );
  return { jobId: job.jobId };
}

/** A bare job, a fresh charter, nothing else attached. */
async function bareJob(title: string): Promise<string> {
  const bundle = await installCharter(buildCharter({ version: `er-x-${ulid()}` }), {
    businessId: BUSINESS,
  });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title,
  });
  return job.jobId;
}

async function insertDocument(documentId: string, storedPath: string): Promise<void> {
  await getPool().query(
    `INSERT INTO documents (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
     VALUES ($1, $2, 'manual', 'doc.txt', 'text/plain', repeat('a', 64), 12, $3, 'extracted')`,
    [documentId, BUSINESS, storedPath],
  );
}

describe('executeErasure', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('deletes what the plan lists and scrubs what it says to scrub', async () => {
    const { jobId } = await seed();
    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    await executeErasure(plan, { businessId: BUSINESS });

    const memories = await getPool().query('SELECT 1 FROM memories WHERE business_id=$1', [BUSINESS]);
    expect(memories.rows).toHaveLength(0);

    const auth = await getPool().query('SELECT 1 FROM job_authorizations WHERE job_id=$1', [jobId]);
    expect(auth.rows).toHaveLength(0);

    // The job survives, emptied — audit rows point at it.
    const job = await getPool().query<{ title: string | null }>(
      'SELECT title FROM jobs WHERE job_id=$1',
      [jobId],
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]?.title).toBeNull();
  });

  it('deletes the file the document pointed at', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'erase-'));
    const path = join(dir, 'doc.txt');
    await writeFile(path, 'תוכן', 'utf8');
    // `byte_size` is NOT NULL with no default — verified against the live
    // schema during preflight, and omitting it fails the insert.
    await insertDocument('DOC-1', path);

    const plan = await buildErasurePlan({ kind: 'document', documentId: 'DOC-1' }, { businessId: BUSINESS });
    const outcome = await executeErasure(plan, { businessId: BUSINESS });

    expect(outcome.filesRemoved).toBe(1);
    expect(outcome.filesFailed).toEqual([]);
    await expect(access(path)).rejects.toThrow();
  });

  it('refuses to run a plan that carries a refusal', async () => {
    const { jobId } = await seed();
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await transition(jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }
    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });
    expect(plan.refusals.length).toBeGreaterThan(0);

    await expect(executeErasure(plan, { businessId: BUSINESS })).rejects.toBeInstanceOf(
      ErasureRefusedError,
    );

    // And nothing was touched on the way to refusing.
    const memories = await getPool().query('SELECT 1 FROM memories WHERE business_id=$1', [BUSINESS]);
    expect(memories.rows).toHaveLength(1);
  });

  /**
   * The audit row is the one record that survives an erasure, so what it does
   * NOT say is the point: a row naming the contact would make the append-only
   * log the single place that name lives forever.
   */
  it('records that an erasure happened, with counts and without the identity', async () => {
    await seed();
    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    const outcome = await executeErasure(plan, { businessId: BUSINESS });
    // The real total, from the statements' own row counts — not a loose
    // "contains a digit" check, which almost any reason string would satisfy.
    const total = outcome.deleted.reduce((sum, item) => sum + item.count, 0);
    expect(total).toBeGreaterThan(0);

    const { rows } = await getPool().query<{ kind: string; reason: string }>(
      `SELECT kind, reason FROM audit_log WHERE business_id=$1 AND kind='erasure'`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).not.toContain(RONIT);
    expect(rows[0]?.reason).not.toContain('רונית');
    expect(rows[0]?.reason).toContain(`${total} פריטים`);
  });

  /**
   * C1: `documents` cascades onto `document_readings`, which cascades onto
   * `proposals`. A `document` anchor's `jobIds` starts empty (it names no
   * contact and no window), so before the resolver closed over readings and
   * proposals, `countItems` reported zero proposals while the cascade was
   * about to destroy every proposal on the document's readings — the preview
   * silently undercounted exactly what its own cascade does.
   *
   * This test fails against the pre-fix resolver: `plan.items` reports 0 for
   * `proposals` even though the row above is about to be (and, via cascade,
   * still would be) destroyed. Confirmed by hand before this fix landed.
   */
  it('a document anchor counts the proposal its own cascade is about to destroy', async () => {
    const jobId = await bareJob('document-anchor-cascade');
    const documentId = `DOC-${ulid()}`;
    await insertDocument(documentId, `nowhere/${documentId}.txt`);

    const readingId = `READ-${ulid()}`;
    await getPool().query(
      `INSERT INTO document_readings
         (reading_id, business_id, document_id, status, content, provenance, model, prompt_version, brief_hash)
       VALUES ($1, $2, $3, 'read', '{}', 'boss', 'test-model', 'v1', 'hash-c1')`,
      [readingId, BUSINESS, documentId],
    );
    const proposalId = `PROP-${ulid()}`;
    await getPool().query(
      `INSERT INTO proposals (proposal_id, business_id, reading_id, status, content, model, prompt_version, raw, job_id)
       VALUES ($1, $2, $3, 'proposed', '{}', 'test-model', 'v1', '', $4)`,
      [proposalId, BUSINESS, readingId, jobId],
    );

    const plan = await buildErasurePlan({ kind: 'document', documentId }, { businessId: BUSINESS });
    const proposalsItem = plan.items.find((item) => item.table === 'proposals');
    expect(proposalsItem?.count).toBe(1);
    expect(plan.jobIds).toContain(jobId);

    const outcome = await executeErasure(plan, { businessId: BUSINESS });
    const deletedProposals = outcome.deleted.find((item) => item.table === 'proposals');
    expect(deletedProposals?.count).toBe(1);

    const remaining = await getPool().query('SELECT 1 FROM proposals WHERE proposal_id=$1', [proposalId]);
    expect(remaining.rows).toHaveLength(0);
  });

  /**
   * I1: atomicity is the single most important property of this file, and it
   * is otherwise untested — replacing the transaction with plain
   * `getPool().query` calls would leave every other test in this file green.
   * Built by hand with a deliberately empty `refusals`: `buildErasurePlan`
   * would itself refuse a signed document, so the only way to exercise the
   * executor's OWN atomicity guarantee, independent of the planner's, is to
   * hand it a plan that reaches the transaction. What actually trips here is
   * the DB constraint (`signatures.document_id … ON DELETE RESTRICT`,
   * migration 020), not the planner.
   *
   * Confirmed by hand against an autocommit version of `executeErasure`
   * (`client.query` replaced by `getPool().query`, `BEGIN`/`COMMIT`/
   * `ROLLBACK` removed): the memory delete commits on its own before the
   * `documents` delete fails, and this test fails because the memory row is
   * gone.
   */
  it('rolls back the whole transaction when one statement fails partway through', async () => {
    const jobId = await bareJob('rollback-target');
    const memory = await writeMemory(
      { jobId, kind: 'entity', subjectKey: 'rollback-subject', body: {} },
      { businessId: BUSINESS },
    );

    const documentId = `DOC-${ulid()}`;
    await insertDocument(documentId, `nowhere/${documentId}.txt`);
    await recordSignature(
      {
        signatureId: `SIG-${ulid()}`,
        documentId,
        signedSha256: 'c'.repeat(64),
        approvalId: `AP-${ulid()}`,
        signedBy: 'owner',
      },
      { businessId: BUSINESS },
    );

    const plan: ErasurePlan = {
      anchor: { kind: 'document', documentId },
      jobIds: [jobId],
      documentIds: [documentId],
      memoryIds: [memory.memoryId],
      filePaths: [],
      items: [],
      excluded: [],
      refusals: [],
    };

    await expect(executeErasure(plan, { businessId: BUSINESS })).rejects.toThrow();

    const memories = await getPool().query('SELECT 1 FROM memories WHERE memory_id=$1', [memory.memoryId]);
    expect(memories.rows).toHaveLength(1);

    const doc = await getPool().query('SELECT 1 FROM documents WHERE document_id=$1', [documentId]);
    expect(doc.rows).toHaveLength(1);
  });

  /**
   * I2: only three of the twelve statements had any coverage before this
   * test — deleting any of the other nine lines left the whole suite green.
   * One row seeded for every statement; removing any single line from
   * `executeErasure` must make this fail.
   */
  it('touches every one of the twelve statements — deletes vanish, scrubs stay and empty', async () => {
    const jobId = await bareJob('twelve-statements');

    const documentId = `DOC-${ulid()}`;
    await insertDocument(documentId, `nowhere/${documentId}.txt`);
    await getPool().query(
      `INSERT INTO document_artifacts (business_id, document_id, ordinal, kind, content)
       VALUES ($1, $2, 0, 'text', '{}')`,
      [BUSINESS, documentId],
    );
    const readingId = `READ-${ulid()}`;
    await getPool().query(
      `INSERT INTO document_readings
         (reading_id, business_id, document_id, status, content, provenance, model, prompt_version, brief_hash)
       VALUES ($1, $2, $3, 'read', '{}', 'boss', 'test-model', 'v1', 'hash-i2')`,
      [readingId, BUSINESS, documentId],
    );
    const proposalId = `PROP-${ulid()}`;
    await getPool().query(
      `INSERT INTO proposals (proposal_id, business_id, reading_id, status, content, model, prompt_version, raw, job_id)
       VALUES ($1, $2, $3, 'proposed', '{}', 'test-model', 'v1', '', $4)`,
      [proposalId, BUSINESS, readingId, jobId],
    );
    await getPool().query(
      `INSERT INTO approval_requests
         (approval_id, business_id, job_id, action_class, summary, detail, risk,
          proposed_tool, proposed_input, input_hash, expires_at)
       VALUES ($1, $2, $3, 'email.reply', 'x', 'x', '{}', 'mail.send', '{}', 'h', $4)`,
      [`AP-${ulid()}`, BUSINESS, jobId, new Date(Date.now() + 3600_000).toISOString()],
    );
    await getPool().query(
      `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text)
       VALUES ($1, $2, $3, 'x')`,
      [`INS-${ulid()}`, BUSINESS, jobId],
    );
    await getPool().query(
      `INSERT INTO job_plans (business_id, job_id, plan_hash, plan)
       VALUES ($1, $2, 'h1', '{}'::jsonb)`,
      [BUSINESS, jobId],
    );
    await getPool().query(
      `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
       VALUES ($1, $2, 'email.reply', ARRAY['x@example.com'])`,
      [BUSINESS, jobId],
    );
    await transition(jobId, { to: 'understand', actor: 'orchestrator', reason: 'seed reason', businessId: BUSINESS });
    await getPool().query(
      `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, external_id)
       VALUES ($1, $2, 'h1', 's1', 'ext-123')`,
      [BUSINESS, jobId],
    );
    const memory = await writeMemory(
      { jobId, kind: 'entity', subjectKey: 'i2-subject', body: {} },
      { businessId: BUSINESS },
    );

    const plan: ErasurePlan = {
      anchor: { kind: 'document', documentId },
      jobIds: [jobId],
      documentIds: [documentId],
      memoryIds: [memory.memoryId],
      filePaths: [],
      items: [],
      excluded: [],
      refusals: [],
    };

    const outcome = await executeErasure(plan, { businessId: BUSINESS });
    const byTable = new Map(outcome.deleted.map((item) => [item.table, item]));

    expect(byTable.get('memories')).toEqual({ table: 'memories', action: 'delete', count: 1 });
    expect(byTable.get('document_artifacts')).toEqual({ table: 'document_artifacts', action: 'delete', count: 1 });
    expect(byTable.get('document_readings')).toEqual({ table: 'document_readings', action: 'delete', count: 1 });
    expect(byTable.get('proposals')).toEqual({ table: 'proposals', action: 'delete', count: 1 });
    expect(byTable.get('approval_requests')).toEqual({ table: 'approval_requests', action: 'delete', count: 1 });
    expect(byTable.get('boss_instructions')).toEqual({ table: 'boss_instructions', action: 'delete', count: 1 });
    expect(byTable.get('job_plans')).toEqual({ table: 'job_plans', action: 'delete', count: 1 });
    expect(byTable.get('job_authorizations')).toEqual({ table: 'job_authorizations', action: 'delete', count: 1 });
    expect(byTable.get('documents')).toEqual({ table: 'documents', action: 'delete', count: 1 });
    expect(byTable.get('jobs')).toEqual({ table: 'jobs', action: 'scrub', count: 1 });
    expect(byTable.get('job_steps')?.action).toBe('scrub');
    expect(byTable.get('job_steps')?.count ?? 0).toBeGreaterThan(0);
    expect(byTable.get('job_step_results')).toEqual({ table: 'job_step_results', action: 'scrub', count: 1 });

    // Deleted rows are gone.
    const deletedChecks: Array<[table: string, column: string, value: string]> = [
      ['memories', 'memory_id', memory.memoryId],
      ['document_artifacts', 'document_id', documentId],
      ['document_readings', 'reading_id', readingId],
      ['proposals', 'proposal_id', proposalId],
      ['job_plans', 'job_id', jobId],
      ['job_authorizations', 'job_id', jobId],
      ['documents', 'document_id', documentId],
    ];
    for (const [table, column, value] of deletedChecks) {
      const { rows } = await getPool().query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [value]);
      expect(rows, table).toHaveLength(0);
    }
    const approvals = await getPool().query('SELECT 1 FROM approval_requests WHERE job_id=$1', [jobId]);
    expect(approvals.rows).toHaveLength(0);
    const instructions = await getPool().query('SELECT 1 FROM boss_instructions WHERE job_id=$1', [jobId]);
    expect(instructions.rows).toHaveLength(0);

    // Scrubbed rows survive, emptied.
    const jobRow = await getPool().query<{ title: string | null }>('SELECT title FROM jobs WHERE job_id=$1', [jobId]);
    expect(jobRow.rows).toHaveLength(1);
    expect(jobRow.rows[0]?.title).toBeNull();

    const stepRows = await getPool().query<{ reason: string }>('SELECT reason FROM job_steps WHERE job_id=$1', [jobId]);
    expect(stepRows.rows.length).toBeGreaterThan(0);
    for (const row of stepRows.rows) expect(row.reason).toBe('נמחק בהוראת הבעלים');

    const resultRow = await getPool().query<{ external_id: string | null }>(
      'SELECT external_id FROM job_step_results WHERE job_id=$1 AND step_id=$2',
      [jobId, 's1'],
    );
    expect(resultRow.rows).toHaveLength(1);
    expect(resultRow.rows[0]?.external_id).toBeNull();
  });

  /**
   * I4: the plan-time refusal reads `jobs.phase` with no lock and is never
   * read again. A job that was quiet when the preview was built but that the
   * scheduler wakes into `execute` before the owner confirms would otherwise
   * have `job_plans`/`job_authorizations` deleted mid-run. The executor must
   * re-check liveness itself, under a lock, using the same plan the owner
   * already approved.
   */
  it('refuses at execution time when a job the plan touches went live after the preview was built', async () => {
    const { jobId } = await seed();
    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });
    expect(plan.refusals).toEqual([]);
    expect(plan.jobIds).toContain(jobId);

    // The scheduler wakes it into a live phase after the preview was shown
    // but before the owner confirmed the erasure.
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await transition(jobId, { to, actor: 'orchestrator', reason: 'woke mid-flight', businessId: BUSINESS });
    }

    await expect(executeErasure(plan, { businessId: BUSINESS })).rejects.toBeInstanceOf(ErasureRefusedError);

    const memories = await getPool().query('SELECT 1 FROM memories WHERE business_id=$1', [BUSINESS]);
    expect(memories.rows).toHaveLength(1);
    const auth = await getPool().query('SELECT 1 FROM job_authorizations WHERE job_id=$1', [jobId]);
    expect(auth.rows).toHaveLength(1);
  });
});
