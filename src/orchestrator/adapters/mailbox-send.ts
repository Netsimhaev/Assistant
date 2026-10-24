import { createGmailClient } from '../../mail/providers/gmail.js';
import { createGraphClient } from '../../mail/providers/graph.js';
import { isFailure } from '../../mail/providers/types.js';
import type { MailboxClient, MailboxFailure } from '../../mail/providers/types.js';
import type { ReplyTargetLookup } from '../../mail/inbox-store.js';
import type { MailProvider } from '../../mail/mailbox.js';
import { readRecipients, readString } from './mail.js';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './types.js';

export interface MailboxSendOptions {
  system: string;
  provider: MailProvider;
  /** Test seam; defaults to the provider's real client. */
  client?: MailboxClient;
  /**
   * Resolves an instruction reply's missing threading fields from the
   * business's stored mail (`replyTargetFor`). Required: a runtime that forgot
   * it would quietly fail every instructed reply again. Injected rather than
   * imported so the adapter holds no database handle of its own, like every
   * other adapter.
   */
  replyTargets: ReplyTargetLookup;
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
 *   - **A reply** — a non-empty `inReplyTo`, with or without `threadId` and
 *     `providerMessageId`. EVERY reply is looked up in THIS business's stored
 *     mail by Message-ID (`options.replyTargets`, scoped by `call.businessId`)
 *     — a card reply carrying all three fields too, so a planner-written step
 *     cannot name an arbitrary `providerMessageId` and reply-quote any message
 *     in the mailbox. The instruction door's planner never knows the
 *     provider's ids; the lookup supplies them. No stored mail →
 *     `reply_target_unknown`, terminal: a reply-classified payload is NEVER
 *     sent as a new mail, or an `email.reply` authorisation would buy what is
 *     really an initiate. A supplied id that disagrees with the stored one →
 *     `not_a_reply`; neither side is trusted over the other. Then `to` must be
 *     exactly one address equal (case-insensitive) to the stored From — never
 *     Reply-To — or `reply_recipient_mismatch`: on Microsoft the reply quotes
 *     the original, so a reply to anyone else is a hidden forward.
 *   - **A new message** — none of the three present (absent, `null` or `''`)
 *     — goes to one or more recipients via the provider's plain send, with no
 *     threading. This is what an instruction-door "write to Dana" becomes.
 *   - **Threading fields without `inReplyTo`** are refused as `not_a_reply`:
 *     there is nothing to resolve from, and a payload that names a thread and
 *     cannot be threaded is never quietly sent as a fresh mail.
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
      let threadId = readString(input, 'threadId');
      let providerMessageId = readString(input, 'providerMessageId');
      let references = readString(input, 'references');
      if (inReplyTo === null) return NOT_A_REPLY;
      // A present-but-unreadable field (a number, an object) is "there" by
      // `threadingPresence` and `null` by `readString`: refuse, never resolve
      // over it.
      if ((threadId === null && threading[1]) || (providerMessageId === null && threading[2])) {
        return NOT_A_REPLY;
      }
      // EVERY reply is checked against the stored mail it answers — a card
      // reply carrying all three fields included. Otherwise a planner-written
      // step could name any providerMessageId and reply-quote any message in
      // the mailbox.
      let target: Awaited<ReturnType<ReplyTargetLookup>>;
      try {
        target = await options.replyTargets(call.businessId, inReplyTo);
      } catch {
        // Our own database, before anything was sent: nothing was created,
        // so `retryable: true` is an honest claim. A fixed sentence, not the
        // driver's error text. An adapter returns, never throws.
        return REPLY_TARGET_LOOKUP_FAILED;
      }
      if (target === null) return REPLY_TARGET_UNKNOWN;
      if (
        (threadId !== null && threadId !== target.threadId) ||
        (providerMessageId !== null && providerMessageId !== target.providerMessageId)
      ) {
        return NOT_A_REPLY;
      }
      threadId = target.threadId;
      providerMessageId = target.providerMessageId;
      references ??= target.references;

      const to = readRecipients(input);
      if (to.length === 0) {
        return { ok: false, retryable: false, code: 'no_recipient', message: 'המטען אינו נושא נמען קריא' };
      }
      // A reply goes to the stored mail's From and nobody else — never its
      // Reply-To, never a second address. On Microsoft the reply quotes the
      // original, so a "reply" to anyone else is a hidden forward of a
      // stranger's mail priced as email.reply.
      const [only] = to;
      if (to.length !== 1 || only === undefined || only.toLowerCase() !== target.fromAddress.toLowerCase()) {
        return REPLY_RECIPIENT_MISMATCH;
      }

      if (subject === null || body === null) return MESSAGE_INCOMPLETE;

      const token = call.credential.value;
      return toAdapterResult(() =>
        client.sendReply(
          token,
          { to, subject, body, inReplyTo, references, threadId, providerMessageId },
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

const NOT_A_REPLY: AdapterResult = {
  ok: false,
  retryable: false,
  code: 'not_a_reply',
  message: 'פרטי השרשור של התשובה אינם תקינים',
};

const REPLY_RECIPIENT_MISMATCH: AdapterResult = {
  ok: false,
  retryable: false,
  code: 'reply_recipient_mismatch',
  message: 'תשובה בתוך שיחה נשלחת רק לשולח המקורי',
};

const REPLY_TARGET_LOOKUP_FAILED: AdapterResult = {
  ok: false,
  retryable: true,
  code: 'reply_target_lookup_failed',
  message: 'לא ניתן היה לבדוק את המייל שאליו עונים — ההודעה לא נשלחה',
};

const REPLY_TARGET_UNKNOWN: AdapterResult = {
  ok: false,
  retryable: false,
  code: 'reply_target_unknown',
  message: 'לא נמצא המייל שאליו מבקשים לענות בתיבת העסק',
};

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
