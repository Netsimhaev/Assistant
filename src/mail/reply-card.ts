/**
 * The words on a mailbox-reply approval card, and the one predicate that
 * recognises such a card's payload.
 *
 * Lives under `src/mail/` and imports nothing with a database behind it, so
 * that the dashboard (`views.ts`) and the orchestrator (`mail-reply.ts`) read
 * the same constants rather than two copies drifting apart.
 *
 * **The detail layout is a contract between the two.** A header block of
 * lines this code writes, then one blank line, then the drafted body. Every
 * header line starts with text written here — the recipient address and the
 * subject come after a fixed label — so `views.ts` can highlight a header
 * line by its prefix without that ever being something the sender wrote.
 * The body (model output derived from a stranger's mail) is never scanned
 * for prefixes: a body line that happens to begin "שים לב:" is body text, not
 * a warning, and must never be dressed as one.
 */
import { stripBidiControls } from '../util/bidi.js';
import { canonicalJson } from '../util/canonical.js';

/**
 * `Re: ` unless the subject already starts with `re:`, any case.
 *
 * Control characters (C0, DEL, C1 — CR and LF among them) are folded to one
 * space first. A subject header can be RFC 2047-encoded so that it DECODES to
 * a line break, and that string is what lands here; proposed as is, it is a
 * subject the Gmail client refuses ("header value contains a line break") on
 * every send and on every re-raise, so the reply could never go out. Folding
 * here keeps the proposal — what the owner reads and approves — clean.
 */
export function replySubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  const folded = subject.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  return /^\s*re:/i.test(folded) ? folded : `Re: ${folded}`;
}

export const REPLY_TO_WARNING_PREFIX = 'שים לב: המייל ביקש שהתשובה תישלח ל-';
export const RETRY_PREFIX = 'השליחה הקודמת לא הושלמה — לאשר שוב?';
export const MAY_HAVE_SENT_WARNING = 'ייתכן שהמייל כבר יצא — בדקו בתיבת הדואר שנשלח לפני שמאשרים.';
export const RECIPIENT_LABEL = 'התשובה תישלח ל-';
export const SUBJECT_LABEL = 'נושא: ';

/** Header lines the card renders as warnings. Matched only in the header block. */
export const WARNING_PREFIXES: readonly string[] = [
  RETRY_PREFIX,
  MAY_HAVE_SENT_WARNING,
  REPLY_TO_WARNING_PREFIX,
];

/** One display line: no bidi controls, no line breaks a header line could be split by. */
export function displayLine(value: string): string {
  return stripBidiControls(value).replace(/\s+/g, ' ').trim();
}

/** Whether a differing Reply-To deserves the warning: set, and not the From address (case-insensitive). */
export function replyToDiffers(replyTo: string | null, fromAddress: string): boolean {
  if (replyTo === null) return false;
  const r = replyTo.trim().toLowerCase();
  return r !== '' && r !== fromAddress.trim().toLowerCase();
}

export interface ReplyDetailInput {
  fromAddress: string;
  replyTo: string | null;
  /** The reply's own subject (already `Re:`-prefixed). */
  subject: string;
  body: string;
  /** Set when this card re-asks after an approved send did not complete. */
  retry?: { mayHaveSent: boolean };
}

export function composeReplyDetail(input: ReplyDetailInput): string {
  const header: string[] = [];
  if (input.retry !== undefined) {
    header.push(RETRY_PREFIX);
    if (input.retry.mayHaveSent) header.push(MAY_HAVE_SENT_WARNING);
  }
  if (replyToDiffers(input.replyTo, input.fromAddress)) {
    header.push(
      `${REPLY_TO_WARNING_PREFIX}${displayLine(input.replyTo ?? '')}. התשובה תישלח ל-${input.fromAddress}.`,
    );
  }
  header.push(`${RECIPIENT_LABEL}${input.fromAddress}`);
  header.push(`${SUBJECT_LABEL}${displayLine(input.subject)}`);
  return `${header.join('\n')}\n\n${input.body}`;
}

/**
 * The single recipient of a mailbox-reply payload, or `null` when the payload
 * is not one. Positive, own-key test of the shape `raiseMailReply` binds:
 * `providerMessageId`, `inReplyTo` and `threadId` strings and exactly one
 * address in `to`.
 */
export function mailboxReplyRecipient(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const own = (key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
  for (const key of ['providerMessageId', 'inReplyTo', 'threadId']) {
    const value = own(key);
    if (typeof value !== 'string' || value === '') return null;
  }
  const to = own('to');
  if (!Array.isArray(to) || to.length !== 1 || typeof to[0] !== 'string') return null;
  return to[0];
}

/** Split a reply-card detail into its code-written header lines and the body. */
export function splitReplyDetail(detail: string): { header: string[]; body: string } {
  const at = detail.indexOf('\n\n');
  if (at === -1) return { header: detail.split('\n'), body: '' };
  return { header: detail.slice(0, at).split('\n'), body: detail.slice(at + 2) };
}

/** Shown when an edit to a mailbox-reply card touches anything but subject and body. */
export const MAIL_REPLY_EDIT_REFUSAL = 'בתשובה למייל אפשר לערוך רק את הנושא ואת גוף ההודעה';

/**
 * Microsoft 365 answers a reply through Graph's `/reply`, which takes no
 * subject: Outlook writes "RE: <original subject>" itself. A subject edit on
 * such a card would be approved and then silently not happen, so it is
 * refused (ruling R22), and the card says so before the owner tries.
 */
export const OUTLOOK_SUBJECT_REFUSAL = 'ב-Outlook הנושא נקבע אוטומטית — אפשר לערוך רק את גוף ההודעה';
export const OUTLOOK_SUBJECT_NOTE =
  'ב-Outlook הנושא נקבע אוטומטית ("RE:" ונושא המייל המקורי) — אפשר לערוך רק את גוף ההודעה.';

/**
 * Why an edit to a mailbox-reply card is refused, or `null` when it is allowed.
 *
 * The provider-aware form of `mailReplyEditAllowed`: everything that rule
 * refuses is refused here with its own sentence, and on a `microsoft`
 * mailbox a changed subject is refused too. Positive: the subject is locked
 * only when the provider IS `microsoft`; Gmail sends the subject it is given.
 */
export function mailReplyEditRefusal(
  proposed: unknown,
  edited: unknown,
  provider: string | null,
): string | null {
  if (!mailReplyEditAllowed(proposed, edited)) return MAIL_REPLY_EDIT_REFUSAL;
  if (provider === 'microsoft') {
    const p = proposed as Record<string, unknown>;
    const e = edited as Record<string, unknown>;
    if (canonicalJson(p['subject']) !== canonicalJson(e['subject'])) return OUTLOOK_SUBJECT_REFUSAL;
  }
  return null;
}

/** The only fields an owner may change on a mailbox-reply card. */
const EDITABLE_REPLY_FIELDS: ReadonlySet<string> = new Set(['subject', 'body']);

/**
 * Whether an edit to a mailbox-reply payload keeps everything but the subject
 * and the body exactly as proposed.
 *
 * Positive and whole: the edited payload must have the same own keys as the
 * proposed one — none removed, none added — and every key outside
 * `EDITABLE_REPLY_FIELDS` must be canonically equal. The recipient of a reply
 * is always the original From (mailbox spec §5.2); an owner who wants to
 * write to someone else uses the instruction door. Dropping `inReplyTo`
 * would also turn the reply into a cold `email.initiate`, and adding a key
 * (a `cc`, say) is a field nothing on the card showed.
 */
export function mailReplyEditAllowed(proposed: unknown, edited: unknown): boolean {
  if (typeof proposed !== 'object' || proposed === null || Array.isArray(proposed)) return false;
  if (typeof edited !== 'object' || edited === null || Array.isArray(edited)) return false;
  const p = proposed as Record<string, unknown>;
  const e = edited as Record<string, unknown>;
  const keys = new Set([...Object.keys(p), ...Object.keys(e)]);
  for (const key of keys) {
    if (!Object.hasOwn(p, key) || !Object.hasOwn(e, key)) return false;
    if (EDITABLE_REPLY_FIELDS.has(key)) continue;
    if (canonicalJson(p[key]) !== canonicalJson(e[key])) return false;
  }
  return true;
}
