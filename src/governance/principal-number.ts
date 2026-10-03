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
 * (`src/charter/compile.ts`) compares the last nine digits, which is correct
 * where it lives: on a do-not-contact list a coarse match errs safe because it
 * blocks more. On an authority list the identical coarseness errs the other
 * way — two different numbers sharing nine trailing digits would both read as
 * the owner. So this module keeps its own normaliser and compares in full.
 */
import type { BusinessCharter } from '../domain/charter.js';

/**
 * Digits only, full international form.
 *
 * A national form (`054…`) is refused rather than guessed at: inferring a
 * country code for an authority check is inventing authority. Minimum length
 * is a country code plus a subscriber number; below that nothing is a real
 * number and a short string must never match by accident.
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
