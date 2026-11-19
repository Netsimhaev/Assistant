import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, TEST_BUSINESS, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { crmConnection, crmFixture } from '../test/external-fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { ConnectionBinding } from '../domain/connection.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { ExternalHttp, ExternalResult } from '../external/http.js';
import { loadReadsForJob } from '../external/store.js';
import { createJob, loadJob, transition } from './jobs.js';
import { decide } from '../governance/approvals.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createExternalAdapter } from './adapters/external.js';
import { envCredentials } from './credentials.js';
import { runPlan } from './run-plan.js';

/**
 * A completed `ext.read` stores the declared fields it returned in
 * `external_reads` — in the SAME transaction as the step's completion, so a
 * job that moved to `verify` always has the fields it read, and a step that
 * failed leaves none.
 */

const BUSINESS = TEST_BUSINESS;
const NOON = new Date('2026-08-18T09:00:00.000Z');
const PREFIX = 'TEST_CRED_';
const CREDENTIALS = envCredentials({ [`${PREFIX}EXT_CRM_KEY`]: 'test-key' }, PREFIX);

const LIVE: ConnectionBinding = {
  system: 'ext:crm',
  status: 'live',
  endpoint: null,
  credentialRef: 'EXT_CRM_KEY',
  provider: null,
  lastOkAt: null,
  lastError: null,
};

const READ_STEP = {
  toolName: 'ext.read',
  input: { system: 'crm', operation: 'get_customer', params: { customer_id: 'c-9' } },
};
const WRITE_STEP = {
  toolName: 'ext.call',
  input: { system: 'crm', operation: 'update_customer', params: { customer_id: 'c-9', phone: '050' } },
};

function readPlan(step: { toolName: string; input: Record<string, unknown> } = READ_STEP): Plan {
  return Plan.parse({
    goal: 'לבדוק לקוח',
    steps: [
      {
        id: 's1',
        agent: 'ops.systems',
        intent: 'customer',
        ...step,
      },
    ],
  });
}

function registry(reply: ExternalResult): AdapterRegistry {
  const http: ExternalHttp = { send: async () => reply };
  return new AdapterRegistry([
    createExternalAdapter(
      // The compiled bundle's definition, as the runtime registers it.
      crmSystem,
      { http, callsToday: async () => 0, recordCall: async () => {}, capPerDay: 200, charterVersion: crmVersion },
    ),
  ]);
}

let crmSystem: PolicyBundle['externalSystems'][number];
let crmVersion: string;

async function setup(): Promise<{ bundle: PolicyBundle; jobId: string }> {
  const bundle = await withBusiness(BUSINESS, (bdb) =>
    installCharter(bdb, buildCharter({ externalSystems: [crmFixture()], connections: [crmConnection()] })),
  );
  const system = bundle.externalSystems[0];
  if (system === undefined) throw new Error('no external system in the bundle');
  crmSystem = system;
  crmVersion = bundle.charterVersion;
  const job = await withBusiness(BUSINESS, (db) =>
    createJob(db, { charterVersion: bundle.charterVersion, provenance: 'boss' }),
  );
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await withBusiness(BUSINESS, (db) => transition(db, job.jobId, { to, actor: 'orchestrator', reason: 'setup' }));
  }
  return { bundle, jobId: job.jobId };
}

async function runOnce(bundle: PolicyBundle, jobId: string, reply: ExternalResult, step = READ_STEP) {
  const job = await withBusiness(BUSINESS, (db) => loadJob(db, jobId));
  if (job === null) throw new Error('job vanished');
  return withBusiness(BUSINESS, (db) =>
    runPlan(db, {
      job,
      bundle,
      plan: readPlan(step),
      registry: registry(reply),
      bindings: [LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    }),
  );
}

/**
 * Run the plan through the real gate. A read of a system the charter's
 * counterparties do not name is first contact today, so the gate queues a
 * card first; the owner approves it, the job resumes, and the step runs on
 * that approval. The store hook is what is under test, not the gate.
 */
async function run(bundle: PolicyBundle, jobId: string, reply: ExternalResult, step = READ_STEP) {
  const first = await runOnce(bundle, jobId, reply, step);
  if (first.status !== 'halted') return first;
  const outcome = first.steps[0]?.outcome;
  if (outcome?.status !== 'awaiting_approval') return first;
  await withBusiness(BUSINESS, (db) => decide(db, outcome.approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' }));
  await withBusiness(BUSINESS, (db) => transition(db, jobId, { to: 'execute', actor: 'orchestrator', reason: 'approved' }));
  return runOnce(bundle, jobId, reply, step);
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('a completed ext.read stores its fields', () => {
  it('writes one external_reads row whose fields equal the step output', async () => {
    const { bundle, jobId } = await setup();
    const result = await run(bundle, jobId, {
      kind: 'response',
      status: 200,
      body: JSON.stringify({ data: { name: 'דנה כהן', id: 'c-9', secret: 'not declared' } }),
    });
    expect(result.status, JSON.stringify(result)).toBe('done');
    if (result.status !== 'done') throw new Error('unreachable');
    const outcome = result.steps[0]?.outcome;
    if (outcome?.status !== 'done') throw new Error('step did not complete');
    const output = outcome.result as { fields: unknown };
    expect(output).toEqual({ fields: [{ label: 'שם', value: 'דנה כהן' }] });

    const reads = await withBusiness(BUSINESS, (db) => loadReadsForJob(db, jobId));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ jobId, stepId: 's1', systemId: 'crm', operation: 'get_customer' });
    expect(reads[0]?.fields).toEqual(output.fields);
    // Same transaction as the completion: the job moved on and the step is recorded.
    const job = await withBusiness(BUSINESS, (db) => loadJob(db, jobId));
    expect(job?.phase).toBe('verify');
  });

  it('writes nothing when the read fails', async () => {
    const { bundle, jobId } = await setup();
    const result = await run(bundle, jobId, { kind: 'response', status: 404, body: '{}' });
    expect(result.status).not.toBe('done');
    // The step really reached the adapter and failed there — not refused earlier.
    if (result.status === 'rejected') throw new Error('plan rejected before any step ran');
    expect(result.steps[0]?.outcome).toMatchObject({ status: 'refused', code: 'external_rejected' });
    const { rows } = await testDb().query('SELECT 1 FROM external_reads');
    expect(rows).toHaveLength(0);
  });
});

describe('a write that may have gone out', () => {
  it('a timeout after sending leaves an unknown completion row, so a re-plan cannot replace it', async () => {
    const { bundle, jobId } = await setup();
    const result = await run(bundle, jobId, { kind: 'timeout', sent: true }, WRITE_STEP);
    if (result.status === 'rejected') throw new Error('plan rejected before any step ran');
    expect(result.steps[0]?.outcome).toMatchObject({ status: 'deferred', code: 'adapter_timeout' });
    const { rows } = await testDb().query<{ status: string }>(
      'SELECT status FROM job_step_results WHERE job_id = $1',
      [jobId],
    );
    expect(rows).toEqual([{ status: 'unknown' }]);
    const { rows: reads } = await testDb().query('SELECT 1 FROM external_reads');
    expect(reads).toHaveLength(0);
  });

  it('a timeout before anything was sent leaves no row', async () => {
    const { bundle, jobId } = await setup();
    const result = await run(bundle, jobId, { kind: 'timeout', sent: false }, WRITE_STEP);
    if (result.status === 'rejected') throw new Error('plan rejected before any step ran');
    expect(result.steps[0]?.outcome).toMatchObject({ status: 'deferred', code: 'adapter_timeout' });
    const { rows } = await testDb().query('SELECT 1 FROM job_step_results WHERE job_id = $1', [jobId]);
    expect(rows).toHaveLength(0);
  });
});

describe('a re-signed charter', () => {
  it('an adapter built from another charter version refuses the step — nothing stored', async () => {
    const { bundle, jobId } = await setup();
    crmVersion = 'some-older-version';
    const result = await run(bundle, jobId, { kind: 'response', status: 200, body: '{"data":{"name":"x"}}' });
    if (result.status === 'rejected') throw new Error('plan rejected before any step ran');
    expect(result.steps[0]?.outcome).toMatchObject({ status: 'deferred', code: 'external_definition_stale' });
    const { rows } = await testDb().query('SELECT 1 FROM external_reads');
    expect(rows).toHaveLength(0);
  });
});
