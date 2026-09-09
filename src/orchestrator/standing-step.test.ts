/**
 * C1: the instruction door's standing authorisation must actually be read.
 *
 * `src/policy/standing-approval.test.ts` already proves the gate honours one
 * when a caller opts in. This file proves the opposite half — that the
 * production executor *is* such a caller. Before this, `executeStep` built its
 * `GateContext` without `useStandingAuthorization`, so `standing` was always
 * `false`, and the row `instruct.ts` writes on every instruction was read by
 * nothing at all.
 *
 * The two tests are a matched pair on purpose. The positive one alone would
 * hold for any reason the step happened to be allowed; the negative twin runs
 * the identical call with the grant removed and must park on an approval, so
 * the only difference between `done` and `awaiting_approval` is the row under
 * test.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { PolicyBundle } from '../domain/policy.js';
import { grantAuthorization } from '../governance/authorization.js';
import { createJob, loadJob, transition } from './jobs.js';
import type { Job } from './jobs.js';
import { executeStep } from './execute.js';

const BUSINESS = 'test-business';
/** 12:00 Asia/Jerusalem — outside the fixture charter's quiet window. */
const NOON = new Date('2026-08-18T09:00:00.000Z');
const NOTHING = { output: null, externalId: null };

/**
 * A reply to Dana, classified `email.reply` by `inReplyTo`.
 *
 * Deliberately a reply and not an initiation: `email.initiate` carries
 * `approve_required` in the fixture charter, which is the SECOND disjunct of
 * `needsApproval` and outside standing authorisation's reach entirely — a
 * test built on it would park on an approval whether or not the wiring under
 * test exists.
 */
const REPLY = { to: 'dana@example.com', inReplyTo: 'msg-1', subject: 'תיאום', body: 'שלום' };

async function bossJobInExecute(bundle: PolicyBundle): Promise<Job> {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'להשיב לדנה',
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('the executor consults the standing authorisation the instruction door wrote', () => {
  it('runs a covered step without asking again', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const job = await bossJobInExecute(bundle);
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['dana@example.com'] },
      { businessId: BUSINESS },
    );

    let performed = 0;
    const outcome = await executeStep({
      job,
      bundle,
      stepId: 'step-1',
      agent: 'comms.email',
      toolName: 'mail.send',
      toolInput: REPLY,
      counterpartyTags: [],
      // Above the ramp floor on purpose. At `draft_only` stage 8 denies
      // before stage 10 is reached, and this would be `refused` whatever the
      // authorisation said — which is exactly why C1's documentation says
      // this buys nothing in production yet.
      rampLevel: 'auto',
      perform: async () => {
        performed += 1;
        return NOTHING;
      },
      now: NOON,
    });

    expect(outcome.status).toBe('done');
    expect(performed).toBe(1);
    const { rows } = await getPool().query('SELECT 1 FROM approval_requests WHERE job_id = $1', [
      job.jobId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('still asks when no authorisation was granted for the job', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const job = await bossJobInExecute(bundle);
    // No grantAuthorization call — the single difference from the test above.

    let performed = 0;
    const outcome = await executeStep({
      job,
      bundle,
      stepId: 'step-1',
      agent: 'comms.email',
      toolName: 'mail.send',
      toolInput: REPLY,
      counterpartyTags: [],
      rampLevel: 'auto',
      perform: async () => {
        performed += 1;
        return NOTHING;
      },
      now: NOON,
    });

    expect(outcome.status).toBe('awaiting_approval');
    expect(performed).toBe(0);
  });
});
