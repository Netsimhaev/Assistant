/**
 * Re-asking after a confirmed boss command went wrong (spec §4.6, §10.3,
 * §10.7). The setup is the shape `confirmed-command-run.test.ts` uses — the
 * unmodified charter, the dial `off`, a live mail binding, a `boss` job born
 * at the door, bound, confirmed and moved to `execute` — and the failures
 * are produced by the real engine wherever the engine can produce them: a
 * real `adapter_timeout` through `runPlanForJob`, a real lost claim through
 * `runDueJobs`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness, withBusinessTransaction } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { saveInstruction } from '../governance/instructions.js';
import { confirmChoice, createConfirmation, loadConfirmation } from '../governance/instruction-confirmations.js';
import { Plan, planProblems } from '../domain/plan.js';
import { recordInbound, settleMessage } from '../whatsapp/store.js';
import type { CharterConnection } from '../domain/connection.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import type { AdapterResult, ExternalAdapter } from './adapters/types.js';
import { upsertBinding } from './bindings.js';
import { envCredentials } from './credentials.js';
import { REASK_PREFIX, alreadyDoneLine } from './command-echo.js';
import { REASK_REASON, reaskFailedCommands, residualPlan } from './command-reask.js';
import { WHATSAPP_MESSAGE_MAX_CHARS, WHATSAPP_QUESTION_TOO_LONG } from './command-confirm.js';
import { createJob, linkWhatsAppMessage, loadJob, transition } from './jobs.js';
import { bindPlanToJob, loadStoredPlan, planHashOf, recordStepCompletion } from './plan-store.js';
import { runDueJobs } from './run-due.js';
import { runPlanForJob } from './run-plan.js';
import type { Runtime } from './runtime.js';
import { schedulerPass } from './scheduler.js';

const BUSINESS = 'test-business';
const OTHER = 'other-business';
const PREFIX = 'TEST_CRED_';
const NOON = new Date('2026-08-18T09:00:00.000Z');
const INSTRUCTION = 'תשלחי ל-stranger@nowhere.example את ההצעה';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const PLAN: Plan = Plan.parse({
  goal: 'לשלוח לזר הצעה',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the offer',
      toolName: 'mail.send',
      input: { to: 'stranger@nowhere.example', subject: 'הצעה', body: 'שלום, מצורפת הצעה.' },
      expectedActionClass: 'email.initiate',
    },
  ],
});
const PLAN_HASH = planHashOf(PLAN);

/** The reviewer's probe: two sends, the second depending on the first. */
const TWO_STEP: Plan = Plan.parse({
  goal: 'לשלוח שתי הודעות',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the first',
      toolName: 'mail.send',
      input: { to: 'first@nowhere.example', subject: 'ראשון', body: 'אחת' },
      expectedActionClass: 'email.initiate',
    },
    {
      id: 's2',
      agent: 'comms.email',
      intent: 'send the second',
      toolName: 'mail.send',
      input: { to: 'second@nowhere.example', subject: 'שני', body: 'שתיים' },
      dependsOn: ['s1'],
      expectedActionClass: 'email.initiate',
    },
  ],
});

/** Sends the first message, then never answers again. */
function firstThenStall(sent: MailMessage[]): AdapterRegistry {
  return new AdapterRegistry([
    createMailAdapter({
      system: 'office-mail',
      transport: {
        async send(message) {
          if (sent.length > 0) return new Promise<never>(() => {});
          sent.push(message);
          return { messageId: `MSG-${sent.length}` };
        },
      },
    }),
  ]);
}
const CREDENTIALS = envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX);

function sendingRuntime(sent: MailMessage[]): Runtime {
  return {
    registry: new AdapterRegistry([
      createMailAdapter({
        system: 'office-mail',
        transport: {
          async send(message) {
            sent.push(message);
            return { messageId: `MSG-${sent.length}` };
          },
        },
      }),
    ]),
    credentials: CREDENTIALS,
    warnings: [],
  };
}

function stallingMailAdapter(): ExternalAdapter {
  return {
    system: 'office-mail',
    channel: 'api',
    serves: ['mail.send'],
    async execute(): Promise<AdapterResult> {
      return new Promise<AdapterResult>(() => {
        /* never settles */
      });
    },
  };
}

function fakeMessenger(): BossMessenger & { sent: Array<{ text: string; jobId: string | null }> } {
  const sent: Array<{ text: string; jobId: string | null }> = [];
  return {
    channel: 'whatsapp',
    sent,
    async send(input) {
      sent.push(input);
      return { ok: true };
    },
  };
}

let charterCounter = 0;

async function seedCommand(o: {
  businessId?: string;
  channel?: 'whatsapp' | 'dashboard';
  plan?: Plan;
} = {}): Promise<{ jobId: string; bundle: PolicyBundle }> {
  const businessId = o.businessId ?? BUSINESS;
  const plan = o.plan ?? PLAN;
  const planHash = planHashOf(plan);
  charterCounter += 1;
  const bundle = await withBusiness(businessId, (bdb) => installCharter(
    bdb,
    buildCharter({ version: `2026-08-15.reask-${charterCounter}`, connections: [MAIL_CONNECTION] })
  ));
  const job = await withBusiness(businessId, (db) => createJob(db, {
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    title: 'הצעה לזר',
  }));
  await withBusiness(businessId, (bdb) => saveInstruction(bdb, { jobId: job.jobId, text: INSTRUCTION, textOrigin: 'typed' }));
  for (const to of ['understand', 'plan'] as const) {
    await withBusiness(businessId, (db) => transition(db, job.jobId, { to, actor: 'orchestrator', reason: 'setup' }));
  }
  await withBusiness(businessId, (db) => bindPlanToJob(db, job.jobId, plan));
  await withBusiness(businessId, (bdb) => createConfirmation(bdb, {
      jobId: job.jobId,
      options: [{ label: 'לשלוח', planHash, plan, contactSource: null }],
      presentedText: 'לשלוח?',
      channel: o.channel ?? 'whatsapp',
    }));
  expect(await withBusiness(businessId, (bdb) => confirmChoice(bdb, job.jobId, planHash, 'p_boss'))).toBe(true);
  await withBusiness(businessId, (db) => transition(db, job.jobId, { to: 'execute', actor: 'orchestrator', reason: 'setup' }));
  await withBusiness(businessId, (db) => upsertBinding(db, {
      system: 'office-mail',
      status: 'live',
      endpoint: null,
      credentialRef: 'OFFICE_MAIL',
      provider: null,
      lastOkAt: null,
      lastError: null,
    }, { by: 'test' }));
  return { jobId: job.jobId, bundle };
}

/** A real `adapter_timeout`: the exemption lets the step out, the far end never answers. */
async function timeOut(jobId: string, bundle: PolicyBundle, businessId = BUSINESS): Promise<void> {
  const job = await withBusiness(businessId, (db) => loadJob(db, jobId));
  if (job === null) throw new Error('no job');
  const outcome = await withBusiness(job.businessId, (db) => runPlanForJob(db, {
    job,
    bundle,
    plan: PLAN,
    registry: new AdapterRegistry([stallingMailAdapter()]),
    credentials: CREDENTIALS,
    counterpartyTags: [],
    rampLevel: 'draft_only',
    now: NOON,
    adapterTimeoutMs: 25,
  }));
  expect(outcome.status).toBe('halted');
  expect((await withBusiness(businessId, (db) => loadJob(db, jobId)))?.phase).toBe('followup');
  const { rows } = await testDb().query<{ status: string }>(
    'SELECT status FROM job_step_results WHERE job_id = $1',
    [jobId],
  );
  expect(rows.map((r) => r.status)).toEqual(['unknown']);
}

async function reasksOf(oldJobId: string): Promise<Array<{ job_id: string; business_id: string }>> {
  const { rows } = await testDb().query<{ job_id: string; business_id: string }>(
    'SELECT job_id, business_id FROM instruction_confirmations WHERE reask_of = $1',
    [oldJobId],
  );
  return rows;
}

/** The door's WhatsApp bookkeeping: an inbound message recorded, linked to the job, settled. */
async function linkToWhatsApp(jobId: string): Promise<string> {
  const message = await withBusiness(BUSINESS, (db) => recordInbound(
    db,
    {
      providerMessageId: `PM-${jobId}`,
      senderNumber: '+972500000000',
      senderKind: 'principal',
      body: INSTRUCTION,
      mediaKind: null,
      providerTimestamp: new Date().toISOString(),
    },
  ));
  if (message === null) throw new Error('setup: duplicate inbound message id');
  await withBusiness(BUSINESS, (db) => linkWhatsAppMessage(db, jobId, message.id));
  await withBusiness(BUSINESS, (db) => settleMessage(db, message.id, 'handled', {}));
  return message.id;
}

async function whatsappLink(jobId: string): Promise<string | null> {
  const { rows } = await testDb().query<{ whatsapp_message_id: string | null }>(
    'SELECT whatsapp_message_id FROM jobs WHERE job_id = $1',
    [jobId],
  );
  return rows[0]?.whatsapp_message_id ?? null;
}

async function backdateDecision(jobId: string): Promise<void> {
  await testDb().query(
    `UPDATE instruction_confirmations SET decided_at = now() - interval '25 hours' WHERE job_id = $1`,
    [jobId],
  );
}

async function jobCount(): Promise<number> {
  const { rows } = await testDb().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM jobs WHERE business_id = $1',
    [BUSINESS],
  );
  return rows[0]?.n ?? 0;
}

async function lastReason(jobId: string): Promise<string | undefined> {
  const { rows } = await testDb().query<{ reason: string }>(
    'SELECT reason FROM job_steps WHERE job_id = $1 ORDER BY at DESC, id DESC LIMIT 1',
    [jobId],
  );
  return rows[0]?.reason;
}

describe('reaskFailedCommands', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('after a timeout: one new job, bound to the same plan, asked once with the prefix', async () => {
    const { jobId, bundle } = await seedCommand();
    await timeOut(jobId, bundle);

    const messenger = fakeMessenger();
    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger }));
    expect(result.errored).toEqual([]);
    expect(result.reasked).toHaveLength(1);
    expect(result.sent).toBe(1);
    const newJobId = result.reasked[0]?.newJobId;
    if (newJobId === undefined) throw new Error('no new job');
    expect(result.reasked[0]).toEqual({ oldJobId: jobId, newJobId, uncertain: true });

    // The old job is failed, for the re-ask.
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.phase).toBe('failed');
    expect(await lastReason(jobId)).toBe(REASK_REASON);

    // The new job: boss, same title, parked in plan, the same plan bound.
    const fresh = await withBusiness(BUSINESS, (db) => loadJob(db, newJobId));
    expect(fresh?.phase).toBe('plan');
    expect(fresh?.provenance).toBe('boss');
    expect(fresh?.title).toBe('הצעה לזר');
    expect((await withBusiness(BUSINESS, (db) => loadStoredPlan(db, newJobId)))?.planHash).toBe(PLAN_HASH);
    const { rows: instructions } = await testDb().query<{ text: string; text_origin: string }>(
      'SELECT text, text_origin FROM boss_instructions WHERE job_id = $1',
      [newJobId],
    );
    expect(instructions).toEqual([{ text: INSTRUCTION, text_origin: 'typed' }]);

    const confirmation = await withBusiness(BUSINESS, (bdb) => loadConfirmation(bdb, newJobId));
    expect(confirmation?.state).toBe('pending');
    expect(confirmation?.reaskOf).toBe(jobId);
    expect(confirmation?.channel).toBe('whatsapp');
    expect(confirmation?.options.map((o) => o.planHash)).toEqual([PLAN_HASH]);
    expect(confirmation?.presentedText.startsWith(REASK_PREFIX)).toBe(true);
    expect(messenger.sent).toEqual([{ text: confirmation?.presentedText, jobId: newJobId }]);
    // Sent, so delivered: a WhatsApp "כן" may now answer it.
    expect(confirmation?.deliveredAt).toBeInstanceOf(Date);

    // A second pass asks nothing more.
    const again = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger }));
    expect(again).toEqual({ reasked: [], sent: 0, notConnected: 0, sendFailed: 0, tooLong: 0, lockedOut: [], errored: [] });
    expect(await jobCount()).toBe(2);
    expect(messenger.sent).toHaveLength(1);
    expect(await reasksOf(jobId)).toHaveLength(1);
  });

  it('two passes at the same moment still re-ask once', async () => {
    const { jobId, bundle } = await seedCommand();
    await timeOut(jobId, bundle);

    const messenger = fakeMessenger();
    const [a, b] = await Promise.all([
      withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger })),
      withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger })),
    ]);
    expect(a.reasked.length + b.reasked.length).toBe(1);
    expect([...a.errored, ...b.errored]).toEqual([]);
    expect(await jobCount()).toBe(2);
    expect(await reasksOf(jobId)).toHaveLength(1);
    expect(messenger.sent).toHaveLength(1);
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM jobs WHERE business_id = $1 AND phase = 'plan'`,
      [BUSINESS],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('the schema refuses a second re-ask of the same old job', async () => {
    const { jobId, bundle } = await seedCommand();
    await timeOut(jobId, bundle);
    await withBusiness(BUSINESS, (db) => reaskFailedCommands(db));

    // A second job naming the same old one, written behind the sweep's back.
    const other = await withBusiness(BUSINESS, (db) => createJob(db, { charterVersion: bundle.charterVersion, provenance: 'boss' }));
    await expect(
      withBusiness(BUSINESS, (bdb) => createConfirmation(bdb, {
          jobId: other.jobId,
          options: [{ label: 'לשלוח', planHash: PLAN_HASH, plan: PLAN, contactSource: null }],
          presentedText: 'לשלוח?',
          channel: 'dashboard',
          reaskOf: jobId,
        })),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('a lost claim after a crash re-asks with the prefix', async () => {
    const { jobId } = await seedCommand();
    const sent: MailMessage[] = [];
    await withBusiness(BUSINESS, (db) => runDueJobs(db, { runtime: sendingRuntime(sent), now: NOON }));
    expect(sent).toHaveLength(1);
    // The crash: the mail is out, the claim stands, the completion is lost.
    await testDb().query('DELETE FROM job_step_results WHERE job_id = $1', [jobId]);
    await testDb().query(`UPDATE jobs SET phase = 'execute' WHERE job_id = $1`, [jobId]);
    await withBusiness(BUSINESS, (db) => runDueJobs(db, { runtime: sendingRuntime(sent), now: NOON }));
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.phase).toBe('failed');
    expect(await lastReason(jobId)).toContain('confirmed_step_already_claimed');

    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db));
    expect(result.reasked).toHaveLength(1);
    expect(result.reasked[0]?.uncertain).toBe(true);
    // No messenger: still written, and counted rather than silent.
    expect(result.notConnected).toBe(1);
    const newJobId = result.reasked[0]?.newJobId ?? '';
    const confirmation = await withBusiness(BUSINESS, (bdb) => loadConfirmation(bdb, newJobId));
    expect(confirmation?.presentedText.startsWith(REASK_PREFIX)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('a confirmation older than 24 hours with the step still to run: a plain question', async () => {
    const { jobId } = await seedCommand();
    await withBusiness(BUSINESS, (db) => transition(db, jobId, {
      to: 'followup',
      actor: 'orchestrator',
      reason: 'quiet_hours',
      wakeAt: new Date(Date.now() + 3_600_000),
    }));
    await testDb().query(
      `UPDATE instruction_confirmations SET decided_at = now() - interval '25 hours' WHERE job_id = $1`,
      [jobId],
    );

    const messenger = fakeMessenger();
    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger }));
    expect(result.reasked).toHaveLength(1);
    expect(result.reasked[0]?.uncertain).toBe(false);
    const newJobId = result.reasked[0]?.newJobId ?? '';
    const confirmation = await withBusiness(BUSINESS, (bdb) => loadConfirmation(bdb, newJobId));
    expect(confirmation?.presentedText.includes(REASK_PREFIX)).toBe(false);
    expect(confirmation?.presentedText.startsWith('לשלוח')).toBe(true);
    expect(messenger.sent.map((m) => m.text)).toEqual([confirmation?.presentedText]);
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.phase).toBe('failed');
  });

  it('T6: the re-ask of a mixed plan carries the ledger echo of what is left', async () => {
    const mixed = Plan.parse({
      goal: 'לשלוח ולרשום',
      steps: [
        PLAN.steps[0],
        {
          id: 's2',
          agent: 'ops.tasks',
          intent: 'record',
          toolName: 'ledger.add',
          input: { family: 'awaiting_reply', description: 'תשובה מהזר' },
          dependsOn: ['s1'],
          expectedActionClass: null,
        },
      ],
    });
    const { jobId } = await seedCommand({ plan: mixed });
    await withBusiness(BUSINESS, (db) => transition(db, jobId, {
      to: 'followup',
      actor: 'orchestrator',
      reason: 'quiet_hours',
      wakeAt: new Date(Date.now() + 3_600_000),
    }));
    await testDb().query(
      `UPDATE instruction_confirmations SET decided_at = now() - interval '25 hours' WHERE job_id = $1`,
      [jobId],
    );
    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger: fakeMessenger() }));
    expect(result.reasked).toHaveLength(1);
    const confirmation = await withBusiness(BUSINESS, (bdb) => loadConfirmation(bdb, result.reasked[0]?.newJobId ?? ''));
    expect(confirmation?.presentedText).toContain('ארשום: ממתינים לצד שני · תשובה מהזר');
  });

  it('a WhatsApp re-ask that was not sent stays undelivered — no messenger, or a failed send', async () => {
    const first = await seedCommand();
    await timeOut(first.jobId, first.bundle);
    const unsent = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db));
    expect(unsent.notConnected).toBe(1);
    const unsentJob = unsent.reasked[0]?.newJobId ?? '';
    expect((await withBusiness(BUSINESS, (bdb) => loadConfirmation(bdb, unsentJob)))?.deliveredAt).toBeNull();

    const second = await seedCommand();
    await timeOut(second.jobId, second.bundle);
    const failing: BossMessenger = {
      channel: 'whatsapp',
      async send() {
        return { ok: false, error: 'down' };
      },
    };
    const failed = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger: failing }));
    expect(failed.sendFailed).toBe(1);
    const failedJob = failed.reasked[0]?.newJobId ?? '';
    expect((await withBusiness(BUSINESS, (bdb) => loadConfirmation(bdb, failedJob)))?.deliveredAt).toBeNull();
  });

  it('a WhatsApp re-ask too long for one message sends a pointer to the dashboard instead, and stays undelivered', async () => {
    const long = 'ב'.repeat(2_500);
    const plan = Plan.parse({
      ...TWO_STEP,
      steps: TWO_STEP.steps.map((step) => ({ ...step, input: { ...step.input, body: long } })),
    });
    const { jobId } = await seedCommand({ plan });
    await withBusiness(BUSINESS, (db) => transition(db, jobId, {
      to: 'followup',
      actor: 'orchestrator',
      reason: 'quiet_hours',
      wakeAt: new Date(Date.now() + 3_600_000),
    }));
    await backdateDecision(jobId);

    const messenger = fakeMessenger();
    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger }));
    expect(result.errored).toEqual([]);
    const newJobId = result.reasked[0]?.newJobId ?? '';
    const confirmation = await withBusiness(BUSINESS, (bdb) => loadConfirmation(bdb, newJobId));
    expect(confirmation?.presentedText.length).toBeGreaterThan(WHATSAPP_MESSAGE_MAX_CHARS);
    expect(confirmation?.deliveredAt).toBeNull();
    expect(messenger.sent).toEqual([{ text: WHATSAPP_QUESTION_TOO_LONG, jobId: newJobId }]);
    expect(result.tooLong).toBe(1);
    expect(result.sent).toBe(0);
  });

  it('a confirmation within 24 hours in followup is left to run', async () => {
    const { jobId } = await seedCommand();
    await withBusiness(BUSINESS, (db) => transition(db, jobId, {
      to: 'followup',
      actor: 'orchestrator',
      reason: 'quiet_hours',
      wakeAt: new Date(Date.now() + 3_600_000),
    }));
    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db));
    expect(result.reasked).toEqual([]);
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.phase).toBe('followup');
  });

  it('a command job that completed is never re-asked, in any phase', async () => {
    const { jobId } = await seedCommand();
    const sent: MailMessage[] = [];
    await withBusiness(BUSINESS, (db) => runDueJobs(db, { runtime: sendingRuntime(sent), now: NOON }));
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.phase).toBe('verify');
    expect(await withBusiness(BUSINESS, (db) => reaskFailedCommands(db))).toMatchObject({ reasked: [] });

    // Claimed AND completed is not "claimed, nothing done" — not even failed.
    await testDb().query(`UPDATE jobs SET phase = 'failed' WHERE job_id = $1`, [jobId]);
    expect(await withBusiness(BUSINESS, (db) => reaskFailedCommands(db))).toMatchObject({ reasked: [] });
    // Nor an old confirmation with nothing left to run.
    await testDb().query(`UPDATE jobs SET phase = 'followup' WHERE job_id = $1`, [jobId]);
    await testDb().query(
      `UPDATE instruction_confirmations SET decided_at = now() - interval '25 hours' WHERE job_id = $1`,
      [jobId],
    );
    expect(await withBusiness(BUSINESS, (db) => reaskFailedCommands(db))).toMatchObject({ reasked: [] });
    expect(await reasksOf(jobId)).toEqual([]);
  });

  it('a job with an unknown row that was not born at the instruction door is not this code’s', async () => {
    const { jobId, bundle } = await seedCommand();
    await timeOut(jobId, bundle);
    await testDb().query('DELETE FROM boss_instructions WHERE job_id = $1', [jobId]);

    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger: fakeMessenger() }));
    // Not found at all — not found and then failed on the missing row.
    expect(result).toEqual({ reasked: [], sent: 0, notConnected: 0, sendFailed: 0, tooLong: 0, lockedOut: [], errored: [] });
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.phase).toBe('followup');
  });

  it('another business is untouched', async () => {
    const { jobId, bundle } = await seedCommand({ businessId: OTHER });
    await timeOut(jobId, bundle, OTHER);

    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger: fakeMessenger() }));
    expect(result).toEqual({ reasked: [], sent: 0, notConnected: 0, sendFailed: 0, tooLong: 0, lockedOut: [], errored: [] });
    expect((await withBusiness(OTHER, (db) => loadJob(db, jobId)))?.phase).toBe('followup');
    expect(await reasksOf(jobId)).toEqual([]);

    const own = await withBusiness(OTHER, (db) => reaskFailedCommands(db));
    expect(own.reasked.map((r) => r.oldJobId)).toEqual([jobId]);
    expect(await reasksOf(jobId)).toEqual([{ job_id: own.reasked[0]?.newJobId, business_id: OTHER }]);
  });

  it('a re-ask moved to failed but not yet asked is asked on the next pass', async () => {
    const { jobId } = await seedCommand();
    // The state a crash right after moving a (c) job leaves: failed for the
    // re-ask, an old confirmation, nothing claimed.
    await backdateDecision(jobId);
    await withBusiness(BUSINESS, (db) => transition(db, jobId, { to: 'failed', actor: 'orchestrator', reason: REASK_REASON }));
    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db));
    expect(result.reasked).toEqual([{ oldJobId: jobId, newJobId: expect.any(String), uncertain: false }]);
  });

  it('a dashboard command is re-asked on the dashboard, with nothing sent', async () => {
    const { jobId, bundle } = await seedCommand({ channel: 'dashboard' });
    await timeOut(jobId, bundle);
    const messenger = fakeMessenger();
    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger }));
    expect(result.reasked).toHaveLength(1);
    expect(result.sent).toBe(0);
    expect(result.notConnected).toBe(0);
    expect(messenger.sent).toEqual([]);
    const confirmation = await withBusiness(BUSINESS, (bdb) => loadConfirmation(bdb, result.reasked[0]?.newJobId ?? ''));
    expect(confirmation?.channel).toBe('dashboard');
  });

  it('runs in the scheduler pass after the plans, and its result is on the pass', async () => {
    const { jobId, bundle } = await seedCommand({ channel: 'dashboard' });
    await timeOut(jobId, bundle);
    const sent: MailMessage[] = [];
    const pass = await schedulerPass(BUSINESS, { runtime: sendingRuntime(sent), now: NOON, inbox: null });
    expect(pass.reaskError).toBeNull();
    expect(pass.reasked.reasked.map((r) => r.oldJobId)).toEqual([jobId]);
    expect(sent).toEqual([]);
  });

  it('the reviewer’s probe: s1 sent, s2 timed out, "yes" sends only s2', async () => {
    const { jobId, bundle } = await seedCommand({ plan: TWO_STEP });
    const sent: MailMessage[] = [];
    const job = await withBusiness(BUSINESS, (db) => loadJob(db, jobId));
    if (job === null) throw new Error('no job');
    const outcome = await withBusiness(job.businessId, (db) => runPlanForJob(db, {
      job,
      bundle,
      plan: TWO_STEP,
      registry: firstThenStall(sent),
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'draft_only',
      now: NOON,
      adapterTimeoutMs: 25,
    }));
    expect(outcome.status).toBe('halted');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toContain('first@nowhere.example');

    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db));
    expect(result.errored).toEqual([]);
    const newJobId = result.reasked[0]?.newJobId ?? '';
    const confirmation = await withBusiness(BUSINESS, (bdb) => loadConfirmation(bdb, newJobId));
    const option = confirmation?.options[0];
    if (confirmation === null || option === undefined) throw new Error('no re-ask');
    // Only s2, its edge to the completed s1 pruned, and a valid plan.
    expect(option.plan.steps.map((st) => st.id)).toEqual(['s2']);
    expect(option.plan.steps[0]?.dependsOn).toEqual([]);
    expect(option.planHash).toBe(planHashOf(option.plan));
    expect((await withBusiness(BUSINESS, (db) => loadStoredPlan(db, newJobId)))?.planHash).toBe(option.planHash);
    expect(confirmation.presentedText.startsWith(`${REASK_PREFIX}\n\n${alreadyDoneLine(1)}`)).toBe(true);
    expect(confirmation.presentedText).not.toContain('first@nowhere.example');

    // The owner says yes; the new job runs.
    expect(await withBusiness(BUSINESS, (bdb) => confirmChoice(bdb, newJobId, option.planHash, 'p_boss'))).toBe(true);
    await withBusiness(BUSINESS, (db) => transition(db, newJobId, { to: 'execute', actor: 'human', reason: 'command: confirmed' }));
    const after: MailMessage[] = [];
    const ran = await withBusiness(BUSINESS, (db) => runDueJobs(db, { runtime: sendingRuntime(after), now: NOON }));
    expect(ran.ran).toEqual([{ jobId: newJobId, status: 'done', detail: null }]);
    expect(after).toHaveLength(1);
    expect(after[0]?.to).toContain('second@nowhere.example');
    expect(after.some((m) => String(m.to).includes('first@nowhere.example'))).toBe(false);
  });

  it('arm (c) with s1 completed: the prefix and the already-done line, only s2 asked', async () => {
    const { jobId } = await seedCommand({ plan: TWO_STEP });
    await withBusinessTransaction(BUSINESS, async (tx) => {
      await recordStepCompletion(tx, {
        jobId, planHash: planHashOf(TWO_STEP), stepId: 's1',
        externalId: 'MSG-1', status: 'completed', performed: true,
      });
    });
    await withBusiness(BUSINESS, (db) => transition(db, jobId, {
      to: 'followup',
      actor: 'orchestrator',
      reason: 'quiet_hours',
      wakeAt: new Date(Date.now() + 3_600_000),
    }));
    await backdateDecision(jobId);

    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db));
    expect(result.reasked).toEqual([{ oldJobId: jobId, newJobId: expect.any(String), uncertain: true }]);
    const confirmation = await withBusiness(BUSINESS, (bdb) => loadConfirmation(bdb, result.reasked[0]?.newJobId ?? ''));
    expect(confirmation?.presentedText.startsWith(`${REASK_PREFIX}\n\n${alreadyDoneLine(1)}`)).toBe(true);
    expect(confirmation?.options[0]?.plan.steps.map((st) => st.id)).toEqual(['s2']);
  });

  it('residualPlan prunes edges to dropped steps and keeps the plan valid', () => {
    const three = Plan.parse({
      ...TWO_STEP,
      steps: [
        ...TWO_STEP.steps,
        { ...TWO_STEP.steps[1], id: 's3', dependsOn: ['s1', 's2'] },
      ],
    });
    const residual = residualPlan(three, new Set(['s1']));
    expect(residual?.steps.map((st) => [st.id, st.dependsOn])).toEqual([
      ['s2', []],
      ['s3', ['s2']],
    ]);
    expect(residual?.goal).toBe(three.goal);
    expect(residual !== null && planProblems(residual)).toEqual([]);
    expect(residualPlan(three, new Set(['s1', 's2', 's3']))).toBeNull();
  });

  it('an expiry the job woke into within the same pass is re-asked once, plainly', async () => {
    const { jobId } = await seedCommand({ channel: 'dashboard' });
    await withBusiness(BUSINESS, (db) => transition(db, jobId, {
      to: 'followup',
      actor: 'orchestrator',
      reason: 'quiet_hours',
      wakeAt: new Date(NOON.getTime() - 60_000),
    }));
    await backdateDecision(jobId);

    const sent: MailMessage[] = [];
    const pass = await schedulerPass(BUSINESS, { runtime: sendingRuntime(sent), now: NOON, inbox: null });
    expect(sent).toEqual([]);
    // Woken, run, refused on the stale "yes", failed — then re-asked.
    expect(await lastReason(jobId)).toContain('draft_only');
    expect(pass.reasked.reasked).toEqual([{ oldJobId: jobId, newJobId: expect.any(String), uncertain: false }]);
    const confirmation = await withBusiness(BUSINESS, (bdb) => loadConfirmation(bdb, pass.reasked.reasked[0]?.newJobId ?? ''));
    expect(confirmation?.presentedText.includes(REASK_PREFIX)).toBe(false);

    const next = await schedulerPass(BUSINESS, { runtime: sendingRuntime(sent), now: NOON, inbox: null });
    expect(next.reasked.reasked).toEqual([]);
    expect(await reasksOf(jobId)).toHaveLength(1);
  });

  it('a fresh confirmation that failed for another reason is not re-asked', async () => {
    const { jobId } = await seedCommand();
    await withBusiness(BUSINESS, (db) => transition(db, jobId, { to: 'failed', actor: 'orchestrator', reason: 'forbidden:x' }));
    expect(await withBusiness(BUSINESS, (db) => reaskFailedCommands(db))).toMatchObject({ reasked: [], errored: [] });
  });

  it('a meeting job is never re-asked — its hold is gone and the twin would carry no meetings rows', async () => {
    const { jobId, bundle } = await seedCommand();
    await timeOut(jobId, bundle);
    await testDb().query(
      `INSERT INTO meetings (meeting_id, business_id, job_id, step_id, calendar_id, event_id, operation, client_name)
       VALUES ('MT-reask', $1, $2, 's1', 'cal-1', 'hold-1', 'create', 'לקוח')`,
      [BUSINESS, jobId],
    );
    expect(await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger: fakeMessenger() }))).toMatchObject({
      reasked: [],
      errored: [],
    });
    expect(await reasksOf(jobId)).toEqual([]);
    // The same job without the meetings row is re-asked: the exclusion is the row.
    await testDb().query(`DELETE FROM meetings WHERE meeting_id = 'MT-reask'`);
    const again = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger: fakeMessenger() }));
    expect(again.reasked.map((r) => r.oldJobId)).toEqual([jobId]);
  });

  it('the successor carries the old job’s WhatsApp message', async () => {
    const { jobId, bundle } = await seedCommand();
    const messageId = await linkToWhatsApp(jobId);
    await timeOut(jobId, bundle);
    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger: fakeMessenger() }));
    expect(await whatsappLink(result.reasked[0]?.newJobId ?? '')).toBe(messageId);
  });

  it('the confirmation and the link land together: a failed link leaves no confirmation', async () => {
    const { jobId, bundle } = await seedCommand();
    await linkToWhatsApp(jobId);
    await timeOut(jobId, bundle);
    await testDb().query(`
      CREATE OR REPLACE FUNCTION reask_test_refuse_link() RETURNS trigger AS $$
      BEGIN
        IF NEW.whatsapp_message_id IS DISTINCT FROM OLD.whatsapp_message_id AND NEW.job_id <> '${jobId}' THEN
          RAISE EXCEPTION 'link refused';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await testDb().query(
      'CREATE TRIGGER reask_test_refuse_link BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION reask_test_refuse_link()',
    );
    try {
      const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger: fakeMessenger() }));
      expect(result.reasked).toEqual([]);
      expect(result.errored.map((e) => e.jobId)).toEqual([jobId]);
      expect(await reasksOf(jobId)).toEqual([]);
    } finally {
      await testDb().query('DROP TRIGGER reask_test_refuse_link ON jobs');
      await testDb().query('DROP FUNCTION reask_test_refuse_link()');
    }
    // Nothing is lost: the next pass asks.
    const again = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db, { messenger: fakeMessenger() }));
    expect(again.reasked.map((r) => r.oldJobId)).toEqual([jobId]);
  });

  /**
   * A command that failed at `failedAgo` after a "כן" given at `decidedAgo`
   * (Postgres intervals, back from now), with its step still to run.
   */
  async function failedAt(decidedAgo: string, failedAgo: string): Promise<string> {
    const { jobId } = await seedCommand();
    await withBusiness(BUSINESS, (db) => transition(db, jobId, { to: 'failed', actor: 'orchestrator', reason: 'forbidden:x' }));
    await testDb().query(
      `UPDATE instruction_confirmations SET decided_at = now() - $2::interval WHERE job_id = $1`,
      [jobId, decidedAgo],
    );
    await testDb().query(
      `UPDATE job_steps SET at = now() - $2::interval WHERE job_id = $1 AND to_phase = 'failed'`,
      [jobId, failedAgo],
    );
    return jobId;
  }

  it('a command that failed inside its 24 hours is not re-asked once the day has passed', async () => {
    const jobId = await failedAt('25 hours', '24 hours 30 minutes');
    expect(await withBusiness(BUSINESS, (db) => reaskFailedCommands(db))).toMatchObject({ reasked: [], errored: [] });
    expect(await reasksOf(jobId)).toEqual([]);
  });

  it('a command that failed early, 30 days ago, is not re-asked on deploy', async () => {
    const jobId = await failedAt('30 days 1 hour', '30 days');
    expect(await withBusiness(BUSINESS, (db) => reaskFailedCommands(db))).toMatchObject({ reasked: [], errored: [] });
    expect(await reasksOf(jobId)).toEqual([]);
  });

  it('a failure after the 24-hour boundary is re-asked', async () => {
    const jobId = await failedAt('26 hours', '1 hour');
    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db));
    expect(result.reasked).toEqual([{ oldJobId: jobId, newJobId: expect.any(String), uncertain: false }]);
  });

  it('a job bound to a plan other than the confirmed one is refused, not re-asked', async () => {
    const { jobId, bundle } = await seedCommand();
    await timeOut(jobId, bundle);
    await testDb().query(`UPDATE job_plans SET plan_hash = 'not-the-chosen-hash' WHERE job_id = $1`, [jobId]);
    const result = await withBusiness(BUSINESS, (db) => reaskFailedCommands(db));
    expect(result.reasked).toEqual([]);
    expect(result.errored).toEqual([
      { jobId, error: `command re-ask: job ${jobId} is bound to not-the-chosen-hash, not the confirmed plan ${PLAN_HASH}` },
    ]);
    expect(await reasksOf(jobId)).toEqual([]);
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.phase).toBe('followup');
  });
});
