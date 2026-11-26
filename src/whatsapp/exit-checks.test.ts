import { describe, expect, it } from 'vitest';
import { EXIT_REASONS, exitChecks, type ExitCheckInput } from './exit-checks.js';
import type { ContactTopic } from './contact-topics.js';

const topic: ContactTopic = {
  topicId: 't1',
  name: 'חשבוניות',
  description: '',
  appliesTo: 'both',
  sources: ['sent_invoices'],
  autoReply: true,
  retiredAt: null,
  updatedAt: new Date(0),
};

function base(over: Partial<ExitCheckInput> = {}): ExitCheckInput {
  return {
    draft: 'החשבונית נשלחה ב-12/11',
    attachDocumentId: null,
    classification: { kind: 'question', topicId: 't1', summary: '', window: null },
    topic,
    sender: { kind: 'client', managed: true, colleague: false, name: 'דנה לוי' },
    tier12: [
      { source: 'sent_invoices', label: 'חשבונית', text: 'חשבונית נשלחה ב-12/11', documentId: 'DOC-1', at: null },
    ] as ExitCheckInput['tier12'],
    tier3Used: false,
    sourceFailed: false,
    ownershipViolation: false,
    otherPeople: { names: [], emails: [], phoneKeys: [] },
    ...over,
  };
}

const reason = (i: ExitCheckInput): string => {
  const r = exitChecks(i);
  return r.ok ? 'ok' : r.reason;
};

describe('exitChecks', () => {
  it('passes the baseline', () => expect(exitChecks(base())).toEqual({ ok: true }));

  it('sources: failed or foreign sources', () => {
    expect(reason(base({ sourceFailed: true }))).toBe(EXIT_REASONS.sources);
    expect(reason(base({ ownershipViolation: true }))).toBe(EXIT_REASONS.sources);
  });

  it('1: grounded date ok, other date ungrounded', () => {
    expect(reason(base())).toBe('ok');
    expect(reason(base({ draft: 'החשבונית נשלחה ב-13/11' }))).toBe(EXIT_REASONS.ungrounded);
  });

  it('1: empty sources with a digit fails; without a digit passes this check', () => {
    expect(reason(base({ tier12: [], draft: 'יש 3 חשבוניות' }))).toBe(EXIT_REASONS.ungrounded);
    expect(reason(base({ tier12: [], draft: 'לא מצאתי חשבונית' }))).toBe('ok');
  });

  it('2: other name, whole word only', () => {
    const people = { names: ['רונית'], emails: [], phoneKeys: [] };
    expect(reason(base({ draft: 'שאלי את רונית', otherPeople: people }))).toBe(EXIT_REASONS.otherPerson);
    expect(reason(base({ draft: 'שאלי את רונית', otherPeople: { ...people, names: [] } }))).toBe('ok');
    expect(reason(base({ draft: 'שאלי את רוניתא', otherPeople: people }))).toBe('ok');
  });

  it('2: sender own name and 1-char names are skipped', () => {
    const o = { names: ['דנה לוי', 'א'], emails: [], phoneKeys: [] };
    expect(reason(base({ draft: 'שלום דנה לוי, יש א', otherPeople: o }))).toBe('ok');
  });

  it('2: email', () => {
    const o = { names: [], emails: ['Rony@x.co.il'], phoneKeys: [] };
    expect(reason(base({ draft: 'כתבי ל-rony@x.co.il', otherPeople: o }))).toBe(EXIT_REASONS.otherPerson);
    expect(reason(base({ draft: 'כתבי ל-rony@x.co.il', otherPeople: { ...o, emails: [] } }))).toBe('ok');
  });

  it('2: local phone against a 972 key', () => {
    const o = { names: [], emails: [], phoneKeys: ['972541234567'] };
    const tier12 = [
      { source: 'sent_invoices', label: 'x', text: '054-1234567', documentId: null, at: null },
    ] as ExitCheckInput['tier12'];
    expect(reason(base({ draft: 'התקשרי 054-1234567', tier12, otherPeople: o }))).toBe(EXIT_REASONS.otherPerson);
    expect(reason(base({ draft: 'התקשרי 054-1234567', tier12, otherPeople: { ...o, phoneKeys: [] } }))).toBe('ok');
  });

  it('3: attachment must be a source document', () => {
    expect(reason(base({ attachDocumentId: 'DOC-1' }))).toBe('ok');
    expect(reason(base({ attachDocumentId: 'DOC-9' }))).toBe(EXIT_REASONS.attachment);
  });

  it('4: tier 3 used', () => {
    expect(reason(base({ tier3Used: true }))).toBe(EXIT_REASONS.internal);
  });

  it('5: topic conditions, one flipped at a time', () => {
    const s = (p: Partial<ExitCheckInput['sender']>) => ({ ...base().sender, ...p });
    expect(reason(base({ sender: s({ managed: false }) }))).toBe(EXIT_REASONS.topic);
    expect(reason(base({ sender: s({ colleague: true }) }))).toBe(EXIT_REASONS.topic);
    expect(reason(base({ sender: s({ kind: null }) }))).toBe(EXIT_REASONS.topic);
    expect(reason(base({ topic: null }))).toBe(EXIT_REASONS.topic);
    expect(reason(base({ topic: { ...topic, retiredAt: new Date() } }))).toBe(EXIT_REASONS.topic);
    expect(reason(base({ topic: { ...topic, autoReply: false } }))).toBe(EXIT_REASONS.topic);
    expect(reason(base({ topic: { ...topic, appliesTo: 'supplier' } }))).toBe(EXIT_REASONS.topic);
    expect(reason(base({ topic: { ...topic, appliesTo: 'client' } }))).toBe('ok');
  });

  it('6: only a question', () => {
    for (const kind of ['request', 'commitment', 'courtesy', 'unclassified'] as const) {
      const classification = { kind, topicId: 't1', summary: '', window: null };
      expect(reason(base({ classification }))).toBe(EXIT_REASONS.notQuestion);
    }
  });

  it('first failure wins', () => {
    expect(reason(base({ draft: 'ב-13/11', tier3Used: true, topic: null }))).toBe(EXIT_REASONS.ungrounded);
  });

  describe('fix round 1', () => {
    const src = (text: string): ExitCheckInput['tier12'] =>
      [{ source: 'sent_invoices', label: 'x', text, documentId: null, at: null }] as ExitCheckInput['tier12'];
    const cases: Array<[string, string, string]> = [
      ['dash date', 'שולם ב-12-11', 'שולם ב-13-11'],
      ['range', 'הסכום 450-600 ש״ח', 'הסכום 450-700 ש״ח'],
      ['phone-like', 'התקשרי 050-1111111', 'התקשרי 050-2222222'],
      ['slash amount', 'עלות 450/חודש', 'עלות 460/חודש'],
      ['slash thousands', 'סך 5,000/10,000', 'סך 5,000/11,000'],
      ['url', 'https://pay.x.co/inv/98765', 'https://pay.x.co/inv/98766'],
      ['time seconds', 'בשעה 12:30:45', 'בשעה 12:30:46'],
      ['suffix', 'דגם 100-A', 'דגם 101-A'],
    ];
    for (const [name, good, bad] of cases) {
      it(`digit runs: ${name}`, () => {
        expect(reason(base({ draft: good, tier12: src(good) }))).toBe('ok');
        expect(reason(base({ draft: bad, tier12: src(good) }))).toBe(EXIT_REASONS.ungrounded);
      });
    }
    it('thousands commas are stripped before comparing', () => {
      expect(reason(base({ draft: 'סך 5,000', tier12: src('סך 5000') }))).toBe('ok');
    });
    it('non-ASCII digits fail, even folded or split by zero-width', () => {
      const t12 = src('סך 100');
      expect(reason(base({ draft: '٣٠٠ ש״ח', tier12: t12 }))).toBe(EXIT_REASONS.ungrounded);
      expect(reason(base({ draft: '５００ ש״ח', tier12: t12 }))).toBe(EXIT_REASONS.ungrounded);
      expect(reason(base({ draft: '5\u200b000 ש״ח', tier12: t12 }))).toBe(EXIT_REASONS.ungrounded);
      expect(reason(base({ draft: '٣٠٠ ש״ח', tier12: [] }))).toBe(EXIT_REASONS.ungrounded);
      expect(reason(base({ draft: 'סך 100', tier12: t12 }))).toBe('ok');
    });
    it('phone next to another number is still caught', () => {
      const o = { names: [], emails: [], phoneKeys: ['972541234567'] };
      const t12 = src('3 054-1234567');
      expect(reason(base({ draft: 'חשבונית 3 054-1234567', tier12: t12, otherPeople: o }))).toBe(EXIT_REASONS.otherPerson);
      expect(reason(base({ draft: 'חשבונית 3 054-1234567', tier12: t12, otherPeople: { ...o, phoneKeys: ['972549999999'] } }))).toBe('ok');
    });
    it('a source decimal does not ground a draft date through the date layer', () => {
      expect(reason(base({ draft: 'ב-3/11', tier12: src('3.11') }))).toBe(EXIT_REASONS.ungrounded);
      expect(reason(base({ draft: 'ב-3/11', tier12: src('3/11') }))).toBe('ok');
      expect(reason(base({ draft: 'ב-3/11', tier12: src('3.11.2026') }))).toBe('ok');
    });
    it('collapses whitespace before name matching', () => {
      const o = { names: ['דנה לוי'], emails: [], phoneKeys: [] };
      const s = { ...base().sender, name: 'אחר' };
      expect(reason(base({ draft: 'שאלי את דנה  לוי', sender: s, otherPeople: o }))).toBe(EXIT_REASONS.otherPerson);
      expect(reason(base({ draft: 'שאלי את דנה', sender: s, otherPeople: o }))).toBe('ok');
    });
  });
});
