import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection } from '../domain/connection.js';
import type { AgentEnvelope } from '../domain/envelope.js';
import type { ApprovalNotifier } from '../governance/notify.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { attachChildJob, writeEnvelope } from '../governance/envelope-store.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { upsertBinding } from './bindings.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, transition } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';
import { setRampLevel } from './ramp.js';
import { runDueJobs } from './run-due.js';
import type { Runtime } from './runtime.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';
// Fixed clock, matching the pattern in external.test.ts: an evening wall-clock
// run of this suite would otherwise fall inside quiet hours and change what
// the test is actually asserting.
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
      // `counterpartyId: 'c_812'` matches the known counterparty
      // `buildCharter` (`test/fixtures.ts`) always includes — and, as of
      // 10/09, that is NOT what keeps this send out of the approval queue.
      // `scoreVisibility` (`policy/risk.ts`) refuses to let identity evidence
      // stand in for an address on a class that reaches a `person`, so the
      // recipient has to resolve by DOMAIN; the charter below declares it.
      // Until the first-contact exempt set was emptied this was invisible,
      // because a `boss` chain came out `routine` no matter who it addressed,
      // and this comment claimed the id was doing work it never did.
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

/** A job in `execute`, via the real transition chain: intake → understand → plan → execute. */
async function jobInExecute(
  charterVersion: string,
  title: string,
  businessId: string = BUSINESS,
): Promise<string> {
  const job = await createJob({
    charterVersion,
    provenance: 'boss',
    businessId,
    title,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId });
  }
  return job.jobId;
}

/** Everything a real production caller would have already done for one business. */
async function seedExecutableJob(businessId: string = BUSINESS): Promise<string> {
  // `installCharter` returns the compiled PolicyBundle directly — its
  // `charterVersion` field is the job's, not a `{ charterVersion, bundle }`
  // wrapper the brief's draft assumed.
  //
  // `autonomyBase` for `email.initiate` defaults to `approve_required`
  // (`test/fixtures.ts`), and `effectiveAutonomy` (`policy/engine.ts`) takes
  // the MOST restrictive of every ceiling that applies — base autonomy,
  // provenance ceiling, and the ramp — never just the ramp alone. Overriding
  // it here to `auto` is what makes "the ramp is the only thing standing
  // between draft_only and a real send" actually true in the "honours the
  // ramp" test below: with this override in place, `setRampLevel(..., 'auto')`
  // is the ONLY thing that changes between that test and this one.
  const bundle = await installCharter(
    buildCharter({
      // `charter_versions` keys on `charter_version` alone, globally, not
      // per business — the version must be unique across every call this
      // test file makes within one test, not just within one business.
      version: `2026-08-15.${businessId}`,
      connections: [MAIL_CONNECTION],
      knownCounterpartyEmailDomain: 'example.com',
      autonomyBase: { 'email.initiate': 'auto' },
    }),
    { businessId },
  );
  const jobId = await jobInExecute(bundle.charterVersion, 'run-due', businessId);
  await upsertBinding(
    {
      system: 'office-mail',
      status: 'live',
      endpoint: null,
      credentialRef: 'OFFICE_MAIL',
      lastOkAt: null,
      lastError: null,
    },
    { businessId, by: 'test' },
  );
  await bindPlanToJob(jobId, PLAN, { businessId });
  return jobId;
}

describe('runDueJobs', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('does nothing when no job is in execute', async () => {
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith([]), now: NOON });
    expect(result.ran).toEqual([]);
  });

  it('runs a job that is in execute with a stored plan', async () => {
    const jobId = await seedExecutableJob();
    // The owner's dial (Task 2) defaults to `off`, which clamps
    // `loadRampLevel` to `draft_only` regardless of what is stored — open it
    // first so the promotion below is actually honoured.
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(result.ran.map((r) => r.jobId)).toEqual([jobId]);
    expect(result.ran[0]?.status).toBe('done');
    expect(sent).toHaveLength(1);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('verify');
  });

  it('forwards runtime.notify into runPlanForJob, so a queued approval actually notifies the owner', async () => {
    // A dedicated charter with `approve_required` as the BASE autonomy for
    // `email.initiate` (not `seedExecutableJob`'s `auto`), so this test's
    // path to `queue_approval` does not depend on `PLAN`'s recipient being an
    // unknown counterparty — it is forced by autonomy alone, the same as the
    // `queues approval and notifies` scenario `notify-wiring.test.ts` drives
    // straight through `runPlan`. This test exists because that one does
    // not: `runPlan` is handed a `notify` literal directly there, so it
    // cannot catch `run-due.ts` failing to forward `runtime.notify` at all.
    // `runtimeWith` above never sets `notify` either — deleting the
    // forwarding line in `run-due.ts` leaves every other test in this file
    // green.
    const bundle = await installCharter(
      buildCharter({
        version: `2026-08-15.notify-forward`,
        connections: [MAIL_CONNECTION],
        knownCounterpartyEmailDomain: 'example.com',
        autonomyBase: { 'email.initiate': 'approve_required' },
      }),
      { businessId: BUSINESS },
    );
    const jobId = await jobInExecute(bundle.charterVersion, 'notify-forward');
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        credentialRef: 'OFFICE_MAIL',
        lastOkAt: null,
        lastError: null,
      },
      { businessId: BUSINESS, by: 'test' },
    );
    await bindPlanToJob(jobId, PLAN, { businessId: BUSINESS });
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'approve_required', { businessId: BUSINESS });

    const notified: string[] = [];
    const notifier: ApprovalNotifier = {
      channel: 'email',
      async notify(request) {
        notified.push(request.approvalId);
        return { ok: true };
      },
    };
    const runtime: Runtime = {
      ...runtimeWith([]),
      notify: { notifier, dashboardBaseUrl: 'http://127.0.0.1:8787' },
    };

    const result = await runDueJobs({ businessId: BUSINESS, runtime, now: NOON });

    expect(result.ran).toEqual([{ jobId, status: 'halted', detail: 'awaiting_approval' }]);
    expect(notified).toHaveLength(1);
  });

  it('reports a job in execute that is bound to no plan, and does not run it', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'example.com' }), {
      businessId: BUSINESS,
    });
    const jobId = await jobInExecute(bundle.charterVersion, 'unbound');

    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith([]), now: NOON });
    expect(result.unbound).toEqual([jobId]);
    expect(result.ran).toEqual([]);
  });

  // I2: an unbound job used to be reported and then left exactly where it
  // was. `updated_at` never moved, so under `ORDER BY updated_at ASC LIMIT 20`
  // it sorted first on every pass afterwards, forever. Twenty of them and the
  // window is permanently full of rows nothing can advance, and no genuinely
  // runnable job of that business is ever reached again. The conductor is the
  // first production producer of unbound `execute` jobs — every approved
  // conductor card lands here — so this went from a documented hypothetical
  // to a certainty.
  it('moves an unbound job out of execute so it cannot hold the window forever', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'example.com' }), {
      businessId: BUSINESS,
    });
    const jobId = await jobInExecute(bundle.charterVersion, 'unbound-twice');

    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith([]), now: NOON });

    const job = await loadJob(jobId, { businessId: BUSINESS });
    expect(job?.phase).toBe('failed');
    expect(job?.closedAt).not.toBeNull();

    // The point of the disposition, stated as behaviour: a second pass does
    // not find it at all. Without the transition this assertion fails — the
    // row is still in `execute` and still first in line.
    const second = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith([]), now: NOON });
    expect(second.unbound).toEqual([]);

    // And the reason is on the record, not only in the returned bucket.
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM job_steps WHERE job_id = $1 AND to_phase = 'failed'`,
      [jobId],
    );
    expect(rows[0]?.reason).toContain('no_plan_bound');
  });

  /**
   * I1, and the same starvation the `unbound` bucket above already fixed for
   * its own case — reached by a different door.
   *
   * `instruct.ts` pre-checks everything that needs no database (allowlist,
   * class mismatch) precisely so a bad plan fails once in `understand`. What
   * it cannot pre-check is what needs bindings and the registry:
   * `no_channel_for_tool`, `ambiguous_channel`, `no_adapter_for_system`.
   * Those surface only here, and a `rejected` outcome used to be pushed into
   * `ran` with the phase left exactly where it was — `updated_at` frozen,
   * first in line under `ORDER BY updated_at ASC` on every pass forever.
   *
   * The scenario is the owner's, not a contrivance: no WhatsApp connection in
   * the charter, "תשלחי לדנה וואטסאפ", the plan binds, `resolveChannel`
   * returns `no_channel` on this pass and on every pass after it.
   */
  it('moves a rejected job out of execute so it cannot hold the window forever', async () => {
    // A charter with no connection serving `mail.send` at all — so
    // `resolveChannel` has nothing to match and `runPlan` rejects with
    // `no_channel_for_tool`, the rejection `instruct.ts` cannot pre-check.
    const bundle = await installCharter(
      buildCharter({ version: '2026-08-15.no-channel', connections: [], autonomyBase: { 'email.initiate': 'auto' } }),
      { businessId: BUSINESS },
    );
    const jobId = await jobInExecute(bundle.charterVersion, 'no-channel');
    await bindPlanToJob(jobId, PLAN, { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const first = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    // The positive half first: the job really did reach `runPlan` and really
    // was rejected there. Without it the phase assertion below would hold for
    // a job that was never picked up at all.
    expect(first.ran).toEqual([{ jobId, status: 'rejected', detail: 'no_channel_for_tool' }]);
    expect(sent).toHaveLength(0);

    const job = await loadJob(jobId, { businessId: BUSINESS });
    expect(job?.phase).toBe('failed');
    expect(job?.closedAt).not.toBeNull();

    // The disposition stated as behaviour: a second pass does not find it.
    const second = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith([]), now: NOON });
    expect(second.ran).toEqual([]);

    // And the rejection code is on the record, not only in the bucket.
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM job_steps WHERE job_id = $1 AND to_phase = 'failed'`,
      [jobId],
    );
    expect(rows[0]?.reason).toContain('no_channel_for_tool');
  });

  it('honours the ramp: with no ramp row the send is capped and no mail goes out', async () => {
    const jobId = await seedExecutableJob();
    // No setRampLevel call at all — the floor is draft_only, which must be
    // enough on its own to stop the send. Everything else here (the live
    // binding, the working adapter, the credential) is set up correctly, so
    // asserting the halt reason is `draft_only` — not, say, a missing
    // credential or a channel that never resolved — is what proves the ramp
    // ceiling is the thing actually stopping the send.
    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });
    expect(sent).toEqual([]);
    expect(result.ran).toEqual([{ jobId, status: 'halted', detail: 'draft_only:persist_as_draft' }]);
  });

  it('does not run a job belonging to another business', async () => {
    // Two real, independently executable jobs, one per business, seeded in
    // this order so `jobIdHome` (BUSINESS) is strictly older by `updated_at`
    // than `jobIdOther` (OTHER_BUSINESS). Combined with `limit: 1` below,
    // this is deliberately the setup that makes the outer query's own
    // `business_id` filter — and not only `loadJob`'s downstream business
    // scoping — load-bearing: without that filter, the outer SELECT would
    // return `jobIdHome` (older, wrong business) instead of `jobIdOther`
    // within the limit, and `jobIdOther` would never even be fetched to
    // attempt. A version of this test that only asserted "the wrong job
    // never appears in `ran`" passed even with the filter stripped, because
    // `loadJob(jobIdHome, { businessId: OTHER_BUSINESS })` returns null and
    // is silently skipped either way — that check alone cannot tell a
    // present filter from an absent one. Asserting the RIGHT job DID run,
    // under a `limit` that a foreign, older row can crowd out, is what
    // makes a stripped filter visible. See the task-5 report's "Fix round 1"
    // section for the exact failure this produced when verified.
    const OTHER_BUSINESS = 'other-business';
    const jobIdHome = await seedExecutableJob(BUSINESS);
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    const jobIdOther = await seedExecutableJob(OTHER_BUSINESS);
    await setAutonomyMode('learn', 'owner@example.com', { businessId: OTHER_BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: OTHER_BUSINESS });

    const sent: MailMessage[] = [];
    const result = await runDueJobs({
      businessId: OTHER_BUSINESS,
      runtime: runtimeWith(sent),
      now: NOON,
      limit: 1,
    });

    expect(result.ran.map((r) => r.jobId)).toEqual([jobIdOther]);
    expect(result.ran.map((r) => r.jobId)).not.toContain(jobIdHome);
    expect(sent).toHaveLength(1);
  });

  it('isolates a job whose stored plan cannot be parsed, and still runs a healthy job in the same pass', async () => {
    // The poison-pill job is created FIRST, so it sorts before the healthy
    // job under `ORDER BY updated_at ASC` — the exact ordering the Important
    // defect exploited: a job that can never advance sorts first on every
    // pass, so an unisolated throw here would have stopped the healthy job
    // from ever being reached, on this pass and every pass after it.
    // `charter_versions` keys on `charter_version` alone, and `seedExecutableJob`
    // below installs a charter of its own — both must carry distinct
    // versions or the second `installCharter` collides on the primary key.
    const bundle = await installCharter(
      buildCharter({
        version: '2026-08-15.poison',
        connections: [MAIL_CONNECTION],
        knownCounterpartyEmailDomain: 'example.com',
        autonomyBase: { 'email.initiate': 'auto' },
      }),
      { businessId: BUSINESS },
    );
    const poisonJobId = await jobInExecute(bundle.charterVersion, 'poison');
    await bindPlanToJob(poisonJobId, PLAN, { businessId: BUSINESS });
    // Corrupt the stored plan directly in the database. `loadPlanBody`
    // (`plan-store.ts`) throws rather than returning null when a stored plan
    // no longer parses as a `Plan` — by design, per its own docblock — and
    // this is the only way to produce that condition from outside the
    // module.
    await getPool().query('UPDATE job_plans SET plan = $1 WHERE business_id = $2 AND job_id = $3', [
      JSON.stringify({ goal: 'missing its steps entirely' }),
      BUSINESS,
      poisonJobId,
    ]);

    const healthyJobId = await seedExecutableJob();
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(result.errored).toEqual([{ jobId: poisonJobId, error: expect.any(String) }]);
    expect(result.errored[0]?.error).toContain('does not parse as a Plan');
    expect(result.ran).toEqual([{ jobId: healthyJobId, status: 'done', detail: null }]);
    expect(sent).toHaveLength(1);
  });

  /**
   * Task 7, piece C: `GateContext.autonomyCeiling` has always been folded into
   * `effectiveAutonomy` (`policy/engine.ts`), but nothing ever populated it —
   * `runDueJobs` built the child's gate context knowing nothing about the
   * delegation that opened it. "Constraints tighten monotonically down a
   * delegation chain" was therefore true of what got STORED on the envelope
   * and false of what got ENFORCED. This test gives the envelope a ceiling
   * strictly tighter than every other autonomy source in play (base autonomy
   * `auto`, ramp `auto` — the exact setup the "runs a job that is in execute"
   * test above proves reaches `done` with NO envelope attached) and asserts
   * the step is held at that ceiling instead.
   */
  it("holds a job at the ceiling carried by the envelope that opened it as a delegation's child", async () => {
    const jobId = await seedExecutableJob();
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    const envelope: AgentEnvelope = {
      v: 1,
      id: `ENV-${ulid()}`,
      correlationId: 'JOB-root-of-the-tree',
      causalChain: [],
      from: 'comms.email',
      to: 'comms.email',
      kind: 'help_request',
      intent: 'send_the_confirmation',
      payload: {},
      contextRefs: [],
      constraints: {
        charterVersion: 'irrelevant-to-this-lookup',
        provenanceCeiling: 'boss',
        // Strictly tighter than the `auto` that base autonomy and the ramp
        // both grant — the one thing standing between `done` and `draft_only`
        // in this test.
        autonomyCeiling: 'draft_only',
        moneyCeilingMinor: null,
        deadlineAt: '2026-12-31T00:00:00.000Z',
      },
      hops: 1,
      idempotencyKey: `IDEM-${ulid()}`,
      createdAt: '2026-09-24T00:00:00.000Z',
    };
    await writeEnvelope(envelope, { parentJobId: 'JOB-some-other-job', businessId: BUSINESS });
    await attachChildJob(envelope.id, jobId, { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(result.ran).toEqual([{ jobId, status: 'halted', detail: 'draft_only:persist_as_draft' }]);
    expect(sent).toHaveLength(0);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('failed');
  });
});
