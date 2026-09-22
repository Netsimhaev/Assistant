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
import { bindPlanToJob } from './plan-store.js';
import { setRampLevel } from './ramp.js';
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
  });
});
