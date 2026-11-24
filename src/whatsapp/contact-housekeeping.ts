/**
 * Scheduler housekeeping for contact cards: the 5-hour reminder to the owner,
 * closing the conversation once its card is decided without a send, marking it
 * answered once the send completed, and the decision log the learning reads.
 *
 * **Every transition acts only on the conversation whose `card_job_id` is the
 * job in question** (ruling R12a): all queries start from the conversation's
 * CURRENT card job, so a replaced card's old (cancelled) approval can never
 * close the conversation now carded on the newer job.
 *
 * **A conversation never leaves `carded` while its card job is approved and
 * not yet finished** (ruling R12b): `approvedReplyCovers` needs `carded` until
 * the send completes. `answered` is set only when the job is `closed` with a
 * performed step; `closed`/`expired` only when the card's latest approval is
 * denied/cancelled/expired and nothing live remains on the job.
 *
 * **An approved card whose send then failed is never silent** (I2). The owner
 * was told "אישרתי. התשובה יוצאת ל-…"; when the card job ends `failed` with
 * its latest approval approved (consumed or not — a gate or kill-switch
 * denial fails the job before consumption) and no performed step, the
 * conversation is closed and the owner gets ONE WhatsApp note that the reply
 * did not go out — "ייתכן שההודעה כבר יצאה" when any step row is `unknown` or
 * a failure code is in `MAY_HAVE_SENT_CODES`. A failed job never runs again
 * (card jobs are not re-asked), so `failed` is terminal here. The conditional
 * close (`state = 'carded' AND card_job_id = $job`) IS the claim: only the
 * pass whose UPDATE flipped the row sends the note, so two passes never send
 * it twice. Claim before send means a crash between the two loses the note —
 * at most once, never twice, as every claim-then-send here.
 *
 * Job phase changes are `resume.ts`'s business; nothing here transitions a job.
 */
import { ulid } from 'ulid';
import type { BusinessDb } from '../db/pool.js';
import { agreementVerdict } from '../governance/agreement-verdict.js';
import { MAY_HAVE_SENT_CODES } from '../domain/may-have-sent.js';
import { toOneLine } from '../util/bidi.js';
import { presentContactCard } from './contact-card.js';
import { INTERNAL_DOCS_SOURCE } from './contact-flow.js';
import type { BossMessenger } from './messenger.js';

export const CARD_REMINDER_AFTER_MS = 5 * 60 * 60 * 1000;
export const CARD_REMINDER_LEAD = 'תזכורת: עדיין ממתין לאישורך';
export const FAILED_SEND_NOTE_PREFIX = 'התשובה שאישרת בוואטסאפ ל-';
export const FAILED_SEND_NOT_SENT = 'לא יצאה. אפשר לשלוח אותה שוב בעצמך, או לחכות לפנייה הבאה שלו.';
export const FAILED_SEND_MAY_HAVE_SENT = 'לא הושלמה — ייתכן שההודעה כבר יצאה. כדאי לבדוק בטלפון לפני ששולחים שוב.';

/** The one note an owner gets when an approved contact-card reply failed. */
export function failedSendNote(contactKey: string, mayHaveSent: boolean): string {
  return `${FAILED_SEND_NOTE_PREFIX}+${toOneLine(contactKey)} ${mayHaveSent ? FAILED_SEND_MAY_HAVE_SENT : FAILED_SEND_NOT_SENT}`;
}

const NOTHING_FOUND = 'לא נמצא מידע רלוונטי';
const FOUND_PREFIX = 'מה נמצא: ';

export interface HousekeepingDeps {
  messenger: BossMessenger;
  now: Date;
}

export interface HousekeepingResult {
  reminded: number;
  expired: number;
  answered: number;
  decisionsRecorded: number;
  /** Approved card replies that failed to send: conversation closed, owner noted. */
  failedNoticed: number;
}

interface CardRow {
  conversation_id: string;
  card_job_id: string;
}

/**
 * The tiers a decision's sources came from, read from what the card itself
 * recorded: its `מה נמצא:` line lists tier-2 source labels and, when the
 * quarantined researcher found something, `INTERNAL_DOCS_SOURCE` (tier 3).
 * Nothing structured about tiers is stored elsewhere, so the card's own text —
 * written by our code from our own labels, never the contact's — is the record.
 * An unknown sender has no tier-2 sources and no researcher: `[]`.
 */
export function sourceTiersFromDetail(detail: string, kind: string): string[] {
  if (kind === 'unknown') return [];
  const line = detail.split('\n').find((l) => l.startsWith(FOUND_PREFIX));
  if (line === undefined) return [];
  const parts = line.slice(FOUND_PREFIX.length).split('; ').map((p) => p.trim()).filter((p) => p !== '');
  const tiers: string[] = [];
  if (parts.some((p) => p !== NOTHING_FOUND && p !== INTERNAL_DOCS_SOURCE)) tiers.push('tier2');
  if (parts.includes(INTERNAL_DOCS_SOURCE)) tiers.push('tier3');
  return tiers;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function recordDecisions(db: BusinessDb): Promise<number> {
  const { rows } = await db.query<{
    approval_id: string;
    job_id: string;
    state: string;
    proposed_input: unknown;
    edited_input: unknown;
    detail: string;
    decided_at: Date;
    conversation_id: string;
    contact_kind: string;
    topic_id: string | null;
    summary: string | null;
    source_names: string[] | null;
    internal_document_ids: string[] | null;
  }>(
    `SELECT a.approval_id, a.job_id, a.state, a.proposed_input, a.edited_input, a.detail, a.decided_at,
            c.conversation_id, c.contact_kind,
            x.topic_id, x.summary, x.source_names, x.internal_document_ids
       FROM approval_requests a
       JOIN contact_conversations c ON c.business_id = a.business_id AND c.card_job_id = a.job_id
       LEFT JOIN contact_card_context x ON x.business_id = a.business_id AND x.job_id = a.job_id
      WHERE a.business_id = $1 AND a.proposed_tool = 'wa.send_message'
        AND a.state IN ('approved', 'approved_with_edit', 'denied') AND a.decided_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM contact_reply_decisions d
                         WHERE d.business_id = a.business_id AND d.approval_id = a.approval_id)
      ORDER BY a.decided_at`,
    [db.businessId],
  );
  let recorded = 0;
  for (const r of rows) {
    const { verdict, reason } = agreementVerdict({
      state: r.state,
      proposed: asRecord(r.proposed_input),
      edited: r.edited_input === null ? null : asRecord(r.edited_input),
    });
    const res = await db.query(
      `INSERT INTO contact_reply_decisions
         (business_id, decision_id, conversation_id, job_id, approval_id, verdict, wrong_reason, source_tiers, decided_at,
          topic_id, summary, source_names, internal_document_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (business_id, approval_id) DO NOTHING`,
      [db.businessId, ulid(), r.conversation_id, r.job_id, r.approval_id, verdict, reason,
        sourceTiersFromDetail(r.detail, r.contact_kind), r.decided_at,
        r.topic_id, r.summary, r.source_names, r.internal_document_ids],
    );
    recorded += res.rowCount ?? 0;
  }
  return recorded;
}

/** Carded conversations, each with the state of its card job's latest approval. */
async function settleCarded(
  db: BusinessDb,
  deps: HousekeepingDeps,
): Promise<{ expired: number; answered: number; failedNoticed: number }> {
  const { rows } = await db.query<
    CardRow & {
      contact_key: string; phase: string | null; performed: boolean; latest: string | null; live: boolean;
      may_have_sent: boolean; auto: boolean;
    }
  >(
    `SELECT c.conversation_id, c.card_job_id, c.contact_key, j.phase,
            (EXISTS (SELECT 1 FROM job_steps f
                      WHERE f.business_id = c.business_id AND f.job_id = c.card_job_id
                        AND split_part(f.reason, ' ', 1) = ANY($2::text[]))
             OR EXISTS (SELECT 1 FROM job_step_results u
                         WHERE u.business_id = c.business_id AND u.job_id = c.card_job_id
                           AND u.status = 'unknown')) AS may_have_sent,
            COALESCE((SELECT x.auto FROM contact_card_context x
                       WHERE x.business_id = c.business_id AND x.job_id = c.card_job_id), false) AS auto,
            EXISTS (SELECT 1 FROM job_step_results s
                     WHERE s.business_id = c.business_id AND s.job_id = c.card_job_id
                       AND s.status = 'completed' AND s.performed IS TRUE) AS performed,
            (SELECT a.state FROM approval_requests a
              WHERE a.business_id = c.business_id AND a.job_id = c.card_job_id AND a.proposed_tool = 'wa.send_message'
              ORDER BY a.created_at DESC, a.approval_id DESC LIMIT 1) AS latest,
            EXISTS (SELECT 1 FROM approval_requests a
                     WHERE a.business_id = c.business_id AND a.job_id = c.card_job_id AND a.proposed_tool = 'wa.send_message'
                       AND (a.state = 'pending'
                         OR (a.state IN ('approved', 'approved_with_edit') AND a.consumed_at IS NULL))) AS live
       FROM contact_conversations c
       LEFT JOIN jobs j ON j.business_id = c.business_id AND j.job_id = c.card_job_id
      WHERE c.business_id = $1 AND c.state = 'carded' AND c.card_job_id IS NOT NULL`,
    [db.businessId, MAY_HAVE_SENT_CODES],
  );
  let expired = 0;
  let answered = 0;
  let failedNoticed = 0;
  for (const r of rows) {
    let to: 'answered' | 'closed' | 'expired' | null = null;
    let failedSend = false;
    // A failed AUTO job has no approval and was never shown to the owner: the
    // re-raise (`contact-auto-reraise.ts`) turns it into a card and owns the
    // conversation. Closing it here would swallow the reply (spec §6).
    if (r.auto && r.phase === 'failed' && !r.performed) continue;
    if (r.phase === 'closed' && r.performed) to = 'answered';
    else if (r.phase === 'failed' && !r.performed && (r.latest === 'approved' || r.latest === 'approved_with_edit')) {
      // I2: approved, then the send failed. Terminal; the owner must hear.
      to = 'closed';
      failedSend = true;
    } else if (!r.live) {
      // Nothing live remains on the card job. `followup` is where the real
      // expiry path (scheduler `expireApprovals`) leaves a job whose approval
      // lapsed. Jobs mid-send (execute/verify/remember) are never matched here
      // (R12b), and an approved-and-consumed job in `followup` (a send that
      // timed out) keeps its conversation: only denied/cancelled/expired end it.
      const settledPhase = r.phase === 'await_approval' || r.phase === 'followup'
        || r.phase === 'closed' || r.phase === 'failed' || r.phase === null;
      if (settledPhase && r.latest === 'expired') to = 'expired';
      else if (settledPhase && (r.latest === 'denied' || r.latest === 'cancelled')) to = 'closed';
      // The approved send is finished (job closed, nothing performed): R12b
      // no longer protects the conversation.
      else if (r.phase === 'closed' && (r.latest === 'approved' || r.latest === 'approved_with_edit')) to = 'closed';
    }
    if (to === null) continue;
    // Conditional on the card pointer (R12a), carded still.
    const res = await db.query(
      `UPDATE contact_conversations SET state = $3, closed_at = now()
        WHERE business_id = $1 AND conversation_id = $2 AND state = 'carded' AND card_job_id = $4`,
      [db.businessId, r.conversation_id, to, r.card_job_id],
    );
    if ((res.rowCount ?? 0) !== 1) continue;
    if (failedSend) {
      // The close above is the claim; only this pass sends the note.
      const sent = await deps.messenger.send({ text: failedSendNote(r.contact_key, r.may_have_sent), jobId: null });
      if (!sent.ok) {
        console.error('contact housekeeping: failed-send note not delivered', sent.error ?? '');
      }
      failedNoticed += 1;
    } else if (to === 'answered') answered += 1;
    else expired += 1;
  }
  return { expired, answered, failedNoticed };
}

async function remindOwner(db: BusinessDb, deps: HousekeepingDeps): Promise<number> {
  const cutoff = new Date(deps.now.getTime() - CARD_REMINDER_AFTER_MS);
  const { rows } = await db.query<CardRow & { approval_id: string | null }>(
    `SELECT c.conversation_id, c.card_job_id,
            (SELECT a.approval_id FROM approval_requests a
              WHERE a.business_id = c.business_id AND a.job_id = c.card_job_id
                AND a.proposed_tool = 'wa.send_message' AND a.state = 'pending'
                AND a.consumed_at IS NULL AND a.expires_at > $3
              ORDER BY a.created_at DESC LIMIT 1) AS approval_id
       FROM contact_conversations c
      WHERE c.business_id = $1 AND c.state = 'carded' AND c.card_job_id IS NOT NULL
        AND c.card_presented_at IS NOT NULL AND c.card_presented_at <= $2
        AND c.reminder_sent_at IS NULL`,
    [db.businessId, cutoff, deps.now],
  );
  let reminded = 0;
  for (const r of rows) {
    if (r.approval_id === null) continue;
    // Re-presented through the same path as the card, so the owner's "שלח"
    // still matches the open-card rules (an outbound row for the job ending
    // with the instruction). A card without a draft is reminded too.
    const ok = await presentContactCard(
      db,
      r.approval_id,
      async (text, jobId) => (await deps.messenger.send({ text, jobId })).ok,
      { lead: CARD_REMINDER_LEAD },
    );
    if (!ok) continue;
    const res = await db.query(
      `UPDATE contact_conversations SET reminder_sent_at = $4
        WHERE business_id = $1 AND conversation_id = $2 AND card_job_id = $3 AND reminder_sent_at IS NULL`,
      [db.businessId, r.conversation_id, r.card_job_id, deps.now],
    );
    reminded += res.rowCount ?? 0;
  }
  return reminded;
}

/** One scheduler step; each part runs in its own catch so one failure leaves the rest running. */
export async function contactHousekeeping(db: BusinessDb, deps: HousekeepingDeps): Promise<HousekeepingResult> {
  const result: HousekeepingResult = { reminded: 0, expired: 0, answered: 0, decisionsRecorded: 0, failedNoticed: 0 };
  try {
    result.decisionsRecorded = await recordDecisions(db);
  } catch (error) {
    console.error('contact housekeeping: decision log failed', error instanceof Error ? error.message : error);
  }
  try {
    const settled = await settleCarded(db, deps);
    result.expired = settled.expired;
    result.answered = settled.answered;
    result.failedNoticed = settled.failedNoticed;
  } catch (error) {
    console.error('contact housekeeping: settle failed', error instanceof Error ? error.message : error);
  }
  try {
    result.reminded = await remindOwner(db, deps);
  } catch (error) {
    console.error('contact housekeeping: reminder failed', error instanceof Error ? error.message : error);
  }
  return result;
}
