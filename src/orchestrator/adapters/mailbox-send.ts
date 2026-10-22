import { createGmailClient } from '../../mail/providers/gmail.js';
import { createGraphClient } from '../../mail/providers/graph.js';
import { isFailure } from '../../mail/providers/types.js';
import type { MailboxClient, MailboxFailure } from '../../mail/providers/types.js';
import type { MailProvider } from '../../mail/mailbox.js';
import { readRecipients, readString } from './mail.js';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './types.js';

export interface MailboxSendOptions {
  system: string;
  provider: MailProvider;
  /** Test seam; defaults to the provider's real client. */
  client?: MailboxClient;
}

const SERVED_TOOLS: readonly string[] = ['mail.send'];

/**
 * Send a REPLY through the owner's own mailbox (Gmail or Microsoft 365).
 *
 * Replies only: a payload with no `inReplyTo`/`threadId`/`providerMessageId`
 * is refused as `not_a_reply`, never sent as a fresh mail. And exactly one
 * recipient: a reply goes to the original sender and nobody else, so a
 * multi-address `to` is refused rather than trimmed.
 *
 * Reads only OWN keys of the redacted payload (`readString`/`readRecipients`
 * use `Object.hasOwn`), so nothing the gate's redaction never walked is sent.
 *
 * **Failure semantics.** `retryable: true` is a declaration that nothing was
 * created. A status-0 failure (the network dropped on the send POST) cannot
 * make that claim -- the provider may have accepted the message -- so it is
 * terminal `delivery_unknown`, the same principle the SMTP adapter applies
 * after DATA. 401 and 429/5xx are provider answers received before
 * acceptance and stay retryable.
 */
export function createMailboxSendAdapter(options: MailboxSendOptions): ExternalAdapter {
  const client: MailboxClient =
    options.client ?? (options.provider === 'google' ? createGmailClient() : createGraphClient());

  return {
    system: options.system,
    channel: 'api',
    serves: SERVED_TOOLS,

    async execute(call: AdapterCall): Promise<AdapterResult> {
      if (!SERVED_TOOLS.includes(call.toolName)) {
        return {
          ok: false,
          retryable: false,
          code: 'unsupported_tool',
          message: `מתאם תיבת הדואר אינו משרת את הכלי "${call.toolName}"`,
        };
      }
      if (call.signal.aborted) {
        return { ok: false, retryable: true, code: 'aborted', message: 'הבקשה בוטלה לפני שהדואר נשלח' };
      }
      if (call.credential === null) {
        return {
          ok: false,
          retryable: false,
          code: 'credential_unavailable',
          message: 'תיבת הדואר אינה מחוברת — ההודעה לא נשלחה',
        };
      }

      const input =
        typeof call.input === 'object' && call.input !== null && !Array.isArray(call.input)
          ? (call.input as Record<string, unknown>)
          : {};

      const inReplyTo = readString(input, 'inReplyTo');
      const threadId = readString(input, 'threadId');
      const providerMessageId = readString(input, 'providerMessageId');
      if (inReplyTo === null || threadId === null || providerMessageId === null) {
        return {
          ok: false,
          retryable: false,
          code: 'not_a_reply',
          message: 'תיבת הדואר שולחת תשובות בלבד — חסר שדה שרשור, ההודעה לא נשלחה',
        };
      }

      const to = readRecipients(input);
      if (to.length !== 1) {
        return {
          ok: false,
          retryable: false,
          code: 'no_recipient',
          message:
            to.length === 0
              ? 'המטען אינו נושא נמען קריא'
              : 'תשובה נשלחת לכתובת אחת בלבד — ההודעה לא נשלחה',
        };
      }

      const subject = readString(input, 'subject');
      const body = readString(input, 'body');
      if (subject === null || body === null) {
        return {
          ok: false,
          retryable: false,
          code: 'message_incomplete',
          message: 'למכתב חסר נושא או גוף — ההודעה לא נשלחה',
        };
      }

      let result: { externalId: string | null } | MailboxFailure;
      try {
        result = await client.sendReply(
          call.credential.value,
          { to, subject, body, inReplyTo, references: readString(input, 'references'), threadId, providerMessageId },
          call.signal,
        );
      } catch (error) {
        // The clients never throw, but a throw after the POST began is the
        // same unknown as status 0.
        return {
          ok: false,
          retryable: false,
          code: 'delivery_unknown',
          message: error instanceof Error ? error.message : String(error),
        };
      }

      if (!isFailure(result)) {
        return { ok: true, output: { externalId: result.externalId }, externalId: result.externalId };
      }
      switch (result.failure) {
        case 'auth':
          return { ok: false, retryable: true, code: 'auth_failed', message: result.message };
        case 'transient':
          if (result.status === 0) {
            return { ok: false, retryable: false, code: 'delivery_unknown', message: result.message };
          }
          return { ok: false, retryable: true, code: 'transient', message: result.message };
        default:
          // rejected, and cursor_expired (cannot occur on a send).
          return { ok: false, retryable: false, code: 'send_rejected', message: result.message };
      }
    },
  };
}
