/**
 * What the isolated extraction child (`extract-child.ts`) does to itself
 * before it parses a byte. Each of these is a second layer under a control
 * the parent (`run-extractor.ts`) already holds, or the only layer where the
 * parent cannot reach. In its own module so a stub child can install exactly
 * the same thing and a test can prove it works, instead of trusting that the
 * real child calls it.
 */

import { registerHooks } from 'node:module';
import { format } from 'node:util';
import { Worker } from 'node:worker_threads';

/**
 * Written to stderr by the memory watchdog just before it kills the
 * process. `run-extractor.ts` reads it to tell "killed for memory" apart
 * from an ordinary crash: on Windows a self-inflicted SIGKILL exits with
 * code 1, the same code a controlled failure uses. A file that somehow got
 * this string onto stderr could only change which rejection reason is
 * recorded — `runExtractor` consults it only for a child that did not exit
 * cleanly.
 */
export const MEMORY_CAP_MARKER = '[extract-child] memory cap exceeded';

/**
 * Stdout carries exactly one thing: the JSON object the child writes. A
 * parsing library that logs through `console.log` (pdf.js's deprecation
 * notices and its Emscripten modules both do) would otherwise splice text
 * into that object, and the parent would read a well-behaved file as a
 * crashed child. Every `console` method a library might reach for is
 * pointed at stderr, which the parent treats as diagnostics only.
 */
export function routeConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${format(...args)}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}

const NATIVE_CANVAS = /^@napi-rs\/canvas(?:$|[-/])/;

/**
 * pdf.js, on import under Node, `require`s the optional native package
 * `@napi-rs/canvas` to polyfill `DOMMatrix`/`Path2D` for rendering. This
 * child never renders, and a native addon loaded into the process that
 * parses an untrusted file is attack surface with no use. A synchronous
 * resolve hook refuses the package (and its per-platform binary packages);
 * pdf.js catches the failure, warns on stderr, and text extraction carries
 * on without it — `pdf.test.ts` proves both halves.
 */
export function blockNativeCanvas(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (NATIVE_CANVAS.test(specifier)) {
        throw new Error(`native module ${specifier} is refused in the extraction child`);
      }
      return nextResolve(specifier, context);
    },
  });
}

const WATCHDOG_INTERVAL_MS = 50;

/**
 * Starts a thread that samples the whole process's resident set
 * (`process.memoryUsage.rss()`, which counts `Buffer`s and `ArrayBuffer`s the
 * V8 heap cap never sees) every 50ms, and kills the process the moment it
 * crosses `capBytes`. A thread and not a timer on the main thread, because
 * the thing it guards against is synchronous: a decompression bomb inflates
 * inside one parser call that never yields to the event loop.
 *
 * Resolves only after the first sample, so no parsing starts unguarded. A
 * watchdog that cannot start rejects, and the child fails closed.
 */
export function startMemoryWatchdog(capBytes: number): Promise<void> {
  if (!Number.isFinite(capBytes) || capBytes <= 0) {
    return Promise.reject(new Error(`memory watchdog needs a positive cap, got ${capBytes}`));
  }
  // Same extension as this module: `.ts` under tsx, `.js` from `dist/` —
  // the rule `run-extractor.ts`'s `defaultChildPath` explains.
  const extension = import.meta.url.slice(import.meta.url.lastIndexOf('.'));
  const worker = new Worker(new URL(`./memory-watchdog-worker${extension}`, import.meta.url), {
    workerData: { capBytes, intervalMs: WATCHDOG_INTERVAL_MS, marker: MEMORY_CAP_MARKER },
  });
  return new Promise<void>((resolve, reject) => {
    worker.once('message', () => {
      // The watchdog must never be what keeps a finished child alive.
      worker.unref();
      resolve();
    });
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`memory watchdog exited early (${code})`)));
  });
}
