/**
 * The confirmed-command exemption, end to end through the scheduler's own
 * runner: a boss command the owner confirmed actually sends under the dial at
 * `off`, and never sends a second time.
 *
 * `confirmed-command.test.ts` proves the gate; this file proves the wiring the
 * gate depends on — that `runDueJobs` → `runPlanForJob` → `executeStep`
 * hands the gate `ctx.stepId`, and that nothing between the plan and the gate
 * refuses a step the gate would allow. The setup is the shape a real install
 * has after the owner said "כן": the unmodified charter (no autonomy
 * override), the dial never written (so `off`), a live mail binding, a `boss`
 * job opened by the instruction door, its plan bound, its confirmation
 * confirmed, and the job moved to `execute`.
 *
 * The recipient is an address the charter does not know, and the class is
 * `email.initiate` — capped at `approve_required` by the charter. Without the
 * exemption this step dies at stage 8 on `draft_only`; the first test proves
 * that baseline with the confirmation left pending.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { loadAutonomyMode } from '../governance/autonomy-mode.js';
import { saveInstruction } from '../governance/instructions.js';
import { confirmChoice, createConfirmation } from '../governance/instruction-confirmations.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection } from '../domain/connection.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { upsertBinding } from './bindings.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, transition } from './jobs.js';
import { bindPlanToJob, planHashOf } from './plan-store.js';
import { runDueJobs } from './run-due.js';
import type { Runtime } from './runtime.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';
const NOON = new Date('2026-08-18T09:00:00.000Z');

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

function runtimeWith(sent: MailMessage[]): Runtime {
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
    credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
    warnings: [],
  };
}

async function seedCommand(options: { confirm: boolean }): Promise<string> {
  const bundle = await installCharter(
    buildCharter({ version: '2026-08-15.confirmed-run', connections: [MAIL_CONNECTION] }),
    { businessId: BUSINESS },
  );
  expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('off');
  expect(bundle.autonomyBase['email.initiate']).toBe('approve_required');

  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'confirmed-command',
  });
  await saveInstruction(
    { jobId: job.jobId, text: 'תשלחי ל-stranger@nowhere.example את ההצעה', textOrigin: 'typed' },
    { businessId: BUSINESS },
  );
  for (const to of ['understand', 'plan'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  await bindPlanToJob(job.jobId, PLAN, { businessId: BUSINESS });
  const planHash = planHashOf(PLAN);
  await createConfirmation(
    {
      jobId: job.jobId,
      options: [{ label: 'לשלוח', planHash, plan: PLAN, contactSource: null }],
      presentedText: 'לשלוח?',
      channel: 'dashboard',
    },
    { businessId: BUSINESS },
  );
  if (options.confirm) {
    expect(await confirmChoice(job.jobId, planHash, 'p_boss', { businessId: BUSINESS })).toBe(true);
  }
  await transition(job.jobId, { to: 'execute', actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });

  await upsertBinding(
    {
      system: 'office-mail',
      status: 'live',
      endpoint: null,
      credentialRef: 'OFFICE_MAIL',
      provider: null,
      lastOkAt: null,
      lastError: null,
    },
    { businessId: BUSINESS, by: 'test' },
  );
  return job.jobId;
}

describe('a confirmed boss command through the scheduler runner', () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await closePool(); });

  it('without the confirmation, the same step sends nothing under dial off', async () => {
    const jobId = await seedCommand({ confirm: false });
    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(result.ran).toHaveLength(1);
    expect(result.ran[0]?.status).not.toBe('done');
    expect(sent).toEqual([]);
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE job_id = $1 AND kind = 'policy_denial'`,
      [jobId],
    );
    expect(rows.map((r) => r.reason)).toEqual(['draft_only:persist_as_draft: email.initiate']);
  });

  it('executes under dial off, and a second pass does not send again', async () => {
    const jobId = await seedCommand({ confirm: true });
    const sent: MailMessage[] = [];

    const first = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });
    expect(first.ran).toEqual([{ jobId, status: 'done', detail: null }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toContain('stranger@nowhere.example');
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('verify');

    const second = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });
    expect(second.ran).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('a crash after the send and before the completion is recorded does not send twice', async () => {
    const jobId = await seedCommand({ confirm: true });
    const sent: MailMessage[] = [];
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });
    expect(sent).toHaveLength(1);

    // Rewind to the state such a crash leaves behind: the mail is out, the
    // claim stands, and nothing recorded the step as completed.
    await getPool().query('DELETE FROM job_step_results WHERE job_id = $1', [jobId]);
    await getPool().query(`UPDATE jobs SET phase = 'execute' WHERE job_id = $1`, [jobId]);

    const again = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });
    expect(again.ran).toHaveLength(1);
    expect(again.ran[0]?.status).not.toBe('done');
    expect(sent).toHaveLength(1);
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM job_steps WHERE job_id = $1 ORDER BY at DESC LIMIT 1`,
      [jobId],
    );
    expect(rows[0]?.reason).toContain('confirmed_step_already_claimed');
  });
});
