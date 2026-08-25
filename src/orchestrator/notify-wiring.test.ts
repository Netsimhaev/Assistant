import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { ApprovalNotifier } from '../governance/notify.js';
import { createJob, loadJob, transition } from './jobs.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter } from './adapters/mail.js';
import { envCredentials } from './credentials.js';
import { runPlan } from './run-plan.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';
// Tuesday, 12:00 Asia/Jerusalem — inside business hours and well clear of the
// charter's 20:00–07:00 quiet-hours window. Without a fixed clock the gate
// picks up the real wall-clock time, and quiet hours (checked before the risk
// step that queues an approval) silently swallows this test whenever it runs
// in the evening — exactly the failure this constant exists to avoid. Same
// value `external.test.ts` uses for the same reason.
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

const PLAN: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the confirmation',
      toolName: 'mail.send',
      input: { to: 'dana@example.com', subject: 'אישור', body: 'שלום' },
      expectedActionClass: 'email.initiate',
    },
  ],
});

function recordingNotifier(): { calls: { approvalId: string; link: string }[]; notifier: ApprovalNotifier } {
  const calls: { approvalId: string; link: string }[] = [];
  return {
    calls,
    notifier: {
      channel: 'email',
      async notify(request, link) {
        calls.push({ approvalId: request.approvalId, link });
        return { ok: true };
      },
    },
  };
}

function registry(): AdapterRegistry {
  return new AdapterRegistry([
    createMailAdapter({
      system: 'office-mail',
      transport: {
        async send() {
          return { messageId: 'MSG-1' };
        },
      },
    }),
  ]);
}

/** A job walked from `intake` to `execute`, the way `run-plan` requires. */
async function jobInExecute(bundle: PolicyBundle) {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'notify wiring',
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

describe('approval notification wiring', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('notifies the owner when the gate queues an approval', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION], autonomyBase: { 'email.initiate': 'approve_required' } }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);

    const { calls, notifier } = recordingNotifier();

    const result = await runPlan({
      job,
      bundle,
      plan: PLAN,
      registry: registry(),
      bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [],
      rampLevel: 'approve_required',
      now: NOON,
      notify: { notifier, dashboardBaseUrl: 'http://127.0.0.1:8787' },
    });

    expect(result.status).toBe('halted');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.link).toContain('http://127.0.0.1:8787');
  });

  it('runs unchanged when no notifier is supplied', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION], autonomyBase: { 'email.initiate': 'approve_required' } }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);

    const result = await runPlan({
      job,
      bundle,
      plan: PLAN,
      registry: registry(),
      bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [],
      rampLevel: 'approve_required',
      now: NOON,
    });

    expect(result.status).toBe('halted');
  });
});
