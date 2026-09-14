import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
import { ErasureAuditUnrecordedError, ErasureRefusedError, executeErasure } from './erasure.js';

const BUSINESS = 'test-business';
const RONIT = 'ronit@beta-log.example';

/** Content that must not survive a scrub, distinctive enough to assert on. */
const SIGNED_SECRET = 'zz-signed-approval-content';

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

async function insertDocument(
  documentId: string,
  storedPath: string,
  sha: string = 'a'.repeat(64),
): Promise<void> {
  await getPool().query(
    `INSERT INTO documents (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
     VALUES ($1, $2, 'manual', 'doc.txt', 'text/plain', $4, 12, $3, 'extracted')`,
    [documentId, BUSINESS, storedPath, sha],
  );
}

async function insertReading(readingId: string, documentId: string, briefHash: string): Promise<void> {
  await getPool().query(
    `INSERT INTO document_readings
       (reading_id, business_id, document_id, status, content, provenance, model, prompt_version, brief_hash)
     VALUES ($1, $2, $3, 'read', '{}', 'boss', 'test-model', 'v1', $4)`,
    [readingId, BUSINESS, documentId, briefHash],
  );
}

async function insertProposal(proposalId: string, readingId: string, jobId: string | null): Promise<void> {
  await getPool().query(
    `INSERT INTO proposals (proposal_id, business_id, reading_id, status, content, model, prompt_version, raw, job_id)
     VALUES ($1, $2, $3, 'proposed', '{}', 'test-model', 'v1', '', $4)`,
    [proposalId, BUSINESS, readingId, jobId],
  );
}

/**
 * A sentinel that forces the audit insert to fail, without stubbing
 * `appendAudit`. Same harness as `src/governance/killswitch.test.ts`
 * (`test_force_audit_failure` / `force_audit_failure`), keyed on
 * `NEW.kind = 'erasure'` instead of a reason substring — an erasure's reason
 * never carries the identity being erased, so there is nothing safe to grep
 * for in it, but `kind` is exactly this row's discriminator.
 */
async function installAuditFailureTrigger(): Promise<void> {
  await getPool().query(`
    CREATE OR REPLACE FUNCTION test_force_erasure_audit_failure() RETURNS trigger AS $$
    BEGIN
      IF NEW.kind = 'erasure' THEN
        RAISE EXCEPTION 'forced erasure audit failure for test';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS force_erasure_audit_failure ON audit_log;
    CREATE TRIGGER force_erasure_audit_failure
      BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION test_force_erasure_audit_failure();
  `);
}

async function removeAuditFailureTrigger(): Promise<void> {
  await getPool().query(`
    DROP TRIGGER IF EXISTS force_erasure_audit_failure ON audit_log;
    DROP FUNCTION IF EXISTS test_force_erasure_audit_failure();
  `);
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

  /**
   * The path is relative in the column, as `ingest.ts` writes it, and the
   * plan is what turns it into something `unlink` can act on. Written against
   * a temp root injected into the plan builder, exactly as `verify.ts`'s tests
   * inject theirs.
   *
   * **`filesRemoved === 1` is the load-bearing half.** An already-absent file
   * is tolerated, so a run that resolved the path wrongly and deleted nothing
   * still leaves `access()` rejecting and `filesFailed` empty. Only the count
   * separates "we deleted it" from "we never found it" — which is precisely
   * how the relative-path defect stayed invisible.
   */
  it('deletes the file a relative stored_path points at, under the document root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'erase-root-'));
    const relative = `${BUSINESS}/DOC-REL/original.txt`;
    await mkdir(join(root, BUSINESS, 'DOC-REL'), { recursive: true });
    await writeFile(join(root, relative), 'תוכן', 'utf8');
    await insertDocument('DOC-REL', relative);

    const plan = await buildErasurePlan(
      { kind: 'document', documentId: 'DOC-REL' },
      { businessId: BUSINESS, documentRoot: root },
    );
    const outcome = await executeErasure(plan, { businessId: BUSINESS });

    expect(outcome.filesRemoved).toBe(1);
    expect(outcome.filesAlreadyGone).toEqual([]);
    expect(outcome.filesFailed).toEqual([]);
    await expect(access(join(root, relative))).rejects.toThrow();
  });

  /**
   * Tolerating an already-absent file is right — the goal was that it not be
   * there, and it is not. Being indistinguishable from a deletion we performed
   * is what let a total failure to delete anything read as a clean run.
   */
  it('counts an already-absent file apart from one it actually deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'erase-gone-'));
    const relative = `${BUSINESS}/DOC-GONE/original.txt`;
    await insertDocument('DOC-GONE', relative);

    const plan = await buildErasurePlan(
      { kind: 'document', documentId: 'DOC-GONE' },
      { businessId: BUSINESS, documentRoot: root },
    );
    const outcome = await executeErasure(plan, { businessId: BUSINESS });

    expect(outcome.filesRemoved).toBe(0);
    expect(outcome.filesAlreadyGone).toEqual([join(root, relative)]);
    expect(outcome.filesFailed).toEqual([]);
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
   * I2: only three of the statements had any coverage before this test —
   * deleting any of the other lines left the whole suite green. One row
   * seeded for every statement; removing any single line from
   * `executeErasure` must make this fail. Thirteen since the signed-approval
   * scrub of spec §5.1.1 was implemented (final review, N3).
   */
  it('touches every one of the thirteen statements — deletes vanish, scrubs stay and empty', async () => {
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
    const unsignedApproval = `AP-${ulid()}`;
    await getPool().query(
      `INSERT INTO approval_requests
         (approval_id, business_id, job_id, action_class, summary, detail, risk,
          proposed_tool, proposed_input, input_hash, expires_at)
       VALUES ($1, $2, $3, 'email.reply', 'x', 'x', '{}', 'mail.send', '{}', 'h', $4)`,
      [unsignedApproval, BUSINESS, jobId, new Date(Date.now() + 3600_000).toISOString()],
    );
    // The thirteenth statement: an approval a signature points at is emptied
    // and kept, not deleted (spec §5.1.1). The signature hangs off a SECOND
    // document, one this plan does not name, so the signed-document refusal
    // is not what is being exercised here.
    const signedApproval = `AP-${ulid()}`;
    await getPool().query(
      `INSERT INTO approval_requests
         (approval_id, business_id, job_id, action_class, summary, detail, risk,
          proposed_tool, proposed_input, input_hash, expires_at)
       VALUES ($1, $2, $3, 'email.reply', $5, $5, '{}', 'mail.send', '{}', 'h2', $4)`,
      [
        signedApproval,
        BUSINESS,
        jobId,
        new Date(Date.now() + 3600_000).toISOString(),
        SIGNED_SECRET,
      ],
    );
    const otherDocument = `DOC-${ulid()}`;
    await insertDocument(otherDocument, `nowhere/${otherDocument}.txt`, 'b'.repeat(64));
    await recordSignature(
      {
        signatureId: `SIG-${ulid()}`,
        documentId: otherDocument,
        signedSha256: 'e'.repeat(64),
        approvalId: signedApproval,
        signedBy: 'owner',
      },
      { businessId: BUSINESS },
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
    // Keyed by table AND action: `approval_requests` now reports both a
    // delete and a scrub, and a map keyed by table alone would silently let
    // one stand in for the other.
    const byStatement = new Map(
      outcome.deleted.map((item) => [`${item.table}:${item.action}`, item]),
    );

    expect(byStatement.get('memories:delete')).toEqual({ table: 'memories', action: 'delete', count: 1 });
    expect(byStatement.get('document_artifacts:delete')).toEqual({ table: 'document_artifacts', action: 'delete', count: 1 });
    expect(byStatement.get('document_readings:delete')).toEqual({ table: 'document_readings', action: 'delete', count: 1 });
    expect(byStatement.get('proposals:delete')).toEqual({ table: 'proposals', action: 'delete', count: 1 });
    expect(byStatement.get('approval_requests:delete')).toEqual({ table: 'approval_requests', action: 'delete', count: 1 });
    expect(byStatement.get('approval_requests:scrub')).toEqual({ table: 'approval_requests', action: 'scrub', count: 1 });
    expect(byStatement.get('boss_instructions:delete')).toEqual({ table: 'boss_instructions', action: 'delete', count: 1 });
    expect(byStatement.get('job_plans:delete')).toEqual({ table: 'job_plans', action: 'delete', count: 1 });
    expect(byStatement.get('job_authorizations:delete')).toEqual({ table: 'job_authorizations', action: 'delete', count: 1 });
    expect(byStatement.get('documents:delete')).toEqual({ table: 'documents', action: 'delete', count: 1 });
    expect(byStatement.get('jobs:scrub')).toEqual({ table: 'jobs', action: 'scrub', count: 1 });
    expect(byStatement.get('job_steps:scrub')?.action).toBe('scrub');
    expect(byStatement.get('job_steps:scrub')?.count ?? 0).toBeGreaterThan(0);
    expect(byStatement.get('job_step_results:scrub')).toEqual({ table: 'job_step_results', action: 'scrub', count: 1 });

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
    const approvals = await getPool().query<{ approval_id: string; summary: string }>(
      'SELECT approval_id, summary FROM approval_requests WHERE job_id=$1',
      [jobId],
    );
    // The unsigned card is gone; the signed one is still there and emptied.
    expect(approvals.rows.map((r) => r.approval_id)).toEqual([signedApproval]);
    expect(approvals.rows.map((r) => r.approval_id)).not.toContain(unsignedApproval);
    expect(approvals.rows[0]?.summary).not.toContain(SIGNED_SECRET);
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

  /**
   * N1 / Residual 2 (fix round 2): C1's fix only closed the reverse direction
   * for a `document` anchor. A `contact` anchor that closes *forward* to a
   * shared document has the identical gap the other way around: the explicit
   * `DELETE FROM proposals` was scoped to `job_id = ANY(jobIds)`, so a SECOND
   * job's proposal on the SAME reading — one `document_readings` row cascades
   * onto every proposal that cites it — was neither previewed nor credited to
   * the statement that actually destroyed it via cascade. `job_id IS NULL`
   * (a legacy proposal predating migration 018) fails that same `job_id =
   * ANY(...)` test identically, so one fix (scoping `proposals` by
   * `reading_id` through the erased documents as well as by `job_id`) closes
   * both gaps at once.
   *
   * Two DIFFERENT jobs propose against the SAME reading — the documented
   * expected state: readings dedupe by `(business_id, document_id,
   * brief_hash, prompt_version, provenance)` and proposals deliberately do
   * not, and `conductPendingDocuments` opens a fresh job per document per
   * pass. Only `jobA` is reachable from the contact; `jobB` is not swept into
   * `jobIds` (erasing a contact must not sweep in an unrelated job's whole
   * record), but its proposal on the shared reading is still about to be
   * destroyed the moment `document_readings` is deleted, and the preview and
   * the executor must both say so.
   */
  it('a contact anchor that reaches a shared reading counts every proposal on it, not just its own job’s', async () => {
    const jobA = await bareJob('shared-reading-a');
    await getPool().query(
      `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
       VALUES ($1, $2, 'email.reply', ARRAY[$3])`,
      [BUSINESS, jobA, RONIT],
    );
    const jobB = await bareJob('shared-reading-b'); // unrelated to RONIT anywhere

    const documentId = `DOC-${ulid()}`;
    await insertDocument(documentId, `nowhere/${documentId}.txt`);
    const readingId = `READ-${ulid()}`;
    await insertReading(readingId, documentId, 'hash-n1-contact');
    const proposalA = `PROP-${ulid()}`;
    await insertProposal(proposalA, readingId, jobA);
    const proposalB = `PROP-${ulid()}`;
    await insertProposal(proposalB, readingId, jobB);

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });
    expect(plan.jobIds).toContain(jobA);
    expect(plan.jobIds).not.toContain(jobB);
    expect(plan.documentIds).toContain(documentId);

    const proposalsItem = plan.items.find((item) => item.table === 'proposals');
    expect(proposalsItem?.count).toBe(2);

    const outcome = await executeErasure(plan, { businessId: BUSINESS });
    const deletedProposals = outcome.deleted.find((item) => item.table === 'proposals');
    expect(deletedProposals?.count).toBe(2);

    const remaining = await getPool().query('SELECT 1 FROM proposals WHERE reading_id=$1', [readingId]);
    expect(remaining.rows).toHaveLength(0);
  });

  /**
   * N1's "cover it too" for the `window` anchor: same shared-reading shape,
   * reached via a job found by creation time instead of by contact.
   */
  it('a window anchor that reaches a shared reading counts every proposal on it, not just its own job’s', async () => {
    const jobA = await bareJob('window-shared-reading-a');
    const jobB = await bareJob('window-shared-reading-b');

    const documentId = `DOC-${ulid()}`;
    await insertDocument(documentId, `nowhere/${documentId}.txt`);
    const readingId = `READ-${ulid()}`;
    await insertReading(readingId, documentId, 'hash-n1-window');
    const proposalA = `PROP-${ulid()}`;
    await insertProposal(proposalA, readingId, jobA);
    const proposalB = `PROP-${ulid()}`;
    await insertProposal(proposalB, readingId, jobB);

    // Real-clock creation times land within milliseconds of each other, so a
    // window couldn't otherwise separate them deterministically. Stamped
    // apart by an hour so the window below can be built to include jobA and
    // exclude jobB unambiguously — the point of this test is the shared
    // reading, not the window boundary arithmetic.
    const jobATime = new Date('2026-01-01T00:00:00.000Z');
    const jobBTime = new Date('2026-01-01T01:00:00.000Z');
    await getPool().query('UPDATE jobs SET created_at=$2 WHERE job_id=$1', [jobA, jobATime.toISOString()]);
    await getPool().query('UPDATE jobs SET created_at=$2 WHERE job_id=$1', [jobB, jobBTime.toISOString()]);

    const fromIso = new Date(jobATime.getTime() - 1000).toISOString();
    const toIso = new Date(jobATime.getTime() + 1000).toISOString();

    const plan = await buildErasurePlan({ kind: 'window', fromIso, toIso }, { businessId: BUSINESS });
    expect(plan.jobIds).toContain(jobA);
    expect(plan.jobIds).not.toContain(jobB);
    expect(plan.documentIds).toContain(documentId);

    const proposalsItem = plan.items.find((item) => item.table === 'proposals');
    expect(proposalsItem?.count).toBe(2);

    const outcome = await executeErasure(plan, { businessId: BUSINESS });
    const deletedProposals = outcome.deleted.find((item) => item.table === 'proposals');
    expect(deletedProposals?.count).toBe(2);

    const remaining = await getPool().query('SELECT 1 FROM proposals WHERE reading_id=$1', [readingId]);
    expect(remaining.rows).toHaveLength(0);
  });

  /**
   * The orphan shapes — a row whose `job_id` is NULL, in the two tables that
   * allow one.
   *
   * `approval_requests.job_id` is TEXT with no NOT NULL and no foreign key
   * (001_spine.sql), and the production path that produces the shape is real:
   * `GateContext.jobId` is `string | null`, `evaluateToolCall` writes
   * `jobId: ctx.jobId ?? null` into `enqueueApproval`, and `gate-hook.ts`
   * carries the same nullable id for the SDK path that has no job row. Such a
   * card holds the recipient address and the whole message body in `summary`,
   * `detail` and `proposed_input`, and it closes over to no job at all — so
   * nothing scoped by `job_id = ANY(...)` can ever reach it. Before this, the
   * plan did not even LIST it: the search found it and the `job_id IS NOT
   * NULL` filter discarded it. Silence plus survival, which is the worst
   * shape of this branch's recurring family.
   *
   * `proposals.job_id` became nullable in migration 018 and `ON DELETE SET
   * NULL` still produces one. That side is already correct — it is reached
   * through `reading_id` — but nothing named it, which is exactly the reason
   * to name it: a test that says "a row with a NULL job id still gets erased"
   * makes the next reader ask the same question about the next table.
   *
   * Both halves assert the same thing twice, deliberately: the plan LISTS the
   * row (count > 0) and the executor DELETES it. Listing without deleting is
   * the failure this is here for.
   */
  describe('a row whose job_id is NULL', () => {
    /** An approval card with no job behind it, carrying the anchor verbatim. */
    async function orphanApproval(identifier: string): Promise<string> {
      const approvalId = `AP-${ulid()}`;
      await getPool().query(
        `INSERT INTO approval_requests
           (approval_id, business_id, job_id, action_class, summary, detail, risk,
            proposed_tool, proposed_input, input_hash, expires_at)
         VALUES ($1, $2, NULL, 'email.reply', $3, $4, '{}', 'mail.send', $5, $6, $7)`,
        [
          approvalId,
          BUSINESS,
          `שליחת מייל אל ${identifier}`,
          `הגוף המלא של ההודעה אל ${identifier}`,
          JSON.stringify({ to: identifier, body: `שלום ${identifier}` }),
          `hash-${approvalId}`,
          new Date(Date.now() + 3600_000).toISOString(),
        ],
      );
      return approvalId;
    }

    const countOf = (plan: ErasurePlan, table: string, action: 'delete' | 'scrub'): number =>
      plan.items.find((item) => item.table === table && item.action === action)?.count ?? 0;

    it('an orphan approval_requests row is listed by a contact plan and deleted by the executor', async () => {
      const mine = await orphanApproval(RONIT);
      const theirs = await orphanApproval('avi@gamma-lift.example');

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: RONIT },
        { businessId: BUSINESS },
      );

      // Listed. Without this the owner confirms a preview that never
      // mentioned the row holding the address and the message body.
      expect(countOf(plan, 'approval_requests', 'delete')).toBe(1);

      await executeErasure(plan, { businessId: BUSINESS });

      const survivors = await getPool().query<{ approval_id: string }>(
        'SELECT approval_id FROM approval_requests WHERE business_id=$1',
        [BUSINESS],
      );
      // The other direction in the same assertion: a predicate that swept
      // every orphan card would fail here, not pass.
      expect(survivors.rows.map((r) => r.approval_id)).toEqual([theirs]);
      expect(survivors.rows.map((r) => r.approval_id)).not.toContain(mine);
    });

    it('an orphan approval_requests row created inside a window is listed and deleted', async () => {
      const inside = await orphanApproval(RONIT);
      const outside = await orphanApproval('avi@gamma-lift.example');
      await getPool().query(
        `UPDATE approval_requests SET created_at = now() - interval '30 days' WHERE approval_id = $1`,
        [outside],
      );

      const plan = await buildErasurePlan(
        {
          kind: 'window',
          fromIso: new Date(Date.now() - 3600_000).toISOString(),
          toIso: new Date(Date.now() + 3600_000).toISOString(),
        },
        { businessId: BUSINESS },
      );

      expect(countOf(plan, 'approval_requests', 'delete')).toBe(1);

      await executeErasure(plan, { businessId: BUSINESS });

      const survivors = await getPool().query<{ approval_id: string }>(
        'SELECT approval_id FROM approval_requests WHERE business_id=$1',
        [BUSINESS],
      );
      expect(survivors.rows.map((r) => r.approval_id)).toEqual([outside]);
      expect(survivors.rows.map((r) => r.approval_id)).not.toContain(inside);
    });

    it('an orphan proposals row on an erased reading is listed and deleted', async () => {
      const documentId = `DOC-${ulid()}`;
      await insertDocument(documentId, `nowhere/${documentId}.txt`);
      const readingId = `READ-${ulid()}`;
      await insertReading(readingId, documentId, `brief-${ulid()}`);
      const orphanProposal = `PROP-${ulid()}`;
      await insertProposal(orphanProposal, readingId, null);

      const plan = await buildErasurePlan(
        { kind: 'document', documentId },
        { businessId: BUSINESS },
      );

      expect(countOf(plan, 'proposals', 'delete')).toBe(1);

      await executeErasure(plan, { businessId: BUSINESS });

      const rows = await getPool().query('SELECT 1 FROM proposals WHERE proposal_id=$1', [
        orphanProposal,
      ]);
      expect(rows.rows).toHaveLength(0);
    });
  });

  /**
   * Spec §5.1.1's one conditional: `approval_requests` is deleted **unless a
   * signature points at it, and then it is scrubbed**.
   *
   * A signature says "this person, at this time, THROUGH THIS APPROVAL,
   * accepted the document". Deleting the approval out from under it leaves
   * the one row recording a human act pointing at nothing — the same ethic
   * migration 020 already encodes by making the signature survive its
   * document's deletion with `ON DELETE RESTRICT`. The content still goes;
   * the row stays.
   *
   * The document behind the signature is deliberately one the anchor does NOT
   * reach, so the signed-document refusal is not what this measures.
   */
  describe('an approval a signature points at', () => {
    async function approvalFor(jobId: string | null, identifier: string): Promise<string> {
      const approvalId = `AP-${ulid()}`;
      await getPool().query(
        `INSERT INTO approval_requests
           (approval_id, business_id, job_id, action_class, summary, detail, risk,
            proposed_tool, proposed_input, input_hash, expires_at, edited_input,
            decision_note, diff_vs_norm, artifacts)
         VALUES ($1, $2, $3, 'email.reply', $4, $5, $6, 'mail.send', $7, $8, $9, $10, $11, $12, $13)`,
        [
          approvalId,
          BUSINESS,
          jobId,
          `שליחת מייל אל ${identifier}`,
          `הגוף המלא אל ${identifier}`,
          JSON.stringify({ band: 'sensitive', note: identifier }),
          JSON.stringify({ to: identifier }),
          `hash-${approvalId}`,
          new Date(Date.now() + 3600_000).toISOString(),
          JSON.stringify({ to: identifier, body: identifier }),
          `הבעלים כתב: ${identifier}`,
          `חריגה לעומת ${identifier}`,
          JSON.stringify([{ name: identifier }]),
        ],
      );
      return approvalId;
    }

    it('is scrubbed and kept, while an unsigned one beside it is deleted', async () => {
      const jobId = await bareJob(`מייל אל ${RONIT}`);
      const signedApproval = await approvalFor(jobId, RONIT);
      const unsignedApproval = await approvalFor(jobId, RONIT);

      // A document the contact anchor cannot reach, so the signed-DOCUMENT
      // refusal never fires and what is measured here is the approval branch.
      const elsewhere = `DOC-${ulid()}`;
      await insertDocument(elsewhere, `nowhere/${elsewhere}.txt`);
      await recordSignature(
        {
          signatureId: `SIG-${ulid()}`,
          documentId: elsewhere,
          signedSha256: 'd'.repeat(64),
          approvalId: signedApproval,
          signedBy: 'owner',
        },
        { businessId: BUSINESS },
      );

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: RONIT },
        { businessId: BUSINESS },
      );
      expect(plan.refusals).toEqual([]);

      // The preview says both things, separately: one row goes, one is emptied.
      const item = (action: 'delete' | 'scrub'): number =>
        plan.items.find((i) => i.table === 'approval_requests' && i.action === action)?.count ?? 0;
      expect(item('delete')).toBe(1);
      expect(item('scrub')).toBe(1);

      await executeErasure(plan, { businessId: BUSINESS });

      const rows = await getPool().query<{
        approval_id: string;
        summary: string;
        detail: string;
        proposed_input: unknown;
        edited_input: unknown;
        decision_note: string | null;
        diff_vs_norm: string | null;
        artifacts: unknown;
        risk: unknown;
      }>(
        `SELECT approval_id, summary, detail, proposed_input, edited_input,
                decision_note, diff_vs_norm, artifacts, risk
           FROM approval_requests WHERE business_id = $1`,
        [BUSINESS],
      );

      // The unsigned one is gone; the signed one is still there.
      expect(rows.rows.map((r) => r.approval_id)).toEqual([signedApproval]);
      expect(rows.rows.map((r) => r.approval_id)).not.toContain(unsignedApproval);

      // And it holds nothing to read. Every content column spec §5.1 names.
      const kept = rows.rows[0];
      if (kept === undefined) throw new Error('unreachable');
      for (const value of [
        kept.summary,
        kept.detail,
        JSON.stringify(kept.proposed_input),
        JSON.stringify(kept.edited_input),
        kept.decision_note ?? '',
        kept.diff_vs_norm ?? '',
        JSON.stringify(kept.artifacts),
        JSON.stringify(kept.risk),
      ]) {
        expect(value).not.toContain(RONIT);
      }

      // The signature itself survives, still pointing at a row that exists.
      const signature = await getPool().query('SELECT 1 FROM signatures WHERE approval_id = $1', [
        signedApproval,
      ]);
      expect(signature.rows).toHaveLength(1);
    });
  });

  /**
   * I3 (round 1 residual, now closed): an `appendAudit` failure after the
   * database transaction and file deletions have already committed must not
   * be reported as though nothing happened. Same forced-failure harness as
   * `src/governance/killswitch.test.ts` (a real BEFORE INSERT trigger on
   * `audit_log`, self-installed and self-removed) — CLAUDE.md explicitly
   * sanctions disabling/restoring `audit_log` triggers from a test, and this
   * one only ever fires on `kind = 'erasure'`, so it cannot affect any other
   * audit write in the same run.
   */
  describe('appendAudit failure after the erasure has already committed', () => {
    afterEach(async () => {
      await removeAuditFailureTrigger();
    });

    it('throws ErasureAuditUnrecordedError carrying the real, completed outcome', async () => {
      await installAuditFailureTrigger();
      const { jobId } = await seed();
      const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

      let caught: unknown;
      try {
        await executeErasure(plan, { businessId: BUSINESS });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ErasureAuditUnrecordedError);
      const typedError = caught as ErasureAuditUnrecordedError;
      expect(typedError.erased).toBe(true);
      expect(typedError.cause).toBeInstanceOf(Error);
      expect((typedError.cause as Error).message).toContain('forced erasure audit failure');

      // The erasure itself is unconditionally done: real counts on the error,
      // and the rows are actually gone — the failure is only in the log.
      const total = typedError.outcome.deleted.reduce((sum, item) => sum + item.count, 0);
      expect(total).toBeGreaterThan(0);
      const memories = await getPool().query('SELECT 1 FROM memories WHERE business_id=$1', [BUSINESS]);
      expect(memories.rows).toHaveLength(0);
      const auth = await getPool().query('SELECT 1 FROM job_authorizations WHERE job_id=$1', [jobId]);
      expect(auth.rows).toHaveLength(0);

      // And genuinely no audit row: the append failed for real, not a retry
      // swallowing the error.
      const rows = await getPool().query(`SELECT 1 FROM audit_log WHERE business_id=$1 AND kind='erasure'`, [BUSINESS]);
      expect(rows.rows).toHaveLength(0);
    });
  });
});
