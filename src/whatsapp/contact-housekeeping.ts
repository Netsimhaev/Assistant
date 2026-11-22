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
 * Job phase changes are `resume.ts`'s business; nothing here transitions a job.
 */
import { ulid } from 'ulid';
import type { BusinessDb } from '../db/pool.js';
import { agreementVerdict } from '../governance/agreement-verdict.js';
import { presentContactCard } from './contact-card.js';
import { INTERNAL_DOCS_SOURCE } from './contact-flow.js';
import type { BossMessenger } from './messenger.js';

export const CARD_REMINDER_AFTER_MS = 5 * 60 * 60 * 1000;
export const CARD_REMINDER_LEAD = 'תזכורת: עדיין ממתין לאישורך';
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
  }>(
    `SELECT a.approval_id, a.job_id, a.state, a.proposed_input, a.edited_input, a.detail, a.decided_at,
            c.conversation_id, c.contact_kind
       FROM approval_requests a
       JOIN contact_conversations c ON c.business_id = a.business_id AND c.card_job_id = a.job_id
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
         (business_id, decision_id, conversation_id, job_id, approval_id, verdict, wrong_reason, source_tiers, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (business_id, approval_id) DO NOTHING`,
      [db.businessId, ulid(), r.conversation_id, r.job_id, r.approval_id, verdict, reason,
        sourceTiersFromDetail(r.detail, r.contact_kind), r.decided_at],
    );
    recorded += res.rowCount ?? 0;
  }
  return recorded;
}

/** Carded conversations, each with the state of its card job's latest approval. */
async function settleCarded(db: BusinessDb): Promise<{ expired: number; answered: number }> {
  const { rows } = await db.query<CardRow & { phase: string | null; performed: boolean; latest: string | null; live: boolean }>(
    `SELECT c.conversation_id, c.card_job_id, j.phase,
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
    [db.businessId],
  );
  let expired = 0;
  let answered = 0;
  for (const r of rows) {
    let to: 'answered' | 'closed' | 'expired' | null = null;
    if (r.phase === 'closed' && r.performed) to = 'answered';
    else if (!r.live && (r.phase === 'await_approval' || r.phase === 'closed' || r.phase === 'failed' || r.phase === null)) {
      // Only a card whose latest approval ended without a send, and whose job
      // is not mid-send (R12b): approved-and-consumed jobs in execute/followup/
      // verify/remember keep the conversation carded.
      if (r.latest === 'expired') to = 'expired';
      else if (r.latest === 'denied' || r.latest === 'cancelled') to = 'closed';
    }
    if (to === null) continue;
    // Conditional on the card pointer (R12a), carded still.
    const res = await db.query(
      `UPDATE contact_conversations SET state = $3, closed_at = now()
        WHERE business_id = $1 AND conversation_id = $2 AND state = 'carded' AND card_job_id = $4`,
      [db.businessId, r.conversation_id, to, r.card_job_id],
    );
    if ((res.rowCount ?? 0) === 1) {
      if (to === 'answered') answered += 1;
      else expired += 1;
    }
  }
  return { expired, answered };
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
  const result: HousekeepingResult = { reminded: 0, expired: 0, answered: 0, decisionsRecorded: 0 };
  try {
    result.decisionsRecorded = await recordDecisions(db);
  } catch (error) {
    console.error('contact housekeeping: decision log failed', error instanceof Error ? error.message : error);
  }
  try {
    const settled = await settleCarded(db);
    result.expired = settled.expired;
    result.answered = settled.answered;
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
