import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { evaluateToolCall } from '../policy/engine.js';
import { inQuietHours, redactPayload } from '../policy/redact.js';
import { canTransition } from '../domain/job.js';
import type { PolicyBundle } from '../domain/policy.js';
import { createJob, dueJobs, jobHistory, loadJob, transition } from './jobs.js';
import { executeStep } from './execute.js';

const BUSINESS = 'test-business';

/** 03:00 Asia/Jerusalem — inside the fixture's 22:00–07:00 quiet window. */
const NIGHT = new Date('2026-08-18T00:00:00.000Z');
/** 12:00 Asia/Jerusalem — outside it. */
const NOON = new Date('2026-08-18T09:00:00.000Z');

async function install(overrides = {}): Promise<PolicyBundle> {
  return installCharter(buildCharter(overrides), { businessId: BUSINESS });
}

async function jobInExecute(bundle: PolicyBundle) {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'מבחן',
  });
  await transition(job.jobId, {
    to: 'understand',
    actor: 'orchestrator',
    reason: 'התקבל',
    businessId: BUSINESS,
  });
  await transition(job.jobId, {
    to: 'plan',
    actor: 'orchestrator',
    reason: 'הובן',
    businessId: BUSINESS,
  });
  return transition(job.jobId, {
    to: 'execute',
    actor: 'orchestrator',
    reason: 'תוכנן',
    businessId: BUSINESS,
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('the job state machine', () => {
  it('rejects a transition the table does not allow', async () => {
    const bundle = await install();
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });

    // intake → closed skips every step that makes a job auditable.
    expect(canTransition('intake', 'closed')).toBe(false);
    await expect(
      transition(job.jobId, {
        to: 'closed',
        actor: 'orchestrator',
        reason: 'קיצור דרך',
        businessId: BUSINESS,
      }),
    ).rejects.toThrow(/illegal job transition/);

    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('intake');
  });

  it('reconstructs the whole run from the database alone', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);

    const history = await jobHistory(job.jobId);
    expect(history.map((step) => `${step.from}→${step.to}`)).toEqual([
      'intake→understand',
      'understand→plan',
      'plan→execute',
    ]);
    // No phase advanced without leaving a row: the history is the audit story.
    expect(history.every((step) => step.reason.length > 0)).toBe(true);
  });

  it('a terminal phase closes the job and leads nowhere', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);

    const failed = await transition(job.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: 'נכשל',
      businessId: BUSINESS,
    });
    expect(failed.closedAt).not.toBeNull();
    expect(canTransition('failed', 'execute')).toBe(false);
  });

  it('a sleeping job surfaces once its wake time passes', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const wakeAt = new Date(NOON.getTime() + 60 * 60 * 1000);

    await transition(job.jobId, {
      to: 'followup',
      actor: 'orchestrator',
      reason: 'ממתין',
      wakeAt,
      businessId: BUSINESS,
    });

    expect(await dueJobs({ businessId: BUSINESS, now: NOON })).toEqual([]);
    const due = await dueJobs({
      businessId: BUSINESS,
      now: new Date(wakeAt.getTime() + 1000),
    });
    expect(due.map((j) => j.jobId)).toEqual([job.jobId]);
  });
});

describe('quiet hours', () => {
  it('knows a window that wraps midnight', () => {
    const quiet = { from: '22:00', to: '07:00', timezone: 'Asia/Jerusalem' };
    expect(inQuietHours(quiet, NIGHT)).toBe(true);
    expect(inQuietHours(quiet, NOON)).toBe(false);
  });

  it('stops an outbound send at night — the promise the owner signed', async () => {
    const bundle = await install();

    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812' },
      {
        agent: 'comms.email',
        bundle,
        provenance: 'boss',
        chainDepth: 0,
        counterpartyTags: [],
        rampLevel: 'auto',
        businessId: BUSINESS,
        now: NIGHT,
      },
    );

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('quiet_hours');
  });

  it('does not stop work that stays inside the instance', async () => {
    const bundle = await install();

    // Reading and writing our own records at 03:00 is fine. The promise is
    // about a message arriving on someone's phone.
    const decision = await evaluateToolCall(
      'crm.read',
      { entityId: 'c_812' },
      {
        agent: 'ops.systems',
        bundle,
        provenance: 'boss',
        chainDepth: 0,
        counterpartyTags: [],
        rampLevel: 'auto',
        businessId: BUSINESS,
        now: NIGHT,
      },
    );

    expect(decision.outcome).toBe('allow');
  });

  it('reschedules the step past the window instead of failing it', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    let performed = false;

    const outcome = await executeStep({
      job,
      stepId: 'step-1',
      agent: 'comms.email',
      bundle,
      counterpartyTags: [],
      rampLevel: 'auto' as const,
      toolName: 'mail.send',
      toolInput: { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812' },
      perform: async () => {
        performed = true;
        return null;
      },
      now: NIGHT,
    });

    expect(outcome.status).toBe('deferred');
    expect(performed).toBe(false);

    const after = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(after?.phase).toBe('followup');
    // Woken at the end of the window, not failed and not left for a human.
    expect(after?.wakeAt).not.toBeNull();
    expect(new Date(after!.wakeAt!).getTime()).toBeGreaterThan(NIGHT.getTime());
  });
});

describe('redaction', () => {
  it('strips the charter patterns from an outbound payload', async () => {
    const bundle = await install();

    // The fixture redacts a bare 9-digit number — an Israeli ID.
    const decision = await evaluateToolCall(
      'mail.send',
      {
        to: 'a@b.com',
        inReplyTo: 'm1',
        counterpartyId: 'c_812',
        body: 'ת"ז 123456789 מצורפת',
      },
      {
        agent: 'comms.email',
        bundle,
        provenance: 'boss',
        chainDepth: 0,
        counterpartyTags: [],
        rampLevel: 'auto',
        businessId: BUSINESS,
        now: NOON,
      },
    );

    expect(decision.outcome).toBe('allow');
    if (decision.outcome !== 'allow') throw new Error('unreachable');
    const redacted = decision.redactedInput as { body: string };
    expect(redacted.body).not.toContain('123456789');
    expect(redacted.body).toContain('[הוסר]');
  });

  it('leaves keys alone and reaches into nested values', async () => {
    const bundle = await install();
    const out = redactPayload(
      { meta: { ref: '987654321' }, items: ['111222333'], '123456789': 'key' },
      bundle,
    ) as Record<string, unknown>;

    expect((out['meta'] as { ref: string }).ref).toBe('[הוסר]');
    expect((out['items'] as string[])[0]).toBe('[הוסר]');
    // Renaming a field changes the payload's meaning — a different and far more
    // dangerous operation than blanking a value.
    expect(Object.keys(out)).toContain('123456789');
  });
});

describe('spend accounting', () => {
  it('writes committed spend to the ledger, which nothing did before', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);

    const outcome = await executeStep({
      job,
      stepId: 'step-1',
      agent: 'comms.email',
      bundle,
      counterpartyTags: [],
      rampLevel: 'auto' as const,
      toolName: 'quote.issue',
      toolInput: { counterpartyId: 'c_812', amountMinor: 120_000, inReplyTo: 'm1' },
      perform: async () => ({ ok: true }),
      now: NOON,
    });

    // quote.issue is approve_required in the fixture, so this queues rather
    // than spending — the ledger must stay empty.
    expect(outcome.status).toBe('awaiting_approval');
    const { rows } = await getPool().query('SELECT * FROM spend_ledger WHERE business_id = $1', [
      BUSINESS,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('records spend once, however many times the step is retried', async () => {
    const bundle = await install({ autonomyBase: { 'accounting.write': 'auto' } });
    const job = await jobInExecute(bundle);

    const step = {
      job,
      stepId: 'step-1',
      agent: 'ops.systems' as const,
      bundle,
      counterpartyTags: [],
      rampLevel: 'auto' as const,
      toolName: 'accounting.write',
      toolInput: { entityId: 'c_812', amountMinor: 50_000 },
      perform: async () => ({ ok: true }),
      now: NOON,
    };

    const first = await executeStep(step);
    expect(first.status).toBe('done');
    if (first.status !== 'done') throw new Error('unreachable');
    expect(first.spendRecorded).toBe(true);

    // A retry after an uncertain timeout must not count the same money twice.
    await transition(job.jobId, {
      to: 'execute',
      actor: 'orchestrator',
      reason: 'ניסיון חוזר',
      businessId: BUSINESS,
    });
    const second = await executeStep(step);
    expect(second.status).toBe('done');
    if (second.status !== 'done') throw new Error('unreachable');
    expect(second.spendRecorded).toBe(false);

    const { rows } = await getPool().query(
      'SELECT amount_minor FROM spend_ledger WHERE business_id = $1',
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
  });

  it('the daily ceiling now actually holds', async () => {
    // Previously unenforceable in practice: with no caller for recordSpend the
    // ledger was always empty, so the sum was always zero and the ceiling the
    // owner signed never bound anything.
    // Amounts kept well under half the ceiling on purpose. The money dimension
    // scores a step as a fraction of the daily ceiling, so a single step near
    // that ceiling is *correctly* sensitive and would queue for approval before
    // the budget check ever ran. Two modest steps that only exceed in sum are
    // what actually exercises the ledger.
    const bundle = await install({
      dailyCeilingMinor: 100_000,
      autonomyBase: { 'accounting.write': 'auto' },
    });
    const job = await jobInExecute(bundle);

    const first = await executeStep({
      job,
      stepId: 'step-1',
      agent: 'ops.systems',
      bundle,
      counterpartyTags: [],
      rampLevel: 'auto' as const,
      toolName: 'accounting.write',
      toolInput: { entityId: 'c_812', amountMinor: 45_000 },
      perform: async () => null,
      now: NOON,
    });
    expect(first.status).toBe('done');

    await transition(job.jobId, {
      to: 'execute',
      actor: 'orchestrator',
      reason: 'צעד שני',
      businessId: BUSINESS,
    });

    const second = await executeStep({
      job,
      stepId: 'step-2',
      agent: 'ops.systems',
      bundle,
      counterpartyTags: [],
      rampLevel: 'auto' as const,
      toolName: 'accounting.write',
      toolInput: { entityId: 'c_812', amountMinor: 60_000 },
      perform: async () => null,
      now: NOON,
    });

    expect(second.status).toBe('refused');
    if (second.status !== 'refused') throw new Error('unreachable');
    expect(second.code).toBe('budget_exceeded:daily');
  });

  it('never performs a side effect the gate refused', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    let performed = false;

    const outcome = await executeStep({
      job,
      stepId: 'step-1',
      agent: 'ops.systems',
      bundle,
      counterpartyTags: [],
      rampLevel: 'auto' as const,
      toolName: 'data.export',
      toolInput: { counterpartyId: 'c_812', dataClasses: ['customer_pii'] },
      perform: async () => {
        performed = true;
        return null;
      },
      now: NOON,
    });

    expect(outcome.status).toBe('refused');
    expect(performed).toBe(false);
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('failed');
  });

  it('hands the step the redacted payload, not the one it proposed', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    let sent: unknown = null;

    await executeStep({
      job,
      stepId: 'step-1',
      agent: 'comms.email',
      bundle,
      counterpartyTags: [],
      rampLevel: 'auto' as const,
      toolName: 'mail.send',
      toolInput: { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812', body: 'מספר 123456789' },
      perform: async (redacted) => {
        sent = redacted;
        return null;
      },
      now: NOON,
    });

    // The step cannot accidentally send what it proposed — it never sees it.
    expect((sent as { body: string }).body).toContain('[הוסר]');
  });
});
