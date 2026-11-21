/**
 * Conversations with contacts (clients and suppliers) over WhatsApp.
 *
 * At most one live (`open`/`carded`) conversation exists per number; the
 * partial unique index `contact_conversations_live_per_number` makes two
 * concurrent runners create one row. `contact_key` is the digits returned by
 * `authorityNumberKey` (no '+'); message numbers are compared after stripping
 * every non-digit, so stored formats do not matter.
 */
import { ulid } from 'ulid';
import type { BusinessDb } from '../db/pool.js';

export type ContactKind = 'client' | 'supplier' | 'unknown';
export type ConversationState = 'open' | 'carded' | 'answered' | 'closed' | 'expired';

export interface ContactConversation {
  conversationId: string;
  contactKey: string;
  contactSubjectKey: string | null;
  contactKind: ContactKind;
  state: ConversationState;
  openedAt: Date;
  lastInboundAt: Date;
  holdingSentAt: Date | null;
  holdingDueAt: Date | null;
  cardJobId: string | null;
  cardPresentedAt: Date | null;
  reminderSentAt: Date | null;
  closedAt: Date | null;
}

interface ContactConversationRow {
  conversation_id: string;
  contact_key: string;
  contact_subject_key: string | null;
  contact_kind: ContactKind;
  state: ConversationState;
  opened_at: Date;
  last_inbound_at: Date;
  holding_sent_at: Date | null;
  holding_due_at: Date | null;
  card_job_id: string | null;
  card_presented_at: Date | null;
  reminder_sent_at: Date | null;
  closed_at: Date | null;
}

const toContactConversation = (r: ContactConversationRow): ContactConversation => ({
  conversationId: r.conversation_id,
  contactKey: r.contact_key,
  contactSubjectKey: r.contact_subject_key,
  contactKind: r.contact_kind,
  state: r.state,
  openedAt: r.opened_at,
  lastInboundAt: r.last_inbound_at,
  holdingSentAt: r.holding_sent_at,
  holdingDueAt: r.holding_due_at,
  cardJobId: r.card_job_id,
  cardPresentedAt: r.card_presented_at,
  reminderSentAt: r.reminder_sent_at,
  closedAt: r.closed_at,
});

export interface OpenInput {
  key: string;
  subjectKey: string | null;
  kind: ContactKind;
  inboundAt: Date;
}

export async function openOrAppend(
  db: BusinessDb,
  input: OpenInput,
): Promise<{ conversation: ContactConversation; created: boolean }> {
  // Single statement: insert, or on a live conversation for this number bump
  // last_inbound_at (never backwards). `xmax = 0` marks a fresh insert.
  const { rows } = await db.query<ContactConversationRow & { inserted: boolean }>(
    `INSERT INTO contact_conversations
       (business_id, conversation_id, contact_key, contact_subject_key, contact_kind, state, last_inbound_at)
     VALUES ($6, $1, $2, $3, $4, 'open', $5)
     ON CONFLICT (business_id, contact_key) WHERE state IN ('open', 'carded')
     DO UPDATE SET last_inbound_at = GREATEST(contact_conversations.last_inbound_at, EXCLUDED.last_inbound_at)
     RETURNING *, (xmax = 0) AS inserted`,
    [ulid(), input.key, input.subjectKey, input.kind, input.inboundAt, db.businessId],
  );
  const row = rows[0];
  if (!row) throw new Error('openOrAppend returned no row');
  return { conversation: toContactConversation(row), created: row.inserted };
}

export async function setCard(
  db: BusinessDb,
  conversationId: string,
  jobId: string,
  presentedAt: Date | null,
): Promise<void> {
  await db.query(
    `UPDATE contact_conversations SET state = 'carded', card_job_id = $2, card_presented_at = $3
      WHERE business_id = $4 AND conversation_id = $1 AND state IN ('open', 'carded')`,
    [conversationId, jobId, presentedAt, db.businessId],
  );
}

export async function markHoldingSent(db: BusinessDb, conversationId: string, at: Date): Promise<void> {
  await db.query(
    `UPDATE contact_conversations SET holding_sent_at = $2, holding_due_at = NULL
      WHERE business_id = $3 AND conversation_id = $1`,
    [conversationId, at, db.businessId],
  );
}

export async function deferHolding(db: BusinessDb, conversationId: string, dueAt: Date): Promise<void> {
  await db.query(
    `UPDATE contact_conversations SET holding_due_at = $2
      WHERE business_id = $3 AND conversation_id = $1`,
    [conversationId, dueAt, db.businessId],
  );
}

export async function closeConversation(
  db: BusinessDb,
  conversationId: string,
  state: 'answered' | 'closed' | 'expired',
): Promise<void> {
  await db.query(
    `UPDATE contact_conversations SET state = $2, closed_at = now()
      WHERE business_id = $3 AND conversation_id = $1 AND state IN ('open', 'carded')`,
    [conversationId, state, db.businessId],
  );
}

export async function loadConversation(db: BusinessDb, conversationId: string): Promise<ContactConversation | null> {
  const { rows } = await db.query<ContactConversationRow>(
    `SELECT * FROM contact_conversations WHERE business_id = $2 AND conversation_id = $1`,
    [conversationId, db.businessId],
  );
  return rows[0] ? toContactConversation(rows[0]) : null;
}

export async function conversationByCardJob(db: BusinessDb, jobId: string): Promise<ContactConversation | null> {
  const { rows } = await db.query<ContactConversationRow>(
    `SELECT * FROM contact_conversations WHERE business_id = $2 AND card_job_id = $1
      ORDER BY opened_at DESC LIMIT 1`,
    [jobId, db.businessId],
  );
  return rows[0] ? toContactConversation(rows[0]) : null;
}

export interface RecentMessage {
  direction: 'inbound' | 'outbound';
  body: string;
  at: Date;
}

export async function recentMessages(db: BusinessDb, key: string, limit = 10): Promise<RecentMessage[]> {
  const { rows } = await db.query<{ direction: 'inbound' | 'outbound'; body: string | null; transcript: string | null; at: Date }>(
    `SELECT direction, body, transcript, provider_timestamp AS at FROM (
       SELECT direction, body, transcript, provider_timestamp, created_at FROM whatsapp_messages
        WHERE business_id = $3
          AND ((direction = 'inbound' AND regexp_replace(coalesce(sender_number, ''), '[^0-9]', '', 'g') = $1)
            OR (direction = 'outbound' AND regexp_replace(coalesce(recipient_number, ''), '[^0-9]', '', 'g') = $1))
        ORDER BY provider_timestamp DESC, created_at DESC LIMIT $2
     ) t ORDER BY provider_timestamp ASC, created_at ASC`,
    [key, limit, db.businessId],
  );
  return rows.map((r) => ({ direction: r.direction, body: r.body ?? r.transcript ?? '', at: r.at }));
}
