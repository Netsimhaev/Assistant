/**
 * Resolving an approval card to the document behind it (spec 2026-09-01-signature §6).
 *
 * `null` is the ordinary case: a mail send or a WhatsApp reply has no document
 * at all, and the card simply shows no sign button. It is not an error, and
 * this module never throws to signal "no document" — the chain just does not
 * reach one.
 *
 * The chain is `approval_requests.job_id → proposals.job_id →
 * proposals.reading_id → document_readings.document_id → documents`.
 * `proposals.job_id` (migration 018) is what makes the trip possible at all —
 * before it, nothing tied a proposal back to the job whose approval card is on
 * screen.
 *
 * Written as one SQL query, not four round trips, and every table in the join
 * is scoped by `business_id` — not only `approval_requests`. A join that
 * scopes the entry point and then follows unscoped foreign keys is exactly
 * how one tenant's row reaches another tenant's page: `job_id`, `reading_id`
 * and `document_id` are all just text values copied out of JSONB and other
 * tables, and nothing stops two businesses from holding rows whose ids
 * collide unless every hop re-asserts `business_id = a.business_id` itself.
 */

import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { IntentName } from '../domain/reading.js';
import type { DocumentRecord, DocumentSource, DocumentStatus } from '../documents/types.js';

export type { DocumentRecord } from '../documents/types.js';

/**
 * The document behind an approval, and what the proposal meant to do about it.
 *
 * The two travel together because they are resolved by one query over one
 * proposal row, and separating them is how they come to disagree: the card
 * renders the document from the latest proposal and the sign decision is
 * taken on a different one. `documentForApproval`'s ordering already carries a
 * tiebreaker for exactly that reason — see its docblock.
 */
export interface ApprovalDocument {
  document: DocumentRecord;
  /**
   * The `intent` of the proposal's action.
   *
   * `null` when the proposal carries no action, when the stored proposal
   * predates the field, or when the stored value is not a member of the
   * closed `IntentName` enum. All three collapse to the same answer on
   * purpose: a caller asking "may this be signed" must read an unparseable
   * value as "no", and `isDocumentDecisionIntent` does.
   */
  intent: IntentName | null;
}

interface DocumentRow {
  document_id: string;
  business_id: string;
  source: string;
  original_name: string;
  media_type: string;
  sha256: string;
  byte_size: bigint;
  stored_path: string;
  status: string;
  reason: string | null;
  read_attempts: number;
  read_error: string | null;
  /** `proposals.content -> 'action' ->> 'intent'`; NULL when the proposal carries no action. */
  action_intent: string | null;
}

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    documentId: row.document_id,
    businessId: row.business_id,
    source: row.source as DocumentSource,
    originalName: row.original_name,
    mediaType: row.media_type,
    sha256: row.sha256,
    byteSize: Number(row.byte_size),
    storedPath: row.stored_path,
    status: row.status as DocumentStatus,
    reason: row.reason,
    readAttempts: row.read_attempts,
    readError: row.read_error,
  };
}

/**
 * The document behind an approval, if any.
 *
 * A job may have several proposals over time — a rejected one and a later
 * retry, for instance. Ordered by the proposal's own `created_at DESC`,
 * `proposal_id DESC` and limited to one: the card shows the most recent
 * proposal made for this job, the same one the dashboard would show if it
 * rendered the proposal itself. The `proposal_id` tiebreaker matters because
 * this query runs twice for one sign — once to render the card, once again
 * when the POST resolves the document to verify and stamp — and two
 * proposals sharing a `created_at` (same batch, clock resolution) would
 * otherwise let Postgres pick either row on either run, so the signature
 * could end up attesting to a different document than the one the card
 * showed. `proposal_id` is a ulid, so `DESC` also happens to agree with
 * "most recently created" whenever `created_at` alone cannot tell two rows
 * apart.
 *
 * Recorded and deliberately not changed: this filters on neither the
 * proposal's `status` nor the document's. An `unproposable` proposal still
 * carries `reading_id` and `job_id` and can win the ordering. It is harmless
 * as things stand — both proposals for one job name the same reading, so the
 * document resolved is the same either way — but the query's contract is "the
 * latest proposal", not "the latest usable one", and a future caller reading
 * the name for the second meaning would be wrong.
 */
export async function documentForApproval(
  approvalId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ApprovalDocument | null> {
  const db = options.db ?? getPool();
  const businessId = options.businessId ?? config.businessId;

  const { rows } = await db.query<DocumentRow>(
    `SELECT d.document_id, d.business_id, d.source, d.original_name, d.media_type,
            d.sha256, d.byte_size, d.stored_path, d.status, d.reason,
            d.read_attempts, d.read_error,
            p.content -> 'action' ->> 'intent' AS action_intent
       FROM approval_requests a
       JOIN proposals p
         ON p.job_id = a.job_id AND p.business_id = a.business_id
       JOIN document_readings r
         ON r.reading_id = p.reading_id AND r.business_id = a.business_id
       JOIN documents d
         ON d.document_id = r.document_id AND d.business_id = a.business_id
      WHERE a.approval_id = $1 AND a.business_id = $2
      ORDER BY p.created_at DESC, p.proposal_id DESC
      LIMIT 1`,
    [approvalId, businessId],
  );

  const row = rows[0];
  if (row === undefined) return null;
  // `safeParse`, not a cast. The value comes out of JSONB written by a model's
  // answer; the enum is the only thing that says which names exist, and a name
  // it does not know must arrive here as `null` rather than as a string that
  // happens to fail an `includes` check later on.
  const parsed = IntentName.safeParse(row.action_intent);
  return { document: toDocument(row), intent: parsed.success ? parsed.data : null };
}
