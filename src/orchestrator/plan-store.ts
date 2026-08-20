import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import type { Plan } from '../domain/plan.js';
import { canonicalHash } from '../util/canonical.js';

/**
 * The plan a job is executing, and which of its steps are already done.
 *
 * This is the state that makes a deferred job resumable. Without it the
 * scheduler woke a job, handed it back to `runPlan`, and the run started at
 * step one — re-sending a mail that had already gone out.
 */

/** One finished step, as it is written down. */
export interface StepCompletion {
  stepId: string;
  /** The plan this completion belongs to. Never omitted — see the table comment. */
  planHash: string;
  /** The provider's handle on what the step created, or null when it created nothing. */
  externalId: string | null;
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
  | { status: 'conflict'; storedHash: string; offeredHash: string };

/**
 * Tie a job to the one plan it will execute.
 *
 * First plan wins and is stored. A later run offering the same plan `matched`
 * and carries on. A later run offering a *different* plan is a `conflict` and
 * the caller must refuse it: re-planning after part of a plan has already run
 * means the world moved underneath steps that already happened, and there is
 * no automatic merge of the two that is correct — the old plan's completed
 * steps cannot be mapped onto a new plan's steps, not even the ones that share
 * an id.
 *
 * `ON CONFLICT DO NOTHING` then re-read, rather than read then insert: two
 * runners starting the same job at once must not both believe they stored it.
 */
export async function bindPlanToJob(
  jobId: string,
  plan: Plan,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<PlanBinding> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const offeredHash = planHashOf(plan);

  const inserted = await db.query<PlanRow>(
    `INSERT INTO job_plans (business_id, job_id, plan_hash, plan)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, job_id) DO NOTHING
     RETURNING *`,
    [businessId, jobId, offeredHash, JSON.stringify(plan)],
  );
  if (inserted.rows[0]) return { status: 'stored', planHash: offeredHash };

  const stored = await loadStoredPlan(jobId, { businessId, db });
  if (stored === null) {
    // The row existed a statement ago and does not now — only a concurrent
    // delete of the job explains it. Louder than pretending we stored one.
    throw new Error(`job ${jobId} lost its stored plan mid-bind`);
  }

  return stored.planHash === offeredHash
    ? { status: 'matched', planHash: offeredHash }
    : { status: 'conflict', storedHash: stored.planHash, offeredHash };
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
 */
export async function completedSteps(
  jobId: string,
  planHash: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<Map<string, string | null>> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<StepResultRow>(
    `SELECT step_id, external_id FROM job_step_results
      WHERE business_id = $1 AND job_id = $2 AND plan_hash = $3`,
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
 * `ON CONFLICT DO NOTHING` so that a step recorded twice is not an error. The
 * first record is the one that counts.
 */
export async function recordStepCompletion(
  tx: Queryable,
  input: StepCompletion & { jobId: string; businessId: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, external_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id, job_id, plan_hash, step_id) DO NOTHING`,
    [input.businessId, input.jobId, input.planHash, input.stepId, input.externalId],
  );
}
