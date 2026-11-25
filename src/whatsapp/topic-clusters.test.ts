import { describe, expect, it } from 'vitest';
import { H8_STEMS, H8_WORDS, NEW_TOPIC_MIN_DECISIONS, parseClusters } from './topic-clusters.js';

type Row = { decisionId: string; sourceNames: string[]; approved: boolean; contactKind: 'client' | 'supplier' | 'unknown' };
const rows = (n: number, over: Partial<Row> = {}): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    decisionId: `d${i}`,
    sourceNames: ['uploaded_invoices'],
    approved: true,
    contactKind: 'client',
    ...over,
  }));
const ctx = (r: Row[], extra: { existingTopicNames?: string[]; contactNames?: string[] } = {}) => ({
  rows: r,
  existingTopicNames: extra.existingTopicNames ?? [],
  contactNames: extra.contactNames ?? [],
});
const group = (name: string, indexes: number[], description = 'שאלות על משלוחים') => ({
  groups: [{ name, description, indexes }],
});

describe('parseClusters', () => {
  it('thresholds', () => expect(NEW_TOPIC_MIN_DECISIONS).toBe(5));
  it('keeps a valid group of 5 with sources from approved rows only', () => {
    const r = rows(5);
    r[0]!.sourceNames = ['uploaded_invoices', 'bogus'];
    r[1]!.approved = false;
    r[1]!.sourceNames = ['sent_invoices'];
    const out = parseClusters(group('סטטוס משלוח', [0, 1, 2, 3, 4]), ctx(r));
    expect(out).toHaveLength(1);
    expect(out[0]!.sources).toEqual(['uploaded_invoices']);
    expect(out[0]!.appliesTo).toBe('client');
    expect(out[0]!.decisionIds).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
  });
  it('drops a group of 4', () => {
    expect(parseClusters(group('סטטוס משלוח', [0, 1, 2, 3]), ctx(rows(5)))).toEqual([]);
  });
  it('drops an out-of-range index, leaving 4', () => {
    expect(parseClusters(group('סטטוס משלוח', [0, 1, 2, 3, 99]), ctx(rows(5)))).toEqual([]);
  });
  it('an index repeated across groups is dropped from the later one', () => {
    const raw = {
      groups: [
        { name: 'אחד', description: 'x', indexes: [0, 1, 2, 3, 4] },
        { name: 'שניים', description: 'y', indexes: [0, 5, 6, 7, 8] },
      ],
    };
    const out = parseClusters(raw, ctx(rows(9)));
    expect(out.map((o) => o.name)).toEqual(['אחד']);
  });
  it('drops H8 words as whole words, not substrings', () => {
    expect(H8_WORDS).toContain('עלות');
    expect(parseClusters(group('עלות משלוח', [0, 1, 2, 3, 4]), ctx(rows(5)))).toEqual([]);
    expect(parseClusters(group('משלוח', [0, 1, 2, 3, 4], 'שאלות על העלות'), ctx(rows(5)))).toEqual([]);
    expect(H8_STEMS).toContain('עלוי');
    // accepted: substring containment also drops "בעלות" (ownership)
    expect(parseClusters(group('בעלות משלוח', [0, 1, 2, 3, 4]), ctx(rows(5)))).toEqual([]);
  });
  it('drops plural and construct forms of H8 words', () => {
    for (const n of ['עלויות משלוח', 'הנחות ללקוחות', 'עמלות', 'רווחים', 'מחיר הקנייה']) {
      expect(parseClusters(group(n, [0, 1, 2, 3, 4]), ctx(rows(5)))).toEqual([]);
    }
  });
  it('H8 stems match across irregular whitespace', () => {
    for (const n of ['מחיר  הקנייה', 'מחיר\nקנייה', 'מחיר\tקנייה']) {
      expect(parseClusters(group(n, [0, 1, 2, 3, 4]), ctx(rows(5)))).toEqual([]);
    }
  });
  it('a rejected group does not consume its indexes', () => {
    const raw = {
      groups: [
        { name: 'עלויות', description: 'x', indexes: [0, 1, 2, 3, 4] },
        { name: 'משלוחים', description: 'y', indexes: [0, 1, 2, 3, 4] },
      ],
    };
    expect(parseClusters(raw, ctx(rows(5))).map((o) => o.name)).toEqual(['משלוחים']);
  });
  it('two kept groups with the same name give one payload', () => {
    const raw = {
      groups: [
        { name: 'משלוחים', description: 'x', indexes: [0, 1, 2, 3, 4] },
        { name: ' משלוחים ', description: 'y', indexes: [5, 6, 7, 8, 9] },
      ],
    };
    expect(parseClusters(raw, ctx(rows(10)))).toHaveLength(1);
  });
  it('drops a name containing a managed contact name', () => {
    expect(parseClusters(group('הזמנות של רונית', [0, 1, 2, 3, 4]), ctx(rows(5), { contactNames: ['רונית'] }))).toEqual([]);
    expect(parseClusters(group('הזמנות', [0, 1, 2, 3, 4]), ctx(rows(5), { contactNames: ['רונית'] }))).toHaveLength(1);
  });
  it('drops a name equal to an existing topic (spaces/case differ)', () => {
    expect(
      parseClusters(group('  Opening   Hours ', [0, 1, 2, 3, 4]), ctx(rows(5), { existingTopicNames: ['opening hours'] })),
    ).toEqual([]);
  });
  it('enforces name and description length', () => {
    expect(parseClusters(group('א', [0, 1, 2, 3, 4]), ctx(rows(5)))).toEqual([]);
    expect(parseClusters(group('א'.repeat(41), [0, 1, 2, 3, 4]), ctx(rows(5)))).toEqual([]);
    expect(parseClusters(group('נושא', [0, 1, 2, 3, 4], 'א'.repeat(201)), ctx(rows(5)))).toEqual([]);
  });
  it('mixed kinds give both', () => {
    const r = rows(5);
    r[0]!.contactKind = 'supplier';
    expect(parseClusters(group('נושא', [0, 1, 2, 3, 4]), ctx(r))[0]!.appliesTo).toBe('both');
  });
  it('garbage gives []', () => {
    for (const g of [null, 'x', 3, {}, { groups: 'x' }, { groups: [{ name: 1 }] }, { groups: [], extra: 1 }]) {
      expect(parseClusters(g, ctx(rows(5)))).toEqual([]);
    }
  });
});
