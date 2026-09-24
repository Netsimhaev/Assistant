import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import { grantAuthorization } from '../governance/authorization.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, transition } from './jobs.js';
import { bindPlanToJob, loadPlanBody, planHashOf } from './plan-store.js';
import { runPlan } from './run-plan.js';
import type { Job } from './jobs.js';

const BUSINESS = 'test-business';

const PLAN: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the confirmation',
      toolName: 'mail.send',
      input: { to: 'dana@example.com', subject: 'hi', body: 'hello' },
      expectedActionClass: 'email.initiate',
    },
  ],
});

async function seedJob(): Promise<string> {
  const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'plan body test',
  });
  // A job only reaches `execute` through `understand` and `plan` — there is no
  // `intake -> plan` edge, and `bindPlanToJob` is meant to be called once a
  // job has actually reached execution.
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  return job.jobId;
}

describe('loadPlanBody', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('returns null for a job that is bound to no plan', async () => {
    const jobId = await seedJob();
    expect(await loadPlanBody(jobId, { businessId: BUSINESS })).toBeNull();
  });

  it('returns the plan a job was bound to, byte for byte', async () => {
    const jobId = await seedJob();
    await bindPlanToJob(jobId, PLAN, { businessId: BUSINESS });

    const loaded = await loadPlanBody(jobId, { businessId: BUSINESS });
    expect(loaded).not.toBeNull();
    expect(loaded?.plan).toEqual(PLAN);
    expect(loaded?.planHash).toBe(planHashOf(PLAN));
    // The point of the whole task: a round trip through the database must
    // still hash to the same plan, or resumption silently re-plans.
    expect(planHashOf(loaded!.plan)).toBe(planHashOf(PLAN));
  });

  it('does not read another business’s row', async () => {
    const jobId = await seedJob();
    await bindPlanToJob(jobId, PLAN, { businessId: BUSINESS });
    expect(await loadPlanBody(jobId, { businessId: 'other-business' })).toBeNull();
  });

  it('throws rather than returning a plan that no longer parses', async () => {
    const jobId = await seedJob();
    await bindPlanToJob(jobId, PLAN, { businessId: BUSINESS });
    await getPool().query(
      `UPDATE job_plans SET plan = '{"goal":"broken"}'::jsonb
        WHERE business_id = $1 AND job_id = $2`,
      [BUSINESS, jobId],
    );

    await expect(loadPlanBody(jobId, { businessId: BUSINESS })).rejects.toThrow(
      /stored plan/i,
    );
  });
});

describe('runPlan and delegationProblems', () => {
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

  const LIVE: ConnectionBinding = {
    system: 'office-mail',
    status: 'live',
    endpoint: null,
    credentialRef: 'OFFICE_MAIL',
    lastOkAt: null,
    lastError: null,
  };

  function registry(sent: MailMessage[]): AdapterRegistry {
    return new AdapterRegistry([
      createMailAdapter({
        system: 'office-mail',
        transport: {
          async send(m) {
            sent.push(m);
            return { messageId: 'MSG-1' };
          },
        },
      }),
    ]);
  }

  async function bossJobInExecute(charterVersion: string): Promise<Job> {
    const job = await createJob({
      charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'delegation rejection test',
    });
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }
    const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
    if (loaded === null) throw new Error('job vanished');
    return loaded;
  }

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('rejects the whole plan when a delegation step names a pair outside the graph', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION], autonomyBase: { 'email.initiate': 'auto' } }),
      { businessId: BUSINESS },
    );
    const job = await bossJobInExecute(bundle.charterVersion);
    // A standing authorisation, so the first step is genuinely executable —
    // the assertion that it never ran only means something if it could have.
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.initiate', recipients: ['dana@example.com'] },
      { businessId: BUSINESS },
    );

    const plan: Plan = Plan.parse({
      goal: 'send, then ask an agent gov.verify may not delegate to',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'send the confirmation',
          toolName: 'mail.send',
          input: { to: 'dana@example.com', subject: 'hi', body: 'hello' },
          expectedActionClass: 'email.initiate',
        },
        {
          // `COLLABORATION_GRAPH['gov.verify']` (charter/capabilities.ts) is
          // `['know.reader']` only — comms.email is outside it.
          id: 's2',
          agent: 'gov.verify',
          intent: 'ask_for_help',
          toolName: 'agent.request_help',
          input: { to: 'comms.email' },
          expectedActionClass: 'agent.delegate',
          dependsOn: ['s1'],
        },
      ],
    });

    const sent: MailMessage[] = [];
    const result = await runPlan({
      job,
      bundle,
      plan,
      registry: registry(sent),
      bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('expected rejected');
    expect(result.code).toBe('malformed_plan');
    expect(result.reason).toContain('s2');
    expect(result.reason).toContain('gov.verify');
    expect(result.reason).toContain('comms.email');
    expect(sent).toEqual([]);

    // The point of the whole layer: rejection at plan validation must mean no
    // step — not even the innocuous first one — was ever performed.
    const { rows } = await getPool().query(
      'SELECT step_id FROM job_step_results WHERE business_id = $1 AND job_id = $2',
      [BUSINESS, job.jobId],
    );
    expect(rows).toEqual([]);
  });
});
