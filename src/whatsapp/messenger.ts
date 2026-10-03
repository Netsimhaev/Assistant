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
 *     not resolve a credential (the gateway already owns that), but it does
 *     call `recordOutbound`, a `db.query` on a pooled connection that can
 *     reject exactly the way a lost connection can. A `try` that starts after
 *     that call would make "never throws" only partly true.
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
import { recordOutbound } from './store.js';
import { canonicalHash } from '../util/canonical.js';

export interface BossMessenger {
  readonly channel: 'whatsapp';
  /** Never throws. Never takes a recipient. */
  send(input: { text: string; jobId: string | null }): Promise<{ ok: boolean; error?: string }>;
}

/**
 * Everything `createBossMessenger` needs, as one object rather than four
 * positional parameters that would otherwise put two same-typed strings
 * (`contactId`, `businessId`) next to each other. `businessId` has no
 * default — see `CredentialSource.resolve` (`src/orchestrator/credentials.ts`)
 * for why a business-scoped write must never silently fall back to
 * configuration.
 */
export interface CreateBossMessengerOptions {
  gateway: WhatsAppGateway;
  /** The principal's number, already validated. From `principalWhatsAppKey`. */
  contactId: string;
  businessId: string;
  now?: () => Date;
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
 * gets a key of its own rather than being silently swallowed forever.
 */
function idempotencyKeyFor(input: { jobId: string | null; text: string }, now: Date): string {
  const minute = Math.floor(now.getTime() / 60_000);
  return canonicalHash({ jobId: input.jobId, text: input.text, minute });
}

export function createBossMessenger(options: CreateBossMessengerOptions): BossMessenger {
  const { gateway, contactId, businessId } = options;
  const nowFn = options.now ?? (() => new Date());

  return {
    channel: 'whatsapp',

    async send(input) {
      // Everything — including `recordOutbound`, a `db.query` on a pooled
      // connection that can reject exactly like a dead transport — sits
      // inside this one `try`. `send` never throws, full stop; starting the
      // `try` after the gateway call would make that only partly true, the
      // same reasoning `createEmailNotifier` states for its own credential
      // resolution (`src/governance/notify.ts`).
      try {
        const idempotencyKey = idempotencyKeyFor(input, nowFn());

        const result = await withDeadline(
          gateway.sendMessage({ contactId, body: input.text, idempotencyKey }),
          SEND_TIMEOUT_MS,
        );

        // Recorded regardless of whether the gateway accepted or rejected —
        // the dashboard shows what the assistant attempted to say, not only
        // what landed. This runs before the rejection check below so a
        // rejected send still leaves a row.
        await recordOutbound({ body: input.text, jobId: input.jobId }, { businessId });

        if (result.state === 'rejected') {
          throw new Error('gateway rejected the message');
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
