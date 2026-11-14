import { describe, expect, it } from 'vitest';
import { DESCRIPTION_PROPOSALS_MAX, parseDescriptionProposals } from './description-proposals.js';
import { sentenceHash } from './sentence.js';

const NONE = { rejectedHashes: new Set<string>(), existingTexts: [] as string[] };

const forbidQuote = (sentence: string) => ({ sentence, kind: 'forbid', actionClasses: ['quote.issue'] });

describe('parseDescriptionProposals', () => {
  it("keeps a forbid whose sentence appears verbatim, with the owner's sentence as rule text", () => {
    const description = 'אנחנו מספרה בתל אביב. לעולם לא להוציא הצעת מחיר בלי אישורי. שעות: א-ה.';
    const raw = JSON.stringify([forbidQuote('לעולם לא להוציא הצעת מחיר בלי אישורי.')]);
    expect(parseDescriptionProposals(raw, description, NONE)).toEqual([
      { kind: 'forbid', text: 'לעולם לא להוציא הצעת מחיר בלי אישורי.', actionClasses: ['quote.issue'] },
    ]);
  });

  it('matches a sentence across CRLF, nbsp and doubled spaces', () => {
    // Description is messy, quote is clean: text is the original substring.
    const messy = 'פתיח. לא\r\n  לתת  הנחות. סוף.';
    const r1 = parseDescriptionProposals(JSON.stringify([forbidQuote('לא לתת הנחות')]), messy, NONE);
    expect(r1).toHaveLength(1);
    expect(r1[0]?.text).toBe('לא\r\n  לתת  הנחות');

    // Description is clean, quote is messy: text is still the description's bytes.
    const clean = 'פתיח. לא לתת הנחות. סוף.';
    const r2 = parseDescriptionProposals(JSON.stringify([forbidQuote('  לא\r\n  לתת  הנחות ')]), clean, NONE);
    expect(r2).toHaveLength(1);
    expect(r2[0]?.text).toBe('לא לתת הנחות');
  });

  it('matches case-insensitively on Latin letters and keeps the original case', () => {
    const description = 'Never call RIVAL.CO.IL about anything.';
    const raw = JSON.stringify([
      { sentence: 'never call rival.co.il about anything.', kind: 'do_not_contact', label: 'Rival', emailDomain: 'rival.co.il' },
    ]);
    const out = parseDescriptionProposals(raw, description, NONE);
    expect(out[0]?.text).toBe('Never call RIVAL.CO.IL about anything.');
    expect(out[0]?.kind).toBe('do_not_contact');
  });

  it('drops an item whose sentence is not in the description', () => {
    const description = 'לא לתת הנחות ללקוחות חדשים.';
    const raw = JSON.stringify([forbidQuote('אסור לתת הנחה ללקוח חדש')]);
    expect(parseDescriptionProposals(raw, description, NONE)).toEqual([]);
  });

  it('drops an item with a missing, empty or non-string sentence', () => {
    const description = 'לא לתת הנחות.';
    const raw = JSON.stringify([
      { kind: 'forbid', actionClasses: ['quote.issue'] },
      { sentence: '   ', kind: 'forbid', actionClasses: ['quote.issue'] },
      { sentence: 42, kind: 'forbid', actionClasses: ['quote.issue'] },
    ]);
    expect(parseDescriptionProposals(raw, description, NONE)).toEqual([]);
  });

  it('drops guidance and any item that parseRuleProposal falls back to guidance', () => {
    const description = 'אנחנו אוהבים לקוחות. לא להבטיח דבר. לא לעבוד עם מתחרים.';
    const raw = JSON.stringify([
      { sentence: 'אנחנו אוהבים לקוחות.', kind: 'guidance' },
      { sentence: 'לא להבטיח דבר.', kind: 'forbid', actionClasses: ['not.a.class'] },
      { sentence: 'לא לעבוד עם מתחרים.', kind: 'do_not_contact', label: 'x', emailDomain: '*.rival.co.il' },
    ]);
    expect(parseDescriptionProposals(raw, description, NONE)).toEqual([]);
  });

  it('drops a sentence over 500 characters', () => {
    const long = `לא לתת הנחות ${'א'.repeat(500)}`;
    const description = `פתיח. ${long}. סוף.`;
    const raw = JSON.stringify([{ sentence: long, kind: 'never_say', phrase: 'הנחה' }]);
    expect(parseDescriptionProposals(raw, description, NONE)).toEqual([]);
  });

  it('drops a rejected sentence and one already pending or accepted', () => {
    const description = 'לא לתת הנחות. לא להבטיח תוצאות. לא לכתוב "מובטח".';
    const raw = JSON.stringify([
      forbidQuote('לא לתת הנחות.'),
      forbidQuote('לא להבטיח תוצאות.'),
      { sentence: 'לא לכתוב "מובטח".', kind: 'never_say', phrase: 'מובטח' },
    ]);
    const out = parseDescriptionProposals(raw, description, {
      rejectedHashes: new Set([sentenceHash('לא  לתת הנחות.')]),
      existingTexts: ['לא להבטיח\nתוצאות.'],
    });
    expect(out).toEqual([{ kind: 'never_say', text: 'לא לכתוב "מובטח".', phrase: 'מובטח' }]);
  });

  it('drops a second item quoting the same sentence', () => {
    const description = 'לא לתת הנחות.';
    const raw = JSON.stringify([forbidQuote('לא לתת הנחות.'), forbidQuote('לא  לתת הנחות.')]);
    expect(parseDescriptionProposals(raw, description, NONE)).toHaveLength(1);
  });

  it("returns at most 10, in the model's order", () => {
    const sentences = Array.from({ length: 14 }, (_, i) => `כלל מספר ${i + 1} לא לתת הנחות.`);
    const description = sentences.join(' ');
    const raw = JSON.stringify(sentences.map((s) => forbidQuote(s)));
    const out = parseDescriptionProposals(raw, description, NONE);
    expect(DESCRIPTION_PROPOSALS_MAX).toBe(10);
    expect(out.map((r) => r.text)).toEqual(sentences.slice(0, 10));
  });

  it('accepts a stream of objects wrapped in prose', () => {
    const description = 'לא לתת הנחות. לא להבטיח תוצאות.';
    const raw = `הנה ההצעות:\n${JSON.stringify(forbidQuote('לא לתת הנחות.'))}\n${JSON.stringify(
      forbidQuote('לא להבטיח תוצאות.'),
    )}`;
    expect(parseDescriptionProposals(raw, description, NONE).map((r) => r.text)).toEqual([
      'לא לתת הנחות.',
      'לא להבטיח תוצאות.',
    ]);
  });

  it('returns [] on unparseable output', () => {
    expect(parseDescriptionProposals('not json at all', 'לא לתת הנחות.', NONE)).toEqual([]);
    expect(parseDescriptionProposals('[{"sentence": ', 'לא לתת הנחות.', NONE)).toEqual([]);
    expect(parseDescriptionProposals('', 'לא לתת הנחות.', NONE)).toEqual([]);
  });
});
