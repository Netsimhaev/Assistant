/**
 * `executeStep` and the owner-ordered WhatsApp (task 13):
 *
 *  - a `wa.send_message` with a future `sendAt` parks the job until that time,
 *    before the gate is consulted and without touching the adapter;
 *  - a proactive WhatsApp (`whatsapp.initiate`, no `conversationId`) runs ONLY
 *    as a confirmed boss command (ruling R13a). On any other job it is refused
 *    before the gate — earlier than stage 8 — so it can never reach a card
 *    whose approval would send it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { saveInstruction } from '../governance/instructions.js';
import { confirmChoice, createConfirmation } from '../governance/instruction-confirmations.js';
import { decide, enqueueApproval } from '../governance/approvals.js';
import { assessRisk } from '../policy/risk.js';
import { buildFacts } from '../policy/facts.js';
import { Plan } from '../domain/plan.js';
import type { TrustLevel } from '../domain/trust.js';
import type { AutonomyLevel } from '../domain/trust.js';
import { createJob, loadJob, transition } from './jobs.js';
import { bindPlanToJob, planHashOf } from './plan-store.js';
import { SCHEDULED_SEND_REASON, WA_INITIATE_NOT_COMMAND, executeStep } from './execute.js';

const BUSINESS = 'test-business';
// 09:00 UTC is noon in Asia/Jerusalem, outside the fixture's quiet hours.
const NOON = new Date('2026-08-18T09:00:00.000Z');
const STEP_ID = 's1';

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

interface JobOptions {
  provenance?: TrustLevel;
  instruction?: boolean;
  confirm?: boolean;
  input: Record<string, unknown>;
}

async function jobInExecute(o: JobOptions) {
  const bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
  const job = await withBusiness(BUSINESS, (db) => createJob(db, {
    charterVersion: bundle.charterVersion,
    provenance: o.provenance ?? 'boss',
  }));
  if (o.instruction === true) {
    await withBusiness(BUSINESS, (db) => saveInstruction(db, { jobId: job.jobId, text: 'תשלחי לדנה +972541234567', textOrigin: 'typed' }));
  }
  const plan = Plan.parse({
    goal: 'וואטסאפ לדנה',
    steps: [{ id: STEP_ID, agent: 'comms.whatsapp', intent: 'send', toolName: 'wa.send_message', input: o.input }],
  });
  const planHash = planHashOf(plan);
  await withBusiness(BUSINESS, (db) => bindPlanToJob(db, job.jobId, plan));
  if (o.confirm === true) {
    await withBusiness(BUSINESS, (db) => createConfirmation(db, {
      jobId: job.jobId,
      options: [{ label: 'לשלוח', planHash, plan, contactSource: null }],
      presentedText: 'לשלוח?',
      channel: 'dashboard',
    }));
    expect(await withBusiness(BUSINESS, (db) => confirmChoice(db, job.jobId, planHash, 'p_boss'))).toBe(true);
  }
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await withBusiness(BUSINESS, (db) => transition(db, job.jobId, { to, actor: 'orchestrator', reason: 'setup' }));
  }
  const loaded = await withBusiness(BUSINESS, (db) => loadJob(db, job.jobId));
  if (loaded === null) throw new Error('job vanished');
  return { job: loaded, bundle, planHash };
}

async function run(
  setup: Awaited<ReturnType<typeof jobInExecute>>,
  input: Record<string, unknown>,
  calls: { n: number },
  extra: { rampLevel?: AutonomyLevel; approvalId?: string; now?: Date } = {},
) {
  return withBusiness(BUSINESS, (db) => executeStep(db, {
    job: setup.job,
    stepId: STEP_ID,
    agent: 'comms.whatsapp',
    bundle: setup.bundle,
    toolName: 'wa.send_message',
    toolInput: input,
    perform: async () => {
      calls.n += 1;
      return { output: { messageId: 'WA-1' }, externalId: 'WA-1', performed: true };
    },
    counterpartyTags: [],
    rampLevel: extra.rampLevel ?? 'draft_only',
    planHash: setup.planHash,
    now: extra.now ?? NOON,
    ...(extra.approvalId !== undefined ? { approvalId: extra.approvalId } : {}),
  }));
}

async function intents(jobId: string): Promise<number> {
  const { rows } = await testDb().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log WHERE job_id = $1 AND kind = 'intent_to_act'`,
    [jobId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function phaseOf(jobId: string): Promise<string | undefined> {
  return (await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.phase;
}

describe('a scheduled WhatsApp', () => {
  it('executeStep parks a future sendAt without calling the adapter', async () => {
    const sendAt = new Date(NOON.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const input = { to: '+972541234567', body: 'תזכורת', sendAt };
    const s = await jobInExecute({ instruction: true, confirm: true, input });
    const calls = { n: 0 };

    const outcome = await run(s, input, calls);

    expect(outcome).toEqual({ status: 'deferred', code: 'scheduled_send', wakeAt: sendAt });
    expect(calls.n).toBe(0);
    // Before the gate: no intent recorded, nothing claimed.
    expect(await intents(s.job.jobId)).toBe(0);
    const { rows } = await testDb().query<{ wake_at: Date | null; phase: string }>(
      'SELECT wake_at, phase FROM jobs WHERE job_id = $1',
      [s.job.jobId],
    );
    expect(rows[0]?.phase).toBe('followup');
    expect(rows[0]?.wake_at?.toISOString()).toBe(sendAt);
    const step = await testDb().query<{ reason: string }>(
      `SELECT reason FROM job_steps WHERE job_id = $1 AND to_phase = 'followup'`,
      [s.job.jobId],
    );
    expect(step.rows.map((r) => r.reason)).toEqual([SCHEDULED_SEND_REASON]);
  });

  it('a sendAt that has come runs now, under the confirmed command', async () => {
    const sendAt = new Date(NOON.getTime() - 60 * 1000).toISOString();
    const input = { to: '+972541234567', body: 'תזכורת', sendAt };
    const s = await jobInExecute({ instruction: true, confirm: true, input });
    const calls = { n: 0 };

    const outcome = await run(s, input, calls);

    expect(outcome.status).toBe('done');
    expect(calls.n).toBe(1);
  });
});

describe('a proactive WhatsApp runs only as a confirmed boss command (R13a)', () => {
  const INPUT = { to: '+972541234567', body: 'שלום דנה' };

  it('the confirmed instruction path sends, under dial off', async () => {
    const s = await jobInExecute({ instruction: true, confirm: true, input: INPUT });
    const calls = { n: 0 };
    const outcome = await run(s, INPUT, calls);
    expect(outcome.status).toBe('done');
    expect(calls.n).toBe(1);
    expect(await intents(s.job.jobId)).toBe(1);
  });

  it('a boss job with no boss_instructions row is refused before the gate', async () => {
    const s = await jobInExecute({ instruction: false, input: INPUT });
    const calls = { n: 0 };
    // `auto` ramp: without the guard the gate would pass stage 8 and queue an
    // ordinary approval at stage 10 — the guard refuses before any of that.
    const outcome = await run(s, INPUT, calls, { rampLevel: 'auto' });
    expect(outcome).toMatchObject({ status: 'refused', code: WA_INITIATE_NOT_COMMAND });
    expect(calls.n).toBe(0);
    expect(await intents(s.job.jobId)).toBe(0);
    expect(await phaseOf(s.job.jobId)).toBe('failed');
    const { rows } = await testDb().query('SELECT 1 FROM approval_requests WHERE job_id = $1', [s.job.jobId]);
    expect(rows).toEqual([]);
  });

  it('an instruction job whose confirmation is not confirmed is refused before the gate', async () => {
    const s = await jobInExecute({ instruction: true, confirm: false, input: INPUT });
    const calls = { n: 0 };
    const outcome = await run(s, INPUT, calls, { rampLevel: 'auto' });
    expect(outcome).toMatchObject({ status: 'refused', code: WA_INITIATE_NOT_COMMAND });
    expect(calls.n).toBe(0);
    expect(await intents(s.job.jobId)).toBe(0);
  });

  it('an unknown_external job is refused before the gate', async () => {
    const s = await jobInExecute({ provenance: 'unknown_external', input: INPUT });
    const calls = { n: 0 };
    const outcome = await run(s, INPUT, calls, { rampLevel: 'auto' });
    expect(outcome).toMatchObject({ status: 'refused', code: WA_INITIATE_NOT_COMMAND });
    expect(calls.n).toBe(0);
    expect(await intents(s.job.jobId)).toBe(0);
  });

  it('an APPROVED card on a non-instruction job still cannot send', async () => {
    const s = await jobInExecute({ instruction: false, input: INPUT });
    const facts = buildFacts('wa.send_message', INPUT, {
      provenance: 'boss',
      chainDepth: 0,
      counterpartyTags: [],
    });
    const risk = await assessRisk(facts, s.bundle);
    const approvalId = await withBusiness(BUSINESS, (db) => enqueueApproval(db, {
      jobId: s.job.jobId,
      facts,
      risk,
      proposedInput: INPUT,
      summary: 'וואטסאפ לדנה',
    }));
    await withBusiness(BUSINESS, (db) => decide(db, approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' }));

    const calls = { n: 0 };
    const outcome = await run(s, INPUT, calls, { rampLevel: 'auto', approvalId });
    expect(outcome).toMatchObject({ status: 'refused', code: WA_INITIATE_NOT_COMMAND });
    expect(calls.n).toBe(0);
    expect(await intents(s.job.jobId)).toBe(0);
    // The approval was not spent.
    const { rows } = await testDb().query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM approval_requests WHERE approval_id = $1',
      [approvalId],
    );
    expect(rows[0]?.consumed_at).toBeNull();
  });

  it('a reply (with conversationId) is not touched by the guard', async () => {
    // The gate then judges it as `whatsapp.reply`: under dial off the ramp is
    // `draft_only`, so stage 8 refuses — proving it reached the gate.
    const input = { ...INPUT, conversationId: 'conv-1' };
    const s = await jobInExecute({ instruction: false, input });
    const calls = { n: 0 };
    const outcome = await run(s, input, calls);
    expect(outcome).toMatchObject({ status: 'refused', code: 'draft_only:persist_as_draft' });
    expect(calls.n).toBe(0);
  });
});
