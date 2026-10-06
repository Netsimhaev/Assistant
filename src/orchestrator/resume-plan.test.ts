import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import type { PolicyBundle } from '../domain/policy.js';
import { createJob, loadJob, transition } from './jobs.js';
import type { Job } from './jobs.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import type { AdapterResult, ExternalAdapter } from './adapters/types.js';
import { upsertBinding } from './bindings.js';
import { envCredentials } from './credentials.js';
import { pendingApprovals } from '../governance/approvals.js';
import { applyDecision } from './resume.js';
import { planHashOf } from './plan-store.js';
import { runPlan, runPlanForJob, type RunPlanResult } from './run-plan.js';

const BUSINESS = 'test-business';
/** 12:00 Asia/Jerusalem — outside the fixture's 20:00–07:00 quiet window. */
const NOON = new Date('2026-08-18T09:00:00.000Z');
/** 03:00 Asia/Jerusalem — inside it. */
const NIGHT = new Date('2026-08-19T00:00:00.000Z');
const PREFIX = 'TEST_CRED_';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const WA_CONNECTION: CharterConnection = {
  system: 'office-wa',
  label: 'וואטסאפ המשרד',
  channel: 'api',
  serves: ['wa.send_message'],
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

const WA_LIVE: ConnectionBinding = {
  system: 'office-wa',
  status: 'live',
  endpoint: null,
  credentialRef: null,
  provider: null,
  lastOkAt: null,
  lastError: null,
};

const CREDENTIALS = envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX);

/**
 * A recording mail transport plus a WhatsApp adapter whose availability the
 * test controls. Nothing here opens a socket; the mail count is the side
 * effect every assertion in this file is really about.
 */
function world(): {
  sent: MailMessage[];
  wa: { reachable: boolean; sent: unknown[] };
  registry: AdapterRegistry;
} {
  const sent: MailMessage[] = [];
  const wa = { reachable: false, sent: [] as unknown[] };

  const mail = createMailAdapter({
    system: 'office-mail',
    transport: {
      async send(message) {
        sent.push(message);
        return { messageId: `MSG-${sent.length}` };
      },
    },
  });

  const whatsapp: ExternalAdapter = {
    system: 'office-wa',
    channel: 'api',
    serves: ['wa.send_message'],
    async execute(call): Promise<AdapterResult> {
      if (!wa.reachable) {
        return {
          ok: false,
          retryable: true,
          code: 'wa_unreachable',
          message: 'הגשר אינו זמין כרגע',
        };
      }
      wa.sent.push(call.input);
      return { ok: true, output: null, externalId: 'WA-1' };
    },
  };

  return { sent, wa, registry: new AdapterRegistry([mail, whatsapp]) };
}

/** A mail step followed by a WhatsApp step. `body` varies the plan's hash. */
function twoStepPlan(body = 'שלום'): Plan {
  return Plan.parse({
    goal: 'לענות במייל ואז לעדכן בוואטסאפ',
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'reply',
        toolName: 'mail.send',
        input: { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812', subject: 'שלום', body },
      },
      {
        id: 's2',
        agent: 'comms.whatsapp',
        intent: 'reply',
        toolName: 'wa.send_message',
        input: {
          to: '+972500000000',
          conversationId: 'w1',
          counterpartyId: 'c_812',
          body: 'עדכון קצר',
        },
        dependsOn: ['s1'],
      },
    ],
  });
}

/**
 * `knownCounterpartyEmailDomain: 'b.com'` covers the `a@b.com` recipient the
 * plans here send to, and it is load-bearing rather than decorative: since the
 * first-contact exempt set was emptied (10/09), a `boss` chain no longer skips
 * the escalation, so an address the charter cannot resolve scores
 * `one_unknown` and queues an approval. Every test in this file is about
 * resumption — what re-runs, what is skipped, what the idempotency key
 * protects — and a step that never sends observes none of it.
 *
 * Deliberately NOT extended to `example.com`: the plans that send to
 * `new@example.com` are the ones whose second step is *supposed* to queue.
 */
async function install(connections: CharterConnection[]): Promise<PolicyBundle> {
  return installCharter(buildCharter({ connections, knownCounterpartyEmailDomain: 'b.com' }), { businessId: BUSINESS });
}

async function jobInExecute(bundle: PolicyBundle): Promise<Job> {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  return reload(job.jobId);
}

async function reload(jobId: string): Promise<Job> {
  const loaded = await loadJob(jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

/** What the scheduler does to a job whose wake time has come. */
async function wake(jobId: string): Promise<Job> {
  await transition(jobId, {
    to: 'execute',
    actor: 'system',
    reason: 'wake_at reached',
    businessId: BUSINESS,
  });
  return reload(jobId);
}

function mailsTo(sent: MailMessage[], address: string): number {
  return sent.filter((message) => message.to.includes(address)).length;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('a resumed plan does not re-run what already ran', () => {
  it('sends the first step once across a quiet-hours deferral of the second', async () => {
    const bundle = await install([MAIL_CONNECTION, WA_CONNECTION]);
    const job = await jobInExecute(bundle);
    const { sent, wa, registry } = world();
    const bindings = [MAIL_LIVE, WA_LIVE];
    const run = (j: Job, now: Date): Promise<RunPlanResult> =>
      runPlan({
        job: j,
        bundle,
        plan: twoStepPlan(),
        registry,
        bindings,
        credentials: CREDENTIALS,
        counterpartyTags: [],
        rampLevel: 'auto',
        now,
      });

    // Run 1, in daylight: the mail goes out, the WhatsApp bridge is down and
    // the failure is retryable, so the job sleeps.
    const first = await run(job, NOON);
    expect(first.status).toBe('halted');
    expect(sent).toHaveLength(1);
    expect((await reload(job.jobId)).phase).toBe('followup');

    // Run 2, after the scheduler woke it, in daylight and with the bridge
    // still down. Nothing stops the mail going out a second time except the
    // record that says it already did.
    const second = await run(await wake(job.jobId), NOON);
    expect(sent).toHaveLength(1);
    expect(second.status).toBe('halted');
    if (second.status !== 'halted') throw new Error('unreachable');
    expect(second.at).toBe('s2');
    // The skipped step is still reported, and is distinguishable from one that ran.
    expect(second.steps[0]?.stepId).toBe('s1');
    expect(second.steps[0]?.skipped).toBe(true);

    // Run 3, at 03:00: the second step is now held by quiet hours instead —
    // a different deferral, and still no second mail.
    const third = await run(await wake(job.jobId), NIGHT);
    expect(sent).toHaveLength(1);
    expect(third.status).toBe('halted');
    if (third.status !== 'halted') throw new Error('unreachable');
    expect(third.at).toBe('s2');
    expect(third.reason).toBe('deferred');
    expect(third.steps[0]?.skipped).toBe(true);
    expect((await reload(job.jobId)).wakeAt).not.toBeNull();

    // Run 4, in the morning, with the bridge back.
    wa.reachable = true;
    const fourth = await run(await wake(job.jobId), NOON);
    expect(fourth.status).toBe('done');
    if (fourth.status !== 'done') throw new Error('unreachable');
    expect(fourth.steps.map((record) => record.skipped)).toEqual([true, false]);

    // The whole point: one mail, four runs.
    expect(sent).toHaveLength(1);
    expect(wa.sent).toHaveLength(1);
  });

  it('sends the first step once across an approval on the second', async () => {
    const bundle = await install([MAIL_CONNECTION]);
    const job = await jobInExecute(bundle);
    const { sent, registry } = world();

    // The second step is a first approach to a new address — `email.initiate`,
    // which the charter puts at `approve_required`.
    const plan = Plan.parse({
      goal: 'לענות ואז לפנות ליועץ חדש',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'reply',
          toolName: 'mail.send',
          input: { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812', subject: 'ש', body: 'ג' },
        },
        {
          id: 's2',
          agent: 'comms.email',
          intent: 'initiate',
          toolName: 'mail.send',
          input: { to: 'new@example.com', subject: 'היכרות', body: 'שלום' },
          dependsOn: ['s1'],
        },
      ],
    });

    const run = (j: Job): Promise<RunPlanResult> =>
      runPlan({
        job: j,
        bundle,
        plan,
        registry,
        bindings: [MAIL_LIVE],
        credentials: CREDENTIALS,
        counterpartyTags: [],
        rampLevel: 'auto',
        now: NOON,
      });

    const first = await run(job);
    expect(first.status).toBe('halted');
    if (first.status !== 'halted') throw new Error('unreachable');
    expect(first.at).toBe('s2');
    expect(mailsTo(sent, 'a@b.com')).toBe(1);

    const approvalId = first.steps[1]?.outcome.status === 'awaiting_approval'
      ? first.steps[1]!.outcome.approvalId
      : null;
    if (approvalId === null) throw new Error('expected s2 to queue an approval');

    const decided = await applyDecision(
      approvalId,
      'approved',
      { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS },
    );
    expect(decided.jobPhase).toBe('execute');

    const second = await run(await reload(job.jobId));
    if (second.status === 'rejected') throw new Error(`unexpected rejection: ${second.reason}`);
    expect(second.steps[0]?.skipped).toBe(true);
    // The reply the customer already had must not arrive a second time.
    expect(mailsTo(sent, 'a@b.com')).toBe(1);

    // And what the second step actually does now: it runs. `runPlan` hashes
    // s2's original input, finds the approval `unspentApprovalFor` matched it
    // to, and hands the id to `executeStep`, which spends it instead of
    // recomputing `needsApproval`. Asserted rather than left unsaid: a test
    // that checked only step one would let this branch claim a story it does
    // not deliver.
    expect(second.status).toBe('done');
    expect(second.steps[1]?.outcome.status).toBe('done');
    expect(mailsTo(sent, 'new@example.com')).toBe(1);
    const queuedTwice = await pendingApprovals({ businessId: BUSINESS });
    expect(queuedTwice).toHaveLength(0);
  });

  it('refuses a different plan for a job already mid-flight, and runs nothing', async () => {
    const bundle = await install([MAIL_CONNECTION, WA_CONNECTION]);
    const job = await jobInExecute(bundle);
    const { sent, wa, registry } = world();
    const bindings = [MAIL_LIVE, WA_LIVE];

    const first = await runPlan({
      job,
      bundle,
      plan: twoStepPlan('שלום'),
      registry,
      bindings,
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });
    expect(first.status).toBe('halted');
    expect(sent).toHaveLength(1);

    wa.reachable = true;
    const replanned = await runPlan({
      job: await wake(job.jobId),
      bundle,
      // Same step ids, different content: a re-plan, not a resume.
      plan: twoStepPlan('נוסח אחר לגמרי'),
      registry,
      bindings,
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(replanned.status).toBe('rejected');
    if (replanned.status !== 'rejected') throw new Error('unreachable');
    expect(replanned.code).toBe('plan_changed_mid_flight');
    // Nothing ran: not the step that was already done, and not the one that was not.
    expect(sent).toHaveLength(1);
    expect(wa.sent).toEqual([]);
    expect((await reload(job.jobId)).phase).toBe('execute');
  });

  it('keeps the external id of a completed step across the resume', async () => {
    const bundle = await install([MAIL_CONNECTION, WA_CONNECTION]);
    const job = await jobInExecute(bundle);
    const { wa, registry } = world();
    const bindings = [MAIL_LIVE, WA_LIVE];

    const first = await runPlan({
      job,
      bundle,
      plan: twoStepPlan(),
      registry,
      bindings,
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });
    expect(first.status).toBe('halted');
    if (first.status !== 'halted') throw new Error('unreachable');
    expect(first.steps[0]?.externalId).toBe('MSG-1');

    // Written down, not merely returned: `verify` reads it after the resume.
    const { rows } = await getPool().query<{ step_id: string; external_id: string | null }>(
      'SELECT step_id, external_id FROM job_step_results WHERE job_id = $1',
      [job.jobId],
    );
    expect(rows).toEqual([{ step_id: 's1', external_id: 'MSG-1' }]);

    wa.reachable = true;
    const second = await runPlan({
      job: await wake(job.jobId),
      bundle,
      plan: twoStepPlan(),
      registry,
      bindings,
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(second.status).toBe('done');
    if (second.status !== 'done') throw new Error('unreachable');
    expect(second.steps[0]?.skipped).toBe(true);
    expect(second.steps[0]?.externalId).toBe('MSG-1');
  });
});

describe('the real entry point closes the approval loop, not only runPlan called directly', () => {
  it('performs the approved step exactly once through runPlanForJob, and queues nothing twice', async () => {
    // Every other test in this file (and in approved-step.test.ts) either
    // calls `executeStep` directly or injects `bindings` by hand. Neither
    // exercises `runPlanForJob` — the actual production entry point that
    // loads bindings from the store and is what a resumed job is really
    // handed back to. This is the gap a review found: `runPlan` never passed
    // `approvalId` through, so this exact path queued a second approval
    // forever no matter how many times a human said yes.
    const bundle = await install([MAIL_CONNECTION]);
    await upsertBinding(MAIL_LIVE, { businessId: BUSINESS, by: 'p_boss' });
    const job = await jobInExecute(bundle);
    const { sent, registry } = world();

    // A first approach to a new address — `email.initiate`, `approve_required`
    // in the fixture charter.
    const plan = Plan.parse({
      goal: 'לפנות ליועץ חדש',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'initiate',
          toolName: 'mail.send',
          input: { to: 'new@example.com', subject: 'היכרות', body: 'שלום' },
        },
      ],
    });

    const run = (j: Job): Promise<RunPlanResult> =>
      runPlanForJob({
        job: j,
        bundle,
        plan,
        registry,
        credentials: CREDENTIALS,
        counterpartyTags: [],
        rampLevel: 'auto',
        now: NOON,
      });

    const first = await run(job);
    expect(first.status).toBe('halted');
    if (first.status !== 'halted') throw new Error('unreachable');
    expect(first.steps[0]?.outcome.status).toBe('awaiting_approval');
    expect(sent).toHaveLength(0);

    const approvalId =
      first.steps[0]?.outcome.status === 'awaiting_approval'
        ? first.steps[0].outcome.approvalId
        : null;
    if (approvalId === null) throw new Error('expected s1 to queue an approval');

    const decided = await applyDecision(
      approvalId,
      'approved',
      { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS },
    );
    expect(decided.jobPhase).toBe('execute');

    const second = await run(await reload(job.jobId));

    expect(second.status).toBe('done');
    if (second.status !== 'done') throw new Error('unreachable');
    expect(second.steps[0]?.outcome.status).toBe('done');
    // The whole point: it actually ran, exactly once.
    expect(sent).toHaveLength(1);
    expect(mailsTo(sent, 'new@example.com')).toBe(1);
    // And nothing asked the boss again.
    expect(await pendingApprovals({ businessId: BUSINESS })).toHaveLength(0);
  });
});

describe('nothing is bound until the job can actually run', () => {
  it('refuses a job that is not in execute without binding its plan', async () => {
    // The race that loses a customer's work: `runPlanForJob` arrives a
    // millisecond after the scheduler parked the job in `followup`. Binding
    // first and checking the phase per-step later left the job tied forever to
    // a plan that never ran, and nothing deletes a `job_plans` row.
    const bundle = await install([MAIL_CONNECTION, WA_CONNECTION]);
    const job = await jobInExecute(bundle);
    const { sent, wa, registry } = world();
    const bindings = [MAIL_LIVE, WA_LIVE];

    await transition(job.jobId, {
      to: 'followup',
      actor: 'system',
      reason: 'parked a moment before the run arrived',
      wakeAt: NOON,
      businessId: BUSINESS,
    });

    const parked = await runPlan({
      job: await reload(job.jobId),
      bundle,
      plan: twoStepPlan('תוכנית שלא רצה מעולם'),
      registry,
      bindings,
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(parked.status).toBe('rejected');
    if (parked.status !== 'rejected') throw new Error('unreachable');
    expect(parked.code).toBe('job_not_executable');
    expect(sent).toEqual([]);

    // Nothing was written down, so the job is not tied to anything.
    const { rows } = await getPool().query('SELECT 1 FROM job_plans WHERE job_id = $1', [
      job.jobId,
    ]);
    expect(rows).toHaveLength(0);

    // The job then wakes legitimately and runs its real plan.
    wa.reachable = true;
    const real = await runPlan({
      job: await wake(job.jobId),
      bundle,
      plan: twoStepPlan(),
      registry,
      bindings,
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });
    expect(real.status).toBe('done');
    expect(sent).toHaveLength(1);
  });
});

describe('re-planning is refused only over work that happened', () => {
  it('replaces the binding when the first plan executed nothing', async () => {
    // A step-one failure is when re-planning is most useful and completely
    // safe. Refusing it forced a caller to reproduce the original plan byte
    // for byte to recover.
    const bundle = await install([MAIL_CONNECTION, WA_CONNECTION]);
    const job = await jobInExecute(bundle);
    const { sent, registry } = world();
    const bindings = [MAIL_LIVE, WA_LIVE];

    const waOnly = Plan.parse({
      goal: 'לעדכן בוואטסאפ',
      steps: [
        {
          id: 's1',
          agent: 'comms.whatsapp',
          intent: 'reply',
          toolName: 'wa.send_message',
          input: {
            to: '+972500000000',
            conversationId: 'w1',
            counterpartyId: 'c_812',
            body: 'עדכון',
          },
        },
      ],
    });

    // The bridge is down, so the only step defers and records nothing.
    const first = await runPlan({
      job,
      bundle,
      plan: waOnly,
      registry,
      bindings,
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });
    expect(first.status).toBe('halted');
    const { rows: none } = await getPool().query(
      'SELECT 1 FROM job_step_results WHERE job_id = $1',
      [job.jobId],
    );
    expect(none).toHaveLength(0);

    // A different plan entirely — reach the customer by mail instead.
    const mailOnly = Plan.parse({
      goal: 'לענות במייל במקום',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'reply',
          toolName: 'mail.send',
          input: { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812', subject: 'ש', body: 'ג' },
        },
      ],
    });

    const second = await runPlan({
      job: await wake(job.jobId),
      bundle,
      plan: mailOnly,
      registry,
      bindings,
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(second.status).toBe('done');
    expect(sent).toHaveLength(1);

    // The job is bound to the new plan now, not the abandoned one.
    const { rows } = await getPool().query<{ plan_hash: string }>(
      'SELECT plan_hash FROM job_plans WHERE job_id = $1',
      [job.jobId],
    );
    expect(rows[0]?.plan_hash).toBe(planHashOf(mailOnly));
  });
});

describe('a run that performs nothing still leaves a phase a caller can act on', () => {
  it('moves to verify when every step was already recorded', async () => {
    const bundle = await install([MAIL_CONNECTION, WA_CONNECTION]);
    const job = await jobInExecute(bundle);
    const { wa, registry } = world();
    wa.reachable = true;
    const bindings = [MAIL_LIVE, WA_LIVE];
    const run = (j: Job): Promise<RunPlanResult> =>
      runPlan({
        job: j,
        bundle,
        plan: twoStepPlan(),
        registry,
        bindings,
        credentials: CREDENTIALS,
        counterpartyTags: [],
        rampLevel: 'auto',
        now: NOON,
      });

    expect((await run(job)).status).toBe('done');
    expect((await reload(job.jobId)).phase).toBe('verify');

    // The same plan handed back once more — every step is on record.
    await transition(job.jobId, {
      to: 'execute',
      actor: 'orchestrator',
      reason: 'handed the same plan again',
      businessId: BUSINESS,
    });
    const again = await run(await reload(job.jobId));
    expect(again.status).toBe('done');
    if (again.status !== 'done') throw new Error('unreachable');
    expect(again.steps.every((record) => record.skipped)).toBe(true);

    // `execute` is not a phase a finished plan may sit in: LEGAL_TRANSITIONS
    // has no edge from it to `closed`, so a caller acting on this `done` would
    // throw on its next move.
    expect((await reload(job.jobId)).phase).toBe('verify');
    await expect(
      transition(job.jobId, {
        to: 'remember',
        actor: 'orchestrator',
        reason: 'the caller carries on',
        businessId: BUSINESS,
      }),
    ).resolves.toBeTruthy();
  });
});

describe('a completion belongs to one job and one plan', () => {
  it('does not let one job skip another job’s step of the same id', async () => {
    // The two jobs run the IDENTICAL plan — two requests that came out the
    // same, which is ordinary. Identical means identical hashes, so the job is
    // the only thing separating their completions; a lookup that forgot it
    // would have the second job report the first one's work as its own and
    // send nothing.
    const bundle = await install([MAIL_CONNECTION, WA_CONNECTION]);
    const { sent, registry } = world();
    const bindings = [MAIL_LIVE, WA_LIVE];
    const run = (job: Job): Promise<RunPlanResult> =>
      runPlan({
        job,
        bundle,
        plan: twoStepPlan(),
        registry,
        bindings,
        credentials: CREDENTIALS,
        counterpartyTags: [],
        rampLevel: 'auto',
        now: NOON,
      });

    await run(await jobInExecute(bundle));
    expect(sent).toHaveLength(1);

    await run(await jobInExecute(bundle));

    // `s1` is done for the first job. That says nothing about the second one.
    expect(sent).toHaveLength(2);
  });

  it('does not let a completion recorded under another plan hash cause a skip', async () => {
    // The refusal in `bindPlanToJob` is the first barrier; the plan hash on the
    // result row is the second, independent one. Written directly because that
    // is the state the column exists to be safe against — a completion from a
    // plan that is not the one now running.
    const bundle = await install([MAIL_CONNECTION, WA_CONNECTION]);
    const job = await jobInExecute(bundle);
    const { sent, registry } = world();

    await getPool().query(
      `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, external_id)
       VALUES ($1, $2, 'a-hash-from-some-other-plan', 's1', 'MSG-STALE')`,
      [BUSINESS, job.jobId],
    );

    await runPlan({
      job,
      bundle,
      plan: twoStepPlan(),
      registry,
      bindings: [MAIL_LIVE, WA_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    // The stale row belongs to a different plan, so `s1` is still this plan's
    // work to do.
    expect(sent).toHaveLength(1);
  });
});

describe('the completion and the transition it belongs to are one write', () => {
  it('does not advance the phase when the completion cannot be recorded', async () => {
    const bundle = await install([MAIL_CONNECTION]);
    const job = await jobInExecute(bundle);
    const { sent, registry } = world();

    // Force the failure the window would otherwise hide: the step's result
    // cannot be written. If the completion were a second write after the
    // transition, the job would already be in `verify` — recorded as having
    // made progress it has no record of, and certain to re-run the step.
    await getPool().query(`
      CREATE FUNCTION refuse_step_result() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_step_result BEFORE INSERT ON job_step_results
        FOR EACH ROW EXECUTE FUNCTION refuse_step_result();
    `);

    try {
      await expect(
        runPlan({
          job,
          bundle,
          plan: Plan.parse({
            goal: 'לענות ללקוח',
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
                  subject: 'ש',
                  body: 'ג',
                },
              },
            ],
          }),
          registry,
          bindings: [MAIL_LIVE],
          credentials: CREDENTIALS,
          counterpartyTags: [],
          rampLevel: 'auto',
          now: NOON,
        }),
      ).rejects.toThrow(/injected failure/);

      // The mail did go out — nothing can undo that, and the docblock on
      // `recordStepCompletion` says so. What must not happen is the job
      // claiming progress the results table does not carry.
      expect(sent).toHaveLength(1);
      expect((await reload(job.jobId)).phase).toBe('execute');
      const { rows } = await getPool().query('SELECT 1 FROM job_step_results WHERE job_id = $1', [
        job.jobId,
      ]);
      expect(rows).toHaveLength(0);
    } finally {
      await getPool().query(`
        DROP TRIGGER refuse_step_result ON job_step_results;
        DROP FUNCTION refuse_step_result();
      `);
    }
  });
});

describe('a dispatched call whose outcome nobody knows is not "nothing ran"', () => {
  /**
   * A mail adapter that accepts the call and then stalls past the deadline,
   * until the test lets it answer. It records the idempotency key of every
   * dispatch, which is the thing the far end would deduplicate on.
   */
  function stalling(): {
    dispatched: string[];
    state: { hang: boolean };
    registry: AdapterRegistry;
  } {
    const dispatched: string[] = [];
    const state = { hang: true };
    const adapter: ExternalAdapter = {
      system: 'office-mail',
      channel: 'api',
      serves: ['mail.send'],
      async execute(call): Promise<AdapterResult> {
        dispatched.push(call.idempotencyKey);
        if (state.hang) {
          // The supplier took the order and went quiet. Nothing here can say
          // whether it landed.
          return new Promise<AdapterResult>(() => {
            /* never settles */
          });
        }
        return { ok: true, output: null, externalId: 'MSG-LATE' };
      },
    };
    return { dispatched, state, registry: new AdapterRegistry([adapter]) };
  }

  function orderPlan(body: string): Plan {
    return Plan.parse({
      goal: 'להזמין מהספק',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'reply',
          toolName: 'mail.send',
          input: { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812', subject: 'הזמנה', body },
        },
      ],
    });
  }

  async function timedOut(): Promise<{
    job: Job;
    bundle: PolicyBundle;
    dispatched: string[];
    state: { hang: boolean };
    registry: AdapterRegistry;
  }> {
    const bundle = await install([MAIL_CONNECTION]);
    const job = await jobInExecute(bundle);
    const { dispatched, state, registry } = stalling();

    const first = await runPlan({
      job,
      bundle,
      plan: orderPlan('הזמנה ראשונה'),
      registry,
      bindings: [MAIL_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
      adapterTimeoutMs: 25,
    });

    expect(first.status).toBe('halted');
    if (first.status !== 'halted') throw new Error('unreachable');
    expect(first.reason).toBe('deferred');
    expect(dispatched).toHaveLength(1);

    // The row that says "we do not know", written with the move to followup.
    // `performed` is `null`, not `false` — ruling 4 (task 8, fix round 1): a
    // timeout carries no claim either way, and `false` here would be a value
    // nobody actually read off anything.
    const { rows } = await getPool().query<{
      status: string;
      external_id: string | null;
      performed: boolean | null;
    }>(
      'SELECT status, external_id, performed FROM job_step_results WHERE job_id = $1',
      [job.jobId],
    );
    expect(rows).toEqual([{ status: 'unknown', external_id: null, performed: null }]);

    return { job, bundle, dispatched, state, registry };
  }

  it('re-runs the step on a same-plan resume, under the identical idempotency key', async () => {
    const { job, bundle, dispatched, state, registry } = await timedOut();

    // The far end can answer now.
    state.hang = false;
    const second = await runPlan({
      job: await wake(job.jobId),
      bundle,
      plan: orderPlan('הזמנה ראשונה'),
      registry,
      bindings: [MAIL_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
      adapterTimeoutMs: 25,
    });

    expect(second.status).toBe('done');
    if (second.status !== 'done') throw new Error('unreachable');
    // Re-run, NOT skipped: the step may never have happened.
    expect(second.steps[0]?.skipped).toBe(false);
    expect(dispatched).toHaveLength(2);
    // The one defence that works here — same job, same step id, same input,
    // so the far end sees the same key and can deduplicate.
    expect(dispatched[1]).toBe(dispatched[0]);

    // The unknown row was promoted rather than left to re-run forever —
    // `performed` along with `status`, from `null` to the real boolean the
    // successful resume actually knows (ruling 5).
    const { rows } = await getPool().query<{
      status: string;
      external_id: string | null;
      performed: boolean | null;
    }>(
      'SELECT status, external_id, performed FROM job_step_results WHERE job_id = $1',
      [job.jobId],
    );
    expect(rows).toEqual([{ status: 'completed', external_id: 'MSG-LATE', performed: true }]);
  });

  it('refuses a different plan over it, because the key that protects it would change', async () => {
    const { job, bundle, dispatched, state, registry } = await timedOut();
    state.hang = false;

    const replanned = await runPlan({
      job: await wake(job.jobId),
      bundle,
      // The planner reworded the order. Different input, therefore a different
      // idempotency key, therefore no deduplication at the supplier — and the
      // first order may well have landed.
      plan: orderPlan('הזמנה מנוסחת מחדש'),
      registry,
      bindings: [MAIL_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
      adapterTimeoutMs: 25,
    });

    expect(replanned.status).toBe('rejected');
    if (replanned.status !== 'rejected') throw new Error('unreachable');
    expect(replanned.code).toBe('plan_changed_mid_flight');
    // Nothing was dispatched a second time.
    expect(dispatched).toHaveLength(1);
  });
});
