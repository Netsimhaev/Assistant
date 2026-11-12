/**
 * One scheduler interval over every active business on the server (spec §5.3).
 *
 * The list comes from `listActiveBusinesses()` — the declared cross-business
 * read (§5.7) — and nothing else: a business is run only because the registry
 * says it is active, never because some row somewhere carries its id. Each
 * business then runs with its own runtime (`businessRuntime(server, db)`, on a
 * connection released before the pass starts), inside its own deadline and
 * its own catch, and every stage of its pass takes a connection of its own
 * and gives it back when the stage ends (`schedulerPass`).
 *
 * **What a stuck business can still cost the others — the bound.** A pass
 * that hangs past its deadline keeps running, and pins the connection of the
 * stage it hangs in — one, or two when it hangs inside a per-job stage
 * (`runDueJobs`, `closeVerifiedJobs`, `resumeDelegatedJobs`,
 * `reaskFailedCommands` hold their stage connection while each job takes its
 * own). Nothing is held across the pass. So the others keep running while
 * the hung passes leave at least two of the pool's connections (max 10) free;
 * a server with more businesses hung at once than that runs out of
 * connections for everyone, and the log says so every interval
 * (`skippedInFlight`, `failed: deadline`). That is the limit, not "never".
 *
 * **Sequential, in `business_id` order.** No concurrency between businesses
 * at this stage: the separation does not need it to be correct, and two
 * passes sharing a process is exactly where a shared `db` would be
 * interleaved by accident.
 *
 * **A deadline stops the waiting, not the work.** `withDeadline` races the
 * pass against a timer; the pass itself keeps running. The business stays in
 * `state.inFlight` until its promise ACTUALLY settles, and every interval in
 * between skips it (`skippedInFlight`) rather than starting a second pass —
 * `pollMailbox` and the cursor writes assume one pass at a time, and the
 * `scheduler:${businessId}` lock inside `tick()` is transaction-scoped and
 * does not cover the whole pass.
 *
 * **Fairness.** When the interval's time budget runs out before every
 * business was reached, the rest go to `notReached` and `state.resumeFrom`
 * names the first of them, so the next interval starts there and a business
 * at the end of the list cannot starve.
 */
import { appendAudit } from '../audit/log.js';
import { activeCharterVersion } from '../charter/store.js';
import { withBusiness } from '../db/pool.js';
import { withDeadline } from '../governance/notify.js';
import { listActiveBusinesses } from '../tenancy/platform.js';
import { canonicalHash } from '../util/canonical.js';
import { businessRuntime, type Runtime, type ServerRuntime } from './runtime.js';
import { schedulerPass, type SchedulerPassResult } from './scheduler.js';

/** How long one business's pass may run before the loop stops waiting for it. */
export const SCHEDULER_BUSINESS_DEADLINE_MS = 120_000;

/** The default interval, and so the default time budget of one loop. */
export const SCHEDULER_INTERVAL_MS = 30_000;

/** How long recording a failure may take; it is best-effort. */
const FAILURE_AUDIT_TIMEOUT_MS = 5_000;

/** Kept by the process across intervals. */
export interface TenantLoopState {
  /** Businesses whose pass has started and not yet settled. */
  inFlight: Set<string>;
  /** The first business the previous interval did not reach, or null. */
  resumeFrom: string | null;
}

export interface TenantPassReport {
  ran: string[];
  skippedInFlight: string[];
  failed: { businessId: string; reason: 'threw' | 'deadline' }[];
  notReached: string[];
}

export type TenantPass = (
  businessId: string,
  options: { runtime: Runtime; now?: Date },
) => Promise<SchedulerPassResult>;

export interface RunAllBusinessesOptions {
  now?: Date;
  perBusinessDeadlineMs: number;
  state: TenantLoopState;
  /** The interval's time budget. Defaults to `SCHEDULER_INTERVAL_MS`. */
  budgetMs?: number;
  /**
   * Called once per business whose pass completed, with that business's
   * result and runtime warnings — for the operator log. Never told about a
   * failed pass; a failure is in `TenantPassReport.failed` and the audit row.
   */
  onPass?: (businessId: string, result: SchedulerPassResult, warnings: readonly string[]) => void;
  /** Test seam: replaces `schedulerPass`. Production leaves it unset. */
  pass?: TenantPass;
}

/**
 * The registry order, rotated to start at `resumeFrom` — the id itself when it
 * is still listed, else the first id after it. The list is ordered
 * `COLLATE "C"` (byte order), which is what JS `>=` on these ASCII ids
 * compares, so the fallback agrees with the order it is searching.
 */
function rotate(ids: string[], resumeFrom: string | null): string[] {
  if (resumeFrom === null) return ids;
  const exact = ids.indexOf(resumeFrom);
  const start = exact !== -1 ? exact : ids.findIndex((id) => id >= resumeFrom);
  if (start <= 0) return ids;
  return [...ids.slice(start), ...ids.slice(0, start)];
}

/**
 * One `audit_log` row in the failing business's OWN chain: kind `tool_call`,
 * reason `scheduler_pass_failed:<threw|deadline>`, and nothing else — no
 * error message, no job, no content. An error message can carry whatever the
 * pass was holding when it threw; the row says only that a pass failed and
 * how. On a connection of its own, since the failed pass may still hold one.
 *
 * Never throws: a failure recording a failure must not stop the loop.
 */
async function recordPassFailure(businessId: string, reason: 'threw' | 'deadline'): Promise<void> {
  try {
    await withDeadline(
      withBusiness(businessId, async (db) => {
        const charterVersion = await activeCharterVersion(db).catch(() => null);
        await appendAudit(db, {
          actor: 'system',
          kind: 'tool_call',
          charterVersion: charterVersion ?? 'n/a',
          // A system row about the installation, not a trust claim about any
          // content — the same choice `killswitch.ts` makes for its rows.
          provenance: 'boss',
          inputHash: canonicalHash({ kind: 'scheduler_pass_failed', reason }),
          reason: `scheduler_pass_failed:${reason}`,
        });
      }),
      FAILURE_AUDIT_TIMEOUT_MS,
      'רישום כשל הסבב',
    );
  } catch {
    // Best-effort — see the docblock.
  }
}

type Outcome = { ok: true; result: SchedulerPassResult; warnings: readonly string[] } | { ok: false };

export async function runAllBusinesses(
  server: ServerRuntime,
  options: RunAllBusinessesOptions,
): Promise<TenantPassReport> {
  const { state } = options;
  const pass: TenantPass = options.pass ?? schedulerPass;
  const budgetMs = options.budgetMs ?? SCHEDULER_INTERVAL_MS;

  const report: TenantPassReport = { ran: [], skippedInFlight: [], failed: [], notReached: [] };
  const order = rotate(await listActiveBusinesses(), state.resumeFrom);
  state.resumeFrom = null;
  // The budget is for running businesses, so its clock starts once the list is in.
  const startedAt = Date.now();

  for (const [index, businessId] of order.entries()) {
    // The first business always runs, whatever the budget: a budget smaller
    // than one pass must not starve every business forever.
    if (index > 0 && Date.now() - startedAt >= budgetMs) {
      report.notReached = order.slice(index);
      state.resumeFrom = report.notReached[0] ?? null;
      break;
    }
    if (state.inFlight.has(businessId)) {
      report.skippedInFlight.push(businessId);
      continue;
    }

    state.inFlight.add(businessId);
    const work: Promise<Outcome> = (async (): Promise<Outcome> => {
      // The runtime's connection is released before the pass starts: nothing
      // is held across the pass (see the bound in the docblock).
      const runtime = await withBusiness(businessId, (db) => businessRuntime(server, db));
      const result = await pass(businessId, {
        runtime,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      return { ok: true as const, result, warnings: runtime.warnings };
    })()
      .catch((): Outcome => ({ ok: false }))
      .finally(() => {
        // Only here, when the pass has really finished — never on the
        // deadline below, which stops the waiting and not the work.
        state.inFlight.delete(businessId);
      });

    let outcome: Outcome | 'deadline';
    try {
      outcome = await withDeadline(work, options.perBusinessDeadlineMs, 'סבב העסק');
    } catch {
      outcome = 'deadline';
    }

    if (outcome === 'deadline' || !outcome.ok) {
      const reason = outcome === 'deadline' ? 'deadline' : 'threw';
      report.failed.push({ businessId, reason });
      await recordPassFailure(businessId, reason);
      continue;
    }
    report.ran.push(businessId);
    try {
      options.onPass?.(businessId, outcome.result, outcome.warnings);
    } catch {
      // The operator log is a courtesy; it must not stop the next business.
    }
  }

  return report;
}
