import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection } from '../domain/connection.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { upsertBinding } from './bindings.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, transition } from './jobs.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { setDigestSettings } from '../governance/digest-settings.js';
import { bindPlanToJob } from './plan-store.js';
import { loadRampLevel, setRampLevel } from './ramp.js';
import { recentDigests } from './digest-store.js';
import { schedulerPass } from './scheduler.js';
import type { Runtime } from './runtime.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';
// Fixed clock, matching run-due.test.ts: an evening wall-clock run of this
// suite would otherwise fall inside quiet hours and change what the test is
// actually asserting.
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
  goal: 'send one mail',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the confirmation',
      toolName: 'mail.send',
      // `counterpartyId: 'c_812'` matches the known counterparty `buildCharter`
      // (`test/fixtures.ts`) always includes. Without it the gate scores this
      // as `one_unknown` (`scoreVisibility`, `policy/risk.ts`) and queues an
      // approval regardless of autonomy or ramp.
      input: { to: 'dana@example.com', counterpartyId: 'c_812', subject: 'נושא', body: 'גוף' },
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
            return { messageId: 'MSG-1' };
          },
        },
      }),
    ]),
    credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
    warnings: [],
  };
}

describe('schedulerPass', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('wakes a sleeping job and runs its plan in the same pass', async () => {
    const bundle = await installCharter(
      buildCharter({
        connections: [MAIL_CONNECTION],
        // The recipient must resolve by DOMAIN: since the first-contact exempt
        // set was emptied (10/09), a boss chain no longer skips the
        // escalation, and an unresolved address would queue an approval —
        // which is not what this file is about.
        knownCounterpartyEmailDomain: 'example.com',
        autonomyBase: { 'email.initiate': 'auto' },
      }),
      { businessId: BUSINESS },
    );
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'wake and run',
    });
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }
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
    await bindPlanToJob(job.jobId, PLAN, { businessId: BUSINESS });
    // The owner's dial (Task 2) defaults to `off`, which clamps
    // `loadRampLevel` to `draft_only` regardless of what is stored — open it
    // first so the promotion below is actually honoured.
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    // Park it asleep, due as of NOON — the same fixed clock passed to
    // `schedulerPass` below, so `tick`'s `wake_at <= now` check finds it
    // regardless of the real wall clock.
    await transition(job.jobId, {
      to: 'followup',
      actor: 'orchestrator',
      reason: 'parked',
      wakeAt: new Date(NOON.getTime() - 1000),
      businessId: BUSINESS,
    });

    const sent: MailMessage[] = [];
    const pass = await schedulerPass({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(pass.tick.wokenJobs).toContain(job.jobId);
    expect(pass.due.ran.map((r) => r.jobId)).toContain(job.jobId);
    expect(sent).toHaveLength(1);
  });

  it('carries a job it just finished all the way to closed, in the same pass', async () => {
    // `runDueJobs` parks a finished job in `verify`. Before `closeVerifiedJobs`
    // was wired in after it, that was the end of the line: nothing in
    // production read `verify`, so every job the engine completed stayed there
    // for good. Ordering the close after the run — rather than before it — is
    // what lets one pass take a job from `execute` to `closed`.
    const bundle = await installCharter(
      buildCharter({
        connections: [MAIL_CONNECTION],
        // The recipient must resolve by DOMAIN: since the first-contact exempt
        // set was emptied (10/09), a boss chain no longer skips the
        // escalation, and an unresolved address would queue an approval —
        // which is not what this file is about.
        knownCounterpartyEmailDomain: 'example.com',
        autonomyBase: { 'email.initiate': 'auto' },
      }),
      { businessId: BUSINESS },
    );
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'run and close',
    });
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }
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
    await bindPlanToJob(job.jobId, PLAN, { businessId: BUSINESS });
    // The owner's dial (Task 2) defaults to `off`, which clamps
    // `loadRampLevel` to `draft_only` regardless of what is stored — open it
    // first so the promotion below is actually honoured.
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const pass = await schedulerPass({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(sent).toHaveLength(1);
    expect(pass.verified.closed).toContain(job.jobId);
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('closed');
    // Shadow mode (H3): the step this very pass performed on its own is
    // reported in the same pass — the stage runs after the plans. No notify
    // seam on this runtime, and email is a default channel, so the send is
    // recorded as not connected rather than silenced.
    expect(pass.actionUpdatesError).toBeNull();
    expect(pass.actionUpdates).toEqual({
      written: 1,
      emailFailed: 0,
      whatsappFailed: 0,
      skippedNotConnected: 1,
    });
  });

  /**
   * Spec §10 — the autonomy pass runs LAST, and the ordering is asserted with
   * evidence this very pass produces rather than with a claim about call
   * order.
   *
   * The job fails inside `runDueJobs` (a credential ref that resolves to
   * nothing — final, not retryable, `run-plan.ts`), and §6.1 makes a job that
   * ended in `failed` a demotion signal. So the class can only come down if
   * the evaluation looks after the plans have run. Move `evaluateAutonomy`
   * above `runDueJobs` — or replace it with a literal — and `demoted` is
   * empty and the stored row stays `auto_notify`.
   */
  it('demotes a class on a job that failed in this same pass', async () => {
    const bundle = await installCharter(
      buildCharter({
        connections: [MAIL_CONNECTION],
        knownCounterpartyEmailDomain: 'example.com',
        autonomyBase: { 'email.initiate': 'auto' },
      }),
      { businessId: BUSINESS },
    );
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'run and fail',
    });
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        // A ref the credential source below cannot resolve. `run-plan.ts`
        // treats that as a misconfiguration and therefore NOT retryable, so
        // the job lands in `failed` rather than sleeping in `followup`.
        credentialRef: 'OFFICE_MAIL',
        provider: null,
        lastOkAt: null,
        lastError: null,
      },
      { businessId: BUSINESS, by: 'test' },
    );
    await bindPlanToJob(job.jobId, PLAN, { businessId: BUSINESS });
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    // The rung a class can actually fall from. `auto` would be clamped to
    // `auto_notify` on read anyway; writing the level the demotion expects
    // makes what is being tested explicit.
    await setRampLevel('email.initiate', 'auto_notify', { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const pass = await schedulerPass({
      businessId: BUSINESS,
      runtime: {
        registry: new AdapterRegistry([
          createMailAdapter({
            system: 'office-mail',
            transport: {
              async send(message) {
                sent.push(message);
                return { messageId: 'MSG-1' };
              },
            },
          }),
        ]),
        // Nothing provisioned: the ref above resolves to null.
        credentials: envCredentials({}, PREFIX),
        warnings: [],
      },
      now: NOON,
      inbox: null,
    });

    // The failure really happened in this pass, and nothing was sent.
    expect(sent).toHaveLength(0);
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('failed');
    // And the evaluation that ran after it saw the failure.
    expect(pass.autonomyError).toBeNull();
    expect(pass.autonomy.demoted).toContain('email.initiate');
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe(
      'approve_required',
    );
  });

  /**
   * Task 6, mutation check — the digest must run AFTER `runDueJobs`, not
   * before it.
   *
   * `waiting.approvals` in `digest-facts.ts` is POINT-IN-TIME, not
   * window-scoped (spec §3.1) — it counts whatever is `pending` the moment
   * the digest looks, with no window arithmetic to get wrong. So this needs
   * no clock trick: the approval this very pass raises either already
   * exists in `approval_requests` by the time `runDigests` queries it, or it
   * does not, purely as a function of which runs first within THIS pass.
   */
  it('counts an approval this very pass just raised', async () => {
    const bundle = await installCharter(
      buildCharter({
        connections: [MAIL_CONNECTION],
        knownCounterpartyEmailDomain: 'example.com',
      }),
      { businessId: BUSINESS },
    );
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'needs approval',
    });
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }
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
    await bindPlanToJob(job.jobId, PLAN, { businessId: BUSINESS });
    // `ask` clamps floor AND ceiling to `approve_required` for every class —
    // the plan step must queue an approval rather than send or sit in draft.
    await setAutonomyMode('ask', 'owner@example.com', { businessId: BUSINESS });
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: false, toWhatsApp: false },
      'owner',
      { businessId: BUSINESS },
    );

    const sent: MailMessage[] = [];
    const pass = await schedulerPass({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    // The step really ran and queued an approval, and nothing went out.
    expect(pass.due.ran.map((r) => r.jobId)).toContain(job.jobId);
    expect(sent).toHaveLength(0);
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('await_approval');
    const stored = await recentDigests({ businessId: BUSINESS });
    expect(stored).toHaveLength(1);
    // Distinctive: this exact count-and-label only appears when
    // `waiting.approvals` is 1, and only `digest-render.ts`'s §3.1 block
    // writes it.
    expect(stored[0]?.body).toContain('1 אישורים שלא הוכרעו');
  });
});
