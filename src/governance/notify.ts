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
 *
 * `notify` also never *hangs*. `evaluateToolCall` (`src/policy/engine.ts`)
 * awaits this call inline before it can return `queue_approval` — round 1 of
 * review found that a transport which simply never settles (an unreachable
 * SMTP host, with nothing else in the diff bounding the wait) turned the
 * try/catch's protection against throwing into no protection at all against
 * silence, and silence is the more common outage. `withDeadline` below races
 * the transport call against `NOTIFY_TIMEOUT_MS` regardless of whether the
 * transport itself cooperates — see that function's docblock for why the
 * `AbortSignal` handed to `transport.send` is not, on its own, enough.
 */
import type { MailTransport } from '../orchestrator/adapters/mail.js';
import type { CredentialSource } from '../orchestrator/credentials.js';
import type { ApprovalRequest } from './approvals.js';

export interface ApprovalNotifier {
  readonly channel: 'email';
  notify(request: ApprovalRequest, link: string): Promise<{ ok: boolean; error?: string }>;
}

/**
 * Everything `createEmailNotifier` needs, as one object rather than five
 * positional parameters — `ref` and `businessId` sit next to each other with
 * the same type (`string`), and a call site that swapped them would still
 * typecheck under positional parameters. None of these fields has a
 * default: a caller with no owner address, no credential source, no ref or
 * no business id has nothing sensible to fall back to, and `businessId`
 * above all must never be silently supplied — see `CredentialSource.resolve`
 * (`src/orchestrator/credentials.ts`) for why.
 */
export interface EmailNotifierOptions {
  /** Where the transport actually sends bytes. */
  transport: MailTransport;
  /** The owner's address — fixed configuration, not a per-request value. */
  to: string;
  /** Resolved fresh on every `notify` call — see the docblock below. */
  credentials: CredentialSource;
  /** The `credential_ref` this notifier always resolves. */
  ref: string;
  /** Required, with no default — see `EmailNotifierOptions`'s own docblock. */
  businessId: string;
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
 * the dashboard is that those details sit behind a login.
 *
 * Deliberately excludes `request.summary`/`request.detail` too, as of fix
 * round 1 (F3). Those two fields carry the proposal's own headline and
 * description when `GateContext.proposalText` was supplied
 * (`src/policy/engine.ts`) — words a model wrote from whatever it read,
 * ingested content included. This function instead reconstructs the same
 * two lines the pre-proposal card always showed, from fields that are never
 * proposal-supplied: `risk.explanation`, one sentence written to be "shown
 * to the boss" (`RiskAssessment`'s own docblock, `src/domain/risk.ts`), and
 * `` `${proposedTool} · ${actionClass} · רצועה ${band}` `` — a label built
 * from the tool the gate itself resolved, not text an attacker's content
 * could shape. The mailbox is assumed less trusted than the dashboard, so
 * only text the system authored travels here; the proposal's own words wait
 * behind the login, on the card, where `renderApprovalCard` already shows
 * them.
 */
function buildMessage(request: ApprovalRequest, link: string): { subject: string; body: string } {
  const band = BAND_LABELS[request.risk.band] ?? request.risk.band;
  const summary = request.risk.explanation;
  const detail = `${request.proposedTool} · ${request.actionClass} · רצועה ${request.risk.band}`;
  const subject = `בקשה לאישור: ${summary}`;
  const body = [
    summary,
    detail,
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
 * How long `notify` waits for a send before giving up.
 *
 * This is a courtesy notification, not the work the approval represents —
 * the row already exists and the dashboard already shows it (see this
 * module's top docblock). Five seconds is enough for a real SMTP exchange
 * to complete against a healthy relay (matches `DEFAULT_TIMEOUT_MS` in
 * `src/mail/transport.ts`, so the transport's own socket timeouts are not
 * the thing racing this deadline to the finish), and short enough that a
 * dead relay costs the gate almost nothing.
 */
export const NOTIFY_TIMEOUT_MS = 5_000;

/**
 * Bound a promise that the transport might never settle.
 *
 * Mirrors `callWithDeadline` in `src/orchestrator/run-plan.ts` — same bug,
 * same fix, two call sites. An `AbortSignal` handed to a component is
 * advisory only: nothing forces the component to check it, so a transport
 * that ignores `context.signal` entirely (or a test double that hangs
 * forever on purpose) leaves whoever only passed the signal waiting anyway.
 * Racing the call itself against an independent timer is what actually
 * binds the wait; `AbortSignal.timeout` at the call site below is still
 * worth sending, because it lets a *cooperating* transport give up on its
 * own socket early, but this function does not depend on that cooperation.
 */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number, what = 'השליחה'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} לא הסתיימה תוך ${timeoutMs} מ״ש`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * `notify` resolves a fresh credential on every call rather than once at
 * construction, so a rotation (`putSecret`, `src/governance/credential-store.ts`)
 * takes effect on the very next notification, with no process restart.
 * There is no connection binding behind this send — it is a system
 * notification, not a governed business action — so `endpoint` is always
 * `null`; the credential is the only per-call thing this module resolves.
 *
 * An unresolved ref (a missing key, a rotation gone wrong, the wrong
 * business id) is reported through the same `{ ok: false }` shape a
 * transport failure already returns, and it is never thrown: this module's
 * contract (see the top docblock) is that a notification failure never
 * fails the approval it announces. An unresolved ref is the same class of
 * event as an unreachable relay, so the call site does not need to tell
 * them apart.
 *
 * Resolution happens before `buildMessage` runs — no point assembling a
 * message this call will not be able to send — and it is raced against the
 * same `withDeadline` the transport call is.
 *
 * An earlier version of this docblock argued the opposite, that "a credential
 * lookup is a local read with no such failure mode". That was wrong, and it is
 * recorded here rather than deleted. The production `CredentialSource`
 * (`storedCredentials`, `src/governance/credential-store.ts`) is a `db.query`
 * on a **pooled** connection, and an exhausted pool does not reject — it
 * *queues*, which is a hang, which is precisely the failure mode
 * `withDeadline` exists for and precisely the one an `AbortSignal` and a
 * try/catch both fail to catch. The try/catch below turns a rejection into
 * `{ ok: false }`; nothing but a race turns silence into one. And the gate
 * (`evaluateToolCall`, `src/policy/engine.ts`) awaits `notify` **inline**
 * before it can return `queue_approval`, so an unbounded wait here stalls the
 * approval path itself — the same reasoning that put a deadline on the
 * transport, one call earlier in the same function.
 */
export function createEmailNotifier(options: EmailNotifierOptions): ApprovalNotifier {
  const { transport, to, credentials, ref, businessId } = options;
  return {
    channel: 'email',

    async notify(request, link) {
      // The `resolve` call sits inside this same `try`, not before it: the
      // production `CredentialSource` (`storedCredentials`,
      // `src/governance/credential-store.ts`) awaits a `db.query` that can
      // reject — a lost connection, a pool that gave up — and a rejection
      // there is exactly as much "notify failed" as a throwing transport
      // below. `notify` never throws, full stop; a resolve outside this
      // block would make that only two-thirds true. And it is inside
      // `withDeadline` for the other half of the same argument: an exhausted
      // pool queues rather than rejecting, and a try/catch cannot catch
      // silence (see this function's docblock).
      try {
        const credential = await withDeadline(
          credentials.resolve(ref, businessId),
          NOTIFY_TIMEOUT_MS,
          'פתירת הסוד',
        );
        if (credential === null) {
          // `ref` is a configuration name, not a secret — safe to quote
          // here, unlike anything that could come from `credential.value`.
          return { ok: false, error: `לא נמצא credential עבור ${ref}` };
        }

        const { subject, body } = buildMessage(request, link);
        await withDeadline(
          transport.send(
            { to: [to], subject, body },
            {
              endpoint: null,
              credential,
              idempotencyKey: `approval-notify:${request.approvalId}`,
              signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
            },
          ),
          NOTIFY_TIMEOUT_MS,
        );
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
