import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import type { ActionFacts } from '../domain/policy.js';
import type { GateContext } from './engine.js';
import { readEmails } from './facts.js';

/**
 * Whether the call in front of stage 8 is a reply to an incoming mail that the
 * assistant has LEARNED to send on her own — the one place in the shadow-mode
 * feature where authority widens (owner ruling H10, spec §5.6).
 *
 * Inbound-mail jobs are `unknown_external`, and the signed charter caps that
 * provenance at `draft_only`. Without this, a class the owner let her learn —
 * dial at `learn`, `email.reply` promoted to `auto_notify` — still could not
 * answer a single mail: the provenance ceiling refused it at stage 8 however
 * many clean approvals had earned the promotion. When this holds, stage 8
 * drops the provenance ceiling and ONLY it (`skipProvenanceOnly`).
 *
 * Built in the pattern of `approvedReplyCovers` (`approved-reply.ts`). Every
 * condition is positive; each one is required:
 *
 *   - `ctx.approval` is ABSENT. An approved reply is `approvedReplyCovers`'s
 *     case, not this one. It also means there is no claim for this exemption
 *     to lose: unlike the approved-reply path, there is no `consumeApproval`
 *     between this read and the allow, so the lost-claim recompute in
 *     stage 10 has nothing to guard here and is deliberately not applied;
 *   - `ctx.jobId` is a string, and the job is a MAILBOX REPLY JOB: a
 *     `mail_messages` row in this business names it as its `reply_job_id`
 *     (the same positive marker `approvedReplyCovers` reads, ruling R20).
 *     This keeps the exemption off every other `unknown_external` chain —
 *     a document from the intake folder, a conductor card;
 *   - the refined action class is exactly `email.reply`. `email.initiate` —
 *     a `mail.send` without a real `inReplyTo` — is a cold message, and the
 *     charter caps it for a reason this does not get to overrule;
 *   - `ctx.rampLevel` is exactly `auto_notify`. That value is the CLAMPED
 *     ramp (`loadRampLevel` via `rampLevelForPlan`), so it is reachable only
 *     with the dial at `learn` and the class promoted; under `off` the clamp
 *     yields `draft_only` and under `ask` `approve_required`, and the
 *     exemption does not exist;
 *   - the recipients (`readEmails`) are exactly ONE address, equal
 *     (case-insensitively) to that mail row's stored `from_address`. Never the
 *     Reply-To, never a second recipient — the rule the mailbox send adapter
 *     enforces too (`reply_recipient_mismatch`);
 *   - `facts.amountDeclared` is false — no money rides on a learned reply;
 *   - the payload has no own `attachments` key — a learned reply is text;
 *   - the job has NO `job_step_results` row with status `unknown`, on any
 *     step. Such a row means a send was dispatched and no authoritative answer
 *     came back (`adapter_timeout`): the mail may already be in the
 *     sender's inbox. On an approved reply the spent approval stops the
 *     re-run; this exemption needs no approval, so without this condition the
 *     woken job passed stage 8 again and sent a SECOND time, card-less — and
 *     the Gmail/Graph sends carry no idempotency key to deduplicate it. With
 *     it, the re-run is refused at stage 8, the job fails, and
 *     `reraiseAfterFailedSend` asks the owner, warning that it may have sent.
 *
 * It is a read and only a read.
 *
 * What it does not bypass, named positively: the kill switch (stage 1),
 * charter `forbidden` rules (5), do-not-contact (6) and quiet hours (7) all
 * run before stage 8 and are untouched. Inside stage 8 the signed
 * `autonomyBase` for the class, every counterparty override, an envelope's
 * `autonomyCeiling` and the ramp itself still apply. Budget (9) and the risk
 * band (10) still run after it — so a reply to a sender the charter does not
 * know is `sensitive` (first contact) and still asks for approval.
 */
/** Appended to the `intent_to_act` audit reason when the exemption carried the call. */
export const LEARNED_REPLY_EXEMPTION_MARKER = 'learned_reply_exemption';

export async function learnedReplyCovers(
  facts: ActionFacts,
  toolInput: Record<string, unknown>,
  ctx: GateContext,
): Promise<boolean> {
  if (ctx.approval !== undefined) return false;
  if (typeof ctx.jobId !== 'string') return false;
  if (facts.actionClass !== 'email.reply') return false;
  if (ctx.rampLevel !== 'auto_notify') return false;
  if (facts.amountDeclared !== false) return false;
  if (Object.hasOwn(toolInput, 'attachments')) return false;

  const recipients = readEmails(toolInput);
  if (recipients.length !== 1) return false;
  const recipient = recipients[0];
  if (recipient === undefined) return false;

  const businessId = ctx.businessId ?? config.businessId;
  const db = ctx.db ?? getPool();
  const { rows } = await db.query<{ mail_id: string }>(
    `SELECT mail_id
       FROM mail_messages
      WHERE business_id = $1
        AND reply_job_id = $2
        AND lower(from_address) = $3
        AND NOT EXISTS (
          SELECT 1 FROM job_step_results r
           WHERE r.business_id = $1 AND r.job_id = $2 AND r.status = 'unknown'
        )`,
    [businessId, ctx.jobId, recipient],
  );
  return rows[0] !== undefined;
}
