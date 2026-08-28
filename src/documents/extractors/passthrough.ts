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
 *
 * **A leading BOM is stripped, matching `csv.ts`'s encoding handling.**
 * `readFile(path, 'utf8')` does not do this on its own — a UTF-8 BOM
 * (`EF BB BF`) decodes to the literal character U+FEFF, which would
 * otherwise sit at the start of the one paragraph block verbatim. §4.3
 * states the BOM rule for CSV explicitly; nothing in §3.3 says passthrough
 * is exempt, and a stray zero-width character at the head of a `.txt`,
 * `.md`, or `.json` file a person or another system exported is exactly as
 * spurious there as it would be in a CSV's first header cell.
 */

import { readFile } from 'node:fs/promises';
import type { DocumentArtifact, TextContent } from '../types.js';

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function extractPassthrough(sourcePath: string): Promise<DocumentArtifact[]> {
  const text = stripBom(await readFile(sourcePath, 'utf8'));
  const content: TextContent = { blocks: [{ kind: 'paragraph', text }] };
  return [{ ordinal: 0, kind: 'text', partName: null, content, flags: [] }];
}
