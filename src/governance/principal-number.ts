/**
 * Who is allowed to instruct the assistant over WhatsApp.
 *
 * **The list is already in the signed charter.** `CharterPerson.isPrincipal`
 * ("the boss"; the charter already validates that exactly one person carries
 * it) plus `channels.whatsapp`, where `Channel` names `whatsapp` explicitly.
 * No schema change, no `CURRENT_SCHEMA_VERSION` bump, no re-signing — and
 * `isPrincipal`, whose only reader today merely validates its uniqueness,
 * finally has a real one.
 *
 * **Deterministic, never a model call.** Same reason stated at the top of
 * `src/memory/contact-resolver.ts`: whoever lets a model decide which "Ronit"
 * was meant, lets it decide who receives an email. Here it is sharper —
 * whoever lets a model decide who the boss is, lets it decide who operates
 * the business.
 *
 * **Exact match, and not the nine-digit key.** `phoneKey`
 * (`src/governance/typed-recipients.ts`) compares the last nine digits, and
 * its own docblock justifies that on the grounds that both sides it compares
 * are charter data the owner curated — not on any do-not-contact list; its
 * only call site (`knownToCharter`, feeding `authorisedRecipients`) is itself
 * an authority-granting check, the same direction as this module. That
 * justification does not transfer here: an inbound WhatsApp sender number is
 * not charter data anyone curated, it is a claim an attacker can dial in. So
 * this module keeps its own normaliser and compares in full.
 */
import type { BusinessCharter } from '../domain/charter.js';

/**
 * Digits only, full international form.
 *
 * A national form (`054…`) is refused rather than guessed at: inferring a
 * country code for an authority check is inventing authority.
 *
 * **Do not raise `MIN_INTERNATIONAL_DIGITS` above 10.** It is not a claim
 * that no real E.164 number is shorter — `+683`, `+290` and `+672` reach a
 * full number in seven total digits, so "below this nothing is a real
 * number" is not literally true. The reason the floor must stay at or below
 * 10 is the collision test this module exists for
 * (`does not resolve a different number that shares its last nine digits`
 * in `principal-number.test.ts`): at 11 its first probe, `+1541234567` (10
 * digits), would be rejected on length before the comparison runs at all,
 * so that assertion would pass for the wrong reason — refused as too short,
 * not refused as a different number. The second probe is 12 digits and would
 * still bite, so the test would not go fully hollow, only half of it would.
 */
const MIN_INTERNATIONAL_DIGITS = 10;
const MAX_INTERNATIONAL_DIGITS = 15; // E.164

export function authorityNumberKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('+')) return null;
  const digits = trimmed.slice(1).replace(/[\s\-()./]/g, '');
  if (!/^[0-9]+$/.test(digits)) return null;
  if (digits.length < MIN_INTERNATIONAL_DIGITS || digits.length > MAX_INTERNATIONAL_DIGITS) return null;
  return digits;
}

/**
 * `charter` must be the `charter` field of what `loadActiveCharter`
 * (`src/charter/store.ts`) returns — the only read path that both parses the
 * schema and checks the schema version. It does **not** verify the
 * signature; that happens in `compileCharter`/`installCharter`. A cached or
 * hand-parsed charter is not a legitimate argument here, the same caution
 * `compile.ts` states about the bundle it produces.
 */
export function principalWhatsAppKey(charter: BusinessCharter): string | null {
  const principal = charter.people.find((p) => p.isPrincipal);
  const declared = principal?.channels['whatsapp'];
  if (declared === undefined) return null;
  return authorityNumberKey(declared);
}

export function isPrincipalSender(charter: BusinessCharter, senderNumber: string): boolean {
  const authorised = principalWhatsAppKey(charter);
  if (authorised === null) return false;
  const sender = authorityNumberKey(senderNumber);
  if (sender === null) return false;
  return sender === authorised;
}
