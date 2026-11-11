import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, loadJob, markContentIngested } from './jobs.js';

const MIGRATION_011 = join(
  dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/011_job_content_ingested.sql',
);

const BUSINESS = 'test-business';

async function newJob(): Promise<string> {
  const bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
  const job = await withBusiness(BUSINESS, (db) => createJob(db, {
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
  }));
  return job.jobId;
}

describe('the content-ingested flag', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('starts false on a new job', async () => {
    const jobId = await newJob();
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.contentIngested).toBe(false);
  });

  it('is true after marking, and reports one row matched', async () => {
    const jobId = await newJob();
    const matched = await withBusiness(BUSINESS, (db) => markContentIngested(db, jobId));
    expect(matched).toBe(1);
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.contentIngested).toBe(true);
  });

  it('is idempotent — marking twice leaves it true', async () => {
    const jobId = await newJob();
    await withBusiness(BUSINESS, (db) => markContentIngested(db, jobId));
    await withBusiness(BUSINESS, (db) => markContentIngested(db, jobId));
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.contentIngested).toBe(true);
  });

  it('does not mark another business’s job, and reports zero rows matched', async () => {
    const jobId = await newJob();
    const matched = await withBusiness('other-business', (db) => markContentIngested(db, jobId));
    expect(matched).toBe(0);
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.contentIngested).toBe(false);
  });

  it('backfills an open job that predates the column, and leaves a closed one alone', async () => {
    // Simulate a row written before migration 011 ever ran: drop the column
    // so `createJob` inserts exactly what it would have inserted back then —
    // it never mentions content_ingested in its own SQL, so this is not a
    // fake, it is the real pre-migration insert path. Restored a few lines
    // down by re-running the migration file itself, which is the point: we
    // are proving what that file does to a row it did not create.
    await testDb().query('ALTER TABLE jobs DROP COLUMN content_ingested');

    // Everything from here until the migration file re-adds the column runs
    // inside try/finally: if any step throws, the column must still come
    // back, or every later test (in this file and beyond) inherits a schema
    // this test broke rather than restored.
    try {
      const bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
      const insertJob = () =>
        withBusiness(BUSINESS, (db) => createJob(db, { charterVersion: bundle.charterVersion, provenance: 'boss' }));
      const openJobId = (await insertJob()).jobId;
      const closedJobId = (await insertJob()).jobId;
      await testDb().query('UPDATE jobs SET closed_at = now() WHERE job_id = $1', [closedJobId]);

      const sql = await readFile(MIGRATION_011, 'utf8');
      await testDb().query(sql);

      expect((await withBusiness(BUSINESS, (db) => loadJob(db, openJobId)))?.contentIngested).toBe(true);
      expect((await withBusiness(BUSINESS, (db) => loadJob(db, closedJobId)))?.contentIngested).toBe(false);
    } finally {
      await testDb().query(
        'ALTER TABLE jobs ADD COLUMN IF NOT EXISTS content_ingested BOOLEAN NOT NULL DEFAULT false',
      );
    }
  });
});
