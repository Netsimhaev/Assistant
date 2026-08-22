import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
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
      // `buildCharter` (`test/fixtures.ts`) always includes. Without it the
      // gate scores this as `one_unknown` (`scoreVisibility`,
      // `policy/risk.ts`) and queues an approval regardless of autonomy or
      // ramp — the first-contact exemption for `boss` provenance never fires
      // in this codebase today, because nothing sets
      // `ActionFacts.provenanceChainDerived` (see that field's docblock).
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
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(result.ran.map((r) => r.jobId)).toEqual([jobId]);
    expect(result.ran[0]?.status).toBe('done');
    expect(sent).toHaveLength(1);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('verify');
  });

  it('reports a job in execute that is bound to no plan, and does not run it', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
      businessId: BUSINESS,
    });
    const jobId = await jobInExecute(bundle.charterVersion, 'unbound');

    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith([]), now: NOON });
    expect(result.unbound).toEqual([jobId]);
    expect(result.ran).toEqual([]);
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
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    const jobIdOther = await seedExecutableJob(OTHER_BUSINESS);
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
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(result.errored).toEqual([{ jobId: poisonJobId, error: expect.any(String) }]);
    expect(result.errored[0]?.error).toContain('does not parse as a Plan');
    expect(result.ran).toEqual([{ jobId: healthyJobId, status: 'done', detail: null }]);
    expect(sent).toHaveLength(1);
  });
});
