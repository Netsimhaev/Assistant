/**
 * A mailbox reply card, over WhatsApp: presenting it, and reading the owner's
 * next message as an answer to it (mailbox spec §5.2 item 7).
 *
 * **This is an authority-granting path, so every condition is positive.**
 * A message reaches `handleMailCardMessage` only from the door, only after
 * `isPrincipalSender` said the sender IS the one authority number, and only
 * while a card is open (below). Inside, exactly one string approves — the
 * word "שלח" (or "שלחי") alone, after `stripBidiControls` and `trim` —
 * and only when exactly one card is open. Nothing else decides anything.
 *
 * **Only three shapes of TYPED text are mail-card actions; everything else
 * passes to the ordinary door and the card stays open (fix round 1 ruling).**
 * "שלח"/"שלחי" approves; a closure word closes the window; and a message that
 * starts with "נוסח:" (or "נוסח :") is a replacement body. Any other text — a
 * new instruction, an answer to an instruction question — is not read as
 * anything here. A voice note never reaches this module at all: a transcript
 * is a provider's model output over audio, not the owner's keystrokes (the
 * same reason `textOrigin: 'transcribed'` withholds the typed-recipient arm
 * in `typed-recipients.ts`), so it goes to the ordinary door, which cannot
 * approve a card either. Image or document captions go there too.
 *
 * **A message older than the card never answers it.** The owner's message
 * must have been sent (provider timestamp) strictly AFTER the card was
 * presented. A "שלח" typed for card A and delivered late, after card B went
 * up, would otherwise approve B — a card he had not seen when he typed it.
 * An unreadable timestamp is never "after".
 *
 * **A replacement is an edit of `body` and nothing else.** The new payload is
 * the proposal with `body` swapped, and `mailReplyEditAllowed` — the same rule
 * the dashboard's decide route enforces — must agree before anything moves.
 * It is staged as `edited_input` on a NEW pending card (the old one is
 * cancelled in the same transaction), re-presented, and needs a second
 * "שלח": a decided card can never be edited later, and the owner must see the
 * text before it can go out.
 *
 * **What is open is DERIVED, never stored a second time** — the same rule
 * `pendingQuestions` keeps (`whatsapp-routing.ts`). A card is open on
 * WhatsApp when ALL of these hold:
 *
 *   - its approval is `pending`, unexpired and unspent, for `mail.send`;
 *   - its job is a mailbox reply job (`mail_messages.reply_job_id`, the
 *     positive marker the dashboard keys on) parked in `await_approval`;
 *   - this code presented it: an outbound WhatsApp row for that job, sent
 *     successfully, at or after the card was raised, ending with
 *     `MAIL_CARD_INSTRUCTION`. The latest such row is the presentation;
 *   - the presentation is inside `WHATSAPP_QUESTION_WINDOW_MINUTES`;
 *   - no later message from the owner was a closure word. Closure needs no
 *     write of its own: the inbound row that carried it is the record, and
 *     re-reading it here is what makes "סגרנו" close every open card at once
 *     without a column to keep in step.
 *
 * A card the WhatsApp send failed for, a card raised with no bridge, a card
 * past its window — none of them is open, and the owner's message goes to
 * the ordinary instruction door. The dashboard is always the other exit.
 */
import { config } from '../config.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import {
  ApprovalNotDecidableError,
  cancelPendingApproval,
  decide,
  enqueueApproval,
  getApproval,
  stagePendingEdit,
  type ApprovalRequest,
} from '../governance/approvals.js';
import { isClosureCommand } from '../governance/closure-command.js';
import { authorityNumberKey } from '../governance/principal-number.js';
import { mailReplyEditAllowed, mailboxReplyRecipient, splitReplyDetail } from '../mail/reply-card.js';
import { MAIL_CARD_INSTRUCTION, renderMailCardWhatsApp } from '../mail/whatsapp-notice.js';
import { buildFacts } from '../policy/facts.js';
import { stripBidiControls } from '../util/bidi.js';
import type { NormalizedInboundMessage } from '../whatsapp/gateway.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { claimMessage, settleMessage } from '../whatsapp/store.js';
import { resumeAfterDecision } from './resume.js';

// --- What the owner reads. Hebrew, every one of them. -----------------------

/** Verbatim from the brief: two open cards, and "שלח" cannot say which. */
export const MULTIPLE_MAIL_CARDS_REFUSAL = 'יש כמה טיוטות פתוחות — אשרי בדשבורד.';

/** Said for "נוסח:" with nothing (or only direction marks) after it. */
export const EMPTY_REPLACEMENT = 'לא קיבלתי נוסח חדש. כתוב "נוסח:" ואחריו את הנוסח המלא.';

/** Says only the mail draft was closed — open instruction questions are untouched. */
export const MAIL_CARD_CLOSED =
  'סגרתי רק את טיוטת המייל בוואטסאפ. היא לא נשלחה, והיא מחכה לך בדשבורד.';

/**
 * The decision is recorded but moving the job on failed. Said instead of the
 * generic error, so the owner does not send "שלח" again at a decided card.
 */
export const DECIDED_RESUME_FAILED =
  'רשמתי את האישור, אבל לא הצלחתי להתחיל את השליחה. כדאי לבדוק את הבקשה בדשבורד.';

export const MAIL_CARD_GONE = 'הטיוטה הזו כבר הוכרעה או שפג תוקפה — לא שיניתי דבר.';

export const REPLACEMENT_LEAD = 'עדכנתי את הטיוטה. זה הנוסח שיישלח רק אחרי שתשיב "שלח":';

export function mailCardApproved(recipient: string): string {
  return `אישרתי. התשובה יוצאת ל-${stripBidiControls(recipient).trim()}.`;
}

/**
 * The only words that approve, compared after `stripBidiControls` and `trim`.
 * Exported so the boss-command confirm reader's disjointness test
 * (`command-confirm.test.ts`) intersects this list rather than a re-typed copy.
 */
export const MAIL_CARD_APPROVE_WORDS: readonly string[] = ['שלח', 'שלחי'];
const APPROVE_WORDS: ReadonlySet<string> = new Set(MAIL_CARD_APPROVE_WORDS);

export function isApproveWord(text: string): boolean {
  return APPROVE_WORDS.has(stripBidiControls(text).trim());
}

/** "נוסח:" or "נוסח :" at the start, after bidi stripping and trim. */
const REPLACEMENT_PREFIX = /^נוסח ?:/;

/**
 * The replacement body a message carries, or `null` when it is not a
 * replacement at all. An empty string means the prefix was there and nothing
 * after it — a refusal, never an empty body.
 */
export function replacementBody(text: string): string | null {
  const clean = stripBidiControls(text).trim();
  const match = REPLACEMENT_PREFIX.exec(clean);
  if (match === null) return null;
  return clean.slice(match[0].length).trim();
}

// --- Presenting ---------------------------------------------------------------

/**
 * Send a reply card to the owner over WhatsApp, recorded against the reply
 * job — that outbound row IS the presentation `openMailCards` looks for.
 *
 * The body shown is the staged edit when there is one, else the proposal: the
 * bytes a "שלח" would approve. Returns `false` when the approval is not a
 * pending mailbox-reply card with a job, and sends nothing then. `send`
 * throwing is left to the caller — the card is on the dashboard either way.
 */
export async function presentMailCard(
  approvalId: string,
  send: (text: string, jobId: string | null) => Promise<void>,
  options: { businessId?: string; lead?: string } = {},
): Promise<boolean> {
  const businessId = options.businessId ?? config.businessId;
  const approval = await getApproval(approvalId, { businessId });
  if (approval === null || approval.jobId === null || approval.state !== 'pending') return false;
  if (mailboxReplyRecipient(approval.proposedInput) === null) return false;
  const payload = approval.editedInput ?? approval.proposedInput;
  const card = renderMailCardWhatsApp(approval, payload);
  await send(options.lead !== undefined ? `${options.lead}\n\n${card}` : card, approval.jobId);
  return true;
}

// --- What is open -------------------------------------------------------------

export interface OpenMailCard {
  approval: ApprovalRequest;
  presentedAt: Date;
}

interface OpenRow {
  approval_id: string;
  presented_at: Date;
  later_texts: string[];
}

/**
 * The reply cards open on WhatsApp right now — see the module docblock for
 * the five conditions. Read-only.
 *
 * `excludeMessageId` is the inbound message being routed: it is already
 * recorded by the time this runs, and must not count as a later closure of
 * the very card it is answering.
 *
 * The window is measured in the app's clock against the database's timestamp,
 * the same trade `withinQuestionWindow` documents: nothing here authorises by
 * the window alone — `decide` still checks the card's own `expires_at` in SQL.
 * `windowMinutes <= 0` means no card is ever open.
 */
export async function openMailCards(input: {
  businessId?: string;
  excludeMessageId: string;
  /**
   * When the message being routed was sent (its provider timestamp). Only a
   * card presented strictly before this moment is open for it; unreadable
   * means no card is open.
   */
  inboundAt: string;
  now?: number;
  windowMinutes?: number;
  db?: Queryable;
}): Promise<OpenMailCard[]> {
  const businessId = input.businessId ?? config.businessId;
  const windowMinutes = input.windowMinutes ?? config.whatsappQuestionWindowMinutes;
  if (windowMinutes <= 0) return [];
  const nowMs = input.now ?? Date.now();
  const inboundMs = Date.parse(input.inboundAt);
  if (Number.isNaN(inboundMs)) return [];
  const db = input.db ?? getPool();

  const { rows } = await db.query<OpenRow>(
    `SELECT a.approval_id, p.presented_at,
            ARRAY(
              SELECT coalesce(w.transcript, w.body, '')
                FROM whatsapp_messages w
               WHERE w.business_id = a.business_id
                 AND w.direction = 'inbound'
                 AND w.sender_kind = 'principal'
                 AND w.created_at > p.presented_at
                 AND w.id <> $3
            ) AS later_texts
       FROM approval_requests a
       JOIN jobs j
         ON j.business_id = a.business_id AND j.job_id = a.job_id AND j.phase = 'await_approval'
       JOIN LATERAL (
         SELECT w.created_at AS presented_at
           FROM whatsapp_messages w
          WHERE w.business_id = a.business_id
            AND w.direction = 'outbound'
            AND w.job_id = a.job_id
            AND w.state = 'handled'
            AND w.created_at >= a.created_at
            AND right(w.body, char_length($2)) = $2
          ORDER BY w.created_at DESC
          LIMIT 1
       ) p ON true
      WHERE a.business_id = $1
        AND a.state = 'pending'
        AND a.expires_at > now()
        AND a.consumed_at IS NULL
        AND a.proposed_tool = 'mail.send'
        AND EXISTS (
          SELECT 1 FROM mail_messages m
           WHERE m.business_id = a.business_id AND m.reply_job_id = a.job_id
        )
      ORDER BY p.presented_at`,
    [businessId, MAIL_CARD_INSTRUCTION, input.excludeMessageId],
  );

  const open: OpenMailCard[] = [];
  for (const row of rows) {
    const presentedMs = row.presented_at.getTime();
    if (Number.isNaN(presentedMs) || nowMs - presentedMs > windowMinutes * 60_000) continue;
    // Strictly after, with no tolerance in the permissive direction: a reply
    // the provider dates at or before the presentation is not read as an
    // answer to it — it goes to the ordinary door instead.
    if (!(inboundMs > presentedMs)) continue;
    if (row.later_texts.some((text) => isClosureCommand(text))) continue;
    const approval = await getApproval(row.approval_id, { businessId });
    if (approval === null || mailboxReplyRecipient(approval.proposedInput) === null) continue;
    open.push({ approval, presentedAt: row.presented_at });
  }
  return open;
}

// --- Reading the owner's message ----------------------------------------------

export type MailCardOutcome =
  | 'decided'
  | 'replaced'
  | 'closed'
  | 'refused'
  | 'skipped'
  | 'passthrough';

/**
 * Whether a typed message is one of the three mail-card actions. Read before
 * anything is claimed, so a message that is not one is left untouched for
 * the ordinary door.
 */
export function isMailCardAction(text: string): boolean {
  return isApproveWord(text) || isClosureCommand(text) || replacementBody(text) !== null;
}

/**
 * The owner's TYPED message while at least one card is open. The caller has
 * already established that the sender is the principal and that `cards` is
 * non-empty.
 *
 * Returns `'passthrough'` — without claiming or settling anything — for a
 * message that is not text or not a mail-card action; the caller hands it to
 * the ordinary door. Otherwise the message is claimed first, before anything
 * is decided, so a redelivered or raced copy of the same "שלח" cannot decide
 * twice.
 */
export async function handleMailCardMessage(input: {
  msg: NormalizedInboundMessage;
  storedId: string;
  cards: readonly OpenMailCard[];
  messenger: BossMessenger;
  businessId: string;
}): Promise<MailCardOutcome> {
  const { msg, storedId, cards, messenger, businessId } = input;
  if (msg.mediaKind !== null) return 'passthrough';
  const text = msg.body ?? '';
  if (!isMailCardAction(text)) return 'passthrough';

  const claimed = await claimMessage(storedId, { businessId });
  if (!claimed) return 'skipped';

  const refuse = async (reply: string): Promise<'refused'> => {
    await messenger.send({ text: reply, jobId: null });
    await settleMessage(storedId, 'failed', {}, { businessId });
    return 'refused';
  };

  const by = `whatsapp:${authorityNumberKey(msg.senderNumber) ?? msg.senderNumber}`;

  if (isApproveWord(text)) {
    const only = cards.length === 1 ? cards[0] : undefined;
    if (only === undefined) return refuse(MULTIPLE_MAIL_CARDS_REFUSAL);
    return approveCard(only.approval, { by, storedId, messenger, businessId, refuse });
  }

  if (isClosureCommand(text)) {
    // Nothing to write: this inbound row is the record `openMailCards` reads.
    await messenger.send({ text: MAIL_CARD_CLOSED, jobId: null });
    await settleMessage(storedId, 'handled', {}, { businessId });
    return 'closed';
  }

  const newBody = replacementBody(text) ?? '';
  if (newBody === '') return refuse(EMPTY_REPLACEMENT);
  const only = cards.length === 1 ? cards[0] : undefined;
  if (only === undefined) return refuse(MULTIPLE_MAIL_CARDS_REFUSAL);
  return replaceBody(only.approval, newBody, { storedId, messenger, businessId, refuse });
}

interface StepContext {
  storedId: string;
  messenger: BossMessenger;
  businessId: string;
  refuse: (text: string) => Promise<'refused'>;
}

/**
 * The same two calls the dashboard makes — `decide`, then
 * `resumeAfterDecision` — with `channel: 'whatsapp'` and the principal's
 * number as `by`. A staged replacement is passed as `editedInput`, checked
 * once more against the proposal first, so `decide` labels the row
 * `approved_with_edit` and binds it to exactly the bytes the owner saw.
 */
async function approveCard(
  card: ApprovalRequest,
  ctx: StepContext & { by: string },
): Promise<MailCardOutcome> {
  const staged = card.editedInput ?? undefined;
  if (staged !== undefined && !mailReplyEditAllowed(card.proposedInput, staged)) {
    return ctx.refuse(MAIL_CARD_GONE);
  }

  let decided: ApprovalRequest;
  try {
    decided = await decide(
      card.approvalId,
      'approved',
      { by: ctx.by, channel: 'whatsapp', ...(staged !== undefined ? { editedInput: staged } : {}) },
      { businessId: ctx.businessId },
    );
  } catch (error) {
    if (error instanceof ApprovalNotDecidableError) return ctx.refuse(MAIL_CARD_GONE);
    throw error;
  }
  // After `decide` has committed, exactly as the dashboard runs it:
  // `transition` opens its own transaction. The decision is permanent by
  // now, so a failure to move the job is told to the owner as exactly that —
  // never as the generic error that would invite a second "שלח" at a card
  // that is already decided — and the message is still settled.
  let resumed = true;
  try {
    await resumeAfterDecision(decided, ctx.by, { businessId: ctx.businessId });
  } catch {
    resumed = false;
  }

  await ctx.messenger.send({
    text: resumed
      ? mailCardApproved(mailboxReplyRecipient(card.proposedInput) ?? '')
      : DECIDED_RESUME_FAILED,
    jobId: null,
  });
  await settleMessage(
    ctx.storedId,
    'handled',
    card.jobId !== null ? { jobId: card.jobId } : {},
    { businessId: ctx.businessId },
  );
  return 'decided';
}

/**
 * The owner's text as the new body: cancel the open card and raise a fresh
 * pending one for the same reply job, in one transaction, with the edit
 * staged on it — then present it again. The job stays in `await_approval`;
 * no phase moves.
 *
 * The fresh card's proposal is the ORIGINAL proposal, byte for byte, and that
 * is checked (`facts.inputHash === card.inputHash`) rather than assumed: it is
 * what the bound plan step carries, so it is how the run finds this card.
 * Its risk is the old card's, because the facts it was assessed on are the
 * same facts.
 */
async function replaceBody(
  card: ApprovalRequest,
  newBody: string,
  ctx: StepContext,
): Promise<MailCardOutcome> {
  if (card.jobId === null) return ctx.refuse(MAIL_CARD_GONE);
  const jobId = card.jobId;
  const proposed = card.proposedInput as Record<string, unknown>;
  // Only `body` is replaced, so the subject is untouched by construction and
  // the Outlook rule (`mailReplyEditRefusal`, R22: on Microsoft 365 the reply
  // subject is set by Outlook and may not be edited) holds here on every
  // provider without needing to know which one is bound.
  const edited: Record<string, unknown> = { ...proposed, body: newBody };
  if (!mailReplyEditAllowed(proposed, edited)) return ctx.refuse(MAIL_CARD_GONE);

  const freshId = await withTransaction(async (tx) => {
    if (!(await cancelPendingApproval(card.approvalId, { businessId: ctx.businessId, db: tx }))) {
      return null;
    }
    const facts = buildFacts('mail.send', proposed, {
      // Every mail reply job is `unknown_external` (`raiseReplyCard`).
      provenance: 'unknown_external',
      chainDepth: 1,
      counterpartyTags: [],
      provenanceChainDerived: false,
    });
    if (facts.actionClass !== 'email.reply' || facts.inputHash !== card.inputHash) {
      throw new Error(`whatsapp mail card: proposal of ${card.approvalId} no longer reads as the bound reply`);
    }
    const { header } = splitReplyDetail(card.detail);
    const id = await enqueueApproval(
      {
        jobId,
        facts,
        risk: card.risk,
        proposedInput: proposed,
        summary: card.summary,
        detail: `${header.join('\n')}\n\n${newBody}`,
      },
      { businessId: ctx.businessId, db: tx },
    );
    if (!(await stagePendingEdit(id, edited, { businessId: ctx.businessId, db: tx }))) {
      throw new Error(`whatsapp mail card: could not stage the edit on ${id}`);
    }
    return id;
  });
  if (freshId === null) return ctx.refuse(MAIL_CARD_GONE);

  await presentMailCard(
    freshId,
    async (cardText, cardJobId) => {
      // `send` never throws; a failed send leaves an outbound row the window
      // does not count, so the fresh card is simply not open on WhatsApp.
      await ctx.messenger.send({ text: cardText, jobId: cardJobId });
    },
    { businessId: ctx.businessId, lead: REPLACEMENT_LEAD },
  );
  await settleMessage(ctx.storedId, 'handled', { jobId }, { businessId: ctx.businessId });
  return 'replaced';
}
