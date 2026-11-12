import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { __setAppPoolMaxForTest, closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { envCredentials } from './credentials.js';
import type { ServerRuntime } from './runtime.js';
import { schedulerPass, type SchedulerPassResult } from './scheduler.js';
import { tenantPassIsNotable, tenantPassLines } from './scheduler-log.js';
import { runAllBusinesses, type TenantLoopState, type TenantPass } from './tenants.js';

/**
 * Spec §5.3: every interval runs every active business, each on its own
 * connection, deadline and catch. Most tests here replace the pass itself
 * (`pass` seam) so a business can be made to throw or hang on purpose; the
 * first runs the real `schedulerPass`, so the wiring is proven too.
 */

const A = 'tenant-a';
const B = 'tenant-b';
const C = 'tenant-c';

/** The server half with nothing configured — no key, no tools, no inbox. */
const SERVER: ServerRuntime = {
  credentials: envCredentials({}, 'TEST_CRED_'),
  dashboardBaseUrl: 'http://127.0.0.1:3000',
  documentInboxRoot: null,
  production: { available: false, sofficePath: null, chromiumPath: null },
  warnings: [],
  overrides: {},
};

function freshState(): TenantLoopState {
  return { inFlight: new Set(), resumeFrom: null };
}

/** A pass seam that records which business it ran on. */
function recordingPass(seen: string[], behave: (id: string) => Promise<void> = async () => {}): TenantPass {
  return async (businessId) => {
    seen.push(businessId);
    await behave(businessId);
    return {} as SchedulerPassResult;
  };
}

async function auditReasons(businessId: string): Promise<string[]> {
  const { rows } = await testDb().query<{ reason: string | null }>(
    'SELECT reason FROM audit_log WHERE business_id = $1 ORDER BY seq',
    [businessId],
  );
  return rows.map((r) => r.reason ?? '');
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
  await closePlatformPool();
});

describe('runAllBusinesses', () => {
  it('runs each active business once per pass, in id order', async () => {
    // Registered out of order: the order comes from the registry query.
    await registerBusiness(C);
    await registerBusiness(A);
    await registerBusiness(B);
    const passed: string[] = [];

    const report = await runAllBusinesses(SERVER, {
      perBusinessDeadlineMs: 60_000,
      state: freshState(),
      // The real pass, not the seam.
      onPass: (businessId, result) => {
        expect(result.tick).toBeDefined();
        passed.push(businessId);
      },
    });

    expect(report).toEqual({ ran: [A, B, C], skippedInFlight: [], failed: [], notReached: [] });
    expect(passed).toEqual([A, B, C]);
  });

  it('a business that throws does not stop the next one', async () => {
    await registerBusiness(A);
    await registerBusiness(B);
    const seen: string[] = [];

    const report = await runAllBusinesses(SERVER, {
      perBusinessDeadlineMs: 5_000,
      state: freshState(),
      pass: recordingPass(seen, async (id) => {
        if (id === A) throw new Error('boom');
      }),
    });

    expect(seen).toEqual([A, B]);
    expect(report.ran).toEqual([B]);
    expect(report.failed).toEqual([{ businessId: A, reason: 'threw' }]);
  });

  it('a business past its deadline is skipped while still in flight and runs again once it settles', async () => {
    await registerBusiness(A);
    await registerBusiness(B);
    const state = freshState();
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hangA = true;
    const seen: string[] = [];
    const pass = recordingPass(seen, async (id) => {
      if (id === A && hangA) await stuck;
    });

    const first = await runAllBusinesses(SERVER, { perBusinessDeadlineMs: 100, state, pass });
    expect(first.failed).toEqual([{ businessId: A, reason: 'deadline' }]);
    expect(first.ran).toEqual([B]);
    // The deadline's own row, in A's chain — not only a thrown pass writes one.
    expect(await auditReasons(A)).toEqual(['scheduler_pass_failed:deadline']);
    expect(await auditReasons(B)).toEqual([]);
    // The deadline stopped the waiting, not the work.
    expect(state.inFlight.has(A)).toBe(true);

    const second = await runAllBusinesses(SERVER, { perBusinessDeadlineMs: 100, state, pass });
    expect(second.skippedInFlight).toEqual([A]);
    expect(second.ran).toEqual([B]);
    expect(seen.filter((id) => id === A)).toHaveLength(1);

    hangA = false;
    release();
    await waitFor(() => !state.inFlight.has(A));

    const third = await runAllBusinesses(SERVER, { perBusinessDeadlineMs: 100, state, pass });
    expect(third.ran).toEqual([A, B]);
    expect(third.skippedInFlight).toEqual([]);
  });

  it('a suspended business is not run', async () => {
    await registerBusiness(A);
    await registerBusiness(B, 'suspended');
    const seen: string[] = [];

    const report = await runAllBusinesses(SERVER, {
      perBusinessDeadlineMs: 5_000,
      state: freshState(),
      pass: recordingPass(seen),
    });

    expect(seen).toEqual([A]);
    expect(report.ran).toEqual([A]);
  });

  it('zero active businesses completes and reports zero', async () => {
    const report = await runAllBusinesses(SERVER, { perBusinessDeadlineMs: 5_000, state: freshState() });

    expect(report).toEqual({ ran: [], skippedInFlight: [], failed: [], notReached: [] });
    expect(tenantPassLines(report)[0]).toBe('0 businesses, ran 0, failed 0, skipped 0');
  });

  it('resumes from the first business not reached', async () => {
    await registerBusiness(A);
    await registerBusiness(B);
    await registerBusiness(C);
    const state = freshState();
    const seen: string[] = [];
    // Each pass takes longer than the whole interval's budget.
    const pass = recordingPass(seen, () => new Promise((resolve) => setTimeout(resolve, 40)));

    const first = await runAllBusinesses(SERVER, { perBusinessDeadlineMs: 5_000, state, budgetMs: 20, pass });
    // The first business always runs, whatever the budget.
    expect(first.ran).toEqual([A]);
    expect(first.notReached).toEqual([B, C]);
    expect(state.resumeFrom).toBe(B);

    const second = await runAllBusinesses(SERVER, { perBusinessDeadlineMs: 5_000, state, budgetMs: 20, pass });
    expect(second.ran).toEqual([B]);
    expect(second.notReached).toEqual([C, A]);
    expect(state.resumeFrom).toBe(C);

    const third = await runAllBusinesses(SERVER, { perBusinessDeadlineMs: 5_000, state, budgetMs: 60_000, pass });
    expect(third.ran).toEqual([C, A, B]);
    expect(third.notReached).toEqual([]);
    expect(state.resumeFrom).toBeNull();
    expect(seen).toEqual([A, B, C, A, B]);
  });

  it('a budget of zero still runs the first business, so nothing starves', async () => {
    await registerBusiness(A);
    await registerBusiness(B);
    const state = freshState();
    const seen: string[] = [];
    const pass = recordingPass(seen);

    const first = await runAllBusinesses(SERVER, { perBusinessDeadlineMs: 5_000, state, budgetMs: 0, pass });
    expect(first.ran).toEqual([A]);
    expect(first.notReached).toEqual([B]);

    const second = await runAllBusinesses(SERVER, { perBusinessDeadlineMs: 5_000, state, budgetMs: 0, pass });
    expect(second.ran).toEqual([B]);
    expect(seen).toEqual([A, B]);
  });

  it('resumes at the remembered business when it is still listed, and after it when it is gone', async () => {
    await registerBusiness(A);
    await registerBusiness(C);
    const seen: string[] = [];
    // B is no longer listed: the next id after it is C.
    const gone = await runAllBusinesses(SERVER, {
      perBusinessDeadlineMs: 5_000,
      state: { inFlight: new Set(), resumeFrom: B },
      pass: recordingPass(seen),
    });
    expect(gone.ran).toEqual([C, A]);
  });

  it('several businesses hung past their deadline do not starve another of connections', async () => {
    // A small pool. Each hung pass here pins one connection, as a pass hung
    // in a stage does (nothing is held across the pass). The healthy pass
    // needs two at its peak — a per-job stage (`runDueJobs`) holds its own
    // connection while each job takes another — so: two hung, two left. Had
    // the pass held a connection of its own across its stages, as it once
    // did, the two hung ones would pin four and the healthy one get none.
    await __setAppPoolMaxForTest(4);
    const H1 = 'tenant-hung-1';
    const H2 = 'tenant-hung-2';
    const OK = 'tenant-ok';
    await registerBusiness(H1);
    await registerBusiness(H2);
    await registerBusiness(OK);
    const state = freshState();
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A hung business hangs INSIDE a connection, as a hung stage would; the
    // healthy one runs the real `schedulerPass`, stage by stage.
    const pass: TenantPass = (businessId, options) =>
      businessId === OK
        ? schedulerPass(businessId, options)
        : withBusiness(businessId, async () => {
            await stuck;
            return {} as SchedulerPassResult;
          });

    try {
      const first = await runAllBusinesses(SERVER, { perBusinessDeadlineMs: 300, state, pass });
      expect(first.failed).toEqual([
        { businessId: H1, reason: 'deadline' },
        { businessId: H2, reason: 'deadline' },
      ]);
      expect(first.ran).toEqual([OK]);

      // Still hung: skipped, and the healthy business runs again.
      const second = await runAllBusinesses(SERVER, { perBusinessDeadlineMs: 300, state, pass });
      expect(second.skippedInFlight).toEqual([H1, H2]);
      expect(second.ran).toEqual([OK]);
    } finally {
      release();
      await waitFor(() => state.inFlight.size === 0);
      await __setAppPoolMaxForTest(10);
    }
  });

  it('the summary line is printed only when something went wrong or the count changed', () => {
    const quiet = { ran: [A, B], skippedInFlight: [], failed: [], notReached: [] };
    expect(tenantPassIsNotable(quiet, null)).toBe(true);
    expect(tenantPassIsNotable(quiet, 2)).toBe(false);
    expect(tenantPassIsNotable(quiet, 3)).toBe(true);
    expect(tenantPassIsNotable({ ...quiet, failed: [{ businessId: A, reason: 'threw' as const }] }, 3)).toBe(true);
    expect(tenantPassIsNotable({ ...quiet, skippedInFlight: [A] }, 3)).toBe(true);
    expect(tenantPassIsNotable({ ...quiet, notReached: [B] }, 3)).toBe(true);
  });

  it('a failure writes one count-only audit row in that business\'s chain and none in others', async () => {
    await registerBusiness(A);
    await registerBusiness(B);
    const secret = 'רונית כהן ronit@example.com';

    await runAllBusinesses(SERVER, {
      perBusinessDeadlineMs: 5_000,
      state: freshState(),
      pass: recordingPass([], async (id) => {
        if (id === A) throw new Error(`failed while holding ${secret}`);
      }),
    });

    expect(await auditReasons(A)).toEqual(['scheduler_pass_failed:threw']);
    expect(await auditReasons(B)).toEqual([]);
    const { rows } = await testDb().query<{ row: string }>(
      'SELECT row_to_json(a)::text AS row FROM audit_log a WHERE business_id = $1',
      [A],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row).not.toContain('ronit');
    expect(rows[0]?.row).toContain('"kind":"tool_call"');
  });
});

/** Poll until `done()` — a stuck pass settles on its own microtask schedule. */
async function waitFor(done: () => boolean, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
