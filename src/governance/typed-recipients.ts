/**
 * Which of a step's recipients an instruction is allowed to authorise.
 *
 * The owner's emphasis is that an instruction is its own approval. The danger
 * is that the recipients in a plan come from a model reading the owner's text:
 * paste a supplier's mail containing an address, add "handle this", and that
 * address would be in the plan. Granting whatever the plan names would let a
 * paste buy authority.
 *
 * Two positive sources, and nothing else:
 *
 *   1. the charter already knows the counterparty, or
 *   2. the owner typed the address or number verbatim in the instruction.
 *
 * The second is the owner's own rule, and it is the right distinction: it
 * separates *the model inferred a destination* from *the boss named one*.
 * Spec §6 records what it does not protect against — it sees that an address
 * is in the text, not who put it there — and the class allowlist below is the
 * hedge the owner chose alongside it.
 */
import type { ActionClass } from '../domain/action.js';
import type { PolicyBundle } from '../domain/policy.js';
import { extractAddressCandidate, extractDomain } from '../util/address.js';

/**
 * The classes where a recipient can be authorised by an instruction at all.
 *
 * Named individually, never derived. A class added to the enum tomorrow is
 * excluded until someone puts it here on purpose, and rewriting this as
 * "everything except a purchase" would fail the invariant test that pins it.
 *
 * What is deliberately absent: `purchase.place`, `commitment.make`,
 * `quote.issue` and `discount.grant` — the four where a mistake costs most —
 * plus every class the code never automates regardless.
 *
 * **This gates the whole grant, not only the typed half.** A supplier already
 * on file is exactly who a purchase would go to, so exempting known
 * counterparties here would defeat the restriction at the only moment it
 * matters.
 */
export const TYPED_RECIPIENT_CLASSES: readonly ActionClass[] = [
  'email.reply',
  'email.initiate',
  'whatsapp.reply',
  'whatsapp.initiate',
  'calendar.create',
  'calendar.move',
  'calendar.cancel',
  'doc.deliver',
];

/**
 * Digits only, and the last nine of them, or `null` when there are not even
 * nine. **The charter side only** — see `phoneNumberKey` below for the
 * instruction side, and the paragraph at the end of this block for why the
 * two deliberately do not share one rule.
 *
 * Nine is the length of an Israeli subscriber number without its leading
 * zero, which is what survives both `054-123-4567` and `+972541234567`.
 *
 * The nine-digit key is a deliberate cost, not an oversight: it drops the
 * country code, so two numbers that merely share their last nine digits
 * compare equal, and an Israeli landline never matches its own
 * international form if the two disagree further left than that. Accepted
 * because the alternative — a locale table to normalise country codes
 * properly — does not exist yet, and the current cost is a coarser match,
 * never a missed one.
 *
 * Why the charter keeps this coarser rule while the instruction path does
 * not: `known.phones` is signed charter data the owner curated, not free
 * text an attacker can paste into. Coarseness there costs a slightly wider
 * match against a list the owner wrote on purpose. It also matches numbers
 * from ANY country, which `phoneNumberKey`'s Israeli-prefix rule cannot —
 * a foreign counterparty on file would stop matching the day the charter
 * side adopted a prefix-anchored key, which is a live regression and not a
 * theoretical one.
 */
function phoneKey(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  return digits.length < 9 ? null : digits.slice(-9);
}

/**
 * The phone number a run of digits and separators actually names, or `null`
 * when it does not name one. **The instruction side**, used for both the
 * candidate and the runs found in the owner's text, so the two are compared
 * under one identical rule.
 *
 * The question is not "are these digits plausible" but "**is this run a
 * phone number, and if so which one**". Rounds 1 and 2 asked the first
 * question — a digit-count range, a cap on separator groups, a prefix
 * anywhere at the start of the run — and then took the key off the run's
 * TAIL (`phoneKey`'s last nine). Nothing tied the prefix that had been
 * checked to the digits that became the key, so the whole splice class
 * survived behind any unrelated leading figure that started with `0`, and
 * the fixed 9-or-10 length simultaneously refused every Israeli landline.
 * One wrong rule, failing in both directions at once.
 *
 * The key is now anchored to the prefix:
 *
 *   - `972` at the front (international, with or without the `+`) or a bare
 *     `0` (national dialling) — and nothing else is a phone number at all.
 *     An order number, a company registration id, or several unrelated
 *     figures run together by the scan will not, by construction, start
 *     with one of those two.
 *   - After `972`, a single trunk zero if one follows it, because
 *     `+972 054-123-4567` is an ordinary spelling and that zero is dialling
 *     notation rather than part of the number. See the comment at the
 *     branch itself for the two symptoms of not doing this.
 *   - What follows the prefix is the key, and it must be exactly 8 or 9
 *     digits. Nine is a mobile (`054-1234567` → `541234567`); eight is a
 *     landline (`03-1234567` → `31234567`). Every spelling of one number —
 *     local, international, international with the trunk zero — reduces to
 *     the same key, which is what the old last-nine rule was reaching for
 *     and got wrong for every landline in the country.
 *
 * The separator-group cap and the digit-count range are both gone.
 * Prefix-anchoring replaces them: a run that does not begin with a
 * recognised prefix is not a number, and one that does is bounded by the
 * 8-or-9 rule. Keeping the cap would have gone on refusing
 * `+972-54-123-4567` and `+972 54 123 4567`, two ordinary ways to write a
 * mobile.
 *
 * **What this still does not close, stated plainly.** Separators are
 * stripped before the prefix is read, so any run whose digits happen to
 * spell the target number authorises it however those digits were spaced:
 * `סעיף 0-521234567`, `שורה 0 521234567 בקובץ`, `פריט (0) 521234567`,
 * `קוד 972 521234567`, `קוד 972 0521234567`, `פריט 05 21234567` and
 * `0-5-2-1-2-3-4-5-6-7` all still authorise `0521234567`. That is not
 * fixable while `054-123-4567` and `+972 54 123 4567` must also be
 * accepted — after
 * separator-stripping they are the same digits, and no rule can prefer one
 * spacing over another without refusing a real number somebody writes that
 * way. The residual is narrow and honest: **the instruction must contain
 * the target number's own digits behind a recognised prefix.** That is a
 * far weaker claim than round 2's "no phone number appears in the text at
 * all", and it is where this stops. `records the residual: …` in the test
 * file pins the exact strings so nobody reads the closed cases as proof
 * that this one is closed too.
 */
function phoneNumberKey(run: string): string | null {
  const digits = run.replace(/\D/g, '');

  let significant: string;
  if (digits.startsWith('972')) {
    // A single trunk zero after the country code, if one is there. It is
    // the local form's leading `0` left in place -- `+972 054-123-4567` --
    // and it is dialling notation, never part of the subscriber number.
    // Counting it made ten significant digits, so the 8-or-9 rule refused
    // the whole spelling; worse, `+972-0-3-1234567` keyed to `031234567`
    // while `03-1234567` keyed to `31234567`, so two spellings of one
    // landline stopped matching each other -- the exact defect
    // prefix-anchoring exists to fix, one digit further left. Stripping it
    // loosens nothing: what remains still has to be 8 or 9 digits, and a
    // leading `0` with no country code in front of it is still what
    // identifies the local form below.
    const afterCountryCode = digits.slice(3);
    significant = afterCountryCode.startsWith('0')
      ? afterCountryCode.slice(1)
      : afterCountryCode;
  } else if (digits.startsWith('0')) {
    significant = digits.slice(1);
  } else {
    return null;
  }

  if (significant.length !== 8 && significant.length !== 9) return null;
  return significant;
}

/**
 * The keys of every phone number written in free text.
 *
 * The run bridges exactly two characters of the whitespace family and no
 * others: the plain space (U+0020) and the non-breaking space (U+00A0).
 * Both have to bridge — `+972 54 123 4567` is an ordinary spelling, and a
 * number copied out of a web page or a Word document carries U+00A0
 * between its groups rather than U+0020, so bridging only the plain space
 * split `054 123 4567` into three runs and refused a number the owner
 * really had typed. A tab or a newline is a *cell* or *line* boundary,
 * never a separator inside one number, and both stay out: bridging `\s`
 * wholesale read a pasted two-column table (`ח.פ.` │ `0` │ `521234567`) as
 * a single run, which is one of the splices this had to close.
 *
 * Runs are maximal: two numbers separated only by a space join into one run
 * and then fail `phoneNumberKey`'s 8-or-9 rule, so a real number sitting
 * immediately beside another number can go unrecognised. That is a false
 * negative — the owner is asked to confirm a recipient they did name — and
 * it is the safe direction. Splitting a run into every sub-run to avoid it
 * would manufacture exactly the false positives this function exists to
 * refuse.
 */
function phoneNumbersIn(instruction: string): string[] {
  const runs = instruction.match(/[+\d][\d \u00A0().-]*/g) ?? [];
  return runs
    .map((run) => phoneNumberKey(run))
    .filter((key): key is string => key !== null);
}

/**
 * A deliberately loose but shape-checked address: no internal whitespace,
 * exactly one `@`, and at least one `.` in the domain part. Mirrors
 * `EMAIL_SHAPE` in `src/orchestrator/adapters/mail.ts` — not imported from
 * there, since that module sits in the execution layer this one must not
 * depend on, but kept to the same shape on purpose so "looks like an
 * address" means the same thing wherever this codebase asks it.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sentence punctuation a token can trail without it being part of an address. */
const TRAILING_PUNCTUATION = /[.,;:!?)"']+$/;

/**
 * A leading Hebrew prefix particle glued directly onto the next word with no
 * space — exactly how "to Dana" is ordinarily written as `ל-דנה`, not as an
 * edge case but as the default way a Hebrew speaker writes it. Round 2
 * reworded three tests to insert a space instead of handling this, on the
 * reasoning that stripping it would mean inventing new parsing logic; the
 * ruling that followed was that a design an owner has to write around for
 * their own language's ordinary grammar is the wrong design, and named the
 * exact fix: a closed, positive list of one-letter particles, never "any
 * leading non-Latin character" or a general prefix stripper.
 *
 * The list is exactly `ל ב מ ה ו כ ש` (to / in / from / the / and / as / that),
 * each followed by either an ASCII hyphen-minus or the Hebrew maqaf (U+05BE)
 * — the punctuation Hebrew text actually uses for this join, distinct from
 * the visually similar hyphen-minus. Nothing else strips: a token starting
 * with any other character, or one of these letters NOT followed by one of
 * the two join marks, passes through unchanged.
 *
 * This does not reopen N1. Only a fixed, short, LEADING particle is ever
 * removed — never a search for where an address "really" starts partway
 * through the token — and the entire remainder must still pass
 * `EMAIL_SHAPE` as a whole afterwards, exactly as an un-prefixed token must.
 * `ל-dana@example.co.il2` strips to `dana@example.co.il2`: the leading-
 * particle strip has nothing more to say about it, and it is then compared
 * to whatever the plan proposes the same way any other token is — as a
 * complete, extracted value, never as a stretch to be found inside a larger
 * one. There is no sub-token scanning anywhere in this pipeline and nothing
 * for a backtracking engine to settle for, regardless of what precedes or
 * follows the particle.
 */
const LEADING_HEBREW_PARTICLE = /^[לבמהוכש][-\u05BE]/;

/**
 * Email-shaped tokens in free text, found the way `readEmails`
 * (`src/policy/facts.ts`) finds them in a `to` field: split into fragments,
 * clean each one up, then ask whether the *whole* fragment is an address —
 * never search for an address-shaped stretch inside a larger fragment.
 *
 * Free text has no commas to split a `to` field on, so the split here is on
 * whitespace instead; everything else is the same shared pipeline. Splitting
 * first and testing the whole token second is what closes both C1 and its
 * round-1 recurrence: a fix-round-1 version of this function matched an
 * address-shaped *stretch* inside the running text with a `\b`-anchored
 * regex, and backtracking on that regex's trailing boundary is exactly what
 * let `dana@example.co.il2` produce a match ending at `dana@example.co` — the
 * boundary the regex needed was satisfied by the `.` two characters early,
 * not by the true end of the address. A token, once isolated by whitespace
 * and stripped of a leading Hebrew particle (see `LEADING_HEBREW_PARTICLE`),
 * is tested whole (`EMAIL_SHAPE` is anchored at both ends): it is a
 * candidate in its entirety or it is not a candidate at all, so there is no
 * shorter match for a backtracking engine to settle for.
 *
 * `TRAILING_PUNCTUATION` is stripped first so ordinary sentence punctuation
 * glued to the end of a typed address — a period closing the sentence, a
 * comma before the next clause — does not stay attached and defeat the exact
 * comparison this function's caller makes. It only strips punctuation, never
 * `<`/`>`: a token can genuinely be a bracket-wrapped `<addr@x.com>` form,
 * and `extractAddressCandidate` (`src/util/address.ts`) — the one place a
 * raw fragment turns into an address everywhere else in this codebase — is
 * what unwraps that, exactly as it does for a comma-split `to` fragment. A
 * token with no brackets at all passes through it unchanged; the branch that
 * actually unwraps a display name is reached only when a token has one.
 *
 * Exported for the curator's recall scope too (`src/orchestrator/instruct.ts`):
 * the memory block handed to the planner is scoped to only the addresses an
 * instruction actually names, and this is the function that already decides
 * that question correctly for standing authorisation — a second extractor
 * would drift from it.
 *
 * Note on `EMAIL_SHAPE` itself: it is loose enough that a token like
 * `dana@example.co.il2` (once any leading particle is stripped) still
 * matches it as a whole — `EMAIL_SHAPE`'s domain half accepts any non-space,
 * non-`@` characters, including a trailing digit, since it mirrors
 * `mail.ts`'s deliberately permissive validator rather than a strict TLD
 * check. That is not a gap: the extracted value in that case is the FULL
 * glued string, `dana@example.co.il2`, and this function's caller compares
 * it for exact equality against whatever the plan proposes — never against
 * a shorter candidate like `dana@example.co`. Whichever of the two checks
 * ends up doing the rejecting, nothing is authorised that the owner did not
 * type in full.
 */
export function emailAddressesIn(instruction: string): string[] {
  return instruction
    .split(/\s+/)
    .map((token) => token.replace(LEADING_HEBREW_PARTICLE, ''))
    .map((token) => token.replace(TRAILING_PUNCTUATION, ''))
    .map((token) => extractAddressCandidate(token))
    .filter((value): value is string => value !== null)
    .filter((value) => EMAIL_SHAPE.test(value))
    .map((value) => value.toLowerCase());
}

function typedInInstruction(candidate: string, instruction: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return false;

  // Shape decides the pathway, and a numeric candidate never falls through
  // to the address path below. That fallthrough is exactly how `12345`
  // used to reach a bare `.includes()` with no length floor at all (C1):
  // the old code tried the substring match first and only reached the phone
  // rule if that failed, so a numeric candidate was authorised by matching
  // itself as a text fragment before it was ever asked whether it was a
  // phone number at all.
  //
  // Candidate and instruction go through the SAME `phoneNumberKey`. A
  // candidate that is not itself a phone number under that rule authorises
  // nobody, however it is written in the text.
  if (/^[+\d][\d\s().-]*$/.test(trimmed)) {
    const wanted = phoneNumberKey(trimmed);
    if (wanted === null) return false;
    return phoneNumbersIn(instruction).includes(wanted);
  }

  const target = trimmed.toLowerCase();
  return emailAddressesIn(instruction).includes(target);
}

function knownToCharter(
  candidate: string,
  known: PolicyBundle['knownCounterparties'],
): boolean {
  const lower = candidate.toLowerCase();

  // Exact equality against the extracted domain, not `domainMatches`
  // (`src/util/address.ts`). That function's own docblock names
  // `knownCounterparties` as the field it must never be used on: there, a
  // broader match makes the outcome LESS restrictive — it grants
  // authority — and `src/policy/risk.ts`'s `scoreVisibility` already
  // compares the same field with exact equality for the identical reason.
  // A charter entry for `acme.co.il` is a sentence an owner wrote about one
  // company, not a hosting platform whose every customer's subdomain
  // should inherit its trust.
  const domain = extractDomain(lower);
  if (domain !== null && known.emailDomains.includes(domain)) return true;

  // `phoneKey` (last nine digits), not `phoneNumberKey` (prefix-anchored,
  // Israeli). Both sides here are charter data the owner curated, so the
  // adversarial parse the instruction path needs buys nothing — and the
  // Israeli-prefix rule would drop every foreign counterparty on file,
  // which the last-nine rule matches today. Both docblocks say so.
  const wanted = phoneKey(candidate);
  if (wanted !== null && known.phones.some((p) => phoneKey(p) === wanted)) return true;

  return known.entityIds.some((id) => id.toLowerCase() === lower);
}

export function authorisedRecipients(input: {
  instruction: string;
  actionClass: ActionClass;
  candidates: string[];
  known: PolicyBundle['knownCounterparties'];
}): string[] {
  if (!TYPED_RECIPIENT_CLASSES.includes(input.actionClass)) return [];

  return input.candidates.filter(
    (candidate) =>
      knownToCharter(candidate, input.known) ||
      typedInInstruction(candidate, input.instruction),
  );
}
