/**
 * Everything open on WhatsApp that one typed message could be answering —
 * ONE definition, read by the confirmation reader, the document-card reader
 * and the mail-card reader (`whatsapp-door.ts`), so their collision counts
 * cannot drift apart.
 *
 * Four kinds, each by its own owner's definition and nothing re-derived here:
 *
 *   - `confirmations` — boss-command questions delivered on WhatsApp before
 *     the message (`openConfirmations`);
 *   - `mailCards` — mailbox reply cards presented before the message
 *     (`openMailCards`);
 *   - `questions` — clarifying questions answerable on WhatsApp now
 *     (`answerableWhatsAppQuestions`);
 *   - `documentCards` — document cards delivered on WhatsApp before the
 *     message (`openDocumentCards`).
 *
 * Read-only. Each reader decides what "more than one" means for its own
 * words; this module only makes sure they all count the same things.
 */
import type { InstructionConfirmation } from '../governance/instruction-confirmations.js';
import type { InstructionRecord } from '../governance/instructions.js';
import type { DocumentCard } from '../production/card.js';
import { openConfirmations } from './command-confirm.js';
import { openDocumentCards } from './whatsapp-document-card.js';
import { openMailCards, type OpenMailCard } from './whatsapp-mail-card.js';
import { answerableWhatsAppQuestions } from './whatsapp-routing.js';

export interface OpenOnWhatsApp {
  confirmations: InstructionConfirmation[];
  mailCards: OpenMailCard[];
  questions: InstructionRecord[];
  documentCards: DocumentCard[];
}

export async function openOnWhatsApp(input: {
  businessId: string;
  /** The inbound message being routed — never counted as a later closure of its own card. */
  excludeMessageId: string;
  /** The message's provider timestamp. Unreadable → nothing time-gated is open for it. */
  inboundAt: string;
  windowMinutes?: number;
}): Promise<OpenOnWhatsApp> {
  const windowOverride = input.windowMinutes !== undefined ? { windowMinutes: input.windowMinutes } : {};
  const inbound = new Date(input.inboundAt);
  const [confirmations, mailCards, questions, documentCards] = await Promise.all([
    openConfirmations({
      businessId: input.businessId,
      channel: 'whatsapp',
      inboundAt: Number.isNaN(inbound.getTime()) ? null : inbound,
      ...windowOverride,
    }),
    openMailCards({
      businessId: input.businessId,
      excludeMessageId: input.excludeMessageId,
      inboundAt: input.inboundAt,
      ...windowOverride,
    }),
    answerableWhatsAppQuestions({ businessId: input.businessId, ...windowOverride }),
    openDocumentCards({ businessId: input.businessId, inboundAt: input.inboundAt, ...windowOverride }),
  ]);
  return { confirmations, mailCards, questions, documentCards };
}
