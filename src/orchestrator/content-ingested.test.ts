import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, loadJob, markContentIngested } from './jobs.js';

const BUSINESS = 'test-business';

async function newJob(): Promise<string> {
  const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
  });
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
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.contentIngested).toBe(false);
  });

  it('is true after marking', async () => {
    const jobId = await newJob();
    await markContentIngested(jobId, { businessId: BUSINESS });
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.contentIngested).toBe(true);
  });

  it('is idempotent — marking twice leaves it true', async () => {
    const jobId = await newJob();
    await markContentIngested(jobId, { businessId: BUSINESS });
    await markContentIngested(jobId, { businessId: BUSINESS });
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.contentIngested).toBe(true);
  });

  it('does not mark another business’s job', async () => {
    const jobId = await newJob();
    await markContentIngested(jobId, { businessId: 'other-business' });
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.contentIngested).toBe(false);
  });
});
