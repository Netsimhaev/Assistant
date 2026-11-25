/**
 * Everything open on WhatsApp that one typed message could be answering —
 * ONE definition, read by the confirmation reader, the document-card reader
 * and the mail-card reader (`whatsapp-door.ts`), so their collision counts
 * cannot drift apart.
 *
 * Six kinds, each by its own owner's definition and nothing re-derived here:
 *
 *   - `confirmations` — boss-command questions delivered on WhatsApp before
 *     the message (`openConfirmations`);
 *   - `mailCards` — mailbox reply cards presented before the message
 *     (`openMailCards`);
 *   - `questions` — clarifying questions answerable on WhatsApp now
 *     (`answerableWhatsAppQuestions`);
 *   - `documentCards` — document cards delivered on WhatsApp before the
 *     message (`openDocumentCards`);
 *   - `contactCards` — WhatsApp contact reply cards presented before the
 *     message (`openContactCards`);
 *   - `suggestions` — learned suggestions delivered on WhatsApp before the
 *     message and inside the window (`deliveredOpenSuggestions`). "כן" is a
 *     confirmation word too, so every other reader must count these.
 *
 * Read-only. Each reader decides what "more than one" means for its own
 * words; this module only makes sure they all count the same things.
 */
import type { BusinessDb } from '../db/pool.js';
import type { InstructionConfirmation } from '../governance/instruction-confirmations.js';
import type { InstructionRecord } from '../governance/instructions.js';
import type { DocumentCard } from '../production/card.js';
import { openContactCards, type OpenContactCard } from '../whatsapp/contact-card.js';
import { deliveredOpenSuggestions, type Suggestion } from '../whatsapp/contact-suggestions.js';
import { capFor, loadRuntimeSettings } from '../tenancy/runtime-settings.js';
import { openConfirmations } from './command-confirm.js';
import { openDocumentCards } from './whatsapp-document-card.js';
import { openMailCards, type OpenMailCard } from './whatsapp-mail-card.js';
import { answerableWhatsAppQuestions } from './whatsapp-routing.js';

export interface OpenOnWhatsApp {
  confirmations: InstructionConfirmation[];
  mailCards: OpenMailCard[];
  questions: InstructionRecord[];
  documentCards: DocumentCard[];
  /** WhatsApp contact (client/supplier) reply cards presented before the message. */
  contactCards: OpenContactCard[];
  /** Learned suggestions delivered on WhatsApp before the message, inside the window. */
  suggestions: Suggestion[];
}

export async function openOnWhatsApp(db: BusinessDb, input: {
  /** The inbound message being routed — never counted as a later closure of its own card. */
  excludeMessageId: string;
  /** The message's provider timestamp. Unreadable → nothing time-gated is open for it. */
  inboundAt: string;
  windowMinutes?: number;
}): Promise<OpenOnWhatsApp> {
  const windowOverride = input.windowMinutes !== undefined ? { windowMinutes: input.windowMinutes } : {};
  const inbound = new Date(input.inboundAt);
  // Sequential, never `Promise.all`: all six read on the one `BusinessDb`, and
  // a shared connection must not carry interleaved work (a reader that opens
  // its own transaction would capture the others' statements).
  const confirmations = await openConfirmations(db, {
    channel: 'whatsapp',
    inboundAt: Number.isNaN(inbound.getTime()) ? null : inbound,
    ...windowOverride,
  });
  const mailCards = await openMailCards(db, {
    excludeMessageId: input.excludeMessageId,
    inboundAt: input.inboundAt,
    ...windowOverride,
  });
  const questions = await answerableWhatsAppQuestions(db, { ...windowOverride });
  const documentCards = await openDocumentCards(db, { inboundAt: input.inboundAt, ...windowOverride });
  const contactCards = await openContactCards(db, {
    excludeMessageId: input.excludeMessageId,
    inboundAt: input.inboundAt,
    ...windowOverride,
  });
  // The window resolves the same way the card readers resolve theirs; a
  // window of 0 or less fails closed — nothing is open.
  const suggestionWindow =
    input.windowMinutes ?? capFor(await loadRuntimeSettings(db), 'whatsappQuestionWindowMinutes');
  const suggestions =
    suggestionWindow > 0
      ? await deliveredOpenSuggestions(db, {
          inboundAt: Number.isNaN(inbound.getTime()) ? null : inbound,
          windowMinutes: suggestionWindow,
        })
      : [];
  return { confirmations, mailCards, questions, documentCards, contactCards, suggestions };
}
