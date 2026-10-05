/**
 * Speaking back to the owner over WhatsApp — the acknowledgement and the
 * report, not an action taken on a counterparty.
 *
 * The precedent is `createEmailNotifier` (`src/governance/notify.ts`): a
 * system notification sits outside the policy gate (there is no action class
 * for "tell the boss what happened to his own instruction"), and `send`
 * never throws for the same reason that notifier's `notify` never throws —
 * the work this message reports on has already happened and already been
 * recorded; the owner's phone not hearing about it is a separate fact that
 * must not take the caller down with it.
 *
 * Two things carry over from that precedent, deliberately:
 *   - The whole body sits inside one `try`, exactly where `createEmailNotifier`
 *     puts its credential resolution — inside, not before. This module does
 *     not resolve a credential (the gateway already owns that), but
 *     `recordAttempt` below calls `recordOutbound`/`settleMessage`, each a
 *     `db.query` on a pooled connection that can reject exactly the way a
 *     lost connection can. A `try` that starts after that call would make
 *     "never throws" only partly true.
 *   - The gateway call is raced against a deadline with a local `withDeadline`,
 *     not left to an `AbortSignal` alone. This project has already paid for
 *     that confusion twice — `callWithDeadline` in `src/orchestrator/run-plan.ts`
 *     and `withDeadline` in `src/governance/notify.ts` both exist because an
 *     `AbortSignal` is advisory: nothing forces a transport (or a test double)
 *     to check it, so a gateway that simply never settles would turn the
 *     try/catch below into no protection at all against silence. This is the
 *     third call site, hence a third local copy rather than an import — the
 *     same choice `oauth-token.ts`'s `withOAuthDeadline` already made, because
 *     each site's deadline wraps a different promise with a different
 *     fallback value and there is nothing shared to factor out beyond the
 *     shape, which is a few lines.
 *
 *     `gateway.sendMessage` itself takes no `AbortSignal` — there is nothing
 *     to tell a real transport to stop once the deadline fires, so the
 *     underlying HTTP call may still be in flight, and the owner's phone may
 *     still receive the message, after `send` has already returned
 *     `{ ok: false }`. This is the same honest-uncertainty state
 *     `job_step_results.status = 'unknown'` exists for elsewhere in this
 *     project ("the call was sent and no authoritative answer came back",
 *     written rather than skipped) — there is no `'unknown'` on
 *     `MessageState`, so `recordAttempt` settles the row to `'failed'`
 *     instead, the honest state this table actually has for "we do not know
 *     that this landed."
 *
 * What is this module's own, not inherited from the notifier: there is no
 * recipient parameter anywhere in {@link BossMessenger}. The number comes
 * from the charter, through `contactId` at construction (resolved upstream by
 * `principalWhatsAppKey`, `src/governance/principal-number.ts`) — this is the
 * control, not a convenience. The moment this assistant can be asked to send
 * WhatsApp to an arbitrary number, that request is an agent action and must
 * pass the policy gate with an action class, the charter's rate ceilings and
 * a `doNotContact` check, same as any other outbound tool. That is a later
 * sub-project; a compile-time absence of the parameter is the boundary until
 * then, so nothing here accepts one "for flexibility".
 *
 * This module sends text it is *given* — `input.text` is composed by
 * whoever calls `send` — and composes none of its own, so unlike
 * `createEmailNotifier` (which writes the Hebrew subject and body a human
 * reads) it carries no Hebrew strings: its own `error` values are internal,
 * for logs and audit, in English, per this project's convention.
 */
import type { WhatsAppGateway } from './gateway.js';
import { recordOutbound, settleMessage } from './store.js';
import type { Queryable } from '../db/pool.js';
import { canonicalHash } from '../util/canonical.js';

export interface BossMessenger {
  readonly channel: 'whatsapp';
  /** Never throws. Never takes a recipient. */
  send(input: { text: string; jobId: string | null }): Promise<{ ok: boolean; error?: string }>;
}

/**
 * Everything `createBossMessenger` needs, as one object rather than five
 * positional parameters that would otherwise put two same-typed strings
 * (`contactId`, `businessId`) next to each other. `businessId` has no
 * default — see `CredentialSource.resolve` (`src/orchestrator/credentials.ts`)
 * for why a business-scoped write must never silently fall back to
 * configuration.
 */
export interface CreateBossMessengerOptions {
  gateway: WhatsAppGateway;
  /**
   * The principal's number, already validated. From `principalWhatsAppKey`
   * (`src/governance/principal-number.ts`), which returns
   * `authorityNumberKey`'s own output — **digits only, no leading `+`**
   * (`authorityNumberKey` strips the sigil after validating it is present).
   * This is deliberately a different shape from
   * `NormalizedInboundMessage.senderNumber` (leading `+`, see that field's
   * own docblock): one is the OUTBOUND form this module hands to
   * `gateway.sendMessage`, the other is the INBOUND form a gateway hands up
   * for the principal check to read. Fix round A, finding 2 — stated
   * explicitly, on both interfaces, because the two formats living only in
   * a planning document is exactly how they drifted apart once already.
   */
  contactId: string;
  businessId: string;
  now?: () => Date;
  /**
   * Test-only. Overrides the pooled connection `recordAttempt` writes
   * through — the same escape hatch `recordOutbound`/`settleMessage`
   * (`src/whatsapp/store.ts`) already expose as `options.db`, so a test can
   * inject a connection that rejects without touching the real pool.
   * Production callers never pass this.
   */
  db?: Queryable;
}

/**
 * How long `send` waits for the gateway before giving up.
 *
 * Matches `NOTIFY_TIMEOUT_MS` in `src/governance/notify.ts` for the same
 * reason: this is a courtesy message, not the work it reports on, so a
 * generous-but-bounded wait costs the caller almost nothing when the gateway
 * is dead, and is enough time for a real send against a healthy bridge.
 */
const SEND_TIMEOUT_MS = 5_000;

/**
 * Bound a promise the gateway might never settle.
 *
 * Mirrors `withDeadline` in `src/governance/notify.ts` (itself mirroring
 * `callWithDeadline` in `src/orchestrator/run-plan.ts`) — same bug, same
 * fix, third call site. An `AbortSignal` is advisory only: nothing forces a
 * gateway implementation, or a test double, to check it, so racing the call
 * itself against an independent timer is what actually binds the wait.
 */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`send did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * `idempotencyKey` folds in the wall-clock minute, not just `jobId` and
 * `text`, so a retry of the exact same acknowledgement inside the same
 * minute collapses into one send at the gateway, while the same text sent a
 * minute later (a genuinely new report, worded identically by coincidence)
 * gets a key of its own rather than being silently swallowed forever. A
 * constant key would be worse than no key: a real gateway dedupes every
 * message after the first against it, and the owner would silently stop
 * hearing anything past the first send.
 */
function idempotencyKeyFor(input: { jobId: string | null; text: string }, now: Date): string {
  const minute = Math.floor(now.getTime() / 60_000);
  return canonicalHash({ jobId: input.jobId, text: input.text, minute });
}

/**
 * Writes the one row the dashboard reads for this attempt, and absorbs its
 * own failure.
 *
 * `recordOutbound` always creates the row as `'handled'`
 * (`src/whatsapp/store.ts`); `outcome: 'failed'` follows it with a
 * `settleMessage` call that moves it to `'failed'` — the honest state for a
 * gateway rejection, a thrown transport error, or a deadline that fired
 * while the real call might still be in flight (see the module docblock).
 * `outcome: 'sent'` leaves the row exactly as `recordOutbound` created it.
 *
 * The `try`/`catch` here is this helper's own, not `send`'s — recording the
 * attempt is itself best-effort, the same hazard class as the gateway call,
 * and a failure here must never override or block the real outcome `send`
 * is about to report. Without this helper's own catch, a database hiccup
 * while writing the row would turn a successful send into a reported
 * failure (or bury the gateway's own rejection reason under a database
 * error) purely because of where the write happened to run.
 */
async function recordAttempt(
  input: { text: string; jobId: string | null },
  businessId: string,
  outcome: 'sent' | 'failed',
  db: Queryable | undefined,
): Promise<void> {
  try {
    const dbOption = db !== undefined ? { businessId, db } : { businessId };
    const row = await recordOutbound({ body: input.text, jobId: input.jobId }, dbOption);
    if (outcome === 'failed') {
      await settleMessage(row.id, 'failed', {}, dbOption);
    }
  } catch {
    // Best-effort, by design — see this function's docblock.
  }
}

export function createBossMessenger(options: CreateBossMessengerOptions): BossMessenger {
  const { gateway, contactId, businessId, db } = options;
  const nowFn = options.now ?? (() => new Date());

  return {
    channel: 'whatsapp',

    async send(input) {
      // `send` never throws, full stop. Everything that can reject —
      // `idempotencyKeyFor` could in principle throw synchronously too —
      // sits inside this one `try`, the same placement `createEmailNotifier`
      // gives its own credential resolution.
      try {
        const idempotencyKey = idempotencyKeyFor(input, nowFn());

        let result: { messageId: string; state: 'sent' | 'queued' | 'rejected' };
        try {
          result = await withDeadline(
            gateway.sendMessage({ contactId, body: input.text, idempotencyKey }),
            SEND_TIMEOUT_MS,
          );
        } catch (error) {
          // The gateway call itself threw, or the deadline fired first — a
          // thrown transport error and a timeout are the same class of "we
          // do not know what happened" from here. Record the attempt as
          // failed and report the real cause.
          await recordAttempt(input, businessId, 'failed', db);
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }

        if (result.state === 'rejected') {
          await recordAttempt(input, businessId, 'failed', db);
          return { ok: false, error: 'gateway rejected the message' };
        }

        await recordAttempt(input, businessId, 'sent', db);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
