/**
 * The WhatsApp line the owner gets about a mail from a real person (spec
 * §2.6): who sent it, then what kind of mail it is and the triage summary.
 *
 * Every field is sender-written or model output over sender-written text, so
 * every one goes through `stripBidiControls` — a direction override in a
 * display name or summary changes what the owner reads without changing the
 * bytes (CLAUDE.md, "every string the owner reads that can carry a stranger's
 * bytes"). The name and summary are also folded onto one line each, so a
 * display name carrying a newline cannot forge a second line of the notice.
 */
import { stripBidiControls } from '../util/bidi.js';
import type { ApprovalRequest } from '../governance/approvals.js';
import { ATTACHMENT_DOC_TYPE_LABELS, type AttachmentDocType } from '../domain/mail-triage.js';
import type { MailCategory } from './mailbox.js';
import { RECIPIENT_LABEL, SUBJECT_LABEL, WARNING_PREFIXES, splitReplyDetail } from './reply-card.js';

/** Only the two categories that ever notify have a word. */
const CATEGORY_WORDS: Partial<Record<MailCategory, string>> = {
  invoice: 'חשבונית',
  question: 'שאלה שמחכה לתשובה',
};

function oneLine(value: string): string {
  return stripBidiControls(value).replace(/\s+/g, ' ').trim();
}

export interface MailNoticeInput {
  fromName: string | null;
  fromAddress: string;
  summary: string;
  /**
   * What the triage reader said about each attachment it saw. The poll passes
   * the validated `triage.attachments` (entries it dropped are already gone),
   * so the notice does not depend on re-reading the stored row.
   */
  attachments?: readonly { docType: AttachmentDocType; summary: string }[];
}

/** At most this many attachment lines; the rest are counted ("ועוד N"). */
export const NOTICE_ATTACHMENT_LINES = 3;

export function renderMailNotice(mail: MailNoticeInput, categories: readonly MailCategory[]): string {
  const address = oneLine(mail.fromAddress);
  const name = mail.fromName === null ? '' : oneLine(mail.fromName);
  const who = name === '' ? address : `${name} <${address}>`;
  const words = categories
    .map((c) => CATEGORY_WORDS[c])
    .filter((w): w is string => w !== undefined)
    .join(' · ');
  const attachments = mail.attachments ?? [];
  const lines = attachments
    .slice(0, NOTICE_ATTACHMENT_LINES)
    .map((a) => `📎 ${ATTACHMENT_DOC_TYPE_LABELS[a.docType] ?? ATTACHMENT_DOC_TYPE_LABELS.other}: ${oneLine(a.summary)}`);
  if (attachments.length > NOTICE_ATTACHMENT_LINES) lines.push(`ועוד ${attachments.length - NOTICE_ATTACHMENT_LINES}`);
  return [`📧 ${who}`, `${words}: ${oneLine(mail.summary)}`, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// The reply card, over WhatsApp (mailbox spec §5.2 item 7)
// ---------------------------------------------------------------------------

/**
 * The last line of every card this module renders, verbatim from the brief.
 *
 * It is also how a presentation is recognised later (`openMailCards` in
 * `orchestrator/whatsapp-mail-card.ts`): code-written, always last, never
 * something the sender or the model wrote — so an outbound row ending with
 * it is a card this code sent.
 */
export const MAIL_CARD_INSTRUCTION = 'השב "שלח" כדי לשלוח, או "נוסח:" ואחריו נוסח חדש.';

/** Shown first, so the owner reads what the message is before he reads the body. */
const CARD_TITLE = '✉️ טיוטת תשובה לאישור';

/**
 * The reply card as one WhatsApp message: the warnings the dashboard card
 * carries, who it goes to, the subject, the FULL body, then the instruction.
 *
 * `payload` is passed apart from `approval` because the body shown must be the
 * body that would run: after a replacement that is the staged edit, not the
 * draft the approval was raised with. Every field passes through
 * `stripBidiControls` — the body is model output over a stranger's mail, or
 * text the owner typed, and an override in it would change what he reads
 * without changing the bytes that go out. The body keeps its line breaks;
 * every other field is folded onto one line, so no field can forge a line
 * of this message.
 *
 * The warning lines are taken from the stored detail's header block — the
 * part this code wrote (`composeReplyDetail`), never the body — and only the
 * ones that start with a known warning prefix.
 */
export function renderMailCardWhatsApp(approval: ApprovalRequest, payload: unknown): string {
  const record =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const own = (key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
  // A mailbox reply has exactly one recipient — the original From (spec
  // §5.2). A payload naming anything else is not a card this code raised, and
  // showing only its first address would hide who else it goes to: refuse.
  const to = own('to');
  if (!Array.isArray(to) || to.length !== 1 || typeof to[0] !== 'string') {
    throw new Error('renderMailCardWhatsApp: a reply card must name exactly one recipient');
  }
  const recipient: string = to[0];
  const subject = own('subject');
  const body = own('body');

  const warnings = splitReplyDetail(approval.detail).header.filter((line) =>
    WARNING_PREFIXES.some((prefix) => line.startsWith(prefix)),
  );

  return [
    `${CARD_TITLE}: ${oneLine(approval.summary)}`,
    ...warnings.map(oneLine),
    `${RECIPIENT_LABEL}${oneLine(recipient)}`,
    `${SUBJECT_LABEL}${oneLine(typeof subject === 'string' ? subject : '')}`,
    '',
    stripBidiControls(typeof body === 'string' ? body : '').trim(),
    '',
    MAIL_CARD_INSTRUCTION,
  ].join('\n');
}
