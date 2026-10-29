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
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';

export type MessageDirection = 'inbound' | 'outbound';
export type SenderKind = 'principal' | 'other';
/**
 * Six states (migration 038 added the fifth; `'reported'` was already the
 * sixth position, unchanged). `'reported'` is terminal and means the owner
 * has been told the real outcome of the instruction this message opened.
 * `'reported_interim'` means he has been told something ONCE but the job has
 * not reached a terminal phase yet — an approval card is still open — so a
 * second, real report is still owed. Both are written by
 * `claimForReport` below, never by anything else in this module.
 */
export type MessageState =
  | 'received'
  | 'claimed'
  | 'handled'
  | 'failed'
  | 'reported_interim'
  | 'reported';

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
 * The report-once claim, parameterised by which report is being made.
 *
 * `'interim'` moves `'handled'`/`'failed'` → `'reported_interim'` — the
 * owner has been told something once, but the job has not reached a
 * terminal phase yet (an approval card is open), so a real report is still
 * owed. `'terminal'` moves `'handled'`/`'failed'`/`'reported_interim'` →
 * `'reported'` — the real, final outcome. The two claims are what task 8's
 * fix round 1 added (migration 038) once an `await_approval` interim notice
 * was found to be consuming the SAME claim a closed job needed later: a
 * money-moving instruction got told "waiting for your approval" once,
 * approved, ran, closed — and nothing ever told the owner that it closed,
 * because the opening message already read `'reported'`.
 *
 * `'terminal'` deliberately also accepts `'reported_interim'` as a starting
 * state — that is the whole mechanism: a job that already earned an interim
 * notice is exactly the one that must still earn a terminal one. `'interim'`
 * deliberately does NOT accept `'reported_interim'` as a starting state —
 * that is report-once for the interim notice itself: a second pass that
 * finds the job still in `await_approval` must not repeat it.
 *
 * The same single-`UPDATE ... WHERE` shape as `claimMessage` above, and for
 * the identical reason: `reportWhatsAppJobs` (`src/orchestrator/whatsapp-report.ts`)
 * must send the owner exactly one message per claim, and a read-then-write
 * would let two overlapping passes both see an unclaimed row and both send.
 * Returns `false` rather than throwing on a zero-row match — unlike
 * `settleMessage` — because a miss here is not a bug to surface: it is
 * "another pass already made this claim", the ordinary outcome of losing the
 * race, and the caller's answer to it is to send nothing, not to fail.
 */
export async function claimForReport(
  id: string,
  kind: 'interim' | 'terminal',
  options: { businessId?: string; db?: Queryable } = {},
): Promise<boolean> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rowCount } =
    kind === 'interim'
      ? await db.query(
          `UPDATE whatsapp_messages SET state = 'reported_interim'
            WHERE id = $1 AND business_id = $2 AND state IN ('handled', 'failed')`,
          [id, businessId],
        )
      : await db.query(
          `UPDATE whatsapp_messages SET state = 'reported'
            WHERE id = $1 AND business_id = $2
              AND state IN ('handled', 'failed', 'reported_interim')`,
          [id, businessId],
        );
  return rowCount === 1;
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

/**
 * How many WhatsApp instruction attempts this business has made today —
 * whatever `runInstruction` returned, not only the ones that reached
 * `'planned'`. A caller cannot see which branch the planner took from the
 * outside, and a cap that only counted successes would let a flood of
 * over-length or malformed messages run unbounded; over-counting a refusal
 * costs one slot out of fifty, under-counting is unbounded (see
 * `src/orchestrator/whatsapp-door.ts`, the one production caller).
 *
 * Counts `audit_log` rows, not a maintained counter — the same reasoning
 * `curationRunsToday` (`src/memory/curate.ts`) and `whatsappTranscriptionsToday`
 * (`src/whatsapp/transcribe.ts`) already apply: a counter kept beside the
 * source can drift from it with nobody noticing. The kind filter is
 * `'whatsapp_instruction'` specifically, never the generic `'whatsapp'` or
 * the sibling `'whatsapp_transcription'` kind — see `'whatsapp_instruction'`'s
 * own docblock in `src/domain/audit.ts` for why a shared kind would spend one
 * budget against the other.
 *
 * **`businessId` is a required positional parameter, not `options.businessId
 * ?? config.businessId`** — fix round 1, Critical 1. This pair's sibling read
 * (`whatsappTranscriptionsToday`, above) does default, but that default is
 * safe only because nothing here writes under it; the moment a cap's
 * *count* and its *write* can silently disagree about which business they
 * mean, a caller that forgets the argument reads one business's rows while
 * writing another's — exactly the gap that let the cap for an
 * explicitly-named business stay permanently empty. `recordWhatsAppInstructionAttempt`
 * below carries the same requirement for the same reason, and the two must
 * be called with the same value or the cap this pair exists to enforce means
 * nothing.
 *
 * Lives here, beside the rest of the WhatsApp message lifecycle, rather than
 * in `transcribe.ts` (which spends the *sibling* budget) or a small module of
 * its own. Fix round 1 confirmed this is no longer forced by the invariant
 * test (see `whatsapp-invariants.test.ts`'s narrower replacement) — it is now
 * a real design choice, not a workaround, and the choice made is: `store.ts`
 * already owns `whatsapp_messages` and the dedupe/claim mechanics for this
 * exact channel, and `transcribe.ts`'s own precedent (reading and writing
 * `audit_log` from a module that does not own that table either) is the
 * established shape for a channel-scoped budget, not an exception to it.
 */
export async function whatsappInstructionsToday(
  businessId: string,
  options: { db?: Queryable } = {},
): Promise<number> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log
      WHERE business_id = $1 AND kind = 'whatsapp_instruction'
        AND at >= date_trunc('day', now())`,
    [businessId],
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * The one audit row an instruction attempt produces, whatever `runInstruction`
 * returned (or a thrown rejection — the door also calls this from its own
 * catch when an attempt had already begun). Carries counts (the
 * instruction's character length) and the outcome status only — never the
 * instruction text and never the sender's number. See
 * `'whatsapp_instruction'`'s own docblock in `src/domain/audit.ts` for the
 * full reasoning.
 *
 * `businessId` is a required positional parameter, exactly like `recordAttempt`
 * (`transcribe.ts`) and for the identical reason stated on
 * `whatsappInstructionsToday` above — fix round 1, Critical 1. The one call
 * site that existed before this fix omitted it entirely, which is exactly
 * the shape `options.businessId ?? config.businessId` makes easy to do by
 * accident and a required positional argument makes a compile error instead.
 *
 * Every row this writes carries a fixed trust level: only a message from the
 * principal ever reaches this far (`src/orchestrator/whatsapp-door.ts` calls
 * `runInstruction` for no one else), so there is nothing here to compute —
 * the value is as fixed as `runInstruction`'s own, stated once, in the one
 * module built to state it.
 *
 * Swallowed on failure, matching `recordAttempt` (`transcribe.ts`): an
 * instruction that already ran must not be lost because this budget row
 * failed to write a moment later.
 */
export async function recordWhatsAppInstructionAttempt(
  businessId: string,
  counts: {
    status: 'planned' | 'needs_answer' | 'needs_confirmation' | 'refused';
    textLength: number;
  },
): Promise<void> {
  try {
    await appendAudit(
      {
        actor: 'orchestrator',
        kind: 'whatsapp_instruction',
        charterVersion: 'n/a',
        provenance: 'boss',
        inputHash: canonicalHash(counts),
        artifacts: [],
        costMinor: null,
        tokens: null,
        reason: `הוראת וואטסאפ · ${counts.status} · ${counts.textLength} תווים`,
      },
      { businessId },
    );
  } catch {
    // Swallowed on purpose — see this function's docblock.
  }
}
