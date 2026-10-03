import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { TrustLevel } from '../domain/trust.js';
import { createJob, loadJob, transition, linkWhatsAppMessage, type Job } from './jobs.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { envCredentials } from './credentials.js';
import { runPlan, runPlanForJob } from './run-plan.js';
import { closeVerifiedJobs } from './verify.js';
import { recordInbound, settleMessage } from '../whatsapp/store.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { reportWhatsAppJobs } from './whatsapp-report.js';

const BUSINESS = 'test-business';
/** 12:00 Asia/Jerusalem — outside the fixture's 20:00–07:00 quiet window. */
const NOON = new Date('2026-08-18T09:00:00.000Z');
const PREFIX = 'TEST_CRED_';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const MAIL_LIVE: ConnectionBinding = {
  system: 'office-mail',
  status: 'live',
  endpoint: null,
  credentialRef: 'OFFICE_MAIL',
  provider: null,
  lastOkAt: null,
  lastError: null,
};

const CREDENTIALS = envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX);

let charterCounter = 0;

/** A fresh, uniquely-versioned charter for each test — tests run against a shared DB. */
async function install(
  overrides: Parameters<typeof buildCharter>[0] = {},
): Promise<PolicyBundle> {
  charterCounter += 1;
  return installCharter(
    buildCharter({ ...overrides, version: `wa-report-${charterCounter}` }),
    { businessId: BUSINESS },
  );
}

async function reload(jobId: string): Promise<Job> {
  const loaded = await loadJob(jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

/** A job walked through to `execute`, the same shape `runDueJobs` hands `runPlan`. */
async function jobInExecute(bundle: PolicyBundle, provenance: TrustLevel = 'boss'): Promise<Job> {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance,
    businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  return reload(job.jobId);
}

/**
 * The WhatsApp half of the door's own bookkeeping: an inbound message
 * recorded and linked to the job it opened, settled `'handled'` — the state
 * `runWhatsAppDoor` leaves a successfully-instructed message in. Real rows,
 * through the real store, because `reportWhatsAppJobs`'s own query joins
 * against them.
 */
async function linkToWhatsApp(jobId: string): Promise<{ messageId: string }> {
  const message = await recordInbound(
    {
      providerMessageId: `PM-${jobId}`,
      senderNumber: '+972500000000',
      senderKind: 'principal',
      body: 'בדיקה',
      mediaKind: null,
      providerTimestamp: new Date().toISOString(),
    },
    { businessId: BUSINESS },
  );
  if (message === null) throw new Error('setup: duplicate inbound message id');
  await linkWhatsAppMessage(jobId, message.id, { businessId: BUSINESS });
  await settleMessage(message.id, 'handled', {}, { businessId: BUSINESS });
  return { messageId: message.id };
}

function fakeMessenger(): BossMessenger & {
  sentTexts: string[];
  sentJobIds: (string | null)[];
} {
  const sentTexts: string[] = [];
  const sentJobIds: (string | null)[] = [];
  return {
    channel: 'whatsapp',
    sentTexts,
    sentJobIds,
    async send(input) {
      sentTexts.push(input.text);
      sentJobIds.push(input.jobId);
      return { ok: true };
    },
  };
}

describe('reportWhatsAppJobs', () => {
  beforeEach(async () => {
    await resetDatabase();
    charterCounter = 0;
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * THE TEST THIS WHOLE SUB-PROJECT TURNS ON.
   *
   * `file.write` is classified (`artifact.write`), owned by `prod.docs`, local
   * (no channel — `isOutbound('file.write')` is `false`), and has no handler
   * in `local-tools.ts`'s `HANDLERS`. `runLocalTool` therefore returns
   * `{ performed: false, reason: 'not_implemented' }`; `performStep` records
   * that as a SUCCESSFUL step outcome; the step is recorded `completed`;
   * `closeVerifiedJobs` closes the job. A report keyed on the phase alone
   * would say "done" about a file that was never written. Run through the
   * real engine — `runPlanForJob`, not a hand-built `job_step_results` row —
   * so this proves the plumbing end to end: `runLocalTool`'s boolean reaches
   * `StepEffect.performed`, which reaches the column migration 037 added,
   * which this report classifies on.
   */
  it('reports "not performed" for a job whose steps all returned not_implemented', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const { messageId } = await linkToWhatsApp(job.jobId);

    const plan = Plan.parse({
      goal: 'ליצור קובץ עם סיכום',
      steps: [
        {
          id: 's1',
          agent: 'prod.docs',
          intent: 'write a summary file',
          toolName: 'file.write',
          input: { path: 'summary.txt', content: 'סיכום' },
        },
      ],
    });

    const run = await runPlanForJob({
      job,
      bundle,
      plan,
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, 'NONE_'),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });
    expect(run.status).toBe('done');

    const closed = await closeVerifiedJobs({ businessId: BUSINESS });
    expect(closed.closed).toContain(job.jobId);
    expect((await reload(job.jobId)).phase).toBe('closed');

    const messenger = fakeMessenger();
    const report = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });

    expect(report.reported).toBe(1);
    expect(messenger.sentTexts[0]).toContain('לא בוצע');
    expect(messenger.sentTexts[0]).not.toContain('בוצע ');
    expect(messenger.sentJobIds[0]).toBe(job.jobId);

    // The opening message is now terminal — `reportWhatsAppJobs`'s own
    // report-once mechanism, read back from the store it wrote to.
    const { rows } = await getPool().query<{ state: string }>(
      'SELECT state FROM whatsapp_messages WHERE id = $1',
      [messageId],
    );
    expect(rows[0]?.state).toBe('reported');
  });

  /**
   * The mirror case: a step that genuinely ran, through the channel branch of
   * `performStep` (not the local-tool branch the test above exercises) —
   * `StepEffect.performed` is set to `true` unconditionally there, because
   * reaching it at all already means the adapter returned `ok: true`.
   */
  it('reports what was performed for a job whose steps really performed', async () => {
    const bundle = await install({
      connections: [MAIL_CONNECTION],
      knownCounterpartyEmailDomain: 'b.com',
    });
    const job = await jobInExecute(bundle);
    await linkToWhatsApp(job.jobId);

    const sent: MailMessage[] = [];
    const mail = createMailAdapter({
      system: 'office-mail',
      transport: {
        async send(message) {
          sent.push(message);
          return { messageId: `MSG-${sent.length}` };
        },
      },
    });

    const plan = Plan.parse({
      goal: 'לענות במייל',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'reply',
          toolName: 'mail.send',
          input: {
            to: 'a@b.com',
            inReplyTo: 'm1',
            counterpartyId: 'c_812',
            subject: 'שלום',
            body: 'תודה על הפנייה',
          },
        },
      ],
    });

    const run = await runPlan({
      job,
      bundle,
      plan,
      registry: new AdapterRegistry([mail]),
      bindings: [MAIL_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });
    expect(run.status).toBe('done');
    expect(sent).toHaveLength(1);

    const closed = await closeVerifiedJobs({ businessId: BUSINESS });
    expect(closed.closed).toContain(job.jobId);

    const messenger = fakeMessenger();
    const report = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });

    expect(report.reported).toBe(1);
    expect(messenger.sentTexts[0]).toContain('בוצע ');
    expect(messenger.sentTexts[0]).not.toContain('לא בוצע');
  });

  it('reports the recorded reason for a failed job', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    await linkToWhatsApp(job.jobId);

    await transition(job.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: 'קוד שגיאה מהספק: תשלום נדחה',
      businessId: BUSINESS,
    });

    const messenger = fakeMessenger();
    const report = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });

    expect(report.reported).toBe(1);
    expect(messenger.sentTexts[0]).toContain('נכשל');
    expect(messenger.sentTexts[0]).toContain('תשלום נדחה');
  });

  it('reports awaiting approval with a dashboard link when the plan stopped at a card', async () => {
    const bundle = await install({
      connections: [MAIL_CONNECTION],
      knownCounterpartyEmailDomain: 'b.com',
    });
    const job = await jobInExecute(bundle);
    await linkToWhatsApp(job.jobId);

    const mail = createMailAdapter({
      system: 'office-mail',
      transport: {
        async send() {
          throw new Error('perform must not run — the plan should stop for approval first');
        },
      },
    });

    // No `inReplyTo`: classifies `email.initiate`, whose charter base is
    // `approve_required` — `needsApproval`'s second disjunct fires regardless
    // of the risk band, so this queues a card rather than sending.
    const plan = Plan.parse({
      goal: 'לפתוח פנייה חדשה',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'first contact',
          toolName: 'mail.send',
          input: { to: 'a@b.com', counterpartyId: 'c_812', subject: 'שלום', body: 'פנייה ראשונה' },
        },
      ],
    });

    const run = await runPlan({
      job,
      bundle,
      plan,
      registry: new AdapterRegistry([mail]),
      bindings: [MAIL_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });
    expect(run.status).toBe('halted');
    expect((await reload(job.jobId)).phase).toBe('await_approval');

    const { rows } = await getPool().query<{ approval_id: string }>(
      'SELECT approval_id FROM approval_requests WHERE job_id = $1',
      [job.jobId],
    );
    const approvalId = rows[0]?.approval_id;
    expect(approvalId).toBeDefined();

    const messenger = fakeMessenger();
    const report = await reportWhatsAppJobs({
      messenger,
      businessId: BUSINESS,
      dashboardBaseUrl: 'http://127.0.0.1:9999',
    });

    expect(report.reported).toBe(1);
    expect(messenger.sentTexts[0]).toContain(`http://127.0.0.1:9999/a/${approvalId}`);
  });

  it('reports a job once and never again', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    await linkToWhatsApp(job.jobId);

    await transition(job.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: 'שגיאה חד-פעמית',
      businessId: BUSINESS,
    });

    const messenger = fakeMessenger();
    const first = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });
    expect(first.reported).toBe(1);
    expect(messenger.sentTexts).toHaveLength(1);

    const second = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });
    expect(second.reported).toBe(0);
    // Nothing new sent — the second call found no unreported candidate at all.
    expect(messenger.sentTexts).toHaveLength(1);
  });

  it('ignores jobs that did not come from WhatsApp', async () => {
    const bundle = await install();
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    // Never linked — `whatsapp_message_id` stays NULL.
    await transition(job.jobId, {
      to: 'understand',
      actor: 'orchestrator',
      reason: 'setup',
      businessId: BUSINESS,
    });
    await transition(job.jobId, {
      to: 'closed',
      actor: 'orchestrator',
      reason: 'closed outside the door entirely',
      businessId: BUSINESS,
    });

    const messenger = fakeMessenger();
    const report = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });

    expect(report.reported).toBe(0);
    expect(messenger.sentTexts).toHaveLength(0);
  });
});
