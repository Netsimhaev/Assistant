/**
 * The conversation between the owner and the assistant, and everything else
 * that arrives at the same WhatsApp number.
 *
 * The dedupe is the unique index on `(business_id, provider_message_id)`, not
 * a prior read — GREEN-API may redeliver a message, and "we probably already
 * saw this" is not a control. `recordInbound` therefore inserts with
 * `ON CONFLICT ... DO NOTHING RETURNING *` and reads `null` off the empty
 * result set, so the index is what decides, not a SELECT this function ran a
 * moment earlier that something else could race.
 *
 * `claimMessage` is the same shape for the same reason: a single `UPDATE ...
 * WHERE state = 'received'` whose row count says whether it won. A
 * read-then-write would let two pollers both observe `received` and both
 * proceed.
 */
import { ulid } from 'ulid';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';

export type MessageDirection = 'inbound' | 'outbound';
export type SenderKind = 'principal' | 'other';
/**
 * Five states. `'reported'` is terminal and means the owner has been told
 * what came of the instruction this message opened — a later task writes it,
 * once the report-back exists; nothing in this module does.
 */
export type MessageState = 'received' | 'claimed' | 'handled' | 'failed' | 'reported';

export interface StoredMessage {
  id: string;
  providerMessageId: string | null;
  direction: MessageDirection;
  senderNumber: string | null;
  senderKind: SenderKind | null;
  body: string | null;
  transcript: string | null;
  mediaKind: string | null;
  providerTimestamp: string;
  state: MessageState;
  jobId: string | null;
  createdAt: string;
}

interface MessageRow {
  id: string;
  provider_message_id: string | null;
  direction: string;
  sender_number: string | null;
  sender_kind: string | null;
  body: string | null;
  transcript: string | null;
  media_kind: string | null;
  provider_timestamp: Date;
  state: string;
  job_id: string | null;
  created_at: Date;
}

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    providerMessageId: row.provider_message_id,
    direction: row.direction as MessageDirection,
    senderNumber: row.sender_number,
    senderKind: row.sender_kind as SenderKind | null,
    body: row.body,
    transcript: row.transcript,
    mediaKind: row.media_kind,
    providerTimestamp: row.provider_timestamp.toISOString(),
    state: row.state as MessageState,
    jobId: row.job_id,
    createdAt: row.created_at.toISOString(),
  };
}

const COLUMNS = `id, provider_message_id, direction, sender_number, sender_kind,
  body, transcript, media_kind, provider_timestamp, state, job_id, created_at`;

/**
 * Returns `null` when `providerMessageId` already exists — a real dedupe,
 * enforced by `whatsapp_messages_provider_idx`, not a best-effort check.
 */
export async function recordInbound(
  input: {
    providerMessageId: string;
    senderNumber: string;
    senderKind: SenderKind;
    body: string | null;
    mediaKind: string | null;
    providerTimestamp: string;
  },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<StoredMessage | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const id = `WA-${ulid()}`;

  const { rows } = await db.query<MessageRow>(
    `INSERT INTO whatsapp_messages
       (id, business_id, provider_message_id, direction, sender_number,
        sender_kind, body, media_kind, provider_timestamp, state)
     VALUES ($1, $2, $3, 'inbound', $4, $5, $6, $7, $8, 'received')
     ON CONFLICT (business_id, provider_message_id) WHERE provider_message_id IS NOT NULL
       DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      id,
      businessId,
      input.providerMessageId,
      input.senderNumber,
      input.senderKind,
      input.body,
      input.mediaKind,
      input.providerTimestamp,
    ],
  );
  return rows[0] !== undefined ? toStoredMessage(rows[0]) : null;
}

/** The assistant's own outbound message. No dedupe: the assistant originates it. */
export async function recordOutbound(
  input: { body: string; jobId: string | null },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<StoredMessage> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const id = `WA-${ulid()}`;

  const { rows } = await db.query<MessageRow>(
    `INSERT INTO whatsapp_messages
       (id, business_id, direction, body, provider_timestamp, state, job_id)
     VALUES ($1, $2, 'outbound', $3, now(), 'handled', $4)
     RETURNING ${COLUMNS}`,
    [id, businessId, input.body, input.jobId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('insert returned no row');
  return toStoredMessage(row);
}

/**
 * Moves `received` → `claimed`. Returns `false` when it was not `received` —
 * already claimed by another caller, or no such row for this business.
 *
 * A single `UPDATE ... WHERE state = 'received'` is the whole mechanism: two
 * concurrent callers racing this statement leave exactly one `rowCount === 1`,
 * which a read-then-write could not guarantee.
 */
export async function claimMessage(
  id: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<boolean> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rowCount } = await db.query(
    `UPDATE whatsapp_messages SET state = 'claimed'
      WHERE id = $1 AND business_id = $2 AND state = 'received'`,
    [id, businessId],
  );
  return rowCount === 1;
}

/**
 * Throws when `id` (under `businessId`) matches no row. A silent miss would
 * leave the message `claimed` forever — `unclaimedInbound` only ever offers
 * `received`, so nothing would re-offer it and no caller would know the
 * instruction was never recorded as settled. Same reasoning
 * `markContentIngested` (`src/documents/read.ts`) already applies to its own
 * `UPDATE`: an unresolved id is not a property of the message, it is a bug
 * that must surface here rather than downstream as silence.
 */
export async function settleMessage(
  id: string,
  state: 'handled' | 'failed',
  patch: { transcript?: string; jobId?: string } = {},
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rowCount } = await db.query(
    `UPDATE whatsapp_messages
        SET state = $1,
            transcript = coalesce($2, transcript),
            job_id = coalesce($3, job_id)
      WHERE id = $4 AND business_id = $5`,
    [state, patch.transcript ?? null, patch.jobId ?? null, id, businessId],
  );
  if (rowCount !== 1) {
    throw new Error(`settleMessage: no whatsapp_messages row for id=${id}, businessId=${businessId}`);
  }
}

/**
 * Oldest first, by the provider's own timestamp — with `id` as a
 * deterministic tie-break. GREEN-API timestamps are second-granularity, so
 * two instructions arriving in the same second would otherwise come out in
 * an order that cannot be reconstructed from the audit trail afterwards; ids
 * are monotonic ULIDs, so ordering by them resolves a tie the same way every
 * time this is read.
 */
export async function unclaimedInbound(
  options: { businessId?: string; limit?: number; db?: Queryable } = {},
): Promise<StoredMessage[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const limit = options.limit ?? 50;

  const { rows } = await db.query<MessageRow>(
    `SELECT ${COLUMNS} FROM whatsapp_messages
      WHERE business_id = $1 AND direction = 'inbound' AND state = 'received'
      ORDER BY provider_timestamp ASC, id ASC
      LIMIT $2`,
    [businessId, limit],
  );
  return rows.map(toStoredMessage);
}

/**
 * Newest last, for the conversation screen. Same tie-break as
 * `unclaimedInbound`, applied in both the inner "most recent N" selection and
 * the outer re-sort, so a same-second pair lands in one deterministic order
 * rather than whichever order Postgres happens to return them in.
 */
export async function conversation(
  options: { businessId?: string; limit?: number; db?: Queryable } = {},
): Promise<StoredMessage[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const limit = options.limit ?? 200;

  const { rows } = await db.query<MessageRow>(
    `SELECT * FROM (
       SELECT ${COLUMNS} FROM whatsapp_messages
        WHERE business_id = $1
        ORDER BY provider_timestamp DESC, id DESC
        LIMIT $2
     ) recent
     ORDER BY provider_timestamp ASC, id ASC`,
    [businessId, limit],
  );
  return rows.map(toStoredMessage);
}
