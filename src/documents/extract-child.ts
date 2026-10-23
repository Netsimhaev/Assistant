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
 * `1` is this file's own controlled failure, anything else is not.
 *
 * No test-only branch lives here. A child that hangs forever or floods
 * stdout is a separate stub script under `fixtures/stub-children/` that a
 * test points `runExtractor`'s `childPath` option at — production code
 * carrying behaviour that exists only for a test is a defect, not a
 * convenience.
 */

import { format } from 'node:util';
import { extractCsv } from './extractors/csv.js';
import { extractDocx } from './extractors/docx.js';
import { extractPassthrough } from './extractors/passthrough.js';
import { extractPdf } from './extractors/pdf.js';
import { extractXlsx } from './extractors/xlsx.js';
import type { ExtractorId } from './registry.js';
import type { DocumentArtifact } from './types.js';

// Exported so `media-type-tables.test.ts` can lock it against `registry.ts`'s
// `ExtractorId` union — an ExtractorId with no entry here would dispatch to
// nothing at runtime despite compiling fine everywhere else.
export const KNOWN_EXTRACTORS: readonly ExtractorId[] = ['xlsx', 'docx', 'csv', 'passthrough', 'pdf'];

function isExtractorId(value: string): value is ExtractorId {
  return (KNOWN_EXTRACTORS as readonly string[]).includes(value);
}

async function dispatch(extractorId: ExtractorId, sourcePath: string): Promise<DocumentArtifact[]> {
  switch (extractorId) {
    case 'passthrough':
      return extractPassthrough(sourcePath);
    case 'xlsx':
      return extractXlsx(sourcePath);
    case 'csv':
      return extractCsv(sourcePath);
    case 'docx':
      return extractDocx(sourcePath);
    case 'pdf':
      return extractPdf(sourcePath);
  }
}

/**
 * Stdout carries exactly one thing: the JSON object `main` writes. A parsing
 * library that logs through `console.log` (pdf.js's deprecation notices and
 * its Emscripten modules both do) would otherwise splice text into that
 * object, and the parent would read a well-behaved file as a crashed child.
 * Every `console` method a library might reach for is pointed at stderr,
 * which the parent already treats as diagnostics only. This runs before
 * dispatch, and `extractors/pdf.ts` imports pdf.js lazily, so the reroute is
 * in place before that library is evaluated.
 */
function routeConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${format(...args)}
`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}

async function main(): Promise<void> {
  routeConsoleToStderr();

  const extractorArg = process.argv[2];
  const sourcePath = process.argv[3];

  if (extractorArg === undefined || sourcePath === undefined || !isExtractorId(extractorArg)) {
    throw new Error(
      `bad child arguments: extractor=${extractorArg ?? '(missing)'} sourcePath=${sourcePath ?? '(missing)'}`,
    );
  }

  const artifacts = await dispatch(extractorArg, sourcePath);
  process.stdout.write(JSON.stringify({ artifacts }));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(message);
  process.exitCode = 1;
});
