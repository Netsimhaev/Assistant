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
async function jobInExecute(charterVersion: string, title: string): Promise<string> {
  const job = await createJob({
    charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  return job.jobId;
}

async function seedExecutableJob(): Promise<string> {
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
      connections: [MAIL_CONNECTION],
      autonomyBase: { 'email.initiate': 'auto' },
    }),
    { businessId: BUSINESS },
  );
  const jobId = await jobInExecute(bundle.charterVersion, 'run-due');
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
    const jobId = await seedExecutableJob();
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    const result = await runDueJobs({
      businessId: 'other-business',
      runtime: runtimeWith([]),
      now: NOON,
    });
    expect(result.ran.map((r) => r.jobId)).not.toContain(jobId);
  });
});
