import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { compileCharter } from '../charter/compile.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { createJob } from '../orchestrator/jobs.js';
import { grantAuthorization, loadAuthorization } from '../orchestrator/authorization.js';
import { evaluateToolCall } from './engine.js';

const BUSINESS = 'test-business';
const bundle = compileCharter(buildCharter());

// Outside the fixture charter's quiet-hours window (20:00-07:00) so the
// gate's step 7 never denies before reaching the code under test.
const NOON = new Date('2026-08-18T09:00:00.000Z');

async function bossJob(title: string) {
  return createJob({
    charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS, title,
  });
}

/** A reply to Dana. Classified `email.reply` because it carries `inReplyTo`. */
const REPLY = { to: 'dana@example.com', inReplyTo: 'msg-1', subject: 'תיאום', body: 'שלום' };

beforeEach(async () => {
  await resetDatabase();
  await installCharter(buildCharter(), { businessId: BUSINESS });
});
afterAll(async () => { await closePool(); });

describe('standing authorisation at the gate', () => {
  it('lets an authorised reply through without queueing an approval', async () => {
    const job = await bossJob('להשיב לדנה');
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['dana@example.com'] },
      { businessId: BUSINESS },
    );
    const auth = await loadAuthorization(job.jobId, { businessId: BUSINESS });

    const decision = await evaluateToolCall('mail.send', REPLY, {
      agent: 'comms.email',
      bundle,
      provenance: 'boss',
      chainDepth: 0,
      counterpartyTags: [],
      // Above the floor on purpose: at draft_only stage 8 denies first and
      // this code is never reached.
      rampLevel: 'auto',
      businessId: BUSINESS,
      jobId: job.jobId,
      standingAuthorization: auth,
      now: NOON,
    });

    // The positive half matters. Without it this test would pass if the call
    // were denied for any reason at all.
    expect(decision.outcome).toBe('allow');
    const { rows } = await getPool().query('SELECT 1 FROM approval_requests WHERE job_id = $1', [job.jobId]);
    expect(rows).toHaveLength(0);
  });

  it('still asks when the recipient is not the one authorised', async () => {
    const job = await bossJob('להשיב לדנה');
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['dana@example.com'] },
      { businessId: BUSINESS },
    );
    const auth = await loadAuthorization(job.jobId, { businessId: BUSINESS });

    const decision = await evaluateToolCall('mail.send', { ...REPLY, to: 'stranger@x.com' }, {
      agent: 'comms.email', bundle, provenance: 'boss',
      chainDepth: 0, counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId, standingAuthorization: auth,
      now: NOON,
    });

    expect(decision.outcome).toBe('queue_approval');
  });

  it('still asks when there is no authorisation at all', async () => {
    const job = await bossJob('משימה בלי הרשאה');
    const decision = await evaluateToolCall('mail.send', REPLY, {
      agent: 'comms.email', bundle, provenance: 'boss',
      chainDepth: 0, counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId, standingAuthorization: null,
      now: NOON,
    });
    expect(decision.outcome).toBe('queue_approval');
  });

  it('puts the proposal\'s words on the approval instead of the risk sentence', async () => {
    const job = await bossJob('הצעה');
    const decision = await evaluateToolCall('mail.send', { ...REPLY, to: 'stranger@x.com' }, {
      agent: 'comms.email', bundle, provenance: 'boss',
      chainDepth: 0, counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId,
      proposalText: { headline: 'אשלח מייל לדנה', detail: 'כדי לאשר את מועד ההתקנה' },
      now: NOON,
    });

    expect(decision.outcome).toBe('queue_approval');
    const { rows } = await getPool().query<{ summary: string; detail: string }>(
      'SELECT summary, detail FROM approval_requests WHERE job_id = $1', [job.jobId],
    );
    expect(rows[0]?.summary).toBe('אשלח מייל לדנה');
    expect(rows[0]?.detail).toBe('כדי לאשר את מועד ההתקנה');
  });

  it('falls back to the risk sentence when no proposal text is supplied', async () => {
    const job = await bossJob('בלי הצעה');
    await evaluateToolCall('mail.send', { ...REPLY, to: 'stranger@x.com' }, {
      agent: 'comms.email', bundle, provenance: 'boss',
      chainDepth: 0, counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId,
      now: NOON,
    });
    const { rows } = await getPool().query<{ summary: string }>(
      'SELECT summary FROM approval_requests WHERE job_id = $1', [job.jobId],
    );
    expect(rows[0]?.summary).not.toBe('');
  });
});
