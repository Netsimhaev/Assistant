import { describe, it, expect } from 'vitest';
import { MailTriage, mailTriageProblems, finalCategories } from './mail-triage.js';

const base: MailTriage = {
  categories: ['other'], summary: 'x', isPerson: true, invoice: null, replyGist: null, attachments: [],
};
const inv = { number: '1', amountText: '10', dateText: null };

describe('MailTriage', () => {
  it('MailTriage rejects an extra field "to"', () => {
    expect(MailTriage.safeParse({ ...base, to: 'a@b.com' }).success).toBe(false);
    expect(MailTriage.safeParse(base).success).toBe(true);
  });
});

describe('mailTriageProblems', () => {
  it('invoice_without_category', () => {
    expect(mailTriageProblems({ ...base, categories: ['question'], replyGist: 'g', invoice: inv }, 0))
      .toContain('invoice_without_category');
  });
  it('question_without_gist', () => {
    expect(mailTriageProblems({ ...base, categories: ['question'] }, 0)).toContain('question_without_gist');
  });
  it('other_mixed', () => {
    expect(mailTriageProblems({ ...base, categories: ['other', 'document'] }, 0)).toContain('other_mixed');
  });
  it('clean triage has no problems', () => {
    expect(mailTriageProblems(base, 0)).toEqual([]);
  });
});

describe('attachments', () => {
  const att = (index: number) => ({ index, docType: 'invoice' as const, summary: 'חשבונית', invoice: null });

  it('triage response with an out-of-range attachment index is rejected', () => {
    expect(mailTriageProblems({ ...base, attachments: [att(0), att(2)] }, 2)).toContain('attachment_index_unknown');
    expect(mailTriageProblems({ ...base, attachments: [att(0), att(1)] }, 2)).toEqual([]);
    expect(mailTriageProblems({ ...base, attachments: [att(0)] }, 0)).toContain('attachment_index_unknown');
  });

  it('triage response with a duplicate index is rejected', () => {
    expect(mailTriageProblems({ ...base, attachments: [att(1), att(1)] }, 3)).toContain('attachment_index_duplicate');
  });

  it('attachments default to [] and reject an unknown docType or an extra field', () => {
    const { attachments: _drop, ...noAttachments } = base;
    expect(MailTriage.parse(noAttachments).attachments).toEqual([]);
    expect(MailTriage.safeParse({ ...base, attachments: [{ ...att(0), docType: 'memo' }] }).success).toBe(false);
    expect(MailTriage.safeParse({ ...base, attachments: [{ ...att(0), to: 'a@b.com' }] }).success).toBe(false);
    expect(MailTriage.safeParse({ ...base, attachments: [{ ...att(0), summary: 'x'.repeat(301) }] }).success).toBe(false);
  });

  it('an invoice attachment adds the invoice category (replacing other), never for an automated mail', () => {
    const t = { ...base, attachments: [att(0)] };
    expect(finalCategories(t, false).categories).toEqual(['invoice']);
    expect(finalCategories({ ...t, categories: ['question'], replyGist: 'g' }, false).categories).toEqual(['question', 'invoice']);
    const viaInvoiceObject = { ...base, attachments: [{ ...att(0), docType: 'other' as const, invoice: { number: '1', amountText: null, dateText: null } }] };
    expect(finalCategories(viaInvoiceObject, false).categories).toEqual(['invoice']);
    expect(finalCategories(t, true).categories).toEqual(['other']);
  });
});

describe('finalCategories', () => {
  it('forces other for automated even when the model says question', () => {
    const t = { ...base, categories: ['question' as const], replyGist: 'g' };
    expect(finalCategories(t, true)).toEqual({ categories: ['other'], isPerson: false });
    expect(finalCategories(t, false)).toEqual({ categories: ['question'], isPerson: true });
  });
});
