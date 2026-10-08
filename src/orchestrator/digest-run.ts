// **The digest runs LAST in the scheduler pass.** After the plans, after the
// closes, after the WhatsApp report — the same ordering argument that
// already puts `closeVerifiedJobs` after the plans (`scheduler.ts`'s own
// docblock): work must happen before it is reported on.
//
// **What running dead last actually buys is POINT-IN-TIME correctness for
// `waiting.*`.** `digest-facts.ts` §3.1 (pending approvals, open questions,
// deferred jobs) is deliberately NOT window-scoped — it is a plain `SELECT`
// against current state. An approval `runDueJobs` raises earlier in THIS
// very pass is already `state = 'pending'` by the time the digest's query
// runs, so it is reported immediately instead of a full scheduler interval
// later. Fix round 1's own test (`scheduler-runs-plans.test.ts`, "counts an
// approval this very pass just raised") proves exactly this, and fails if
// the digest is moved ahead of `runDueJobs`.
//
// The expired-approval EXCEPTION in `collectDigestFacts` (§3.3, windowed on
// `expires_at`) only requires running the digest after `tick()` — not dead
// last specifically — because `expireOverdue` is what flips `state` to
// `'expired'`, and that happens once, at the very start of the pass. (An
// earlier version of this comment claimed this was a second, independent
// reason for the DEAD-LAST position; it is not — it is a weaker requirement
// that the dead-last position happens to also satisfy.)
//
// **Same-pass WINDOW-SCOPED counting (jobsCompleted, messagesSent,
// documentsRead, memoriesWritten) is structurally impossible, and no
// ordering of this function within the pass changes that.** `dueWindow`'s
// `end` is always the SCHEDULED moment and always `<= now`
// (`digest-window.ts`'s own docblock: "never `now` itself"). Anything
// stamped with the database's real `now()` DURING this very pass — a job's
// `closed_at`, a step's `completed_at` — therefore has a timestamp
// `>= now >= end`, and the `< end` bound in every window-scoped query in
// `digest-facts.ts` excludes it by construction. Such work is always picked
// up by a LATER pass's window instead, once enough time has passed for a
// new scheduled hour to be in the past. Moving this function earlier or
// later within the pass has no effect on that at all — only the
// point-in-time measures above are ordering-sensitive.
//
// **No model is reachable from this file, at any depth.** Spec §2 decision 2,
// locked by a transitive import walk in `digest-invariants.test.ts`, which is
// pointed at THIS file as its entry point.
import { loadActiveCharter } from '../charter/store.js';
import { config } from '../config.js';
import { loadDigestSettings } from '../governance/digest-settings.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { collectDigestFacts } from './digest-facts.js';
import { renderDigest } from './digest-render.js';
import { lastWindowEnd, recordChannel, storeDigest } from './digest-store.js';
import { dueWindow } from './digest-window.js';
import type { DigestKind } from './digest-window.js';

export interface DigestRunResult {
  /**
   * Every window that was due and got STORED this pass — delivered to a
   * channel, or not. An empty window (`hadContent: false`) still appears
   * here: this field answers "which kinds did the pass process", never
   * "which kinds actually reached an inbox". Use `screenOnly` for the count
   * of windows that reached only the stored row (and so only the screen).
   * Named `produced`, not `sent`, for exactly this reason — fix round 1:
   * the field was originally called `sent`, which a reader could easily
   * (and wrongly) take to mean "delivered".
   */
  produced: readonly { kind: DigestKind; digestId: string }[];
  /** Windows that were due but produced nothing worth interrupting him for. */
  screenOnly: number;
  /**
   * `loadActiveCharter`'s thrown message, if it threw — a stale or
   * unparseable charter. Null on a clean pass. The same treatment
   * `scanError`/`whatsappError`/`autonomyError` already give an escaping
   * throw in `scheduler.ts`: caught here, reported, and never propagated —
   * the pass still has approvals to expire and jobs to run, and an
   * installation whose charter cannot be parsed must not lose those too.
   */
  errored: string | null;
}

const KINDS: readonly DigestKind[] = ['daily', 'weekly'];

/**
 * Runs both kinds, each independently, and stores/delivers whichever window
 * is due for each.
 *
 * **Storage precedes delivery, always.** Deliver-then-store leaves a window
 * in which the owner has been told something no record exists of.
 * Store-then-deliver leaves at worst a stored digest whose delivery outcome
 * is unknown — visible to the next pass, readable by an operator. The same
 * direction `trip()` (`governance/killswitch.ts`) chose, for the same reason.
 *
 * **An empty window reaches the screen but not the inbox.** `storeDigest`
 * always runs for a due window; email and WhatsApp go out only when the
 * owner enabled that channel AND `rendered.hadContent`. A daily email that is
 * usually empty teaches him to ignore the one that is not — and then he
 * misses the day that mattered (spec §2 decision 3).
 *
 * **A channel the owner enabled but which cannot be reached is RECORDED,
 * never silenced.** No `sendAlert` supplied, or no messenger →
 * `recordChannel(..., 'skipped_not_connected')`. A send that fails →
 * `'failed'`. "Not sent" and "nothing to send" must not look alike (spec §6).
 * Each channel is caught on its own and never rethrown — one dead channel
 * must not cost the other, nor the stored digest.
 */
export async function runDigests(options: {
  businessId?: string;
  now?: Date;
  sendAlert?: (subject: string, body: string) => Promise<{ ok: boolean; error?: string }>;
  messenger?: BossMessenger;
}): Promise<DigestRunResult> {
  const businessId = options.businessId ?? config.businessId;
  const now = options.now ?? new Date();

  const settings = await loadDigestSettings({ businessId });
  if (settings.schedule === 'off') {
    return { produced: [], screenOnly: 0, errored: null };
  }

  // A stale or unparseable charter makes `loadActiveCharter` THROW
  // (`charter/store.ts`'s own docblock). Caught here and returned as
  // `errored` — the pass still has approvals to expire and jobs to run, and
  // an installation whose charter cannot be parsed must not lose those too.
  // Same treatment `scanError`/`whatsappError` already give an escaping
  // throw in `scheduler.ts`.
  let active;
  try {
    active = await loadActiveCharter(businessId);
  } catch (err) {
    return { produced: [], screenOnly: 0, errored: err instanceof Error ? err.message : String(err) };
  }
  if (active === null) {
    return { produced: [], screenOnly: 0, errored: `no active charter for business ${businessId}` };
  }
  // `active.charter.identity.timezone` — never `active.bundle.quietHours`,
  // which is `null` whenever the charter leaves quiet hours unconfigured
  // (`compile.ts`). The digest needs a zone unconditionally; the identity
  // field is the one that is always present.
  const timeZone = active.charter.identity.timezone;
  const ceilings = {
    monthlyMinor: active.bundle.ceilings.monthlyMinor,
    currency: active.bundle.ceilings.currency,
    timeZone,
  };

  const produced: { kind: DigestKind; digestId: string }[] = [];
  let screenOnly = 0;

  for (const kind of KINDS) {
    const lastEnd = await lastWindowEnd(kind, { businessId });
    const window = dueWindow(settings, kind, lastEnd, now, timeZone);
    if (window === null) continue;

    const facts = await collectDigestFacts(window, ceilings, { businessId });
    const rendered = renderDigest(facts);

    // Storage before delivery — see this function's own docblock.
    const stored = await storeDigest({ window, rendered }, { businessId });

    // Email: only when the owner opted in AND there is content worth
    // interrupting him for. Each channel's outcome is caught and recorded on
    // its own — a dead channel must never take the stored row, or the other
    // channel, down with it.
    if (settings.toEmail) {
      if (rendered.hadContent && options.sendAlert !== undefined) {
        try {
          const result = await options.sendAlert(EMAIL_SUBJECT[kind], rendered.body);
          await recordChannel(stored.digestId, 'email', result.ok ? 'sent' : 'failed', { businessId });
        } catch {
          await recordChannel(stored.digestId, 'email', 'failed', { businessId });
        }
      } else if (rendered.hadContent) {
        // Wanted, but no seam supplied — not connected, never silenced.
        await recordChannel(stored.digestId, 'email', 'skipped_not_connected', { businessId });
      }
      // `!rendered.hadContent`: email stays null on the row — spec §2
      // decision 3. Not sent, and not recorded as "not connected" either,
      // because nothing was owed to the inbox at all.
    }

    if (settings.toWhatsApp) {
      if (rendered.hadContent && options.messenger !== undefined) {
        try {
          const result = await options.messenger.send({ text: rendered.body, jobId: null });
          await recordChannel(stored.digestId, 'whatsapp', result.ok ? 'sent' : 'failed', { businessId });
        } catch {
          await recordChannel(stored.digestId, 'whatsapp', 'failed', { businessId });
        }
      } else if (rendered.hadContent) {
        await recordChannel(stored.digestId, 'whatsapp', 'skipped_not_connected', { businessId });
      }
    }

    // Every due window that gets stored this pass is reported here — the
    // kind ran, whether or not it was worth his attention. `screenOnly` is
    // the narrower count, of those that reached only the stored row (and so
    // the screen) and never the inbox, because `rendered.hadContent` was
    // false. A window can be in BOTH: `produced` says the pass processed it,
    // `screenOnly` says what it was worth.
    produced.push({ kind, digestId: stored.digestId });
    if (!rendered.hadContent) screenOnly += 1;
  }

  return { produced, screenOnly, errored: null };
}

const EMAIL_SUBJECT: Readonly<Record<DigestKind, string>> = Object.freeze({
  daily: 'תדריך יומי',
  weekly: 'תדריך שבועי',
});
