/**
 * The scheduler as a process.
 *
 * Nothing in the system wakes a deferred job or expires an unanswered approval
 * unless this is running. It is deliberately dull: one tick on a timer, a
 * signal handler, and a log line per tick that did something.
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

// A job whose stored plan no longer parses (or any other per-job failure
// `runDueJobs` isolates) lands in `due.errored`, not in a thrown error — it
// never reaches `onError`. An operator has to learn a job is stuck some way,
// and silence here is exactly the failure mode `errored` exists to end.
function logErrored(result: SchedulerPassResult): void {
  for (const job of result.due.errored) {
    console.error(`job ${job.jobId} errored: ${job.error}`);
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
