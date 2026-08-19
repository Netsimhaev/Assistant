import { REDACTED } from '../../policy/redact.js';
import type { AdapterCall, AdapterResult, CredentialHandle, ExternalAdapter } from './types.js';

export interface MailMessage {
  to: string[];
  subject: string;
  body: string;
}

/**
 * Everything the transport needs beyond the message itself.
 *
 * Bundled rather than three positional parameters so a future field (a
 * `From` override, a reply-to) does not reshuffle every implementation's
 * signature.
 */
export interface MailSendContext {
  /**
   * The resolved per-connection secret (an SMTP password, an app token).
   * Every layer beneath this adapter — the binding's `credential_ref`, the
   * prefix namespace, the branded handle, the non-enumerable `value` — exists
   * to deliver this secret to the one place that actually opens a connection.
   * Read `credential.value`; never log or serialise the handle itself.
   */
  credential: CredentialHandle;
  /**
   * `AdapterCall.idempotencyKey`, forwarded unchanged. A real SMTP
   * implementation should fold it into the outgoing `Message-ID` header (or
   * an equivalent provider dedupe token): the point is that a timeout
   * between the send succeeding at the far end and the response reaching
   * this process must not, on retry, produce a second message with a second
   * `Message-ID` — the caller retries with the same key precisely so the
   * transport (or the SMTP relay behind it) can recognise the repeat.
   */
  idempotencyKey: string;
  /**
   * `AdapterCall.signal`, forwarded unchanged. This adapter refuses before
   * ever calling the transport if the signal is already aborted, so this is
   * only useful once a send is in flight — a transport backed by a real
   * connection should wire it into its own cancellation or timeout so a
   * stalled socket does not hang whatever called `execute`. Cancelling an
   * in-flight SMTP `DATA` command safely is the transport's problem, not
   * this adapter's: only the transport knows whether the bytes already left
   * the process.
   */
  signal: AbortSignal;
}

/**
 * The seam between this adapter and a real SMTP client.
 *
 * An interface rather than a direct nodemailer call so every test drives a
 * recording transport and no test ever sends a real message.
 *
 * A rejection is communicated by throwing, and the adapter reads the thrown
 * value's shape to decide `retryable` (see `classifyTransportFailure`
 * below) rather than requiring a bespoke error class, because that shape —
 * `responseCode`, `code`, `command` — is what a real SMTP client (nodemailer
 * among them) already throws.
 */
export interface MailTransport {
  send(message: MailMessage, context: MailSendContext): Promise<{ messageId: string }>;
}

export interface MailAdapterOptions {
  system: string;
  transport: MailTransport;
}

/** The only tool this adapter serves; checked against `call.toolName` before anything runs. */
const SERVED_TOOLS: readonly string[] = ['mail.send'];

/**
 * Send mail over SMTP.
 *
 * SMTP rather than a provider API: it works against Gmail, Outlook and any
 * self-hosted server with a username and password behind a credential ref,
 * instead of an OAuth flow that is a project of its own. The point of the
 * first adapter is to exercise the layer, not to pick a vendor.
 *
 * `mail.send` only. Reading mail is an inbound direction — it feeds
 * `intake.triage`, which does not exist, and it carries untrusted content that
 * needs the quarantine chain.
 */
export function createMailAdapter(options: MailAdapterOptions): ExternalAdapter {
  return {
    system: options.system,
    channel: 'api',
    serves: SERVED_TOOLS,

    async execute(call: AdapterCall): Promise<AdapterResult> {
      // AdapterRegistry.get looks an adapter up by system name alone and
      // does not check `serves` -- a mis-wired binding could hand this
      // adapter a call for a tool it was never meant to run. `serves` on
      // the object above is what other code inspects; this is what stops a
      // wrong-tool call from actually sending mail.
      if (!SERVED_TOOLS.includes(call.toolName)) {
        return {
          ok: false,
          retryable: false,
          code: 'unsupported_tool',
          message: `מתאם הדואר אינו משרת את הכלי "${call.toolName}"`,
        };
      }

      // Nothing has happened yet, so refusing costs nothing external and the
      // caller is free to retry the same attempt later.
      if (call.signal.aborted) {
        return {
          ok: false,
          retryable: true,
          code: 'aborted',
          message: 'הבקשה בוטלה לפני שהדואר נשלח',
        };
      }

      if (call.credential === null) {
        return {
          ok: false,
          retryable: false,
          code: 'credential_missing',
          message: 'אין credential לחיבור — ההודעה לא נשלחה',
        };
      }

      const input = isRecord(call.input) ? call.input : {};
      const to = readRecipients(input);
      if (to.length === 0) {
        // Sending to nobody succeeds at the transport and fails at the goal.
        // Also reached when every candidate recipient failed shape
        // validation (see readRecipients) -- a garbled address is not a
        // recipient any more than a missing one is.
        return {
          ok: false,
          retryable: false,
          code: 'no_recipient',
          message: 'המטען אינו נושא נמען קריא',
        };
      }

      const subject = readString(input, 'subject');
      const body = readString(input, 'body');
      if (subject === null || body === null) {
        // A send that "succeeds" with an empty subject or body delivers
        // nothing and reports ok: true -- worse than a refusal, because
        // nothing downstream learns anything went wrong.
        return {
          ok: false,
          retryable: false,
          code: 'message_incomplete',
          message: 'למכתב חסר נושא או גוף — ההודעה לא נשלחה',
        };
      }

      try {
        const sent = await options.transport.send(
          { to, subject, body },
          { credential: call.credential, idempotencyKey: call.idempotencyKey, signal: call.signal },
        );
        return { ok: true, output: sent, externalId: sent.messageId };
      } catch (error) {
        return classifyTransportFailure(error);
      }
    },
  };
}

/**
 * Turn a thrown transport failure into a result, in three distinct shapes.
 *
 * - **Permanent** (`responseCode` 5xx — "550 no such mailbox", "535 bad
 *   credentials"): the server actively refused the message and retrying
 *   unchanged will refuse it again. Not retryable.
 * - **Transient** (`responseCode` 4xx, or a `code` naming a network failure
 *   that never reached the server at all — connection refused, DNS,
 *   socket): retryable. Nothing was accepted, so nothing can be duplicated.
 * - **Ambiguous** (`command: 'DATA'`, meaning the message body may already
 *   have left this process before the failure, or any shape this function
 *   does not recognise): the outcome is unknown. Retrying risks a duplicate
 *   send, so this is deliberately **not** retryable even though nothing
 *   here proves the send failed — for mail a duplicate is merely
 *   embarrassing, but this adapter is the pattern later ones (a purchase)
 *   copy, and there a duplicate is a real loss. An unclassified failure
 *   gets the same treatment as an unrecognised one: the restrictive answer,
 *   not the convenient one.
 */
function classifyTransportFailure(error: unknown): AdapterResult {
  const shape = isRecord(error) ? error : {};
  const message = error instanceof Error ? error.message : String(error);

  const responseCode = shape['responseCode'];
  if (typeof responseCode === 'number') {
    if (responseCode >= 500 && responseCode < 600) {
      return { ok: false, retryable: false, code: 'send_rejected', message };
    }
    if (responseCode >= 400 && responseCode < 500) {
      return { ok: false, retryable: true, code: 'transport_error', message };
    }
  }

  // The connection dropped while (or after) the message body was in
  // transit, with no final reply -- the server may or may not have it.
  if (shape['command'] === 'DATA') {
    return { ok: false, retryable: false, code: 'delivery_unknown', message };
  }

  const code = shape['code'];
  if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) {
    return { ok: false, retryable: true, code: 'transport_error', message };
  }

  // Unrecognised shape: this function cannot tell whether the message went
  // out, so it does not guess "safe to retry."
  return { ok: false, retryable: false, code: 'delivery_unknown', message };
}

/**
 * Network-layer failure codes that mean the connection never reached the
 * server, or reached it and got no reply at all -- never that the server
 * saw and rejected the message. Matches what nodemailer's SMTP client
 * throws (`err.code`), without importing nodemailer: the adapter reads a
 * conventional shape, not a vendor type.
 */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EDNS',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A deliberately loose but shape-checked address: no internal whitespace,
 * exactly the one `@`, and at least one `.` in the domain part. Not RFC
 * 5322 -- just enough to refuse the two concrete failures this guards
 * against: the redaction placeholder, and a fragment of a comma-shredded
 * display name like `"Cohen, Dana" <dana@x.com>` (which splits into
 * `"Cohen` and `Dana" <dana@x.com>`, neither of which is a bare address).
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPlausibleEmail(value: string): boolean {
  // Named explicitly rather than relying on EMAIL_SHAPE to reject it by
  // accident: '[הוסר]' has no '@' and would already fail the pattern, but
  // the redaction placeholder is exactly the one string this check must
  // never let through, on purpose, forever -- not merely today, by
  // coincidence of what the pattern happens to match.
  if (value === REDACTED) return false;
  return EMAIL_SHAPE.test(value);
}

/**
 * Every recipient, whether the payload carried a list or one joined string.
 *
 * Reads the same three keys as `readEmails` in `src/policy/facts.ts` — `to`,
 * `recipient`, `email` — with the same split-and-collect shape, so the
 * gate's do-not-contact check and this adapter's actual send never look at
 * different recipient sets. This function keeps the original case (SMTP
 * local parts are, by RFC, case-sensitive) where `readEmails` lower-cases
 * for matching; the parity test in `adapters.test.ts` drives both functions
 * over one case table and normalises case before comparing, rather than
 * checking each against a separately hand-written expectation that could
 * drift from the other file without anyone noticing.
 */
export function readRecipients(input: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of ['to', 'recipient', 'email']) {
    const raw = input[key];
    if (typeof raw === 'string') values.push(raw);
    else if (Array.isArray(raw)) {
      for (const item of raw) if (typeof item === 'string') values.push(item);
    }
  }

  return values
    .flatMap((value) => value.split(/[,;]/))
    .map((value) => value.trim())
    .filter((value) => isPlausibleEmail(value));
}
