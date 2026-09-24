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
 * reaches the draft embedded in a date or an identifier is not checked at
 * all — a hallucinated invoice number shaped like `2024-99999`, or an order
 * id the business itself assigned, passes silently. Telling "this is an
 * amount" from "this is an id" is exactly the judgement call the adjacency
 * rule refuses to make; it only ever asks what character is touching the
 * digits.
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
 */

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
 * read two different things off the same character: `-500` is a negative
 * amount (the money this whole check exists for — a draft that turns a
 * credit into a debit must not silently ground), while `10-20` and
 * `050-1234567` are a range and a phone number, where the `-` belongs to
 * neither digit run on either side of it. The distinguishing question is
 * "is there a digit immediately before the `-`": if yes, the `-` sits
 * BETWEEN two digit runs and both are noise; if no (start of string,
 * whitespace, punctuation), the `-` is a sign attached to what follows.
 * A `-` immediately AFTER a digit run is never a sign — nothing negates
 * backwards — so that side only ever means "noise, part of a range or id".
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
      sign = '-'; // leading sign, e.g. "-500"
    }
    if (nextChar === '-') continue; // first half of a range or phone number

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
