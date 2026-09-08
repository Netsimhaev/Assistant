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
 * Whether `run` is plausibly a single phone number rather than several
 * unrelated numbers a whitespace-tolerant scan spliced together.
 *
 * Two independent guards. First, a total digit count outside 9–15 — below
 * the shortest real subscriber number or above the longest number E.164
 * allows — cannot be a phone number at all. Second, at most one single-space
 * gap: a real number is written as one glued token (`054-123-4567`) or, at
 * most, split into two groups by a single space (`050 1234567`). Four
 * separate single-space gaps — `100 200 521 234 567` — is not how anyone
 * writes a phone number; it is how five unrelated three-digit numbers look
 * once a whitespace-tolerant regex has run a comma-free sentence together.
 * That exact string's last nine digits equal a real subscriber number's
 * last nine, with no address and no phone number appearing in the
 * instruction at all — the digit-count floor alone does not catch it (the
 * spliced total can itself land inside 9–15), so the space-count guard is
 * load-bearing on its own, not redundant with the count check beside it.
 */
function phoneRunPlausible(run: string): boolean {
  const digitCount = run.replace(/\D/g, '').length;
  if (digitCount < 9 || digitCount > 15) return false;

  const spaceCount = (run.match(/\s/g) ?? []).length;
  return spaceCount <= 1;
}

/**
 * Phone-shaped runs in free text, filtered to the ones `phoneRunPlausible`
 * accepts before anything is keyed off them.
 *
 * The regex itself already refuses to bridge two single-space gaps: the
 * optional trailing group matches *at most once*, so `100 200 521 234 567`
 * splits into three separate candidate runs (`100 200`, `521 234`, `567`)
 * rather than one that concatenates all five groups — each on its own falls
 * under the nine-digit floor before `phoneRunPlausible` is even consulted.
 * The plausibility filter is defence in depth for the runs the regex shape
 * alone does not rule out (a long dash-joined digit string with no spaces
 * at all, e.g. an invoice or tracking number).
 */
function phoneRunsIn(instruction: string): string[] {
  const runs = instruction.match(/[+\d][\d().-]*(?:\s[\d().-]+){0,1}/g) ?? [];
  return runs.filter(phoneRunPlausible);
}

/**
 * Email-shaped tokens in free text, anchored so a glued prefix (`ל-` typed
 * with no space before the address) is excluded but a real address is
 * extracted in full — greedy backtracking on the domain group means a
 * multi-label domain (`example.co.il`) is captured whole, never truncated
 * to a shorter domain that happens to be a substring of it (`example.co`).
 * That truncation was C1: `haystack.includes(candidate)` authorised
 * `dana@example.co` against text that actually said `dana@example.co.il`,
 * because a substring search cannot tell "the whole address" from "a prefix
 * of it that happens to look like one." Extracting the full token first and
 * comparing extracted-to-extracted makes that impossible: the two strings
 * are simply unequal.
 *
 * `\b` on both ends is what excludes the glued prefix: at the boundary
 * between a non-word character (`-` or a Hebrew letter, neither in `\w`)
 * and the first word character of the real address, `\b` holds; between two
 * non-word characters (`ל` then `-`) it does not, so the match cannot start
 * there. The same asymmetry is why `reply@example.com` cannot match inside
 * `noreply@example.com`: there is no boundary between the `o` and the `r`
 * of "noreply", so the regex is never offered a starting position there at
 * all — a boundary check, not a domain check, and not hand-rolled against
 * `knownCounterparties`'s forbidden subdomain matcher (see `knownToCharter`).
 *
 * Each match is passed through `extractAddressCandidate`
 * (`src/util/address.ts`) — the one place a raw fragment turns into an
 * address everywhere else in this codebase — so a `Name <addr@x.com>` form
 * embedded in free text unwraps the same way it would in a `to` field,
 * rather than this module inventing a second opinion about what counts.
 */
function emailAddressesIn(instruction: string): string[] {
  const runs = instruction.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? [];
  return runs
    .map((run) => extractAddressCandidate(run))
    .filter((value): value is string => value !== null)
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
