import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';

/**
 * Why an approval could not be spent. Diagnostic only — every one of these is
 * the same outcome for the caller, which is that the normal path runs and a
 * fresh request is queued.
 */
export type ConsumeCode =
  | 'unknown_approval'
  | 'wrong_job'
  | 'not_approved'
  | 'input_changed'
  | 'already_consumed';

export type ConsumeOutcome = { ok: true } | { ok: false; code: ConsumeCode };

export interface ConsumeInput {
  approvalId: string;
  jobId: string;
  /** The step spending it. Recorded so the chain can be read back. */
  stepId: string;
  /** Hash of the input that is about to run, not of what was proposed. */
  liveInputHash: string;
  businessId?: string;
  db?: Queryable;
}

/**
 * Spend an approval a human already granted.
 *
 * The claim is ONE conditional UPDATE, and that is the entire race defence:
 * `consumed_at IS NULL` in the predicate means two runners racing on the same
 * approval produce exactly one winner, whatever the interleaving. A read
 * followed by a write would let both read null and both proceed, which for a
 * purchase means two real orders.
 *
 * The failure reason is derived by a SECOND query, deliberately outside that
 * atomicity. It is only ever used to explain the refusal in the audit trail —
 * the decision itself was already made by the UPDATE claiming nothing.
 *
 * Note what this does NOT re-check: the budget. Ceilings are step 9 of the
 * gate and have already run by the time step 10 reaches an approval, so a
 * spent approval cannot carry an action past a ceiling.
 */
export async function consumeApproval(input: ConsumeInput): Promise<ConsumeOutcome> {
  const businessId = input.businessId ?? config.businessId;
  const db = input.db ?? getPool();

  const claimed = await db.query<{ approval_id: string }>(
    `UPDATE approval_requests
        SET consumed_at = now(), consumed_by_step = $4
      WHERE approval_id = $1
        AND business_id = $2
        AND job_id = $3
        AND state IN ('approved', 'approved_with_edit')
        AND consumed_at IS NULL
        AND input_hash_at_decision = $5
      RETURNING approval_id`,
    [input.approvalId, businessId, input.jobId, input.stepId, input.liveInputHash],
  );

  if (claimed.rows[0]) return { ok: true };

  const { rows } = await db.query<{
    job_id: string | null;
    state: string;
    consumed_at: Date | null;
    input_hash_at_decision: string | null;
  }>(
    `SELECT job_id, state, consumed_at, input_hash_at_decision
       FROM approval_requests WHERE approval_id = $1 AND business_id = $2`,
    [input.approvalId, businessId],
  );

  const row = rows[0];
  if (!row) return { ok: false, code: 'unknown_approval' };
  if (row.job_id !== input.jobId) return { ok: false, code: 'wrong_job' };
  if (row.state !== 'approved' && row.state !== 'approved_with_edit') {
    return { ok: false, code: 'not_approved' };
  }
  if (row.consumed_at !== null) return { ok: false, code: 'already_consumed' };
  return { ok: false, code: 'input_changed' };
}
