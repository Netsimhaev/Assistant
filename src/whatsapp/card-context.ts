/** What the classifier and the sources said about a card job — read by the card, the decision log and package 2's learning. */
import type { BusinessDb } from '../db/pool.js';

export type MessageKind = 'question' | 'request' | 'commitment' | 'courtesy';

export interface CardContext {
  jobId: string;
  kind: MessageKind | 'unclassified';
  topicId: string | null;
  summary: string;
  sourceNames: string[];
  internalDocumentIds: string[];
  auto: boolean;
}

export const SUMMARY_MAX_CHARS = 200;

interface Row {
  job_id: string;
  kind: CardContext['kind'];
  topic_id: string | null;
  summary: string;
  source_names: string[];
  internal_document_ids: string[];
  auto: boolean;
}

/** An over-long summary is cut, never refused: the card must still be raised. */
export async function saveCardContext(db: BusinessDb, ctx: CardContext): Promise<void> {
  await db.query(
    `INSERT INTO contact_card_context
       (business_id, job_id, kind, topic_id, summary, source_names, internal_document_ids, auto)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (business_id, job_id) DO UPDATE SET
       kind = EXCLUDED.kind, topic_id = EXCLUDED.topic_id, summary = EXCLUDED.summary,
       source_names = EXCLUDED.source_names, internal_document_ids = EXCLUDED.internal_document_ids,
       auto = EXCLUDED.auto`,
    [
      db.businessId,
      ctx.jobId,
      ctx.kind,
      ctx.topicId,
      Array.from(ctx.summary).slice(0, SUMMARY_MAX_CHARS).join(''),
      ctx.sourceNames,
      ctx.internalDocumentIds,
      ctx.auto,
    ],
  );
}

export async function loadCardContext(db: BusinessDb, jobId: string): Promise<CardContext | null> {
  const { rows } = await db.query<Row>(
    `SELECT job_id, kind, topic_id, summary, source_names, internal_document_ids, auto
       FROM contact_card_context WHERE business_id = $1 AND job_id = $2`,
    [db.businessId, jobId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    jobId: r.job_id,
    kind: r.kind,
    topicId: r.topic_id,
    summary: r.summary,
    sourceNames: r.source_names,
    internalDocumentIds: r.internal_document_ids,
    auto: r.auto,
  };
}
