import type pg from 'pg';
import { config } from '../config.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import type { Plan } from '../domain/plan.js';
import { canonicalHash } from '../util/canonical.js';

/**
 * The plan a job is executing, and which of its steps are already done.
 *
 * This is the state that makes a deferred job resumable. Without it the
 * scheduler woke a job, handed it back to `runPlan`, and the run started at
 * step one — re-sending a mail that had already gone out.
 */

/**
 * What is known about a step after the run that attempted it.
 *
 * `completed` — it finished, and `externalId` is the provider's handle on what
 * it created.
 *
 * `unknown` — the call was dispatched and nothing authoritative came back.
 * Only `adapter_timeout` produces this: an adapter's own `retryable: true` is
 * a claim that nothing was created, and adapters honour it, but a deadline the
 * orchestrator enforced from outside carries no such claim.
 */
export type StepResultStatus = 'completed' | 'unknown';

/** One attempted step, as it is written down. */
export interface StepCompletion {
  stepId: string;
  /** The plan this completion belongs to. Never omitted — see the table comment. */
  planHash: string;
  /** The provider's handle on what the step created, or null when it created nothing. */
  externalId: string | null;
  status: StepResultStatus;
}

interface PlanRow {
  business_id: string;
  job_id: string;
  plan_hash: string;
}

interface StepResultRow {
  step_id: string;
  external_id: string | null;
}

interface StoredPlan {
  jobId: string;
  planHash: string;
}

function toStoredPlan(row: PlanRow): StoredPlan {
  return { jobId: row.job_id, planHash: row.plan_hash };
}

/**
 * The identity of a plan, for the purpose of resumption.
 *
 * `canonicalHash` and not `JSON.stringify`: two runs must agree byte for byte
 * on what "the same plan" means, and stringify's key order follows insertion
 * order rather than the value.
 */
export function planHashOf(plan: Plan): string {
  return canonicalHash(plan);
}

export type PlanBinding =
  | { status: 'stored'; planHash: string }
  | { status: 'matched'; planHash: string }
  /** A previous binding was replaced because not one of its steps had run. */
  | { status: 'replaced'; previousHash: string; planHash: string }
  | { status: 'conflict'; storedHash: string; offeredHash: string };

/**
 * Tie a job to the one plan it will execute.
 *
 * First plan wins and is stored. A later run offering the same plan `matched`
 * and carries on.
 *
 * A later run offering a *different* plan is judged on one question, and it is
 * not "is this the same plan" but **"has any step of this job actually run
 * yet"**. Nothing has: the binding is `replaced` and the new plan proceeds. A
 * step-one failure is precisely when re-planning is both most useful and
 * completely safe, and refusing there forced a caller to reproduce the
 * original plan byte for byte to recover — a trap, and the common case.
 * Something has: `conflict`, and the caller must refuse. Completed steps
 * belong to the plan that produced them and cannot be carried onto a re-plan,
 * least of all by matching step ids, which two unrelated plans may well share.
 *
 * The existence test is "any result row for this job", not "any completion
 * under the stored hash". A row under some third hash means the job's history
 * is not what the `job_plans` row claims, and replacing on top of that is the
 * merge this function exists to refuse. It also counts `unknown` rows: a
 * missing row is what licenses a replacement, so a dispatched call whose
 * outcome nobody knows has to leave one behind or "nothing ran" is a guess.
 *
 * All of it inside one transaction with the stored row locked `FOR UPDATE`:
 * read-then-replace across two statements lets two runners both find zero
 * completions and both install their own plan. `ON CONFLICT DO NOTHING` then
 * re-read, rather than read then insert, for the same reason one level up.
 */
export async function bindPlanToJob(
  jobId: string,
  plan: Plan,
  options: { businessId?: string } = {},
): Promise<PlanBinding> {
  const businessId = options.businessId ?? config.businessId;
  const offeredHash = planHashOf(plan);

  return withTransaction(async (tx) => {
    const inserted = await tx.query<PlanRow>(
      `INSERT INTO job_plans (business_id, job_id, plan_hash, plan)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, job_id) DO NOTHING
       RETURNING *`,
      [businessId, jobId, offeredHash, JSON.stringify(plan)],
    );
    if (inserted.rows[0]) return { status: 'stored', planHash: offeredHash };

    const { rows } = await tx.query<PlanRow>(
      `SELECT business_id, job_id, plan_hash FROM job_plans
        WHERE business_id = $1 AND job_id = $2
        FOR UPDATE`,
      [businessId, jobId],
    );
    const stored = rows[0];
    if (!stored) {
      // The row existed a statement ago and does not now — only a concurrent
      // delete of the job explains it. Louder than pretending we stored one.
      throw new Error(`job ${jobId} lost its stored plan mid-bind`);
    }
    if (stored.plan_hash === offeredHash) return { status: 'matched', planHash: offeredHash };

    // Deliberately unfiltered by status, unlike `completedSteps`. A row that
    // says `unknown` means a call was dispatched and nobody knows whether it
    // landed — the outcome a different plan must never be layered on top of,
    // because a re-plan changes the step id or the input and therefore the
    // idempotency key, so the far end's own deduplication cannot fire and the
    // order is placed a second time for real.
    const executed = await tx.query<{ step_id: string }>(
      'SELECT step_id FROM job_step_results WHERE business_id = $1 AND job_id = $2 LIMIT 1',
      [businessId, jobId],
    );
    if (executed.rows[0]) {
      return { status: 'conflict', storedHash: stored.plan_hash, offeredHash };
    }

    await tx.query(
      `UPDATE job_plans SET plan_hash = $3, plan = $4, stored_at = now()
        WHERE business_id = $1 AND job_id = $2`,
      [businessId, jobId, offeredHash, JSON.stringify(plan)],
    );
    return { status: 'replaced', previousHash: stored.plan_hash, planHash: offeredHash };
  });
}

/** The plan hash a job is bound to, or null when it is not bound yet. */
export async function loadStoredPlan(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<StoredPlan | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<PlanRow>(
    'SELECT business_id, job_id, plan_hash FROM job_plans WHERE business_id = $1 AND job_id = $2',
    [options.businessId ?? config.businessId, jobId],
  );
  const row = rows[0];
  return row ? toStoredPlan(row) : null;
}

/**
 * The steps of this job and this plan that are already done, by step id.
 *
 * Scoped by BOTH the job and the plan hash, and neither is redundant. The job
 * keeps two jobs that happen to name their steps `s1` from skipping each
 * other's work; the plan hash keeps a completion produced under one plan from
 * satisfying a step of another that shares an id.
 *
 * **Takes `completed` only, while `bindPlanToJob` counts both statuses. The
 * asymmetry is the point, and unifying them reintroduces a real defect in one
 * direction or the other.** An `unknown` step must be re-run by a resume of
 * the SAME plan: the step id and input are unchanged, so `performStep` derives
 * the identical idempotency key and the far end can deduplicate — that is the
 * entire design of the timeout path. Skipping it instead would abandon a step
 * that may never have happened. The other reader asks a different question —
 * may a DIFFERENT plan be layered on top of this job — and there an `unknown`
 * row is disqualifying, because a re-plan changes the key's inputs by
 * definition and no deduplication can fire.
 */
export async function completedSteps(
  jobId: string,
  planHash: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<Map<string, string | null>> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<StepResultRow>(
    `SELECT step_id, external_id FROM job_step_results
      WHERE business_id = $1 AND job_id = $2 AND plan_hash = $3
        AND status = 'completed'`,
    [options.businessId ?? config.businessId, jobId, planHash],
  );
  return new Map(rows.map((row) => [row.step_id, row.external_id]));
}

/**
 * Write down that a step finished.
 *
 * **Takes a transaction, and the caller must be the one that also moves the
 * job's phase.** `transition` passes its own `tx` here so the completion and
 * the phase change land together: two separate writes leave a window in which
 * the job has advanced and the step it advanced past is unrecorded, and a
 * resume would then run that step a second time.
 *
 * The parameter is `pg.PoolClient` and not `Queryable` deliberately. A `Pool`
 * satisfies `Queryable` structurally, so the narrower type is the only thing
 * that stops `recordStepCompletion(getPool(), …)` from compiling — which is
 * exactly the separate write this docblock forbids, and exactly the defect
 * `upsertBinding` hit earlier on this branch. The read functions above keep
 * `Queryable`: they hold no lock and have no atomicity to lose.
 *
 * **Resumption is at-least-once, not exactly-once, and no transaction can make
 * it otherwise.** The external call happens before this row can possibly be
 * written. If the process dies in between — after the mail server accepted the
 * message and before this insert commits — the step has happened and nothing
 * records it, so the resumed run does it again. That is a physical limit of
 * acting on a system that does not share our database, not a defect to be
 * fixed here. The only defence is `AdapterCall.idempotencyKey`, which is
 * handed to every adapter and which the far end may or may not honour. Do not
 * read this function as closing that gap; it closes the much wider one where
 * the completion was never written at all.
 *
 * One consequence worth naming because it is money. `recordSpend`'s
 * idempotency key is `hash(jobId, stepId, input)`, identical across every
 * re-run of the same step — right for an ambiguous timeout, where the question
 * is whether one action happened once or not at all. In the crash window above
 * the step genuinely happens twice, and the ledger still charges it once. The
 * daily and monthly ceilings therefore under-count real exposure in exactly
 * that window, and those ceilings are the only thing bounding it.
 *
 * The upsert **promotes and never demotes**. A step that timed out leaves an
 * `unknown` row; the same-plan resume re-runs it and, on success, must turn
 * that row into a `completed` one — `DO NOTHING` would leave it `unknown`
 * forever and the step would re-run on every resume after that. The reverse
 * is refused by the `WHERE`: a `completed` row is never overwritten, so a
 * later timeout on an already-finished step cannot un-know it.
 */
export async function recordStepCompletion(
  tx: pg.PoolClient,
  input: StepCompletion & { jobId: string; businessId: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, external_id, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (business_id, job_id, plan_hash, step_id) DO UPDATE
        SET status = 'completed',
            external_id = EXCLUDED.external_id,
            completed_at = now()
      WHERE job_step_results.status = 'unknown' AND EXCLUDED.status = 'completed'`,
    [
      input.businessId,
      input.jobId,
      input.planHash,
      input.stepId,
      input.externalId,
      input.status,
    ],
  );
}
