import { authorityNumberKey } from '../governance/principal-number.js';
import type { InstructionTextOrigin } from '../governance/typed-recipients.js';
import { toOneLine } from '../util/bidi.js';

/**
 * Who an owner-ordered WhatsApp message may go to (task 13, H2): a contact the
 * owner saved ("הגדרות ← אנשים", `listManagedContacts`) or a number he TYPED
 * in this instruction. Nothing else — not a number the planner found in
 * memory, not one that only appears in a voice transcript.
 *
 * Both sides are compared by `authorityNumberKey`: full international form
 * with a leading `+`, exact digits. Never the last-nine-digit rule
 * (`phoneKey`): that grants authority to a different number sharing a
 * suffix. A transcribed instruction is not typing (`textOrigin` must be
 * `'typed'`); a saved contact counts whatever the origin, because the owner
 * saved it, not because it was said today.
 */

export type WaRecipientSource = { kind: 'contact'; name: string } | { kind: 'typed' };

export interface WaRecipientContext {
  contacts: readonly { name: string; phone: string }[];
  instructionText: string;
  textOrigin: InstructionTextOrigin;
}

/** Every `+`-led number in the text, as `authorityNumberKey` digits. */
export function typedAuthorityNumbersIn(text: string): Set<string> {
  const runs = text.match(/\+[\d  ().-]*\d/g) ?? [];
  const keys = new Set<string>();
  for (const run of runs) {
    const key = authorityNumberKey(run);
    if (key !== null) keys.add(key);
  }
  return keys;
}

export function waRecipientSource(to: unknown, ctx: WaRecipientContext): WaRecipientSource | null {
  if (typeof to !== 'string') return null;
  const key = authorityNumberKey(to);
  if (key === null) return null;
  const contact = ctx.contacts.find((c) => authorityNumberKey(c.phone) === key);
  if (contact !== undefined) return { kind: 'contact', name: contact.name };
  if (ctx.textOrigin === 'typed' && typedAuthorityNumbersIn(ctx.instructionText).has(key)) {
    return { kind: 'typed' };
  }
  return null;
}

/** The note shown after the recipient in the confirmation echo. */
export function waRecipientNote(source: WaRecipientSource): string {
  return source.kind === 'contact'
    ? `(איש קשר ששמרת: ${toOneLine(source.name)})`
    : '(הוקלד בהוראה)';
}

export const WA_RECIPIENT_REFUSAL = 'אפשר לשלוח בוואטסאפ רק לאיש קשר ששמרת או למספר שהקלדת בהוראה.';
