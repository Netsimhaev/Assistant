/**
 * The one file that imports `nodemailer`.
 *
 * Everything else in this codebase reaches mail through `MailTransport`
 * (`src/orchestrator/adapters/mail.ts`), an interface chosen precisely so no
 * test ever has to send anything real. This is the first implementation of
 * it — swapping SMTP providers, or the library itself, touches nothing
 * outside this one file.
 */
import nodemailer from 'nodemailer';
import type {
  MailMessage,
  MailSendContext,
  MailTransport,
} from '../orchestrator/adapters/mail.js';

export interface SmtpConfig {
  /** Used when a call's `context.endpoint` is `null`. */
  host: string;
  port: number;
  secure: boolean;
  /** The envelope `From:` header. */
  from: string;
  /**
   * A fixed account this transport instance always authenticates as.
   *
   * Omit it for the governed path: `createMailAdapter` (`mail.ts`) resolves a
   * real per-connection secret from `connection_bindings` and forwards it as
   * `context.credential` on every call — that field's own docblock is
   * explicit ("Read `credential.value`; never log or serialise the handle
   * itself"), so when no fixed account is configured here, every send reads
   * it from there instead.
   *
   * Supply it for a single-account relay that never receives a per-call
   * credential at all — the approval notifier's own system mailbox
   * (`createEmailNotifier`, `src/governance/notify.ts`) has no connection
   * binding and nothing resolves one for it, so the transport must already
   * hold what it needs.
   */
  auth?: { user: string; pass: string };
}

/**
 * A bare CR or LF anywhere in a header field lets it terminate the field
 * early and start a new one — `Subject: hi\r\nBcc: attacker@evil.com`
 * delivers a copy nothing upstream ever screened against do-not-contact.
 * `MailTransport`'s contract (see that interface's docblock) requires every
 * implementation to reject this outright rather than strip or encode it, so
 * a caller who thought a subject was clean is told it wasn't, instead of
 * silently having it rewritten into something that happens to be safe.
 */
const CRLF = /[\r\n]/;

function assertNoCrlf(value: string, field: string): void {
  if (CRLF.test(value)) {
    throw new Error(
      `${field} מכיל תו שורה חדשה (CR/LF) — נדחה למניעת הזרקת כותרות SMTP`,
    );
  }
}

/**
 * Wrap `nodemailer` behind `MailTransport`.
 *
 * A fresh `nodemailer` transporter is opened per send rather than held open
 * across calls: `context.endpoint` can differ call to call (a binding may
 * redirect one connection at a time, see that field's docblock), so the host
 * this function connects to is not knowable until the call arrives.
 */
export function createSmtpTransport(config: SmtpConfig): MailTransport {
  return {
    async send(
      message: MailMessage,
      context: MailSendContext,
    ): Promise<{ messageId: string }> {
      // Validated before anything else opens a socket: a rejected message
      // costs nothing external and the caller can fix the input and retry.
      assertNoCrlf(message.subject, 'הנושא');
      for (const to of message.to) assertNoCrlf(to, 'הנמען');

      if (context.signal.aborted) {
        throw new Error('הבקשה בוטלה לפני שהחיבור נפתח');
      }

      const auth =
        config.auth ?? { user: context.credential.ref, pass: context.credential.value };

      const transporter = nodemailer.createTransport({
        host: context.endpoint ?? config.host,
        port: config.port,
        secure: config.secure,
        auth,
      });

      // Folded into the outgoing Message-ID, per `MailSendContext.idempotencyKey`'s
      // own docblock: a retry with the same key must not read to the far end
      // as a second, distinct message.
      const domain = config.from.split('@')[1] ?? 'localhost';
      const messageId = `<${context.idempotencyKey}@${domain}>`;

      const info = await raceAbort(
        transporter.sendMail({
          from: config.from,
          to: message.to.join(', '),
          subject: message.subject,
          text: message.body,
          messageId,
        }),
        context.signal,
      );

      return { messageId: info.messageId };
    },
  };
}

/**
 * Race a send against the call's `AbortSignal`.
 *
 * `nodemailer`'s promise does not observe the signal itself, so without this
 * a caller that gave up waiting would still hang until the socket resolves
 * on its own — exactly the "promise tied to nothing" this project's own
 * `callWithDeadline` exists to avoid at the orchestrator layer. This does not
 * stop the underlying send (only the transport that owns the socket can do
 * that); it stops this function from making its caller wait for it.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('הבקשה בוטלה במהלך השליחה'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('הבקשה בוטלה במהלך השליחה'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
