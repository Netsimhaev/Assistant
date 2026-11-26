/**
 * Suggestions the assistant offers the owner, learned from his own decisions on
 * contact reply cards. A suggestion grants nothing: it changes something only
 * when the owner answers "yes", through the existing stores.
 */
import { ulid } from 'ulid';
import type { BusinessDb } from '../db/pool.js';
import { canonicalHash } from '../util/canonical.js';
import { stripBidiControls } from '../util/bidi.js';
import type { Tier2SourceName } from './contact-topics.js';

export type SuggestionKind = 'new_topic' | 'auto_reply' | 'public_document';
export type SuggestionState = 'open' | 'accepted' | 'rejected' | 'expired';
type AppliesTo = 'client' | 'supplier' | 'both';

export interface NewTopicPayload {
  name: string;
  description: string;
  appliesTo: AppliesTo;
  sources: Tier2SourceName[];
  decisionIds: string[];
}
export interface AutoReplyPayload {
  topicId: string;
  /**
   * The topic's `updated_at` (ISO) when the suggestion was made. A topic the
   * owner edited since is a different topic from the one his decisions were
   * about, so the executor treats a mismatch as stale.
   */
  topicUpdatedAt: string;
  right: number;
  counted: number;
}
export interface PublicDocumentPayload {
  documentId: string;
  appliesTo: AppliesTo;
  approvals: number;
}

interface SuggestionBase {
  suggestionId: string;
  state: SuggestionState;
  createdAt: Date;
  deliveredAt: Date | null;
}
export type Suggestion =
  | (SuggestionBase & { kind: 'new_topic'; payload: NewTopicPayload })
  | (SuggestionBase & { kind: 'auto_reply'; payload: AutoReplyPayload })
  | (SuggestionBase & { kind: 'public_document'; payload: PublicDocumentPayload });

interface SuggestionRow {
  suggestion_id: string;
  kind: SuggestionKind;
  payload: unknown;
  state: SuggestionState;
  created_at: Date;
  delivered_at: Date | null;
}

const COLUMNS = 'suggestion_id, kind, payload, state, created_at, delivered_at';

function toSuggestion(row: SuggestionRow): Suggestion {
  return {
    suggestionId: row.suggestion_id,
    kind: row.kind,
    payload: row.payload,
    state: row.state,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  } as Suggestion;
}

export function normaliseName(name: string): string {
  return stripBidiControls(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function shapeHashFor(
  s:
    | { kind: 'new_topic'; name: string }
    | { kind: 'auto_reply'; topicId: string; topicUpdatedAt: Date }
    | { kind: 'public_document'; documentId: string },
): string {
  switch (s.kind) {
    case 'new_topic':
      return canonicalHash({ kind: s.kind, name: normaliseName(s.name) });
    case 'auto_reply':
      return canonicalHash({ kind: s.kind, topicId: s.topicId, topicUpdatedAt: s.topicUpdatedAt.toISOString() });
    case 'public_document':
      return canonicalHash({ kind: s.kind, documentId: s.documentId });
  }
}

/** Null when the same shape was ever offered, in any state. */
export async function insertSuggestion(
  db: BusinessDb,
  kind: SuggestionKind,
  payload: NewTopicPayload | AutoReplyPayload | PublicDocumentPayload,
  shapeHash: string,
): Promise<Suggestion | null> {
  const { rows } = await db.query<SuggestionRow>(
    `INSERT INTO contact_suggestions (business_id, suggestion_id, kind, payload, shape_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id, shape_hash) DO NOTHING
     RETURNING ${COLUMNS}`,
    [db.businessId, ulid(), kind, JSON.stringify(payload), shapeHash],
  );
  const row = rows[0];
  return row === undefined ? null : toSuggestion(row);
}

/**
 * Every decision id a new-topic suggestion ever carried, in any state. The
 * pass never sends these to the clusterer again: an open one is already
 * offered, an accepted one is a topic, and a rejected one the owner refused.
 */
export async function decisionIdsCarriedByNewTopicSuggestions(db: BusinessDb): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(payload->'decisionIds') AS id
       FROM contact_suggestions
      WHERE business_id = $1 AND kind = 'new_topic' AND jsonb_typeof(payload->'decisionIds') = 'array'`,
    [db.businessId],
  );
  return new Set(rows.map((r) => r.id));
}

export async function listOpenSuggestions(db: BusinessDb): Promise<Suggestion[]> {
  const { rows } = await db.query<SuggestionRow>(
    `SELECT ${COLUMNS} FROM contact_suggestions
      WHERE business_id = $1 AND state = 'open' ORDER BY created_at, suggestion_id`,
    [db.businessId],
  );
  return rows.map(toSuggestion);
}

export async function loadSuggestion(db: BusinessDb, suggestionId: string): Promise<Suggestion | null> {
  const { rows } = await db.query<SuggestionRow>(
    `SELECT ${COLUMNS} FROM contact_suggestions WHERE business_id = $1 AND suggestion_id = $2`,
    [db.businessId, suggestionId],
  );
  const row = rows[0];
  return row === undefined ? null : toSuggestion(row);
}

/**
 * Stamps `delivered_at` with the DATABASE clock — the same clock every reader
 * (`deliveredOpenSuggestions`, `openOnWhatsApp`) measures the window against —
 * and only on a row still `open`. True when a row was stamped.
 */
export async function markSuggestionDelivered(db: BusinessDb, suggestionId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE contact_suggestions SET delivered_at = now()
      WHERE business_id = $1 AND suggestion_id = $2 AND state = 'open'`,
    [db.businessId, suggestionId],
  );
  return (rowCount ?? 0) > 0;
}

/** True only for the call that moved the row out of `open`. */
export async function decideSuggestion(
  db: BusinessDb,
  suggestionId: string,
  state: 'accepted' | 'rejected' | 'expired',
  by: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE contact_suggestions SET state = $3, decided_at = now(), decided_by = $4
      WHERE business_id = $1 AND suggestion_id = $2 AND state = 'open'`,
    [db.businessId, suggestionId, state, by],
  );
  return (rowCount ?? 0) > 0;
}

export const SUGGESTION_WINDOW_MINUTES_DEFAULT = 30;

export async function deliveredOpenSuggestions(
  db: BusinessDb,
  opts: { inboundAt: Date | null; windowMinutes?: number },
): Promise<Suggestion[]> {
  if (opts.inboundAt === null) return [];
  const { rows } = await db.query<SuggestionRow>(
    `SELECT ${COLUMNS} FROM contact_suggestions
      WHERE business_id = $1 AND state = 'open'
        AND delivered_at IS NOT NULL AND delivered_at < $2
        AND delivered_at > now() - ($3::int * interval '1 minute')
      ORDER BY created_at, suggestion_id`,
    [db.businessId, opts.inboundAt, opts.windowMinutes ?? SUGGESTION_WINDOW_MINUTES_DEFAULT],
  );
  return rows.map(toSuggestion);
}
