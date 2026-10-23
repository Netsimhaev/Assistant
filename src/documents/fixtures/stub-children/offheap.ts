/**
 * Test-only stub child for `run-extractor.test.ts`. Starts the same memory
 * watchdog the real child starts (`child-hardening.ts`), with the RSS cap
 * `runExtractor` passed as the third argument, then allocates filled
 * `Buffer`s in a synchronous loop. Buffers live outside the V8 heap, so the
 * `--max-old-space-size` cap never sees them — the shape of a decompression
 * bomb. The loop never yields: only the watchdog's own thread can stop it.
 *
 * Never wired into `extract-child.ts` — see `hang.ts` in this directory for
 * why a stub like this stays test-only.
 */
import { startMemoryWatchdog } from '../../child-hardening.js';

await startMemoryWatchdog(Number(process.argv[4]) * 1024 * 1024);
const kept: Buffer[] = [];
for (;;) {
  kept.push(Buffer.alloc(1024 * 1024, 1));
}
