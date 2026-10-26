/**
 * Shadow mode: how often the owner agreed with the proposed mail replies.
 *
 * Derived from `approval_requests` on every call, never accumulated. A
 * counter maintained beside its source can drift from it without anyone
 * noticing — the failure this codebase has already paid for twice — while a
 * derived number is right by construction, and right retroactively after a
 * bug is fixed. The counter columns migration 001 put on `autonomy_ramp`
 * stay empty on purpose (spec §4.1).
 *
 * WHAT COUNTS AS EVIDENCE is stated positively (spec §5.1, "אילו כרטיסים הם
 * ראיה"): a card counts only when its job is a mailbox reply job — a
 * `mail_messages` row of the same business names the job as `reply_job_id`.
 * "Every `email.reply` card" is the negation-shaped rule this project keeps
 * paying for: instruction-door and conductor cards share the action class but
 * are not the assistant proposing a reply to a mail, so they would silently
 * inflate or deflate the rate.
 *
 * Per job, only the FIRST decided card counts (by `created_at`): a job that
 * was asked twice measures the first answer, not the owner's patience.
 * Cards whose header carries `RETRY_PREFIX` / `EXPIRED_PREFIX` are skipped —
 * they re-ask about a send that did not complete, which says nothing about
 * the proposal.
 *
 * Known limitation: a re-raise relinks `reply_job_id` to the new job, so a
 * re-raised mail drops out of measurement entirely — the original card loses
 * its link and the re-raised card is skipped by its prefix. That undercounts,
 * which is the safe direction.
 */
import { getPool, type Queryable } from '../db/pool.js';
import type { ActionClass } from '../domain/action.js';
import { EXPIRED_PREFIX, RETRY_PREFIX, splitReplyDetail } from '../mail/reply-card.js';
import { agreementVerdict, type WrongReason } from './agreement-verdict.js';

export const AGREEMENT_WINDOW_DAYS = 14;
export const MIN_SAMPLES = 5;
/** Strictly greater: exactly 80% is not yet learned. */
export const LEARNED_THRESHOLD = 0.8;

export interface Agreement {
  right: number;
  counted: number;
  topWrongReason: WrongReason | null;
}

/**
 * Tie-break order for `topWrongReason`. A `Record` over the union, so a member
 * added to `WrongReason` without a place here is a compile error; the order is
 * the key order.
 */
const REASON_ORDER_KEYS: Record<WrongReason, true> = {
  recipient: true,
  number: true,
  date: true,
  too_many_words: true,
  denied: true,
};
const REASON_ORDER = Object.keys(REASON_ORDER_KEYS) as WrongReason[];

/**
 * The three states that carry a verdict, named positively. `expired` and
 * `cancelled` say nobody answered or the request was withdrawn — neither is
 * the assistant being right or wrong, so they are excluded in the query.
 */
const DECIDED_STATES = ['approved', 'approved_with_edit', 'denied'] as const;

interface CardRow {
  state: string;
  detail: string;
  proposed_input: unknown;
  edited_input: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function agreementFor(
  actionClass: ActionClass,
  options: { businessId: string; since: Date | null; now?: Date; db?: Queryable },
): Promise<Agreement> {
  const db = options.db ?? getPool();
  const now = options.now ?? new Date();
  const { rows } = await db.query<CardRow>(
    `SELECT state, detail, proposed_input, edited_input
       FROM (
         SELECT DISTINCT ON (a.job_id)
                a.state, a.detail, a.proposed_input, a.edited_input, a.decided_at
           FROM approval_requests a
           JOIN mail_messages m
             ON m.business_id = a.business_id AND m.reply_job_id = a.job_id
          WHERE a.business_id = $1 AND a.action_class = $2
            AND a.state = ANY($3::text[])
          ORDER BY a.job_id, a.created_at, a.approval_id
       ) first_card
      WHERE decided_at > GREATEST(
              $4::timestamptz - make_interval(days => $5),
              COALESCE($6::timestamptz, '-infinity'::timestamptz))`,
    [
      options.businessId,
      actionClass,
      [...DECIDED_STATES],
      now.toISOString(),
      AGREEMENT_WINDOW_DAYS,
      options.since === null ? null : options.since.toISOString(),
    ],
  );

  let right = 0;
  let counted = 0;
  const reasons = new Map<WrongReason, number>();
  for (const row of rows) {
    const header = splitReplyDetail(row.detail).header;
    if (header.includes(RETRY_PREFIX) || header.includes(EXPIRED_PREFIX)) continue;

    const { verdict, reason } = agreementVerdict({
      state: row.state,
      proposed: asRecord(row.proposed_input),
      edited: row.edited_input === null ? null : asRecord(row.edited_input),
    });
    if (verdict === 'not_counted') continue;
    counted += 1;
    if (verdict === 'right') {
      right += 1;
    } else if (reason !== null) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }

  let topWrongReason: WrongReason | null = null;
  let topCount = 0;
  for (const reason of REASON_ORDER) {
    const n = reasons.get(reason) ?? 0;
    if (n > topCount) {
      topCount = n;
      topWrongReason = reason;
    }
  }
  return { right, counted, topWrongReason };
}

export function isLearned(a: Agreement): boolean {
  return a.counted >= MIN_SAMPLES && a.right / a.counted > LEARNED_THRESHOLD;
}
