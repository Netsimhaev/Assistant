/**
 * A WhatsApp attachment belongs to a contact-card reply, and only there.
 *
 * `attachDocumentId` on `wa.send_message` is honoured only when the payload
 * also carries a real `conversationId` (own key, non-empty string): the card
 * path sets it from a tier-2 source the drafter was shown in that very run
 * (ruling R11c). An owner-ordered message (no conversation) that names a
 * stored document could name ANY document of the business — a file a
 * stranger mailed in included — and its "yes" skips gate stages 5–9. So the
 * instruction door, the re-ask and `runPlan` all refuse that shape.
 *
 * Own-key reads only, like every routing read: an inherited
 * `conversationId` must not make an attachment acceptable.
 */
export function waCarriesAttachment(input: Record<string, unknown>): boolean {
  return Object.hasOwn(input, 'attachDocumentId');
}

export function waCarriesConversation(input: Record<string, unknown>): boolean {
  if (!Object.hasOwn(input, 'conversationId')) return false;
  const v = input['conversationId'];
  return typeof v === 'string' && v !== '';
}

/** True when a `wa.send_message` payload names a file but no conversation. */
export function waAttachmentWithoutConversation(toolName: string, input: Record<string, unknown>): boolean {
  return toolName === 'wa.send_message' && waCarriesAttachment(input) && !waCarriesConversation(input);
}

export const WA_ATTACHMENT_WITHOUT_CONVERSATION_CODE = 'wa_attachment_without_conversation';
export const WA_ATTACHMENT_WITHOUT_CONVERSATION_HE =
  'אפשר לצרף קובץ להודעת וואטסאפ רק כתשובה לפנייה של איש קשר — לא בהודעה שנשלחת ביוזמתך.';
