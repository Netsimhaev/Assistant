import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { loadActiveCharter } from '../charter/store.js';
import { loadJob } from './jobs.js';
import { loadPlanBody } from './plan-store.js';
import { rampLevelForPlan } from './ramp.js';
import { runPlanForJob } from './run-plan.js';
import { buildRuntime } from './runtime.js';
import type { Runtime } from './runtime.js';

/**
 * One job's outcome from a `runDueJobs` pass.
 *
 * Mirrors `RunPlanResult['status']` exactly (`run-plan.ts`), because that is
 * exactly what it reports — this function adds no status of its own for a
 * job that actually ran.
 */
export interface RanJob {
  jobId: string;
  status: 'done' | 'halted' | 'rejected';
  /** The halt reason or rejection detail; null on a clean completion. */
  detail: string | null;
}

/** A job whose processing threw, and did not reach a `RanJob` outcome at all. */
export interface ErroredJob {
  jobId: string;
  error: string;
}

export interface RunDueResult {
  ran: RanJob[];
  /** Jobs another runner held the lock on during this pass. */
  lockedOut: string[];
  /** Jobs in `execute` with no plan stored — nothing to run, and worth saying. */
  unbound: string[];
  /**
   * Jobs the initial query found in `execute`, but whose phase had already
   * moved by the time this runner re-read them under the per-job lock —
   * another runner finished it, or the scheduler moved it to `followup`, in
   * the moment between the query and the lock being granted. Nothing is
   * wrong: this is the race the re-read exists to catch (see the function
   * docblock). Reported anyway, because a bucket nobody reads is the same as
   * no bucket at all — see `logErrored` in `run-scheduler.ts`.
   */
  phaseMoved: string[];
  /**
   * Jobs whose processing threw before reaching any outcome — a stored plan
   * that no longer parses (`loadPlanBody` throws by design, see its
   * docblock), or a transient failure from `loadJob`, `loadActiveCharter`,
   * `rampLevelForPlan`, or `runPlanForJob` itself.
   *
   * Distinct from `ran`: nothing ran. A job here reached no `RunPlanResult`
   * at all, so there is no `status` to report — only the error that stopped
   * it before one could be produced. Isolated per job so one poison-pill row
   * — a corrupted plan that will never parse, sorting first on every pass
   * because it never advances — cannot stop every other due job of the same
   * business from running on this pass and every pass after it.
   */
  errored: ErroredJob[];
}

interface DueJobRow {
  job_id: string;
}

/**
 * `runPlanForJob`'s first production caller.
 *
 * Everything built since `run-plan.ts` was written runs through it, and until
 * this function nothing in production ever called it — only tests did. Finds
 * every job sitting in `execute` with a plan already bound, and runs each one.
 *
 * **The per-job lock is session-scoped (`pg_try_advisory_lock`), not
 * transaction-scoped.** A plan run makes external calls bounded only by the
 * adapter deadline (`run-plan.ts`'s `ADAPTER_TIMEOUT_MS`), and holding a
 * database transaction open across that call is how a ten-connection pool
 * dies under two concurrent runs. The lock is taken on a client checked out
 * for exactly this purpose and released in a `finally`, whatever happens in
 * between.
 *
 * **`pg_try_advisory_lock`, not the blocking form**, for the same reason
 * `tick()` (`scheduler.ts`) uses `pg_try_advisory_xact_lock` and not a
 * blocking wait: a second runner must skip a job someone else already holds
 * and come back next pass, never queue behind it and then repeat its work
 * once the first one finishes.
 *
 * **The job is re-read under the lock**, not trusted from the query that
 * found it. Its phase may have moved between that query and the lock being
 * granted — another runner may have already finished it, or the scheduler
 * may have moved it to `followup` a moment earlier. `runPlan` checks the
 * phase too, but only after it has already bound the plan to the job (see
 * that check's own docblock for why re-checking early is cheaper); checking
 * here first is belt-and-braces, not a substitute for it.
 *
 * **Every per-job failure is isolated.** The whole per-job body — lock
 * acquisition included — sits inside its own `try`/`catch`, and a throw
 * there lands in `errored` rather than propagating out of the function. A
 * stored plan that no longer parses (`loadPlanBody` throws rather than
 * returning null — see that function's docblock) would otherwise abort this
 * loop on the first pass it was found, and keep aborting it on every pass
 * after: a job that cannot advance sorts first forever under
 * `ORDER BY updated_at ASC`, so every job behind it would never run again
 * until a human repaired the row by hand. `runDueJobs` itself still throws,
 * but only for the one query that is not per-job — the initial `SELECT`
 * that finds the due jobs in the first place.
 */
export async function runDueJobs(
  options: { businessId?: string; limit?: number; runtime?: Runtime; now?: Date } = {},
): Promise<RunDueResult> {
  const businessId = options.businessId ?? config.businessId;
  const limit = options.limit ?? 20;
  const runtime = options.runtime ?? buildRuntime();

  const { rows } = await getPool().query<DueJobRow>(
    `SELECT job_id FROM jobs
      WHERE business_id = $1
        AND phase = 'execute'
        AND closed_at IS NULL
      ORDER BY updated_at ASC
      LIMIT $2`,
    [businessId, limit],
  );

  const result: RunDueResult = {
    ran: [],
    lockedOut: [],
    unbound: [],
    phaseMoved: [],
    errored: [],
  };

  for (const row of rows) {
    const jobId = row.job_id;
    const lockScope = `run-due:${businessId}:${jobId}`;
    const client = await getPool().connect();
    let holdsLock = false;
    try {
      try {
        const lock = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
          [lockScope],
        );
        if (lock.rows[0]?.locked !== true) {
          result.lockedOut.push(jobId);
          continue;
        }
        holdsLock = true;

        // Re-read under the lock — see the docblock above.
        const job = await loadJob(jobId, { businessId });
        if (job === null || job.phase !== 'execute') {
          result.phaseMoved.push(jobId);
          continue;
        }

        const stored = await loadPlanBody(jobId, { businessId });
        if (stored === null) {
          result.unbound.push(jobId);
          continue;
        }

        const active = await loadActiveCharter(businessId);
        if (active === null) {
          // Fatal, never permissive: a job cannot run without the policy
          // that governs it.
          result.ran.push({ jobId, status: 'rejected', detail: 'no_active_charter' });
          continue;
        }

        const rampLevel = await rampLevelForPlan(stored.plan, { businessId });

        const outcome = await runPlanForJob({
          job,
          bundle: active.bundle,
          plan: stored.plan,
          registry: runtime.registry,
          credentials: runtime.credentials,
          // No tag resolver exists yet. `[]` states "nobody resolved tags" —
          // a different claim from "we did not look" — and stays explicit so
          // no tag-scoped policy rule is silently disabled by this caller.
          counterpartyTags: [],
          rampLevel,
          ...(runtime.notify !== undefined ? { notify: runtime.notify } : {}),
          ...(options.now !== undefined ? { now: options.now } : {}),
        });

        result.ran.push({
          jobId,
          status: outcome.status,
          detail:
            outcome.status === 'done'
              ? null
              : outcome.status === 'halted'
                ? outcome.reason
                : outcome.code,
        });
      } catch (error) {
        // This job's failure must not take the rest of the pass down with
        // it — see the docblock above. Nothing ran, so this is `errored`,
        // never a `ran` entry with a made-up status.
        result.errored.push({
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (holdsLock) {
        // The unlock attempt and the release are kept apart so `release` is
        // called exactly once on every path. Nesting `client.release()`
        // inside the `try` and `client.release(err)` inside its `catch` — the
        // earlier shape here — released twice if `release()` itself ever
        // threw: once from the `try`, once more from the `catch` it fell
        // into.
        let unlockError: unknown;
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockScope]);
        } catch (error) {
          unlockError = error;
        }
        if (unlockError === undefined) {
          client.release();
        } else {
          // The advisory lock is session-scoped, not connection-scoped by
          // magic: it lives on the session pg gave this client, and only
          // ends for certain when that session ends. `client.release()`
          // with no argument returns the session to the pool ALIVE, so a
          // failed unlock followed by a plain release hands the next
          // caller of this connection a session that still holds this
          // job's lock — every future run on this job would see
          // `pg_try_advisory_lock` fail and report `lockedOut`, silently,
          // until the pool eventually recycles the connection on its own
          // (`idleTimeoutMillis` in `db/pool.ts`). Passing the error to
          // `release` tells `pg` to destroy the connection instead of
          // pooling it, which is the only way to be sure the lock is gone.
          client.release(
            unlockError instanceof Error ? unlockError : new Error(String(unlockError)),
          );
        }
      } else {
        client.release();
      }
    }
  }

  return result;
}
