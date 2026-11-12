import { createHash } from 'node:crypto';
import { loadActiveCharter } from '../charter/store.js';
import { storedCredentials } from '../governance/credential-store.js';
import { loadMasterKey, MasterKeyError, verifyKeyState } from '../governance/master-key.js';
import { createEmailNotifier } from '../governance/notify.js';
import type { ApprovalNotifier } from '../governance/notify.js';
import { createSmtpTransport } from '../mail/transport.js';
import type { SmtpConfig } from '../mail/transport.js';
import { browserAdapter } from './adapters/browser.js';
import { createGoogleCalendarAdapter } from './adapters/google-calendar.js';
import type { CalendarHttp } from './adapters/google-calendar.js';
import { googleTokenHttp } from './adapters/google-token-http.js';
import { microsoftTokenHttp } from './adapters/microsoft-token-http.js';
import { providerTokenHttp } from './adapters/provider-token-http.js';
import { createMailAdapter } from './adapters/mail.js';
import { createMailboxSendAdapter } from './adapters/mailbox-send.js';
import { MAILBOX_SYSTEM } from '../mail/mailbox.js';
import { replyTargetFor } from '../mail/inbox-store.js';
import type { MailProvider } from '../mail/mailbox.js';
import type { MailboxClient } from '../mail/providers/types.js';
import { signedCalendarProvider } from '../charter/amend-calendar.js';
import { CALENDAR_SYSTEM } from '../calendar/calendar.js';
import type { CalendarProvider } from '../calendar/calendar.js';
import type { CalendarClient } from '../calendar/types.js';
import { createCalendarAdapter } from './adapters/calendar.js';
import { AdapterRegistry } from './adapters/registry.js';
import { loadBindings } from './bindings.js';
import type { CredentialSource } from './credentials.js';
import { oauthCredentials } from './oauth-token.js';
import type { TokenHttp } from './oauth-token.js';
import type { CredentialHandle } from './adapters/types.js';
import type { WhatsAppGateway } from '../whatsapp/gateway.js';
import { canonicalHash } from '../util/canonical.js';
import { PRODUCTION_TOOLS_MISSING_REASON } from '../production/render-error.js';
import { withBusiness } from '../db/pool.js';
import type { BusinessDb } from '../db/pool.js';
import { platformSecrets } from '../tenancy/platform-credentials.js';
import { loadRuntimeSettings } from '../tenancy/runtime-settings.js';
import type { RuntimeSettings } from '../tenancy/runtime-settings.js';

/** Which vendor's code serves a binding's system. Matches `ConnectionBinding.provider`. */
const GOOGLE_PROVIDER = 'google';

/**
 * Everything a production run needs that is not per-job.
 *
 * Assembled in one place so the scheduler, the seed command and anything later
 * agree on which adapters exist and where notifications go. Two callers each
 * building their own registry is two chances to disagree about which system
 * name the charter uses.
 */
export interface Runtime {
  registry: AdapterRegistry;
  credentials: CredentialSource;
  notify?: {
    notifier: ApprovalNotifier;
    dashboardBaseUrl: string;
    /**
     * A free-standing system alert, not about any one approval — what §7.4
     * sends when the WhatsApp bridge drops. Same credential resolution and
     * the same `withDeadline` discipline `createEmailNotifier`'s own
     * `notify` uses, built right here rather than by extending
     * `ApprovalNotifier` itself: that interface's only method takes an
     * `ApprovalRequest`, and widening its signature (or adding a second
     * required method) to fit one unrelated caller would break every test
     * double that already implements it structurally
     * (`run-due.test.ts`, `policy/engine.test.ts`). This closure reuses the
     * exact `transport`/`to`/`credentials`/`notifyRef` this function already
     * resolved for `notifier` below — never a second credential source, never
     * a second SMTP configuration.
     *
     * Optional even when `notify` itself is present, so a test fixture that
     * predates this field — a literal `Runtime['notify']` built by hand, as
     * several existing scheduler tests do — keeps typechecking unchanged.
     * Every real build of `notify` below sets it.
     */
    sendAlert?(subject: string, body: string): Promise<{ ok: boolean; error?: string }>;
    /**
     * `sendAlert` with one file attached — the document card's email to the
     * owner (document production §10, D10). Same transport, credential and
     * recipient as `sendAlert`; never throws. The idempotency key hashes the
     * subject, the body and the file's sha256, so the caller puts something
     * unique in the body (the card id) — two identical cards would otherwise
     * collapse into one at the mail server while this reports `ok`.
     */
    sendAlertWithAttachment?(
      subject: string,
      body: string,
      attachment: { filename: string; mediaType: string; bytes: Buffer },
    ): Promise<{ ok: boolean; error?: string }>;
  };
  /**
   * The WhatsApp bridge, GREEN-API side only — never the messenger.
   *
   * **Deliberately just `{ gateway }`.** `createBossMessenger`'s `contactId`
   * is the principal's WhatsApp number, read off the SIGNED CHARTER
   * (`principalWhatsAppKey`) — and an owner can change that number by
   * signing an amendment. A messenger built once, here, at process start
   * would pin a recipient for the life of the process: after the owner
   * changes his number the assistant would keep messaging the OLD one,
   * which by then may belong to someone who is not the principal at all.
   * `createBossMessenger` does no I/O at construction, so building it fresh
   * every `schedulerPass`, from the charter that pass itself loads, costs
   * nothing — see `scheduler.ts`.
   *
   * **No default gateway exists yet.** There is no production
   * `createGreenApiGateway` in this codebase today (a later task supplies
   * it) — only the two test doubles in `src/whatsapp/`. Until then this
   * field is undefined in every real deployment, by construction: see
   * `overrides.whatsappGateway` below.
   */
  whatsapp?: { gateway: WhatsAppGateway };
  /**
   * The folder this business's document inbox scans, present only when the
   * business turned its inbox on (`inbox_enabled`) AND the server has an inbox
   * folder configured (`DOCUMENT_INBOX`). Absent means the scan and the
   * conductor do not run for this business this pass — the same "a missing
   * setting is a switch, not a fault" rule `DOCUMENT_INBOX` stated alone
   * before settings moved into the database (spec §5.4).
   */
  inbox?: string;
  /**
   * Whether document production can run on this server: both binaries it
   * needs (`DOCUMENT_SOFFICE_PATH` for the LibreOffice page conversion of
   * check 2, `DOCUMENT_CHROMIUM_PATH` for PDF printing and page images) are
   * configured. When `available` is false a production fails with stage
   * `failed` and `PRODUCTION_TOOLS_MISSING_REASON`
   * (`src/production/page-images.ts`), and `warnings` says which path is
   * missing. Optional so hand-built test runtimes keep typechecking; every
   * real build sets it, and a reader treats an absent field as unavailable.
   */
  production?: { available: boolean; sofficePath: string | null; chromiumPath: string | null };
  /**
   * What could not be assembled, and why.
   *
   * Returned rather than logged here, and never swallowed: a runtime missing
   * its mail adapter still starts — the scheduler must keep expiring approvals
   * — but the operator has to be told, or "no mail ever went out" looks
   * exactly like "there was nothing to send".
   */
  warnings: string[];
}

const DEFAULT_MAIL_SYSTEM = 'office-mail';
const DEFAULT_DASHBOARD_BASE_URL = 'http://127.0.0.1:8787';

/**
 * How long `sendAlert` waits for a send before giving up.
 *
 * Matches `NOTIFY_TIMEOUT_MS` in `src/governance/notify.ts` — this is a
 * courtesy notification, not the work it reports on.
 */
const ALERT_TIMEOUT_MS = 5_000;

/**
 * Bound a promise the transport might never settle.
 *
 * A fifth local copy of the same pattern `notify.ts`, `messenger.ts`,
 * `run-plan.ts` and `oauth-token.ts` each already carry their own of: an
 * `AbortSignal` is advisory only, and nothing forces a transport (or a test
 * double) to check it, so racing the call itself against an independent
 * timer is what actually binds the wait. Each site's deadline wraps a
 * different promise with a different fallback value, so — the same
 * reasoning `withOAuthDeadline`'s own docblock states — there is nothing
 * shared to factor out beyond the shape, which is a few lines.
 */
function withAlertDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`sendAlert did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * The SMTP fields a business must set before its mail adapter and approval
 * notifier exist, named by their `business_runtime_settings` columns so a
 * warning points at exactly what `npm run business:settings` writes.
 */
const SMTP_FIELDS = [
  ['notify_smtp_host', 'notifySmtpHost'],
  ['notify_smtp_port', 'notifySmtpPort'],
  ['notify_smtp_from', 'notifySmtpFrom'],
  ['notify_smtp_user', 'notifySmtpUser'],
] as const satisfies ReadonlyArray<readonly [string, keyof RuntimeSettings]>;

/**
 * The fixed secret names a business's runtime resolves, from that business's
 * own encrypted `credentials`. Fixed rather than named by an env var (the old
 * `NOTIFY_CREDENTIAL_REF` / `GREEN_API_*_REF`): with many businesses on one
 * server there is no process-wide setting to name a ref in, and a fixed name
 * per business is what 500c33b already decided for GREEN-API. Each is a legal
 * `CREDENTIAL_REF_PATTERN` ref by construction, so no startup check is needed
 * for a typo that can no longer be made.
 */
export const NOTIFY_SMTP_PASS_REF = 'NOTIFY_SMTP_PASS';
export const GREEN_API_INSTANCE_ID_REF = 'GREEN_API_INSTANCE_ID';
export const GREEN_API_TOKEN_REF = 'GREEN_API_TOKEN';

/**
 * The document card email's idempotency key — content-derived, like
 * `sendAlert`'s. Unique per notice only because every card notice carries
 * its own `מזהה הודעה` line (`NOTICE_ID_LABEL`, `production/card.ts`): two
 * notices of the same card are otherwise byte-identical, and the mail server
 * would drop the second as a duplicate while the send reports ok.
 */
export function documentCardAlertKey(subject: string, body: string, bytes: Buffer): string {
  const fileSha = createHash('sha256').update(bytes).digest('hex');
  return `document-card-alert:${canonicalHash({ subject, body, fileSha })}`;
}

/**
 * The test seams `buildServerRuntime` accepts. No production caller ever
 * passes any of them — see `buildServerRuntime`'s own docblock.
 */
export interface ServerRuntimeOverrides {
  createTransport?: SmtpConfig['createTransport'];
  tokenHttp?: TokenHttp;
  calendarHttp?: CalendarHttp;
  /** Test seam: the mailbox client a send adapter uses, per provider. */
  mailboxClient?: (provider: MailProvider) => MailboxClient;
  /** Test seam: the calendar client the calendar adapter uses, per provider. */
  calendarClient?: (provider: CalendarProvider) => CalendarClient;
  /** Test seam only — see `businessRuntime`'s docblock. No default exists yet. */
  whatsappGateway?: (creds: { instance: CredentialHandle; token: CredentialHandle }) => WhatsAppGateway;
}

/**
 * Everything one process needs once, whatever business it is serving: the
 * master key (as the credential source built from it), the tool paths, the
 * dashboard link base and the server's own warnings (spec §5.4).
 *
 * Nothing here belongs to a business — no charter, no binding, no setting.
 * Those are read per business, per pass, by `businessRuntime`.
 */
export interface ServerRuntime {
  /** The composed source: the encrypted store, with OAuth grants minted on top. */
  readonly credentials: CredentialSource;
  readonly dashboardBaseUrl: string;
  /** `DOCUMENT_INBOX`, or `null` when the server has no inbox folder at all. */
  readonly documentInbox: string | null;
  readonly production: { available: boolean; sofficePath: string | null; chromiumPath: string | null };
  /** What the SERVER could not assemble. A business's own warnings are on its `Runtime`. */
  readonly warnings: readonly string[];
  readonly overrides: Readonly<ServerRuntimeOverrides>;
}

/**
 * Assemble the server half of a production runtime, once per process.
 *
 * **Async because the master key is a file, and it is read here** — once, at
 * startup, into process memory. Missing settings are a warning and the
 * scheduler carries on, but a key that will not load is a REFUSAL: an
 * installation running with no secrets produces failures that look like
 * network trouble, one customer at a time, instead of one refusal an operator
 * sees immediately (spec §4.2).
 *
 * `verifyKeyState` runs here for the same reason (spec §5.1). Without it, a
 * replaced or damaged key file is discovered when a customer's mail fails at
 * three in the morning, not when the process starts.
 *
 * `overrides.createTransport` exists for exactly one caller: a test that
 * needs to see what `SmtpConfig` and per-send credential actually reached
 * nodemailer, the same seam `SmtpConfig.createTransport` documents for
 * `createSmtpTransport` itself. `overrides.tokenHttp` and
 * `overrides.calendarHttp` are the same seam one layer over — a test that
 * needs to see what reached the OAuth token exchange or the calendar API
 * without a real Google account behind it — and **no test in this
 * sub-project uses either one yet**. They exist for two NAMED future
 * consumers: Task 5's consent-flow tests (which need to drive a fake token
 * exchange through a runtime assembled here end to end, the way this
 * sub-project's own tests drive `createTransport`) and a future live-run
 * script test for the calendar chain, the sibling of `probe-smtp.ts`. Naming
 * the expected consumer here is deliberate: a seam with no reader and no
 * stated owner is exactly the "field nobody reads" class this project has
 * paid for more than once (fix round 2, minor 7) — until one of those two
 * lands, this stays a documented gap, not a claim that something already
 * exercises it. No production caller ever passes any of the overrides —
 * every real call site calls `buildServerRuntime()` with zero arguments.
 *
 * **The credential source is a composition, not a single store.**
 * `oauthCredentials` wraps `storedCredentials(key)` rather than replacing
 * it: a ref that is not a stored OAuth grant — every ref the mail adapter
 * has ever resolved — falls straight through to the same encrypted store as
 * before, unchanged in behaviour. What is added is a ref that names a
 * Google or Microsoft grant: the composed source mints a live access token
 * for it, refreshing through `googleTokenHttp` / `microsoftTokenHttp`, which
 * resolve the app's OWN OAuth client id/secret through the encrypted
 * PLATFORM store (`platform-credentials.ts`) — the client belongs to the
 * application, not to any business — never through `process.env` (see
 * `google-token-http.ts`'s own docblock — this is the piece Task 3
 * originally sketched as reading `process.env` and was reverted for that
 * exact reason).
 */
export async function buildServerRuntime(
  env: Record<string, string | undefined> = process.env,
  overrides: ServerRuntimeOverrides = {},
): Promise<ServerRuntime> {
  const warnings: string[] = [];

  const keyPath = env['CREDENTIAL_KEY_PATH'];
  if (keyPath === undefined || keyPath.length === 0) {
    // A positive requirement, not a fallback. There is deliberately no
    // default path and no "carry on without secrets" branch: either this
    // installation has a key or it does not start.
    throw new MasterKeyError(
      'CREDENTIAL_KEY_PATH אינו מוגדר — אין מפתח לפתוח בו את הסודות, וההתקנה מסרבת לעלות',
    );
  }
  const key = await loadMasterKey(keyPath);
  await verifyKeyState(key);
  // COMPOSED, not the bare store: a ref that resolves through
  // `storedCredentials` still resolves the same way (the mail adapter is
  // untouched); a ref that names a stored OAuth grant instead mints a live
  // access token. See the docblock above.
  const credentials = oauthCredentials({
    key,
    fallback: storedCredentials(key),
    http:
      overrides.tokenHttp ??
      providerTokenHttp({
        google: googleTokenHttp({ clients: platformSecrets(key) }),
        microsoft: microsoftTokenHttp({ clients: platformSecrets(key) }),
      }),
  });

  // Same switch discipline as the SMTP settings, for the same reason
  // (spec §4.2): a missing key turns curation off entirely, and a job that
  // closes without learning anything from it must not look identical to a
  // job that simply had nothing worth remembering. `curateJob` itself
  // reports this per-job as `skipped: 'no_key'`; this is the one place that
  // reports it for the installation as a whole, before any job has run.
  if ((env['ANTHROPIC_API_KEY'] ?? '').length === 0) {
    warnings.push(
      `no curation: ANTHROPIC_API_KEY not set — jobs will close normally, ` +
        `but the assistant will not learn anything from them`,
    );
  }

  // Same switch discipline as the SMTP settings: a server without LibreOffice
  // or Chromium still starts (the scheduler has other work), but the operator
  // is told, so "no document was produced" does not look like "none was
  // asked". Presence only; whether the binary actually runs is what
  // `npm run doc:render-check` checks (docs/11-pre-launch-checks.md).
  const envValue = (name: string): string | null => {
    const value = env[name];
    return value === undefined || value.length === 0 ? null : value;
  };
  const production = {
    sofficePath: envValue('DOCUMENT_SOFFICE_PATH'),
    chromiumPath: envValue('DOCUMENT_CHROMIUM_PATH'),
  };
  const missingProduction = [
    ...(production.sofficePath === null ? ['DOCUMENT_SOFFICE_PATH'] : []),
    ...(production.chromiumPath === null ? ['DOCUMENT_CHROMIUM_PATH'] : []),
  ];
  if (missingProduction.length > 0) {
    warnings.push(
      `no document production: ${missingProduction.join(', ')} not set — every document ` +
        `production will fail ("${PRODUCTION_TOOLS_MISSING_REASON}")`,
    );
  }

  return {
    credentials,
    // Empty is treated as unset, the same as every other env value read here.
    dashboardBaseUrl: envValue('DASHBOARD_BASE_URL') ?? DEFAULT_DASHBOARD_BASE_URL,
    documentInbox: envValue('DOCUMENT_INBOX'),
    production: { available: missingProduction.length === 0, ...production },
    warnings,
    overrides,
  };
}

/**
 * Assemble one business's runtime from its settings row, its charter, its
 * bindings and its own credentials (spec §5.4).
 *
 * **Rebuilt on every pass, never cached.** A setting the owner changes, a
 * secret he stores, a `provider` column the dashboard writes — each takes
 * effect on that business's next pass, with no restart. Before settings
 * moved into the database the runtime was built once at process start, and
 * a binding written after it simply had no effect until the scheduler was
 * restarted; re-reading per pass is what removes that, at the cost of a few
 * queries per business per pass.
 *
 * **No settings row means everything off,** each one reported in `warnings`
 * rather than looking like "there was nothing to send": no mail adapter and
 * no notifier (no SMTP), no WhatsApp, no inbox.
 *
 * **A credential that THROWS is not "not configured".** `resolve` throws on
 * a store failure or a malformed business id; that propagates out of here as
 * a failed build for this business, which the caller reports as such. Only a
 * clean `null` — nothing stored under that ref — becomes a warning.
 *
 * **WhatsApp resolves credentials only, never the charter — that is this
 * function's whole business with it.** The two GREEN-API secrets
 * (`GREEN_API_INSTANCE_ID`, `GREEN_API_TOKEN`) are resolved through the
 * server's credential source, for this business; a missing one is a warning
 * naming which, never a throw — the scheduler still has approvals to expire.
 * The principal's WhatsApp number lives in the signed CHARTER
 * (`principalWhatsAppKey`), and deliberately plays no part here:
 * `probeActiveCharter` is reserved for exactly two callers (the install path
 * and the readiness report — CLAUDE.md), and a third reader here would void
 * the control beside it. Per-pass charter loading, and the messenger that
 * number builds, is `scheduler.ts`'s job — see `Runtime.whatsapp`'s own
 * docblock for why the messenger is never built here. `overrides.whatsappGateway`
 * is the seam a later task's `createGreenApiGateway` replaces the default
 * (today: none) with; no production caller passes it, same as the other
 * overrides.
 *
 * **Provider adapters register from the charter and the bindings, not from
 * a grant.** A system whose binding names `provider: 'google'`, and whose
 * charter-declared connection for that same system BOTH uses the `api`
 * channel AND serves `calendar.read`, gets `createGoogleCalendarAdapter`
 * registered under its system name — even when no grant has been stored for
 * it yet. A missing authorisation is a RUNTIME failure the adapter itself
 * reports (`credential_unavailable`, from `oauthCredentials` resolving to
 * `null`), not a missing adapter — the same distinction §6.2 of the design
 * spec draws between a connectivity failure and a policy decision. The
 * `serves` half of that check is load-bearing: see the registration loop's
 * own comment (fix-round 1, finding I1) for the collision it prevents.
 */
export async function businessRuntime(server: ServerRuntime, db: BusinessDb): Promise<Runtime> {
  const warnings: string[] = [];
  const businessId = db.businessId;
  const { credentials, overrides } = server;
  const settings = await loadRuntimeSettings(db);

  const missing = SMTP_FIELDS.filter(([, field]) => settings[field] === null).map(([column]) => column);

  const systemAdapters = [];
  let notify: Runtime['notify'];

  if (missing.length > 0) {
    warnings.push(
      `no mail adapter: ${missing.join(', ')} not set — every mail.send step ` +
        `will be refused, and no approval notification can be sent`,
    );
  } else {
    // Positive check, the same shape as `notify_smtp_secure` below: anything
    // but an explicit `true` reads as "not set", never as "cleartext is
    // fine". Warned about rather than merely honoured — an installation
    // sending a stored secret over a downgradeable channel must say so on
    // every pass, because the symptom of getting this wrong is silence (see
    // `SmtpConfig.secure`).
    const allowCleartext = settings.notifySmtpAllowCleartext === true;
    if (allowCleartext) {
      warnings.push(
        `notify_smtp_allow_cleartext: STARTTLS is not required — the mail password ` +
          `may travel in the clear. Intended for a local test relay only.`,
      );
    }

    const transport = createSmtpTransport({
      host: settings.notifySmtpHost as string,
      port: settings.notifySmtpPort as number,
      // Positive check. `!== false` would make an unset value mean TLS.
      secure: settings.notifySmtpSecure === true,
      allowCleartext,
      from: settings.notifySmtpFrom as string,
      // No `auth` here any more — see `SmtpConfig.user`'s own docblock.
      // The password comes from a resolved credential per send, never from
      // a value this function reads out of a setting.
      user: settings.notifySmtpUser as string,
      ...(overrides.createTransport !== undefined
        ? { createTransport: overrides.createTransport }
        : {}),
    });

    systemAdapters.push(
      createMailAdapter({
        // `saveRuntimeSettings` stores an empty value as NULL, so an empty
        // system id — one `resolveChannel` can never match, failing every
        // `mail.send` step silently — cannot reach here.
        system: settings.mailSystem ?? DEFAULT_MAIL_SYSTEM,
        transport,
      }),
    );

    const to = settings.notifyTo;
    const notifyRef = NOTIFY_SMTP_PASS_REF;
    // Resolved here once only to know whether to build the notifier at all —
    // the closures below resolve it again on every send, so a rotated
    // password takes effect on the next notification. A throw propagates
    // (see this function's docblock). On the `db` this runtime is being built
    // on: its caller holds that connection, and a second acquire here is
    // hold-and-wait. The send-time closures below run after `db` is released,
    // so they resolve on their own connection, as before.
    const stored = to === null ? null : await credentials.resolve(notifyRef, businessId, db);
    if (to === null) {
      warnings.push(
        `no approval notifier: notify_to not set — approvals will ` +
          `queue and appear on the dashboard, and nobody will be emailed`,
      );
    } else if (stored === null) {
      warnings.push(
        `no approval notifier: ${notifyRef} is not stored for this business — approvals will ` +
          `queue and appear on the dashboard, and nobody will be emailed`,
      );
    } else {
      notify = {
        notifier: createEmailNotifier({
          transport,
          to,
          credentials,
          ref: notifyRef,
          businessId,
        }),
        dashboardBaseUrl: server.dashboardBaseUrl,
        // §7.4's health email, through the SAME transport/credentials/to
        // this block just resolved — see `Runtime.notify`'s own docblock
        // for why this is not a second method on `ApprovalNotifier`.
        async sendAlert(subject, body) {
          try {
            const credential = await withAlertDeadline(
              credentials.resolve(notifyRef, businessId),
              ALERT_TIMEOUT_MS,
            );
            if (credential === null) {
              return { ok: false, error: `לא נמצא credential עבור ${notifyRef}` };
            }
            await withAlertDeadline(
              transport.send(
                { to: [to], subject, body },
                {
                  endpoint: null,
                  credential,
                  // Content-derived, not clock-derived (review F3 note):
                  // `Date.now()` here gave every call its own key, which
                  // dedupes nothing. The same subject+body hashes the same
                  // way whether this is a fresh alert or a retry of one
                  // that failed to send a pass ago — exactly the case
                  // `checkWhatsAppHealth` produces when it leaves the
                  // transition unrecorded and tries again next pass.
                  //
                  // This function never reads `current.since` itself — it
                  // only hashes whatever `body` the caller built. The
                  // caller (`checkWhatsAppHealth`, `scheduler.ts`) is
                  // therefore the one load-bearing fact for this key: fix
                  // round A found that its `body` carried `current.state`
                  // but not `current.since`, so two genuinely distinct
                  // outages reporting the SAME state word hashed to the
                  // SAME key, and the mail server dropped the second as a
                  // duplicate of the first — silence, one layer past every
                  // test, because a test counting `sendAlert` calls cannot
                  // see a Message-ID collision. `checkWhatsAppHealth` now
                  // embeds `since` in `body` for exactly this reason: a
                  // retry of the SAME outage must still hash identically
                  // (same `since`, same `state`), while two different
                  // outages — even under the same state word — must not.
                  idempotencyKey: `whatsapp-health-alert:${canonicalHash({ subject, body })}`,
                  signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
                },
              ),
              ALERT_TIMEOUT_MS,
            );
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
        // The document card's email (document production §10): the same
        // seam as `sendAlert` above, with the file attached.
        async sendAlertWithAttachment(subject, body, attachment) {
          try {
            const credential = await withAlertDeadline(
              credentials.resolve(notifyRef, businessId),
              ALERT_TIMEOUT_MS,
            );
            if (credential === null) {
              return { ok: false, error: `לא נמצא credential עבור ${notifyRef}` };
            }
            await withAlertDeadline(
              transport.send(
                { to: [to], subject, body, attachments: [attachment] },
                {
                  endpoint: null,
                  credential,
                  idempotencyKey: documentCardAlertKey(subject, body, attachment.bytes),
                  signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
                },
              ),
              ALERT_TIMEOUT_MS,
            );
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      };
    }
  }

  // WhatsApp (GREEN-API) — resolves credentials only. See this function's own
  // docblock for why the charter, and the messenger built from it, have no
  // part here.
  let whatsapp: Runtime['whatsapp'];
  if (!settings.whatsappEnabled) {
    warnings.push(
      `no WhatsApp gateway: whatsapp_enabled is off for this business — the owner's ` +
        `WhatsApp channel will not run; messages will neither be received nor sent`,
    );
  } else {
    // On the caller's `db`, one after the other: two queries in flight on one
    // connection interleave, and a fresh connection each would be the nested
    // acquire the caller's held connection must not wait behind.
    const instanceCredential = await credentials.resolve(GREEN_API_INSTANCE_ID_REF, businessId, db);
    const tokenCredential = await credentials.resolve(GREEN_API_TOKEN_REF, businessId, db);
    if (instanceCredential === null || tokenCredential === null) {
      const unresolvedGreenApiRefs: string[] = [];
      if (instanceCredential === null) unresolvedGreenApiRefs.push(GREEN_API_INSTANCE_ID_REF);
      if (tokenCredential === null) unresolvedGreenApiRefs.push(GREEN_API_TOKEN_REF);
      warnings.push(
        `no WhatsApp gateway: ${unresolvedGreenApiRefs.join(', ')} did not resolve to a ` +
          `stored credential`,
      );
    } else if (overrides.whatsappGateway === undefined) {
      // No real implementation exists yet — see `Runtime.whatsapp`'s own
      // docblock. Resolving this far and stopping here, rather than skipping
      // straight to this branch, is what makes a genuinely misconfigured
      // business (a secret never stored) distinguishable from one that is
      // simply waiting on a later task.
      warnings.push(
        `no WhatsApp gateway: GREEN-API credentials resolved, but no gateway ` +
          `implementation is wired in yet`,
      );
    } else {
      whatsapp = {
        gateway: overrides.whatsappGateway({
          instance: instanceCredential,
          token: tokenCredential,
        }),
      };
    }
  }

  // The inbox: on only when this business turned it on AND the server has a
  // folder. Both halves are reported, since "the owner never turned it on"
  // and "the server has nowhere to watch" are different fixes.
  let inbox: string | undefined;
  if (!settings.inboxEnabled) {
    warnings.push(`no document inbox: inbox_enabled is off for this business`);
  } else if (server.documentInbox === null) {
    warnings.push(`no document inbox: inbox_enabled is on, but DOCUMENT_INBOX is not set on this server`);
  } else {
    inbox = server.documentInbox;
  }

  // Additive, on top of the mail adapter above: every system whose binding
  // carries `provider: 'google'`, and whose charter-declared connection for
  // that same system BOTH uses the `api` channel AND serves `calendar.read`,
  // gets a Google Calendar adapter registered under its system name.
  //
  // The `serves` check is load-bearing, not decorative (fix-round 1, finding
  // I1). The charter decides WHICH TOOLS a connection serves; the binding's
  // `provider` column decides WHOSE CODE runs a system that already has one.
  // Checking only `provider` and `channel` -- without `serves` -- let a
  // binding whose SYSTEM NAME already has an adapter (`office-mail`, whose
  // charter connection is also `channel: 'api'`) collide with it: an owner
  // setting `provider: 'google'` on the `office-mail` row -- the natural
  // thing to do when authorising Gmail through Task 5's consent screen --
  // made `AdapterRegistry`'s constructor throw `adapter for system
  // "office-mail" is already registered`, which is not a failed step but
  // the runtime build itself throwing: the scheduler, `run-due`,
  // `live-thread-status` and `probe-smtp` all refuse to start, and nothing
  // recovers until someone edits the row by hand. A row a dashboard writes
  // must never be able to stop the process from booting. Requiring BOTH the
  // binding's `provider` and the charter's `serves` is the column's own
  // division of labour, not a redundant belt-and-braces check.
  //
  // The `serves` check closes THAT case, but not the general one -- see the
  // `systemAdapters.some(...)` check inside the loop below for the charter
  // shape it still misses and how that is closed.
  //
  // Registered even with no grant stored, and even when the binding's own
  // `status` is not `live` — that status is what `resolveChannel` later
  // reports as `unavailable`, at plan-execution time; it is not a reason for
  // the adapter itself not to exist, the same way the mail adapter above is
  // registered from SMTP settings alone with no binding-status check at
  // all. A missing authorisation is likewise the adapter's own runtime
  // failure, not a missing adapter — see this function's own docblock. No
  // charter installed, or no matching binding, is simply zero adapters
  // registered here; neither is an error.
  //
  // The charter and the bindings are read on every pass (this function is
  // rebuilt per pass — see its docblock), so a `provider` column written by
  // the dashboard takes effect on that business's next pass, with no restart.
  const charter = await loadActiveCharter(db);
  const bindings = await loadBindings(db);
  const connectionBySystem = new Map(
    (charter?.charter.connections ?? []).map((connection) => [connection.system, connection] as const),
  );
  for (const binding of bindings) {
    if (binding.provider !== GOOGLE_PROVIDER) continue;
    // The business calendar has its own read-write adapter (loop below); the
    // legacy read-only adapter must never be registered under that name.
    if (binding.system === CALENDAR_SYSTEM) continue;
    const connection = connectionBySystem.get(binding.system);
    // `connectionAcceptsOAuthCeremony` (`oauth-eligibility.ts`) is this same
    // channel-and-serves check, extracted (final fix wave, item 1) so the
    // OAuth ceremony (`oauth-routes.ts`'s `handleOAuthStart`) and the
    // connections screen (`views.ts`) answer this exact question with the
    // same function, not a second copy that can drift.
    // Explicit, NOT `connectionAcceptsOAuthCeremony`: that predicate now also
    // accepts the `mailbox` connection (it has an OAuth profile), and a
    // mailbox binding must never receive a calendar adapter.
    if (connection === undefined || connection.channel !== 'api') continue;
    if (!connection.serves.includes('calendar.read')) continue;
    // The `serves` check above closes the SEEDED case (a charter that
    // declares `office-mail` for `mail.send` only, so it never reaches
    // here at all) but not the general one (fix-round 2, finding I3): a
    // signed charter is free to declare ONE system that serves BOTH
    // `mail.send` and `calendar.read` -- the natural single-connection
    // modelling of Google Workspace -- with `MAIL_SYSTEM` pointing at it
    // and `provider: 'google'` on its binding. The mail adapter above is
    // already registered under that system name by the time this loop
    // runs, so pushing a second adapter under the identical name would
    // still hit `AdapterRegistry`'s constructor throwing on the
    // duplicate -- the exact "a row a dashboard writes must never be able
    // to stop the process from booting" failure the `serves` check was
    // ruled on to prevent, just reached through a charter shape the
    // seeded case does not cover. Skip and warn instead of registering,
    // the same shape every other assembly failure in this function takes.
    if (systemAdapters.some((a) => a.system === binding.system)) {
      warnings.push(
        `no calendar adapter for "${binding.system}": an adapter is already ` +
          `registered under this system name (most likely the mail adapter) ` +
          `— one system cannot serve both mail and calendar today`,
      );
      continue;
    }
    systemAdapters.push(
      createGoogleCalendarAdapter({
        system: binding.system,
        ...(overrides.calendarHttp !== undefined ? { http: overrides.calendarHttp } : {}),
      }),
    );
  }

  // The mailbox (Gmail / Microsoft 365) reply adapter. Same discipline as the
  // calendar loop: the binding names the vendor, the charter's connection
  // decides the tool (`mail.send` over `api`). The OAuth credential is
  // resolved per call by `oauthCredentials`, so no grant is needed here.
  for (const binding of bindings) {
    if (binding.system !== MAILBOX_SYSTEM) continue;
    if (binding.provider !== 'google' && binding.provider !== 'microsoft') continue;
    const connection = connectionBySystem.get(binding.system);
    if (connection === undefined || connection.channel !== 'api') continue;
    if (!connection.serves.includes('mail.send')) continue;
    if (systemAdapters.some((a) => a.system === binding.system)) {
      warnings.push(`no mailbox adapter for "${binding.system}": an adapter is already registered under this system name`);
      continue;
    }
    const provider: MailProvider = binding.provider;
    systemAdapters.push(
      createMailboxSendAdapter({
        system: binding.system,
        provider,
        // Opens its own connection: the adapter runs during a later step,
        // long after the `db` this runtime was built on may have been released.
        replyTargets: (callBusinessId, internetMessageId, providerMessageId) =>
          withBusiness(callBusinessId, (replyDb) => replyTargetFor(replyDb, internetMessageId, providerMessageId)),
        ...(overrides.mailboxClient !== undefined ? { client: overrides.mailboxClient(provider) } : {}),
      }),
    );
  }

  // The business calendar (read + write). Same discipline as the mailbox loop:
  // the binding names the vendor, the charter's connection decides the tools.
  // The time zone is ALWAYS the charter's, read fresh per call (never the
  // process zone); a failed read makes the adapter answer `timezone_unavailable`
  // (retryable) instead of guessing.
  for (const binding of bindings) {
    if (binding.system !== CALENDAR_SYSTEM) continue;
    if (binding.provider !== 'google' && binding.provider !== 'microsoft') continue;
    const connection = connectionBySystem.get(binding.system);
    if (connection === undefined || connection.channel !== 'api') continue;
    if (!connection.serves.includes('calendar.read') || !connection.serves.includes('calendar.write')) continue;
    // The binding's provider must be the one the owner SIGNED for: a binding
    // pointing at another vendor would send calendar data through a
    // subprocessor the signed charter does not name.
    if (signedCalendarProvider(connection) !== binding.provider) {
      warnings.push(
        `no calendar adapter for "${binding.system}": the binding's provider is not the one the signed charter names`,
      );
      continue;
    }
    if (systemAdapters.some((a) => a.system === binding.system)) {
      warnings.push(`no calendar adapter for "${binding.system}": an adapter is already registered under this system name`);
      continue;
    }
    const provider: CalendarProvider = binding.provider;
    systemAdapters.push(
      createCalendarAdapter({
        system: binding.system,
        provider,
        timeZone: async () => {
          // Its own connection, for this business: the adapter is called long
          // after the `db` this runtime was built on may have been released.
          const active = await withBusiness(businessId, (bdb) => loadActiveCharter(bdb));
          if (active === null) throw new Error('no active charter: the business time zone is unknown');
          return active.charter.identity.timezone;
        },
        ...(overrides.calendarClient !== undefined ? { client: overrides.calendarClient(provider) } : {}),
      }),
    );
  }

  return {
    registry: new AdapterRegistry(systemAdapters, [browserAdapter]),
    // The encrypted store, never `envCredentials` — that one exists for tests
    // and reads a single shared process environment with no per-business
    // partition at all. `runtime.test.ts` locks this as a positive control
    // rather than as a claim, because a component nobody uses is exactly the
    // component someone wires by mistake (spec §3.4). The same instance the
    // notifier above resolves against — the server's, not a second one built
    // from the same key.
    credentials,
    ...(notify !== undefined ? { notify } : {}),
    ...(whatsapp !== undefined ? { whatsapp } : {}),
    ...(inbox !== undefined ? { inbox } : {}),
    production: server.production,
    warnings,
  };
}
