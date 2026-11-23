/**
 * Failure codes after which the far end may have accepted an outbound message.
 * `delivery_unknown` is a send adapter's "we cannot tell" answer;
 * `adapter_timeout` is the orchestrator's own deadline. Neither carries
 * "nothing was created". Shared by the mail re-raise (`mail-reply.ts`) and
 * the WhatsApp contact-card failure note (`contact-housekeeping.ts`), so the
 * two never disagree about which failures to warn on.
 */
export const MAY_HAVE_SENT_CODES: readonly string[] = ['delivery_unknown', 'adapter_timeout'];
