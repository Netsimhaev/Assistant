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
 * Normalise a bare domain string: drop a leading `@` someone typed by habit,
 * strip *every* trailing `.`, lower-case. Returns `null` when nothing is
 * left, which every caller must treat as "this is not a domain."
 *
 * The one normalisation both `extractDomain` (below, given a whole address
 * candidate) and `normaliseDomain` (`src/charter/compile.ts`, given a
 * charter's raw `emailDomain` field) go through. Normalising only the
 * candidate side and leaving the charter side raw is the same class of bug
 * as not sharing extraction at all: a charter entry written `'rival.co.il.'`
 * stopped matching `'dana@rival.co.il.'` the moment only the inbound side
 * started stripping the dot -- a deny that silently became an allow.
 *
 * Strips every trailing dot, not just one: `'rival.co.il..'` must not
 * normalise to `'rival.co.il.'` and slip past a charter entry for
 * `'rival.co.il'` by being one dot short of matching -- the same bypass
 * shape the single-dot fix closed, one character further out.
 */
export function normaliseDomainString(domain: string): string | null {
  const stripped = domain.trim().replace(/^@/, '').replace(/\.+$/, '');
  return stripped.length > 0 ? stripped.toLowerCase() : null;
}

/**
 * The domain an address candidate names, normalised via
 * `normaliseDomainString` above, or `null` when the candidate does not have
 * exactly one `@` or has no domain part.
 *
 * Shared by every consumer that keys a decision off a counterparty's email
 * domain — `matchDoNotContact` and the `byEmailDomain` autonomy override in
 * `src/policy/engine.ts`, and `knownCounterparties` in `src/policy/risk.ts`
 * — for the same reason `extractAddressCandidate` above is shared: a bare
 * `email.split('@')[1]` on a candidate this module deliberately never
 * shape-validates missed input that is legal but odd. See
 * `normaliseDomainString`'s own docblock for the trailing-dot bypass this
 * closed on both the candidate and the charter side together.
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

  return normaliseDomainString(raw);
}

/**
 * Whether `domain` is `pattern` itself or a true subdomain of it.
 *
 * A charter entry of `'rival.co.il'` is a sentence an owner writes about a
 * company, not one hostname — `emailDomains.includes(domain)` (exact string
 * equality) never blocked `dana@mail.rival.co.il`.
 *
 * Anchored on the label boundary with a leading dot, so the match is on a
 * whole domain label, not a text suffix: `'mail.rival.co.il'` matches
 * `'rival.co.il'`, but the lookalike `'evilrival.co.il'` does not, because
 * `'rival.co.il'` never follows a `.` inside it. A plain `.endsWith(pattern)`
 * without the dot would have matched the lookalike.
 *
 * **Use this only where a broader match makes the outcome MORE
 * restrictive, never less.** `matchDoNotContact` and the `byEmailDomain`
 * autonomy ceiling in `src/policy/engine.ts` both use it correctly: a
 * subdomain matching means *more* gets blocked or its ceiling tightened,
 * which is always safe to widen. `knownCounterparties` in
 * `src/policy/risk.ts` must NOT use it: there, a match means *less*
 * restriction -- it scores the sender as a known counterparty and skips the
 * first-contact risk escalation -- and a DNS label boundary is not a
 * company boundary an owner vouched for. A charter entry for
 * `'acme.co.il'` says nothing about `'promo.mail.acme.co.il'`, and less
 * than nothing when the parent domain is a hosting platform anyone can get
 * a subdomain of. `knownCounterparties` compares with exact equality
 * instead, on purpose. The next call site that reaches for this function
 * should ask which direction its own match loosens before using it.
 */
export function domainMatches(domain: string, pattern: string): boolean {
  return domain === pattern || domain.endsWith(`.${pattern}`);
}
