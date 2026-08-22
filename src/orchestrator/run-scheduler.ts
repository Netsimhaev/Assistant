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

const runtime = buildRuntime();
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
// was silent for the one pass it happened on. Surfacing all four is the only
// fix in scope here — deciding a terminal disposition for a job stuck this
// way (moving it to `failed`, adding an attempt counter) is a policy call for
// its own change.
function logErrored(result: SchedulerPassResult): void {
  for (const job of result.due.errored) {
    console.error(`job ${job.jobId} errored: ${job.error}`);
  }
  for (const jobId of result.due.unbound) {
    console.error(`job ${jobId} is in execute with no plan bound`);
  }
  for (const job of result.due.ran) {
    if (job.status === 'rejected') {
      console.error(`job ${job.jobId} rejected: ${job.detail ?? '(no detail)'}`);
    }
  }
  for (const jobId of result.due.phaseMoved) {
    console.error(`job ${jobId} moved out of execute between the scan and the lock`);
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
