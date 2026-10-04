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
}
