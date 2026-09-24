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
   * A false positive here does not block a send — nothing is conditioned on
   * this verdict — but it still costs trust: a control that fires when
   * nothing happened teaches an owner to click past it. An empty source list
   * means nothing was extracted, not that the document carries no numbers,
   * so it would fire loudest exactly when it knows least.
   */
  it('reports nothing when there are no sources to compare against', () => {
    expect(ungroundedNumbers('11,988', [])).toEqual([]);
  });

  /**
   * A source chunk with no digits at all is a plausible real input (plain
   * prose alongside a chunk that does carry the amount). This exercises the
   * branch that handles a digit-free string without throwing.
   */
  it('tolerates a source with no digits at all', () => {
    expect(ungroundedNumbers('הסכום 11988', ['זהו טקסט ללא ספרות בכלל', 'סה"כ 11988'])).toEqual([]);
  });

  /**
   * A digit run adjacent to '/', '-' or ':' is a date, a time, a phone
   * number, or a range — not a quantity — and is excluded before the
   * comparison even runs. Extracted from a full draft body (Task 10's real
   * shape), essentially every real message carries a date or a phone number,
   * and without this exclusion the check would fire on almost all of them.
   * The genuine amount alongside all that noise is still caught when it
   * disagrees with the source.
   */
  it('excludes dates, times, phone numbers and ranges as noise, not amounts', () => {
    const draft =
      'הזמנה מספר 050-1234567 בסך 12,500 ש"ח בתאריך 15/10 בשעה 10:30, טווח 10-20';
    expect(ungroundedNumbers(draft, ['סכום כולל 11988'])).toEqual(['12500']);
  });

  /**
   * Money is the whole reason this check exists, so sign must survive
   * normalisation: a credit written as "-500" is not the same value as a
   * debit of "500", and grounding them against each other would silently
   * launder the inversion. A leading '-' not preceded by a digit is a sign;
   * both readings are tested, alongside the adjacency exclusion from the
   * case above so the two rules don't cancel each other out.
   */
  it('keeps a negative amount distinct from its positive counterpart', () => {
    expect(ungroundedNumbers('זיכוי בסך -500 ש"ח', ['חיוב 500 ש"ח'])).toEqual(['-500']);
  });

  it('grounds a negative amount against a source that carries the same sign', () => {
    expect(ungroundedNumbers('זיכוי בסך -500 ש"ח', ['רישום זיכוי -500 ש"ח'])).toEqual([]);
  });

  /**
   * A dash after a digit run is not always noise: "500-" is the standard
   * Israeli and spreadsheet way of writing a negative balance, and a source
   * that writes it that way must ground a draft that writes "-500" — the
   * same value, spelled with the sign on the other side. Before this rule
   * existed both sides simply dropped the sign and compared as "500"; now
   * that the sign is carried, both spellings of "the same negative number"
   * must still agree with each other.
   */
  it('reads a trailing minus as a sign, not as range noise', () => {
    expect(ungroundedNumbers('זיכוי בסך -500 ש"ח', ['יתרה 500-'])).toEqual([]);
  });

  /**
   * A dash BETWEEN two digit runs is still a range, whether or not the
   * numbers happen to be four digits — this is the reading that must not
   * regress when a trailing dash starts being read as a sign.
   */
  it('still drops a multi-digit range as noise on both sides', () => {
    expect(ungroundedNumbers('טווח 1500-2000', ['אין כאן שום סכום'])).toEqual([]);
  });
});
