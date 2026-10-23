import { z } from 'zod';
import type { MailCategory } from '../mail/mailbox.js';

/**
 * What a document attached to a mail is, as the reader judged it. Closed set;
 * advisory only — used to filter the owner's screens, never read by any module
 * under `src/policy/` (the same rule as a reading's `findings`).
 */
export const AttachmentDocType = z.enum(['invoice', 'receipt', 'quote', 'contract', 'order', 'report', 'other']);
export type AttachmentDocType = z.infer<typeof AttachmentDocType>;

/** The owner-facing Hebrew word for each type. */
export const ATTACHMENT_DOC_TYPE_LABELS: Readonly<Record<AttachmentDocType, string>> = {
  invoice: 'חשבונית',
  receipt: 'קבלה',
  quote: 'הצעת מחיר',
  contract: 'חוזה',
  order: 'הזמנה',
  report: 'דוח',
  other: 'אחר',
};

/** Unverified invoice details a model read — from the body or from an attachment. */
const TriageInvoice = z
  .object({
    number: z.string().max(64).nullable(),
    amountText: z.string().max(64).nullable(),
    dateText: z.string().max(64).nullable(),
  })
  .strict();

/**
 * One attachment, by its position in the brief (= the stored `attachments`
 * order). Like everything here it carries no address field.
 */
export const TriageAttachment = z
  .object({
    index: z.number().int().min(0),
    docType: AttachmentDocType,
    summary: z.string().min(1).max(300),
    invoice: TriageInvoice.nullable(),
  })
  .strict();
export type TriageAttachment = z.infer<typeof TriageAttachment>;

/** What the model may say about a mail. Deliberately carries no address field. */
export const MailTriage = z
  .object({
    categories: z.array(z.enum(['invoice', 'question', 'document', 'other'])).min(1),
    summary: z.string().min(1).max(400),
    isPerson: z.boolean(),
    invoice: TriageInvoice.nullable(),
    replyGist: z.string().max(500).nullable(),
    attachments: z.array(TriageAttachment).default([]),
  })
  .strict();
export type MailTriage = z.infer<typeof MailTriage>;

/**
 * Semantic checks the schema cannot express. `shownAttachmentCount` is how
 * many attachments the brief actually showed: an index at or past it names an
 * attachment the model never saw (or one that does not exist).
 */
export function mailTriageProblems(t: MailTriage, shownAttachmentCount: number): string[] {
  const problems: string[] = [];
  if (t.invoice !== null && !t.categories.includes('invoice')) problems.push('invoice_without_category');
  if (t.categories.includes('question') && t.replyGist === null) problems.push('question_without_gist');
  if (t.categories.includes('other') && t.categories.length > 1) problems.push('other_mixed');
  const seen = new Set<number>();
  for (const attachment of t.attachments) {
    if (attachment.index >= shownAttachmentCount) problems.push('attachment_index_unknown');
    if (seen.has(attachment.index)) problems.push('attachment_index_duplicate');
    seen.add(attachment.index);
  }
  return [...new Set(problems)];
}

/** Whether the reader judged this attachment an invoice — by its type or by invoice details. */
export function attachmentIsInvoice(a: TriageAttachment): boolean {
  return a.docType === 'invoice' || a.invoice !== null;
}

/**
 * The model can only lower an automated mail to `other`, never raise it —
 * and that holds for an invoice found inside an attachment too: an automated
 * mail stays `other` (its PDF invoice is still recorded, which grants nothing).
 * For a mail from a person, an invoice attachment adds `invoice` (replacing a
 * lone `other`), so the label and the invoice screen follow.
 */
export function finalCategories(
  t: MailTriage,
  automated: boolean,
): { categories: MailCategory[]; isPerson: boolean } {
  if (automated) return { categories: ['other'], isPerson: false };
  let categories: MailCategory[] = [...t.categories];
  if (t.attachments.some(attachmentIsInvoice) && !categories.includes('invoice')) {
    categories = [...categories.filter((c) => c !== 'other'), 'invoice'];
  }
  return { categories, isPerson: t.isPerson };
}
