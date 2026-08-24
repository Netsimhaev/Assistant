import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, loadJob, transition } from './jobs.js';
import { executeStep } from './execute.js';

const BUSINESS = 'test-business';
const NOON = new Date('2026-08-18T09:00:00.000Z');

async function jobInExecute() {
  const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return { job: loaded, bundle };
}

describe('the executor and the provenance signal', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('marks the job as having ingested content when the tool reads', async () => {
    const { job, bundle } = await jobInExecute();

    await executeStep({
      job,
      stepId: 's1',
      agent: 'know.reader',
      bundle,
      toolName: 'doc.fetch',
      toolInput: { uri: 'https://example.com/doc' },
      perform: async () => ({ output: 'text', externalId: null }),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.contentIngested).toBe(true);
  });

  it('leaves the flag alone for a tool that does not read', async () => {
    const { job, bundle } = await jobInExecute();

    await executeStep({
      job,
      stepId: 's1',
      agent: 'comms.email',
      bundle,
      toolName: 'mail.send',
      toolInput: { to: 'dana@example.com', subject: 's', body: 'b', counterpartyId: 'c_812' },
      perform: async () => ({ output: null, externalId: 'MSG-1' }),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.contentIngested).toBe(false);
  });

  it('marks the flag before perform runs, even when perform throws', async () => {
    const { job, bundle } = await jobInExecute();

    await executeStep({
      job,
      stepId: 's1',
      agent: 'know.reader',
      bundle,
      toolName: 'doc.fetch',
      toolInput: { uri: 'https://example.com/doc' },
      perform: async () => {
        throw new Error('boom');
      },
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.contentIngested).toBe(true);
  });
});
