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

import { extractPassthrough } from './extractors/passthrough.js';
import type { ExtractorId } from './registry.js';
import type { DocumentArtifact } from './types.js';

const KNOWN_EXTRACTORS: readonly ExtractorId[] = ['xlsx', 'docx', 'csv', 'passthrough'];

function isExtractorId(value: string): value is ExtractorId {
  return (KNOWN_EXTRACTORS as readonly string[]).includes(value);
}

async function dispatch(extractorId: ExtractorId, sourcePath: string): Promise<DocumentArtifact[]> {
  switch (extractorId) {
    case 'passthrough':
      return extractPassthrough(sourcePath);
    case 'csv':
    case 'xlsx':
    case 'docx':
      // Built in later tasks (§3.3, §4.1, §4.2, §4.3). A registry entry
      // that names an id with no implementation here must fail loudly, not
      // silently return nothing.
      throw new Error(`extractor not yet implemented: ${extractorId}`);
  }
}

async function main(): Promise<void> {
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
