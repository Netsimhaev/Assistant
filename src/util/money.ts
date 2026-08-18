/**
 * Money formatting for anything a human reads.
 *
 * Money is stored and reasoned about as an integer count of minor units
 * (agorot / cents) everywhere in the system — see `readAmountMinor` in
 * src/policy/facts.ts, which rejects a decimal rather than rounding it. This is
 * the single place that turns those integers back into something readable, so
 * an approval card, a denial reason and the signed plain-language charter all
 * render the same amount identically.
 *
 * Grouping is en-US regardless of the business's language: `₪10,000` reads
 * correctly in a Hebrew sentence, and switching the separator per locale would
 * make the signed charter text depend on the reader's environment.
 */
export function formatMinor(minor: number, currency: string): string {
  const symbol = currency === 'ILS' ? '₪' : `${currency} `;
  return `${symbol}${(minor / 100).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}
