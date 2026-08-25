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

    const outcome = await executeStep({
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

    // `doc.fetch` is in `READ_ONLY_TOOLS`, so this must reach `allow` and
    // therefore `perform` — otherwise the assertion below would hold for the
    // wrong reason, exactly like the vacuous `mail.send` test this replaces.
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') expect(outcome.result).toBe('text');
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.contentIngested).toBe(true);
  });

  it('leaves the flag alone for a tool that does not read', async () => {
    const { job, bundle } = await jobInExecute();

    // `inReplyTo` refines `mail.send` to `email.reply` (fixture base
    // `auto_notify`), not `email.initiate` (`approve_required`) — a step that
    // stopped at `queue_approval` would never reach `markContentIngested` or
    // `perform`, and the flag would read `false` regardless of whether the
    // marking code ran at all. Asserting `outcome.status === 'done'` is what
    // makes that distinction visible.
    const outcome = await executeStep({
      job,
      stepId: 's1',
      agent: 'comms.email',
      bundle,
      toolName: 'mail.send',
      toolInput: {
        to: 'dana@example.com',
        subject: 's',
        body: 'b',
        counterpartyId: 'c_812',
        inReplyTo: 'thread-42',
      },
      perform: async () => ({ output: null, externalId: 'MSG-1' }),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(outcome.status).toBe('done');
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.contentIngested).toBe(false);
  });

  it('marks the flag before perform runs, even when perform throws', async () => {
    const { job, bundle } = await jobInExecute();

    const outcome = await executeStep({
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

    // `refused`/`adapter_threw` only happens if `perform` was actually
    // invoked and threw — proof this test exercises the real call, not a
    // gate short-circuit.
    expect(outcome.status).toBe('refused');
    if (outcome.status === 'refused') expect(outcome.code).toBe('adapter_threw');
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.contentIngested).toBe(true);
  });
});
