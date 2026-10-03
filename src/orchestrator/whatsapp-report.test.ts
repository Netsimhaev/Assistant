import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, withTransaction } from '../db/pool.js';
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
import { applyDecision } from './resume.js';
import { decide } from '../governance/approvals.js';
import { bindPlanToJob, planHashOf, recordStepCompletion } from './plan-store.js';
import { recordInbound, settleMessage } from '../whatsapp/store.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import {
  awaitingApprovalText,
  classifyJob,
  failedText,
  FAILED_GENERIC_TEXT,
  NOT_IMPLEMENTED_TEXT,
  PERFORMED_TEXT,
  reportWhatsAppJobs,
} from './whatsapp-report.js';

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

async function messageState(messageId: string): Promise<string> {
  const { rows } = await getPool().query<{ state: string }>(
    'SELECT state FROM whatsapp_messages WHERE id = $1',
    [messageId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('expected a whatsapp_messages row');
  return row.state;
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
   *
   * Asserts exact equality against the exported constant, not a substring of
   * prose (fix round 1, item 7) — a rewording changes one string and no test.
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
    expect(report.errored).toEqual([]);
    expect(messenger.sentTexts[0]).toBe(NOT_IMPLEMENTED_TEXT);
    expect(messenger.sentJobIds[0]).toBe(job.jobId);

    // A `closed` job claims the TERMINAL marker, not the interim one.
    expect(await messageState(messageId)).toBe('reported');
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
    expect(messenger.sentTexts[0]).toBe(PERFORMED_TEXT);
  });

  /**
   * Fix round 1, Important 4. The engine's OWN failure reason on this path is
   * English prose (`verify.ts`'s `outcome unknown for … — the call went out
   * and no authoritative answer came back; nothing confirms it happened`),
   * with no code prefix `FAILURE_REASON_HE` could possibly match. Driven
   * through the real engine (an `adapter_timeout` → `unknown` row, closed by
   * `closeVerifiedJobs`) specifically so this reaches `failedText` with a
   * reason production can actually produce — the previous version of this
   * test was green only because it hand-wrote a Hebrew reason production
   * never emits.
   */
  it('reports a generic Hebrew failure, never the engine’s own English reason, for an unmapped code', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    await linkToWhatsApp(job.jobId);

    const plan = Plan.parse({
      goal: 'ליצור קובץ',
      steps: [{ id: 's1', agent: 'prod.docs', intent: 'x', toolName: 'file.write', input: {} }],
    });
    const binding = await bindPlanToJob(job.jobId, plan, { businessId: BUSINESS });
    if (binding.status === 'conflict') throw new Error('unreachable');

    await withTransaction(async (tx) => {
      await recordStepCompletion(tx, {
        jobId: job.jobId, businessId: BUSINESS, planHash: binding.planHash, stepId: 's1',
        externalId: null, status: 'unknown', performed: null,
      });
    });
    await transition(job.jobId, { to: 'verify', actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });

    const closed = await closeVerifiedJobs({ businessId: BUSINESS });
    expect(closed.failed.map((f) => f.jobId)).toContain(job.jobId);
    expect((await reload(job.jobId)).phase).toBe('failed');

    const messenger = fakeMessenger();
    const report = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });

    expect(report.reported).toBe(1);
    expect(messenger.sentTexts[0]).toBe(FAILED_GENERIC_TEXT);
    // Never leaked, whatever happens to the mapping table later.
    expect(messenger.sentTexts[0]).not.toMatch(/[A-Za-z]/);
  });

  /**
   * The other half of Important 4: a code the table DOES know, in exactly
   * the shape `execute.ts` actually writes it (`${code} — ${message}`, where
   * `message` here is a credential ref — English, by construction). The
   * owner reads the Hebrew translation, never the ref.
   */
  it('maps a known engine failure code to Hebrew, without forwarding the raw reason', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    await linkToWhatsApp(job.jobId);

    const rawReason = 'credential_unavailable — OFFICE_MAIL';
    await transition(job.jobId, { to: 'failed', actor: 'orchestrator', reason: rawReason, businessId: BUSINESS });

    const messenger = fakeMessenger();
    const report = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });

    expect(report.reported).toBe(1);
    expect(messenger.sentTexts[0]).toBe(failedText(rawReason));
    expect(messenger.sentTexts[0]).not.toContain('OFFICE_MAIL');
    expect(messenger.sentTexts[0]).not.toContain('credential_unavailable');
  });

  /**
   * Fix round 1, Minor 6. Branch 5's catch-all must not reuse the last
   * `job_steps.reason` as if it were a failure cause — for a job closed or
   * halted outside the normal path, that reason is routinely a non-failure
   * sentence.
   */
  it('does not misattribute a non-failure reason on the branch-5 catch-all', async () => {
    const bundle = await install();
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    await linkToWhatsApp(job.jobId);
    await transition(job.jobId, { to: 'understand', actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });

    // `understand → closed` directly, no bound plan at all — the record
    // cannot possibly support a "performed" claim, so this lands on branch 5
    // regardless of what the transition's own reason says.
    await transition(job.jobId, {
      to: 'closed',
      actor: 'orchestrator',
      reason: 'closed after the curator pass',
      businessId: BUSINESS,
    });

    const messenger = fakeMessenger();
    await reportWhatsAppJobs({ messenger, businessId: BUSINESS });

    expect(messenger.sentTexts[0]).toBe(FAILED_GENERIC_TEXT);
    expect(messenger.sentTexts[0]).not.toContain('curator');
  });

  /**
   * CRITICAL 1, fix round 1 — the test this round exists for. `await_approval`
   * is not terminal: the first version of this module claimed the message
   * straight to `'reported'` on the interim notice, so the owner never heard
   * the real outcome of an approval-gated instruction. Both halves, in one
   * flow: the interim sentence once, nothing on a redundant pass, and the
   * real terminal sentence once the job actually closes.
   */
  it('reports the interim notice once, then still reports the real outcome once the job closes', async () => {
    const bundle = await install({
      connections: [MAIL_CONNECTION],
      knownCounterpartyEmailDomain: 'b.com',
    });
    const job = await jobInExecute(bundle);
    const { messageId } = await linkToWhatsApp(job.jobId);

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

    const first = await runPlan({
      job, bundle, plan,
      registry: new AdapterRegistry([mail]),
      bindings: [MAIL_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });
    expect(first.status).toBe('halted');
    expect((await reload(job.jobId)).phase).toBe('await_approval');

    const { rows } = await getPool().query<{ approval_id: string }>(
      'SELECT approval_id FROM approval_requests WHERE job_id = $1',
      [job.jobId],
    );
    const approvalId = rows[0]?.approval_id;
    if (approvalId === undefined) throw new Error('expected a queued approval');

    // Pass 1: the interim notice.
    const messenger = fakeMessenger();
    const interimReport = await reportWhatsAppJobs({
      messenger, businessId: BUSINESS, dashboardBaseUrl: 'http://127.0.0.1:9999',
    });
    expect(interimReport.reported).toBe(1);
    expect(messenger.sentTexts[0]).toBe(
      awaitingApprovalText(`http://127.0.0.1:9999/a/${approvalId}`),
    );
    expect(await messageState(messageId)).toBe('reported_interim');

    // Pass 2: nothing changed — no duplicate interim notice.
    const secondPass = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });
    expect(secondPass.reported).toBe(0);
    expect(messenger.sentTexts).toHaveLength(1);
    expect(await messageState(messageId)).toBe('reported_interim');

    // The owner approves from the dashboard; the plan runs to completion.
    await applyDecision(approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' }, { businessId: BUSINESS });
    const second = await runPlan({
      job: await reload(job.jobId), bundle, plan,
      registry: new AdapterRegistry([mail]),
      bindings: [MAIL_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });
    expect(second.status).toBe('done');
    expect(sent).toHaveLength(1);
    await closeVerifiedJobs({ businessId: BUSINESS });
    expect((await reload(job.jobId)).phase).toBe('closed');

    // Pass 3: the real, terminal report — the one the owner was actually
    // waiting for.
    const terminalReport = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });
    expect(terminalReport.reported).toBe(1);
    expect(messenger.sentTexts).toHaveLength(2);
    expect(messenger.sentTexts[1]).toBe(PERFORMED_TEXT);
    expect(await messageState(messageId)).toBe('reported');

    // And report-once holds for the terminal claim too.
    const fourthPass = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });
    expect(fourthPass.reported).toBe(0);
    expect(messenger.sentTexts).toHaveLength(2);
  });

  /**
   * Fix round 1, Important 3 (review's numbering) — `pendingApprovalForJob`'s
   * not-found branch. The approval was decided (by `decide` alone, without
   * `resumeAfterDecision` — simulating the race where the job's own phase
   * read still says `await_approval` a moment before the scheduler moves it
   * on). The wait this phase describes has already passed; reporting
   * "waiting for your approval" would describe a state that is over.
   */
  it('does not report awaiting-approval once the approval has already been decided', async () => {
    const bundle = await install({
      connections: [MAIL_CONNECTION],
      knownCounterpartyEmailDomain: 'b.com',
    });
    const job = await jobInExecute(bundle);
    const { messageId } = await linkToWhatsApp(job.jobId);

    const mail = createMailAdapter({
      system: 'office-mail',
      transport: {
        async send() {
          throw new Error('perform must not run in this test');
        },
      },
    });

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
      job, bundle, plan,
      registry: new AdapterRegistry([mail]),
      bindings: [MAIL_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });
    expect(run.status).toBe('halted');

    const { rows } = await getPool().query<{ approval_id: string }>(
      'SELECT approval_id FROM approval_requests WHERE job_id = $1',
      [job.jobId],
    );
    const approvalId = rows[0]?.approval_id;
    if (approvalId === undefined) throw new Error('expected a queued approval');

    // `decide` alone — the row leaves `pending`, but the job's own phase is
    // untouched (still `await_approval`), the exact race window named above.
    await decide(approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' }, { businessId: BUSINESS });
    expect((await reload(job.jobId)).phase).toBe('await_approval');

    const messenger = fakeMessenger();
    const report = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });

    expect(report.reported).toBe(1);
    expect(messenger.sentTexts[0]).not.toContain('/a/');
    expect(messenger.sentTexts[0]).toBe(FAILED_GENERIC_TEXT);
    // The claim's KIND still follows the PHASE (`await_approval`), not the
    // outcome this pass happened to render — so a real terminal report is
    // still owed once the job actually reaches one.
    expect(await messageState(messageId)).toBe('reported_interim');
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

  /**
   * Fix round 1, Important 3 (the review's numbering, distinct from the
   * decided-approval test above) — the phase filter had no test and no
   * mutation. Deleting `AND j.phase IN (...)` from `reportCandidates` fails
   * nothing without this: every other test uses a terminal or awaiting job,
   * or an unlinked one.
   */
  it('ignores a WhatsApp job still running in execute', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const { messageId } = await linkToWhatsApp(job.jobId);
    // Left in `execute` on purpose — no further transition.

    const messenger = fakeMessenger();
    const report = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });

    expect(report.reported).toBe(0);
    expect(messenger.sentTexts).toHaveLength(0);
    // Untouched — a job still running must not have its one report burned.
    expect(await messageState(messageId)).toBe('handled');
  });

  /**
   * Fix round 1, Important 2. `classifyJob` → `loadPlanBody` throws BY
   * DESIGN on a stored plan that no longer parses, and candidates are
   * oldest-first — without isolation, the poison job (created first) would
   * sit first forever and starve every WhatsApp job behind it.
   */
  it('isolates one job whose record cannot be read from the rest of the pass', async () => {
    const bundle = await install();

    const poison = await jobInExecute(bundle);
    await linkToWhatsApp(poison.jobId);
    const poisonPlan = Plan.parse({
      goal: 'x',
      steps: [{ id: 's1', agent: 'prod.docs', intent: 'x', toolName: 'file.write', input: {} }],
    });
    const binding = await bindPlanToJob(poison.jobId, poisonPlan, { businessId: BUSINESS });
    if (binding.status === 'conflict') throw new Error('unreachable');
    // Corrupt the stored plan body in place so `loadPlanBody` throws when
    // this pass reaches it.
    await getPool().query(
      `UPDATE job_plans SET plan = '{"not":"a plan"}'::jsonb WHERE job_id = $1`,
      [poison.jobId],
    );
    await transition(poison.jobId, {
      to: 'failed', actor: 'orchestrator', reason: 'irrelevant', businessId: BUSINESS,
    });

    // Created after the poison job, so `ORDER BY updated_at ASC` places it
    // second — exactly the position the starvation bug would never reach.
    const healthy = await jobInExecute(bundle);
    await linkToWhatsApp(healthy.jobId);
    await transition(healthy.jobId, {
      to: 'failed', actor: 'orchestrator', reason: 'שגיאה רגילה', businessId: BUSINESS,
    });

    const messenger = fakeMessenger();
    const report = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });

    expect(report.errored).toEqual([poison.jobId]);
    expect(report.reported).toBe(1);
    expect(messenger.sentJobIds).toEqual([healthy.jobId]);
  });
});

/**
 * `classifyJob` exercised directly — fix round 1, item 7: assertions on the
 * `ReportOutcome` itself, not on substrings of the prose built from it.
 * Lighter-weight than the full `reportWhatsAppJobs` tests above: a bound
 * plan and hand-written `job_step_results` rows, the same shape
 * `verify.test.ts` already uses for `closeVerifiedJobs`.
 */
describe('classifyJob', () => {
  beforeEach(async () => {
    await resetDatabase();
    charterCounter = 0;
  });

  afterAll(async () => {
    await closePool();
  });

  const PLAN = Plan.parse({
    goal: 'x',
    steps: [{ id: 's1', agent: 'prod.docs', intent: 'x', toolName: 'file.write', input: {} }],
  });

  async function jobWithBoundPlan(): Promise<{ jobId: string; planHash: string }> {
    const bundle = await install();
    const job = await createJob({ charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS });
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }
    await bindPlanToJob(job.jobId, PLAN, { businessId: BUSINESS });
    return { jobId: job.jobId, planHash: planHashOf(PLAN) };
  }

  it('branch 1 outranks the phase — not_implemented regardless of what the phase says', async () => {
    const { jobId, planHash } = await jobWithBoundPlan();
    await withTransaction(async (tx) => {
      await recordStepCompletion(tx, {
        jobId, businessId: BUSINESS, planHash, stepId: 's1',
        externalId: null, status: 'completed', performed: false,
      });
    });
    // `classifyJob` takes `phase` as a plain argument — the same value
    // `reportCandidates` would have read off `jobs.phase` — and never
    // re-reads the row itself, so passing `'closed'` here exercises branch 1
    // against the phase branch 4 would otherwise have claimed, without
    // needing the job to actually be there.
    const verdict = await classifyJob(jobId, 'closed', BUSINESS);
    expect(verdict.outcome).toBe('not_implemented');
  });

  it('branch 4 requires every declared step to have a completed row, not just some', async () => {
    const { jobId, planHash } = await jobWithBoundPlan();
    // No row at all for 's1' — the only declared step.
    const verdict = await classifyJob(jobId, 'closed', BUSINESS);
    expect(verdict.outcome).toBe('failed');
    expect(verdict.failReason).toBeNull();

    await withTransaction(async (tx) => {
      await recordStepCompletion(tx, {
        jobId, businessId: BUSINESS, planHash, stepId: 's1',
        externalId: null, status: 'completed', performed: true,
      });
    });
    const second = await classifyJob(jobId, 'closed', BUSINESS);
    expect(second.outcome).toBe('performed');
  });

  /**
   * Ruling 4, direct: a `null`-performed `unknown` row must never satisfy
   * branch 1 — only a recorded `false` does. Mutating `execute.ts`'s
   * `adapter_timeout` branch from `performed: null` to `performed: false`
   * flips this test's outcome from `failed` to `not_implemented` (see the
   * task report's mutation transcript).
   */
  it('never classifies an honestly-unknown row as not_implemented', async () => {
    const { jobId, planHash } = await jobWithBoundPlan();
    await withTransaction(async (tx) => {
      await recordStepCompletion(tx, {
        jobId, businessId: BUSINESS, planHash, stepId: 's1',
        externalId: null, status: 'unknown', performed: null,
      });
    });
    await transition(jobId, {
      to: 'failed', actor: 'orchestrator', reason: 'outcome unknown for s1 — timed out', businessId: BUSINESS,
    });

    const verdict = await classifyJob(jobId, 'failed', BUSINESS);
    expect(verdict.outcome).toBe('failed');
  });
});
