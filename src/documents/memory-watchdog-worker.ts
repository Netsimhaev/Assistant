/**
 * The memory watchdog thread `child-hardening.ts` starts inside the
 * extraction child. `process.memoryUsage.rss()` is the resident set of the
 * whole process, not of this thread, so it sees what the main thread's
 * parser allocates — including off-heap buffers.
 *
 * Over the cap it writes the marker to stderr with a synchronous write (the
 * kill below gives an asynchronous one no chance to flush) and then kills
 * the process it lives in. `process.exit` here would end only this thread,
 * and `process.abort` is not available in a worker.
 */

import { writeSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const { capBytes, intervalMs, marker } = workerData as {
  capBytes: number;
  intervalMs: number;
  marker: string;
};

function check(): void {
  if (process.memoryUsage.rss() <= capBytes) return;
  try {
    writeSync(2, `\n${marker}\n`);
  } finally {
    process.kill(process.pid, 'SIGKILL');
  }
}

check();
setInterval(check, intervalMs);
parentPort?.postMessage('ready');
