import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { getApproval, pendingApprovals } from '../governance/approvals.js';
import { loadEnvelopeWithChild } from '../governance/envelope-store.js';
import type { PolicyBundle } from '../domain/policy.js';
import { Plan } from '../domain/plan.js';
import { createJob, loadJob, transition } from './jobs.js';
import { executeStep } from './execute.js';
import { setDigestSettings } from '../governance/digest-settings.js';
import { bindPlanToJob } from './plan-store.js';
import { runDueJobs } from './run-due.js';
import { schedulerPass, startScheduler, tick } from './scheduler.js';
import { applyDecision } from './resume.js';
import { AdapterRegistry } from './adapters/registry.js';
import { envCredentials } from './credentials.js';
import type { Runtime } from './runtime.js';
import { MasterKeyError } from '../governance/master-key.js';
import { getCursor, setCursor } from '../mail/inbox-store.js';
import type { MailboxClient } from '../mail/providers/types.js';
import type { Triage } from '../sdk/mail-triage.js';
import { NOON as MAIL_NOON, QUESTION_TRIAGE, incomingMail, installMailboxCharter, stubDrafter } from '../test/mailbox.js';

/**
 * What `perform` returns when a step produced nothing an adapter would hand
 * back. The shape is `StepEffect`: the output, and the provider's handle on
 * whatever was created — `executeStep` writes that handle down with the step's
 * completion, which is what lets a resumed run skip the step instead of
 * repeating it.
 */
const NOTHING = { output: null, externalId: null, performed: true };


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
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, {
      to,
      actor: 'orchestrator',
      reason: 'setup',
      businessId: BUSINESS,
    });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

const STEP = {
  stepId: 'step-1',
  agent: 'comms.email' as const,
  toolName: 'mail.send',
  toolInput: { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812' },
  counterpartyTags: [] as string[],
  rampLevel: 'auto' as const,
};

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('the scheduler closes the loop the orchestrator opens', () => {
  it('wakes a job that quiet hours put to sleep', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    let sent = 0;

    // Deferred at night. Before the scheduler existed this job slept forever:
    // `wakeAt` was written and nothing ever read it.
    const deferred = await executeStep({
      ...STEP,
      job,
      bundle,
      perform: async () => {
        sent += 1;
        return NOTHING;
      },
      now: NIGHT,
    });
    expect(deferred.status).toBe('deferred');
    expect(sent).toBe(0);

    const asleep = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(asleep?.phase).toBe('followup');

    // Too early — the window has not closed yet.
    const early = await tick({ businessId: BUSINESS, now: NIGHT });
    expect(early.wokenJobs).toEqual([]);

    const later = await tick({ businessId: BUSINESS, now: NOON });
    expect(later.wokenJobs).toEqual([job.jobId]);

    const awake = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(awake?.phase).toBe('execute');
    // Woken once, not every tick thereafter.
    expect(awake?.wakeAt).toBeNull();
    expect((await tick({ businessId: BUSINESS, now: NOON })).wokenJobs).toEqual([]);
  });

  it('the woken job then actually sends, in the morning', async () => {
    // `STEP` writes to `a@b.com`; the charter is given that domain so the send
    // is `routine` and the subject stays what it says — quiet hours deferring a
    // job and the wake-up actually sending. An entity id no longer vouches for
    // an address the charter cannot resolve (`visibility-scoring.test.ts`), and
    // an escalation here would stop the step before `perform` ever ran.
    const bundle = await install({ knownCounterpartyEmailDomain: 'b.com' });
    const job = await jobInExecute(bundle);
    let sent = 0;

    await executeStep({ ...STEP, job, bundle, perform: async () => { sent += 1; return NOTHING; }, now: NIGHT });
    await tick({ businessId: BUSINESS, now: NOON });

    const awake = await loadJob(job.jobId, { businessId: BUSINESS });
    if (awake === null) throw new Error('job vanished');
    const outcome = await executeStep({
      ...STEP,
      job: awake,
      bundle,
      perform: async () => {
        sent += 1;
        return NOTHING;
      },
      now: NOON,
    });

    expect(outcome.status).toBe('done');
    expect(sent).toBe(1);
  });

  it('expires an approval nobody answered and frees the job behind it', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);

    const queued = await executeStep({
      ...STEP,
      job,
      bundle,
      toolInput: { to: 'new@example.com', body: 'פנייה ראשונה' },
      perform: async () => NOTHING,
      now: NOON,
    });
    expect(queued.status).toBe('awaiting_approval');
    if (queued.status !== 'awaiting_approval') throw new Error('unreachable');

    await getPool().query(
      `UPDATE approval_requests SET expires_at = now() - interval '1 hour' WHERE approval_id = $1`,
      [queued.approvalId],
    );

    const result = await tick({ businessId: BUSINESS, now: NOON });

    expect(result.expiredApprovals).toEqual([queued.approvalId]);
    expect((await getApproval(queued.approvalId, { businessId: BUSINESS }))?.state).toBe(
      'expired',
    );
    // The job is freed rather than failed: nobody answering is not a rejection.
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('followup');
    expect(await pendingApprovals({ businessId: BUSINESS })).toEqual([]);
  });

  it('leaves an approval that is still within its fuse alone', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);

    const queued = await executeStep({
      ...STEP,
      job,
      bundle,
      toolInput: { to: 'new@example.com', body: 'פנייה' },
      perform: async () => NOTHING,
      now: NOON,
    });
    if (queued.status !== 'awaiting_approval') throw new Error('unreachable');

    const result = await tick({ businessId: BUSINESS, now: NOON });

    expect(result.expiredApprovals).toEqual([]);
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe(
      'await_approval',
    );
  });

  it('a second scheduler skips the tick rather than repeating it', async () => {
    await install();
    // Both ticks race for the same advisory lock; exactly one does the work.
    const [a, b] = await Promise.all([
      tick({ businessId: BUSINESS, now: NOON }),
      tick({ businessId: BUSINESS, now: NOON }),
    ]);
    expect([a.skipped, b.skipped].filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });

  it('runs on an interval and stops cleanly', async () => {
    await install();
    const errors: unknown[] = [];
    // `buildRuntime` now reads the installation's master key file and
    // refuses to build without one, so a pass with no runtime would report
    // that refusal through `onError` on every tick. This test is about the
    // interval and the clean stop; it runs no plan and resolves no
    // credential, so it is handed an inert runtime rather than a key.
    const inert: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, 'TEST_CRED_'),
      warnings: [],
    };
    const handle = startScheduler({
      businessId: BUSINESS,
      intervalMs: 50,
      runtime: inert,
      onError: (error) => errors.push(error),
    });

    await new Promise((resolve) => setTimeout(resolve, 160));
    await handle.stop();

    expect(errors).toEqual([]);
  });
});

describe('a human decision restarts the job it was blocking', () => {
  it('an approval returns the job to execute', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);

    const queued = await executeStep({
      ...STEP,
      job,
      bundle,
      toolInput: { to: 'new@example.com', body: 'פנייה ראשונה' },
      perform: async () => NOTHING,
      now: NOON,
    });
    if (queued.status !== 'awaiting_approval') throw new Error('unreachable');

    // `decide` wrote the row and stopped, so the job stayed parked with
    // nothing to restart it.
    const result = await applyDecision(
      queued.approvalId,
      'approved',
      { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS },
    );

    expect(result.state).toBe('approved');
    expect(result.jobPhase).toBe('execute');
  });

  it('a refusal closes the job rather than failing it', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);

    const queued = await executeStep({
      ...STEP,
      job,
      bundle,
      toolInput: { to: 'new@example.com', body: 'פנייה ראשונה' },
      perform: async () => NOTHING,
      now: NOON,
    });
    if (queued.status !== 'awaiting_approval') throw new Error('unreachable');

    const result = await applyDecision(
      queued.approvalId,
      'denied',
      { by: 'p_boss', channel: 'dashboard', note: 'לא עכשיו' },
      { businessId: BUSINESS },
    );

    // The system did what was asked and a person said no. That is an outcome.
    expect(result.jobPhase).toBe('closed');
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.closedAt).not.toBeNull();
  });
});

/**
 * The branch three other test files stopped exercising.
 *
 * `schedulerPass` and `runDueJobs` both default to `options.runtime ??
 * (await buildRuntime())`, and `buildRuntime` now refuses outright when there
 * is no master key — an installation with no secrets must fail at startup,
 * not one customer's send at a time. `promote.test.ts`, `scheduler.test.ts`
 * (above) and `scheduler-conducts.test.ts` all correctly swapped that default
 * for an injected inert runtime, which left the default itself covered
 * nowhere at all.
 *
 * So: one pass with no runtime injected and no key path in the environment.
 * The refusal is the assertion.
 */
describe('a pass with no master key refuses rather than running blind', () => {
  it("propagates buildRuntime's refusal out of schedulerPass", async () => {
    const previous = process.env['CREDENTIAL_KEY_PATH'];
    delete process.env['CREDENTIAL_KEY_PATH'];
    try {
      await expect(
        schedulerPass({ businessId: BUSINESS, now: NOON, inbox: null }),
      ).rejects.toThrow(MasterKeyError);
      // Named, so a MasterKeyError arriving from some other check cannot
      // stand in for the one this test is about.
      await expect(
        schedulerPass({ businessId: BUSINESS, now: NOON, inbox: null }),
      ).rejects.toThrow(/CREDENTIAL_KEY_PATH/);
    } finally {
      if (previous === undefined) delete process.env['CREDENTIAL_KEY_PATH'];
      else process.env['CREDENTIAL_KEY_PATH'] = previous;
    }
  });
});

/**
 * Task 7 fix round 1, Critical. A `parked` step writes no completion row, so
 * on resume `runPlan`'s `alreadyDone` set is empty and `agent.request_help`
 * runs a SECOND time. Before this fix, `requestHelp`'s guard 4
 * (`no_new_information`) fired on that second call — the request is,
 * byte-for-byte, identical to the one that already succeeded — and the
 * local-tool handler could not tell that refusal apart from a real one: it
 * read the parent's phase as still `execute`, threw non-retryably, and
 * `executeStep` marked the parent `failed`. In the DEFAULT production
 * configuration — an envelope closes before its parent is next scheduled —
 * every successful delegation ended this way.
 *
 * This also pins the one fact about `schedulerPass` that was previously only
 * prose: `resumeDelegatedJobs` runs BEFORE `runDueJobs`, in the same pass, so
 * a parent freed this pass is not left waiting a full interval to resume.
 */
describe('a delegation resumes in the same pass it is freed', () => {
  it('parks a parent, closes its child, and one schedulerPass completes the parent instead of failing it', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const plan = Plan.parse({
      goal: 'ask know.reader to read the document',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'delegate',
          toolName: 'agent.request_help',
          input: {
            to: 'know.reader',
            intent: 'read_for_question',
            payload: { question: 'מה המסמך הזה מבקש?' },
            contextRefs: [{ kind: 'document', documentId: 'doc-scheduler-test' }],
          },
          dependsOn: [],
          expectedActionClass: 'agent.delegate',
        },
      ],
    });
    await bindPlanToJob(job.jobId, plan, { businessId: BUSINESS });

    const runtime: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, 'TEST_CRED_'),
      warnings: [],
    };

    // Sets up the state a real earlier scheduler pass would already have
    // produced: the delegation opens, and the parent parks in `followup`.
    const opening = await runDueJobs({ businessId: BUSINESS, runtime, now: NOON });
    const openedEntry = opening.ran.find((r) => r.jobId === job.jobId);
    if (openedEntry === undefined) throw new Error('expected the parent to have run and parked');
    expect(openedEntry.status).toBe('halted');

    const parkedParent = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(parkedParent?.phase).toBe('followup');
    if (parkedParent?.awaitingEnvelopeId == null) throw new Error('expected an awaiting envelope id');

    const stored = await loadEnvelopeWithChild(parkedParent.awaitingEnvelopeId, { businessId: BUSINESS });
    if (stored?.childJobId == null) throw new Error('expected an attached child job');
    const childJobId = stored.childJobId;

    // Close the child, simulating a completed delegation.
    for (const to of ['verify', 'remember', 'closed'] as const) {
      await transition(childJobId, { to, actor: 'orchestrator', reason: 'test setup', businessId: BUSINESS });
    }

    // The critical assertion: ONE schedulerPass both wakes the parent
    // (`resumeDelegatedJobs`) and re-runs its plan (`runDueJobs`) in the SAME
    // pass, and the parent completes rather than being marked `failed`.
    const pass = await schedulerPass({ businessId: BUSINESS, now: NOON, inbox: null, runtime });

    expect(pass.delegated.resumed).toEqual([job.jobId]);
    expect(pass.delegated.errored).toEqual([]);

    const resumedEntry = pass.due.ran.find((r) => r.jobId === job.jobId);
    if (resumedEntry === undefined) {
      throw new Error('expected the parent to run again in the very same pass that freed it');
    }
    expect(resumedEntry.status).toBe('done');

    const finalParent = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(finalParent?.phase).not.toBe('failed');
  });
});

/**
 * Fix round 1, item 1 — the most mechanical-looking gap, and still real:
 * before this describe block, nothing anywhere read `pass.digest`. The
 * reviewer proved it by hard-coding `digest: null` into `schedulerPass`'s
 * return object — leaving the real `runDigests` call and its database write
 * completely untouched — and all 23 existing tests still passed, because
 * every one of them checks the stored row through `recentDigests` instead
 * of the field `SchedulerPassResult` actually exposes.
 */
describe('the digest field on SchedulerPassResult', () => {
  it('is null when the digest schedule is off', async () => {
    await install();
    const inert: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, 'TEST_CRED_'),
      warnings: [],
    };
    const pass = await schedulerPass({ businessId: BUSINESS, now: NOON, inbox: null, runtime: inert });
    expect(pass.digest).toBeNull();
  });

  it('carries the produced window and no error when the schedule is on', async () => {
    await install();
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: false, toWhatsApp: false },
      'owner',
      { businessId: BUSINESS },
    );
    const inert: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, 'TEST_CRED_'),
      warnings: [],
    };
    const pass = await schedulerPass({ businessId: BUSINESS, now: NOON, inbox: null, runtime: inert });
    expect(pass.digest).not.toBeNull();
    expect(pass.digest?.produced).toHaveLength(1);
    expect(pass.digest?.produced[0]?.kind).toBe('daily');
    expect(pass.digest?.errored).toBeNull();
  });
});

/**
 * The mailbox poll inside the pass: `null` when nothing is connected (a
 * switch, not a fault), and a real result — with the poll's own work done —
 * when a mailbox is.
 */
describe('the mail field on SchedulerPassResult', () => {
  const inert = (): Runtime => ({
    registry: new AdapterRegistry([]),
    credentials: envCredentials({ TEST_CRED_OAUTH_MAILBOX: 'access-token' }, 'TEST_CRED_'),
    warnings: [],
  });

  it('is null, with no error, when no mailbox is connected', async () => {
    await install();
    const pass = await schedulerPass({ businessId: BUSINESS, now: NOON, inbox: null, runtime: inert() });
    expect(pass.mail).toBeNull();
    expect(pass.mailError).toBeNull();
  });

  it('scrubs a body past its year on every pass, mailbox connected or not', async () => {
    await install();
    const old = new Date(NOON.getTime() - 400 * 24 * 3600_000);
    await getPool().query(
      `INSERT INTO mail_messages
         (mail_id, business_id, provider_message_id, thread_id, from_address, subject, received_at, body_text)
       VALUES ('M-old', $1, 'pm-old', 't', 'a@b.example', 's', $2, 'גוף ישן')`,
      [BUSINESS, old.toISOString()],
    );
    const pass = await schedulerPass({ businessId: BUSINESS, now: NOON, inbox: null, runtime: inert() });
    expect(pass.mailRetention).toEqual({ scrubbed: 1 });
    expect(pass.mailRetentionError).toBeNull();
    const { rows } = await getPool().query<{ body_text: string | null }>(
      'SELECT body_text FROM mail_messages WHERE mail_id = $1',
      ['M-old'],
    );
    expect(rows[0]?.body_text).toBeNull();
  });

  it('polls the connected mailbox and raises the reply card in the same pass', async () => {
    await installMailboxCharter(BUSINESS);
    await setCursor({ provider: 'google', cursor: 'C-0' }, { businessId: BUSINESS });
    const client = {
      initialCursor: async () => 'C-0',
      listSince: async () => ({ messages: [incomingMail({ providerMessageId: 'PM-S' })], nextCursor: 'C-1' }),
      fetchAttachment: async () => Buffer.alloc(0),
      ensureLabels: async (_t: string, names: readonly string[]) => Object.fromEntries(names.map((n) => [n, `L-${n}`])),
      addLabel: async () => true as const,
      sendReply: async () => ({ externalId: 'SENT-1' }),
    } as unknown as MailboxClient;
    const triage: Triage = async () => ({ status: 'read', triage: QUESTION_TRIAGE });

    const pass = await schedulerPass({
      businessId: BUSINESS,
      now: MAIL_NOON,
      inbox: null,
      runtime: inert(),
      mailClient: client,
      mailTriage: triage,
      mailDrafter: stubDrafter(),
    });

    expect(pass.mailError).toBeNull();
    expect(pass.mail).toMatchObject({ status: 'ok', recorded: 1, triaged: 1, drafts: 1 });
    expect((await getCursor({ businessId: BUSINESS }))?.cursor).toBe('C-1');
    const pending = await pendingApprovals({ businessId: BUSINESS });
    expect(pending).toHaveLength(1);
  });
});
