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
import { logErrored } from './scheduler-log.js';
import { buildRuntime } from './runtime.js';

const intervalMs = Number(process.env['SCHEDULER_INTERVAL_MS'] ?? 30_000);

console.log(
  `scheduler starting for ${config.businessId}, every ${Math.round(intervalMs / 1000)}s`,
);

const runtime = await buildRuntime();
for (const warning of runtime.warnings) console.warn(`warning: ${warning}`);

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
