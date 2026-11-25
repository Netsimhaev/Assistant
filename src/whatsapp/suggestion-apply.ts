/**
 * The ONLY executor of a learned suggestion. Both the WhatsApp reader and the
 * dashboard call `applySuggestion`; nothing else turns a suggestion into a
 * topic, an auto-reply switch or a public document.
 *
 * Every accept re-checks the world at decision time — the topic may have been
 * retired, the document removed or re-sourced since the suggestion was made —
 * and a suggestion that no longer fits is expired, never applied. The claim
 * (`decideSuggestion('accepted')`) and the effect run in ONE transaction: an
 * effect that throws rolls the claim back and the suggestion stays open.
 *
 * Accepting grants nothing beyond what the owner's own screens already can:
 * a new topic always starts with auto-reply OFF (H7), whatever the payload
 * says.
 */
import { appendAudit } from '../audit/log.js';
import { transaction, type BusinessDb } from '../db/pool.js';
import { canonicalHash } from '../util/canonical.js';
import { createTopic, listTopics, loadTopic, setTopicAutoReply } from './contact-topics.js';
import {
  decideSuggestion,
  loadSuggestion,
  normaliseName,
  type Suggestion,
} from './contact-suggestions.js';
import { setPublicFor } from './public-documents.js';

export type ApplyOutcome = 'applied' | 'rejected' | 'stale' | 'already';

async function auditDecision(
  db: BusinessDb,
  s: Suggestion,
  state: 'accepted' | 'rejected' | 'expired',
  by: string,
): Promise<void> {
  await appendAudit(db, {
    actor: 'human',
    onBehalfOf: by,
    kind: 'tool_call',
    charterVersion: 'n/a',
    provenance: 'boss',
    inputHash: canonicalHash({ suggestionId: s.suggestionId }),
    reason: `contact_suggestion:${s.kind}:${state}`,
  });
}

interface DocStateRow {
  source: string;
  status: string;
  public_for: string | null;
}

/** True when the suggestion no longer fits the world it was made for. Positive checks only. */
export async function suggestionIsStale(db: BusinessDb, s: Suggestion): Promise<boolean> {
  switch (s.kind) {
    case 'new_topic': {
      const name = normaliseName(String(s.payload.name ?? ''));
      if (name === '') return true;
      const live = await listTopics(db);
      return live.some((t) => normaliseName(t.name) === name);
    }
    case 'auto_reply': {
      const topic = await loadTopic(db, String(s.payload.topicId ?? ''));
      return !(topic !== null && topic.retiredAt === null && topic.autoReply === false);
    }
    case 'public_document': {
      const { rows } = await db.query<DocStateRow>(
        `SELECT source, status, public_for FROM documents WHERE business_id = $1 AND document_id = $2`,
        [db.businessId, String(s.payload.documentId ?? '')],
      );
      const doc = rows[0];
      return !(doc !== undefined && doc.source === 'instruction' && doc.status === 'extracted' && doc.public_for === null);
    }
  }
}

/** Moves an open suggestion to `expired` and audits it. False when someone else decided first. */
export async function expireSuggestion(db: BusinessDb, s: Suggestion, by: string): Promise<boolean> {
  return transaction(db, async (tx) => {
    if (!(await decideSuggestion(tx, s.suggestionId, 'expired', by))) return false;
    await auditDecision(tx, s, 'expired', by);
    return true;
  });
}

async function applyEffect(db: BusinessDb, s: Suggestion, by: string): Promise<void> {
  switch (s.kind) {
    case 'new_topic':
      await createTopic(db, {
        name: s.payload.name,
        description: s.payload.description,
        appliesTo: s.payload.appliesTo,
        sources: s.payload.sources,
        // H7: a topic enters empty of authority; auto-reply is a separate "yes".
        autoReply: false,
        by,
      });
      return;
    case 'auto_reply':
      if (!(await setTopicAutoReply(db, s.payload.topicId, true, by))) {
        throw new Error('auto-reply suggestion: topic changed under the claim');
      }
      return;
    case 'public_document':
      if (!(await setPublicFor(db, s.payload.documentId, s.payload.appliesTo, by))) {
        throw new Error('public-document suggestion: document vanished under the claim');
      }
      return;
  }
}

export async function applySuggestion(
  db: BusinessDb,
  suggestionId: string,
  decision: 'accept' | 'reject',
  by: string,
): Promise<ApplyOutcome> {
  return transaction(db, async (tx) => {
    // Row lock first: two answers racing (WhatsApp and the dashboard) serialise here.
    const { rows } = await tx.query<{ state: string }>(
      `SELECT state FROM contact_suggestions WHERE business_id = $1 AND suggestion_id = $2 FOR UPDATE`,
      [tx.businessId, suggestionId],
    );
    const locked = rows[0];
    if (locked === undefined) return 'stale';
    if (locked.state !== 'open') return 'already';
    const s = await loadSuggestion(tx, suggestionId);
    if (s === null) return 'stale';

    if (decision === 'reject') {
      if (!(await decideSuggestion(tx, suggestionId, 'rejected', by))) return 'already';
      await auditDecision(tx, s, 'rejected', by);
      return 'rejected';
    }

    if (await suggestionIsStale(tx, s)) {
      if (!(await decideSuggestion(tx, suggestionId, 'expired', by))) return 'already';
      await auditDecision(tx, s, 'expired', by);
      return 'stale';
    }

    // Claim, then the effect — one transaction, so a failing effect un-claims.
    if (!(await decideSuggestion(tx, suggestionId, 'accepted', by))) return 'already';
    await applyEffect(tx, s, by);
    await auditDecision(tx, s, 'accepted', by);
    return 'applied';
  });
}
