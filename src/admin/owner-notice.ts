/**
 * The owner hears when a technician touched his sign-in (final review I1).
 *
 * The panel lets one technician reset the owner's Authenticator and issue a
 * password-reset link — together, a technician can take the account over.
 * That is an accepted, owner-ruled risk (docs/08-risks.md); what keeps it
 * from being a SILENT one is this notice: on every `totp_reset` and
 * `reset_issued` the owner gets a short Hebrew mail through the business's
 * own notification seam — the same one `businessRuntime` builds for approval
 * notices (`notify_to`, the SMTP settings, `NOTIFY_SMTP_PASS`).
 *
 * **Best effort, never a gate.** The action already happened when this runs.
 * A failed send, a throw, or a business with no notification configured never
 * fails the action; each is recorded in the business's own audit trail as an
 * `incident` — `owner_notice_failed:<kind>` or `owner_notice_not_sent:<kind>`
 * — the same shape as `approval_notify_failed`, so "the owner was not told"
 * is a fact on record and not silence.
 *
 * **Each notice carries a fresh id line**, because `sendAlert`'s idempotency
 * key is derived from subject and body: two resets of the same kind would
 * otherwise collapse into one at the mail server while the send reports ok.
 */
import { ulid } from 'ulid';
import { appendAudit } from '../audit/log.js';
import { withBusiness } from '../db/pool.js';
import { businessRuntime, type ServerRuntime } from '../orchestrator/runtime.js';
import { canonicalHash } from '../util/canonical.js';

export type OwnerNoticeKind = 'totp_reset' | 'reset_issued';

export type OwnerNoticeDelivery =
  | { status: 'sent' }
  | { status: 'failed'; error: string }
  | { status: 'not_configured' };

/** Sends one notice to the business's owner. May throw; `noticeOwner` contains it. */
export type OwnerNoticeSender = (businessId: string, subject: string, body: string) => Promise<OwnerNoticeDelivery>;

/** No seam at all: every notice is "not sent", and recorded as such. */
export const NO_OWNER_NOTICE: OwnerNoticeSender = async () => ({ status: 'not_configured' });

export const OWNER_NOTICE_FOOTER = 'אם לא ביקשת זאת, פנה למנהל המערכת.';

export const OWNER_NOTICE_TEXT: Record<OwnerNoticeKind, { subject: string; body: string }> = {
  totp_reset: {
    subject: 'Google Authenticator של החשבון שלך אופס',
    body: 'איש התמיכה אפס את Google Authenticator של החשבון שלך.',
  },
  reset_issued: {
    subject: 'הונפק קישור לאיפוס הסיסמה שלך',
    body: 'איש התמיכה הנפיק קישור לאיפוס הסיסמה של החשבון שלך.',
  },
};

const MAX_ERROR_CHARS = 200;

/**
 * The production sender: this business's runtime, built fresh (its settings
 * may have changed since the last notice), and its `notify.sendAlert`.
 */
export function runtimeOwnerNoticeSender(server: ServerRuntime): OwnerNoticeSender {
  return async (businessId, subject, body) => {
    const runtime = await withBusiness(businessId, (db) => businessRuntime(server, db));
    const sendAlert = runtime.notify?.sendAlert;
    if (sendAlert === undefined) return { status: 'not_configured' };
    const result = await sendAlert(subject, body);
    return result.ok ? { status: 'sent' } : { status: 'failed', error: result.error ?? 'send returned not-ok' };
  };
}

/** Tell the owner; never throws. Returns what happened, for tests and logs. */
export async function noticeOwner(
  send: OwnerNoticeSender,
  businessId: string,
  kind: OwnerNoticeKind,
): Promise<OwnerNoticeDelivery['status']> {
  const text = OWNER_NOTICE_TEXT[kind];
  const body = `${text.body}\n${OWNER_NOTICE_FOOTER}\n\nמזהה הודעה: ${ulid()}`;
  let delivery: OwnerNoticeDelivery;
  try {
    delivery = await send(businessId, text.subject, body);
  } catch (error) {
    delivery = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  if (delivery.status !== 'sent') {
    const reason =
      delivery.status === 'failed'
        ? `owner_notice_failed:${kind} — ${delivery.error.slice(0, MAX_ERROR_CHARS)}`
        : `owner_notice_not_sent:${kind} — no notification configured for this business`;
    try {
      await withBusiness(businessId, (db) =>
        appendAudit(db, {
          actor: 'system',
          kind: 'incident',
          charterVersion: 'n/a',
          provenance: 'boss',
          inputHash: canonicalHash({ ownerNotice: kind }),
          reason,
        }),
      );
    } catch {
      // Recording the failure failed too. The reset stands either way; the
      // panel action's own audit row (`recordStaffAction`) already names it.
    }
  }
  return delivery.status;
}
