/**
 * The isolation boundary (spec §3.4). Every file the business did not write
 * is parsed by a short-lived child process, never inline — a hostile file
 * gets a process killed, not the assistant.
 *
 * The parent enforces every limit; the child (`extract-child.ts`) is never
 * trusted to stop itself:
 *   - memory, in three layers. A V8 heap-cap flag on the child's command
 *     line (`memoryMb`) bounds the JavaScript heap — and only that heap:
 *     `Buffer`s and `ArrayBuffer`s live outside it, and a 1.5MB PDF whose
 *     FlateDecode stream inflates to 1.5GB drove a child to a 3.3GB working
 *     set under the 256MB flag. So the resident set of the whole process is
 *     capped too (`rssCapMb`, default twice the heap cap: 512MB — the heap
 *     plus room for Node, tsx and the parser's own off-heap buffers). On
 *     Linux, where it costs one file read, the parent samples
 *     `/proc/<pid>/status` every 100ms and SIGKILLs over the cap. On every
 *     platform the child runs a watchdog thread (`child-hardening.ts`) that
 *     samples its own RSS every 50ms and kills itself over the cap, leaving
 *     `MEMORY_CAP_MARKER` on stderr. Either way the outcome is
 *     `extractor_memory`. The in-child layer is the one that holds on
 *     Windows and macOS; a parser that could stop that thread could still
 *     outrun it, which is why Linux, the production platform, has the
 *     parent's layer as well.
 *   - time: a timer here that sends SIGKILL, not SIGTERM — a wedged parser
 *     does not handle signals
 *   - output: a byte counter on the stdout stream that kills once the cap
 *     is crossed, checked as bytes arrive rather than after the whole
 *     stream has been buffered (that buffering would itself be the
 *     resource exhaustion this exists to prevent)
 *   - code generation: the child runs with
 *     `--disallow-code-generation-from-strings`, so `eval` and
 *     `new Function` throw inside it whatever a parsing library (or a file
 *     steering one) attempts — the control `extractors/pdf.ts` relies on
 *     for "no script ever runs"
 *   - environment: the child receives `PATH` and nothing else — the same
 *     rule `src/sdk/know-reader.ts` already applies to the quarantine
 *     agent's own subprocess, so the database URL and any API key never
 *     reach a process parsing an untrusted file
 *
 * Every one of the five `ExtractOutcome` failure codes is a returned value,
 * never a thrown error — the same rule `archive-guard.ts` follows: a
 * hostile file must not stop ingestion of the valid ones behind it.
 *
 * The child is TypeScript with `.js`-suffixed relative imports (project
 * convention, required by `NodeNext` resolution), and this repository has
 * no build step in dev or test — `npm test` runs source, not `dist/`. A
 * plain `node extract-child.ts` cannot resolve those imports: Node's native
 * type-stripping does not perform TypeScript's `.js`→`.ts` remapping, only
 * `tsc` and loaders like `tsx` do (verified empirically while building
 * this file). So the child is spawned through `tsx`'s loader via
 * `--import`, the same tool every other standalone entry point in this
 * project already runs under (`package.json`'s `migrate`/`scheduler`/
 * `dashboard` scripts).
 *
 * The loader is resolved once, from this module's own location, via
 * `createRequire(import.meta.url).resolve('tsx')` rather than passed as the
 * bare specifier `'tsx'` — so the spawn does not depend on the caller's
 * current working directory containing a `node_modules/tsx`. Plain
 * `import.meta.resolve` would do the same thing more directly under Node,
 * but Vitest's SSR module environment does not implement it (throws
 * `TypeError: ... .resolve is not a function` — hit while writing this
 * file's own test); `createRequire(...).resolve` works identically under
 * both, and `pathToFileURL` converts the filesystem path it returns into
 * the `file://` specifier `--import` requires on Windows.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MEMORY_CAP_MARKER } from './child-hardening.js';
import type { ExtractorId } from './registry.js';
import type { DocumentArtifact } from './types.js';

export type ExtractOutcome =
  | { ok: true; artifacts: DocumentArtifact[] }
  | {
      ok: false;
      code:
        | 'extractor_timeout'
        | 'extractor_crashed'
        | 'extractor_output_too_large'
        | 'extractor_failed'
        | 'extractor_memory';
      detail: string;
    };

export interface RunExtractorOptions {
  timeoutMs?: number;
  /** The V8 heap cap. */
  memoryMb?: number;
  /** The whole-process resident-set cap. Defaults to twice `memoryMb`. */
  rssCapMb?: number;
  maxOutputBytes?: number;
  /**
   * Test-only escape hatch: run a different child than `extract-child.ts`.
   * A test that needs a process that never exits, exits non-zero, or
   * floods stdout points this at its own stub instead of teaching the real
   * child to behave that way for no reason but being observed.
   */
  childPath?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_MB = 256;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const STDERR_DETAIL_LIMIT_BYTES = 2 * 1024;
const RSS_SAMPLE_INTERVAL_MS = 100;

/**
 * The resident set, in bytes, from the text of a Linux `/proc/<pid>/status`
 * (its `VmRSS:  <n> kB` line). `null` when the line is absent or does not
 * parse — never `0`, which would read as "well under the cap".
 */
export function vmRssBytes(status: string): number | null {
  const match = /^VmRSS:\s+(\d+)\s+kB\s*$/m.exec(status);
  return match?.[1] === undefined ? null : Number(match[1]) * 1024;
}

/**
 * Derives the default child's path from the extension *this* module was
 * loaded with, instead of naming `.ts` literally. `tsc` emits `.js` and
 * never copies `.ts` sources into `dist/`, so a literal `./extract-child.ts`
 * would ask for a file that does not exist once this module runs compiled
 * as `dist/documents/run-extractor.js` — where the sibling that *does*
 * exist is `extract-child.js`. Nothing consumes `dist/` today, which is
 * exactly why this is easy to get wrong without noticing: the literal form
 * looks correct and passes every test until the day something actually
 * runs from `dist/`. Do not replace this with a literal extension again —
 * that reintroduces the bug this function exists to prevent.
 *
 * Exported so `run-extractor.test.ts` can pin the relationship against a
 * synthetic `.js` module URL, since no compiled `dist/` exists in this
 * repository to exercise the real one against.
 */
export function defaultChildPath(runnerModuleUrl: string): string {
  const extension = runnerModuleUrl.slice(runnerModuleUrl.lastIndexOf('.'));
  return fileURLToPath(new URL(`./extract-child${extension}`, runnerModuleUrl));
}

const DEFAULT_CHILD_PATH = defaultChildPath(import.meta.url);

// Resolved once, from this module's own location, so the spawn below does
// not depend on the spawning process's current working directory holding a
// `node_modules/tsx` of its own. See the module docblock for why this uses
// `createRequire(...).resolve` rather than `import.meta.resolve`.
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/**
 * Parses one file in an isolated, capped child process. Every limit in the
 * isolation contract above is enforced from here — the memory watchdog in
 * the child is a second layer, never the only one on Linux. `options` lets
 * a caller (or a test) override the defaults, which are the spec §3.4
 * numbers.
 */
export async function runExtractor(
  extractor: ExtractorId,
  sourcePath: string,
  options: RunExtractorOptions = {},
): Promise<ExtractOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryMb = options.memoryMb ?? DEFAULT_MEMORY_MB;
  const rssCapMb = options.rssCapMb ?? memoryMb * 2;
  const rssCapBytes = rssCapMb * 1024 * 1024;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const childPath = options.childPath ?? DEFAULT_CHILD_PATH;

  return new Promise<ExtractOutcome>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${memoryMb}`,
        '--disallow-code-generation-from-strings',
        '--import',
        TSX_LOADER,
        childPath,
        extractor,
        sourcePath,
        String(rssCapMb),
      ],
      {
        // PATH and nothing else. See the module docblock and
        // `src/sdk/know-reader.ts`, which applies the identical rule to the
        // quarantine agent's own subprocess.
        env: process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let settled = false;
    // Which cap this run's own SIGKILL was for, if any — checked ahead of
    // the child's exit code in the `close` handler below, because a killed
    // process's exit code is meaningless (it is whatever SIGKILL produced
    // on this platform, not something the child chose).
    let killedFor: 'timeout' | 'output' | 'memory' | null = null;
    // Set when the child's own watchdog announced it was killing itself
    // for memory. Scanned on every chunk, not only within the first
    // STDERR_DETAIL_LIMIT_BYTES kept for the detail text, and across a
    // chunk boundary.
    let sawMemoryMarker = false;
    let stderrTail = '';

    let stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;

    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;

    const timer = setTimeout(() => {
      killedFor = 'timeout';
      child.kill('SIGKILL');
    }, timeoutMs);

    // Linux only, where reading the resident set costs one small file read.
    // Elsewhere the in-child watchdog is the layer that holds.
    const pid = child.pid;
    const rssSampler =
      process.platform === 'linux' && pid !== undefined
        ? setInterval(() => {
            readFile(`/proc/${pid}/status`, 'utf8').then(
              (status) => {
                const rss = vmRssBytes(status);
                if (rss !== null && rss > rssCapBytes && killedFor === null) {
                  killedFor = 'memory';
                  child.kill('SIGKILL');
                }
              },
              // The process may already be gone; the close handler decides.
              () => undefined,
            );
          }, RSS_SAMPLE_INTERVAL_MS)
        : null;

    const finish = (outcome: ExtractOutcome): void => {
      if (settled) return;
      settled = true;
      try {
        resolve(outcome);
      } finally {
        clearTimeout(timer);
        if (rssSampler !== null) clearInterval(rssSampler);
      }
    };

    // Counts bytes as they arrive and kills the instant the cap is
    // crossed. Never buffers the whole stream first — a flood that never
    // finished writing would mean never finishing this check.
    child.stdout.on('data', (chunk: Buffer) => {
      if (killedFor !== null) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        killedFor = 'output';
        // Nothing collected so far is going to be used — an oversized
        // output is discarded, not returned in truncated form.
        stdoutChunks = [];
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = stderrTail + chunk.toString('latin1');
      if (text.includes(MEMORY_CAP_MARKER)) sawMemoryMarker = true;
      stderrTail = text.slice(-MEMORY_CAP_MARKER.length);
      if (stderrBytes >= STDERR_DETAIL_LIMIT_BYTES) return;
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });

    child.on('error', (err) => {
      finish({ ok: false, code: 'extractor_crashed', detail: err.message });
    });

    child.on('close', (code) => {
      const stderrText = Buffer.concat(stderrChunks)
        .subarray(0, STDERR_DETAIL_LIMIT_BYTES)
        .toString('utf8');

      if (killedFor === 'timeout') {
        finish({
          ok: false,
          code: 'extractor_timeout',
          detail: `התהליך לא הסתיים תוך ${timeoutMs}ms ונהרג`,
        });
        return;
      }
      if (killedFor === 'memory' || (sawMemoryMarker && code !== 0)) {
        finish({
          ok: false,
          code: 'extractor_memory',
          detail: `התהליך חצה את תקרת הזיכרון של ${rssCapMb}MB ונהרג`,
        });
        return;
      }
      if (killedFor === 'output') {
        finish({
          ok: false,
          code: 'extractor_output_too_large',
          detail: `הפלט חצה את תקרת ${maxOutputBytes} בייטים ונהרג`,
        });
        return;
      }

      // Code 1 is this file's own contract with `extract-child.ts`: every
      // controlled failure there exits with exactly 1. Any other nonzero
      // code (or a null code from an external signal) means the process
      // ended some other way — a V8 heap-limit abort, for one real
      // example, which exits 134 and never reaches the child's own catch.
      if (code === 0) {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8'));
          // A child that exits 0 is not, by that fact alone, proof its JSON
          // has the shape this file trusts. Without this check, a child
          // whose JSON is valid but lacks (or misshapes) `artifacts` would
          // hand `buildOutline` an `undefined` it throws on
          // (`buildOutline(undefined)`) — an uncaught exception straight out
          // of `ingestDocument`, exactly what every controlled failure in
          // this pipeline exists to avoid. Checking `Array.isArray` here
          // turns that into the same recorded `extractor_crashed` outcome
          // as any other malformed child output, before it ever reaches a
          // caller.
          const artifacts = (parsed as { artifacts?: unknown } | null)?.artifacts;
          if (!Array.isArray(artifacts)) {
            finish({
              ok: false,
              code: 'extractor_crashed',
              detail: 'פלט לא תקין מהתהליך המבודד: artifacts חסר או אינו מערך',
            });
            return;
          }
          finish({ ok: true, artifacts: artifacts as DocumentArtifact[] });
        } catch (err) {
          finish({
            ok: false,
            code: 'extractor_crashed',
            detail: `פלט לא תקין מהתהליך המבודד: ${(err as Error).message}`,
          });
        }
        return;
      }

      if (code === 1) {
        finish({
          ok: false,
          code: 'extractor_failed',
          detail: stderrText || 'התהליך יצא בקוד 1 בלי פרטים ב-stderr',
        });
        return;
      }

      finish({
        ok: false,
        code: 'extractor_crashed',
        detail: stderrText || `התהליך קרס עם קוד יציאה ${code ?? 'לא ידוע'}`,
      });
    });
  });
}
