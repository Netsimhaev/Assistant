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
import { oauthCredentials } from './oauth-token.js';
import type { TokenHttp } from './oauth-token.js';

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
  notify?: { notifier: ApprovalNotifier; dashboardBaseUrl: string };
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

const SMTP_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_FROM',
  'SMTP_USER',
] as const;

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
 * `overrides.calendarHttp` are the same seam one layer over, for a test that
 * needs to see what reached the OAuth token exchange or the calendar API
 * without a real Google account behind it. No production caller ever passes
 * any of them — every real call site calls `buildRuntime()` with zero
 * arguments: `run-scheduler.ts`, `run-due.ts` and `scheduler.ts` in the
 * product, plus the two operator scripts `scripts/live-thread-status.ts` and
 * `scripts/probe-smtp.ts`.
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
 * a grant.** A system whose live binding names `provider: 'google'`, and
 * whose charter-declared connection for that same system uses the `api`
 * channel, gets `createGoogleCalendarAdapter` registered under its system
 * name — even when no grant has been stored for it yet. A missing
 * authorisation is a RUNTIME failure the adapter itself reports
 * (`credential_unavailable`, from `oauthCredentials` resolving to `null`),
 * not a missing adapter — the same distinction §6.2 of the design spec
 * draws between a connectivity failure and a policy decision.
 */
export async function buildRuntime(
  env: Record<string, string | undefined> = process.env,
  overrides: {
    createTransport?: SmtpConfig['createTransport'];
    tokenHttp?: TokenHttp;
    calendarHttp?: CalendarHttp;
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
      googleTokenHttp({ credentials: storedCredentials(key), businessId: config.businessId }),
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
        };
      }
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
  // that same system uses the `api` channel, gets a Google Calendar adapter
  // registered under its system name. Registered even with no grant stored,
  // and even when the binding's own `status` is not `live` — that status is
  // what `resolveChannel` later reports as `unavailable`, at plan-execution
  // time; it is not a reason for the adapter itself not to exist, the same
  // way the mail adapter above is registered from env configuration alone
  // with no binding-status check at all. A missing authorisation is
  // likewise the adapter's own runtime failure, not a missing adapter — see
  // this function's own docblock. No charter installed, or no matching
  // binding, is simply zero adapters registered here; neither is an error.
  const charter = await loadActiveCharter();
  const bindings = await loadBindings();
  const connectionBySystem = new Map(
    (charter?.charter.connections ?? []).map((connection) => [connection.system, connection] as const),
  );
  for (const binding of bindings) {
    if (binding.provider !== GOOGLE_PROVIDER) continue;
    const connection = connectionBySystem.get(binding.system);
    if (connection === undefined || connection.channel !== 'api') continue;
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
    warnings,
  };
}
