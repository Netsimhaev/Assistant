import { createEmailNotifier } from '../governance/notify.js';
import type { ApprovalNotifier } from '../governance/notify.js';
import { createSmtpTransport } from '../mail/transport.js';
import { browserAdapter } from './adapters/browser.js';
import { createMailAdapter } from './adapters/mail.js';
import { AdapterRegistry } from './adapters/registry.js';
import { envCredentials } from './credentials.js';
import type { CredentialSource } from './credentials.js';

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
  'SMTP_PASS',
] as const;

export function buildRuntime(
  env: Record<string, string | undefined> = process.env,
): Runtime {
  const warnings: string[] = [];

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
      const transport = createSmtpTransport({
        host: env['SMTP_HOST'] as string,
        port,
        // Positive check. `!== 'false'` would make a typo mean TLS.
        secure: env['SMTP_SECURE'] === 'true',
        from: env['SMTP_FROM'] as string,
        auth: { user: env['SMTP_USER'] as string, pass: env['SMTP_PASS'] as string },
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
      } else {
        const dashboardBaseUrl = env['DASHBOARD_BASE_URL'];
        notify = {
          notifier: createEmailNotifier(transport, to),
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

  return {
    registry: new AdapterRegistry(systemAdapters, [browserAdapter]),
    credentials: envCredentials(env),
    ...(notify !== undefined ? { notify } : {}),
    warnings,
  };
}
