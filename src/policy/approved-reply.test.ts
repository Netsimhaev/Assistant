/**
 * The one relaxation of stage 8: a reply the owner already approved.
 *
 * Every test here runs the real `evaluateToolCall` against `buildCharter()`
 * with the "freedom level" dial at `off` — the state of every new install —
 * on a job whose provenance is `unknown_external`. Under that setup the ramp
 * is clamped to `draft_only` (`loadRampLevel`) and the provenance ceiling is
 * `draft_only` too, so without the exemption every call below denies at
 * stage 8. That is the baseline each negative test asserts: the deny CODE is
 * `draft_only` (not some earlier stage) and the approval is still unspent.
 * A negative test that merely saw "deny" would hold without the exemption's
 * condition it claims to test.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, type Queryable } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter, type CharterOverrides } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { decide, enqueueApproval } from '../governance/approvals.js';
import { loadAutonomyMode } from '../governance/autonomy-mode.js';
import { trip } from '../governance/killswitch.js';
import { createJob } from '../orchestrator/jobs.js';
import { loadRampLevel } from '../orchestrator/ramp.js';
import { DENY_CODES, type PolicyBundle } from '../domain/policy.js';
import { evaluateToolCall, type GateContext } from './engine.js';
import { buildFacts } from './facts.js';
import { assessRisk } from './risk.js';

const BUSINESS = 'test-business';
// 09:00 UTC is noon in Asia/Jerusalem, outside the fixture's 20:00-07:00
// quiet hours. 19:30 UTC is 22:30 there — inside them.
const NOON = new Date('2026-08-18T09:00:00.000Z');
const NIGHT = new Date('2026-08-18T19:30:00.000Z');
const STEP_ID = 's1';

/** `inReplyTo` makes `mail.send` an `email.reply` (`refineActionClass`). */
const REPLY = {
  to: 'sender@outside.example',
  subject: 'Re: הצעת מחיר',
  body: 'תודה, קיבלנו ונחזור אלייך מחר.',
  inReplyTo: '<msg-1@outside.example>',
};

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

interface Setup {
  bundle: PolicyBundle;
  jobId: string;
  ctx: GateContext;
}

async function setup(overrides: CharterOverrides = {}): Promise<Setup> {
  const charter = buildCharter(overrides);
  const bundle = await installCharter(charter, { businessId: BUSINESS });
  // The dial is not written: a fresh install reads `off`. Asserted, because
  // the whole file is about what happens under it.
  expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('off');
  const rampLevel = await loadRampLevel('email.reply', { businessId: BUSINESS });
  expect(rampLevel).toBe('draft_only');

  const job = await createJob({
    businessId: BUSINESS,
    charterVersion: bundle.charterVersion,
    provenance: 'unknown_external',
  });
  return {
    bundle,
    jobId: job.jobId,
    ctx: {
      agent: 'comms.email',
      bundle,
      jobId: job.jobId,
      provenance: 'unknown_external',
      chainDepth: 0,
      counterpartyTags: [],
      rampLevel,
      businessId: BUSINESS,
      now: NOON,
    },
  };
}

/**
 * Raise and approve a card the way the conductor does: directly, not through
 * the gate (which would deny it at stage 8 and raise nothing).
 */
async function approvedCard(
  s: Setup,
  options: { toolName?: string; input?: Record<string, unknown>; jobId?: string } = {},
): Promise<string> {
  const toolName = options.toolName ?? 'mail.send';
  const input = options.input ?? REPLY;
  const facts = buildFacts(toolName, input, {
    provenance: 'unknown_external',
    chainDepth: 0,
    counterpartyTags: [],
  });
  const risk = await assessRisk(facts, s.bundle);
  const approvalId = await enqueueApproval(
    {
      jobId: options.jobId ?? s.jobId,
      facts,
      risk,
      proposedInput: input,
      summary: 'מענה לשולח',
    },
    { businessId: BUSINESS },
  );
  await decide(approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' },
    { businessId: BUSINESS });
  return approvalId;
}

async function consumedAt(approvalId: string): Promise<Date | null> {
  const { rows } = await getPool().query<{ consumed_at: Date | null }>(
    'SELECT consumed_at FROM approval_requests WHERE approval_id = $1',
    [approvalId],
  );
  const row = rows[0];
  if (!row) throw new Error(`no approval ${approvalId}`);
  return row.consumed_at;
}

function expectDenied(decision: Awaited<ReturnType<typeof evaluateToolCall>>, code: string): void {
  expect(decision.outcome).toBe('deny');
  if (decision.outcome !== 'deny') throw new Error('unreachable');
  expect(decision.code).toBe(code);
}

async function intentRows(jobId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log WHERE job_id = $1 AND kind = 'intent_to_act'`,
    [jobId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Denied AT stage 8, not later. The distinction carries the weight here:
 * stage 10's lost-claim fallback also answers `draft_only`, so a predicate
 * dropped from `approvedReplyCovers` would still end in a `draft_only` deny —
 * one that passed stage 8 on the relaxed ceiling, wrote `intent_to_act` at
 * stage 10, and was caught only by the claim. Without the audit-row check
 * every negative test below would stay green with its condition removed.
 */
async function expectDeniedAtStage8(
  decision: Awaited<ReturnType<typeof evaluateToolCall>>,
  jobId: string,
): Promise<void> {
  expectDenied(decision, DENY_CODES.draftOnly);
  expect(await intentRows(jobId)).toBe(0);
}

describe('an owner-approved reply passes the ramp and provenance ceilings', () => {
  it('approved reply under mode off is allowed and consumes the approval', async () => {
    const s = await setup();
    const approvalId = await approvedCard(s);

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, approval: { approvalId, stepId: STEP_ID },
    });

    expect(decision.outcome).toBe('allow');
    expect(await consumedAt(approvalId)).not.toBeNull();
  });

  it('same call without ctx.approval is denied draft_only', async () => {
    const s = await setup();
    const approvalId = await approvedCard(s);

    const decision = await evaluateToolCall('mail.send', REPLY, s.ctx);

    await expectDeniedAtStage8(decision, s.jobId);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('approval for a different input hash is denied draft_only', async () => {
    const s = await setup();
    const approvalId = await approvedCard(s);

    const decision = await evaluateToolCall(
      'mail.send',
      { ...REPLY, body: 'נוסח אחר שהבעלים מעולם לא ראה' },
      { ...s.ctx, approval: { approvalId, stepId: STEP_ID } },
    );

    await expectDeniedAtStage8(decision, s.jobId);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('approval for whatsapp.send tool is denied draft_only', async () => {
    const s = await setup();
    // Same bytes, approved for the WhatsApp send tool (`wa.send_message` is
    // its name in `TOOL_ACTION_CLASS`). `inputHash` is `canonicalHash` of the
    // input alone, so the two hashes are IDENTICAL — `proposed_tool` is the
    // only thing that can refuse this, which is exactly the binding under test.
    const approvalId = await approvedCard(s, { toolName: 'wa.send_message' });

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, approval: { approvalId, stepId: STEP_ID },
    });

    await expectDeniedAtStage8(decision, s.jobId);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('approval of another job is denied draft_only', async () => {
    const s = await setup();
    const other = await createJob({
      businessId: BUSINESS,
      charterVersion: s.bundle.charterVersion,
      provenance: 'unknown_external',
    });
    const approvalId = await approvedCard(s, { jobId: other.jobId });

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, approval: { approvalId, stepId: STEP_ID },
    });

    await expectDeniedAtStage8(decision, s.jobId);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('an approval row of another business is denied draft_only', async () => {
    const s = await setup();
    // Same job id, same tool, same bytes, decided — but filed under another
    // business. `approval_requests.job_id` has no foreign key, so nothing but
    // the business predicate keeps this row out.
    const facts = buildFacts('mail.send', REPLY, {
      provenance: 'unknown_external', chainDepth: 0, counterpartyTags: [],
    });
    const approvalId = await enqueueApproval(
      { jobId: s.jobId, facts, risk: await assessRisk(facts, s.bundle),
        proposedInput: REPLY, summary: 'מענה לשולח' },
      { businessId: 'other-business' },
    );
    await decide(approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' },
      { businessId: 'other-business' });

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, approval: { approvalId, stepId: STEP_ID },
    });

    await expectDeniedAtStage8(decision, s.jobId);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('expired approved approval is denied draft_only', async () => {
    const s = await setup();
    const approvalId = await approvedCard(s);
    // `expireOverdue` never touches a decided row, so an approved card past
    // its fuse keeps `state = approved` — the shape that must not be spendable.
    await getPool().query(
      `UPDATE approval_requests SET expires_at = now() - interval '1 minute'
        WHERE approval_id = $1`,
      [approvalId],
    );

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, approval: { approvalId, stepId: STEP_ID },
    });

    await expectDeniedAtStage8(decision, s.jobId);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('a card the owner has not decided yet is denied draft_only', async () => {
    const s = await setup();
    const facts = buildFacts('mail.send', REPLY, {
      provenance: 'unknown_external', chainDepth: 0, counterpartyTags: [],
    });
    const approvalId = await enqueueApproval(
      { jobId: s.jobId, facts, risk: await assessRisk(facts, s.bundle),
        proposedInput: REPLY, summary: 'מענה לשולח' },
      { businessId: BUSINESS },
    );
    // `input_hash_at_decision` is written by `decide`; set it here so the
    // ONLY thing this card lacks is the decision itself.
    await getPool().query(
      'UPDATE approval_requests SET input_hash_at_decision = input_hash WHERE approval_id = $1',
      [approvalId],
    );

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, approval: { approvalId, stepId: STEP_ID },
    });

    await expectDeniedAtStage8(decision, s.jobId);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('an approval already spent is denied draft_only', async () => {
    const s = await setup();
    const approvalId = await approvedCard(s);
    await getPool().query(
      `UPDATE approval_requests SET consumed_at = now(), consumed_by_step = 'earlier'
        WHERE approval_id = $1`,
      [approvalId],
    );

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, approval: { approvalId, stepId: STEP_ID },
    });

    await expectDeniedAtStage8(decision, s.jobId);
  });

  it('email.initiate (no inReplyTo) with an approval is denied', async () => {
    const s = await setup();
    const { inReplyTo: _thread, ...initiate } = REPLY;
    const approvalId = await approvedCard(s, { input: initiate });

    const decision = await evaluateToolCall('mail.send', initiate, {
      ...s.ctx, approval: { approvalId, stepId: STEP_ID },
    });

    await expectDeniedAtStage8(decision, s.jobId);
    expect(await consumedAt(approvalId)).toBeNull();
  });
});

describe('the exemption skips nothing but the two ceilings it names', () => {
  it('kill switch still denies an approved reply', async () => {
    const s = await setup();
    const approvalId = await approvedCard(s);
    await trip('outbound', 'p_boss', 'בדיקה', { businessId: BUSINESS });

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, approval: { approvalId, stepId: STEP_ID },
    });

    expectDenied(decision, DENY_CODES.killSwitch);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('quiet hours still defer an approved reply', async () => {
    const s = await setup();
    const approvalId = await approvedCard(s);

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, now: NIGHT, approval: { approvalId, stepId: STEP_ID },
    });

    expectDenied(decision, DENY_CODES.quietHours);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('doNotContact still denies an approved reply', async () => {
    const s = await setup({ doNotContactEmailDomain: 'outside.example' });
    const approvalId = await approvedCard(s);

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, approval: { approvalId, stepId: STEP_ID },
    });

    expectDenied(decision, DENY_CODES.doNotContact);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('autonomyBase forbidden for email.reply still denies', async () => {
    const s = await setup({ autonomyBase: { 'email.reply': 'forbidden' } });
    const approvalId = await approvedCard(s);

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, approval: { approvalId, stepId: STEP_ID },
    });

    expectDenied(decision, DENY_CODES.autonomyForbidden);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('autonomyBase draft_only for email.reply still denies', async () => {
    // The signed charter's own cap for the class is not a ramp or provenance
    // ceiling, so the exemption must not reach it.
    const s = await setup({ autonomyBase: { 'email.reply': 'draft_only' } });
    const approvalId = await approvedCard(s);

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, approval: { approvalId, stepId: STEP_ID },
    });

    await expectDeniedAtStage8(decision, s.jobId);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('an envelope autonomyCeiling of draft_only still denies', async () => {
    const s = await setup();
    const approvalId = await approvedCard(s);

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, autonomyCeiling: 'draft_only', approval: { approvalId, stepId: STEP_ID },
    });

    await expectDeniedAtStage8(decision, s.jobId);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  it('an approval that loses the claim race does not run on the relaxed ceiling', async () => {
    // A recipient the charter knows, so the risk band is `routine`: if the
    // gate fell through to its normal path with the exemption still applied,
    // `needsApproval` would be false and the reply would be ALLOWED without
    // anything having been spent — a second send of an approval another
    // runner already used.
    const s = await setup({ knownCounterpartyEmailDomain: 'outside.example' });
    const approvalId = await approvedCard(s);

    // Simulate the competing runner: the moment the gate tries to claim, the
    // row is already spent. Every other statement passes through untouched.
    const pool = getPool();
    const racing: Queryable = {
      query: (async (text: string, params?: unknown[]) => {
        if (/^\s*UPDATE approval_requests\s+SET consumed_at/.test(text)) {
          await pool.query(
            `UPDATE approval_requests SET consumed_at = now(), consumed_by_step = 'other'
              WHERE approval_id = $1`,
            [approvalId],
          );
        }
        return pool.query(text, params);
      }) as Queryable['query'],
    };

    const decision = await evaluateToolCall('mail.send', REPLY, {
      ...s.ctx, db: racing, approval: { approvalId, stepId: STEP_ID },
    });

    // Denied by the fallback in stage 10, not by stage 8: the one
    // `intent_to_act` row proves the exemption DID apply and the call got
    // past stage 8 on it — otherwise this test would hold with the fallback
    // deleted, for the boring reason that stage 8 refused first.
    expectDenied(decision, DENY_CODES.draftOnly);
    expect(await intentRows(s.jobId)).toBe(1);
  });
});
