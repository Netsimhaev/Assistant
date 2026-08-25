import { config } from '../config.js';
import { getPool, withTransaction } from '../db/pool.js';
import { expireOverdue } from '../governance/approvals.js';
import { loadJob, transition } from './jobs.js';
import { runDueJobs } from './run-due.js';
import type { RunDueResult } from './run-due.js';
import { closeVerifiedJobs } from './verify.js';
import type { CloseVerifiedResult } from './verify.js';
import type { Runtime } from './runtime.js';

export interface TickResult {
  /** Approvals whose fuse ran out on this tick. */
  expiredApprovals: string[];
  /** Jobs whose wake time had come and that were returned to `execute`. */
  wokenJobs: string[];
  /** True when another scheduler held the lock and this tick did nothing. */
  skipped: boolean;
}

/**
 * One pass of the scheduler.
 *
 * Everything the orchestrator defers depends on this existing. `executeStep`
 * parks a job in `followup` with a `wakeAt` when quiet hours push a message to
 * the morning, and `expireOverdue` marks an approval dead when nobody answered
 * — and until now nothing called either, so a deferred message slept forever
 * and an approval's TTL was decoration.
 *
 * Written as a function returning what it did, with the loop on the outside.
 * A tick you can call once is a tick you can test; a `setInterval` with the
 * logic inside it is not.
 */
export async function tick(
  options: { businessId?: string; now?: Date; limit?: number } = {},
): Promise<TickResult> {
  const businessId = options.businessId ?? config.businessId;
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;

  return withTransaction(async (tx) => {
    // Only one scheduler works a business at a time. `try` rather than a
    // blocking wait: a second scheduler should skip this tick and come back,
    // not queue up behind the first and then repeat its work.
    const { rows } = await tx.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
      [`scheduler:${businessId}`],
    );
    if (rows[0]?.locked !== true) {
      return { expiredApprovals: [], wokenJobs: [], skipped: true };
    }

    const expiredApprovals = await expireApprovals(businessId, limit);
    const wokenJobs = await wakeDueJobs(businessId, now, limit);

    return { expiredApprovals, wokenJobs, skipped: false };
  });
}

/**
 * Expire approvals nobody answered, and free the jobs waiting on them.
 *
 * The job goes to `followup` rather than `failed`: an unanswered approval is
 * not a rejection, and the work is still worth doing when someone gets to it.
 * `onTimeout: 'escalate_next'` is what an anomalous action carries, and
 * escalation is a delivery concern — the job's state is the same either way.
 */
async function expireApprovals(businessId: string, limit: number): Promise<string[]> {
  // Deliberately on the pool and not the caller's transaction: `expireOverdue`
  // is a single atomic UPDATE ... RETURNING, and joining it to the tick's
  // transaction would hold the scheduler lock across every job transition
  // below, each of which opens a transaction of its own.
  const expired = await expireOverdue({ businessId });

  const ids: string[] = [];
  for (const approval of expired.slice(0, limit)) {
    ids.push(approval.approvalId);
    if (approval.jobId === null) continue;

    const job = await loadJob(approval.jobId, { businessId });
    if (job === null || job.phase !== 'await_approval') continue;

    await transition(job.jobId, {
      to: 'followup',
      actor: 'system',
      reason: `approval_expired:${approval.approvalId}`,
      businessId,
    });
  }
  return ids;
}

/** Return every job whose wake time has come to `execute`. */
async function wakeDueJobs(
  businessId: string,
  now: Date,
  limit: number,
): Promise<string[]> {
  const { rows } = await getPool().query<{ job_id: string; phase: string }>(
    `SELECT job_id, phase FROM jobs
      WHERE business_id = $1
        AND closed_at IS NULL
        AND wake_at IS NOT NULL
        AND wake_at <= $2
      ORDER BY wake_at ASC
      LIMIT $3`,
    [businessId, now, limit],
  );

  const woken: string[] = [];
  for (const row of rows) {
    // Only a sleeping job is woken. A job that moved on since the query is not
    // ours to advance, and `transition` would reject it anyway — checking here
    // keeps one stale row from aborting the whole tick.
    if (row.phase !== 'followup') continue;
    await transition(row.job_id, {
      to: 'execute',
      actor: 'system',
      reason: 'wake_at reached',
      businessId,
    });
    woken.push(row.job_id);
  }
  return woken;
}

export interface SchedulerPassResult {
  tick: TickResult;
  due: RunDueResult;
  verified: CloseVerifiedResult;
}

/**
 * One full pass: tick, then run whatever the tick made ready.
 *
 * Two calls, one after the other, and the order is the whole point — a job
 * woken by the tick is in `execute` by the time `runDueJobs` looks, so it runs
 * in the same pass instead of waiting a full interval.
 *
 * `runDueJobs` is called **after** `tick` has returned and its transaction has
 * committed, never inside it: `tick` holds a transaction-scoped advisory lock
 * for its whole body, and a plan's external calls — bounded only by the
 * adapter deadline — have no business holding a pooled connection open across
 * the wire behind that lock.
 *
 * A skipped tick — another scheduler holds the business-wide lock — still
 * runs the due pass. The per-job locks in `runDueJobs` are what actually keep
 * two runners apart, and they are finer-grained than the tick's lock.
 */
export async function schedulerPass(
  options: { businessId?: string; now?: Date; limit?: number; runtime?: Runtime } = {},
): Promise<SchedulerPassResult> {
  const tickResult = await tick(options);
  const due = await runDueJobs(options);
  // Third and last, and the order matters as much as the first two: a job
  // `runDueJobs` just finished is sitting in `verify` by the time this looks,
  // so it closes in the same pass instead of waiting a full interval. Run
  // before the plans instead and every close would trail a pass behind the
  // work that earned it.
  const verified = await closeVerifiedJobs(options);
  return { tick: tickResult, due, verified };
}

export interface SchedulerHandle {
  /** Resolves once the loop has stopped and any in-flight tick has finished. */
  stop: () => Promise<void>;
}

/**
 * Run `schedulerPass` on an interval until stopped.
 *
 * Polling Postgres rather than pg-boss. The roadmap names pg-boss and it is
 * the right answer for throughput, but the work here is a handful of rows a
 * minute, and a dependency that owns the job lifecycle is not something to
 * take on before the lifecycle it has to own is finished.
 *
 * Ticks never overlap: the in-flight guard means a slow pass delays the next
 * one instead of running two at once.
 */
export function startScheduler(
  options: {
    businessId?: string;
    intervalMs?: number;
    runtime?: Runtime;
    /**
     * Called after every pass that completed without throwing — including a
     * pass whose `due.errored` is non-empty. `runDueJobs` isolates a per-job
     * failure into `errored` rather than throwing (see its own docblock), so
     * a stuck job never reaches `onError`; this is the only hook that sees it.
     */
    onResult?: (result: SchedulerPassResult) => void;
    onError?: (error: unknown) => void;
  } = {},
): SchedulerHandle {
  const intervalMs = options.intervalMs ?? 30_000;
  let running = false;
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    const businessId = options.businessId;
    const runtime = options.runtime;
    inFlight = schedulerPass({
      ...(businessId === undefined ? {} : { businessId }),
      ...(runtime === undefined ? {} : { runtime }),
    })
      .then((result) => {
        options.onResult?.(result);
      })
      .catch((error) => {
        // A failing pass must not kill the loop — the next one may well
        // succeed, and a scheduler that dies quietly is worse than one that
        // retries.
        options.onError?.(error);
      });
    try {
      await inFlight;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), intervalMs);
  // Do not hold the process open on this timer alone.
  timer.unref?.();
  void run();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
