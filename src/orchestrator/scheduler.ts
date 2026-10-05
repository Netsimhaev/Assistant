import { appendAudit } from '../audit/log.js';
import { loadActiveCharter } from '../charter/store.js';
import { config } from '../config.js';
import { getPool, withTransaction } from '../db/pool.js';
import { expireOverdue } from '../governance/approvals.js';
import { principalWhatsAppKey } from '../governance/principal-number.js';
import { canonicalHash } from '../util/canonical.js';
import { conductPendingDocuments } from './conduct.js';
import type { Judge } from '../sdk/gov-verify.js';
import type { ConductOptions, ConductResult } from './conduct.js';
import { createBossMessenger } from '../whatsapp/messenger.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import type { GatewayHealth } from '../whatsapp/gateway.js';
import { runWhatsAppDoor } from './whatsapp-door.js';
import type { DoorResult } from './whatsapp-door.js';
import { reportWhatsAppJobs } from './whatsapp-report.js';
import type { ReportResult } from './whatsapp-report.js';
import type { RunInstructionOptions } from './instruct.js';
import { scanInbox } from './inbox-scan.js';
import type { ScanResult } from './inbox-scan.js';
import { loadJob, transition } from './jobs.js';
import { evaluateAutonomy } from './promote.js';
import type { AutonomyPassResult } from './promote.js';
import { resumeDelegatedJobs } from './resume-delegated.js';
import type { ResumeResult } from './resume-delegated.js';
import { runDueJobs } from './run-due.js';
import type { RunDueResult } from './run-due.js';
import { buildRuntime } from './runtime.js';
import { closeVerifiedJobs } from './verify.js';
import type { CloseVerifiedResult } from './verify.js';
import type { Runtime } from './runtime.js';

export interface TickResult {
  /** Approvals whose fuse ran out on this tick. */
  expiredApprovals: string[];
  /** Jobs whose wake time had come and that were returned to `execute`. */
  wokenJobs: string[];
  /** True when another scheduler held the lock and this tick did nothing. */
  skipped: boolean;
}

/**
 * One pass of the scheduler.
 *
 * Everything the orchestrator defers depends on this existing. `executeStep`
 * parks a job in `followup` with a `wakeAt` when quiet hours push a message to
 * the morning, and `expireOverdue` marks an approval dead when nobody answered
 * — and until now nothing called either, so a deferred message slept forever
 * and an approval's TTL was decoration.
 *
 * Written as a function returning what it did, with the loop on the outside.
 * A tick you can call once is a tick you can test; a `setInterval` with the
 * logic inside it is not.
 */
export async function tick(
  options: { businessId?: string; now?: Date; limit?: number } = {},
): Promise<TickResult> {
  const businessId = options.businessId ?? config.businessId;
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;

  return withTransaction(async (tx) => {
    // Only one scheduler works a business at a time. `try` rather than a
    // blocking wait: a second scheduler should skip this tick and come back,
    // not queue up behind the first and then repeat its work.
    const { rows } = await tx.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
      [`scheduler:${businessId}`],
    );
    if (rows[0]?.locked !== true) {
      return { expiredApprovals: [], wokenJobs: [], skipped: true };
    }

    const expiredApprovals = await expireApprovals(businessId, limit);
    const wokenJobs = await wakeDueJobs(businessId, now, limit);

    return { expiredApprovals, wokenJobs, skipped: false };
  });
}

/**
 * Expire approvals nobody answered, and free the jobs waiting on them.
 *
 * The job goes to `followup` rather than `failed`: an unanswered approval is
 * not a rejection, and the work is still worth doing when someone gets to it.
 * `onTimeout: 'escalate_next'` is what an anomalous action carries, and
 * escalation is a delivery concern — the job's state is the same either way.
 */
async function expireApprovals(businessId: string, limit: number): Promise<string[]> {
  // Deliberately on the pool and not the caller's transaction: `expireOverdue`
  // is a single atomic UPDATE ... RETURNING, and joining it to the tick's
  // transaction would hold the scheduler lock across every job transition
  // below, each of which opens a transaction of its own.
  const expired = await expireOverdue({ businessId });

  const ids: string[] = [];
  for (const approval of expired.slice(0, limit)) {
    ids.push(approval.approvalId);
    if (approval.jobId === null) continue;

    const job = await loadJob(approval.jobId, { businessId });
    if (job === null || job.phase !== 'await_approval') continue;

    await transition(job.jobId, {
      to: 'followup',
      actor: 'system',
      reason: `approval_expired:${approval.approvalId}`,
      businessId,
    });
  }
  return ids;
}

/** Return every job whose wake time has come to `execute`. */
async function wakeDueJobs(
  businessId: string,
  now: Date,
  limit: number,
): Promise<string[]> {
  const { rows } = await getPool().query<{ job_id: string; phase: string }>(
    `SELECT job_id, phase FROM jobs
      WHERE business_id = $1
        AND closed_at IS NULL
        AND wake_at IS NOT NULL
        AND wake_at <= $2
      ORDER BY wake_at ASC
      LIMIT $3`,
    [businessId, now, limit],
  );

  const woken: string[] = [];
  for (const row of rows) {
    // Only a sleeping job is woken. A job that moved on since the query is not
    // ours to advance, and `transition` would reject it anyway — checking here
    // keeps one stale row from aborting the whole tick.
    if (row.phase !== 'followup') continue;
    await transition(row.job_id, {
      to: 'execute',
      actor: 'system',
      reason: 'wake_at reached',
      businessId,
    });
    woken.push(row.job_id);
  }
  return woken;
}

/**
 * One business's WhatsApp bridge bookkeeping, as this process has last
 * observed it — §7.4, fix round 2 (fields), fix round 3 (the key). A single
 * record, not two parallel maps on the same key: all three fields below are
 * read and written together on every call, and splitting any of them into a
 * second `Map` keyed the same way is exactly the drift shape this codebase
 * keeps refusing to reintroduce (the `job_plans`/`job_authorizations`
 * lesson, restated for a `Map` instead of a table).
 *
 * **Keyed by the PAIR `(since, state)`, never by either alone — fix round
 * 3.** Round 2 keyed by `since` alone, on the theory that two distinct
 * outages never share one; the re-review found the pair this leaves
 * unguarded, by trying to break it rather than taking the theory on trust:
 * a gateway that holds the SAME `since` while the word WORSENS
 * (`'reconnecting'` → `'banned'`) produced no further row and no further
 * email, so the owner was never told his bridge reached the single worst
 * state it can be in. Comparing the pair, not `since` alone, makes a
 * worsening (or changing) word under an unchanged `since` read as a new
 * episode in its own right. It also settles the question `since`-alone
 * left as an argument rather than a fact: a `'connected'` record's `since`
 * can in principle coincide, to the millisecond, with a later outage's —
 * but a `'connected'` record and an outage record can never match on BOTH
 * fields at once, because the `'connected'` branch below always writes
 * `state: 'connected'` and an outage's `state` is by definition something
 * else. No separate "is this an outage at all" field is needed; the pair
 * already answers that question structurally. `since` alone still does the
 * work the pair cannot: a bridge that drops, recovers unseen, and drops
 * again reporting the IDENTICAL word is still read as a new episode,
 * because its `since` differs even though its `state` does not.
 */
interface WhatsAppHealthRecord {
  /**
   * The `since` of the episode — an outage, or a `'connected'` period —
   * this process has most recently finished dealing with. Compared against
   * `current.since` on every call, ALWAYS alongside `state` below — see
   * this interface's own docblock on why the pair, not `since` alone, is
   * what decides whether this pass describes the SAME episode as last time.
   */
  since: string;
  /** The state word that went with `since` above, the other half of the pair — fix round 3. */
  state: GatewayHealth['state'];
  /**
   * Whether an alert has actually been delivered for THIS `(since, state)`
   * pair — or whether there is nothing to deliver, because the pair names a
   * connected period rather than an outage. `false` only while an outage
   * matching this exact pair is still being retried; fix round 1, F1/F2's
   * rule that "attempted" and "told him" are not the same fact.
   */
  delivered: boolean;
  /**
   * Whether the one-time `incident` audit row for THIS pair has already
   * been written — fix round 2's ruling: record once per transition, keep
   * retrying, mark observed only on delivery. Independent of `delivered`:
   * the row is written on the FIRST failed attempt, long before delivery
   * ever succeeds, and must not repeat on every retry in between.
   */
  audited: boolean;
  /**
   * Whether this exact `(since, state)` outage was first seen directly
   * after a record of `state: 'connected'` — fix round A, finding 1.
   * Decided ONCE, the moment this pair is first observed, and carried
   * unchanged through every retry via this field — never recomputed from
   * `state` above on a later call. That distinction matters because a
   * retry's own write already overwrites `state` with THIS outage's word
   * (`'reconnecting'`, say), not the `'connected'` period it followed; a
   * naive `record.state === 'connected'` check would therefore read `true`
   * on the first attempt and `false` on every retry of the SAME outage —
   * silently rewriting "the bridge, which had been connected, disconnected"
   * into "the bridge is not connected" the moment delivery first failed,
   * for an outage whose history never changed. Meaningless (and unused) on
   * a `'connected'` record itself.
   */
  followedConnected: boolean;
}

/**
 * The last WhatsApp bridge bookkeeping this process has observed, per
 * business — §7.4. In-memory, for the life of the process.
 *
 * **Fix round 3 — the FIRST observation ever made for a business DOES
 * alert, when the bridge is already down.** Rounds 1 and 2 both claimed
 * that a first observation is never a transition, and both were wrong in
 * the dangerous direction: an installation that boots — or restarts mid-
 * outage — with the bridge already down got ZERO emails and ZERO audit
 * rows for that outage, for as long as it stayed down, across any number
 * of restarts. That is total, permanent silence about the one state this
 * whole mechanism exists to surface, and it is strictly worse than the
 * noise a flapping bridge can cause (see `checkWhatsAppHealth`'s own
 * docblock for that accepted, opposite-direction cost). The owner's
 * interest in "the bridge is down, and I am only now finding out because
 * the process just started" is identical to his interest in "the bridge
 * JUST went down" — there is no prior state to call this a transition
 * FROM, but there does not need to be: `checkWhatsAppHealth` alerts
 * whenever `current.state !== 'connected'`, whether or not a record exists
 * yet for this business. Nothing is persisted to the database for this —
 * the fix is behavioural, not a new storage layer — so a crash-loop still
 * re-alerts on every restart while the SAME outage persists; that cost is
 * real and is stated honestly below, not hidden the way the false "never a
 * transition" claim hid the opposite one.
 *
 * Keyed by business rather than a single value, matching every other
 * per-business concern in this module — a single installation may in
 * principle run the scheduler for more than one `businessId`.
 */
const lastWhatsAppHealth = new Map<string, WhatsAppHealthRecord>();

/**
 * Writes one `incident` audit row for a health alert that could not be
 * delivered — fix round 1, F1. Mirrors `policy/engine.ts`'s own
 * `approval_notify_failed` pattern exactly: `kind: 'incident'`, the specific
 * failure folded into `reason` as a stable prefix rather than a dedicated
 * `AuditKind` member (CLAUDE.md's own rule on why adding an `ActionClass` or
 * `TrustLevel` member is dangerous does not apply to a free-text `reason`,
 * and inventing a kind for one caller is the same class of unforced
 * complexity). `provenance: 'boss'` follows `killswitch.ts`'s identical
 * choice for the identical reason: this is a fact about the INSTALLATION,
 * not about any one chain of content, and there is no better value to put
 * there. `charterVersion` is a required parameter, not a placeholder — the
 * sole caller below always has the real value in hand from the same charter
 * load it used for the messenger's number, so there is no "none available"
 * branch here the way `killswitch.ts`'s own `?? 'unknown'` fallback has.
 *
 * Never throws: a failure recording a failure must not take the pass down
 * with it, the same discipline every other best-effort write in this
 * codebase keeps (`recordAttempt` in `whatsapp/messenger.ts`, `transcribe.ts`'s
 * own `recordAttempt`).
 */
async function recordWhatsAppHealthNotifyFailure(
  businessId: string,
  charterVersion: string,
  reason: string,
): Promise<void> {
  try {
    await appendAudit(
      {
        actor: 'system',
        kind: 'incident',
        charterVersion,
        provenance: 'boss',
        inputHash: canonicalHash({ kind: 'whatsapp_health_notify_failed', businessId, reason }),
        reason: `whatsapp_health_notify_failed: ${reason}`,
      },
      { businessId },
    );
  } catch {
    // Best-effort — see this function's own docblock.
  }
}

/**
 * How long `checkWhatsAppHealth` waits for `gateway.health()` before giving
 * up — fix round A, finding 3. A status probe, not real work: the bridge is
 * either up and answers almost immediately, or it is down, and the whole
 * point of this call is to find that out fast enough to alert on it. Matches
 * the "courtesy acknowledgement" class (`SEND_TIMEOUT_MS`/`NOTIFY_TIMEOUT_MS`/
 * `ALERT_TIMEOUT_MS`, all 5s) rather than the 60s "real external work" class
 * (`ADAPTER_TIMEOUT_MS`, `TRANSCRIBE_TIMEOUT_MS`) — a health check that takes
 * tens of seconds to answer is itself evidence of trouble, not a call worth
 * waiting out.
 */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * Bound a promise `gateway.health()` might never settle.
 *
 * A sixth local copy of the pattern `notify.ts`, `messenger.ts`,
 * `run-plan.ts`, `oauth-token.ts` and `runtime.ts`'s own `withAlertDeadline`
 * each already carry: an `AbortSignal` is advisory only, and nothing forces
 * a gateway implementation — or a test double — to check it, so racing the
 * call itself against an independent timer is what actually binds the wait.
 */
function withHealthCheckDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`gateway.health() did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * §7.4 — a bridge that WAS connected and is not must reach the owner by
 * EMAIL, never by WhatsApp (WhatsApp is the very thing that is down).
 *
 * **Fix round 1, F6 — a health READ failure must never take the door down
 * with it.** `gateway.health()` is a real network call against the GREEN-API
 * client once Task 11 lands; a blip there is a diagnostic failure, not a
 * reason to refuse the owner's own instructions this pass. It is wrapped in
 * its own `try` and returns silently on a throw — `lastWhatsAppHealth` is
 * left EXACTLY as it was, byte for byte: no read, no write, not even to the
 * default. A genuine outage already being retried is not forgotten, and a
 * genuine reconnect that this exact probe happened to miss is still caught
 * correctly on the next one — see `WhatsAppHealthRecord`'s own docblock on
 * why keying by the `(since, state)` pair rather than either alone is what
 * makes that true even though the reconnect itself was never observed.
 * Nothing here can propagate into the shared `try` in `schedulerPass` that
 * would otherwise skip `runWhatsAppDoor` too.
 *
 * **Fix round 1, F1/F2 — delivery, not an attempt, is what "handled" means.**
 * `record.delivered` for the CURRENT episode only becomes `true` after a
 * `{ ok: true }` from `sendAlert`; a failure — no `sendAlert` configured, or
 * `sendAlert` itself returning `{ ok: false }` or throwing — leaves it
 * `false`, so the NEXT pass still tries the send again for the same episode.
 *
 * **Fix round 2 — the AUDIT ROW is a separate concern from the send, and is
 * written at most once per OUTAGE, not once per retry pass.** Round 1 wrote
 * an `incident` row on every failed attempt, which meant a sustained outage
 * with a down mail relay wrote one row every thirty seconds — and every one
 * of those rows takes the audit chain's own advisory lock, so a sustained
 * double failure (bridge down AND mail down at once) serialised this
 * business's entire audit-writing path for as long as both stayed broken,
 * precisely while something was already going wrong. `record.audited`
 * tracks whether THIS episode has already earned its one row; later retries
 * for the same episode keep trying to SEND but skip the audit write. The
 * `reason` text below says so explicitly, because the row itself has no
 * tail: an operator reading one incident cannot otherwise tell whether the
 * retry behind it is still running or gave up after one try.
 *
 * **Fix round 3 — the honest claim is "once per OUTAGE", never "once per
 * pass" in the absolute sense, and two costs follow from that, in opposite
 * directions.** First: this bound is only as strong as the process it runs
 * in. A crash-loop that restarts mid-outage starts a fresh `Map`, so the
 * SAME outage re-alerts once per restart — and, as of this round, correctly
 * so: see `lastWhatsAppHealth`'s own docblock on why the alternative (a
 * first observation that stays silent) was the worse, hidden failure round
 * 2 shipped by mistake. Second, parked rather than fixed here: a bridge
 * that genuinely flaps — a new `since` on every single pass, never
 * repeating one this process has already seen — alerts on every pass,
 * unbounded, because each really is a distinct, never-before-seen episode
 * by this function's own honest reading of `since`. That is noise, not
 * silence — the opposite failure from everything else this mechanism
 * guards against — and bounding it needs a minimum interval between
 * alerts, a mechanism this task does not add.
 *
 * **Fix round A, finding 1 — the outgoing MESSAGE was still keyed on the
 * state word alone, even though the health RECORD above has been keyed on
 * the `(since, state)` pair since round 3.** `sendAlert`'s idempotency key
 * (`runtime.ts`) hashes `{ subject, body }`, and `body` carried
 * `current.state` but not `current.since`. Two genuinely distinct outages
 * reporting the same state word therefore produced the identical
 * Message-ID; the receiving server read the second as a duplicate of the
 * first; `sendAlert` returned `{ ok: true }` for a message that never
 * actually reached the owner's inbox a second time; and this function
 * recorded `delivered: true` for an outage nobody was told about. `body`
 * now embeds `since` for exactly this reason. The same fix also corrects a
 * sentence that was never conditioned on `observedConnectedBefore`: "the
 * bridge, which had been connected, disconnected" is true only when this
 * process itself last recorded a `'connected'` episode for this business —
 * false on the very first observation of an already-down bridge (round 3's
 * own addition) and false on a worsening between two already-down states.
 */
async function checkWhatsAppHealth(
  gateway: { health(): Promise<GatewayHealth> },
  notify: Runtime['notify'],
  businessId: string,
  charterVersion: string,
): Promise<void> {
  let current: GatewayHealth;
  try {
    // Raced against `HEALTH_CHECK_TIMEOUT_MS`, not awaited directly — fix
    // round A, finding 3. F6 above already explains why a throw here is
    // swallowed rather than propagated; before this round, nothing made a
    // WEDGED health probe throw at all. `health()` takes no `AbortSignal`,
    // same reason as every other call this project races this way: a
    // signal is advisory, and nothing forces a real GREEN-API client — or a
    // test double — to check it. This call sits inside `schedulerPass`'s
    // one sequential await chain (same as `gateway.pollOnce()` in
    // `whatsapp-door.ts` and `msg.downloadAudio()`/the provider call in
    // `transcribe.ts`); an unbounded await here freezes `expireOverdue` and
    // every due plan for as long as the probe hangs — on the exact call
    // whose entire job is to notice the bridge is unhealthy.
    current = await withHealthCheckDeadline(gateway.health(), HEALTH_CHECK_TIMEOUT_MS);
  } catch {
    // F6 — diagnostic, not a gate. Left exactly as it was; no read, no write.
    return;
  }

  if (current.state === 'connected') {
    // Reconnected (or still connected, including the very first observation
    // ever made for this business). Nothing pending, whether or not an
    // earlier outage's alert ever actually went out.
    lastWhatsAppHealth.set(businessId, {
      since: current.since,
      state: 'connected',
      delivered: true,
      audited: true,
      followedConnected: true, // unused on a 'connected' record itself — see the field's own docblock
    });
    return;
  }

  const record = lastWhatsAppHealth.get(businessId);

  // Fix round 3 — no special case for `record === undefined`. The very
  // first observation ever made for this business, if the bridge is
  // already down, falls straight through to the same "new episode" path
  // below as any other outage — see `lastWhatsAppHealth`'s own docblock on
  // why a silent first observation was the bug, not the feature.
  if (record !== undefined && record.since === current.since && record.state === current.state && record.delivered) {
    // The SAME episode this process has already told the owner about —
    // matched on BOTH `since` and the state word, not either alone (fix
    // round 3; see `WhatsAppHealthRecord`'s own docblock) — and nothing has
    // reconnected since. Nothing new to do.
    return;
  }

  // Either a genuinely new episode — a different `since`, a worsened or
  // otherwise changed state word under an unchanged `since`, or the very
  // first observation of an already-down bridge — or a retry of one that
  // has not yet been delivered.
  const isSameUndeliveredEpisode =
    record !== undefined && record.since === current.since && record.state === current.state; // implies !record.delivered, from the check above
  const alreadyAudited = isSameUndeliveredEpisode && record.audited;

  // Fix round A, finding 1 — decided ONCE, when this `(since, state)` pair
  // is first seen, and carried unchanged through every retry via
  // `record.followedConnected` (see that field's own docblock on why
  // recomputing it from `record.state` on a later call would be wrong: a
  // retry's own earlier write already overwrote `state` with THIS outage's
  // word, not the `'connected'` period it followed). On first sight of a
  // pair, true only when THIS process actually recorded a `'connected'`
  // episode for this business right before it — fix round 3 made the very
  // first observation ever made for a business alert even when the bridge
  // is already down (`lastWhatsAppHealth`'s own docblock); for that case,
  // and for a worsening from one already-down state to another, this
  // process never actually observed a connected period to have dropped
  // FROM — so claiming "the bridge, which had been connected, disconnected"
  // would be a sentence this process cannot back up with anything it saw.
  const followedConnected = isSameUndeliveredEpisode
    ? record.followedConnected
    : record !== undefined && record.state === 'connected';

  // Formatted with second-level precision, not `dateStyle`/`timeStyle`'s
  // usual minute granularity — fix round A's own mutation caught this: two
  // outages a few milliseconds apart (an unlikely but real shape; see
  // `WhatsAppHealthRecord`'s own docblock on why `since` alone, at full
  // precision, is what tells two episodes apart) rounded to the SAME
  // displayed minute, which would have reintroduced the identical-body
  // collision this whole fix exists to close, one layer up from where the
  // first version of it lived.
  const since = new Intl.DateTimeFormat('he-IL', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  }).format(new Date(current.since));
  const subject = followedConnected ? 'התנתק הגשר לוואטסאפ' : 'הגשר לוואטסאפ אינו מחובר';
  const body =
    (followedConnected
      ? `הגשר לוואטסאפ, שהיה מחובר, התנתק`
      : `הגשר לוואטסאפ אינו מחובר`) +
    // `since` is embedded here, not only in `current.state` above, because
    // the outgoing Message-ID is derived from this exact text
    // (`whatsapp-health-alert:${canonicalHash({ subject, body })}` in
    // `runtime.ts`) — fix round A, finding 1. Without it, two genuinely
    // distinct outages that happen to report the SAME state word (two
    // separate `'reconnecting'` episodes, say) hash to the identical key,
    // the mail server treats the second as a duplicate of the first, and
    // the owner never hears about it. A retry of the SAME outage must still
    // produce the identical body — and does, since `since` and `state`
    // together are exactly the pair this episode is keyed on throughout
    // this module (`WhatsAppHealthRecord`'s own docblock).
    ` (מצב נוכחי: ${current.state}, מאז: ${since}). ` +
    `הודעות נכנסות בוואטסאפ לא מתקבלות כרגע, ואי אפשר להשתמש בערוץ הזה עד שהחיבור יחזור.`;

  if (notify?.sendAlert === undefined) {
    if (!alreadyAudited) {
      await recordWhatsAppHealthNotifyFailure(
        businessId,
        charterVersion,
        'no sendAlert configured — SMTP is not set up on this installation. ' +
          'This is the only row for this outage; the next scheduler pass will try again silently.',
      );
    }
    lastWhatsAppHealth.set(businessId, { since: current.since, state: current.state, delivered: false, audited: true, followedConnected });
    return;
  }

  const sent = await notify.sendAlert(subject, body).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (!sent.ok) {
    if (!alreadyAudited) {
      await recordWhatsAppHealthNotifyFailure(
        businessId,
        charterVersion,
        `${sent.error ?? 'sendAlert returned not-ok'}. This is the only row for this outage; ` +
          `the next scheduler pass will try to send again silently.`,
      );
    }
    lastWhatsAppHealth.set(businessId, { since: current.since, state: current.state, delivered: false, audited: true, followedConnected });
    return;
  }

  // Delivered.
  lastWhatsAppHealth.set(businessId, { since: current.since, state: current.state, delivered: true, audited: true, followedConnected });
}

export interface SchedulerPassResult {
  tick: TickResult;
  /** Null when no inbox is configured, or when the scan itself faulted. */
  scan: ScanResult | null;
  /**
   * `scanInbox`'s thrown message, if it threw. Null on a clean scan and null
   * when no inbox is configured at all — those two are not failures.
   */
  scanError: string | null;
  /**
   * Null when no inbox is configured — the same switch that stops the scan
   * stops the understanding loop, and for a stronger reason: this half is the
   * one that costs money. `null` is not `{ considered: 0, ... }`; "the
   * conductor did not run" and "the conductor ran and found nothing" are
   * different facts about an installation, and only the first is a statement
   * about how it is configured.
   */
  conduct: ConductResult | null;
  /**
   * Parents freed this pass — either because their child reached a terminal
   * phase, or because the envelope's own deadline ran out first.
   *
   * Run first, right after the tick and before `runDueJobs`: a child that
   * closed on the PREVIOUS pass wakes its parent at the top of THIS one, so
   * the parent is sitting in `execute` by the time `runDueJobs` looks and
   * runs in this very pass instead of waiting a full interval. Running it
   * after the plans instead would cost every delegation a full extra
   * interval for no reason — the same ordering argument this function's own
   * docblock makes for `runDueJobs` before `closeVerifiedJobs`.
   */
  delegated: ResumeResult;
  /**
   * Null when no WhatsApp gateway is configured (`runtime.whatsapp ===
   * undefined`) — the same "switch, not fault" shape `scan`/`conduct` already
   * carry. Run right after `delegated` and before the conductor loops: an
   * instruction the door plans this pass must reach `execute` before
   * `runDueJobs` looks, or it costs a full scheduler interval — see this
   * function's own docblock.
   */
  whatsappDoor: DoorResult | null;
  due: RunDueResult;
  verified: CloseVerifiedResult;
  /**
   * Null under the same switch as `whatsappDoor` above. Run after
   * `closeVerifiedJobs`, not before: a job the door opened and this very pass
   * ran all the way to `closed` must be reportable in the SAME pass, or the
   * owner waits a full interval to hear the outcome of an instruction he
   * already knows was received.
   */
  whatsappReport: ReportResult | null;
  /**
   * The charter failing to load for the WhatsApp loops, `runWhatsAppDoor`
   * itself throwing (its own docblock: a missing/stale charter, or no
   * principal WhatsApp number), or `reportWhatsAppJobs`' own candidate query
   * rejecting — never a per-message or per-job failure, which
   * `DoorResult`/`ReportResult` already isolate on their own. Null on a
   * clean pass and null when no gateway is configured.
   *
   * **Fix round 1, F2 — non-null does NOT always mean both loops were
   * skipped, and the field cannot be read alone.** Check `whatsappDoor`
   * too: `whatsappDoor === null` means the charter/messenger/door step
   * itself failed and BOTH loops were skipped (`scanError`'s own pattern —
   * a charter this process cannot parse leaves the door with no policy to
   * check a sender against and the report with no number to build a
   * messenger from); `whatsappDoor !== null` means the door ran to
   * completion and only the REPORT'S own candidate query failed afterward.
   * `scheduler-log.ts`'s `logErrored` is the canonical reader that tells
   * the two apart.
   */
  whatsappError: string | null;
  /** Which action classes this round moved up, and which moved down. */
  autonomy: AutonomyPassResult;
  /**
   * `evaluateAutonomy`'s thrown message, if it threw. Null on a clean pass.
   *
   * The same treatment `scanError` gets, and for the same reason. The pass's
   * own `try/catch` isolates ONE class (spec §10); a throw outside that loop
   * — `loadAutonomyMode` on a transient database error — would reject
   * `schedulerPass` itself, and `startScheduler` routes a rejected pass to
   * `onError` INSTEAD of `onResult`. That would suppress the tick, the scan,
   * the plans and the closes that had all already succeeded, because the
   * bookkeeping that runs last after them failed.
   */
  autonomyError: string | null;
}

/**
 * One full pass: tick, then run whatever the tick made ready.
 *
 * Four calls, one after the other, and the order is the whole point — a job
 * woken by the tick is in `execute` by the time `runDueJobs` looks, so it runs
 * in the same pass instead of waiting a full interval.
 *
 * The two document-conductor loops (`scanInbox`, `conductPendingDocuments`)
 * sit between the tick and `runDueJobs`, for the same reason `runDueJobs`
 * itself is called after `tick` has returned and its transaction has
 * committed, never inside it: `tick` holds a transaction-scoped advisory lock
 * for its whole body, and neither a file read nor a model call — bounded only
 * by their own deadlines — has any business holding a pooled connection open
 * across the wire behind that lock.
 *
 * **Both loops are behind the same switch.** `scan` and `conduct` are both
 * `null`, and neither runs, when `config.documentInbox` (or an explicit
 * `options.inbox`) is absent: an installation that has not configured a
 * watched folder is a switch, not a fault, and the pass must neither throw
 * nor pretend a scan happened. `conductPendingDocuments` used to sit outside
 * this guard, which meant an installation that upgraded with an API key
 * present and no `DOCUMENT_INBOX` set began paying to read every `extracted`
 * document already in its database within one interval of launch — spec §10
 * says a missing `DOCUMENT_INBOX` means the conductor does not run, and the
 * half that ran was the half that costs. `DOCUMENT_READS_PER_DAY=0` is a
 * ceiling, not a switch, and must never be the only way to turn this off.
 *
 * A configured inbox that `scanInbox` cannot actually read — the folder is
 * missing, permissions are wrong, a path component is a plain file — is a
 * different thing from an absent one, and the spec's own failure table
 * (§9) says so: recorded, and the scheduler carries on. `scanInbox` genuinely
 * throws on that class of fault (its own docblock only documents one case,
 * a reserved subdirectory name occupied by a file, but any `mkdir`/`readdir`
 * error not caught there propagates the same way), so the call is wrapped
 * here rather than left to reach the caller. Letting it escape would stop
 * `conduct`, `due` and `verified` from running for as long as the path stays
 * broken — every interval, forever — and would crash `run-scheduler.ts`'s
 * unguarded startup call outright. `scanError` carries the message so an
 * operator watching the process log sees it; `scan` stays `null`, the same
 * value an absent inbox produces, because no scan result exists either way.
 *
 * A skipped tick — another scheduler holds the business-wide lock — still
 * runs the rest of the pass. The per-job locks in `runDueJobs` and the
 * conductor's own advisory lock are what actually keep two runners apart, and
 * they are finer-grained than the tick's lock.
 */
export async function schedulerPass(
  options: {
    businessId?: string;
    now?: Date;
    limit?: number;
    runtime?: Runtime;
    /** Defaults to `config.documentInbox`. */
    inbox?: string | null;
    documentRoot?: string;
    readsPerDay?: number;
    reader?: ConductOptions['reader'];
    proposer?: ConductOptions['proposer'];
    /**
     * Replaces `verifyDraft` for the CONDUCTOR's call only — `beginVerification`,
     * which passes `answer: null` and does nothing but open the delegation.
     * That call is deterministic and free, so this seam exists for tests that
     * want to observe or fail it, never to avoid a bill.
     *
     * **Two names, not one, and the split is a control.** Production calls
     * `verifyDraft` in two places, and one shared option reached both: a
     * caller that replaced the function to stub the judge silently disabled
     * `requestHelp` too — no envelope, no parked parent — while
     * `ConductResult.verificationFailed` stayed 0, because a replacement
     * returning a `Verdict` is indistinguishable from success. A green run
     * over a loop that never ran is the exact failure this scheduler's own
     * verification test exists to prevent, so the judging path gets `judge`
     * below and this one keeps a name of its own.
     *
     * `NonNullable`, unlike its `reader`/`proposer` siblings above: this whole
     * options object is spread into `conductPendingDocuments`, and
     * `ConductOptions.verifier` is declared without `| undefined` — so under
     * `exactOptionalPropertyTypes` the indexed type alone will not assign.
     */
    verifier?: NonNullable<ConductOptions['verifier']>;
    /**
     * Replaces only the billed model call inside the JUDGING step
     * (`assert.evaluate` → `VerifyDraftInput.judge`), threaded through
     * `runDueJobs` → `runPlanForJob` → `runLocalTool`. A `Judge` cannot decide
     * not to delegate, which is precisely why this is the seam production
     * exposes and `verifier` above is not. Held out of the conductor's call
     * explicitly below — see `conductOptions`.
     */
    judge?: Judge;
    /** Test seam only; production leaves it unset and `runInstruction` uses the real planner. */
    whatsappPlanner?: RunInstructionOptions['planner'];
    whatsappProvider?: Parameters<typeof runWhatsAppDoor>[0]['provider'];
  } = {},
): Promise<SchedulerPassResult> {
  const businessId = options.businessId ?? config.businessId;
  const tickResult = await tick(options);

  // First after the tick, and the order matters: a child that closed on the
  // previous pass wakes its parent at the top of this one, so the parent runs
  // in this very pass through `runDueJobs` below. Run it after the plans
  // instead and every delegation would cost a full extra interval.
  const delegated = await resumeDelegatedJobs(options);

  // Built once per pass and reused everywhere below — `due` and the
  // conductor loops need it too, and a second `buildRuntime()` call here
  // would both waste the work and risk two registries disagreeing.
  const runtime = options.runtime ?? (await buildRuntime());

  // The door, right after `resumeDelegatedJobs` and before the conductor
  // loops — see `SchedulerPassResult.whatsappDoor`'s own docblock. Guarded on
  // `runtime.whatsapp !== undefined`: no GREEN-API gateway configured is a
  // switch, the same shape `scan`/`conduct` already carry below, not a fault.
  //
  // **The charter is loaded here, once, and the messenger is built from it
  // here, once — never inside `buildRuntime`.** `principalWhatsAppKey` reads
  // the SIGNED charter, which an owner can change by signing an amendment;
  // building the messenger at process start (inside `buildRuntime`) would pin
  // a recipient for the life of the process, so after the owner changes his
  // number the assistant would keep messaging the old one — which by then may
  // belong to someone who is not the principal at all. `createBossMessenger`
  // does no I/O at construction, so doing this every pass costs nothing.
  //
  // A charter that will not load (missing, or a stale schema —
  // `loadActiveCharter`'s own docblock) skips BOTH the door and the report
  // this pass, never the pass itself: `whatsappError` carries why, the same
  // `scanError` treatment a broken document inbox already gets, for the same
  // reason — an escaping throw here would suppress the tick, the plans and
  // the closes that had all already succeeded. `runWhatsAppDoor` itself can
  // also throw for the identical reason (its own docblock: no active charter,
  // or no principal number), so the whole block below shares one `try`.
  let whatsappDoor: DoorResult | null = null;
  let whatsappReport: ReportResult | null = null;
  let whatsappError: string | null = null;
  let whatsappMessenger: BossMessenger | null = null;
  if (runtime.whatsapp !== undefined) {
    try {
      const active = await loadActiveCharter(businessId);
      if (active === null) {
        throw new Error(
          `schedulerPass: no active charter for business ${businessId} — refusing to run the WhatsApp loops`,
        );
      }
      const principal = principalWhatsAppKey(active.charter);
      if (principal === null) {
        throw new Error(
          `schedulerPass: charter has no principal WhatsApp number for business ${businessId} — refusing to run the WhatsApp loops`,
        );
      }
      whatsappMessenger = createBossMessenger({
        gateway: runtime.whatsapp.gateway,
        contactId: principal,
        businessId,
      });

      // §7.4 — once per outage, not once per pass for a sustained one; see
      // `checkWhatsAppHealth`'s own docblock for what that bound does and
      // does not promise.
      await checkWhatsAppHealth(
        runtime.whatsapp.gateway,
        runtime.notify,
        businessId,
        active.charter.charterVersion,
      );

      whatsappDoor = await runWhatsAppDoor({
        gateway: runtime.whatsapp.gateway,
        messenger: whatsappMessenger,
        businessId,
        // Fix round 1, F11 — the SAME charter load this block already did
        // for the messenger's number, handed to the door so it checks the
        // sender against it rather than loading a second, independently
        // timed copy. Without this, an amendment signed between the two
        // loads leaves a pass whose door authorises the NEW number while
        // the messenger replies with the OLD one — the exact one-pass
        // window Override B exists to close, one level deeper than Override
        // B itself reaches alone.
        charter: active.charter,
        ...(options.whatsappProvider !== undefined ? { provider: options.whatsappProvider } : {}),
        ...(options.whatsappPlanner !== undefined ? { planner: options.whatsappPlanner } : {}),
      });
    } catch (err) {
      whatsappError = err instanceof Error ? err.message : String(err);
      whatsappMessenger = null;
    }
  }

  // Both conductor loops run after the tick's transaction has committed, not
  // inside it — see the docblock above.
  //
  // `judge` is destructured OUT rather than left to ride the spread. It is not
  // a `ConductOptions` field, so nothing would break today — but the whole
  // point of splitting the two seams (see `verifier`'s and `judge`'s own
  // docblocks) is that the conductor's `verifyDraft` call and the judging one
  // are reached by different names, and a `...options` that quietly carried
  // both would make that separation a matter of what `ConductOptions` happens
  // to declare rather than a statement this function makes.
  const { judge, ...conductOptions } = options;
  const inbox = options.inbox !== undefined ? options.inbox : config.documentInbox;
  let scan: ScanResult | null = null;
  let scanError: string | null = null;
  let conduct: ConductResult | null = null;
  if (inbox !== null) {
    try {
      scan = await scanInbox({
        inbox,
        ...(options.businessId !== undefined ? { businessId: options.businessId } : {}),
        ...(options.documentRoot !== undefined ? { documentRoot: options.documentRoot } : {}),
      });
    } catch (err) {
      // A broken inbox must not stop the rest of the pass. `scan` stays
      // `null` and `conduct`/`due`/`verified` still run below. Note the
      // asymmetry with an *absent* inbox: a folder that is configured but
      // unreadable is still a configured installation, so the understanding
      // loop below still runs against whatever is already in the database —
      // documents ingested on earlier passes do not stop deserving a reading
      // because today's `readdir` failed.
      scanError = err instanceof Error ? err.message : String(err);
    }

    conduct = await conductPendingDocuments({
      ...conductOptions,
      // The conductor writes approvals without passing through the gate, and
      // the gate was carrying the notification. Threaded here so a conductor
      // card reaches the owner's mailbox exactly as a gate-raised one does.
      ...(runtime.notify !== undefined ? { notify: runtime.notify } : {}),
    });
  }

  // `...options` here, not `conductOptions`: this is the path `judge` belongs
  // on. `verifier` rides along and is ignored — `runDueJobs` declares no such
  // field, and the judging step reads `judge` alone.
  const due = await runDueJobs({ ...options, runtime });
  // Last, and the order matters as much as the rest: a job `runDueJobs` just
  // finished is sitting in `verify` by the time this looks, so it closes in
  // the same pass instead of waiting a full interval. Run before the plans
  // instead and every close would trail a pass behind the work that earned
  // it.
  const verified = await closeVerifiedJobs(options);

  // The report, right after `closeVerifiedJobs` — see
  // `SchedulerPassResult.whatsappReport`'s own docblock. Guarded on
  // `whatsappMessenger !== null`: that is `null` both when no gateway is
  // configured and when the charter failed to load above, so a charter this
  // process cannot parse skips this loop too, never only the door.
  if (runtime.whatsapp !== undefined && whatsappMessenger !== null) {
    try {
      whatsappReport = await reportWhatsAppJobs({
        messenger: whatsappMessenger,
        businessId,
        ...(runtime.notify !== undefined
          ? { dashboardBaseUrl: runtime.notify.dashboardBaseUrl }
          : {}),
      });
    } catch (err) {
      whatsappError = err instanceof Error ? err.message : String(err);
    }
  }

  // Last, and for the same reason `closeVerifiedJobs` runs after the plans:
  // this pass reads what this very round produced — an approval just decided,
  // a job just failed. Run it earlier and every evaluation trails a pass
  // behind the evidence that justifies it (spec §10).
  //
  // Guarded rather than awaited bare: see `autonomyError`. Everything above
  // has already happened by the time this runs, and a bookkeeping pass that
  // failed must not hide the work that succeeded.
  let autonomy: AutonomyPassResult = { promoted: [], demoted: [], errored: [] };
  let autonomyError: string | null = null;
  try {
    autonomy = await evaluateAutonomy(options);
  } catch (err) {
    autonomyError = err instanceof Error ? err.message : String(err);
  }
  return {
    tick: tickResult,
    scan,
    scanError,
    conduct,
    delegated,
    whatsappDoor,
    due,
    verified,
    whatsappReport,
    whatsappError,
    autonomy,
    autonomyError,
  };
}

export interface SchedulerHandle {
  /** Resolves once the loop has stopped and any in-flight tick has finished. */
  stop: () => Promise<void>;
}

/**
 * Run `schedulerPass` on an interval until stopped.
 *
 * Polling Postgres rather than pg-boss. The roadmap names pg-boss and it is
 * the right answer for throughput, but the work here is a handful of rows a
 * minute, and a dependency that owns the job lifecycle is not something to
 * take on before the lifecycle it has to own is finished.
 *
 * Ticks never overlap: the in-flight guard means a slow pass delays the next
 * one instead of running two at once.
 */
export function startScheduler(
  options: {
    businessId?: string;
    intervalMs?: number;
    runtime?: Runtime;
    /**
     * Called after every pass that completed without throwing — including a
     * pass whose `due.errored` is non-empty. `runDueJobs` isolates a per-job
     * failure into `errored` rather than throwing (see its own docblock), so
     * a stuck job never reaches `onError`; this is the only hook that sees it.
     */
    onResult?: (result: SchedulerPassResult) => void;
    onError?: (error: unknown) => void;
  } = {},
): SchedulerHandle {
  const intervalMs = options.intervalMs ?? 30_000;
  let running = false;
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    const businessId = options.businessId;
    const runtime = options.runtime;
    inFlight = schedulerPass({
      ...(businessId === undefined ? {} : { businessId }),
      ...(runtime === undefined ? {} : { runtime }),
    })
      .then((result) => {
        options.onResult?.(result);
      })
      .catch((error) => {
        // A failing pass must not kill the loop — the next one may well
        // succeed, and a scheduler that dies quietly is worse than one that
        // retries.
        options.onError?.(error);
      });
    try {
      await inFlight;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), intervalMs);
  // Do not hold the process open on this timer alone.
  timer.unref?.();
  void run();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
