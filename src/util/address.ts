const DISPLAY_NAME_WRAPPER = /<([^<>]+)>\s*$/;

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
 * — falling back to the fragment itself when there is no wrapper at all.
 *
 * A fragment that carries a stray `<` or `>` *without* forming a single,
 * clean, trailing wrapper — `'<>'`, `'<<a@b.com>>'`, or a wrapper that is
 * not at the end — returns `null` rather than falling back to the raw text.
 * `EMAIL_SHAPE` in `mail.ts` does not exclude `<`/`>`, so passing malformed
 * bracket punctuation through as a "candidate" let it later pass shape
 * validation and be delivered to (or screened as) `'<dana@rival.co.il>>'`
 * verbatim — a stray closing bracket is enough to make a domain check miss,
 * exactly like the trailing-bracket bug above, just shaped differently.
 * Refusing here closes it at the one place both readers already share,
 * rather than requiring every downstream shape check to anticipate it.
 *
 * Returns the trimmed result, or `null` when that result is empty.
 *
 * Deliberately does not validate the extracted candidate as an email shape:
 * a caller that wants a wide, over-approximating candidate for screening (a
 * false positive there is free) and a caller that wants a strict,
 * deliverable address (a false positive there sends mail to garbage) apply
 * their own validation on top of the same extracted candidate. This
 * function only guarantees that both callers extracted the *same*
 * candidate from the *same* input.
 */
export function extractAddressCandidate(fragment: string): string | null {
  const wrapped = DISPLAY_NAME_WRAPPER.exec(fragment);
  if (wrapped !== null) {
    const inner = (wrapped[1] ?? '').trim();
    return inner.length > 0 ? inner : null;
  }

  // No clean trailing wrapper matched. A fragment with no bracket at all is
  // a bare address and falls back to itself; one that still contains `<` or
  // `>` is ambiguous punctuation this function does not understand, and
  // must not be handed to a caller as if it were plain text -- see above.
  if (fragment.includes('<') || fragment.includes('>')) return null;

  const trimmed = fragment.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The domain an address candidate names, normalised, or `null` when the
 * candidate does not have exactly one `@` or has no domain part.
 *
 * Shared by every consumer that keys a decision off a counterparty's email
 * domain — `matchDoNotContact` and the `byEmailDomain` autonomy override in
 * `src/policy/engine.ts`, and `knownCounterparties` in `src/policy/risk.ts`
 * — for the same reason `extractAddressCandidate` above is shared: a bare
 * `email.split('@')[1]` on a candidate this module deliberately never
 * shape-validates missed input that is legal but odd.
 * `'dana@rival.co.il.'` — a trailing root dot, which is legal DNS notation
 * and passes `EMAIL_SHAPE` in `mail.ts` — split to `'rival.co.il.'`, which
 * matched nothing in a charter naming `'rival.co.il'`, and the message was
 * delivered anyway. Stripping exactly one trailing `.` and lower-casing
 * here means every caller sees the same, comparable domain.
 *
 * Refuses (returns `null`) a candidate with zero or more than one `@`:
 * more than one is ambiguous about which part is actually the domain, and
 * reading `parts[1]` regardless — the exact shape of the original bug — is
 * not a safe default for an unusual case, it is the bug.
 */
export function extractDomain(candidate: string): string | null {
  const parts = candidate.split('@');
  if (parts.length !== 2) return null;

  const raw = parts[1];
  if (raw === undefined || raw.length === 0) return null;

  const stripped = raw.endsWith('.') ? raw.slice(0, -1) : raw;
  return stripped.length > 0 ? stripped.toLowerCase() : null;
}

/**
 * Whether `domain` is `pattern` itself or a true subdomain of it.
 *
 * A charter entry of `'rival.co.il'` is a sentence an owner writes about a
 * company, not one hostname — `emailDomains.includes(domain)` (exact string
 * equality) never blocked `dana@mail.rival.co.il`, and the identical naive
 * comparison in the `byEmailDomain` autonomy override and
 * `knownCounterparties` let a subdomain skip a tightening ceiling too.
 *
 * Anchored on the label boundary with a leading dot, so the match is on a
 * whole domain label, not a text suffix: `'mail.rival.co.il'` matches
 * `'rival.co.il'`, but the lookalike `'evilrival.co.il'` does not, because
 * `'rival.co.il'` never follows a `.` inside it. A plain `.endsWith(pattern)`
 * without the dot would have matched the lookalike.
 */
export function domainMatches(domain: string, pattern: string): boolean {
  return domain === pattern || domain.endsWith(`.${pattern}`);
}
