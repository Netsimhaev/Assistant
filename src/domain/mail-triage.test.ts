import { describe, it, expect } from 'vitest';
import { MailTriage, mailTriageProblems, finalCategories } from './mail-triage.js';

const base: MailTriage = {
  categories: ['other'], summary: 'x', isPerson: true, invoice: null, replyGist: null,
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
    expect(mailTriageProblems({ ...base, categories: ['question'], replyGist: 'g', invoice: inv }))
      .toContain('invoice_without_category');
  });
  it('question_without_gist', () => {
    expect(mailTriageProblems({ ...base, categories: ['question'] })).toContain('question_without_gist');
  });
  it('other_mixed', () => {
    expect(mailTriageProblems({ ...base, categories: ['other', 'document'] })).toContain('other_mixed');
  });
  it('clean triage has no problems', () => {
    expect(mailTriageProblems(base)).toEqual([]);
  });
});

describe('finalCategories', () => {
  it('forces other for automated even when the model says question', () => {
    const t = { ...base, categories: ['question' as const], replyGist: 'g' };
    expect(finalCategories(t, true)).toEqual({ categories: ['other'], isPerson: false });
    expect(finalCategories(t, false)).toEqual({ categories: ['question'], isPerson: true });
  });
});
