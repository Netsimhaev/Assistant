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

/** The minimal `{ sendMail }` shape the send path below actually uses. */
interface MinimalTransporter {
  sendMail(mailOptions: {
    from: string;
    to: string;
    subject: string;
    text: string;
    messageId: string;
  }): Promise<{ messageId: string }>;
}

/** The exact options object this module ever builds for `createTransport`. */
interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  socketTimeout: number;
}

export interface SmtpConfig {
  /** Used when a call's `context.endpoint` is `null`. */
  host: string;
  port: number;
  secure: boolean;
  /** The envelope `From:` header. */
  from: string;
  /**
   * The account this transport always authenticates as — the username only.
   *
   * There used to be an `auth: { user, pass }` pair here, required precisely
   * so a caller with no credential of its own (`createEmailNotifier`,
   * `src/governance/notify.ts`) could not build a working transport with an
   * empty password. The notifier now resolves its own credential, so that
   * protection has nothing left to guard, and keeping a password on this
   * config was the hazard: it meant a transport instance had a secret of its
   * own that every send could reach, instead of authenticating with exactly
   * the secret that send was handed. The password now comes from
   * `context.credential.value` on every `send()` call — see the check at the
   * top of `send` below. `user` stays here because it genuinely is
   * configuration: the account name does not vary per send the way the
   * secret does.
   */
  user: string;
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
  /**
   * The seam this module needs so a test can see what a send hands
   * nodemailer, without any test ever dialing a real socket.
   *
   * The same pattern as `LocalToolContext.reader` and
   * `LocalToolContext.verifier` (`src/orchestrator/local-tools.ts`) — "the one
   * step that costs money, injectable so a test can drive it without an API
   * key" — and `ReadDocumentOptions.reader` (`src/documents/read.ts`) before
   * them: an optional factory that defaults to the real thing, so production
   * never passes it and every test that needs to inspect a send can, without
   * a fake network layer underneath it.
   */
  createTransport?: (options: SmtpTransportOptions) => MinimalTransporter;
}

/**
 * `nodemailer.createTransport`'s real signature is far broader than
 * `SmtpTransportOptions` — every option is optional, several shapes are
 * unioned together — so it is cast once, here, rather than at every call
 * site. This is the only place in the module that needs to know the real
 * type does not line up exactly with the narrow one this module actually
 * uses.
 */
const DEFAULT_CREATE_TRANSPORT = nodemailer.createTransport as unknown as (
  options: SmtpTransportOptions,
) => MinimalTransporter;

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
  // Only the username is checked here now; the password no longer lives on
  // this config at all (see `SmtpConfig.user`'s own docblock), so there is
  // nothing left to validate about it until a send actually arrives.
  if (config.user.length === 0) {
    throw new Error(
      'createSmtpTransport: שם המשתמש (user) ריק — לא ניתן להקים מתאם SMTP בלי חשבון אמיתי',
    );
  }

  const connectionTimeout = config.connectionTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socketTimeout = config.socketTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const buildTransporter = config.createTransport ?? DEFAULT_CREATE_TRANSPORT;

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

      // `config.auth` is gone. The credential this send was handed is the only
      // source, which is what makes "a caller with no credential" a compile
      // error rather than a silent fallback to somebody else's account. The
      // previous shape held an unconditional `auth` precisely so the notifier
      // — which had no per-call credential — could not authenticate with one;
      // the notifier now resolves its own, so the default has nothing left to
      // protect and its existence is the hazard.
      if (context.credential.value.length === 0) {
        throw new Error(
          'createSmtpTransport: ה-credential שהועבר לשליחה ריק — לא ניתן להזדהות מול שרת הדואר',
        );
      }

      const transporter = buildTransporter({
        host: context.endpoint ?? config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: context.credential.value },
        connectionTimeout,
        socketTimeout,
      });

      // Folded into the outgoing Message-ID, per `MailSendContext.idempotencyKey`'s
      // own docblock: a retry with the same key must not read to the far end
      // as a second, distinct message.
      const domain = config.from.split('@')[1] ?? 'localhost';
      const messageId = `<${context.idempotencyKey}@${domain}>`;

      let info: { messageId: string };
      try {
        info = await raceAbort(
          transporter.sendMail({
            from: config.from,
            to: message.to.join(', '),
            subject: message.subject,
            text: message.body,
            messageId,
          }),
          context.signal,
        );
      } catch (error) {
        // Only the message crosses this boundary. Real nodemailer failures
        // carry `command`, `response`, `responseCode` and more, and an AUTH
        // failure's `command` can be the AUTH line itself — an echoed error
        // reaching `StepChannelError` and from there an audit row's `reason`
        // would cross far more than this function's own boundary. This is a
        // positive selection of the one field an operator actually needs
        // (the server's own response text), not a scrub of a list of
        // dangerous fields this file would have to keep current.
        throw new Error(error instanceof Error ? error.message : String(error));
      }

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
