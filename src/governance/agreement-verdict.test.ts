import { describe, expect, it } from 'vitest';
import { agreementVerdict, MAX_EDITED_WORDS } from './agreement-verdict.js';

const mail = (body: string, extra: Record<string, unknown> = {}) => ({
  to: 'dana@x.com',
  subject: 'נושא',
  body,
  ...extra,
});
const edit = (proposedBody: string, editedBody: string, editedExtra: Record<string, unknown> = {}) =>
  agreementVerdict({
    state: 'approved_with_edit',
    proposed: mail(proposedBody),
    edited: mail(editedBody, editedExtra),
  });

describe('agreementVerdict', () => {
  it('maps approval states', () => {
    const base = { proposed: mail('שלום'), edited: null };
    expect(agreementVerdict({ state: 'approved', ...base })).toEqual({ verdict: 'right', reason: null });
    expect(agreementVerdict({ state: 'denied', ...base })).toEqual({ verdict: 'wrong', reason: 'denied' });
    expect(agreementVerdict({ state: 'expired', ...base })).toEqual({ verdict: 'not_counted', reason: null });
    expect(agreementVerdict({ state: 'cancelled', ...base })).toEqual({ verdict: 'not_counted', reason: null });
    expect(agreementVerdict({ state: 'pending', ...base })).toEqual({ verdict: 'not_counted', reason: null });
    expect(agreementVerdict({ state: 'whatever', ...base })).toEqual({ verdict: 'not_counted', reason: null });
  });

  it('treats approved_with_edit without an edit as approved', () => {
    expect(agreementVerdict({ state: 'approved_with_edit', proposed: mail('שלום'), edited: null })).toEqual({
      verdict: 'right',
      reason: null,
    });
  });

  it('allows up to the word limit and refuses one more', () => {
    expect(MAX_EDITED_WORDS).toBe(3);
    expect(edit('אחד שתיים שלוש ארבע חמש', 'אחד X Y Z חמש')).toEqual({ verdict: 'right', reason: null });
    expect(edit('אחד שתיים שלוש ארבע חמש', 'אחד X Y Z W')).toEqual({ verdict: 'wrong', reason: 'too_many_words' });
  });

  it('counts words over subject and body together', () => {
    const r = agreementVerdict({
      state: 'approved_with_edit',
      proposed: { to: 'a@x.com', subject: 'א ב', body: 'ג ד' },
      edited: { to: 'a@x.com', subject: 'X Y', body: 'Z W' },
    });
    expect(r).toEqual({ verdict: 'wrong', reason: 'too_many_words' });
  });

  it('treats a changed recipient as wrong even with no body change', () => {
    const r = agreementVerdict({
      state: 'approved_with_edit',
      proposed: mail('שלום'),
      edited: { ...mail('שלום'), to: 'other@x.com' },
    });
    expect(r).toEqual({ verdict: 'wrong', reason: 'recipient' });
  });

  it('compares recipients case-insensitively', () => {
    const r = agreementVerdict({
      state: 'approved_with_edit',
      proposed: mail('שלום'),
      edited: { ...mail('שלום'), to: 'DANA@X.com' },
    });
    expect(r).toEqual({ verdict: 'right', reason: null });
  });

  it('flags a changed number', () => {
    expect(edit('עלות 500 ש"ח', 'עלות 5,000 ש"ח')).toEqual({ verdict: 'wrong', reason: 'number' });
  });

  it('normalises thousands separators before comparing numbers', () => {
    expect(edit('עלות 5,000 ש"ח', 'עלות 5000 ש"ח')).toEqual({ verdict: 'right', reason: null });
  });

  it('flags a changed clock time', () => {
    expect(edit("ביום ג' ב-10:00", "ביום ג' ב-14:00")).toEqual({ verdict: 'wrong', reason: 'number' });
  });

  it('flags changed date words', () => {
    expect(edit('נדבר מחר', 'נדבר מחרתיים')).toEqual({ verdict: 'wrong', reason: 'date' });
    expect(edit('ביום שלישי', 'ביום חמישי')).toEqual({ verdict: 'wrong', reason: 'date' });
    expect(edit("ביום ג'", "ביום ד'")).toEqual({ verdict: 'wrong', reason: 'date' });
  });

  it('sees date words behind a glued particle', () => {
    expect(edit('נדבר בשלישי', 'נדבר בחמישי')).toEqual({ verdict: 'wrong', reason: 'date' });
    expect(edit('נדבר ביום שלישי', 'נדבר ביום שלישי')).toEqual({ verdict: 'right', reason: null });
  });

  it('ignores punctuation and bidi controls', () => {
    expect(edit('שלום דנה', 'שלום, דנה!\u200F')).toEqual({ verdict: 'right', reason: null });
  });
});
