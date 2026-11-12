/**
 * The scheduler as a process.
 *
 * Nothing in the system wakes a deferred job, expires an unanswered approval,
 * or runs a plan that is ready to go unless this is running: each interval
 * calls `runAllBusinesses`, which runs `schedulerPass` for every active
 * business on this server, each with its own runtime, deadline and catch, and
 * each stage of a pass on a connection of its own (spec §5.3). Each pass ticks
 * (waking due jobs, expiring overdue approvals) and then runs every job that
 * pass left sitting in `execute`. It is deliberately dull: one interval on a
 * timer, a signal handler, a summary line (`N businesses, ran X, failed Y,
 * skipped Z`) for every interval where something failed or the business count
 * changed, and a line per pass that found something worth telling an operator
 * about. Business ids and counts only — never a business's content.
 *
 *   npm run scheduler
 */
import { positiveInt } from '../config.js';
import { closePool } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { startScheduler } from './scheduler.js';
import { logErrored, logTenantPass } from './scheduler-log.js';
import { buildServerRuntime } from './runtime.js';
import {
  SCHEDULER_BUSINESS_DEADLINE_MS,
  SCHEDULER_INTERVAL_MS,
  runAllBusinesses,
  type TenantLoopState,
} from './tenants.js';

// Validated, never `Number(...)` raw: a typo would become NaN, and a NaN
// timer fires after ~1ms — every business would "miss its deadline" at once.
// Zero is refused too: neither an interval nor a deadline of 0 means anything.
function positiveMs(name: string, fallback: number): number {
  const value = positiveInt(name, fallback);
  if (value === 0) throw new Error(`${name} must be a positive integer (got: 0)`);
  return value;
}
const intervalMs = positiveMs('SCHEDULER_INTERVAL_MS', SCHEDULER_INTERVAL_MS);
const perBusinessDeadlineMs = positiveMs('SCHEDULER_BUSINESS_DEADLINE_MS', SCHEDULER_BUSINESS_DEADLINE_MS);

console.log(
  `scheduler starting, every ${Math.round(intervalMs / 1000)}s, ` +
    `${Math.round(perBusinessDeadlineMs / 1000)}s per business`,
);

// The server half once per process; the business half is rebuilt from each
// business's own settings on every pass (`businessRuntime`, in the loop).
const server = await buildServerRuntime();
for (const warning of server.warnings) console.warn(`warning: ${warning}`);

// Kept across intervals: who still has a pass in the air, and where the
// previous interval stopped when its budget ran out.
const state: TenantLoopState = { inFlight: new Set(), resumeFrom: null };

// The business count at the last interval: the summary line is printed only
// when something went wrong or that count changed (`tenantPassIsNotable`).
let lastTotal: number | null = null;

// A business's own warnings (a missing mail setting, say) are printed the
// first time they are seen, not on every pass.
const warned = new Set<string>();

const handle = startScheduler({
  intervalMs,
  pass: () =>
    runAllBusinesses(server, {
      perBusinessDeadlineMs,
      state,
      budgetMs: intervalMs,
      onPass: (businessId, result, warnings) => {
        for (const warning of warnings) {
          const key = `${businessId}\u0000${warning}`;
          if (warned.has(key)) continue;
          warned.add(key);
          console.warn(`[${businessId}] warning: ${warning}`);
        }
        if (result.tick.skipped) {
          console.log(`[${businessId}] another scheduler holds the lock; this one will keep polling`);
        }
        logErrored(result, businessId);
      },
    }),
  onResult: (report) => {
    lastTotal = logTenantPass(report, lastTotal);
  },
  onError: (error) => {
    console.error('scheduler interval failed:', error instanceof Error ? error.message : error);
  },
});

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — finishing the current interval, then stopping`);
  await handle.stop();
  await closePool();
  await closePlatformPool();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
