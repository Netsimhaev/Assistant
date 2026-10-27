/**
 * The one widening of authority in the shadow-mode feature: a reply to an
 * incoming mail that the assistant has LEARNED to send (owner ruling H10).
 *
 * Every test here runs the real `evaluateToolCall` against `buildCharter()`
 * on a job whose provenance is `unknown_external`, with the dial at `learn`
 * and `email.reply` promoted to `auto_notify`, and a charter that knows the
 * sender's domain (so the risk band is `routine`). Under that setup the
 * provenance ceiling (`draft_only`) is the ONLY thing that would refuse the
 * call, so each negative test proves its refusal came from stage 8: the deny
 * code is `draft_only` AND no `intent_to_act` row was written. A negative
 * test that saw only "deny" would hold with its condition deleted, for the
 * boring reason that something later refused instead.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter, type CharterOverrides } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { loadAutonomyMode, setAutonomyMode } from '../governance/autonomy-mode.js';
import { trip } from '../governance/killswitch.js';
import { createJob } from '../orchestrator/jobs.js';
import { loadRampLevel, setRampLevel } from '../orchestrator/ramp.js';
import { DENY_CODES } from '../domain/policy.js';
import { evaluateToolCall, type GateContext } from './engine.js';
import { buildFacts } from './facts.js';
import { LEARNED_REPLY_EXEMPTION_MARKER, learnedReplyCovers } from './learned-reply.js';
import { linkReplyJob } from '../mail/inbox-store.js';
import { storedMail } from '../test/mailbox.js';

const BUSINESS = 'test-business';
// 09:00 UTC is noon in Asia/Jerusalem, outside the fixture's quiet hours;
// 19:30 UTC is 22:30 there — inside them.
const NOON = new Date('2026-08-18T09:00:00.000Z');
const NIGHT = new Date('2026-08-18T19:30:00.000Z');

/** The stored mail's From is `dana@client.example` (`incomingMail`). */
const SENDER = 'dana@client.example';
const REPLY = {
  to: [SENDER],
  subject: 'Re: מתי תגיע ההצעה?',
  body: 'שלום דנה, נחזור אלייך עד מחר.',
  inReplyTo: '<q-1@client.example>',
};

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

interface Setup {
  jobId: string;
  ctx: GateContext;
}

async function setup(
  overrides: CharterOverrides = {},
  options: { link?: 'this' | 'none' | 'other-business'; mode?: 'learn' | 'off' } = {},
): Promise<Setup> {
  const bundle = await installCharter(
    buildCharter({ knownCounterpartyEmailDomain: 'client.example', ...overrides }),
    { businessId: BUSINESS },
  );
  await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
  await setAutonomyMode(options.mode ?? 'learn', 'owner', { businessId: BUSINESS });
  const rampLevel = await loadRampLevel('email.reply', { businessId: BUSINESS });
  expect(rampLevel).toBe(options.mode === 'off' ? 'draft_only' : 'auto_notify');

  const job = await createJob({
    businessId: BUSINESS,
    charterVersion: bundle.charterVersion,
    provenance: 'unknown_external',
  });
  // A mail from the sender is ALWAYS stored, linked or not, so a mutation that
  // dropped the reply-job predicate would still find a row by From alone.
  const link = options.link ?? 'this';
  const mail = await storedMail(BUSINESS);
  if (link === 'this') await linkReplyJob(mail.mailId, job.jobId, { businessId: BUSINESS });
  if (link === 'other-business') {
    const foreign = await storedMail('other-business');
    await linkReplyJob(foreign.mailId, job.jobId, { businessId: 'other-business' });
  }
  return {
    jobId: job.jobId,
    ctx: {
      agent: 'comms.email',
      bundle,
      jobId: job.jobId,
      provenance: 'unknown_external',
      chainDepth: 1,
      counterpartyTags: [],
      rampLevel,
      businessId: BUSINESS,
      now: NOON,
    },
  };
}

/** `job_step_results.job_id` has a foreign key to `jobs` only, so a row under another business is expressible. */
async function stepResult(jobId: string, businessId: string, status: 'unknown' | 'completed'): Promise<void> {
  await getPool().query(
    `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, status)
     VALUES ($1, $2, 'h-earlier', 'reply', $3)`,
    [businessId, jobId, status],
  );
}

async function intentRows(): Promise<{ reason: string }[]> {
  const { rows } = await getPool().query<{ reason: string }>(
    `SELECT reason FROM audit_log WHERE business_id = $1 AND kind = 'intent_to_act' ORDER BY seq`,
    [BUSINESS],
  );
  return rows;
}

function expectDenied(decision: Awaited<ReturnType<typeof evaluateToolCall>>, code: string): void {
  expect(decision.outcome).toBe('deny');
  if (decision.outcome !== 'deny') throw new Error('unreachable');
  expect(decision.code).toBe(code);
}

/** Denied AT stage 8: `draft_only`, and no `intent_to_act` row (written only at stage 10). */
async function expectDeniedAtStage8(decision: Awaited<ReturnType<typeof evaluateToolCall>>): Promise<void> {
  expectDenied(decision, DENY_CODES.draftOnly);
  expect(await intentRows()).toHaveLength(0);
}

async function expectAllowed(decision: Awaited<ReturnType<typeof evaluateToolCall>>): Promise<void> {
  expect(decision.outcome).toBe('allow');
  expect(await intentRows()).toHaveLength(1);
}

describe('a learned reply to incoming mail passes the provenance ceiling', () => {
  it('allows the reply with no card, and marks the intent row', async () => {
    const s = await setup();
    const decision = await evaluateToolCall('mail.send', REPLY, s.ctx);

    await expectAllowed(decision);
    const [row] = await intentRows();
    expect(row?.reason.endsWith(` ${LEARNED_REPLY_EXEMPTION_MARKER}`)).toBe(true);
    const { rows } = await getPool().query('SELECT 1 FROM approval_requests WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });

  it('a call the exemption did not carry has no marker on its intent row', async () => {
    // A charter whose own provenance ceiling already allows the class: stage 8
    // passes WITHOUT the exemption (the job is not a mailbox reply job), and
    // the row must not claim it.
    const s = await setup({ provenanceCeiling: { unknown_external: 'auto_notify' } }, { link: 'none' });
    const decision = await evaluateToolCall('mail.send', REPLY, s.ctx);

    await expectAllowed(decision);
    const [row] = await intentRows();
    expect(row?.reason).not.toContain(LEARNED_REPLY_EXEMPTION_MARKER);
  });

  it('the recipient match is case-insensitive', async () => {
    const s = await setup();
    const decision = await evaluateToolCall('mail.send', { ...REPLY, to: ['Dana@Client.Example'] }, s.ctx);
    await expectAllowed(decision);
  });
});

describe('each condition, flipped alone, is refused at stage 8', () => {
  it('an approval on the context (no matching row) turns it off', async () => {
    const s = await setup();
    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, approval: { approvalId: 'no-such-approval', stepId: 'reply' },
    });
    await expectDeniedAtStage8(decision);
  });

  it('a job no mail names as its reply job is refused', async () => {
    const s = await setup({}, { link: 'none' });
    await expectDeniedAtStage8(await evaluateToolCall('mail.send', REPLY, s.ctx));
  });

  it('a mail row of another business naming this job does not count', async () => {
    const s = await setup({}, { link: 'other-business' });
    await expectDeniedAtStage8(await evaluateToolCall('mail.send', REPLY, s.ctx));
  });

  it('no job id at all is refused', async () => {
    const s = await setup();
    await expectDeniedAtStage8(await evaluateToolCall('mail.send', REPLY, { ...s.ctx, jobId: null }));
  });

  it('email.initiate (no inReplyTo) is refused', async () => {
    const s = await setup();
    const { inReplyTo: _thread, ...initiate } = REPLY;
    await expectDeniedAtStage8(await evaluateToolCall('mail.send', initiate, s.ctx));
  });

  it('a ramp below auto_notify is refused', async () => {
    // `approve_required`, not `draft_only`: the ramp itself must not be what
    // refuses, or the test would hold with the ramp condition deleted.
    const s = await setup();
    await expectDeniedAtStage8(
      await evaluateToolCall('mail.send', REPLY, { ...s.ctx, rampLevel: 'approve_required' }),
    );
  });

  it('a recipient other than the stored From is refused', async () => {
    const s = await setup();
    await expectDeniedAtStage8(
      await evaluateToolCall('mail.send', { ...REPLY, to: ['other@client.example'] }, s.ctx),
    );
  });

  it('a second recipient beside the From is refused', async () => {
    const s = await setup();
    await expectDeniedAtStage8(
      await evaluateToolCall('mail.send', { ...REPLY, to: [SENDER, 'other@client.example'] }, s.ctx),
    );
  });

  it('a declared amount is refused, even zero', async () => {
    const s = await setup();
    await expectDeniedAtStage8(await evaluateToolCall('mail.send', { ...REPLY, amountMinor: 0 }, s.ctx));
  });

  it('an attachments key is refused, even empty', async () => {
    const s = await setup();
    await expectDeniedAtStage8(await evaluateToolCall('mail.send', { ...REPLY, attachments: [] }, s.ctx));
  });

  it('a job with an unknown step result (a send that may have gone) is refused', async () => {
    const s = await setup();
    await stepResult(s.jobId, BUSINESS, 'unknown');
    await expectDeniedAtStage8(await evaluateToolCall('mail.send', REPLY, s.ctx));
  });

  it('an unknown step result filed under another business does not count', async () => {
    const s = await setup();
    await stepResult(s.jobId, 'other-business', 'unknown');
    await expectAllowed(await evaluateToolCall('mail.send', REPLY, s.ctx));
  });

  it('a completed step result does not count as unknown', async () => {
    const s = await setup();
    await stepResult(s.jobId, BUSINESS, 'completed');
    await expectAllowed(await evaluateToolCall('mail.send', REPLY, s.ctx));
  });

  it('no learned reply when the dial is off', async () => {
    // The stored ramp row still says `auto_notify`; the dial clamps it.
    const s = await setup({}, { mode: 'off' });
    expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('off');
    const facts = buildFacts('mail.send', REPLY, s.ctx);
    expect(await learnedReplyCovers(facts, REPLY, s.ctx)).toBe(false);
    await expectDeniedAtStage8(await evaluateToolCall('mail.send', REPLY, s.ctx));
  });
});

describe('the exemption drops the provenance ceiling and nothing else', () => {
  it('the ramp still applies: a charter base of auto still yields auto_notify', async () => {
    // Observable only here: when the exemption holds the ramp is `auto_notify`,
    // so dropping it too would show as `auto` — the base the charter signed.
    const s = await setup({ autonomyBase: { 'email.reply': 'auto' } });
    const decision = await evaluateToolCall('mail.send', REPLY, s.ctx);
    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') throw new Error('unreachable');
    expect(decision.effectiveAutonomy).toBe('auto_notify');
  });

  it('a sender the charter does not know still asks (sensitive band)', async () => {
    // Past stage 8 on the exemption (the intent row is written, marked), and
    // then queued: the risk band is untouched.
    const s = await setup({ knownCounterpartyEmailDomain: 'someone-else.example' });
    const decision = await evaluateToolCall('mail.send', REPLY, s.ctx);
    expect(decision.outcome).toBe('queue_approval');
    const rows = await intentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason.endsWith(` ${LEARNED_REPLY_EXEMPTION_MARKER}`)).toBe(true);
  });

  it('the charter base draft_only for email.reply still denies at stage 8', async () => {
    const s = await setup({ autonomyBase: { 'email.reply': 'draft_only' } });
    await expectDeniedAtStage8(await evaluateToolCall('mail.send', REPLY, s.ctx));
  });

  it('an envelope autonomyCeiling of draft_only still denies at stage 8', async () => {
    const s = await setup();
    await expectDeniedAtStage8(
      await evaluateToolCall('mail.send', REPLY, { ...s.ctx, autonomyCeiling: 'draft_only' }),
    );
  });

  it('the kill switch still denies', async () => {
    const s = await setup();
    await trip('outbound', 'p_boss', 'בדיקה', { businessId: BUSINESS });
    expectDenied(await evaluateToolCall('mail.send', REPLY, s.ctx), DENY_CODES.killSwitch);
  });

  it('quiet hours still defer', async () => {
    const s = await setup();
    expectDenied(await evaluateToolCall('mail.send', REPLY, { ...s.ctx, now: NIGHT }), DENY_CODES.quietHours);
  });

  it('doNotContact still denies', async () => {
    const s = await setup({ doNotContactEmailDomain: 'client.example' });
    expectDenied(await evaluateToolCall('mail.send', REPLY, s.ctx), DENY_CODES.doNotContact);
  });
});
