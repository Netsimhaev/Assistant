/**
 * The child process `run-extractor.ts` spawns (spec §3.4). Runs with only
 * `PATH` in its environment, touches no database, opens no socket. Its only
 * job is to parse one untrusted file and print one JSON object to stdout.
 *
 * Every controlled failure funnels through the single top-level catch below
 * and exits 1 — there is no other designed exit path out of this file.
 * Anything that ends this process outside that catch (a V8 heap-limit
 * abort at the `--max-old-space-size` cap the parent set, a signal) is
 * exactly what `run-extractor.ts` classifies as `extractor_crashed` rather
 * than `extractor_failed`: the parent tells the two apart by exit code —
 * `1` is this file's own controlled failure, anything else is not. The one
 * other designed exit is the memory watchdog (`child-hardening.ts`), which
 * kills the process and leaves `MEMORY_CAP_MARKER` on stderr so the parent
 * can name it `extractor_memory` even where that kill exits with code 1.
 *
 * No test-only branch lives here. A child that hangs forever or floods
 * stdout is a separate stub script under `fixtures/stub-children/` that a
 * test points `runExtractor`'s `childPath` option at — production code
 * carrying behaviour that exists only for a test is a defect, not a
 * convenience.
 */

import { blockNativeCanvas, routeConsoleToStderr, startMemoryWatchdog } from './child-hardening.js';
import type { ExtractorId } from './registry.js';
import type { DocumentArtifact } from './types.js';

// Exported so `media-type-tables.test.ts` can lock it against `registry.ts`'s
// `ExtractorId` union — an ExtractorId with no entry here would dispatch to
// nothing at runtime despite compiling fine everywhere else.
export const KNOWN_EXTRACTORS: readonly ExtractorId[] = ['xlsx', 'docx', 'csv', 'passthrough', 'pdf'];

function isExtractorId(value: string): value is ExtractorId {
  return (KNOWN_EXTRACTORS as readonly string[]).includes(value);
}

/**
 * Each parser is imported here, on demand, never at the top of the file.
 *
 * Static imports are hoisted, so they evaluated exceljs, mammoth and the PDF
 * module in EVERY child — before `main()` had installed the console reroute,
 * the canvas block or the memory watchdog. A child reading a PDF loaded two
 * libraries it would never call, ahead of the controls meant to contain
 * whatever the file does to them; measured 25/10 that was ~350 ms of each
 * child's start. Loaded here, a child holds one parser, and only after
 * hardening. `extract-child-imports.test.ts` keeps it that way.
 */
async function dispatch(extractorId: ExtractorId, sourcePath: string): Promise<DocumentArtifact[]> {
  switch (extractorId) {
    case 'passthrough':
      return (await import('./extractors/passthrough.js')).extractPassthrough(sourcePath);
    case 'xlsx':
      return (await import('./extractors/xlsx.js')).extractXlsx(sourcePath);
    case 'csv':
      return (await import('./extractors/csv.js')).extractCsv(sourcePath);
    case 'docx':
      return (await import('./extractors/docx.js')).extractDocx(sourcePath);
    case 'pdf':
      return (await import('./extractors/pdf.js')).extractPdf(sourcePath);
  }
}

/**
 * The hardening in `child-hardening.ts` is installed before dispatch, and
 * `extractors/pdf.ts` imports pdf.js lazily, so the console reroute and the
 * native-canvas block are in place before that library is evaluated, and
 * the memory watchdog is sampling before any parser touches the file.
 */
async function main(): Promise<void> {
  routeConsoleToStderr();
  blockNativeCanvas();

  const extractorArg = process.argv[2];
  const sourcePath = process.argv[3];
  const rssCapMb = Number(process.argv[4]);

  if (extractorArg === undefined || sourcePath === undefined || !isExtractorId(extractorArg)) {
    throw new Error(
      `bad child arguments: extractor=${extractorArg ?? '(missing)'} sourcePath=${sourcePath ?? '(missing)'}`,
    );
  }
  if (!Number.isInteger(rssCapMb) || rssCapMb <= 0) {
    throw new Error(`bad child arguments: rssCapMb=${process.argv[4] ?? '(missing)'}`);
  }

  await startMemoryWatchdog(rssCapMb * 1024 * 1024);
  const artifacts = await dispatch(extractorArg, sourcePath);
  process.stdout.write(JSON.stringify({ artifacts }));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(message);
  process.exitCode = 1;
});
