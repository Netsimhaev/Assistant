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
  | 'wrong_tool'
  | 'not_approved'
  | 'input_changed'
  | 'already_consumed'
  | 'expired';

export type ConsumeOutcome = { ok: true } | { ok: false; code: ConsumeCode };

export interface ConsumeInput {
  approvalId: string;
  jobId: string;
  /** The step spending it. Recorded so the chain can be read back. */
  stepId: string;
  /**
   * The tool about to run. Required, not optional.
   *
   * `proposed_tool` was already stored on every approval and matched against
   * nothing. Binding the claim to it costs one predicate and removes a class
   * of confusion: an approval granted for `mail.send` cannot be spent by a
   * step calling `whatsapp.send`, however identical their inputs hash. A
   * caller with a tool name it did not check is a caller that should not be
   * spending an approval at all, so there is nothing sensible to default to.
   */
  toolName: string;
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
 *
 * Expiry IS re-checked here, and the `expires_at > now()` predicate is the
 * authority rather than any read that preceded it. `expireOverdue` only ever
 * touches rows still in `pending`, so a DECIDED approval keeps its state for
 * as long as the row exists: without this predicate an approval granted for a
 * job that then halted stayed spendable forever, and a re-plan months later
 * producing the same input hash would spend it silently. `unspentApprovalFor`
 * filters expired rows too — that keeps a dead approval from ever being
 * offered — but a lookup's answer can go stale in the milliseconds before the
 * claim, and only the claim's own WHERE clause can be relied on. Two checks,
 * two layers, exactly as `decide` re-checks its own predicate in SQL after
 * reading the row in JavaScript.
 *
 * An expired approval is refused, never failed: `expired` joins every other
 * code in falling through to the normal path, which queues a FRESH request.
 * The action is still wanted; what ran out was the fuse on the question.
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
        AND proposed_tool = $6
        AND expires_at > now()
      RETURNING approval_id`,
    [
      input.approvalId,
      businessId,
      input.jobId,
      input.stepId,
      input.liveInputHash,
      input.toolName,
    ],
  );

  if (claimed.rows[0]) return { ok: true };

  const { rows } = await db.query<{
    job_id: string | null;
    state: string;
    consumed_at: Date | null;
    input_hash_at_decision: string | null;
    proposed_tool: string;
    expires_at: Date;
  }>(
    `SELECT job_id, state, consumed_at, input_hash_at_decision, proposed_tool, expires_at
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
  if (row.proposed_tool !== input.toolName) return { ok: false, code: 'wrong_tool' };
  // Reported after `already_consumed` on purpose: a row that was spent and
  // then expired is a spent row, and that is the more useful sentence in the
  // audit trail.
  if (row.expires_at.getTime() <= Date.now()) return { ok: false, code: 'expired' };
  return { ok: false, code: 'input_changed' };
}
