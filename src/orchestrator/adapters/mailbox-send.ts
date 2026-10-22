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
 * Send mail through the owner's own mailbox (Gmail or Microsoft 365) — a
 * reply, or a new message.
 *
 * After the mailbox amendment this adapter is the ONLY one serving
 * `mail.send` (`buildMailboxAmendment` moves the tool off every other
 * connection), and the sign page promises the owner that all outgoing mail
 * goes from the business mailbox. So it sends both shapes (ruling R21):
 *
 *   - **A reply** — all three threading fields (`inReplyTo`, `threadId`,
 *     `providerMessageId`) present — goes to exactly one recipient: the
 *     original sender and nobody else, so a multi-address `to` is refused
 *     rather than trimmed.
 *   - **A new message** — none of the three present (absent, `null` or `''`)
 *     — goes to one or more recipients via the provider's plain send, with no
 *     threading. This is what an instruction-door "write to Dana" becomes.
 *   - **Some but not all** is refused as `not_a_reply`: a payload that names a
 *     thread and cannot be threaded is never quietly sent as a fresh mail.
 *
 * The adapter grants nothing. A new message is `email.initiate` at the gate
 * (`refineActionClass`: no `inReplyTo`), which the charter holds at
 * `approve_required`, and the instruction door authorises only recipients the
 * owner typed or the charter knows (`authorisedRecipients`). The approved-reply
 * exemption (`policy/approved-reply.ts`) is for `email.reply` on a mailbox
 * reply job only and never reaches this branch. And the adapter can only send
 * a NEW message when the gate cannot have read the payload as a reply: the
 * gate's reply test is a non-empty `inReplyTo`, and any non-empty
 * `inReplyTo` here is "present", so it lands in the reply or `not_a_reply`
 * branch, never in this one.
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

      const subject = readString(input, 'subject');
      const body = readString(input, 'body');

      const threading = THREADING_FIELDS.map((key) => threadingPresence(input, key));
      if (threading.every((present) => !present)) {
        return sendNew(input, subject, body, call);
      }

      const inReplyTo = readString(input, 'inReplyTo');
      const threadId = readString(input, 'threadId');
      const providerMessageId = readString(input, 'providerMessageId');
      if (inReplyTo === null || threadId === null || providerMessageId === null) {
        return {
          ok: false,
          retryable: false,
          code: 'not_a_reply',
          message: 'חסר חלק משדות השרשור של התשובה — ההודעה לא נשלחה',
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

      if (subject === null || body === null) return MESSAGE_INCOMPLETE;

      const token = call.credential.value;
      return toAdapterResult(() =>
        client.sendReply(
          token,
          { to, subject, body, inReplyTo, references: readString(input, 'references'), threadId, providerMessageId },
          call.signal,
        ),
      );
    },
  };

  async function sendNew(
    input: Record<string, unknown>,
    subject: string | null,
    body: string | null,
    call: AdapterCall,
  ): Promise<AdapterResult> {
    const to = readRecipients(input);
    if (to.length === 0) {
      return { ok: false, retryable: false, code: 'no_recipient', message: 'המטען אינו נושא נמען קריא' };
    }
    if (subject === null || body === null) return MESSAGE_INCOMPLETE;
    if (call.credential === null) return CREDENTIAL_UNAVAILABLE;
    const token = call.credential.value;
    return toAdapterResult(() => client.sendNew(token, { to, subject, body }, call.signal));
  }
}

const THREADING_FIELDS = ['inReplyTo', 'threadId', 'providerMessageId'] as const;

/**
 * Whether a threading field is there at all. Own keys only, like every read
 * here. Absent, `null` and `''` mean "not there"; ANY other value — a
 * non-empty string, a number, an object — means there, so a malformed
 * threading field can only make the payload refuse, never make it a new mail.
 */
function threadingPresence(input: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(input, key)) return false;
  const value = input[key];
  return !(value === null || value === undefined || value === '');
}

const MESSAGE_INCOMPLETE: AdapterResult = {
  ok: false,
  retryable: false,
  code: 'message_incomplete',
  message: 'למכתב חסר נושא או גוף — ההודעה לא נשלחה',
};

const CREDENTIAL_UNAVAILABLE: AdapterResult = {
  ok: false,
  retryable: false,
  code: 'credential_unavailable',
  message: 'תיבת הדואר אינה מחוברת — ההודעה לא נשלחה',
};

/** One mapping from a client answer to an adapter result, shared by both send shapes. */
async function toAdapterResult(
  send: () => Promise<{ externalId: string | null } | MailboxFailure>,
): Promise<AdapterResult> {
  let result: { externalId: string | null } | MailboxFailure;
  try {
    result = await send();
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
}
