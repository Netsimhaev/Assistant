/**
 * The cheapest hallucination detector in this codebase, and it costs zero
 * tokens: every number a draft states must trace to a number the
 * deterministic extraction of the source document actually carries. This
 * runs against that extraction — never against what a model said about the
 * document — so it catches a model inventing a figure the source never
 * mentions.
 *
 * **A false positive here does not block a send.** The verdict this feeds
 * appears on the approval card the owner already sees; nothing — not a send,
 * not a job closing — is conditioned on it. But it is not harmless: a
 * control that lights up when nothing happened teaches an owner to click
 * past it, and then it catches nothing when it matters. So the check below
 * is narrowed on purpose, not left maximally paranoid.
 *
 * **Excluded, positively, not by magnitude:** a digit run immediately
 * adjacent to `/`, `-` or `:` in the ORIGINAL text — the shape of a date, a
 * time, a phone number, or a numeric range. A magnitude threshold would have
 * thrown away small real amounts too (`500` looks exactly like a phone
 * fragment by size alone); an adjacency rule does not, and "what character
 * sits next to it" is checkable and explainable in a way "probably not a
 * quantity" is not.
 *
 * **What this does NOT catch, and never will by design:** a number that
 * reaches the draft embedded in a date or a DIGIT-SHAPED identifier is not
 * checked at all — a hallucinated invoice number shaped like `2024-99999`
 * passes silently. (A LETTER-prefixed identifier like `ORDER-12345` is a
 * different, narrower failure — see the known limits below.) Telling "this
 * is an amount" from "this is an id" is exactly the judgement call the
 * adjacency rule refuses to make; it only ever asks what character is
 * touching the digits.
 *
 * **Known limits, left as limits, not bugs to rediscover later:**
 * - European decimal formatting (`11.988,00` meaning eleven thousand, nine
 *   hundred eighty-eight) tokenises into two separate runs — `11.988` read
 *   as a decimal, and `00` — and matches nothing sensible against `11988`.
 *   Low-probability in this market; not worth code today.
 * - Leading zeros are not stripped while trailing decimal zeros are, so
 *   `052` and `52` compare unequal. Same call.
 * - A hyphen preceded by a LETTER, as in an identifier like `ORDER-12345`,
 *   reads as a leading sign on `12345` rather than as separator noise: the
 *   sign/separator rule below only asks whether the character before the
 *   hyphen is a *digit*, not whether the hyphen sits inside an identifier.
 *   Narrowed for Hebrew (fix round 3, item 1): a hyphen preceded specifically
 *   by a Hebrew PREFIX PARTICLE (`ל`/`ב`/`מ`/`ה`/`ו`/`כ`/`ש` —
 *   `LEADING_HEBREW_PARTICLE`, `typed-recipients.ts`) is a glued-on prefix,
 *   never a sign — `ו-950`, `ב-11,988`, `ל-7.5` are the ordinary Hebrew way to
 *   write "and 950", "for 11,988", "to 7.5", not negative numbers. A hyphen
 *   preceded by any OTHER letter (`ORDER-12345`) still misreads as a sign;
 *   that narrower case remains the limit.
 * - Two genuine amounts either side of a slash, as in `שולם 5,000/10,000`,
 *   are both dropped by the `/`-adjacency rule — the same rule that
 *   correctly drops a date. An adjacency rule cannot tell "date" from "two
 *   real numbers separated by a slash" because it never looks past the one
 *   character touching the digits; this is the cost of the narrowing
 *   above, not a bug to fix separately from it.
 */
import { LEADING_HEBREW_PARTICLE } from './typed-recipients.js';

/** Digit runs with optional thousands separators and a decimal tail. */
const NUMBER_PATTERN = /\d[\d,]*(?:\.\d+)?/g;

/**
 * Strip thousands separators and trailing decimal zeros so `11,988.00` and
 * `11988` compare equal. Comparing raw strings would report every correctly
 * copied amount as a hallucination — the separators and the currency
 * formatting around a number are not part of its value. `raw` never carries
 * a sign; that is applied by the caller, which is the only place that has
 * seen the surrounding text.
 */
function normaliseNumber(raw: string): string {
  let normalised = raw.replace(/,/g, '');
  if (normalised.includes('.')) {
    normalised = normalised.replace(/0+$/, '').replace(/\.$/, '');
  }
  return normalised;
}

/**
 * Every digit run in `text`, normalised, minus the ones adjacent to `/`,
 * `-` or `:` — dates, times, phone numbers and ranges — and with a leading
 * minus sign carried through when it is one.
 *
 * The sign/separator split on `-` is the one place this function has to
 * read two different things off the same character: `-500` and `500-` are
 * both negative amounts (the money this whole check exists for — a draft
 * that turns a credit into a debit must not silently ground; `500-` is the
 * standard Israeli and spreadsheet way of writing a negative balance),
 * while `10-20` and `050-1234567` are a range and a phone number, where
 * the `-` belongs to neither digit run on either side of it — and
 * `100-A`, a model or lot code, is a third shape where the `-` belongs to
 * an identifier and the number must be dropped, not signed.
 *
 * The two sides are checked differently, and that is a real asymmetry, not
 * an oversight: a trailing sign can only be followed by whitespace,
 * punctuation, or the end of the string — nothing glues a letter or a
 * digit to the far side of a genuine trailing minus — so the trailing
 * check treats BOTH a digit and a letter past the dash as proof the `-`
 * belongs to something else and drops the run. The leading check only
 * tests for a digit before the dash; a leading `-` preceded by a letter
 * still misreads as a sign (`ORDER-12345` — the known limit documented
 * above), UNLESS that letter is a Hebrew prefix particle (below) — fixing
 * the general letter case is a separate, symmetric change to the leading
 * side that this round's fix — closing the trailing-side regression only —
 * did not make.
 *
 * **Fix round 3, item 1 — a Hebrew prefix particle glued onto the dash is a
 * PREFIX, never a sign.** `ו-950`, `ב-11,988`, `ל-7.5` are the ordinary
 * Hebrew way to write "and 950", "for 11,988", "to 7.5" — not `-950`,
 * `-11988`, `-7.5`. Before this fix every one of those normalised to a
 * negative number, matched nothing in the source (which carries the
 * unsigned form), and landed on the owner's card as ungrounded on an
 * ordinary business letter — the exact false-positive shape this module's
 * own docblock warns teaches an owner to click past the control, and a far
 * more common trigger than the spreadsheet-JSON regression round 2 closed.
 * `LEADING_HEBREW_PARTICLE` (`typed-recipients.ts`) is the shared,
 * one-definition source for the particle letters — reused here, not
 * duplicated, the same way `contact-resolver.ts` already reuses it. No
 * check of what sits before the particle is needed: even where a word
 * merely ENDS in one of these letters ("שלב-2", "stage-2"), reading the
 * dash as an unsigned prefix rather than a sign is still the more correct
 * of the two readings — nothing this rule does is worse than what it
 * replaces.
 */
function numbersIn(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const prevChar = start > 0 ? text[start - 1] : undefined;
    const nextChar = end < text.length ? text[end] : undefined;

    // Adjacent to '/' or ':' on either side — a date or a time, never a
    // quantity someone typed as an amount.
    if (prevChar === '/' || prevChar === ':' || nextChar === '/' || nextChar === ':') continue;

    let sign = '';
    if (prevChar === '-') {
      const charBeforeDash = start > 1 ? text[start - 2] : undefined;
      const dashSeparatesTwoRuns = charBeforeDash !== undefined && /\d/.test(charBeforeDash);
      if (dashSeparatesTwoRuns) continue; // e.g. "10-20", "050-1234567" — noise on both sides
      // "ו-950" and friends: the particle+dash is a glued-on prefix, not
      // part of the number's own text, so the run stays UNSIGNED — `sign`
      // is simply never set to '-' here.
      const hebrewPrefix =
        charBeforeDash !== undefined && LEADING_HEBREW_PARTICLE.test(text.slice(start - 2, start));
      if (!hebrewPrefix) sign = '-'; // leading sign, e.g. "-500"
    }
    if (nextChar === '-') {
      const charAfterDash = end + 1 < text.length ? text[end + 1] : undefined;
      // A digit past the dash means a range or a phone number ("1500-2000",
      // "050-1234567"); a LETTER past the dash means an identifier suffix
      // ("100-A", a model or lot code) — a genuine trailing sign is never
      // followed by either, only by whitespace, punctuation, or the end of
      // the string.
      const dashHasTokenAfter = charAfterDash !== undefined && /[\p{L}\p{N}]/u.test(charAfterDash);
      if (dashHasTokenAfter) continue;
      sign = '-'; // trailing sign, e.g. "500-" — the standard Israeli/spreadsheet negative
    }

    tokens.push(sign + normaliseNumber(match[0]));
  }
  return tokens;
}

/**
 * Numbers in `draft` that no entry in `sources` carries, each returned in
 * its normalised form (not the draft's original formatting).
 *
 * An empty `sources` list means nothing was extracted from the document —
 * not that the document carries no numbers. A false positive here still
 * costs trust even though it does not block a send (see the module
 * docblock), and reporting every number as ungrounded when there is nothing
 * to compare against would fire loudest exactly when the check knows least.
 * So an empty source list grounds everything.
 */
export function ungroundedNumbers(draft: string, sources: readonly string[]): string[] {
  if (sources.length === 0) return [];

  const grounded = new Set<string>();
  for (const source of sources) {
    for (const num of numbersIn(source)) grounded.add(num);
  }

  const ungrounded: string[] = [];
  for (const num of numbersIn(draft)) {
    if (!grounded.has(num)) ungrounded.push(num);
  }
  return ungrounded;
}
