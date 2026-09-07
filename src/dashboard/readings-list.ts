/**
 * What the assistant read, and what it concluded.
 *
 * The approval card answers "shall I do this?" and needs an action to ask
 * about. Three of the four proposal stances may carry none — `ask`,
 * `no_action`, and an `advise_against` with no alternative — so without this
 * screen, "I am against signing this contract" would reach the owner nowhere.
 *
 * Read-only by construction: no form, no decision, no action. Deciding lives
 * on the approval card, which carries expiry, decision, signing and audit. A
 * second screen that decided would be a second path to the same table.
 */
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';

export interface ReadingSummary {
  documentId: string;
  originalName: string;
  sha256: string;
  readAt: string;
  summary: string;
  stance: string | null;
  headline: string | null;
  reasons: string[];
  approvalId: string | null;
  /**
   * Whether the stored proposal carries an action at all.
   *
   * Separate from `approvalId` because the two answer different questions,
   * and the screen used to conflate them (M2): an `approvalId` of `null` was
   * rendered as "no card — nothing to approve", which is true when the stance
   * carries no action and false when it carries one and
   * `raiseProposalApproval` did not produce a card — it threw, or the
   * proposed tool turned out to be read-only and has no action class to
   * assess. Telling the owner "nothing to approve" about a proposal that
   * proposed something is telling them the wrong thing.
   */
  hasAction: boolean;
}

interface ReadingRow {
  document_id: string;
  original_name: string;
  sha256: string;
  read_at: string;
  // NULL exactly when `document_readings.status = 'unreadable'`
  // (`document_readings_content_present`, migration 013) — genuinely written
  // by `read.ts` on every failed read, not an edge case this screen gets to
  // ignore. `unreadable_reason` is that row's `reason` column, non-null in
  // exactly the case `reading` is null.
  reading: { summary?: unknown } | null;
  unreadable_reason: string | null;
  proposal: { stance?: unknown; headline?: unknown; reasons?: unknown; action?: unknown } | null;
  approval_id: string | null;
}

/** Shown as the "summary" line for a reading that failed. Hebrew, since it is what the owner reads. */
function unreadableSummary(reason: string | null): string {
  return `לא ניתן היה לקרוא את המסמך: ${reason ?? 'סיבה לא ידועה'}`;
}

function toSummary(row: ReadingRow): ReadingSummary {
  const proposal = row.proposal;
  const reasons = Array.isArray(proposal?.reasons)
    ? proposal.reasons
        .map((r) => (typeof r === 'object' && r !== null && 'text' in r ? String(r.text) : ''))
        .filter((t) => t !== '')
    : [];

  // `row.reading === null` is the unreadable case — see the field comment.
  // A "what I read" screen that silently dropped the documents it could not
  // read would be answering a different question than its own title, and
  // CLAUDE.md's rule is that an unreadable result is stored, not discarded.
  const summary =
    row.reading !== null && typeof row.reading.summary === 'string'
      ? row.reading.summary
      : unreadableSummary(row.unreadable_reason);

  return {
    documentId: row.document_id,
    originalName: row.original_name,
    sha256: row.sha256,
    readAt: row.read_at,
    summary,
    stance: typeof proposal?.stance === 'string' ? proposal.stance : null,
    headline: typeof proposal?.headline === 'string' ? proposal.headline : null,
    reasons,
    approvalId: row.approval_id,
    // Positive: an action exists when the stored value is an object. `null`
    // (the schema's own "no action"), a missing key on an older row, and any
    // other shape all read as "no action" — the answer that says less.
    hasAction: typeof proposal?.action === 'object' && proposal.action !== null,
  };
}

/**
 * The most recent readings for a business, each paired with the latest
 * proposal made from it (if any) and the latest approval raised for that
 * proposal's job (if any).
 *
 * Every joined table is scoped by `business_id` in its own right, not only
 * the entry point — the same rule `documentForApproval` follows, and for the
 * same reason: `document_id`, `reading_id` and `job_id` are plain text values
 * copied out of JSONB and other tables, and nothing stops two businesses from
 * holding rows whose ids collide unless every hop re-asserts
 * `business_id = r.business_id` itself.
 *
 * Both `proposals` and `approval_requests` are joined through a `LATERAL`
 * subselect, not a plain join, because neither is unique per reading or per
 * job: a reading may carry more than one proposal over time (a rejected one
 * and a later retry — see `016_proposals.sql`), and a job may carry more than
 * one approval request over time (`consumeApproval` failing after the first
 * one leaves it spent files a new one). A plain join on either would multiply
 * one reading into several output rows the moment either history existed.
 * `LIMIT 1 ... ORDER BY created_at DESC` picks the latest of each, mirroring
 * `documentForApproval`'s own ordering — and, like that query, breaks a
 * `created_at` tie with the row's own ulid-shaped id (`proposal_id`,
 * `approval_id`) rather than leaving Postgres free to pick either row on
 * either run: `documentForApproval` already documents why an ordering with no
 * tiebreaker is a real bug and not a theoretical one (two proposals from the
 * same batch can share a timestamp at clock resolution).
 *
 * No `status` filter on `document_readings`. A row whose reading failed
 * (`status = 'unreadable'`, `content IS NULL` — enforced by
 * `document_readings_content_present`, migration 013) is exactly as real a
 * fact as one that succeeded, and CLAUDE.md is explicit that an unreadable
 * result is stored, not discarded. `toSummary` renders `r.reason` for those
 * rows instead of a summary it does not have.
 */
export async function recentReadings(
  limit: number,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ReadingSummary[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<ReadingRow>(
    `SELECT d.document_id,
            d.original_name,
            d.sha256,
            r.created_at::text AS read_at,
            r.content AS reading,
            r.reason AS unreadable_reason,
            p.content AS proposal,
            ap.approval_id AS approval_id
       FROM document_readings r
       JOIN documents d
         ON d.document_id = r.document_id
        AND d.business_id = r.business_id
       LEFT JOIN LATERAL (
            SELECT pr.content, pr.job_id
              FROM proposals pr
             WHERE pr.reading_id = r.reading_id
               AND pr.business_id = r.business_id
             ORDER BY pr.created_at DESC, pr.proposal_id DESC
             LIMIT 1
       ) p ON true
       LEFT JOIN LATERAL (
            SELECT a.approval_id
              FROM approval_requests a
             WHERE a.job_id = p.job_id
               AND a.business_id = r.business_id
             ORDER BY a.created_at DESC, a.approval_id DESC
             LIMIT 1
       ) ap ON p.job_id IS NOT NULL
      WHERE r.business_id = $1
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [businessId, limit],
  );

  return rows.map(toSummary);
}
