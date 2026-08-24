import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, markContentIngested, transition } from './jobs.js';
import { runPlan } from './run-plan.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';
const NOON = new Date('2026-08-18T09:00:00.000Z');

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail', label: 'תיבת המשרד', channel: 'api',
  serves: ['mail.send'], target: null, subprocessor: null,
};

const LIVE: ConnectionBinding = {
  system: 'office-mail', status: 'live', endpoint: null,
  credentialRef: 'OFFICE_MAIL', lastOkAt: null, lastError: null,
};

/** One step, to a stranger, with nothing read. The live thread's own plan. */
const SEND_ONLY: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [{
    id: 's1', agent: 'comms.email', intent: 'send',
    toolName: 'mail.send',
    input: { to: 'stranger@example.com', subject: 'הצעה', body: 'שלום' },
    expectedActionClass: 'email.initiate',
  }],
});

function registry(sent: MailMessage[]): AdapterRegistry {
  return new AdapterRegistry([
    createMailAdapter({
      system: 'office-mail',
      transport: { async send(m) { sent.push(m); return { messageId: 'MSG-1' }; } },
    }),
  ]);
}

async function jobInExecute(bundle: { charterVersion: string }) {
  const job = await createJob({
    charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

/**
 * The charter must permit the class, or its own ceiling forces an approval
 * regardless of the exemption — see the spec's §6. This is the charter change
 * the owner would make in production, expressed as a test override.
 */
function permissiveCharter() {
  return buildCharter({
    connections: [MAIL_CONNECTION],
    autonomyBase: { 'email.initiate': 'auto' },
  });
}

describe('the boss exemption, end to end through runPlan', () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await closePool(); });

  it('sends without an approval when the boss instructed it and nothing was read', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);
    const sent: MailMessage[] = [];

    const result = await runPlan({
      job, bundle, plan: SEND_ONLY, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    expect(result.status).toBe('done');
    expect(sent).toHaveLength(1);
  });

  it('still asks when the job has already ingested content', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);
    await markContentIngested(job.jobId, { businessId: BUSINESS });
    const fresh = await loadJob(job.jobId, { businessId: BUSINESS });
    if (fresh === null) throw new Error('job vanished');
    const sent: MailMessage[] = [];

    const result = await runPlan({
      job: fresh, bundle, plan: SEND_ONLY, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    expect(result.status).toBe('halted');
    expect(sent).toEqual([]);
  });

  it('still asks when the plan itself contains a reader, even after the send step', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);
    const sent: MailMessage[] = [];

    // The reader comes SECOND. Execution order must not matter: the planner
    // that wrote step 1 is the same planner that had read for step 2.
    const readAfter: Plan = Plan.parse({
      goal: 'send then read',
      steps: [
        SEND_ONLY.steps[0],
        { id: 's2', agent: 'know.reader', intent: 'read', toolName: 'doc.fetch',
          input: { uri: 'https://example.com/d' }, dependsOn: ['s1'],
          expectedActionClass: null },
      ],
    });

    const result = await runPlan({
      job, bundle, plan: readAfter, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    expect(result.status).toBe('halted');
    expect(sent).toEqual([]);
  });

  it('still asks when the job did not come from the boss', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'unknown_external',
      businessId: BUSINESS,
    });
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }
    const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
    if (loaded === null) throw new Error('job vanished');
    const sent: MailMessage[] = [];

    const result = await runPlan({
      job: loaded, bundle, plan: SEND_ONLY, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    expect(result.status).toBe('halted');
    expect(sent).toEqual([]);
  });
});
