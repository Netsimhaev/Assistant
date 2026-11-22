import { z } from 'zod';
import { authorityNumberKey } from '../../governance/principal-number.js';
import type { WhatsAppGateway } from '../../whatsapp/gateway.js';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './types.js';

export const WHATSAPP_CONTACTS_ADAPTER_SYSTEM = 'whatsapp-contacts';

export interface WhatsAppContactsOptions {
  gateway: WhatsAppGateway;
  /** The number a stored conversation belongs to, or `null` when unknown — scoped by business, injected so the adapter holds no DB handle. */
  conversationNumber: (businessId: string, conversationId: string) => Promise<string | null>;
  /** Records the outbound message for the conversation history. */
  recordOutbound: (
    businessId: string,
    input: { body: string; jobId: string | null; recipientNumber: string },
  ) => Promise<void>;
}

const Input = z.object({
  to: z.string(),
  body: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  sendAt: z.string().optional(),
  attachDocumentId: z.string().min(1).optional(),
});

function refuse(code: string, message: string, retryable = false): AdapterResult {
  return { ok: false, retryable, code, message };
}

/**
 * Sends a WhatsApp message to a client or supplier. Returns a result, never
 * throws. `sendAt` is the job's scheduling concern (it wakes the step at that
 * time); the adapter itself only ever sends now.
 *
 * A thrown gateway error is `delivery_unknown` and NOT retryable: the message
 * may already have left, and a blind retry would double-send.
 */
export function createWhatsAppContactsAdapter(options: WhatsAppContactsOptions): ExternalAdapter {
  const { gateway } = options;
  return {
    system: WHATSAPP_CONTACTS_ADAPTER_SYSTEM,
    channel: 'api',
    serves: ['wa.send_message'],
    async execute(call: AdapterCall): Promise<AdapterResult> {
      const parsed = Input.safeParse(call.input);
      if (!parsed.success) return refuse('bad_input', 'פרטי ההודעה אינם תקינים.');
      const input = parsed.data;
      const key = authorityNumberKey(input.to);
      if (key === null) return refuse('bad_recipient', 'מספר הנמען אינו תקין — נדרש מספר בינלאומי עם +.');

      if (input.conversationId !== undefined) {
        let stored: string | null;
        try {
          stored = await options.conversationNumber(call.businessId, input.conversationId);
        } catch {
          return refuse('reply_target_lookup_failed', 'לא ניתן היה לאמת את השיחה. נסו שוב.', true);
        }
        if (stored === null || authorityNumberKey(`+${stored.replace(/^\+/, '')}`) !== key) {
          return refuse('reply_recipient_mismatch', 'המספר אינו תואם לשיחה שאליה מגיבים.');
        }
      }

      const file = input.attachDocumentId !== undefined ? call.attachments[0] : undefined;
      if (input.attachDocumentId !== undefined && file === undefined) {
        return refuse('attachment_missing', 'הקובץ שאושר לשליחה לא נמצא.');
      }
      if (file !== undefined && gateway.sendFile === undefined) {
        return refuse('attachment_unsupported', 'ערוץ הוואטסאפ אינו תומך בשליחת קבצים.');
      }

      let result: { messageId: string; state: 'sent' | 'queued' | 'rejected' };
      try {
        result =
          file !== undefined && gateway.sendFile !== undefined
            ? await gateway.sendFile({
                contactId: key,
                filename: file.filename,
                mediaType: file.mediaType,
                bytes: file.bytes,
                caption: input.body,
                idempotencyKey: call.idempotencyKey,
              })
            : await gateway.sendMessage({ contactId: key, body: input.body, idempotencyKey: call.idempotencyKey });
      } catch {
        return {
          ok: false,
          retryable: false,
          code: 'delivery_unknown',
          message: 'לא ידוע אם ההודעה נשלחה — לא נשלח שוב אוטומטית.',
        };
      }
      if (result.state === 'rejected') return refuse('whatsapp_rejected', 'הוואטסאפ דחה את ההודעה.');

      try {
        await options.recordOutbound(call.businessId, { body: input.body, jobId: null, recipientNumber: key });
      } catch {
        // The message left; a history write failing must not turn a delivery into a failure.
      }
      return { ok: true, output: { messageId: result.messageId, state: result.state }, externalId: result.messageId };
    },
  };
}
