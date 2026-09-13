import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { writeMemory } from '../memory/store.js';
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
    await getPool().query(
      `INSERT INTO documents (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
       VALUES ('DOC-1', $1, 'manual', 'doc.txt', 'text/plain', repeat('a', 64), 12, $2, 'extracted')`,
      [BUSINESS, path],
    );

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

    await executeErasure(plan, { businessId: BUSINESS });

    const { rows } = await getPool().query<{ kind: string; reason: string }>(
      `SELECT kind, reason FROM audit_log WHERE business_id=$1 AND kind='erasure'`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).not.toContain(RONIT);
    expect(rows[0]?.reason).not.toContain('רונית');
    expect(rows[0]?.reason).toMatch(/\d/);
  });
});
