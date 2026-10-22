/**
 * What `run-scheduler.ts` prints after every pass.
 *
 * Pulled into its own module (Task 10 fix round 1, F4) so it can be imported
 * by a test without importing `run-scheduler.ts` itself — that file runs
 * side-effecting top-level code the moment it is loaded (`buildRuntime()`,
 * a first `schedulerPass()`, `startScheduler()`, `process.on`), which a unit
 * test on `logErrored` alone must not trigger. `run-scheduler.ts` imports
 * this and calls it; nothing else changes about how or when it runs.
 */
import type { SchedulerPassResult } from './scheduler.js';

/**
 * A job stuck in `execute` — one `runDueJobs` threw on, one with no plan
 * bound, one permanently rejected (`no_active_charter`, `job_not_executable`,
 * a malformed plan, …), or one whose phase moved out from under the lock —
 * never reaches `onError`; `runDueJobs` isolates every one of these into its
 * own bucket on `RunDueResult` instead (see that interface's docblock). Under
 * `ORDER BY updated_at ASC` a job that cannot advance sorts first on every
 * pass, so with enough such jobs the `LIMIT 20` window fills up and no other
 * job of that business runs at all. `errored` alone reported none of this:
 * `unbound` and a rejected `ran` entry were silent forever, and `phaseMoved`
 * was silent for the one pass it happened on. Surfacing all four is what this
 * function does.
 *
 * One of the four no longer starves the window: an unbound job is now moved
 * to `failed` by `runDueJobs` itself before it reaches this bucket (I2, see
 * `RunDueResult.unbound`), so it is reported once and then gone. The other
 * three still sit where they were — a permanently rejected `ran` entry and a
 * job `runDueJobs` threw on both keep their frozen `updated_at`, and deciding
 * a terminal disposition for those (an attempt counter, a dead-letter phase)
 * is still a policy call for its own change.
 */
export function logErrored(result: SchedulerPassResult): void {
  // A folder that is missing, unreadable, or blocked by a plain file where a
  // directory belongs (see `scheduler.ts`'s docblock above `schedulerPass`)
  // is recorded here, once per pass for as long as it persists — never
  // thrown, because a broken inbox must not stop the approvals and plans
  // below it from running.
  if (result.scanError !== null) {
    console.error(`document inbox scan failed: ${result.scanError}`);
  }
  // The mailbox poll: a thrown pass, or a provider failure the poll itself
  // reported. `mail === null` is "no mailbox connected", not a failure.
  if (result.mailError !== null) {
    console.error(`mailbox poll failed: ${result.mailError}`);
  }
  if (result.mail !== null && result.mail.status !== 'ok') {
    console.error(`mailbox poll: ${result.mail.status}${result.mail.error !== undefined ? ` (${result.mail.error})` : ''}`);
  }
  // `ConductResult.verificationFailed` (fix round 1's Important 3) is exactly
  // this file's own rule applied to a bucket that, until now, had no printer
  // at all: "visible, unlike a bare swallow" was true only to a test.
  // `conduct` is `null` when no document inbox is configured, in which case
  // there is nothing to have failed.
  if (result.conduct !== null && result.conduct.verificationFailed > 0) {
    // Fix round 3, item 4(b): "see the audit trail" over-promised. A job that
    // reached `execute` before failing carries its own reason on the
    // transition that closed it (`beginVerification`'s own `reason:` string).
    // A job that never got that far — `createJob` itself threw — leaves no
    // job row at all, so there is no trail to point at; this count is the
    // only trace such a failure leaves.
    console.error(
      `${result.conduct.verificationFailed} card(s) this pass had gov.verify fail to open — ` +
        `a job that reached execute records why on its own failed transition; a failure inside ` +
        `createJob itself leaves no job to look up, and this count is the only trace of it`,
    );
  }
  // Delegation resumption's own buckets, same rule: a parent moved to
  // `failed` over corrupted bookkeeping (`resume-delegated.ts`'s
  // `failCorruptedParent`) or a parent freed only because its envelope's
  // deadline ran out are both facts an operator needs to see, not just a
  // count nobody reads.
  for (const parent of result.delegated.errored) {
    console.error(`delegation parent ${parent.jobId} errored: ${parent.error}`);
  }
  for (const jobId of result.delegated.timedOut) {
    console.error(`delegation parent ${jobId} woke on its envelope's deadline — its child never answered`);
  }
  for (const job of result.due.errored) {
    console.error(`job ${job.jobId} errored: ${job.error}`);
  }
  for (const jobId of result.due.unbound) {
    console.error(`job ${jobId} was in execute with no plan bound; moved to failed`);
  }
  for (const job of result.due.ran) {
    if (job.status === 'rejected') {
      console.error(`job ${job.jobId} rejected: ${job.detail ?? '(no detail)'}`);
    }
  }
  for (const jobId of result.due.phaseMoved) {
    console.error(`job ${jobId} moved out of execute between the scan and the lock`);
  }
  // The close pass has its own buckets, and the same rule applies to them:
  // one nobody prints is one that does not exist. A job stopped short of
  // `closed` is the only kind an operator can act on — a clean close is not
  // news, so `verified.closed` is deliberately silent.
  for (const job of result.verified.failed) {
    console.error(`job ${job.jobId} stopped before closing: ${job.detail}`);
  }
  for (const jobId of result.verified.unbound) {
    console.error(`job ${jobId} is in verify with no plan bound`);
  }
  for (const job of result.verified.errored) {
    console.error(`job ${job.jobId} errored while closing: ${job.error}`);
  }
  // Fix round 1, F2 — the text must say what actually happened, not just
  // "both loops skipped". `reportWhatsAppJobs` isolates per-candidate
  // failures into `ReportResult.errored` (below), but `reportCandidates`'
  // own `db.query` sits outside that loop and can itself reject — in which
  // case the door already ran to completion (`whatsappDoor` is non-null) and
  // only the report failed. The two cases are told apart on `whatsappDoor`,
  // the same signal `schedulerPass`'s own `whatsappMessenger` guard uses to
  // decide whether the report block even runs.
  if (result.whatsappError !== null) {
    if (result.whatsappDoor === null) {
      console.error(`WhatsApp loops skipped this pass: ${result.whatsappError}`);
    } else {
      console.error(`WhatsApp report failed after the door ran this pass: ${result.whatsappError}`);
    }
  }
  // Fix round B, finding 3 — `DoorResult.malformedSenderCount`'s own
  // docblock on why this is counted apart from `recordedOnly`: a
  // `senderNumber` the gateway handed up in a shape `authorityNumberKey`
  // cannot parse is a GATEWAY CONTRACT VIOLATION, not a stranger, and round
  // A's own finding (the wrong "bare international form" ledger
  // instruction) is exactly the drift this line exists to surface the
  // moment it happens, rather than on the day the owner wonders why he
  // never hears back.
  if (result.whatsappDoor !== null && result.whatsappDoor.malformedSenderCount > 0) {
    console.error(
      `${result.whatsappDoor.malformedSenderCount} WhatsApp message(s) this pass arrived with a ` +
        `senderNumber the gateway contract does not allow — check the gateway, not the sender`,
    );
  }
  // Task 8's own report-round ruling: counting `deferred` is what stops a job
  // permanently stuck on a crashed resume from becoming invisible silence —
  // but that justification is only true once something actually reads the
  // counter, which until this file printed it, nothing did. A single pass
  // with a few deferred candidates is routine (a decided-not-yet-resumed
  // race, resolved by the next pass); a count that keeps climbing pass after
  // pass is the pathological case this line exists to surface.
  if (result.whatsappReport !== null && result.whatsappReport.deferred > 0) {
    console.log(`${result.whatsappReport.deferred} WhatsApp-opened job(s) deferred this pass`);
  }
  if (result.whatsappReport !== null && result.whatsappReport.errored.length > 0) {
    for (const jobId of result.whatsappReport.errored) {
      console.error(`WhatsApp report for job ${jobId} errored — its own record could not be read`);
    }
  }
  // Same rule one pass further along. A class whose evaluation threw would
  // otherwise look exactly like a class with nothing due — it would simply
  // never promote, every pass, and say nothing. A move itself is not an
  // error, but it is a change to what the assistant may do unasked, so it is
  // worth a line an operator sees.
  if (result.autonomyError !== null) {
    console.error(`autonomy evaluation failed: ${result.autonomyError}`);
  }
  for (const actionClass of result.autonomy.errored) {
    console.error(`autonomy evaluation failed for ${actionClass}`);
  }
  for (const actionClass of result.autonomy.promoted) {
    console.log(`autonomy raised for ${actionClass}`);
  }
  for (const actionClass of result.autonomy.demoted) {
    console.log(`autonomy lowered for ${actionClass}`);
  }
  // Fix round 1, item 2 — the most serious gap this round found. `digest` is
  // `null` when the schedule is off, in which case there is nothing to have
  // failed; it is non-null and carries its OWN `errored` (not a sibling
  // top-level field, because `runDigests` fails per-kind-loop, not per-pass)
  // whenever `loadActiveCharter` threw inside it. Before this branch, an
  // installation with the digest switched on and a charter that cannot be
  // parsed failed on EVERY pass, forever, printing nothing — `run-scheduler.ts`
  // wires `logErrored` as the only reporting path in production, so a bucket
  // with no printer here is invisible there too. Same class of silent failure
  // the WhatsApp branch already closed twice (a duplicate-keyed alert the
  // mail server swallowed; a bridge warning indistinguishable from "nothing
  // to send") — this is the identical shape one module over.
  if (result.digest !== null && result.digest.errored !== null) {
    console.error(`digest failed: ${result.digest.errored}`);
  }
}
