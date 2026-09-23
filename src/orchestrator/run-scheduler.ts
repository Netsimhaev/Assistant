/**
 * The scheduler as a process.
 *
 * Nothing in the system wakes a deferred job, expires an unanswered approval,
 * or runs a plan that is ready to go unless this is running: each pass calls
 * `schedulerPass`, which ticks (waking due jobs, expiring overdue approvals)
 * and then runs every job that pass left sitting in `execute`. It is
 * deliberately dull: one pass on a timer, a signal handler, and a log line
 * per pass that found something worth telling an operator about.
 *
 *   npm run scheduler
 */
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { schedulerPass, startScheduler } from './scheduler.js';
import type { SchedulerPassResult } from './scheduler.js';
import { buildRuntime } from './runtime.js';

const intervalMs = Number(process.env['SCHEDULER_INTERVAL_MS'] ?? 30_000);

console.log(
  `scheduler starting for ${config.businessId}, every ${Math.round(intervalMs / 1000)}s`,
);

const runtime = await buildRuntime();
for (const warning of runtime.warnings) console.warn(`warning: ${warning}`);

// A job stuck in `execute` — one `runDueJobs` threw on, one with no plan
// bound, one permanently rejected (`no_active_charter`, `job_not_executable`,
// a malformed plan, …), or one whose phase moved out from under the lock —
// never reaches `onError`; `runDueJobs` isolates every one of these into its
// own bucket on `RunDueResult` instead (see that interface's docblock). Under
// `ORDER BY updated_at ASC` a job that cannot advance sorts first on every
// pass, so with enough such jobs the `LIMIT 20` window fills up and no other
// job of that business runs at all. `errored` alone reported none of this:
// `unbound` and a rejected `ran` entry were silent forever, and `phaseMoved`
// was silent for the one pass it happened on. Surfacing all four is what this
// function does.
//
// One of the four no longer starves the window: an unbound job is now moved
// to `failed` by `runDueJobs` itself before it reaches this bucket (I2, see
// `RunDueResult.unbound`), so it is reported once and then gone. The other
// three still sit where they were — a permanently rejected `ran` entry and a
// job `runDueJobs` threw on both keep their frozen `updated_at`, and deciding
// a terminal disposition for those (an attempt counter, a dead-letter phase)
// is still a policy call for its own change.
function logErrored(result: SchedulerPassResult): void {
  // A folder that is missing, unreadable, or blocked by a plain file where a
  // directory belongs (see `scheduler.ts`'s docblock above `schedulerPass`)
  // is recorded here, once per pass for as long as it persists — never
  // thrown, because a broken inbox must not stop the approvals and plans
  // below it from running.
  if (result.scanError !== null) {
    console.error(`document inbox scan failed: ${result.scanError}`);
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

// One pass before the loop, so a misconfiguration surfaces immediately rather
// than at the first interval.
const first = await schedulerPass({ runtime });
if (first.tick.skipped) {
  console.log('another scheduler holds the lock; this one will keep polling');
}
logErrored(first);

const handle = startScheduler({
  businessId: config.businessId,
  intervalMs,
  runtime,
  onResult: logErrored,
  onError: (error) => {
    console.error('scheduler pass failed:', error instanceof Error ? error.message : error);
  },
});

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — finishing the current tick, then stopping`);
  await handle.stop();
  await closePool();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
