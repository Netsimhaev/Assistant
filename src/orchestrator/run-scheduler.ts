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
import { startScheduler, tick } from './scheduler.js';

const intervalMs = Number(process.env['SCHEDULER_INTERVAL_MS'] ?? 30_000);

console.log(
  `scheduler starting for ${config.businessId}, every ${Math.round(intervalMs / 1000)}s`,
);

// One tick before the loop, so a misconfiguration surfaces immediately rather
// than at the first interval.
const first = await tick();
if (first.skipped) {
  console.log('another scheduler holds the lock; this one will keep polling');
}

const handle = startScheduler({
  businessId: config.businessId,
  intervalMs,
  onError: (error) => {
    console.error('tick failed:', error instanceof Error ? error.message : error);
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
