/**
 * The boss-command exemption: a step of a command the owner confirmed runs
 * under any dial, past stages 5–9 and every approval requirement, once.
 *
 * Every test runs the real `evaluateToolCall` against `buildCharter()` with
 * the "freedom level" dial at `off` — the state of every new install — on a
 * `boss` job. Under that setup the ramp is clamped to `draft_only`, so
 * without the exemption every `mail.send` below denies at stage 8. That is
 * the baseline each negative test asserts: the code is `draft_only`, no
 * `intent_to_act` row was written (so the call never got past stage 8), and
 * nothing was claimed. A negative that merely saw "not allowed" would hold
 * with the condition it claims to test deleted.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter, type CharterOverrides } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { loadAutonomyMode } from '../governance/autonomy-mode.js';
import { saveInstruction } from '../governance/instructions.js';
import { confirmChoice, createConfirmation } from '../governance/instruction-confirmations.js';
import { trip } from '../governance/killswitch.js';
import { createJob } from '../orchestrator/jobs.js';
import { bindPlanToJob, planHashOf } from '../orchestrator/plan-store.js';
import { loadRampLevel } from '../orchestrator/ramp.js';
import { Plan } from '../domain/plan.js';
import type { TrustLevel } from '../domain/trust.js';
import type { AgentId } from '../domain/audit.js';
import { DENY_CODES, type PolicyBundle } from '../domain/policy.js';
import { evaluateToolCall, type GateContext } from './engine.js';
import { redactPayload } from './redact.js';
import { CONFIRMED_COMMAND_EXEMPTION_MARKER } from './confirmed-command.js';

const BUSINESS = 'test-business';
const OTHER = 'other-business';
// 09:00 UTC is noon in Asia/Jerusalem, outside the fixture's 20:00–07:00
// quiet hours; 19:30 UTC is 22:30 there, inside them.
const NOON = new Date('2026-08-18T09:00:00.000Z');
const NIGHT = new Date('2026-08-18T19:30:00.000Z');
const STEP_ID = 's1';

/**
 * A cold mail (`email.initiate`, no `inReplyTo`) to an address the charter
 * does not know. The nine-digit run is there so the redaction of the allowed
 * payload is observable.
 */
const SEND: Record<string, unknown> = {
  to: 'dana@outside.example',
  subject: 'הצעה',
  body: 'שלום דנה, מספר התיק 123456789.',
};

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

interface SetupOptions {
  charter?: CharterOverrides;
  jobBusiness?: string;
  provenance?: TrustLevel;
  instruction?: boolean;
  instructionBusiness?: string;
  planBusiness?: string;
  confirmationBusiness?: string;
  confirm?: boolean;
  toolName?: string;
  stepAgent?: AgentId;
  input?: Record<string, unknown>;
}

interface Setup {
  bundle: PolicyBundle;
  jobId: string;
  planHash: string;
  ctx: GateContext;
}

function planOf(
  toolName: string,
  input: Record<string, unknown>,
  goal = 'לשלוח לדנה',
  agent: AgentId = 'comms.email',
): Plan {
  return Plan.parse({
    goal,
    steps: [
      { id: STEP_ID, agent, intent: 'send', toolName, input },
    ],
  });
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const bundle = await installCharter(buildCharter(options.charter ?? {}), { businessId: BUSINESS });
  expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('off');
  const rampLevel = await loadRampLevel('email.initiate', { businessId: BUSINESS });
  expect(rampLevel).toBe('draft_only');
  if (options.jobBusiness !== undefined && options.jobBusiness !== BUSINESS) {
    await installCharter(buildCharter(options.charter ?? {}), { businessId: options.jobBusiness });
  }

  const job = await createJob({
    businessId: options.jobBusiness ?? BUSINESS,
    charterVersion: bundle.charterVersion,
    provenance: options.provenance ?? 'boss',
  });
  if (options.instruction !== false) {
    await saveInstruction(
      { jobId: job.jobId, text: 'תשלחי לדנה את ההצעה', textOrigin: 'typed' },
      { businessId: options.instructionBusiness ?? BUSINESS },
    );
  }
  const plan = planOf(options.toolName ?? 'mail.send', options.input ?? SEND, undefined, options.stepAgent);
  const planHash = planHashOf(plan);
  await bindPlanToJob(job.jobId, plan, { businessId: options.planBusiness ?? BUSINESS });

  const confirmationBusiness = options.confirmationBusiness ?? BUSINESS;
  await createConfirmation(
    {
      jobId: job.jobId,
      options: [{ label: 'לשלוח', planHash, plan, contactSource: null }],
      presentedText: 'לשלוח לדנה?',
      channel: 'dashboard',
    },
    { businessId: confirmationBusiness },
  );
  if (options.confirm !== false) {
    expect(await confirmChoice(job.jobId, planHash, 'p_boss', { businessId: confirmationBusiness }))
      .toBe(true);
  }

  return {
    bundle,
    jobId: job.jobId,
    planHash,
    ctx: {
      agent: 'comms.email',
      bundle,
      jobId: job.jobId,
      stepId: STEP_ID,
      provenance: 'boss',
      chainDepth: 0,
      counterpartyTags: [],
      rampLevel,
      businessId: BUSINESS,
      now: NOON,
    },
  };
}

type Decision = Awaited<ReturnType<typeof evaluateToolCall>>;

function expectDenied(decision: Decision, code: string): void {
  expect(decision.outcome).toBe('deny');
  if (decision.outcome !== 'deny') throw new Error('unreachable');
  expect(decision.code).toBe(code);
}

async function auditRows(jobId: string, kind: string): Promise<string[]> {
  const { rows } = await getPool().query<{ reason: string }>(
    'SELECT reason FROM audit_log WHERE job_id = $1 AND kind = $2 ORDER BY seq',
    [jobId, kind],
  );
  return rows.map((row) => row.reason);
}

async function claims(jobId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM confirmed_step_claims WHERE job_id = $1',
    [jobId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** The exemption carried the call: allowed at `auto`, redacted, claimed once. */
async function expectExempt(decision: Decision, s: Setup, input: unknown = SEND): Promise<void> {
  expect(decision).toEqual({
    outcome: 'allow',
    effectiveAutonomy: 'auto',
    redactedInput: redactPayload(input, s.bundle),
  });
  expect(await claims(s.jobId)).toBe(1);
}

/**
 * The NORMAL path ran and stopped at stage 8 on the dial: `draft_only`, no
 * `intent_to_act` (so the call never passed stage 8), nothing claimed.
 */
async function expectNormalPathDraftOnly(decision: Decision, jobId: string): Promise<void> {
  expectDenied(decision, DENY_CODES.draftOnly);
  expect(await auditRows(jobId, 'intent_to_act')).toEqual([]);
  expect(await claims(jobId)).toBe(0);
}

describe('a confirmed boss command runs under any dial', () => {
  it('executes under dial off', async () => {
    const s = await setup();
    const decision = await evaluateToolCall('mail.send', SEND, s.ctx);
    await expectExempt(decision, s);
    // Redaction is the normal allow's, not skipped: the nine digits are gone.
    if (decision.outcome !== 'allow') throw new Error('unreachable');
    expect(JSON.stringify(decision.redactedInput)).not.toContain('123456789');
  });

  it('records intent_to_act ending in the marker, and claims the step', async () => {
    const s = await setup();
    await evaluateToolCall('mail.send', SEND, s.ctx);

    const intents = await auditRows(s.jobId, 'intent_to_act');
    expect(intents).toHaveLength(1);
    expect(intents[0]?.endsWith(` ${CONFIRMED_COMMAND_EXEMPTION_MARKER}`)).toBe(true);
    const { rows } = await getPool().query<{ step_id: string; plan_hash: string; business_id: string }>(
      'SELECT step_id, plan_hash, business_id FROM confirmed_step_claims WHERE job_id = $1',
      [s.jobId],
    );
    expect(rows).toEqual([{ step_id: STEP_ID, plan_hash: s.planHash, business_id: BUSINESS }]);
  });
});

describe('each condition, flipped alone, falls to the normal path', () => {
  it('a confirmation still pending is not a confirmation', async () => {
    const s = await setup({ confirm: false });
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
  });

  it('a job whose stored provenance is not boss is not exempt, whatever ctx claims', async () => {
    const s = await setup({ provenance: 'staff' });
    // ctx.provenance still says `boss` — the caller's claim, which must not count.
    expect(s.ctx.provenance).toBe('boss');
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
  });

  it('a job with no boss_instructions row is not exempt', async () => {
    const s = await setup({ instruction: false });
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
  });

  it('a job of another business is not exempt', async () => {
    // The job row is the other business's; its instruction, plan and
    // confirmation are filed under this one (none of them has a foreign key
    // to the job's business). Only the job's own business predicate keeps it
    // out.
    const s = await setup({ jobBusiness: OTHER });
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
  });

  it('a row that is not confirmed is not a confirmation, even carrying a chosen hash', async () => {
    // The CHECK constraint makes "chosen hash" imply "confirmed" today, so
    // the gate's own `state = 'confirmed'` could not be tested without it
    // lifted. The gate must not lean on a constraint alone: lifted here, a
    // cancelled row keeping its hash must still fall to the normal path.
    const s = await setup();
    const pool = getPool();
    await pool.query(
      'ALTER TABLE instruction_confirmations DROP CONSTRAINT instruction_confirmations_chosen_iff_confirmed',
    );
    try {
      await pool.query(
        `UPDATE instruction_confirmations SET state = 'cancelled' WHERE job_id = $1`,
        [s.jobId],
      );
      await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
    } finally {
      await pool.query('DELETE FROM instruction_confirmations WHERE job_id = $1', [s.jobId]);
      await pool.query(
        `ALTER TABLE instruction_confirmations ADD CONSTRAINT instruction_confirmations_chosen_iff_confirmed
           CHECK ((state = 'confirmed') = (chosen_plan_hash IS NOT NULL))`,
      );
    }
  });

  it('a boss_instructions row of another business does not count', async () => {
    const s = await setup({ instructionBusiness: OTHER });
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
  });

  it('a confirmation of another business does not count', async () => {
    const s = await setup({ confirmationBusiness: OTHER });
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
  });

  it('a plan bound under another business does not count', async () => {
    const s = await setup({ planBusiness: OTHER });
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
  });

  it('a confirmation decided 23 hours ago still carries the step', async () => {
    const s = await setup();
    await getPool().query(
      `UPDATE instruction_confirmations SET decided_at = now() - interval '23 hours' WHERE job_id = $1`,
      [s.jobId],
    );
    await expectExempt(await evaluateToolCall('mail.send', SEND, s.ctx), s);
  });

  it('a confirmation older than 24 hours falls to the normal path', async () => {
    const s = await setup();
    await getPool().query(
      `UPDATE instruction_confirmations SET decided_at = now() - interval '25 hours' WHERE job_id = $1`,
      [s.jobId],
    );
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
  });

  it('a chosen plan that is not the bound plan is not exempt', async () => {
    const s = await setup();
    // Same step, same tool, same bytes — only the plan around it differs, so
    // the bound hash is no longer the one the owner chose.
    const other = planOf('mail.send', SEND, 'מטרה אחרת');
    const binding = await bindPlanToJob(s.jobId, other, { businessId: BUSINESS });
    expect(binding.status).toBe('replaced');
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
  });

  it('a step id the plan does not have is not exempt', async () => {
    const s = await setup();
    await expectNormalPathDraftOnly(
      await evaluateToolCall('mail.send', SEND, { ...s.ctx, stepId: 's2' }),
      s.jobId,
    );
  });

  it('a step planned for another agent is not exempt', async () => {
    // Same id, tool and bytes; the bound step names `comms.whatsapp`, while
    // `comms.email` is the agent making the call.
    const s = await setup({ stepAgent: 'comms.whatsapp' });
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
  });

  it('a step whose tool is another tool is not exempt', async () => {
    // The plan's s1 is `wa.send_message` with the very same input; the call
    // judged is `mail.send`. `inputHash` is of the input alone, so the tool
    // is the only thing that can refuse it.
    const s = await setup({ toolName: 'wa.send_message' });
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
  });

  it('bytes other than the confirmed ones are not exempt', async () => {
    const s = await setup();
    await expectNormalPathDraftOnly(
      await evaluateToolCall('mail.send', { ...SEND, body: 'נוסח שהבוס לא ראה' }, s.ctx),
      s.jobId,
    );
  });

  it('a job with an unknown step result is not exempt', async () => {
    const s = await setup();
    await getPool().query(
      `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, status)
       VALUES ($1, $2, $3, 's0', 'unknown')`,
      [BUSINESS, s.jobId, s.planHash],
    );
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, s.ctx), s.jobId);
  });

  it('an unknown step result of another business does not count', async () => {
    const s = await setup();
    await getPool().query(
      `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, status)
       VALUES ($1, $2, $3, 's0', 'unknown')`,
      [OTHER, s.jobId, s.planHash],
    );
    await expectExempt(await evaluateToolCall('mail.send', SEND, s.ctx), s);
  });

  it('with ctx.approval set, the normal path runs', async () => {
    const s = await setup();
    await expectNormalPathDraftOnly(
      await evaluateToolCall('mail.send', SEND, {
        ...s.ctx, approval: { approvalId: 'A-none', stepId: STEP_ID },
      }),
      s.jobId,
    );
  });

  it('an SDK-style call without stepId is never exempt', async () => {
    const s = await setup();
    const { stepId: _stepId, ...sdkCtx } = s.ctx;
    await expectNormalPathDraftOnly(await evaluateToolCall('mail.send', SEND, sdkCtx), s.jobId);
  });

  it('a call without a job is never exempt', async () => {
    const s = await setup();
    const decision = await evaluateToolCall('mail.send', SEND, { ...s.ctx, jobId: null });
    expectDenied(decision, DENY_CODES.draftOnly);
    expect(await claims(s.jobId)).toBe(0);
  });
});

describe('the command overrides the brakes on the assistant', () => {
  it('a charter forbidden rule: refused without the confirmation, run with it', async () => {
    const charter: CharterOverrides = {
      forbidden: [
        { id: 'no_cold_mail', description: 'לא לשלוח מייל יזום.', actionClasses: ['email.initiate'] },
      ],
    };
    const without = await setup({ charter, confirm: false });
    expectDenied(await evaluateToolCall('mail.send', SEND, without.ctx), 'forbidden:no_cold_mail');

    await resetDatabase();
    const s = await setup({ charter });
    await expectExempt(await evaluateToolCall('mail.send', SEND, s.ctx), s);
  });

  it('a doNotContact recipient: refused without the confirmation, run with it', async () => {
    const charter: CharterOverrides = { doNotContactEmailDomain: 'outside.example' };
    const without = await setup({ charter, confirm: false });
    expectDenied(await evaluateToolCall('mail.send', SEND, without.ctx), DENY_CODES.doNotContact);

    await resetDatabase();
    const s = await setup({ charter });
    await expectExempt(await evaluateToolCall('mail.send', SEND, s.ctx), s);
  });

  it('quiet hours: refused without the confirmation, run with it', async () => {
    const without = await setup({ confirm: false });
    expectDenied(
      await evaluateToolCall('mail.send', SEND, { ...without.ctx, now: NIGHT }),
      DENY_CODES.quietHours,
    );

    await resetDatabase();
    const s = await setup();
    await expectExempt(await evaluateToolCall('mail.send', SEND, { ...s.ctx, now: NIGHT }), s);
  });

  it('a budget ceiling: refused without the confirmation, run with it', async () => {
    // The ramp opened in BOTH runs, so the unconfirmed one gets past stage 8
    // (charter base `approve_required`) and reaches the budget.
    const charter: CharterOverrides = { singleActionCeilingMinor: 1_000 };
    const input = { ...SEND, amountMinor: 50_000 };
    const without = await setup({ charter, confirm: false, input });
    expectDenied(
      await evaluateToolCall('mail.send', input, { ...without.ctx, rampLevel: 'auto' }),
      'budget_exceeded:single_action',
    );

    await resetDatabase();
    const s = await setup({ charter, input });
    await expectExempt(
      await evaluateToolCall('mail.send', input, { ...s.ctx, rampLevel: 'auto' }),
      s,
      input,
    );
  });
});

describe('what the command never overrides', () => {
  it('a stale charter still denies, before the exemption is consulted', async () => {
    const s = await setup();
    const stale = { ...s.ctx, bundle: { ...s.bundle, charterVersion: '2026-01-01.old' } };
    expectDenied(await evaluateToolCall('mail.send', SEND, stale), DENY_CODES.stalePolicy);
    expect(await claims(s.jobId)).toBe(0);
  });

  it('a confirmed step whose tool is outside the agent allowlist is refused', async () => {
    // `wa.send_message` is a known, classified tool that `comms.email` does
    // not hold. The bound step names exactly this agent, tool and bytes, so
    // every condition of the exemption holds — only stage 3 refuses it.
    const s = await setup({ toolName: 'wa.send_message' });
    expectDenied(await evaluateToolCall('wa.send_message', SEND, s.ctx), DENY_CODES.notAllowlisted);
    expect(await claims(s.jobId)).toBe(0);
  });

  it('a confirmed step naming an unowned tool is refused', async () => {
    // `contract.sign` is in UNOWNED_TOOLS: no agent's allowlist holds it.
    const input = { documentId: 'D-1' };
    const s = await setup({ toolName: 'contract.sign', input });
    expectDenied(await evaluateToolCall('contract.sign', input, s.ctx), DENY_CODES.notAllowlisted);
    expect(await claims(s.jobId)).toBe(0);
  });

  it('the kill switch still denies', async () => {
    const s = await setup();
    await trip('outbound', 'p_boss', 'בדיקה', { businessId: BUSINESS });
    expectDenied(await evaluateToolCall('mail.send', SEND, s.ctx), DENY_CODES.killSwitch);
    expect(await claims(s.jobId)).toBe(0);
  });

  it('amount_unreadable still denies, records the denial, and claims nothing', async () => {
    const input = { to: 'dana@outside.example', subject: 'הצעת מחיר', body: 'מצורפת' };
    const s = await setup({ toolName: 'quote.issue', input });
    expectDenied(await evaluateToolCall('quote.issue', input, s.ctx), DENY_CODES.amountUnreadable);
    expect(await auditRows(s.jobId, 'policy_denial')).toEqual([
      `${DENY_CODES.amountUnreadable}: quote.issue`,
    ]);
    expect(await auditRows(s.jobId, 'intent_to_act')).toEqual([]);
    expect(await claims(s.jobId)).toBe(0);
  });

  it('the same quote with its amount readable runs', async () => {
    const input = { to: 'dana@outside.example', subject: 'הצעת מחיר', body: 'מצורפת', amountMinor: 120_000 };
    const s = await setup({ toolName: 'quote.issue', input });
    await expectExempt(await evaluateToolCall('quote.issue', input, s.ctx), s, input);
  });

  it('a claimed step never runs twice', async () => {
    const s = await setup();
    await expectExempt(await evaluateToolCall('mail.send', SEND, s.ctx), s);

    const second = await evaluateToolCall('mail.send', SEND, s.ctx);
    expectDenied(second, 'confirmed_step_already_claimed');
    if (second.outcome !== 'deny') throw new Error('unreachable');
    expect(second.reason).toBe('הצעד הזה כבר נתבע לביצוע — לא אבצע אותו שוב בלי לשאול.');
    // Both attempts wrote a marker row (intent before claim), and the loser
    // also wrote a denial citing its own marker row by seq. Executions are the
    // marker rows no such denial cites: exactly one.
    const { rows } = await getPool().query<{ seq: string; kind: string; reason: string }>(
      `SELECT seq::text AS seq, kind, reason FROM audit_log
        WHERE job_id = $1 AND kind IN ('intent_to_act', 'policy_denial') ORDER BY seq`,
      [s.jobId],
    );
    const markers = rows.filter(
      (r) => r.kind === 'intent_to_act' && r.reason.endsWith(` ${CONFIRMED_COMMAND_EXEMPTION_MARKER}`),
    );
    const denials = rows.filter((r) => r.kind === 'policy_denial');
    expect(markers).toHaveLength(2);
    expect(denials.map((r) => r.reason)).toEqual([
      `confirmed_step_already_claimed (intent seq ${markers[1]?.seq})`,
    ]);
    const cited = new Set(denials.map((r) => /intent seq (\d+)/.exec(r.reason)?.[1]));
    const executions = markers.filter((m) => !cited.has(m.seq));
    expect(executions.map((m) => m.seq)).toEqual([markers[0]?.seq]);
    expect(await claims(s.jobId)).toBe(1);
  });
});
