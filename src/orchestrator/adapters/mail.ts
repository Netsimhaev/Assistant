import type { AdapterCall, AdapterResult, ExternalAdapter } from './types.js';

export interface MailMessage {
  to: string[];
  subject: string;
  body: string;
}

/**
 * The seam between this adapter and a real SMTP client.
 *
 * An interface rather than a direct nodemailer call so every test drives a
 * recording transport and no test ever sends a real message.
 *
 * `idempotencyKey` is `AdapterCall.idempotencyKey`, forwarded unchanged. A
 * real SMTP implementation should fold it into the outgoing `Message-ID`
 * header (or an equivalent provider dedupe token): the point is that a
 * timeout between the send succeeding at the far end and the response
 * reaching this process must not, on retry, produce a second message with a
 * second `Message-ID` — the caller retries with the same key precisely so
 * the transport (or the SMTP relay behind it) can recognise the repeat.
 */
export interface MailTransport {
  send(message: MailMessage, idempotencyKey: string): Promise<{ messageId: string }>;
}

export interface MailAdapterOptions {
  system: string;
  transport: MailTransport;
}

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
    serves: ['mail.send'],

    async execute(call: AdapterCall): Promise<AdapterResult> {
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
        return {
          ok: false,
          retryable: false,
          code: 'no_recipient',
          message: 'המטען אינו נושא נמען קריא',
        };
      }

      try {
        const sent = await options.transport.send(
          {
            to,
            subject: readString(input, 'subject') ?? '',
            body: readString(input, 'body') ?? '',
          },
          call.idempotencyKey,
        );
        return { ok: true, output: sent, externalId: sent.messageId };
      } catch (error) {
        // The server being down is a reason to come back later; the caller
        // reschedules on `retryable`.
        return {
          ok: false,
          retryable: true,
          code: 'transport_error',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Every recipient, whether the payload carried a list or one joined string.
 *
 * Mirrors `readEmails` in `src/policy/facts.ts` exactly (same key, same
 * split, same "collect all, not just the first" shape) because the gate and
 * this adapter must agree on who the recipients are. If they disagreed, the
 * do-not-contact check in `buildFacts` could clear a payload by checking one
 * set of addresses while this adapter mails a different, larger set — the
 * most dangerous possible divergence between the two.
 */
function readRecipients(input: Record<string, unknown>): string[] {
  const raw = input['to'];
  const values: string[] = [];
  if (typeof raw === 'string') values.push(raw);
  else if (Array.isArray(raw)) {
    for (const item of raw) if (typeof item === 'string') values.push(item);
  }

  return values
    .flatMap((value) => value.split(/[,;]/))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
