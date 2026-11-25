/**
 * Learned suggestions on the owner's WhatsApp: delivery (one at a time) and
 * the reader for "כן" / "לא".
 *
 * A suggestion is an authority-bearing question — "yes" creates a topic, turns
 * auto-reply on, or marks a document public — so the reader is held to the
 * boss-command rules: typed text only, a message sent strictly after the
 * suggestion was delivered and inside the window (`deliveredOpenSuggestions`),
 * the message claimed before anything is decided, and anything else open on
 * WhatsApp (`openOnWhatsApp`, where suggestions are the sixth kind) refuses
 * with `SEVERAL_OPEN_REFUSAL` — "כן" does not say which.
 *
 * The decision itself is `applySuggestion`, the one executor.
 */
import type { BusinessDb } from '../db/pool.js';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import { capFor, loadRuntimeSettings } from '../tenancy/runtime-settings.js';
import { SEVERAL_OPEN_REFUSAL } from '../orchestrator/whatsapp-document-card.js';
import { loadTopic } from './contact-topics.js';
import {
  listOpenSuggestions,
  markSuggestionDelivered,
  type Suggestion,
} from './contact-suggestions.js';
import type { NormalizedInboundMessage } from './gateway.js';
import type { BossMessenger } from './messenger.js';
import { claimMessage, settleMessage } from './store.js';
import { applySuggestion, expireSuggestion, suggestionIsStale, type ApplyOutcome } from './suggestion-apply.js';

export const SUGGESTION_QUESTION_TAIL = 'לאשר? השיבי כן או לא';
export const SUGGESTION_APPLIED = 'אושר — עדכנתי.';
export const SUGGESTION_REJECTED = 'בסדר, לא אציע את זה שוב.';
export const SUGGESTION_STALE = 'ההצעה כבר אינה רלוונטית';
export const SUGGESTION_ALREADY = 'כבר טופל.';
export const SUGGESTION_FAILED = 'לא הצלחתי לבצע — נסי שוב בדשבורד.';

const APPLIES_HE: Record<string, string> = { client: 'לקוחות', supplier: 'ספקים', both: 'לקוחות וספקים' };

/** One line of owner-facing text from anything the model or a sender may have written. */
function safe(value: unknown): string {
  return toOneLine(stripBidiControls(String(value ?? '')));
}

function appliesHe(value: unknown): string {
  return APPLIES_HE[String(value)] ?? 'לקוחות וספקים';
}

/** Labels looked up by the caller: a topic or a document is named, never shown by id. */
export interface SuggestionLabels {
  topicName?: string;
  documentName?: string;
}

/** The WhatsApp question for one suggestion. Every field is one bidi-free line. */
export function SUGGESTION_TEXT(s: Suggestion, labels: SuggestionLabels): string {
  const lines: string[] = [];
  switch (s.kind) {
    case 'new_topic': {
      lines.push(`הצעה: נושא חדש לשיחות עם ${appliesHe(s.payload.appliesTo)} — "${safe(s.payload.name)}".`);
      const description = safe(s.payload.description);
      if (description !== '') lines.push(description);
      lines.push(`מבוסס על ${Array.isArray(s.payload.decisionIds) ? s.payload.decisionIds.length : 0} תשובות שאישרת.`);
      lines.push('הנושא ייפתח בלי מענה אוטומטי.');
      break;
    }
    case 'auto_reply':
      lines.push(`הצעה: שהעוזרת תענה לבד בנושא "${safe(labels.topicName ?? '')}".`);
      lines.push(`הסכמת עם ${Number(s.payload.right)} מתוך ${Number(s.payload.counted)} ההצעות האחרונות בנושא הזה.`);
      break;
    case 'public_document':
      lines.push(`הצעה: לסמן את המסמך "${safe(labels.documentName ?? '')}" כמותר לציטוט ל${appliesHe(s.payload.appliesTo)}.`);
      lines.push(`נשענתי עליו ב-${Number(s.payload.approvals)} תשובות שאישרת.`);
      break;
  }
  lines.push(SUGGESTION_QUESTION_TAIL);
  return lines.join('\n');
}

/** Exactly "כן" or "לא" after bidi stripping, trimming and trailing punctuation; anything else `null`. */
export function isSuggestionAnswer(text: string): 'yes' | 'no' | null {
  const word = stripBidiControls(text).trim().replace(/[)'"»,.;:!?…]+$/, '');
  if (word === 'כן') return 'yes';
  if (word === 'לא') return 'no';
  return null;
}

export async function labelsFor(db: BusinessDb, s: Suggestion): Promise<SuggestionLabels> {
  if (s.kind === 'auto_reply') {
    const topic = await loadTopic(db, s.payload.topicId);
    return topic !== null ? { topicName: topic.name } : {};
  }
  if (s.kind === 'public_document') {
    const { rows } = await db.query<{ original_name: string }>(
      `SELECT original_name FROM documents WHERE business_id = $1 AND document_id = $2`,
      [db.businessId, s.payload.documentId],
    );
    return rows[0] !== undefined ? { documentName: rows[0].original_name } : {};
  }
  return {};
}

const DELIVERY_ACTOR = 'system:suggestion-delivery';

/**
 * Sends the oldest undelivered open suggestion — only when no open suggestion
 * is already delivered and still inside its window, so the owner is never
 * asked two at once. A suggestion that went stale before it was sent is
 * expired, not sent, and the next one is tried. `delivered_at` is stamped only
 * after the send came back `ok`. Returns whether one was sent.
 */
export async function deliverNextSuggestion(
  db: BusinessDb,
  deps: { messenger: BossMessenger; now: Date; windowMinutes?: number },
): Promise<boolean> {
  const windowMinutes =
    deps.windowMinutes ?? capFor(await loadRuntimeSettings(db), 'whatsappQuestionWindowMinutes');
  if (windowMinutes <= 0) return false;
  const cutoff = deps.now.getTime() - windowMinutes * 60_000;

  const open = await listOpenSuggestions(db);
  if (open.some((s) => s.deliveredAt !== null && s.deliveredAt.getTime() > cutoff)) return false;

  for (const s of open) {
    if (s.deliveredAt !== null) continue;
    if (await suggestionIsStale(db, s)) {
      await expireSuggestion(db, s, DELIVERY_ACTOR);
      continue;
    }
    const text = SUGGESTION_TEXT(s, await labelsFor(db, s));
    const sent = await deps.messenger.send({ text, jobId: null });
    if (!sent.ok) return false;
    await markSuggestionDelivered(db, s.suggestionId, deps.now);
    return true;
  }
  return false;
}

const REPLY: Record<ApplyOutcome, string> = {
  applied: SUGGESTION_APPLIED,
  rejected: SUGGESTION_REJECTED,
  stale: SUGGESTION_STALE,
  already: SUGGESTION_ALREADY,
};

export type SuggestionAnswerOutcome = 'decided' | 'refused' | 'passthrough' | 'skipped';

/**
 * The owner's typed "כן"/"לא" with at least one suggestion open on WhatsApp.
 * `suggestions` and `othersOpen` come from `openOnWhatsApp` for this message.
 * Passthrough (nothing claimed) unless the message is typed, reads as an
 * answer and a suggestion is open; then the message is claimed first, and
 * more than one suggestion or anything else open refuses with
 * `SEVERAL_OPEN_REFUSAL` — nothing applied.
 */
export async function handleSuggestionMessage(db: BusinessDb, input: {
  msg: NormalizedInboundMessage;
  storedId: string;
  suggestions: Suggestion[];
  othersOpen: number;
  messenger: BossMessenger;
  by: string;
}): Promise<SuggestionAnswerOutcome> {
  const { msg, storedId, suggestions } = input;
  if (msg.mediaKind !== null || msg.body === null) return 'passthrough';
  const answer = isSuggestionAnswer(msg.body);
  if (answer === null || suggestions.length === 0) return 'passthrough';

  if (!(await claimMessage(db, storedId))) return 'skipped';

  const reply = async (text: string, state: 'handled' | 'failed'): Promise<void> => {
    await input.messenger.send({ text, jobId: null });
    await settleMessage(db, storedId, state, {});
  };

  const only = suggestions.length === 1 ? suggestions[0] : undefined;
  if (only === undefined || input.othersOpen > 0) {
    await reply(SEVERAL_OPEN_REFUSAL, 'failed');
    return 'refused';
  }

  let outcome: ApplyOutcome;
  try {
    outcome = await applySuggestion(db, only.suggestionId, answer === 'yes' ? 'accept' : 'reject', input.by);
  } catch {
    await reply(SUGGESTION_FAILED, 'failed');
    return 'refused';
  }
  const decided = outcome === 'applied' || outcome === 'rejected';
  await reply(REPLY[outcome], decided ? 'handled' : 'failed');
  return decided ? 'decided' : 'refused';
}
