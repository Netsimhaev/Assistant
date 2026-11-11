import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { __setAppPoolMaxForTest, closePool, withBusiness, type BusinessDb } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { PolicyBundle } from '../domain/policy.js';
import { createJob, loadJob, transition } from './jobs.js';
import { recordStepCompletion } from './plan-store.js';
import { upsertBinding } from './bindings.js';
import { runPlan } from './run-plan.js';
import { executeStep } from './execute.js';
import { AdapterRegistry } from './adapters/registry.js';
import { withSessionLock, withSessionLockOn } from './session-lock.js';

/**
 * The orchestrator takes its business from the `BusinessDb` it is handed —
 * one source of truth, so a function cannot be given business A's id with
 * business B's connection (multi-tenant plan, Tasks 3–7 shared rule).
 */

const OTHER = 'other-business';

async function install(businessId = TEST_BUSINESS): Promise<PolicyBundle> {
  return withBusiness(businessId, (db) => installCharter(db, buildCharter()));
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('the orchestrator takes the business from its BusinessDb', () => {
  it('createJob writes the job under db.businessId, and loadJob finds it only there', async () => {
    const bundle = await install();
    const job = await withBusiness(TEST_BUSINESS, (db) =>
      createJob(db, { charterVersion: bundle.charterVersion, provenance: 'boss' }),
    );
    expect(job.businessId).toBe(TEST_BUSINESS);
    expect(await withBusiness(TEST_BUSINESS, (db) => loadJob(db, job.jobId))).not.toBeNull();
    expect(await withBusiness(OTHER, (db) => loadJob(db, job.jobId))).toBeNull();
  });

  it("transition joins the caller's transaction, so a rollback undoes the move and its step row", async () => {
    const bundle = await install();
    const job = await withBusiness(TEST_BUSINESS, (db) =>
      createJob(db, { charterVersion: bundle.charterVersion, provenance: 'boss' }),
    );
    await withBusiness(TEST_BUSINESS, async (db) => {
      await db.query('BEGIN');
      await transition({ ...db, inTransaction: true }, job.jobId, {
        to: 'understand',
        actor: 'orchestrator',
        reason: 'rolled back',
      });
      await db.query('ROLLBACK');
    });
    expect((await withBusiness(TEST_BUSINESS, (db) => loadJob(db, job.jobId)))?.phase).toBe('intake');
    const steps = await testDb().query('SELECT 1 FROM job_steps WHERE job_id = $1', [job.jobId]);
    expect(steps.rowCount).toBe(0);
  });

  it('recordStepCompletion refuses a connection that is not in a transaction', async () => {
    await expect(
      withBusiness(TEST_BUSINESS, (db) =>
        recordStepCompletion(db, {
          jobId: 'J-none',
          planHash: 'h',
          stepId: 's1',
          externalId: null,
          status: 'completed',
          performed: true,
        }),
      ),
    ).rejects.toThrow(/inside the transaction/);
  });

  it('upsertBinding writes the row and its audit entry under db.businessId alone', async () => {
    await withBusiness(TEST_BUSINESS, (db) =>
      upsertBinding(
        db,
        {
          system: 'office-mail',
          status: 'live',
          endpoint: null,
          credentialRef: null,
          provider: null,
          lastOkAt: null,
          lastError: null,
        },
        { by: 'test' },
      ),
    );
    const rows = await testDb().query<{ business_id: string }>(
      'SELECT business_id FROM connection_bindings',
    );
    expect(rows.rows.map((r) => r.business_id)).toEqual([TEST_BUSINESS]);
    const audit = await testDb().query<{ business_id: string }>(
      `SELECT business_id FROM audit_log WHERE kind = 'connection_binding'`,
    );
    expect(audit.rows.map((r) => r.business_id)).toEqual([TEST_BUSINESS]);
  });

  it("runPlan and executeStep refuse a job of another business than the connection's", async () => {
    const bundle = await install(OTHER);
    const job = await withBusiness(OTHER, (db) =>
      createJob(db, { charterVersion: bundle.charterVersion, provenance: 'boss' }),
    );
    const plan = {
      goal: 'x',
      assumptions: [],
      clarifyingQuestion: null,
      estimatedCostMinor: 0,
      steps: [],
    };
    await expect(
      withBusiness(TEST_BUSINESS, (db) =>
        runPlan(db, {
          job,
          bundle,
          plan: plan as never,
          registry: new AdapterRegistry([]),
          bindings: [],
          credentials: { resolve: async () => null },
          counterpartyTags: [],
          rampLevel: 'auto',
        }),
      ),
    ).rejects.toThrow(/not of the connection's business/);
    await expect(
      withBusiness(TEST_BUSINESS, (db) =>
        executeStep(db, {
          job,
          stepId: 's1',
          agent: 'comms.email',
          bundle,
          toolName: 'memory.recall',
          toolInput: {},
          perform: async () => ({ output: null, externalId: null, performed: true }),
          counterpartyTags: [],
          rampLevel: 'auto',
        }),
      ),
    ).rejects.toThrow(/not of the connection's business/);
  });
});

describe('withSessionLock', () => {
  it('skips the work while another session holds the lock, and releases it after', async () => {
    const scope = `tenancy-test:${TEST_BUSINESS}`;
    const held = await testDb().connect();
    try {
      await held.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [scope]);
      let ran = false;
      const out = await withSessionLock(TEST_BUSINESS, scope, async () => {
        ran = true;
      });
      expect(out.locked).toBe(false);
      expect(ran).toBe(false);
      await held.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [scope]);
    } finally {
      held.release();
    }

    const first = await withSessionLock(TEST_BUSINESS, scope, async (db) => db.businessId);
    expect(first).toEqual({ locked: true, value: TEST_BUSINESS });
    // Released after the first run: a second one gets it again.
    const second = await withSessionLock(TEST_BUSINESS, scope, async () => 'again');
    expect(second).toEqual({ locked: true, value: 'again' });
  });

  it('refuses a connection that is already in a transaction', async () => {
    await expect(
      withBusiness(TEST_BUSINESS, async (db) => {
        await db.query('BEGIN');
        try {
          return await withSessionLockOn({ ...db, inTransaction: true }, 'tenancy-test:tx', async () => 1);
        } finally {
          await db.query('ROLLBACK');
        }
      }),
    ).rejects.toThrow(/already in a transaction/);
  });

  it('destroys the connection when the unlock fails, so the lock does not outlive it', async () => {
    const scope = `tenancy-test:unlock-fails:${TEST_BUSINESS}`;
    // One pooled connection: the next checkout is either that very session
    // (pooled — the bug) or a brand-new one (destroyed — the rule).
    await __setAppPoolMaxForTest(1);
    try {
      const firstPid = await withBusiness(TEST_BUSINESS, async (db) => {
        const { rows } = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const failingUnlock: BusinessDb = {
          ...db,
          query: ((text: string, params?: unknown[]) =>
            text.includes('pg_advisory_unlock')
              ? Promise.reject(new Error('injected unlock failure'))
              : db.query(text, params)) as BusinessDb['query'],
        };
        const out = await withSessionLockOn(failingUnlock, scope, async () => 'ran');
        expect(out).toEqual({ locked: true, value: 'ran' });
        return rows[0]!.pid;
      });
      const secondPid = await withBusiness(TEST_BUSINESS, async (db) => {
        const { rows } = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        return rows[0]!.pid;
      });
      expect(secondPid).not.toBe(firstPid);
      // And the lock died with the session it was held on.
      const other = await testDb().connect();
      try {
        const { rows } = await other.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
          [scope],
        );
        expect(rows[0]?.locked).toBe(true);
        await other.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [scope]);
      } finally {
        other.release();
      }
    } finally {
      await __setAppPoolMaxForTest(10);
    }
  });
});
