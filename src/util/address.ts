/**
 * The one place a raw `to`-style fragment turns into an address.
 *
 * Both `readEmails` (screening, `src/policy/facts.ts`) and `readRecipients`
 * (delivery, `src/orchestrator/adapters/mail.ts`) call this on every
 * comma/semicolon-split fragment before doing anything else with it. They
 * differ in which *keys* they read off the payload — screening stays wider
 * than delivery, on purpose, per `readRecipients`'s own docblock — but they
 * must never differ in how a token becomes an address, because the gate's
 * do-not-contact check and the adapter's actual send both key off the
 * result of this exact function.
 *
 * That second kind of drift is not hypothetical: before this function
 * existed, the adapter unwrapped a trailing `Name <addr@x.com>` display-name
 * form to deliver to `addr@x.com`, while the gate's `matchDoNotContact` kept
 * the whole raw token and read the domain off it with `email.split('@')[1]`
 * — which, given `'dana cohen <dana@x.com>'`, returns `'x.com>'` (the
 * trailing bracket still attached) rather than `'x.com'`, so a charter entry
 * blocking `x.com` never matched. Adversarial input made it worse: for
 * `'a@b.com <evil@x.com>'`, that same split yields `'b.com <evil'`, so
 * *neither* real domain was screened, while the adapter delivered to
 * `evil@x.com` regardless. Both bugs were really one bug: two independent
 * parsers for the same string, agreeing only by coincidence.
 *
 * Unwraps a trailing `<...>` wrapper by taking whatever is inside it —
 * `'Dana Cohen <dana@x.com>'` and `'a@b.com <evil@x.com>'` both resolve to
 * the bracketed address, never to text that happens to precede the bracket
 * — falling back to the fragment itself when there is no wrapper. Returns
 * the trimmed result, or `null` when that result is empty.
 *
 * Deliberately does not validate shape: a caller that wants a wide,
 * over-approximating candidate for screening (a false positive there is
 * free) and a caller that wants a strict, deliverable address (a false
 * positive there sends mail to garbage) apply their own validation on top
 * of the same extracted candidate. This function only guarantees that both
 * callers extracted the *same* candidate from the *same* input.
 */
const DISPLAY_NAME_WRAPPER = /<([^<>]+)>\s*$/;

export function extractAddressCandidate(fragment: string): string | null {
  const wrapped = DISPLAY_NAME_WRAPPER.exec(fragment);
  const candidate = (wrapped?.[1] ?? fragment).trim();
  return candidate.length > 0 ? candidate : null;
}
