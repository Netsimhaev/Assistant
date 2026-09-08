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
 * nine.
 *
 * Nine is the length of an Israeli subscriber number without its leading
 * zero, which is what survives both `054-123-4567` and `+972541234567`.
 * Shorter than that is not a phone number, and comparing it would match half
 * the digits in the instruction by accident — the exact shape of the
 * `12345` / "הזמנה מספר 12345" false positive fixed below: an all-digit
 * candidate must be rejected here, on its own length, and never fall
 * through to a textual path that has no length floor at all.
 *
 * The nine-digit key is a deliberate cost, not an oversight: it drops the
 * country code, so two numbers that merely share their last nine digits
 * compare equal, and an Israeli landline never matches its own
 * international form if the two disagree further left than that. Accepted
 * because the alternative — a locale table to normalise country codes
 * properly — does not exist yet, and the current cost is a coarser match,
 * never a missed one.
 */
function phoneKey(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  return digits.length < 9 ? null : digits.slice(-9);
}

/**
 * Whether `run` looks like an actual Israeli phone number, not merely a
 * digit string of plausible length.
 *
 * Fix round 1 tried "digit count in 9–15, at most one whitespace gap" and
 * both clauses turned out to be decorative: the regex in `phoneRunsIn` only
 * ever handed this function a match with zero or one `\s` in it, so
 * `spaceCount <= 1` could never see the input it was written to reject, and
 * `digitCount < 9` only restated `phoneKey`'s own floor one call later. That
 * left a single live clause (`> 15`), which nothing tested, and it still
 * missed a whole family of splices that use a separator other than a space:
 * `100-521-234-567`, `1.521.234.567`, `521234567` sitting after a company-id
 * label — none of those contain two spaces, so the old guard waved all of
 * them through, each synthesising a real subscriber number's last nine
 * digits out of a number that never appeared in the instruction.
 *
 * This asks a different question: does `run` have the *shape* of a phone
 * number, not just a length in some range. A real Israeli number starts
 * with a recognisable prefix — a bare `0` (national dialling) or `972`
 * (international, with or without the `+`) — and nothing else does; an
 * order number, a company registration id, or several unrelated figures run
 * together by a whitespace-tolerant scan will not, by construction, start
 * with one of those two prefixes. After stripping the recognised prefix,
 * what remains must be nine or ten digits — an Israeli subscriber number —
 * and the run may bridge at most two separator groups, because a number is
 * written as one glued token, split by an area code, or split by an area
 * code and a country code: never four or five fragments stitched together.
 */
function looksLikePhoneNumber(run: string): boolean {
  const digits = run.replace(/\D/g, '');
  let significant: string;
  if (digits.startsWith('972')) {
    significant = digits.slice(3);
  } else if (digits.startsWith('0')) {
    significant = digits.slice(1);
  } else {
    return false;
  }
  if (significant.length !== 9 && significant.length !== 10) return false;

  const separatorGroups = run.match(/[\s().-]+/g) ?? [];
  return separatorGroups.length <= 2;
}

/**
 * Phone-shaped runs in free text, filtered to the ones `looksLikePhoneNumber`
 * accepts before anything is keyed off them.
 *
 * Deliberately broad on its own: this used to also try to structurally limit
 * whitespace inside the match, which review found unreachable in practice
 * (see `looksLikePhoneNumber`'s docblock) and which did nothing to stop a
 * splice joined by dots or dashes instead of spaces. All of the real
 * filtering now lives in one place, on the fully-formed candidate run, where
 * it can see the whole shape at once rather than a fragment the regex
 * happened to bound.
 */
function phoneRunsIn(instruction: string): string[] {
  const runs = instruction.match(/[+\d][\d\s().-]*/g) ?? [];
  return runs.map((run) => run.trim()).filter(looksLikePhoneNumber);
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
function emailAddressesIn(instruction: string): string[] {
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
  // the old code tried the substring match first and only reached
  // `phoneKey` if that failed, so a short numeric candidate was authorised
  // by matching itself as a text fragment before its length was ever
  // checked as a phone number.
  if (/^[+\d][\d\s().-]*$/.test(trimmed)) {
    const wanted = phoneKey(trimmed);
    if (wanted === null) return false;
    return phoneRunsIn(instruction).some((run) => phoneKey(run) === wanted);
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
