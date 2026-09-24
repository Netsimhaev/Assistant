import { config } from '../config.js';
import { getPool, withTransaction } from '../db/pool.js';
import { expireOverdue } from '../governance/approvals.js';
import { conductPendingDocuments } from './conduct.js';
import type { ConductOptions, ConductResult } from './conduct.js';
import { scanInbox } from './inbox-scan.js';
import type { ScanResult } from './inbox-scan.js';
import { loadJob, transition } from './jobs.js';
import { evaluateAutonomy } from './promote.js';
import type { AutonomyPassResult } from './promote.js';
import { resumeDelegatedJobs } from './resume-delegated.js';
import type { ResumeResult } from './resume-delegated.js';
import { runDueJobs } from './run-due.js';
import type { RunDueResult } from './run-due.js';
import { buildRuntime } from './runtime.js';
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
  /** Null when no inbox is configured, or when the scan itself faulted. */
  scan: ScanResult | null;
  /**
   * `scanInbox`'s thrown message, if it threw. Null on a clean scan and null
   * when no inbox is configured at all — those two are not failures.
   */
  scanError: string | null;
  /**
   * Null when no inbox is configured — the same switch that stops the scan
   * stops the understanding loop, and for a stronger reason: this half is the
   * one that costs money. `null` is not `{ considered: 0, ... }`; "the
   * conductor did not run" and "the conductor ran and found nothing" are
   * different facts about an installation, and only the first is a statement
   * about how it is configured.
   */
  conduct: ConductResult | null;
  /**
   * Parents freed this pass — either because their child reached a terminal
   * phase, or because the envelope's own deadline ran out first.
   *
   * Run first, right after the tick and before `runDueJobs`: a child that
   * closed on the PREVIOUS pass wakes its parent at the top of THIS one, so
   * the parent is sitting in `execute` by the time `runDueJobs` looks and
   * runs in this very pass instead of waiting a full interval. Running it
   * after the plans instead would cost every delegation a full extra
   * interval for no reason — the same ordering argument this function's own
   * docblock makes for `runDueJobs` before `closeVerifiedJobs`.
   */
  delegated: ResumeResult;
  due: RunDueResult;
  verified: CloseVerifiedResult;
  /** Which action classes this round moved up, and which moved down. */
  autonomy: AutonomyPassResult;
  /**
   * `evaluateAutonomy`'s thrown message, if it threw. Null on a clean pass.
   *
   * The same treatment `scanError` gets, and for the same reason. The pass's
   * own `try/catch` isolates ONE class (spec §10); a throw outside that loop
   * — `loadAutonomyMode` on a transient database error — would reject
   * `schedulerPass` itself, and `startScheduler` routes a rejected pass to
   * `onError` INSTEAD of `onResult`. That would suppress the tick, the scan,
   * the plans and the closes that had all already succeeded, because the
   * bookkeeping that runs last after them failed.
   */
  autonomyError: string | null;
}

/**
 * One full pass: tick, then run whatever the tick made ready.
 *
 * Four calls, one after the other, and the order is the whole point — a job
 * woken by the tick is in `execute` by the time `runDueJobs` looks, so it runs
 * in the same pass instead of waiting a full interval.
 *
 * The two document-conductor loops (`scanInbox`, `conductPendingDocuments`)
 * sit between the tick and `runDueJobs`, for the same reason `runDueJobs`
 * itself is called after `tick` has returned and its transaction has
 * committed, never inside it: `tick` holds a transaction-scoped advisory lock
 * for its whole body, and neither a file read nor a model call — bounded only
 * by their own deadlines — has any business holding a pooled connection open
 * across the wire behind that lock.
 *
 * **Both loops are behind the same switch.** `scan` and `conduct` are both
 * `null`, and neither runs, when `config.documentInbox` (or an explicit
 * `options.inbox`) is absent: an installation that has not configured a
 * watched folder is a switch, not a fault, and the pass must neither throw
 * nor pretend a scan happened. `conductPendingDocuments` used to sit outside
 * this guard, which meant an installation that upgraded with an API key
 * present and no `DOCUMENT_INBOX` set began paying to read every `extracted`
 * document already in its database within one interval of launch — spec §10
 * says a missing `DOCUMENT_INBOX` means the conductor does not run, and the
 * half that ran was the half that costs. `DOCUMENT_READS_PER_DAY=0` is a
 * ceiling, not a switch, and must never be the only way to turn this off.
 *
 * A configured inbox that `scanInbox` cannot actually read — the folder is
 * missing, permissions are wrong, a path component is a plain file — is a
 * different thing from an absent one, and the spec's own failure table
 * (§9) says so: recorded, and the scheduler carries on. `scanInbox` genuinely
 * throws on that class of fault (its own docblock only documents one case,
 * a reserved subdirectory name occupied by a file, but any `mkdir`/`readdir`
 * error not caught there propagates the same way), so the call is wrapped
 * here rather than left to reach the caller. Letting it escape would stop
 * `conduct`, `due` and `verified` from running for as long as the path stays
 * broken — every interval, forever — and would crash `run-scheduler.ts`'s
 * unguarded startup call outright. `scanError` carries the message so an
 * operator watching the process log sees it; `scan` stays `null`, the same
 * value an absent inbox produces, because no scan result exists either way.
 *
 * A skipped tick — another scheduler holds the business-wide lock — still
 * runs the rest of the pass. The per-job locks in `runDueJobs` and the
 * conductor's own advisory lock are what actually keep two runners apart, and
 * they are finer-grained than the tick's lock.
 */
export async function schedulerPass(
  options: {
    businessId?: string;
    now?: Date;
    limit?: number;
    runtime?: Runtime;
    /** Defaults to `config.documentInbox`. */
    inbox?: string | null;
    documentRoot?: string;
    readsPerDay?: number;
    reader?: ConductOptions['reader'];
    proposer?: ConductOptions['proposer'];
  } = {},
): Promise<SchedulerPassResult> {
  const tickResult = await tick(options);

  // First after the tick, and the order matters: a child that closed on the
  // previous pass wakes its parent at the top of this one, so the parent runs
  // in this very pass through `runDueJobs` below. Run it after the plans
  // instead and every delegation would cost a full extra interval.
  const delegated = await resumeDelegatedJobs(options);

  // Both conductor loops run after the tick's transaction has committed, not
  // inside it — see the docblock above.
  const inbox = options.inbox !== undefined ? options.inbox : config.documentInbox;
  const runtime = options.runtime ?? (await buildRuntime());
  let scan: ScanResult | null = null;
  let scanError: string | null = null;
  let conduct: ConductResult | null = null;
  if (inbox !== null) {
    try {
      scan = await scanInbox({
        inbox,
        ...(options.businessId !== undefined ? { businessId: options.businessId } : {}),
        ...(options.documentRoot !== undefined ? { documentRoot: options.documentRoot } : {}),
      });
    } catch (err) {
      // A broken inbox must not stop the rest of the pass. `scan` stays
      // `null` and `conduct`/`due`/`verified` still run below. Note the
      // asymmetry with an *absent* inbox: a folder that is configured but
      // unreadable is still a configured installation, so the understanding
      // loop below still runs against whatever is already in the database —
      // documents ingested on earlier passes do not stop deserving a reading
      // because today's `readdir` failed.
      scanError = err instanceof Error ? err.message : String(err);
    }

    conduct = await conductPendingDocuments({
      ...options,
      // The conductor writes approvals without passing through the gate, and
      // the gate was carrying the notification. Threaded here so a conductor
      // card reaches the owner's mailbox exactly as a gate-raised one does.
      ...(runtime.notify !== undefined ? { notify: runtime.notify } : {}),
    });
  }

  const due = await runDueJobs({ ...options, runtime });
  // Last, and the order matters as much as the rest: a job `runDueJobs` just
  // finished is sitting in `verify` by the time this looks, so it closes in
  // the same pass instead of waiting a full interval. Run before the plans
  // instead and every close would trail a pass behind the work that earned
  // it.
  const verified = await closeVerifiedJobs(options);
  // Last, and for the same reason `closeVerifiedJobs` runs after the plans:
  // this pass reads what this very round produced — an approval just decided,
  // a job just failed. Run it earlier and every evaluation trails a pass
  // behind the evidence that justifies it (spec §10).
  //
  // Guarded rather than awaited bare: see `autonomyError`. Everything above
  // has already happened by the time this runs, and a bookkeeping pass that
  // failed must not hide the work that succeeded.
  let autonomy: AutonomyPassResult = { promoted: [], demoted: [], errored: [] };
  let autonomyError: string | null = null;
  try {
    autonomy = await evaluateAutonomy(options);
  } catch (err) {
    autonomyError = err instanceof Error ? err.message : String(err);
  }
  return {
    tick: tickResult,
    scan,
    scanError,
    conduct,
    delegated,
    due,
    verified,
    autonomy,
    autonomyError,
  };
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
