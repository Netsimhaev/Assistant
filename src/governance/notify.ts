/**
 * Tells the owner a request is waiting, without making delivery load-bearing.
 *
 * The call site (`src/policy/engine.ts`, in the branch that queues an
 * approval) wraps every call to `notify` in its own try/catch and writes an
 * `incident` audit entry on failure — the row already exists, the dashboard
 * already shows it, and the scheduler will expire it on schedule regardless
 * of whether this ever runs. This module's only job is to turn an
 * `ApprovalRequest` into a safe email and hand it to a `MailTransport`.
 *
 * `notify` itself never throws: a transport failure (including the CRLF
 * rejection `MailTransport` requires — see that interface's docblock) is
 * caught here and turned into `{ ok: false, error }`, mirroring
 * `ExternalAdapter.execute`'s "return a result, never throw" contract
 * (`src/orchestrator/adapters/types.ts`). The call site's own try/catch is
 * the actual safety net — this is what keeps it from needing two different
 * failure shapes to handle.
 */
import type { MailTransport } from '../orchestrator/adapters/mail.js';
import { createCredentialHandle } from '../orchestrator/adapters/types.js';
import type { ApprovalRequest } from './approvals.js';

export interface ApprovalNotifier {
  readonly channel: 'email';
  notify(request: ApprovalRequest, link: string): Promise<{ ok: boolean; error?: string }>;
}

const BAND_LABELS: Record<string, string> = {
  routine: 'שגרתי',
  sensitive: 'רגיש',
  anomalous: 'חריג',
  blocked: 'חסום',
};

/**
 * The email's content.
 *
 * Deliberately excludes `request.proposedInput` — the raw tool call, which
 * may carry a customer's details, a supplier's price, or anything else the
 * agent read to build it — because the whole point of routing this through
 * the dashboard is that those details sit behind a login. `summary` and
 * `detail` are safe to repeat here: `summary` is `risk.explanation`, one
 * sentence written to be "shown to the boss" (`RiskAssessment`'s own
 * docblock, `src/domain/risk.ts`); `detail` is `` `${toolName} · ${actionClass}
 * · רצועה ${band}` `` (`src/policy/engine.ts`) — a label, not a payload. The
 * mailbox is assumed less trusted than the dashboard, so nothing beyond that
 * label and sentence travels here.
 */
function buildMessage(request: ApprovalRequest, link: string): { subject: string; body: string } {
  const band = BAND_LABELS[request.risk.band] ?? request.risk.band;
  const subject = `בקשה לאישור: ${request.summary}`;
  const body = [
    request.summary,
    request.detail,
    `רמת סיכון: ${band}`,
    `פג תוקף: ${request.expiresAt}`,
    '',
    'לצפייה בפרטים ולקבלת החלטה, יש להיכנס לדשבורד:',
    link,
    '',
    'הודעה זו אינה נושאת את פרטי הבקשה עצמם — אלה מוצגים רק לאחר כניסה מאובטחת.',
  ].join('\n');
  return { subject, body };
}

/**
 * The credential every `notify` call presents to the transport.
 *
 * No connection binding backs this send — it is a system notification, not
 * a governed business action — so there is no per-call secret to resolve.
 * An empty placeholder is enough: `createSmtpTransport` (`src/mail/transport.ts`)
 * falls back to its own configured `auth` whenever a transport is built for
 * exactly this single-account case (see that function's docblock), so this
 * handle's `value` is never actually read on the path this module is meant
 * to run on.
 */
const SYSTEM_CREDENTIAL = createCredentialHandle('notify:system', '');

export function createEmailNotifier(transport: MailTransport, to: string): ApprovalNotifier {
  return {
    channel: 'email',

    async notify(request, link) {
      const { subject, body } = buildMessage(request, link);
      try {
        await transport.send(
          { to: [to], subject, body },
          {
            endpoint: null,
            credential: SYSTEM_CREDENTIAL,
            idempotencyKey: `approval-notify:${request.approvalId}`,
            signal: new AbortController().signal,
          },
        );
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
