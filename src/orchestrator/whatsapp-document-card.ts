/**
 * A document card, answered over WhatsApp (document production §8.3, C9).
 *
 * **An authority-granting path, so every condition is positive — the mail
 * card's rules, applied to a second kind of card.** A message reaches
 * `handleDocumentCardMessage` only from the door, only after
 * `isPrincipalSender` said the sender IS the owner, only as TYPED text
 * (`mediaKind === null`: a transcript or a caption is a model's output, not
 * his keystrokes), and only while at least one document card is open:
 *
 *   - the card is actionable (`open`, or `failed_send` returned after a
 *     failed delivery) and its version is not superseded;
 *   - the card was DELIVERED to WhatsApp (`whatsapp_delivered_at`, stamped
 *     only after a `sendFile` that came back ok and only for a card short
 *     enough to answer there) — a card the bridge never carried is answered
 *     on the dashboard only;
 *   - the owner's message was sent (provider timestamp) strictly AFTER that
 *     delivery: a "שלחי" typed for an earlier card and delivered late does
 *     not approve this one. An unreadable timestamp is never "after";
 *   - the delivery is inside `WHATSAPP_QUESTION_WINDOW_MINUTES`.
 *
 * **Document cards and mail-reply cards are counted together (C9).** "שלחי"
 * is the word both kinds answer to, and it does not say which: with more
 * than one card of either kind open, the answer is `SEVERAL_OPEN_REFUSAL`
 * and nothing is approved. The same count gates "תיקון:".
 *
 * **"שלחי" approves one option, and only an unambiguous one.** A card that
 * offers several options (send AND save) cannot be answered by one word —
 * "יש כמה אפשרויות — אשרי בדשבורד". A lone option is approved only when it
 * is what the card was made for: a `ready` card whose one option is the send
 * it was asked to make, or the save it was asked to make. A version that did
 * not pass the checks, or a send request left with only a save option (no
 * authorised recipient), is the dashboard's. The approval itself is
 * `approveDocumentCard` — the dashboard's own call, with `actor: 'whatsapp'`.
 *
 * **"תיקון: <text>"** is `requestFix` with `textOrigin: 'typed'`.
 *
 * The message is claimed (`claimMessage`) before anything is decided, so a
 * redelivered or raced copy cannot approve twice.
 */
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import type { NormalizedInboundMessage } from '../whatsapp/gateway.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { claimMessage, settleMessage } from '../whatsapp/store.js';
import { approveDocumentCard, loadDocumentCard, requestFix, type DocumentCard } from '../production/card.js';
import { loadProduction, loadVersion } from '../production/store.js';
import type { Runtime } from './runtime.js';
import { isApproveWord } from './whatsapp-mail-card.js';

/**
 * Spec §10.11 of the boss command, verbatim: more than one thing is open, and
 * the answer cannot say which. Defined here and re-exported by the door
 * (`whatsapp-door.ts`), which imports this module — one sentence, one owner.
 */
export const SEVERAL_OPEN_REFUSAL = 'יש כמה שאלות פתוחות — עני בדשבורד';
export const DOCUMENT_CARD_SEVERAL_OPTIONS = 'יש כמה אפשרויות — אשרי בדשבורד';
export const DOCUMENT_CARD_DASHBOARD_ONLY = 'את הכרטיס הזה אפשר לאשר רק בדשבורד.';
export const DOCUMENT_CARD_GONE = 'הכרטיס הזה כבר הוכרע או שהשתנה — לא שיניתי דבר.';
export const DOCUMENT_CARD_FIX_OPENED = 'קיבלתי. אני מכינה גרסה מתוקנת, וכרטיס חדש יגיע אלייך.';
export const DOCUMENT_CARD_SAVED = 'אישרתי. המסמך יישמר בתיקייה.';

export function documentCardSent(to: readonly string[]): string {
  return `אישרתי. המסמך יוצא ל-${to.map(toOneLine).join(', ')}.`;
}

/** "תיקון:" or "תיקון :" at the start, after bidi stripping and trim. */
const FIX_PREFIX = /^תיקון ?:/;

/** The fix text a message carries, or `null` when it is not a fix request. `''` = the prefix alone. */
export function fixRequestText(text: string): string | null {
  const clean = stripBidiControls(text).trim();
  const match = FIX_PREFIX.exec(clean);
  return match === null ? null : clean.slice(match[0].length).trim();
}

/** Whether a typed message is a document-card action at all — read before anything is claimed. */
export function isDocumentCardAction(text: string): boolean {
  return isApproveWord(text) || fixRequestText(text) !== null;
}

/**
 * The document cards open on WhatsApp for a message sent at `inboundAt` —
 * see the module docblock for the conditions. Read-only. `windowMinutes <= 0`
 * means none is ever open.
 */
export async function openDocumentCards(input: {
  businessId?: string;
  inboundAt: string;
  now?: number;
  windowMinutes?: number;
  db?: Queryable;
}): Promise<DocumentCard[]> {
  const businessId = input.businessId ?? config.businessId;
  const windowMinutes = input.windowMinutes ?? config.whatsappQuestionWindowMinutes;
  if (windowMinutes <= 0) return [];
  const inboundMs = Date.parse(input.inboundAt);
  if (Number.isNaN(inboundMs)) return [];
  const nowMs = input.now ?? Date.now();
  const db = input.db ?? getPool();

  const { rows } = await db.query<{ card_id: string; delivered_at: Date }>(
    `SELECT c.card_id, c.whatsapp_delivered_at AS delivered_at
       FROM document_cards c
       JOIN document_versions v ON v.version_id = c.version_id
      WHERE c.business_id = $1
        AND c.state IN ('open', 'failed_send')
        AND c.whatsapp_delivered_at IS NOT NULL
        AND v.superseded_at IS NULL
      ORDER BY c.whatsapp_delivered_at, c.card_id`,
    [businessId],
  );
  const open: DocumentCard[] = [];
  for (const row of rows) {
    const deliveredMs = row.delivered_at.getTime();
    if (Number.isNaN(deliveredMs) || nowMs - deliveredMs > windowMinutes * 60_000) continue;
    // Strictly after, with no tolerance in the permissive direction.
    if (!(inboundMs > deliveredMs)) continue;
    const card = await loadDocumentCard(businessId, row.card_id, db);
    if (card !== null) open.push(card);
  }
  return open;
}

export type DocumentCardOutcome = 'decided' | 'fix' | 'refused' | 'skipped' | 'passthrough';

/**
 * The owner's typed "שלחי"/"שלח" or "תיקון: …" while at least one document
 * card is open. `mailCardsOpen` is how many mailbox reply cards are open for
 * the same message (`openMailCards`) — counted together with `cards` (C9).
 */
export async function handleDocumentCardMessage(input: {
  msg: NormalizedInboundMessage;
  storedId: string;
  cards: readonly DocumentCard[];
  mailCardsOpen: number;
  messenger: BossMessenger;
  businessId: string;
  production: Runtime['production'] | undefined;
}): Promise<DocumentCardOutcome> {
  const { msg, storedId, cards, messenger, businessId } = input;
  if (msg.mediaKind !== null || msg.body === null) return 'passthrough';
  const text = msg.body;
  if (!isDocumentCardAction(text) || cards.length === 0) return 'passthrough';

  const claimed = await claimMessage(storedId, { businessId });
  if (!claimed) return 'skipped';

  const reply = async (replyText: string, state: 'handled' | 'failed', jobId: string | null = null): Promise<void> => {
    await messenger.send({ text: replyText, jobId });
    await settleMessage(storedId, state, jobId !== null ? { jobId } : {}, { businessId });
  };
  const refuse = async (replyText: string): Promise<'refused'> => {
    await reply(replyText, 'failed');
    return 'refused';
  };

  const only = cards.length === 1 && input.mailCardsOpen === 0 ? cards[0] : undefined;
  if (only === undefined) return refuse(SEVERAL_OPEN_REFUSAL);

  const fix = fixRequestText(text);
  if (fix !== null) {
    const outcome = await requestFix(only.cardId, fix, 'whatsapp', 'typed', {
      businessId,
      production: input.production,
    });
    if (outcome.status === 'opened') {
      await reply(DOCUMENT_CARD_FIX_OPENED, 'handled', outcome.jobId);
      return 'fix';
    }
    return refuse(outcome.status === 'refused' ? outcome.reason : DOCUMENT_CARD_GONE);
  }

  // "שלחי": one option, and the one the card was made for.
  if (only.deliveryPlans.length !== 1) return refuse(DOCUMENT_CARD_SEVERAL_OPTIONS);
  const option = only.deliveryPlans[0]!;
  const version = await loadVersion(businessId, only.versionId);
  const production = version === null ? null : await loadProduction(businessId, version.productionId);
  if (production === null) return refuse(DOCUMENT_CARD_GONE);
  if (production.stage !== 'ready' || option.option !== production.destination.mode) {
    return refuse(DOCUMENT_CARD_DASHBOARD_ONLY);
  }

  const outcome = await approveDocumentCard(only.cardId, option.planHash, 'whatsapp', { businessId });
  if (outcome.status !== 'approved') return refuse(DOCUMENT_CARD_GONE);
  await reply(
    production.destination.mode === 'send' ? documentCardSent(production.destination.to) : DOCUMENT_CARD_SAVED,
    'handled',
    outcome.jobId,
  );
  return 'decided';
}
