import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { loadActiveCharter } from '../charter/store.js';
import { loadEnvelopeForChildJob } from '../governance/envelope-store.js';
import { loadJob, transition } from './jobs.js';
import { loadPlanBody } from './plan-store.js';
import { rampLevelForPlan } from './ramp.js';
import { runPlanForJob, type RunPlanForJobRequest } from './run-plan.js';
import { buildRuntime } from './runtime.js';
import type { Runtime } from './runtime.js';

/**
 * One job's outcome from a `runDueJobs` pass.
 *
 * Mirrors `RunPlanResult['status']` exactly (`run-plan.ts`), because that is
 * exactly what it reports — this function adds no status of its own for a
 * job that actually ran.
 *
 * A `rejected` entry has already been moved to `failed` by the time it is
 * listed here, the same way `unbound` is (I1) — see the transition at the
 * call site for why, and for why `halted` deliberately is not.
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
  /**
   * Jobs found in `execute` with no plan stored — nothing to run, so each is
   * transitioned to `failed` before being listed here.
   *
   * **Why terminal rather than left alone (I2).** Reporting without moving
   * the row was the earlier shape, and it starved this loop: the initial
   * `SELECT` orders by `updated_at ASC LIMIT 20`, an unbound job's
   * `updated_at` never moves, so it sorts first on every subsequent pass
   * forever. Twenty such rows and the window is permanently full of jobs
   * nothing can advance, and no genuinely runnable job of that business is
   * ever reached again. `run-scheduler.ts` had already documented the
   * mechanism as an outstanding policy call; the conductor made it certain
   * by becoming the first production producer of unbound `execute` jobs —
   * `conduct.ts` parks a job in `await_approval`, the owner approves,
   * `resume.ts` moves it to `execute`, and no plan was ever bound to it.
   *
   * Still listed here after the transition. The bucket is what
   * `run-scheduler.ts` prints, and an operator needs to know this happened;
   * a disposition nobody is told about is the same silence in a different
   * phase.
   */
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
  options: {
    businessId?: string;
    limit?: number;
    runtime?: Runtime;
    now?: Date;
    /**
     * Forwarded to `runPlanForJob`'s `RunPlanRequest.reader` — the seam that
     * keeps a test exercising `doc.fetch` through this real entry point from
     * reaching the live, billed `runKnowReader`. Production callers leave it
     * unset.
     */
    reader?: RunPlanForJobRequest['reader'];
    /**
     * Forwarded to `runPlanForJob`'s `RunPlanRequest.judge` — the same kind of
     * seam `reader` is, for the other local step that costs money (the judge
     * inside `assert.evaluate`, `gov.verify`'s judging step). A test driving
     * the verification loop through this real entry point would otherwise
     * reach the billed `judgeWithModel`, whose own `refuseUnderTest` guard
     * would throw and fail the step rather than let the loop finish.
     * Production callers leave it unset.
     */
    judge?: RunPlanForJobRequest['judge'];
  } = {},
): Promise<RunDueResult> {
  const businessId = options.businessId ?? config.businessId;
  const limit = options.limit ?? 20;
  const runtime = options.runtime ?? (await buildRuntime());

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
          // Terminal, not merely reported — see `RunDueResult.unbound`.
          //
          // **The question this used to leave open was answered on 11/09,
          // and by the owner.** The shape described here — bind the one-step
          // plan `proposalToPlan` compiles and let it run — is now what
          // `conduct.ts` does, before the card is ever raised. It was not
          // acquired as the side effect of this starvation fix: the owner
          // asked for it after a live run showed that approving a conductor
          // card did nothing but land here.
          //
          // So an approved conductor card no longer reaches this branch at
          // all. What routes a document-authored payload into
          // `evaluateToolCall` is now exactly that, and the gate is what
          // refuses it: `conduct.ts` stamps `unknown_external`, whose
          // provenance ceiling the signed charter sets to `draft_only`, so
          // stage 8 denies and writes an audit row saying so.
          //
          // This branch remains for what it was always really about — a job
          // that reached `execute` with nothing bound for some other reason —
          // and stays terminal so it cannot hold the scheduler's window.
          await transition(jobId, {
            to: 'failed',
            actor: 'system',
            reason: 'run_due: no_plan_bound',
            businessId,
          });
          result.unbound.push(jobId);
          continue;
        }

        const active = await loadActiveCharter(businessId);
        if (active === null) {
          // Fatal, never permissive: a job cannot run without the policy
          // that governs it.
          //
          // Deliberately NOT transitioned to `failed`, unlike the `rejected`
          // outcomes below. This is the one rejection that is a property of
          // the BUSINESS rather than of the job: no job of this business can
          // run while the charter is missing, so there is nothing behind
          // this row for it to starve — and installing a charter makes every
          // one of them runnable again. Failing them all on the way past
          // would be an irreversible answer to a repairable condition.
          result.ran.push({ jobId, status: 'rejected', detail: 'no_active_charter' });
          continue;
        }

        const rampLevel = await rampLevelForPlan(stored.plan, { businessId });

        // A hard cap this job inherited from the envelope that opened it as a
        // delegation's child — `null` for an ordinary root job nothing ever
        // delegated into. Folded into every step's `GateContext.autonomyCeiling`
        // so "constraints tighten monotonically down a delegation chain" is
        // true of what gets ENFORCED, not merely of what gets stored: without
        // this lookup the ceiling `requestHelp` wrote onto the envelope has no
        // reader in production at all.
        const governingEnvelope = await loadEnvelopeForChildJob(job.jobId, { businessId });

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
          ...(options.reader !== undefined ? { reader: options.reader } : {}),
          ...(options.judge !== undefined ? { judge: options.judge } : {}),
          ...(governingEnvelope !== null
            ? { autonomyCeiling: governingEnvelope.constraints.autonomyCeiling }
            : {}),
        });

        if (outcome.status === 'rejected') {
          // Terminal, for exactly the reason `RunDueResult.unbound` gives
          // (I1). `rejected` means `runPlan` refused before performing
          // anything, and it refused on a property of the stored plan and
          // the charter — `no_channel_for_tool`, `ambiguous_channel`,
          // `no_adapter_for_system` — none of which the next pass will find
          // any different. Reported and left alone, the phase never moves,
          // `updated_at` stays frozen, and the row sorts first under
          // `ORDER BY updated_at ASC LIMIT 20` on every pass forever;
          // twenty of them and that business's execution loop is dead.
          //
          // The instruction door is what made this reachable: `instruct.ts`
          // is the only production caller of `bindPlanToJob`, and its
          // pre-checks deliberately cover only what needs no database, so
          // the three channel rejections above can arrive here and nowhere
          // else. An owner with no WhatsApp connection in the charter typing
          // "תשלחי לדנה וואטסאפ" produces one on the first pass.
          //
          // `halted` is NOT treated this way and must not be: `executeStep`
          // has already moved the phase itself for every halt — to
          // `await_approval`, `followup` or `failed` — so this job is not in
          // `execute` any more and a transition from here would either be
          // illegal or would overwrite a decision that was made properly.
          await transition(jobId, {
            to: 'failed',
            actor: 'system',
            reason: `run_due: ${outcome.code}`,
            businessId,
          });
        }

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
