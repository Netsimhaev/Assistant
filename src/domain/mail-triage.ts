import { z } from 'zod';
import type { MailCategory } from '../mail/mailbox.js';

/** What the model may say about a mail. Deliberately carries no address field. */
export const MailTriage = z
  .object({
    categories: z.array(z.enum(['invoice', 'question', 'document', 'other'])).min(1),
    summary: z.string().min(1).max(400),
    isPerson: z.boolean(),
    invoice: z
      .object({
        number: z.string().max(64).nullable(),
        amountText: z.string().max(64).nullable(),
        dateText: z.string().max(64).nullable(),
      })
      .strict()
      .nullable(),
    replyGist: z.string().max(500).nullable(),
  })
  .strict();
export type MailTriage = z.infer<typeof MailTriage>;

export function mailTriageProblems(t: MailTriage): string[] {
  const problems: string[] = [];
  if (t.invoice !== null && !t.categories.includes('invoice')) problems.push('invoice_without_category');
  if (t.categories.includes('question') && t.replyGist === null) problems.push('question_without_gist');
  if (t.categories.includes('other') && t.categories.length > 1) problems.push('other_mixed');
  return problems;
}

/** The model can only lower an automated mail to `other`, never raise it. */
export function finalCategories(
  t: MailTriage,
  automated: boolean,
): { categories: MailCategory[]; isPerson: boolean } {
  if (automated) return { categories: ['other'], isPerson: false };
  return { categories: t.categories, isPerson: t.isPerson };
}
