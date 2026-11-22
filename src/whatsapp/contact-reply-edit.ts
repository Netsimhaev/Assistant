import { canonicalJson } from '../util/canonical.js';

/**
 * Whether an owner's edit of a WhatsApp contact-card reply is allowed: only
 * `body` may differ. `to` and `conversationId` identify who and which thread
 * the approved text goes to, and the exemption in `approvedReplyCovers` is
 * bound to them — an edit that moved either would send the card's approval
 * to someone the card never showed. Every other key must be canonically equal,
 * present on both sides; a key added or dropped is a change.
 */
export function contactReplyEditAllowed(original: unknown, edited: unknown): boolean {
  if (typeof original !== 'object' || original === null || Array.isArray(original)) return false;
  if (typeof edited !== 'object' || edited === null || Array.isArray(edited)) return false;
  const p = original as Record<string, unknown>;
  const e = edited as Record<string, unknown>;
  const keys = new Set([...Object.keys(p), ...Object.keys(e)]);
  for (const key of keys) {
    if (!Object.hasOwn(p, key) || !Object.hasOwn(e, key)) return false;
    if (key === 'body') continue;
    if (canonicalJson(p[key]) !== canonicalJson(e[key])) return false;
  }
  return true;
}
