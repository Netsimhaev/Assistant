// **The digest runs LAST in the scheduler pass.** After the plans, after the
// closes, after the WhatsApp report — otherwise it reports on a period that
// ended half a second after it looked. The same ordering argument that put
// `closeVerifiedJobs` after the plans (`scheduler.ts`'s own docblock).
//
// There is a second, independent reason the ordering is load-bearing:
// `collectDigestFacts` (`digest-facts.ts`) windows its "expired approval"
// exception on `expires_at`, and an approval only reaches `state = 'expired'`
// after `expireOverdue` sweeps it — which happens inside `tick()`, at the
// START of the pass. Running the digest last is what lets it see approvals
// that expired during its own window, in the same pass that expired them.
// Moving this earlier would silently reopen the "matches nothing" failure
// `digest-facts.ts`'s own docblock already names for `decided_at`.
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
  /** Every window that was due and got stored this pass, whether or not it had content. */
  sent: readonly { kind: DigestKind; digestId: string }[];
  /** Windows that were due but produced nothing worth interrupting him for. */
  screenOnly: number;
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
    return { sent: [], screenOnly: 0, errored: null };
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
    return { sent: [], screenOnly: 0, errored: err instanceof Error ? err.message : String(err) };
  }
  if (active === null) {
    return { sent: [], screenOnly: 0, errored: `no active charter for business ${businessId}` };
  }
  // `active.charter.identity.timezone` — never `active.bundle.quietHours`,
  // which is `null` whenever the charter leaves quiet hours unconfigured
  // (`compile.ts`). The digest needs a zone unconditionally; the identity
  // field is the one that is always present.
  const timeZone = active.charter.identity.timezone;
  const ceilings = {
    monthlyMinor: active.bundle.ceilings.monthlyMinor,
    currency: active.bundle.ceilings.currency,
  };

  const sent: { kind: DigestKind; digestId: string }[] = [];
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

    // Every due window that gets stored this pass is reported in `sent` —
    // the kind ran, whether or not it was worth his attention. `screenOnly`
    // is the narrower count, of those that reached only the stored row (and
    // so the screen) and never the inbox, because `rendered.hadContent` was
    // false. A window can be in BOTH: `sent` says the pass processed it,
    // `screenOnly` says what it was worth.
    sent.push({ kind, digestId: stored.digestId });
    if (!rendered.hadContent) screenOnly += 1;
  }

  return { sent, screenOnly, errored: null };
}

const EMAIL_SUBJECT: Readonly<Record<DigestKind, string>> = Object.freeze({
  daily: 'תדריך יומי',
  weekly: 'תדריך שבועי',
});
