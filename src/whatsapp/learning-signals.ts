/**
 * Learning signals read from the owner's own decisions on contact reply cards.
 * SQL and fixed thresholds only — no model. Each function returns candidates
 * for a suggestion; nothing here changes any setting.
 */
import type { BusinessDb } from '../db/pool.js';
import { AGREEMENT_WINDOW_DAYS, isLearned } from '../governance/agreement.js';
import { listTopics, type ContactTopic, type TopicAppliesTo } from './contact-topics.js';

/** Approved drafts that leaned on one owner document before it is suggested public. */
export const PUBLIC_DOC_MIN_APPROVALS = 3;

/** How far back unthemed decisions are considered for a new-topic suggestion. */
export const UNTHEMED_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** An approved decision: the owner accepted the draft, possibly after editing it. */
const APPROVED_SQL = `(d.verdict = 'right' OR (d.verdict = 'wrong' AND d.wrong_reason IS DISTINCT FROM 'denied'))`;

export interface AutoReplyCandidate {
  topic: ContactTopic;
  right: number;
  counted: number;
}

export async function autoReplyCandidates(db: BusinessDb, now: Date): Promise<AutoReplyCandidate[]> {
  const topics = (await listTopics(db)).filter((t) => !t.autoReply);
  const out: AutoReplyCandidate[] = [];
  for (const topic of topics) {
    const windowStart = new Date(Math.max(now.getTime() - AGREEMENT_WINDOW_DAYS * DAY_MS, topic.updatedAt.getTime()));
    const { rows } = await db.query<{ right: string; counted: string }>(
      `SELECT count(*) FILTER (WHERE verdict = 'right') AS right,
              count(*) AS counted
         FROM (SELECT DISTINCT ON (job_id) verdict
                 FROM contact_reply_decisions
                WHERE business_id = $1 AND topic_id = $2 AND decided_at > $3
                  AND verdict IN ('right', 'wrong')
                ORDER BY job_id, decided_at, decision_id) per_job`,
      [db.businessId, topic.topicId, windowStart],
    );
    const right = Number(rows[0]?.right ?? 0);
    const counted = Number(rows[0]?.counted ?? 0);
    if (isLearned({ right, counted, topWrongReason: null })) out.push({ topic, right, counted });
  }
  return out;
}

export interface PublicDocumentCandidate {
  documentId: string;
  approvals: number;
  appliesTo: TopicAppliesTo;
}

export async function publicDocumentCandidates(db: BusinessDb): Promise<PublicDocumentCandidate[]> {
  const { rows } = await db.query<{ document_id: string; approvals: string; kinds: string[] }>(
    `SELECT u.document_id,
            count(DISTINCT d.job_id) AS approvals,
            array_agg(DISTINCT c.contact_kind) AS kinds
       FROM contact_reply_decisions d
       CROSS JOIN LATERAL unnest(d.internal_document_ids) AS u(document_id)
       JOIN documents doc
         ON doc.business_id = d.business_id AND doc.document_id = u.document_id
       LEFT JOIN contact_conversations c
         ON c.business_id = d.business_id AND c.conversation_id = d.conversation_id
      WHERE d.business_id = $1
        AND ${APPROVED_SQL}
        AND doc.source = 'instruction' AND doc.status = 'extracted' AND doc.public_for IS NULL
        -- A document assigned to a contact (their invoice) is that contact's, never public.
        AND NOT EXISTS (SELECT 1 FROM contact_documents cd
                         WHERE cd.business_id = doc.business_id AND cd.document_id = doc.document_id)
      GROUP BY u.document_id
     HAVING count(DISTINCT d.job_id) >= $2
      ORDER BY u.document_id`,
    [db.businessId, PUBLIC_DOC_MIN_APPROVALS],
  );
  const out: PublicDocumentCandidate[] = [];
  for (const row of rows) {
    const kinds = row.kinds.filter((k) => k === 'client' || k === 'supplier');
    if (kinds.length === 0) continue;
    const appliesTo: TopicAppliesTo = kinds.length > 1 ? 'both' : (kinds[0] as 'client' | 'supplier');
    out.push({ documentId: row.document_id, approvals: Number(row.approvals), appliesTo });
  }
  return out;
}

export interface UnthemedDecision {
  decisionId: string;
  decidedAt: Date;
  summary: string;
  sourceNames: string[];
  approved: boolean;
  contactKind: 'client' | 'supplier' | 'unknown';
}

interface UnthemedRow {
  decision_id: string;
  decided_at: Date;
  summary: string;
  source_names: string[] | null;
  approved: boolean;
  contact_kind: string | null;
}

export async function unthemedDecisions(db: BusinessDb, now: Date, limit = 200): Promise<UnthemedDecision[]> {
  const since = new Date(now.getTime() - UNTHEMED_WINDOW_DAYS * DAY_MS);
  const { rows } = await db.query<UnthemedRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (d.job_id) d.decision_id, d.decided_at, d.summary, d.source_names, c.contact_kind,
            ${APPROVED_SQL} AS approved
       FROM contact_reply_decisions d
       LEFT JOIN contact_conversations c
         ON c.business_id = d.business_id AND c.conversation_id = d.conversation_id
      WHERE d.business_id = $1 AND d.topic_id IS NULL AND d.summary IS NOT NULL
        AND d.decided_at > $2
      ORDER BY d.job_id, d.decided_at, d.decision_id) per_job
      ORDER BY decided_at DESC, decision_id DESC
      LIMIT $3`,
    [db.businessId, since, limit],
  );
  return rows.map((r) => ({
    decisionId: r.decision_id,
    decidedAt: r.decided_at,
    summary: r.summary,
    sourceNames: r.source_names ?? [],
    approved: r.approved,
    contactKind: r.contact_kind === 'client' || r.contact_kind === 'supplier' ? r.contact_kind : 'unknown',
  }));
}
