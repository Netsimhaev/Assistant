import { describe, expect, it } from 'vitest';
import { parseClassification } from './contact-classification.js';

const now = new Date('2026-11-24T10:00:00Z');
const ctx = (texts: string[] = ['שלום']) => ({ topicIds: new Set(['T1']), texts, now });
const base = { kind: 'question', topicId: 'T1', summary: 's', window: null };

describe('parseClassification', () => {
  it('keeps courtesy for a short text', () => {
    expect(parseClassification({ ...base, kind: 'courtesy' }, ctx(['תודה'])).kind).toBe('courtesy');
  });
  it('courtesy with a 41-char text is unclassified', () => {
    expect(parseClassification({ ...base, kind: 'courtesy' }, ctx(['א'.repeat(41)])).kind).toBe('unclassified');
  });
  it('courtesy with no texts is unclassified', () => {
    expect(parseClassification({ ...base, kind: 'courtesy' }, ctx([])).kind).toBe('unclassified');
  });
  it('courtesy needs every text to be short', () => {
    expect(parseClassification({ ...base, kind: 'courtesy' }, ctx(['תודה', 'א'.repeat(41)])).kind).toBe('unclassified');
  });
  it('keeps a window of exactly 7 days, drops one ending at now', () => {
    const seven = { from: '2026-11-25T08:00:00Z', to: '2026-12-02T08:00:00Z' };
    expect(parseClassification({ ...base, window: seven }, ctx()).window).not.toBeNull();
    const atNow = { from: '2026-11-24T09:00:00Z', to: '2026-11-24T10:00:00Z' };
    expect(parseClassification({ ...base, window: atNow }, ctx()).window).toBeNull();
  });
  it('unknown topic id becomes null', () => {
    const r = parseClassification({ ...base, topicId: 'X' }, ctx());
    expect(r.kind).toBe('question');
    expect(r.topicId).toBeNull();
  });
  it('garbage is unclassified', () => {
    expect(parseClassification('x', ctx())).toEqual({ kind: 'unclassified', topicId: null, summary: '', window: null });
    expect(parseClassification({ ...base, extra: 1 }, ctx()).kind).toBe('unclassified');
  });
  it('keeps a valid window', () => {
    const w = parseClassification(
      { ...base, window: { from: '2026-11-25T08:00:00+02:00', to: '2026-11-25T12:00:00+02:00' } },
      ctx(),
    ).window;
    expect(w).not.toBeNull();
    expect(w!.to.getTime()).toBeGreaterThan(w!.from.getTime());
  });
  it('rejects an 8-day window', () => {
    const window = { from: '2026-11-25T08:00:00Z', to: '2026-12-03T08:00:00Z' };
    expect(parseClassification({ ...base, window }, ctx()).window).toBeNull();
  });
  it('rejects a window without offset', () => {
    const window = { from: '2026-11-25T08:00:00', to: '2026-11-25T12:00:00' };
    expect(parseClassification({ ...base, window }, ctx()).window).toBeNull();
  });
  it('rejects a window in the past and a reversed one', () => {
    const past = { from: '2026-11-20T08:00:00Z', to: '2026-11-21T08:00:00Z' };
    const rev = { from: '2026-11-26T08:00:00Z', to: '2026-11-25T08:00:00Z' };
    expect(parseClassification({ ...base, window: past }, ctx()).window).toBeNull();
    expect(parseClassification({ ...base, window: rev }, ctx()).window).toBeNull();
  });
  it('cleans the summary to one short line', () => {
    const r = parseClassification({ ...base, summary: `a‮b\nc${'x'.repeat(300)}` }, ctx());
    expect(r.summary).not.toMatch(/[‮\n]/);
    expect(r.summary.length).toBeLessThanOrEqual(200);
  });
});
