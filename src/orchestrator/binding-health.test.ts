import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import type { PolicyBundle } from '../domain/policy.js';
import { OAuthGrantError } from '../governance/oauth-grants.js';
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

/**
 * Final fix wave, item 12 — spec §3.4 row 5's "one refresh and one retry".
 * `oauthCredentials` (`oauth-token.ts`) keeps a short-lived access token in
 * memory and trusts its own recorded expiry; a 401 from the RESOURCE call
 * (not the refresh call) is the one signal that proves the provider already
 * invalidated a token this module still thinks is good. `performStep`
 * (`run-plan.ts`) is the one place that sees both the classified result and
 * the `credentialRef` that produced it, so it is the one place that can call
 * `credentials.invalidate?.(ref, businessId)` — proven here through a real
 * `runPlan` call, the same discipline the describe block above uses, not by
 * calling the private helper directly.
 */
describe('a 401 from the resource call invalidates the cached credential', () => {
  it('calls credentials.invalidate with the resolved ref and business id on an "unauthorized" failure', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [CRM_CONNECTION], autonomyBase: { 'crm.write': 'auto' } }),
      { businessId: BUSINESS },
    );
    await upsertBinding(LIVE, { businessId: BUSINESS, by: 'p_boss' });
    const job = await jobInExecute(bundle);

    const invalidated: Array<{ ref: string; businessId: string }> = [];
    const credentials: CredentialSource = {
      async resolve(ref: string, _businessId: string) {
        return createCredentialHandle(ref, 'irrelevant-secret');
      },
      invalidate(ref: string, businessId: string) {
        invalidated.push({ ref, businessId });
      },
    };

    const result = await runPlan({
      job,
      bundle,
      plan: writePlan(),
      registry: new AdapterRegistry([
        // `google-calendar.ts`'s own code for a 401 from the resource call
        // (`classifyCalendarFailure`) — the concrete shape this stub stands
        // in for.
        stubAdapter('crm-system', ['crm.write'], {
          ok: false,
          retryable: true,
          code: 'unauthorized',
          message: 'Google דחה את האסימון (401)',
        }),
      ]),
      bindings: [LIVE],
      credentials,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');
    // Positive half: the failure genuinely reached `performStep` and the
    // binding's own ref (`LIVE.credentialRef`) is what got invalidated —
    // never some other value from the same closure.
    expect(invalidated).toEqual([{ ref: 'CRM_SECRET', businessId: BUSINESS }]);
  });

  it('does not call invalidate for a failure code other than "unauthorized"', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [CRM_CONNECTION], autonomyBase: { 'crm.write': 'auto' } }),
      { businessId: BUSINESS },
    );
    await upsertBinding(LIVE, { businessId: BUSINESS, by: 'p_boss' });
    const job = await jobInExecute(bundle);

    const invalidated: Array<{ ref: string; businessId: string }> = [];
    const credentials: CredentialSource = {
      async resolve(ref: string, _businessId: string) {
        return createCredentialHandle(ref, 'irrelevant-secret');
      },
      invalidate(ref: string, businessId: string) {
        invalidated.push({ ref, businessId });
      },
    };

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
      credentials,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');
    expect(invalidated).toEqual([]);
  });
});

/**
 * Final fix wave, item 3's "Also": `OAuthGrantError` (`governance/
 * oauth-grants.ts`) is thrown by `recordRefresh`/`markNeedsReauth` when a
 * concurrent revoke lands between `oauthCredentials` reading a live grant
 * and its own write landing a moment later. Before this fix it was not one
 * of the classes `mapOAuthTokenError` (`run-plan.ts`) recognised, so it fell
 * through to `return error` unchanged and reached `execute.ts`'s bare catch
 * as a plain `Error`: `adapter_threw`, and — unlike a genuinely revoked
 * grant one line above it in the same function — NON-retryable for no
 * reason connected to whether retrying makes sense. Driven through a real
 * `runPlan` call (a `credentials.resolve` that throws the class directly)
 * rather than by calling `mapOAuthTokenError` in isolation, since it is not
 * exported and the thing worth proving is that `performStep`'s `.catch`
 * actually reaches it.
 */
describe('a concurrent-revoke race during a refresh gets a readable, correctly-terminal code', () => {
  it('classifies OAuthGrantError as oauth_grant_revoked, not adapter_threw', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [CRM_CONNECTION], autonomyBase: { 'crm.write': 'auto' } }),
      { businessId: BUSINESS },
    );
    await upsertBinding(LIVE, { businessId: BUSINESS, by: 'p_boss' });
    const job = await jobInExecute(bundle);

    const credentials: CredentialSource = {
      async resolve(): Promise<never> {
        throw new OAuthGrantError('לא נמצאה הרשאה פעילה למערכת — לא ניתן לרשום ריענון');
      },
    };

    const result = await runPlan({
      job,
      bundle,
      plan: writePlan(),
      // Never reached: `resolve` throws before any adapter call happens.
      registry: new AdapterRegistry([
        stubAdapter('crm-system', ['crm.write'], { ok: true, output: {}, externalId: null }),
      ]),
      bindings: [LIVE],
      credentials,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');
    if (result.status !== 'halted') throw new Error('unreachable — asserted above');
    // The load-bearing assertion: `oauth_grant_revoked`, the SAME readable
    // code an actually-revoked grant gets — never the generic `adapter_threw`
    // a plain, unmapped `Error` would have produced.
    expect(result.reason).toBe('oauth_grant_revoked');

    const job2 = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(job2?.phase).toBe('failed');
  });
});
