import { loadActiveCharter } from '../charter/store.js';
import { config } from '../config.js';
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
import { createMailAdapter } from './adapters/mail.js';
import { AdapterRegistry } from './adapters/registry.js';
import { loadBindings } from './bindings.js';
import { CREDENTIAL_REF_PATTERN } from './credentials.js';
import type { CredentialSource } from './credentials.js';
import { connectionAcceptsOAuthCeremony } from './oauth-eligibility.js';
import { oauthCredentials } from './oauth-token.js';
import type { TokenHttp } from './oauth-token.js';
import type { CredentialHandle } from './adapters/types.js';
import type { WhatsAppGateway } from '../whatsapp/gateway.js';
import { canonicalHash } from '../util/canonical.js';

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

const SMTP_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_FROM',
  'SMTP_USER',
] as const;

/**
 * The two GREEN-API credential refs — same pattern as `NOTIFY_CREDENTIAL_REF`:
 * the env var names a ref, never a secret itself, and the secret is resolved
 * through `credentials` below. Both must name a ref that actually resolves,
 * or the switch stays off — see `buildRuntime`'s own docblock on why this
 * function resolves credentials only, never the charter.
 */
const GREEN_API_INSTANCE_REF_KEY = 'GREEN_API_INSTANCE_REF';
const GREEN_API_TOKEN_REF_KEY = 'GREEN_API_TOKEN_REF';

/**
 * Assemble a production runtime.
 *
 * **Async because the master key is a file, and it is read here** — once, at
 * startup, into process memory. Missing SMTP settings are a warning and the
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
 * exchange through a `buildRuntime`-assembled runtime end to end, the way
 * this sub-project's own tests drive `createTransport`) and a future
 * live-run script test for the calendar chain, the sibling of
 * `probe-smtp.ts`. Naming the expected consumer here is deliberate: a seam
 * with no reader and no stated owner is exactly the "field nobody reads"
 * class this project has paid for more than once (fix round 2, minor 7) —
 * until one of those two lands, this stays a documented gap, not a claim
 * that something already exercises it. No production caller ever passes
 * any of the three overrides — every real call site calls `buildRuntime()`
 * with zero arguments: `run-scheduler.ts`, `run-due.ts` and `scheduler.ts`
 * in the product, plus the two operator scripts
 * `scripts/live-thread-status.ts` and `scripts/probe-smtp.ts`.
 *
 * **The credential source is a composition, not a single store.**
 * `oauthCredentials` wraps `storedCredentials(key)` rather than replacing
 * it: a ref that is not a stored OAuth grant — every ref the mail adapter
 * has ever resolved — falls straight through to the same encrypted store as
 * before, unchanged in behaviour. What is added is a ref that names a
 * Google grant: the composed source mints a live access token for it,
 * refreshing through `googleTokenHttp`, which resolves the app's OWN OAuth
 * client id/secret through that identical encrypted store, never through
 * `process.env` (see `google-token-http.ts`'s own docblock — this is the
 * piece Task 3 originally sketched as reading `process.env` and was
 * reverted for that exact reason).
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
 *
 * **This reads the charter and the bindings exactly ONCE, at the moment
 * `buildRuntime` is called — not continuously.** Every real caller
 * (`run-scheduler.ts` chief among them) builds one `Runtime` at process
 * start and reuses it for every scheduler pass thereafter. A `provider`
 * column an owner sets through Task 5's dashboard AFTER the scheduler is
 * already running therefore has NO EFFECT until the process is restarted —
 * this is a known limitation, not an oversight: re-deriving the adapter
 * registry on every pass would mean re-reading the charter and the master
 * key every 30 seconds, and that trade-off belongs to a later task, not this
 * fix round. `docs/live-thread-runbook.md` states the restart requirement
 * for an operator to actually find.
 *
 * **WhatsApp resolves credentials only, never the charter — that is this
 * function's whole business with it.** The two GREEN-API refs
 * (`GREEN_API_INSTANCE_REF`, `GREEN_API_TOKEN_REF`) are resolved through the
 * same `credentials` this function already built; a missing or unresolved
 * ref is a warning naming which one, following the SMTP block's own shape
 * above, never a throw — the scheduler still has approvals to expire. The
 * principal's WhatsApp number lives in the signed CHARTER
 * (`principalWhatsAppKey`), and deliberately plays no part here:
 * `probeActiveCharter` is reserved for exactly two callers (the install path
 * and the readiness report — CLAUDE.md), and a third reader here would void
 * the control beside it. Per-pass charter loading, and the messenger that
 * number builds, is `scheduler.ts`'s job — see `Runtime.whatsapp`'s own
 * docblock for why the messenger is never built here. `overrides.whatsappGateway`
 * is the seam a later task's `createGreenApiGateway` replaces the default
 * (today: none) with; no production caller passes it, same as the other three
 * overrides below.
 */
export async function buildRuntime(
  env: Record<string, string | undefined> = process.env,
  overrides: {
    createTransport?: SmtpConfig['createTransport'];
    tokenHttp?: TokenHttp;
    calendarHttp?: CalendarHttp;
    /** Test seam only — see this function's docblock. No default exists yet. */
    whatsappGateway?: (creds: { instance: CredentialHandle; token: CredentialHandle }) => WhatsAppGateway;
  } = {},
): Promise<Runtime> {
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
      googleTokenHttp({ credentials: storedCredentials(key) }),
  });

  // A missing ref is a warning below, in the same place APPROVAL_NOTIFY_TO's
  // absence already is — the notifier simply does not get built. A *present*
  // ref that cannot be legal is different in kind: it is a typo an operator
  // made, not a switch they left off, and finding out about it at the first
  // approval hours later is strictly worse than refusing to start now.
  const notifyRef = env['NOTIFY_CREDENTIAL_REF'];
  if (notifyRef !== undefined && notifyRef.length > 0 && !CREDENTIAL_REF_PATTERN.test(notifyRef)) {
    throw new Error(
      `NOTIFY_CREDENTIAL_REF אינו ref חוקי (אותיות גדולות, ספרות וקו תחתון בלבד): ${notifyRef}`,
    );
  }

  const missing = SMTP_KEYS.filter((key) => {
    const value = env[key];
    return value === undefined || value.length === 0;
  });

  const systemAdapters = [];
  let notify: Runtime['notify'];

  if (missing.length > 0) {
    warnings.push(
      `no mail adapter: ${missing.join(', ')} not set — every mail.send step ` +
        `will be refused, and no approval notification can be sent`,
    );
  } else {
    const port = Number(env['SMTP_PORT']);
    if (!Number.isInteger(port) || port <= 0) {
      warnings.push(`no mail adapter: SMTP_PORT is not a positive integer`);
    } else {
      // Positive check, the same shape as `SMTP_SECURE` below: a typo must
      // read as "not set", never as "cleartext is fine". Warned about rather
      // than merely honoured — an installation sending a stored secret over a
      // downgradeable channel must say so on every startup, because the
      // symptom of getting this wrong is silence (see `SmtpConfig.secure`).
      const allowCleartext = env['SMTP_ALLOW_CLEARTEXT'] === '1';
      if (allowCleartext) {
        warnings.push(
          `SMTP_ALLOW_CLEARTEXT=1: STARTTLS is not required — the mail password ` +
            `may travel in the clear. Intended for a local test relay only.`,
        );
      }

      const transport = createSmtpTransport({
        host: env['SMTP_HOST'] as string,
        port,
        // Positive check. `!== 'false'` would make a typo mean TLS.
        secure: env['SMTP_SECURE'] === 'true',
        allowCleartext,
        from: env['SMTP_FROM'] as string,
        // No `auth` here any more — see `SmtpConfig.user`'s own docblock.
        // The password comes from a resolved credential per send, never from
        // a value this function reads out of `process.env`.
        user: env['SMTP_USER'] as string,
        ...(overrides.createTransport !== undefined
          ? { createTransport: overrides.createTransport }
          : {}),
      });

      const mailSystem = env['MAIL_SYSTEM'];
      systemAdapters.push(
        createMailAdapter({
          // `??` alone would accept `MAIL_SYSTEM=''` and register the mail
          // adapter under an empty system id — one `resolveChannel` can never
          // match, so every `mail.send` step would fail as if no adapter
          // existed at all, silently. Empty is treated as unset here, the
          // same as every other env value this function reads.
          system: mailSystem === undefined || mailSystem.length === 0 ? DEFAULT_MAIL_SYSTEM : mailSystem,
          transport,
        }),
      );

      const to = env['APPROVAL_NOTIFY_TO'];
      if (to === undefined || to.length === 0) {
        warnings.push(
          `no approval notifier: APPROVAL_NOTIFY_TO not set — approvals will ` +
            `queue and appear on the dashboard, and nobody will be emailed`,
        );
      } else if (notifyRef === undefined || notifyRef.length === 0) {
        warnings.push(
          `no approval notifier: NOTIFY_CREDENTIAL_REF not set — approvals will ` +
            `queue and appear on the dashboard, and nobody will be emailed`,
        );
      } else {
        const dashboardBaseUrl = env['DASHBOARD_BASE_URL'];
        notify = {
          notifier: createEmailNotifier({
            transport,
            to,
            credentials,
            ref: notifyRef,
            businessId: config.businessId,
          }),
          dashboardBaseUrl:
            dashboardBaseUrl === undefined || dashboardBaseUrl.length === 0
              ? DEFAULT_DASHBOARD_BASE_URL
              : dashboardBaseUrl,
          // §7.4's health email, through the SAME transport/credentials/to
          // this block just resolved — see `Runtime.notify`'s own docblock
          // for why this is not a second method on `ApprovalNotifier`.
          async sendAlert(subject, body) {
            try {
              const credential = await withAlertDeadline(
                credentials.resolve(notifyRef, config.businessId),
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
        };
      }
    }
  }

  // WhatsApp (GREEN-API) — resolves credentials only. See this function's own
  // docblock for why the charter, and the messenger built from it, have no
  // part here.
  let whatsapp: Runtime['whatsapp'];
  const greenApiInstanceRef = env[GREEN_API_INSTANCE_REF_KEY];
  const greenApiTokenRef = env[GREEN_API_TOKEN_REF_KEY];
  const missingGreenApiRefs: string[] = [];
  if (greenApiInstanceRef === undefined || greenApiInstanceRef.length === 0) {
    missingGreenApiRefs.push(GREEN_API_INSTANCE_REF_KEY);
  }
  if (greenApiTokenRef === undefined || greenApiTokenRef.length === 0) {
    missingGreenApiRefs.push(GREEN_API_TOKEN_REF_KEY);
  }

  if (missingGreenApiRefs.length > 0) {
    warnings.push(
      `no WhatsApp gateway: ${missingGreenApiRefs.join(', ')} not set — the owner's ` +
        `WhatsApp channel will not run; messages will neither be received nor sent`,
    );
  } else {
    // Present means it is a ref — validated before it is resolved, the same
    // "typo, not a switch left off" distinction NOTIFY_CREDENTIAL_REF already
    // draws above.
    for (const [label, ref] of [
      [GREEN_API_INSTANCE_REF_KEY, greenApiInstanceRef as string],
      [GREEN_API_TOKEN_REF_KEY, greenApiTokenRef as string],
    ] as const) {
      if (!CREDENTIAL_REF_PATTERN.test(ref)) {
        throw new Error(
          `${label} אינו ref חוקי (אותיות גדולות, ספרות וקו תחתון בלבד): ${ref}`,
        );
      }
    }
    const [instanceCredential, tokenCredential] = await Promise.all([
      credentials.resolve(greenApiInstanceRef as string, config.businessId),
      credentials.resolve(greenApiTokenRef as string, config.businessId),
    ]);
    if (instanceCredential === null || tokenCredential === null) {
      const unresolvedGreenApiRefs: string[] = [];
      if (instanceCredential === null) unresolvedGreenApiRefs.push(GREEN_API_INSTANCE_REF_KEY);
      if (tokenCredential === null) unresolvedGreenApiRefs.push(GREEN_API_TOKEN_REF_KEY);
      warnings.push(
        `no WhatsApp gateway: ${unresolvedGreenApiRefs.join(', ')} did not resolve to a ` +
          `stored credential`,
      );
    } else if (overrides.whatsappGateway === undefined) {
      // No real implementation exists yet — see `Runtime.whatsapp`'s own
      // docblock. Resolving this far and stopping here, rather than skipping
      // straight to this branch, is what makes a genuinely misconfigured
      // installation (a typo'd ref) distinguishable from one that is simply
      // waiting on a later task.
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

  // Same switch discipline as the SMTP set above, for the same reason
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
  // `buildRuntime` itself throwing: the scheduler, `run-due`,
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
  // registered from env configuration alone with no binding-status check at
  // all. A missing authorisation is likewise the adapter's own runtime
  // failure, not a missing adapter — see this function's own docblock. No
  // charter installed, or no matching binding, is simply zero adapters
  // registered here; neither is an error.
  //
  // **Known limitation, documented rather than fixed here:** the charter and
  // the bindings are read exactly once, at process start — `run-scheduler.ts`
  // builds one `Runtime` and passes it into every pass. A `provider` column
  // written by Task 5's dashboard after this process started therefore has
  // no effect until the scheduler is RESTARTED; re-deriving the registry on
  // every pass would mean re-reading the charter and the master key every
  // 30 seconds, which is an architecture decision for a later task, not a
  // line in this fix round. See `docs/live-thread-runbook.md`.
  const charter = await loadActiveCharter();
  const bindings = await loadBindings();
  const connectionBySystem = new Map(
    (charter?.charter.connections ?? []).map((connection) => [connection.system, connection] as const),
  );
  for (const binding of bindings) {
    if (binding.provider !== GOOGLE_PROVIDER) continue;
    const connection = connectionBySystem.get(binding.system);
    // `connectionAcceptsOAuthCeremony` (`oauth-eligibility.ts`) is this same
    // channel-and-serves check, extracted (final fix wave, item 1) so the
    // OAuth ceremony (`oauth-routes.ts`'s `handleOAuthStart`) and the
    // connections screen (`views.ts`) answer this exact question with the
    // same function, not a second copy that can drift.
    if (!connectionAcceptsOAuthCeremony(connection)) continue;
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

  return {
    registry: new AdapterRegistry(systemAdapters, [browserAdapter]),
    // The encrypted store, never `envCredentials` — that one exists for tests
    // and reads a single shared process environment with no per-business
    // partition at all. `runtime.test.ts` locks this as a positive control
    // rather than as a claim, because a component nobody uses is exactly the
    // component someone wires by mistake (spec §3.4). The same instance the
    // notifier above resolves against, not a second one built from the same key.
    credentials,
    ...(notify !== undefined ? { notify } : {}),
    ...(whatsapp !== undefined ? { whatsapp } : {}),
    warnings,
  };
}
