/**
 * The brief the quarantined `intake.triage` reader sees. Mail is hostile by
 * definition, so every field written by the sender is fenced between
 * per-call-nonce markers (same rule as `sdk/gov-verify.ts`; the nonce is the
 * boundary, `stripUntilStable` is belt-and-braces).
 *
 * The header addresses (From / Reply-To / To) are NEVER included: the model
 * has no use for them, and a brief that never carries them cannot be talked
 * into echoing one. The sender is described as "השולח". Addresses the sender
 * typed inside the body stay as text — we do not rewrite hostile content.
 *
 * **Attachments** (spec §9.3) follow the body, in the stored `attachments`
 * order, each as its own fenced field whose open line names its index:
 * `=== צרופה <index>: <filename label> :: <nonce> ===`. The index is what the
 * model answers by, so it must be the position in the stored list. The
 * filename is the sender's and sits INSIDE the fence line, so it is cleaned
 * harder than fenced content: bidi and control characters go, `=`/`:` runs
 * that could imitate a fence are collapsed, and a name that is (or embeds) an
 * address is replaced outright — the same rule as the display name. An
 * attachment with no text is shown as not read, with the reason. The text
 * itself comes from the document's stored artefacts (built by the caller);
 * this module stays pure.
 *
 * **Budget.** The whole brief stays within `TRIAGE_BRIEF_MAX_CHARS`. The
 * skeleton (headers, fences, and a reserved notice slot per attachment) is
 * measured first; the body then takes what it needs; the attachments share
 * what is left, in order, each at most `TRIAGE_ATTACHMENT_MAX_CHARS`. So
 * attachments are cut before the body, and every cut is marked.
 */
import { stripBidiControls } from '../util/bidi.js';
import { buildFence, stripFenceMarkers, type Fence } from '../util/fence.js';
import type { StoredMail } from './inbox-store.js';

export const TRIAGE_BRIEF_MAX_CHARS = 24_000;
/** Characters of one attachment's text shown to the reader. */
export const TRIAGE_ATTACHMENT_MAX_CHARS = 8_000;
/** Attachments listed in the brief; any beyond are counted, not shown. */
export const TRIAGE_MAX_ATTACHMENTS = 10;
const FIELD_MAX_CHARS = 500;
const FILENAME_MAX_CHARS = 120;

export const TRIAGE_LABELS = {
  subject: 'נושא ההודעה (לא אמין)',
  fromName: 'שם השולח כפי שהוצהר (לא אמין)',
  body: 'גוף ההודעה (לא אמין)',
} as const;

/**
 * Why an attachment's text is not in the brief. `undecodable`: a PDF kept
 * `stored` because extraction failed (ruling P7). `stored_before_reading`: a
 * PDF kept `stored` with no reason — ingested before PDFs were read at all.
 */
export type AttachmentNotRead = 'scanned' | 'not_ingested' | 'unsupported' | 'undecodable' | 'stored_before_reading';

/** One stored attachment, as the brief shows it. Built in code from the document's artefacts. */
export interface BriefAttachment {
  /** The sender's filename, verbatim; cleaned here, never trusted. */
  filename: string;
  /** The extracted text, or `null` when there is none to show. */
  text: string | null;
  /** Set exactly when `text` is `null`. */
  notRead: AttachmentNotRead | null;
  /** Extraction already cut the document (page or character cap). */
  truncated: boolean;
}

const NOT_READ_TEXT: Record<AttachmentNotRead, string> = {
  scanned: '(לא נקרא: סרוק)',
  not_ingested: '(לא נקרא: לא נקלט)',
  unsupported: '(לא נקרא: סוג לא נתמך)',
  undecodable: '(לא נקרא: לא ניתן לפענח)',
  stored_before_reading: '(לא נקרא: נשמר לפני שקריאת PDF נבנתה)',
};

const CUT_NOTICE = '\n(קוצץ — התוכן המקורי ארוך יותר)';
const OMITTED_NOTICE = '(הטקסט הושמט — אין מקום בתדריך)';
const EXTRACTION_CUT_NOTICE = '\n(המסמך קוצץ כבר בקליטה.)';
const UNNAMED_FILE = '(שם הקובץ הושמט)';
/** Room reserved per attachment for its notices — more than any combination of them needs. */
const ATTACHMENT_NOTICE_SLOT = CUT_NOTICE.length + EXTRACTION_CUT_NOTICE.length + OMITTED_NOTICE.length;

function strip(text: string, fence: Fence): string {
  return stripFenceMarkers(stripBidiControls(text), fence);
}

/** At most `max` characters INCLUDING the cut notice. */
function capWithin(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - CUT_NOTICE.length))}${CUT_NOTICE}`;
}

const ADDRESS_LIKE = /\S@\S/;

/** A name that is (or embeds) an address would put a header address in the brief. */
function nameIsSafe(name: string, mail: StoredMail): boolean {
  if (name.trim() === '') return false;
  if (ADDRESS_LIKE.test(name)) return false;
  const lower = name.toLowerCase();
  for (const addr of [mail.fromAddress, mail.replyTo, ...mail.toAddresses]) {
    if (addr !== null && addr !== '' && lower.includes(addr.toLowerCase())) return false;
  }
  return true;
}

/**
 * The filename as it may appear inside a fence line: one line, no bidi or
 * control characters, nothing that imitates a fence, bounded — and never an
 * address. Address shape is checked AFTER cleaning, so a stripped control
 * character cannot join an address back together past the check.
 */
export function attachmentLabel(filename: string, mail: StoredMail): string {
  const cleaned = stripBidiControls(filename)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/={2,}/g, '=')
    .replace(/:{2,}/g, ':')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FILENAME_MAX_CHARS);
  return nameIsSafe(cleaned, mail) ? cleaned : UNNAMED_FILE;
}

/** The fence of attachment `index`; `label` is the already-cleaned filename label. */
export function attachmentFence(index: number, label: string, nonce: string): Fence {
  return buildFence(`צרופה ${index}: ${label}`, nonce);
}

/** How many attachments the brief shows — the bound `mailTriageProblems` checks indexes against. */
export function shownAttachmentCount(attachments: readonly BriefAttachment[]): number {
  return Math.min(attachments.length, TRIAGE_MAX_ATTACHMENTS);
}

export function renderTriageBrief(
  mail: StoredMail,
  nonce: string,
  attachments: readonly BriefAttachment[] = [],
): string {
  const fenced = (title: string, f: Fence, content: string): string => `# ${title}\n${f.open}\n${content}\n${f.close}`;

  const subjectFence = buildFence(TRIAGE_LABELS.subject, nonce);
  const subject = capWithin(strip(mail.subject, subjectFence), FIELD_MAX_CHARS);
  const nameFence = buildFence(TRIAGE_LABELS.fromName, nonce);
  const fromName =
    mail.fromName !== null && nameIsSafe(mail.fromName, mail)
      ? capWithin(strip(mail.fromName, nameFence), FIELD_MAX_CHARS)
      : null;
  const bodyFence = buildFence(TRIAGE_LABELS.body, nonce);
  const bodyText = strip(mail.bodyText, bodyFence);

  const shown = attachments.slice(0, TRIAGE_MAX_ATTACHMENTS).map((a, index) => {
    const fence = attachmentFence(index, attachmentLabel(a.filename, mail), nonce);
    return { a, fence, text: a.text === null ? null : strip(a.text, fence) };
  });

  const assemble = (body: string, texts: readonly string[]): string => {
    const parts: string[] = [fenced('נושא', subjectFence, subject)];
    if (fromName !== null) parts.push(fenced('שם השולח', nameFence, fromName));
    parts.push(fenced('גוף ההודעה', bodyFence, body));
    if (mail.bodyTruncated) parts.push('(הגוף שנשמר קוצר בקליטה.)');
    shown.forEach((s, i) => parts.push(fenced(`צרופה ${i}`, s.fence, texts[i] ?? '')));
    if (attachments.length > shown.length) {
      parts.push(`(יש עוד ${attachments.length - shown.length} צרופות שלא הוצגו.)`);
    }
    return `הודעה שהתקבלה מ"השולח".\n\n${parts.join('\n\n')}`;
  };

  const skeleton = assemble('', shown.map(() => '')).length + shown.length * ATTACHMENT_NOTICE_SLOT;
  let budget = Math.max(0, TRIAGE_BRIEF_MAX_CHARS - skeleton);

  // The body first: attachments are cut before it is.
  const body = capWithin(bodyText, budget);
  budget -= body.length;

  const texts = shown.map(({ a, text }) => {
    if (text === null) return NOT_READ_TEXT[a.notRead ?? 'not_ingested'];
    const extractionCut = a.truncated ? EXTRACTION_CUT_NOTICE : '';
    const limit = Math.min(TRIAGE_ATTACHMENT_MAX_CHARS, budget);
    if (text.length <= limit) {
      budget -= text.length;
      return `${text}${extractionCut}`;
    }
    if (limit <= 0) return OMITTED_NOTICE;
    budget -= limit;
    // The notices live in this attachment's reserved slot, not in the budget.
    return `${text.slice(0, limit)}${CUT_NOTICE}${extractionCut}`;
  });

  return assemble(body, texts);
}
