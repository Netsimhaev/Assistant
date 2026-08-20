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
   * The account this transport instance always authenticates as.
   *
   * Required, not optional — round 1 of review found the earlier optional
   * design silently authenticating with an empty password: when `auth` was
   * omitted, `send()` fell back to `context.credential`, and the only real
   * caller (`createEmailNotifier`, `src/governance/notify.ts`) has no per-call
   * credential of its own to offer, so that fallback resolved to a
   * placeholder handle with `value: ''`. Nothing failed until an actual SMTP
   * server rejected an empty `AUTH`, at send time, deep in a call the gate was
   * already waiting on. Requiring `auth` up front, and validating it below,
   * turns that into a synchronous throw the moment a misconfigured transport
   * is built — long before anything tries to use it.
   */
  auth: { user: string; pass: string };
  /**
   * Milliseconds nodemailer waits for the TCP/TLS handshake before giving up.
   * Defaults to `DEFAULT_TIMEOUT_MS` — left unset before round 1, which meant
   * the real bound on a hung connection was whatever nodemailer's own
   * default happened to be: unconfigured, untested, and not reasoned about
   * anywhere in this file.
   */
  connectionTimeoutMs?: number;
  /** Milliseconds nodemailer waits for the far end mid-conversation (after `HELO`/`AUTH`/`DATA`) before giving up. Same default and same reasoning as `connectionTimeoutMs`. */
  socketTimeoutMs?: number;
}

/**
 * Applies to both `connectionTimeoutMs` and `socketTimeoutMs` when a config
 * omits either. This transport has exactly one caller today — the approval
 * notifier, itself bounded by `NOTIFY_TIMEOUT_MS` in `src/governance/notify.ts`
 * — so five seconds gives nodemailer room to actually attempt a handshake
 * against a healthy relay while still resolving comfortably inside that
 * caller's own deadline instead of racing against it.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

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
  // Fails synchronously, at construction — before this function ever returns
  // a usable `MailTransport` — rather than at the first `send()`, which
  // would already be inside whatever deadline a caller is racing against.
  // `SmtpConfig.auth`'s own docblock explains why this exists.
  if (config.auth.user.length === 0 || config.auth.pass.length === 0) {
    throw new Error(
      'createSmtpTransport: auth.user/auth.pass ריקים — לא ניתן להקים מתאם SMTP בלי חשבון אמיתי',
    );
  }

  const connectionTimeout = config.connectionTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socketTimeout = config.socketTimeoutMs ?? DEFAULT_TIMEOUT_MS;

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

      // `context.credential` is still required by `MailSendContext` — every
      // implementation of the interface must accept one — but this
      // implementation never reads it for authentication: `config.auth`
      // above is now unconditional, precisely so a caller with no per-call
      // credential of its own (the notifier) cannot end up authenticating
      // with one anyway.
      const transporter = nodemailer.createTransport({
        host: context.endpoint ?? config.host,
        port: config.port,
        secure: config.secure,
        auth: config.auth,
        connectionTimeout,
        socketTimeout,
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
