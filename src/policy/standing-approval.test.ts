import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { compileCharter } from '../charter/compile.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { createJob } from '../orchestrator/jobs.js';
import { grantAuthorization } from '../orchestrator/authorization.js';
import { queryAudit } from '../audit/log.js';
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
      // The gate loads the row itself (fix round 1, F5) — the caller only
      // opts in, it never hands over the row.
      useStandingAuthorization: true,
      now: NOON,
    });

    // The positive half matters. Without it this test would pass if the call
    // were denied for any reason at all.
    expect(decision.outcome).toBe('allow');
    const { rows } = await getPool().query('SELECT 1 FROM approval_requests WHERE job_id = $1', [job.jobId]);
    expect(rows).toHaveLength(0);
  });

  it('does not consult an authorisation the caller did not opt into, even when one exists', async () => {
    // F5: the row is loaded only on request. A caller that forgets the flag
    // — or one that should not have it — gets a fresh question, not a silent
    // grant, even though the exact same authorisation would have covered it.
    const job = await bossJob('להשיב לדנה');
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['dana@example.com'] },
      { businessId: BUSINESS },
    );

    const decision = await evaluateToolCall('mail.send', REPLY, {
      agent: 'comms.email', bundle, provenance: 'boss', chainDepth: 0, counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId, now: NOON,
      // useStandingAuthorization omitted.
    });

    expect(decision.outcome).toBe('queue_approval');
  });

  it('still asks when the recipient is not the one authorised', async () => {
    const job = await bossJob('להשיב לדנה');
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['dana@example.com'] },
      { businessId: BUSINESS },
    );

    const decision = await evaluateToolCall('mail.send', { ...REPLY, to: 'stranger@x.com' }, {
      agent: 'comms.email', bundle, provenance: 'boss',
      chainDepth: 0, counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId,
      useStandingAuthorization: true, now: NOON,
    });

    expect(decision.outcome).toBe('queue_approval');
  });

  it('still asks when there is no authorisation at all', async () => {
    const job = await bossJob('משימה בלי הרשאה');
    const decision = await evaluateToolCall('mail.send', REPLY, {
      agent: 'comms.email', bundle, provenance: 'boss',
      chainDepth: 0, counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId,
      useStandingAuthorization: true, now: NOON,
    });
    expect(decision.outcome).toBe('queue_approval');
  });

  // F1 (controller ruling): a charter ceiling the owner signed — or an
  // envelope cap that can only tighten — stands outside standing
  // authorisation's reach. `email.initiate` (no `inReplyTo`) carries
  // `approve_required` in the reference charter; a standing authorisation
  // naming the exact class and recipient must not buy its way past that.
  it('does not let a standing authorisation override a signed approve_required ceiling', async () => {
    const job = await bossJob('פנייה חדשה לדנה');
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.initiate', recipients: ['dana@example.com'] },
      { businessId: BUSINESS },
    );

    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'dana@example.com', subject: 'תיאום', body: 'שלום' }, // no inReplyTo -> email.initiate
      {
        agent: 'comms.email', bundle, provenance: 'boss', chainDepth: 0, counterpartyTags: [],
        rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId,
        useStandingAuthorization: true, now: NOON,
      },
    );

    expect(decision.outcome).toBe('queue_approval');
  });

  // F2: `NEVER_FULLY_AUTONOMOUS` must hold even when a standing authorisation
  // squarely covers the call. `data.export` is the one member where this
  // actually contends: `contract.sign`/`payment.charge` are unowned (stage 3
  // denies first) and `payment.make`/`refund.issue` are amount-required
  // (the money guard already refuses coverage). The charter's default
  // `no_customer_data_export` rule is dropped via the `forbidden` override so
  // the call reaches stage 8/10 instead of being denied at stage 5, and the
  // class's base autonomy is relaxed off `approve_required` so this test is
  // not merely re-proving F1 under a different class.
  it('never lets a standing authorisation buy autonomy for a NEVER_FULLY_AUTONOMOUS class', async () => {
    // A distinct `version` — `installCharter` and the shared `beforeEach`
    // both write to `charter_versions`, keyed on (business, version), and
    // this override's own default version collides with the module-level
    // `bundle` every other test in this file uses.
    const dataExportCharter = buildCharter({
      version: 'data-export-test.1',
      forbidden: [
        {
          id: 'no_contract_signing',
          description: 'לעולם לא לחתום על חוזה או מסמך מחייב.',
          actionClasses: ['contract.sign'],
        },
        {
          id: 'no_payments_to_new_payees',
          description: 'לא לבצע תשלום לנמען שאינו ספק מאושר.',
          actionClasses: ['payment.make'],
        },
      ],
      autonomyBase: { 'data.export': 'auto' },
    });
    const dataExportBundle = compileCharter(dataExportCharter);
    await installCharter(dataExportCharter, { businessId: BUSINESS });

    const job = await createJob({
      charterVersion: dataExportBundle.charterVersion, provenance: 'boss', businessId: BUSINESS,
      title: 'ייצוא נתונים',
    });
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'data.export', recipients: ['dana@example.com'] },
      { businessId: BUSINESS },
    );

    const decision = await evaluateToolCall('data.export', { to: 'dana@example.com' }, {
      agent: 'ops.systems', bundle: dataExportBundle, provenance: 'boss', chainDepth: 0,
      counterpartyTags: [], rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId,
      useStandingAuthorization: true, now: NOON,
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
    const decision = await evaluateToolCall('mail.send', { ...REPLY, to: 'stranger@x.com' }, {
      agent: 'comms.email', bundle, provenance: 'boss',
      chainDepth: 0, counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId,
      now: NOON,
    });
    if (decision.outcome !== 'queue_approval') throw new Error('expected a queued approval');

    const { rows } = await getPool().query<{ summary: string; detail: string }>(
      'SELECT summary, detail FROM approval_requests WHERE job_id = $1', [job.jobId],
    );
    // Pinned to the actual risk explanation, not merely "non-empty" — a
    // review finding (fix round 1, minor): the original assertion here
    // would have passed with the fallback deleted entirely.
    expect(rows[0]?.summary).toBe(decision.reason);
    expect(rows[0]?.detail).toContain('mail.send');
    expect(rows[0]?.detail).toContain('email.reply');
  });

  // F4: a field counts as present only when it is a non-empty string after
  // trimming (the `refineActionClass` rule). `??` alone let a whitespace-only
  // headline and an empty detail through and rendered a blank card title.
  it('treats a whitespace-only headline and an empty detail as absent, and falls back', async () => {
    const job = await bossJob('הצעה ריקה');
    const decision = await evaluateToolCall('mail.send', { ...REPLY, to: 'stranger@x.com' }, {
      agent: 'comms.email', bundle, provenance: 'boss',
      chainDepth: 0, counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId,
      proposalText: { headline: '  ', detail: '' },
      now: NOON,
    });
    if (decision.outcome !== 'queue_approval') throw new Error('expected a queued approval');

    const { rows } = await getPool().query<{ summary: string; detail: string }>(
      'SELECT summary, detail FROM approval_requests WHERE job_id = $1', [job.jobId],
    );
    expect(rows[0]?.summary).toBe(decision.reason);
    expect(rows[0]?.detail).toContain('mail.send');
  });

  // F6: the only trace of *why* a standing-authorised call ran unattended
  // must not be indistinguishable from an ordinary routine allow.
  it('leaves an audit trail naming the standing authorisation as the reason it ran unattended', async () => {
    const job = await bossJob('להשיב לדנה');
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['dana@example.com'] },
      { businessId: BUSINESS },
    );

    const decision = await evaluateToolCall('mail.send', REPLY, {
      agent: 'comms.email', bundle, provenance: 'boss', chainDepth: 0, counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId,
      useStandingAuthorization: true, now: NOON,
    });
    expect(decision.outcome).toBe('allow');

    const entries = await queryAudit(
      { businessId: BUSINESS, jobId: job.jobId, kind: 'decision' },
      getPool(),
    );
    const standingEntry = entries.find((e) => e.reason.startsWith(`standing_authorization:${job.jobId}`));
    expect(standingEntry).toBeDefined();
  });
});
