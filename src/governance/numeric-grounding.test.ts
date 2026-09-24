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

  /**
   * A trailing dash is only a sign when nothing is glued to its far side —
   * "100-A" is a model or lot code, not a negative 100, and a letter right
   * after the dash proves it the same way a digit does for "1500-2000".
   * Before this rule, only a digit after the dash was checked, so "100-A"
   * read as "-100" and a source carrying it would silently ground an
   * unrelated genuine "-100" credit in the draft — a false grounding this
   * test guards against directly.
   */
  it('drops a number before a letter-suffixed dash as an identifier, not a sign', () => {
    expect(ungroundedNumbers('דגם 100-A', ['אין כאן שום סכום'])).toEqual([]);
  });

  it('does not let a model code ground an unrelated negative amount', () => {
    expect(ungroundedNumbers('זיכוי בסך -100 ש"ח', ['דגם 100-A'])).toEqual(['-100']);
  });

  /**
   * Fix round 3, item 1. `ו-950`, `ב-11,988`, `ל-7.5` are the ordinary Hebrew
   * way to write "and 950", "for 11,988", "to 7.5" — before this fix each
   * normalised to a NEGATIVE number (`-950`, `-11988`, `-7.5`), matched
   * nothing in a source that (correctly) carries the unsigned amount, and
   * landed on the owner's card as ungrounded on an ordinary business letter.
   * `LEADING_HEBREW_PARTICLE` (`typed-recipients.ts`) is the shared source
   * for the particle letters — the same one `contact-resolver.ts` already
   * reuses rather than duplicating.
   */
  describe('a Hebrew prefix particle glued onto the dash is a prefix, not a sign', () => {
    it('grounds "ו-950" (and 950) against the unsigned source', () => {
      expect(ungroundedNumbers('קיבלת ו-950 ש"ח', ['תיעוד: 950 ש"ח'])).toEqual([]);
    });

    it('grounds "ב-11,988" (for 11,988) against the unsigned source', () => {
      expect(ungroundedNumbers('התשלום ב-11,988 ש"ח', ['סה"כ 11988'])).toEqual([]);
    });

    it('grounds "ל-7.5" (to 7.5) against the unsigned source', () => {
      expect(ungroundedNumbers('עדכון ל-7.5 אחוז', ['הריבית עודכנה ל7.5'])).toEqual([]);
    });

    /**
     * Every other dash rule, exercised in the SAME draft, so the particle fix
     * cannot be shown to hold only in isolation from them: a leading `-` with
     * no particle before it is still a sign; a dash between two digit runs is
     * still a range; a phone number's dash is still noise on both sides; a
     * hyphen preceded by a non-particle LETTER (`ORDER-12345`) still misreads
     * as a sign, the documented limit; and a trailing dash is still a sign
     * that can ground a leading one written the other way.
     */
    it('holds together with every other dash rule in one draft', () => {
      const draft =
        'קיבלת ו-950 ש"ח, זיכוי בסך -500 ש"ח, טווח 1500-2000, ' +
        'טלפון 052-1234567, דגם ORDER-12345, יתרה 500-';
      const sources = ['תיעוד: 950 ש"ח', 'רישום: 500-'];

      // "950" grounds via the particle fix; both spellings of "-500" (leading
      // and trailing) ground via the source's "500-"; "1500-2000" and
      // "052-1234567" are dropped as range/phone noise on both sides and
      // never even compared; "-12345" — the `ORDER-12345` limit — has no
      // source and is the only survivor.
      expect(ungroundedNumbers(draft, sources)).toEqual(['-12345']);
    });

    /**
     * Fix round 4, item 1. Round 3's version of this rule checked only the
     * single character before the dash, not what precedes THAT character —
     * so any word simply ENDING in one of the seven particle letters (`ה` is
     * the most common word-final letter in Hebrew) was misread as a prefix
     * too. `הנחה-500` ("a discount of 500", positive) normalised to `-500`
     * and matched nothing in a source carrying the unsigned amount — a real
     * credit/debit inversion silently grounded, measured by transpiling and
     * running round 3's code. Nothing pinned this word-ending behaviour
     * either way before now.
     */
    it('does NOT treat a word merely ending in a particle letter as a prefix (false negative on money)', () => {
      expect(ungroundedNumbers('הנחה-500 ש"ח', ['סכום 500 ש"ח'])).toEqual(['-500']);
      expect(ungroundedNumbers('יתרה-1,200 ש"ח לזכותך', ['יתרה 1200 ש"ח'])).toEqual(['-1200']);
    });
  });
});
