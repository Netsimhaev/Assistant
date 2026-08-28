/**
 * The `passthrough` extractor (spec §3.3): `text/plain`, `text/markdown`,
 * and `application/json` all pass straight through as one `text` artefact.
 *
 * Minimal by design (task 5 brief) — task 8 extends this and adds `csv`.
 * There is no parser here to exploit (the whole file becomes one string,
 * verbatim), but `runExtractor` still runs this inside the same isolated
 * child as every other extractor id, so the dispatch contract in
 * `extract-child.ts` stays one shape for all four ids. Whether a future
 * caller of `runExtractor` chooses to skip the child process entirely for
 * this id (the spec's "בלי תהליך נפרד" note) is that caller's decision, not
 * this module's or the runner's.
 */

import { readFile } from 'node:fs/promises';
import type { DocumentArtifact, TextContent } from '../types.js';

export async function extractPassthrough(sourcePath: string): Promise<DocumentArtifact[]> {
  const text = await readFile(sourcePath, 'utf8');
  const content: TextContent = { blocks: [{ kind: 'paragraph', text }] };
  return [{ ordinal: 0, kind: 'text', partName: null, content, flags: [] }];
}
