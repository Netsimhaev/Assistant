/**
 * The reader the `verify` phase never had.
 *
 * `runDueJobs` (`run-due.ts`) leaves a finished job in `verify` and stops
 * there. Nothing in production has ever read that phase, so every job the run
 * engine completed sat in `verify` for good — the live thread of 2026-08-24
 * is still sitting there. A phase with no reader is not a resting place, it
 * is a leak: the job is neither running nor closed, and nothing would ever
 * call it done.
 *
 * **This does not verify anything against the far end, and says so in the
 * reason it records.** `Plan` carries no acceptance criteria, and the one
 * tool that has actually run — `mail.send` over SMTP — offers no way to ask
 * what became of a message: `externalId` is a handle the provider echoed
 * back, not a query interface. So the honest job here is bookkeeping over the
 * record the engine itself wrote, and the trail must not imply more. A real
 * verifier, once there is something to ask, is a separate change.
 *
 * The decision is a positive control, like every other in this codebase: a
 * job closes only when every step the plan declares has a row and every one
 * of those rows says `completed`. Anything else stops the job at `failed`
 * with a reason naming what was wrong. An `unknown` row means the call went
 * out and no authoritative answer came back (`callWithDeadline`,
 * `run-plan.ts`); closing on top of that would record success for an action
 * nobody can say happened.
 */
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { curateJob } from '../memory/curate.js';
import type { Curator } from '../sdk/curator.js';
import { loadJob, transition } from './jobs.js';
import { loadPlanBody, stepResults } from './plan-store.js';

/** A job this pass stopped instead of closing, and why. */
export interface HaltedJob {
  jobId: string;
  detail: string;
}

/** A job whose processing threw before it reached any disposition. */
export interface ErroredVerifyJob {
  jobId: string;
  error: string;
}

export interface CloseVerifiedResult {
  /** Jobs carried all the way to `closed` this pass. */
  closed: string[];
  /** Jobs moved to `failed` because the record does not support closing them. */
  failed: HaltedJob[];
  /**
   * Jobs in `verify` with no plan bound. Left exactly where they are: with no
   * plan there is no list of steps to check the record against, and a job
   * that cannot be judged must not be closed on the strength of not having
   * been judged.
   */
  unbound: string[];
  /** Jobs another runner held the lock on during this pass. */
  lockedOut: string[];
  /** Jobs whose phase moved between the scan and the lock being granted. */
  phaseMoved: string[];
  /** Per-job failures, isolated so one bad row cannot end the pass. */
  errored: ErroredVerifyJob[];
  /**
   * Jobs whose curation actually ran this pass — `curateJob`'s `ran` flag.
   * True for a clean pass, but also true when the attempt wrote some
   * candidates and then failed partway through (`written > 0` inside its
   * `catch` still counts as `ran`), so membership here is not by itself
   * proof of a clean run. A job that closed without appearing in either
   * this list or `curationSkipped` below is the one `CurationOutcome`
   * shape neither list carries: `ran: false, skipped: null, failed: true`
   * — an attempt that threw before writing a single candidate (a model
   * error, a failed query, `refuseUnderTest` firing under
   * `NODE_ENV=test`). `curateJob` still records that failure as its own
   * `curation` audit row, but this pass result does not surface it —
   * exactly the gap N2 exists to close, and the one this fix wave left
   * open.
   */
  curated: string[];
  /**
   * Jobs closed this pass whose curation did not run, and why —
   * `curateJob`'s `skipped` reason, surfaced rather than discarded (spec
   * §4.2). `not_qualified` and `no_brief` are routine. `no_key` and
   * `over_cap` are the ones an operator needs to see: without this list, an
   * installation with curation switched off (no key) or budgeted out for
   * today is indistinguishable from one where every job simply had nothing
   * worth remembering.
   */
  curationSkipped: Array<{ jobId: string; reason: string }>;
}

interface DueJobRow {
  job_id: string;
  phase: string;
}

/**
 * Close every job whose plan is finished, and stop the ones whose record says
 * it might not be.
 *
 * **Scans `remember` as well as `verify`, and that is not tidiness.**
 * `transition` opens its own transaction and accepts no external one, so
 * `verify → remember → closed` is two commits with a gap between them. A
 * crash in that gap leaves the job in `remember` — the very same orphaned
 * phase this function exists to drain, one step further along. Picking
 * `remember` up on the next pass costs one clause in the query and removes
 * the window entirely.
 *
 * **Why through `remember` at all**, rather than adding `verify → closed` to
 * `LEGAL_TRANSITIONS`: that table is the state machine's contract, and
 * widening it to save one write would erase the difference between a job that
 * passed the curator and one that never did. `curateJob` now runs in that
 * phase, right before the job is closed — see `closeJob`'s own docblock for
 * what it does and does not guarantee.
 *
 * Per-job isolation, the session-scoped advisory lock, the re-read under that
 * lock, and destroying the connection on a failed unlock are all the same as
 * `runDueJobs`, and that function's docblock argues each one.
 *
 * `options.curator` exists so a test can inject a stub and observe that the
 * call actually happened, the same reason `runPlan` takes `bindings` as a
 * parameter instead of calling `loadBindings` itself: without a seam here, a
 * test asserting `curated` could pass with the `curateJob` call deleted,
 * because nothing would force the real, billed path to run. Production
 * callers pass nothing and get `curateWithModel`, `curateJob`'s own default.
 */
export async function closeVerifiedJobs(
  options: { businessId?: string; limit?: number; curator?: Curator } = {},
): Promise<CloseVerifiedResult> {
  const businessId = options.businessId ?? config.businessId;
  const limit = options.limit ?? 20;

  const { rows } = await getPool().query<DueJobRow>(
    `SELECT job_id, phase FROM jobs
      WHERE business_id = $1
        AND phase IN ('verify', 'remember')
        AND closed_at IS NULL
      ORDER BY updated_at ASC
      LIMIT $2`,
    [businessId, limit],
  );

  const result: CloseVerifiedResult = {
    closed: [],
    failed: [],
    unbound: [],
    lockedOut: [],
    phaseMoved: [],
    errored: [],
    curated: [],
    curationSkipped: [],
  };

  for (const row of rows) {
    const jobId = row.job_id;
    const lockScope = `verify:${businessId}:${jobId}`;
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

        const job = await loadJob(jobId, { businessId });
        if (job === null || (job.phase !== 'verify' && job.phase !== 'remember')) {
          result.phaseMoved.push(jobId);
          continue;
        }

        // Found here on a pass that picks up after a crash between the two
        // commits below: `transition(..., 'remember')` lands before
        // `curateJob` is even called, so a job already sitting in
        // `remember` may have had curation run to completion, or may have
        // been stranded mid-attempt (or before any attempt) by the very
        // crash that left it here. Either way this pass does not retry
        // curation for it — only the last hop, closing, is left. The
        // docblock above says why this phase is scanned at all.
        if (job.phase === 'remember') {
          await closeJob(jobId, businessId);
          result.closed.push(jobId);
          continue;
        }

        const stored = await loadPlanBody(jobId, { businessId });
        if (stored === null) {
          result.unbound.push(jobId);
          continue;
        }

        const recorded = await stepResults(jobId, stored.planHash, { businessId });
        const byStep = new Map(recorded.map((step) => [step.stepId, step]));

        const unknown = stored.plan.steps
          .filter((step) => byStep.get(step.id)?.status === 'unknown')
          .map((step) => step.id);
        if (unknown.length > 0) {
          const detail =
            `outcome unknown for ${unknown.join(', ')} — the call went out and no ` +
            'authoritative answer came back; nothing confirms it happened';
          await failJob(jobId, businessId, detail);
          result.failed.push({ jobId, detail });
          continue;
        }

        const unrecorded = stored.plan.steps
          .filter((step) => !byStep.has(step.id))
          .map((step) => step.id);
        if (unrecorded.length > 0) {
          const detail =
            `no result recorded for ${unrecorded.join(', ')} — a step with no row is ` +
            'not a step that went well';
          await failJob(jobId, businessId, detail);
          result.failed.push({ jobId, detail });
          continue;
        }

        await transition(jobId, {
          to: 'remember',
          actor: 'orchestrator',
          reason: 'all steps completed — no acceptance criteria were evaluated',
          businessId,
        });

        // The curator runs in the `remember` hop it was always meant for.
        // It cannot fail the job: `curateJob` swallows its own errors and
        // reports them, because a job that did its work must not be
        // stranded by a model that did not answer.
        const curation = await curateJob(jobId, {
          businessId,
          ...(options.curator ? { curator: options.curator } : {}),
        });
        if (curation.ran) {
          result.curated.push(jobId);
        } else if (curation.skipped !== null) {
          result.curationSkipped.push({ jobId, reason: curation.skipped });
        }

        await closeJob(jobId, businessId);
        result.closed.push(jobId);
      } catch (error) {
        // This job's failure must not take the rest of the pass down with it.
        // Nothing was decided, so this is `errored` and never a disposition
        // invented to fill the gap.
        result.errored.push({
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (holdsLock) {
        // The unlock attempt and the release are kept apart so `release` is
        // called exactly once on every path, and a failed unlock destroys the
        // connection rather than returning a session to the pool that still
        // holds this job's lock. `runDueJobs` argues both at length.
        let unlockError: unknown;
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockScope]);
        } catch (error) {
          unlockError = error;
        }
        if (unlockError === undefined) {
          client.release();
        } else {
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

/**
 * The last hop, and its reason has to stay true as the system grows.
 *
 * It used to read "nothing to remember — the memory layers are not built",
 * which was honest until 12/09 and then was not: the memory store exists, and
 * a job that ran a `memory.write_*` step has already written what it learned.
 * The live run of that day closed two jobs with a line saying the opposite of
 * what they had just done. It then read "no curator — a job remembers only
 * what its own steps recorded", which was honest until this hop started
 * calling `curateJob` and then was not.
 *
 * The curator now runs immediately before this function is called, in the
 * `remember` hop. A job still closes here whether or not curation actually
 * ran: the feature is switched off entirely with no API key or over its
 * daily cap, and `curateJob` never fails a job for a model that did not
 * answer. This function only ever records that the job reached `closed`,
 * not that anything in particular was remembered along the way.
 */
async function closeJob(jobId: string, businessId: string): Promise<void> {
  await transition(jobId, {
    to: 'closed',
    actor: 'orchestrator',
    reason: 'closed after the curator pass',
    businessId,
  });
}

async function failJob(jobId: string, businessId: string, reason: string): Promise<void> {
  await transition(jobId, { to: 'failed', actor: 'orchestrator', reason, businessId });
}
