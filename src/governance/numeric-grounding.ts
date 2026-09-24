/**
 * The cheapest hallucination detector in this codebase, and it costs zero
 * tokens: every number a draft states must trace to a number the
 * deterministic extraction of the source document actually carries. This
 * runs against that extraction — never against what a model said about the
 * document — so it catches a model inventing a figure the source never
 * mentions.
 */

/** Every digit run in a string, normalised to compare values, not formatting. */
const NUMBER_PATTERN = /\d[\d,]*(?:\.\d+)?/g;

/**
 * Strip thousands separators and trailing decimal zeros so `11,988.00` and
 * `11988` compare equal. Comparing raw strings would report every correctly
 * copied amount as a hallucination — the separators and the currency
 * formatting around a number are not part of its value.
 */
function normaliseNumber(raw: string): string {
  let normalised = raw.replace(/,/g, '');
  if (normalised.includes('.')) {
    normalised = normalised.replace(/0+$/, '').replace(/\.$/, '');
  }
  return normalised;
}

function numbersIn(text: string): string[] {
  const matches = text.match(NUMBER_PATTERN);
  return matches ? matches.map(normaliseNumber) : [];
}

/**
 * Numbers in `draft` that no entry in `sources` carries, each returned in
 * its normalised form (not the draft's original formatting).
 *
 * An empty `sources` list means nothing was extracted from the document —
 * not that the document carries no numbers. This is a `must` criterion, so a
 * false positive here blocks a send; reporting every number as ungrounded
 * when there is nothing to compare against would fire the control loudest
 * exactly when it knows least. So an empty source list grounds everything.
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
