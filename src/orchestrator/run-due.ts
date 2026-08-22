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

export interface RunDueResult {
  ran: RanJob[];
  /** Jobs another runner held the lock on during this pass. */
  lockedOut: string[];
  /** Jobs in `execute` with no plan stored — nothing to run, and worth saying. */
  unbound: string[];
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
 * A stored plan that no longer parses is `loadPlanBody`'s problem, not this
 * function's: it throws rather than resolving to null, because null there
 * means "unbound" and this function must not treat an unreadable plan as
 * license to leave the job alone. The lock is still released — the throw
 * happens inside the per-job `try`, and `finally` runs regardless.
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

  const result: RunDueResult = { ran: [], lockedOut: [], unbound: [] };

  for (const row of rows) {
    const jobId = row.job_id;
    const lockScope = `run-due:${businessId}:${jobId}`;
    const client = await getPool().connect();
    let holdsLock = false;
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
      if (job === null || job.phase !== 'execute') continue;

      const stored = await loadPlanBody(jobId, { businessId });
      if (stored === null) {
        result.unbound.push(jobId);
        continue;
      }

      const active = await loadActiveCharter(businessId);
      if (active === null) {
        // Fatal, never permissive: a job cannot run without the policy that
        // governs it.
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
    } finally {
      if (holdsLock) {
        await client
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockScope])
          .catch(() => {
            // The lock dies with the session regardless; a failed unlock must
            // not mask whatever error is already unwinding through this call.
          });
      }
      client.release();
    }
  }

  return result;
}
