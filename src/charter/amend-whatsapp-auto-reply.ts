/**
 * The charter amendment that lets the assistant answer a known client or
 * supplier on WhatsApp by itself (phase 2, package 1) — the SIGNED switch.
 *
 * One fixed change: `autonomy.base['whatsapp.reply']` goes to `auto_notify`,
 * with a new `charterVersion`, `effectiveFrom` and `supersedes`. Everything else
 * is copied verbatim. It needs the `whatsapp-contacts` connection (phase 1) and
 * is refused while the owner's own "never" rule on this class stands: undoing a
 * "never" is done in the interview ("ערוך את הכללים"), never here.
 *
 * The revert sets the base back to `approve_required` (the phase-1 value).
 */
import { ulid } from 'ulid';
import type { BusinessCharter, UnsignedCharter } from '../domain/charter.js';
import { declaresWhatsAppContacts } from './amend-whatsapp-contacts.js';
import { INTERVIEW_NEVER_PREFIX } from './interview/build.js';

/** What the auto-reply signature authorises, verbatim (original spec §9.3). */
export const AUTO_REPLY_AUTHORISATION_TEXT =
  'העוזרת תענה לבד ללקוחות ולספקים שהכנסת, רק בנושאים שאישרת, ורק עם מידע ציבורי או מידע של אותו כותב. היא תענה גם כשרמת החופש הכללית כבויה.';

export class AutoReplyPreconditionError extends Error {
  constructor(reason: string) {
    super(`cannot sign WhatsApp auto-reply: ${reason}`);
    this.name = 'AutoReplyPreconditionError';
  }
}

export class AutoReplyNotSignedError extends Error {
  constructor(charterVersion: string) {
    super(`charter ${charterVersion} does not sign WhatsApp auto-reply; nothing to revert`);
    this.name = 'AutoReplyNotSignedError';
  }
}

export function autoReplySigned(charter: BusinessCharter): boolean {
  const base = charter.autonomy.base['whatsapp.reply'];
  return declaresWhatsAppContacts(charter) && (base === 'auto_notify' || base === 'auto');
}

export function autoReplyBlockedByNever(charter: BusinessCharter): boolean {
  return charter.forbidden.some((r) => r.id === `${INTERVIEW_NEVER_PREFIX}whatsapp.reply`);
}

export function buildWhatsAppAutoReplyAmendment(active: BusinessCharter, now: Date): UnsignedCharter {
  if (!declaresWhatsAppContacts(active)) throw new AutoReplyPreconditionError('the WhatsApp connection is not signed');
  if (autoReplySigned(active)) throw new AutoReplyPreconditionError('already signed');
  if (autoReplyBlockedByNever(active)) throw new AutoReplyPreconditionError('the charter forbids WhatsApp replies');
  const { signature: _signature, ...rest } = structuredClone(active);
  return {
    ...rest,
    charterVersion: `${active.charterVersion}.war-${ulid()}`,
    effectiveFrom: now.toISOString(),
    supersedes: active.charterVersion,
    autonomy: { ...rest.autonomy, base: { ...rest.autonomy.base, 'whatsapp.reply': 'auto_notify' } },
  };
}

export function buildWhatsAppAutoReplyRevert(active: BusinessCharter, now: Date): UnsignedCharter {
  if (!autoReplySigned(active)) throw new AutoReplyNotSignedError(active.charterVersion);
  const { signature: _signature, ...rest } = structuredClone(active);
  return {
    ...rest,
    charterVersion: `${active.charterVersion}.war-revert-${ulid()}`,
    effectiveFrom: now.toISOString(),
    supersedes: active.charterVersion,
    autonomy: { ...rest.autonomy, base: { ...rest.autonomy.base, 'whatsapp.reply': 'approve_required' } },
  };
}
