import { describe, expect, it } from 'vitest';
import { ungroundedNumbers } from './numeric-grounding.js';

describe('ungroundedNumbers', () => {
  it('returns nothing when every number in the draft appears in a source', () => {
    expect(ungroundedNumbers('הסכום 11,988 ש"ח עד 15/10', ['סה"כ 11988', 'תאריך 15/10'])).toEqual([]);
  });

  it('names a number the sources never carry', () => {
    expect(ungroundedNumbers('הסכום 12,500 ש"ח', ['סה"כ 11988'])).toEqual(['12500']);
  });

  /**
   * Thousands separators and currency symbols are formatting, not value.
   * Comparing the raw strings would report every correctly copied amount.
   */
  it('compares values, not formatting', () => {
    expect(ungroundedNumbers('11,988.00', ['11988'])).toEqual([]);
  });

  /**
   * The check is a `must` criterion, so a false positive is a blocked send.
   * An empty source list means nothing was extracted, and reporting every
   * number as ungrounded there would make the control fire loudest exactly
   * when it knows least.
   */
  it('reports nothing when there are no sources to compare against', () => {
    expect(ungroundedNumbers('11,988', [])).toEqual([]);
  });
});
