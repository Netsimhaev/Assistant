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
import { AMBIGUOUS_FAILURE_COMMAND } from '../orchestrator/adapters/mail.js';
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
  /**
   * Always the negation of `secure`, unless `SmtpConfig.allowCleartext` says
   * otherwise — see `SmtpConfig.secure`'s docblock for the whole argument.
   * Not optional: an omitted `requireTLS` is nodemailer's silent
   * "upgrade if offered", which is the state this field exists to remove.
   */
  requireTLS: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  socketTimeout: number;
}

export interface SmtpConfig {
  /** Used when a call's `context.endpoint` is `null`. */
  host: string;
  port: number;
  /**
   * `true` is implicit TLS (the whole session is encrypted from the first
   * byte, port 465). `false` makes STARTTLS **mandatory** — `requireTLS` goes
   * on the options object below — and there is no third setting.
   *
   * There used to be one, by omission, and it was the default: with `secure:
   * false` and no `requireTLS`, nodemailer connects in cleartext and upgrades
   * only *if the server advertises STARTTLS in its EHLO reply*. An on-path
   * attacker who strips that one advertisement line gets the `AUTH` exchange
   * verbatim — and this transport resolves and transmits a stored secret on
   * every single send. A whole subsystem (an encrypted row, an AAD-bound
   * cipher, a mode-0600 key file, a non-enumerable handle) protecting a value
   * that then leaves the host over a downgradeable channel is decorative.
   * With `requireTLS`, a stripped advertisement is a connection failure
   * instead of a silent downgrade.
   */
  secure: boolean;
  /**
   * Opt out of the mandatory STARTTLS above. `false` unless a caller says
   * otherwise, and the only legitimate use is a local test relay that speaks
   * no TLS at all (`maildev`, `docs/live-thread-runbook.md`).
   *
   * Same shape as `assertBindableHost`'s `allowNonLoopback`
   * (`src/dashboard/server.ts`) and for the same reason: the dangerous
   * configuration stays reachable, because an operator who genuinely needs it
   * is better served by a named switch than by a workaround, but it is never
   * what happens by default and never silent — `buildRuntime`
   * (`src/orchestrator/runtime.ts`) reads `SMTP_ALLOW_CLEARTEXT=1` for this
   * and pushes a warning whenever it is on. A silent default is what this
   * field removes; a visible opt-out is not the same thing.
   */
  allowCleartext?: boolean;
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
 * omits either.
 *
 * `buildRuntime` (`src/orchestrator/runtime.ts`) builds **one** transport and
 * hands the same instance to two readers: the approval notifier
 * (`createEmailNotifier`, bounded by `NOTIFY_TIMEOUT_MS` in
 * `src/governance/notify.ts`) and the mail adapter (`createMailAdapter`, whose
 * calls `runPlan` bounds with `callWithDeadline`). Five seconds gives
 * nodemailer room to actually attempt a handshake against a healthy relay
 * while still resolving comfortably inside either caller's own deadline
 * instead of racing it — the notifier's is the tighter of the two, so it is
 * the one this value is chosen against.
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
        // Two settings, not three: implicit TLS, or cleartext-then-mandatory
        // STARTTLS. See `SmtpConfig.secure` for why the third — "upgrade if
        // the server happens to offer it" — is the one that had to go.
        requireTLS: !config.secure && config.allowCleartext !== true,
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
        throw rethrowClassifiable(error);
      }

      return { messageId: info.messageId };
    },
  };
}

/** Own properties only — see `rethrowClassifiable` below for why that matters. */
function ownField(error: unknown, field: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return Object.hasOwn(error, field) ? (error as Record<string, unknown>)[field] : undefined;
}

/**
 * A fresh error carrying the message and **exactly three** of the fields the
 * library attached — nothing else survives.
 *
 * The rethrow itself is the redaction: a real nodemailer failure carries
 * `response` (the server's own reply text, which is also already folded into
 * `message` by nodemailer's `_formatError`), and possibly more the library
 * adds later, and an echoed error object reaching `StepChannelError` and from
 * there an audit row would cross far more than this function's boundary.
 *
 * But **three of those fields are load-bearing**, and an earlier version of
 * this function dropped all three. `classifyTransportFailure`
 * (`src/orchestrator/adapters/mail.ts`) reads `responseCode`, `command` and
 * `code` — and only those — to decide `retryable` and the result code. With
 * them stripped, every real SMTP failure fell to that function's last branch:
 * `{ retryable: false, code: 'delivery_unknown' }`. Two harms, the second
 * worse: a `421 too busy`, an `ECONNREFUSED`, a DNS failure — cases where
 * nothing was ever accepted and this project deliberately made the step
 * retryable — terminally failed the job; and `delivery_unknown` is the code
 * reserved for *the message may already have left this process*, so a
 * connection that was **refused** was recorded as an outcome nobody can
 * determine. The trail asserted an ambiguity that provably did not exist, and
 * this project treats the trail's honesty as the control.
 *
 * Positive selection, not a filter: each field is named, type-checked, and
 * read as an **own** property (a `command: 'DATA'` inherited from a prototype
 * is not something the far end said). `command` is narrower still — carried
 * forward only when it equals `AMBIGUOUS_FAILURE_COMMAND`, the single value
 * the classifier compares it against, and the constant is substituted for the
 * library's own string — so a library that put a credential where the command
 * label belongs cannot get it across this boundary at all. Narrowing `code`
 * the same way (to `TRANSIENT_ERROR_CODES`) was considered and rejected: that
 * would reintroduce, for the next branch the classifier grows, exactly the bug
 * described above.
 *
 * What holds for all three regardless: **none of them reaches a human-visible
 * row.** `classifyTransportFailure` puts only `message` into
 * `AdapterResult.message`, and that is the single value `executeStep`
 * (`src/orchestrator/execute.ts`) renders into `job_steps.reason`. The three
 * carried fields are read by that classifier and by nothing else.
 */
function rethrowClassifiable(error: unknown): Error {
  const rethrown: Error & { responseCode?: number; command?: string; code?: string } = new Error(
    error instanceof Error ? error.message : String(error),
  );

  const responseCode = ownField(error, 'responseCode');
  if (typeof responseCode === 'number') rethrown.responseCode = responseCode;

  const command = ownField(error, 'command');
  if (command === AMBIGUOUS_FAILURE_COMMAND) rethrown.command = AMBIGUOUS_FAILURE_COMMAND;

  const code = ownField(error, 'code');
  if (typeof code === 'string') rethrown.code = code;

  return rethrown;
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
