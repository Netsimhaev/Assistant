import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import type { ActionFacts } from '../domain/policy.js';
import type { GateContext } from './engine.js';

/**
 * Whether the call in front of stage 8 is a reply the owner has ALREADY
 * approved, byte for byte — the one case in which the gate lets an action
 * past the ramp and provenance ceilings.
 *
 * The owner's decision (mailbox spec §5.2 items 5–6): "once I approve a send,
 * she sends, whatever the freedom-level dial says". Without this, an install
 * at `off` — every new install — raised a reply card, the owner approved it,
 * and the step then died at stage 8 on `draft_only`, because the dial clamps
 * the ramp to `draft_only` and the mail job's provenance is
 * `unknown_external`, whose ceiling is `draft_only` too. The approval was
 * asked for and could never be honoured.
 *
 * Why this is safe — every condition is positive, and each one is a predicate
 * the stage-10 claim (`consumeApproval`) ALSO enforces, so this can never
 * widen a call that the claim would then refuse to spend:
 *
 *   - `ctx.approval` is present and `ctx.jobId` is a string — an approval
 *     belongs to a job, and the executor supplies both;
 *   - the action class is exactly `email.reply`. Not `email.initiate`: a
 *     `mail.send` without a real `inReplyTo` is a cold message to someone,
 *     and the charter caps that class for a reason this exemption does not
 *     get to overrule;
 *   - the row is in this business, decided `approved`/`approved_with_edit`,
 *     unspent, unexpired, on THIS job, for THIS tool, and its
 *     `input_hash_at_decision` equals the hash of the bytes about to run —
 *     the same `facts.inputHash` stage 10 hands `consumeApproval`, so the
 *     two can never disagree about what "the approved bytes" are.
 *
 * It is a read and only a read. The approval is still spent in stage 10 by
 * the single guarded UPDATE, and if that claim loses a race the gate does
 * NOT continue on the relaxed ceiling (see the fallback in `engine.ts`).
 *
 * What it does not bypass: the kill switch, charter `forbidden` rules,
 * do-not-contact and quiet hours all run before stage 8 and are untouched;
 * inside stage 8 only the ramp and the provenance ceiling are dropped —
 * the signed `autonomyBase` for the class, every counterparty override and
 * an envelope's `autonomyCeiling` still apply; budget and the `blocked` risk
 * band still run after it.
 */
export async function approvedReplyCovers(
  facts: ActionFacts,
  toolName: string,
  liveInputHash: string,
  ctx: GateContext,
): Promise<boolean> {
  if (ctx.approval === undefined) return false;
  if (typeof ctx.jobId !== 'string') return false;
  if (facts.actionClass !== 'email.reply') return false;

  const businessId = ctx.businessId ?? config.businessId;
  const db = ctx.db ?? getPool();
  const { rows } = await db.query<{ approval_id: string }>(
    `SELECT approval_id
       FROM approval_requests
      WHERE approval_id = $1
        AND business_id = $2
        AND job_id = $3
        AND state IN ('approved', 'approved_with_edit')
        AND consumed_at IS NULL
        AND expires_at > now()
        AND proposed_tool = $4
        AND input_hash_at_decision = $5`,
    [ctx.approval.approvalId, businessId, ctx.jobId, toolName, liveInputHash],
  );
  return rows[0] !== undefined;
}
