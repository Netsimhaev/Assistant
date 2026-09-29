import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import type { PolicyBundle } from '../domain/policy.js';
import { createJob, transition, loadJob } from './jobs.js';
import { AdapterRegistry } from './adapters/registry.js';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './adapters/types.js';
import { createCredentialHandle } from './adapters/types.js';
import type { CredentialSource } from './credentials.js';
import { upsertBinding } from './bindings.js';
import { runPlan } from './run-plan.js';

/**
 * `connection_bindings.last_ok_at`/`last_error` have existed since the table
 * was created, validated and read by `loadBindings`, and written only as
 * `null` by two seed scripts. This file proves the writer that closes that
 * gap: `performStep` (`run-plan.ts`) calls `recordBindingOutcome`
 * (`bindings.ts`) right after `callWithDeadline` resolves, before the
 * result is thrown or returned.
 *
 * Every test drives a step all the way through `runPlan`, not
 * `recordBindingOutcome` in isolation — the thing worth proving is that the
 * wiring in `performStep` actually reaches it with the right values, not
 * that the SQL statement works in a vacuum.
 */

const BUSINESS = 'test-business';
const NOON = new Date('2026-08-18T09:00:00.000Z');

const CRM_CONNECTION: CharterConnection = {
  system: 'crm-system',
  label: 'ה-CRM',
  channel: 'api',
  serves: ['crm.write'],
  target: null,
  subprocessor: null,
};

const LIVE: ConnectionBinding = {
  system: 'crm-system',
  status: 'live',
  endpoint: null,
  credentialRef: 'CRM_SECRET',
  provider: null,
  lastOkAt: null,
  lastError: null,
};

/** A credential source that always hands back the same secret value, so a test can prove that value never reaches a recorded row. */
function credentialsWithValue(value: string): CredentialSource {
  return {
    async resolve(ref: string, _businessId: string) {
      return createCredentialHandle(ref, value);
    },
  };
}

/** An adapter whose one call answers with a fixed, injected result — success or a classified failure, never a thrown value. */
function stubAdapter(system: string, serves: readonly string[], result: AdapterResult): ExternalAdapter {
  return {
    system,
    channel: 'api',
    serves,
    async execute(_call: AdapterCall): Promise<AdapterResult> {
      return result;
    },
  };
}

function writePlan(): Plan {
  return Plan.parse({
    goal: 'לעדכן רשומה',
    steps: [
      {
        id: 's1',
        agent: 'ops.systems',
        intent: 'update_record',
        toolName: 'crm.write',
        input: { entityId: 'c_812' },
      },
    ],
  });
}

async function jobInExecute(bundle: PolicyBundle) {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

interface BindingHealthRow {
  status: string;
  last_ok_at: Date | null;
  last_error: string | null;
}

async function loadBindingRow(system: string): Promise<BindingHealthRow> {
  const { rows } = await getPool().query<BindingHealthRow>(
    'SELECT status, last_ok_at, last_error FROM connection_bindings WHERE business_id = $1 AND system = $2',
    [BUSINESS, system],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no connection_bindings row for ${system}`);
  return row;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('the binding health fields get a writer', () => {
  it('stamps last_ok_at on success and clears the error', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [CRM_CONNECTION], autonomyBase: { 'crm.write': 'auto' } }),
      { businessId: BUSINESS },
    );
    // Seeded with a stale error and no last_ok_at, so a success genuinely has
    // to change both — not merely leave them at values that already matched.
    await upsertBinding(
      { ...LIVE, lastError: 'stale_failure — from an earlier run' },
      { businessId: BUSINESS, by: 'p_boss' },
    );
    const job = await jobInExecute(bundle);

    const result = await runPlan({
      job,
      bundle,
      plan: writePlan(),
      registry: new AdapterRegistry([
        stubAdapter('crm-system', ['crm.write'], { ok: true, output: { updated: true }, externalId: null }),
      ]),
      bindings: [LIVE],
      credentials: credentialsWithValue('irrelevant-secret'),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('done');

    const row = await loadBindingRow('crm-system');
    expect(row.last_ok_at).not.toBeNull();
    expect(row.last_error).toBeNull();
  });

  it('records the classified code on failure, never the credential value', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [CRM_CONNECTION], autonomyBase: { 'crm.write': 'auto' } }),
      { businessId: BUSINESS },
    );
    await upsertBinding(LIVE, { businessId: BUSINESS, by: 'p_boss' });
    const job = await jobInExecute(bundle);

    const SENTINEL = 'SENTINEL-TOKEN-DO-NOT-LEAK';

    const result = await runPlan({
      job,
      bundle,
      plan: writePlan(),
      registry: new AdapterRegistry([
        // A well-behaved adapter: it holds the secret (it was handed one) but
        // its classified failure never mentions it. The point of this test is
        // that run-plan.ts's own wiring records ONLY `result.code`/
        // `result.message` — never `credential`, which is a sibling value in
        // the very same closure and would be an easy thing to pass by mistake
        // (string concatenation of the whole call, say).
        stubAdapter('crm-system', ['crm.write'], {
          ok: false,
          retryable: false,
          code: 'credential_unavailable',
          message: 'the far end rejected the request — see logs',
        }),
      ]),
      bindings: [LIVE],
      credentials: credentialsWithValue(SENTINEL),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');

    const row = await loadBindingRow('crm-system');
    // Positive half first: prove a failure was genuinely recorded, not merely
    // absent for the wrong reason (a negative assertion that also holds
    // before the code under test ever ran proves nothing — CLAUDE.md names
    // this exact trap).
    expect(row.last_error).not.toBeNull();
    expect(row.last_error).toContain('credential_unavailable');
    expect(row.last_error).toContain('the far end rejected the request');
    // Only then the negative half.
    expect(row.last_error).not.toContain(SENTINEL);
  });

  it('leaves status live on a transient failure', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [CRM_CONNECTION], autonomyBase: { 'crm.write': 'auto' } }),
      { businessId: BUSINESS },
    );
    await upsertBinding(LIVE, { businessId: BUSINESS, by: 'p_boss' });
    const job = await jobInExecute(bundle);

    const result = await runPlan({
      job,
      bundle,
      plan: writePlan(),
      registry: new AdapterRegistry([
        stubAdapter('crm-system', ['crm.write'], {
          ok: false,
          retryable: true,
          code: 'adapter_unreachable',
          message: 'timed out talking to the far end',
        }),
      ]),
      bindings: [LIVE],
      credentials: credentialsWithValue('irrelevant-secret'),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');

    const row = await loadBindingRow('crm-system');
    // The failure IS recorded (proving the write ran) ...
    expect(row.last_error).toContain('adapter_unreachable');
    // ... but a single failed call is not the owner deciding to distrust the
    // connection. That is `status`'s question, and only a human or an
    // explicit health check answers it.
    expect(row.status).toBe('live');
  });
});
