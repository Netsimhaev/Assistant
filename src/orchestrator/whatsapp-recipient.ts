import { authorityNumberKey } from '../governance/principal-number.js';
import type { InstructionTextOrigin } from '../governance/typed-recipients.js';
import { toOneLine } from '../util/bidi.js';
import type { BusinessDb } from '../db/pool.js';
import type { PlanStep } from '../domain/plan.js';
import { listManagedContacts } from '../business/settings-contacts.js';
import { MAX_SEND_AHEAD_MS, hasSendAt, readSendAt } from '../util/send-at.js';
import { WA_ATTACHMENT_WITHOUT_CONVERSATION_HE, waAttachmentWithoutConversation, waCarriesAttachment } from '../domain/wa-attachment.js';

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

export const WA_SEND_AT_INVALID = 'מועד השליחה בוואטסאפ אינו תקין.';
export const WA_SEND_AT_PAST = 'מועד השליחה בוואטסאפ כבר עבר.';
export const WA_SEND_AT_TOO_FAR = 'אפשר לתזמן הודעת וואטסאפ עד 30 יום קדימה.';
export const SEND_AT_NOT_WHATSAPP = 'מועד שליחה אפשר לקבוע רק להודעת וואטסאפ.';

/**
 * Why a plan step cannot be offered as an owner-ordered send, or null.
 * The one check the instruction door and the re-ask both run:
 *  - a `sendAt` on any tool other than `wa.send_message` is refused — the
 *    scheduled-send extension and the "בשעה" echo are WhatsApp's alone;
 *  - a `wa.send_message` must go to a saved contact or a number typed in a
 *    typed instruction (`waRecipientSource`);
 *  - its `sendAt`, when present, must parse, be in the future, and be at most
 *    30 days ahead;
 *  - it may not carry `attachDocumentId` at all: an owner-ordered message
 *    never attaches a stored file, because the id could name any document of
 *    the business, a stranger's included, and the "yes" skips gate stages
 *    5–9. A `conversationId` does not change that — only a contact card's
 *    own job may attach (`jobIsCardOfConversation`, enforced in `runPlan`).
 */
export async function waStepProblem(
  db: BusinessDb,
  step: PlanStep,
  instruction: { text: string; textOrigin: InstructionTextOrigin },
  now: Date = new Date(),
): Promise<{ reason: string; audit: string } | null> {
  if (step.toolName !== 'wa.send_message') {
    return hasSendAt(step.input)
      ? { reason: SEND_AT_NOT_WHATSAPP, audit: `step ${step.id} ${step.toolName} carries sendAt` }
      : null;
  }
  // An owner-ordered message never attaches a stored file — with or without
  // a conversation id. A real conversation id refines the step to
  // `whatsapp.reply` but does not make this job that conversation's card;
  // `runPlan` enforces the card binding again before a byte is read.
  if (waCarriesAttachment(step.input)) {
    return {
      reason: WA_ATTACHMENT_WITHOUT_CONVERSATION_HE,
      audit: waAttachmentWithoutConversation(step.toolName, step.input)
        ? `step ${step.id} wa.send_message carries attachDocumentId without a conversationId`
        : `step ${step.id} owner-ordered wa.send_message carries attachDocumentId`,
    };
  }
  const contacts = await listManagedContacts(db);
  const source = waRecipientSource(Object.hasOwn(step.input, 'to') ? step.input['to'] : undefined, {
    contacts,
    instructionText: instruction.text,
    textOrigin: instruction.textOrigin,
  });
  if (source === null) {
    return {
      reason: WA_RECIPIENT_REFUSAL,
      audit: `step ${step.id} wa.send_message recipient neither a saved contact nor typed`,
    };
  }
  if (hasSendAt(step.input)) {
    const at = readSendAt(step.input);
    if (at === null) return { reason: WA_SEND_AT_INVALID, audit: `step ${step.id} wa.send_message sendAt unparsable` };
    if (at.getTime() <= now.getTime()) {
      return { reason: WA_SEND_AT_PAST, audit: `step ${step.id} wa.send_message sendAt in the past` };
    }
    if (at.getTime() - now.getTime() > MAX_SEND_AHEAD_MS) {
      return { reason: WA_SEND_AT_TOO_FAR, audit: `step ${step.id} wa.send_message sendAt more than 30 days ahead` };
    }
  }
  return null;
}
