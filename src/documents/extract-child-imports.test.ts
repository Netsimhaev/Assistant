import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runExtractor } from './run-extractor.js';

const CHILD_SOURCE = readFileSync(fileURLToPath(new URL('./extract-child.ts', import.meta.url)), 'utf8');

/**
 * The extraction child parses ONE file with ONE parser, so it loads only
 * that parser — and only after the hardening and the memory watchdog are in
 * place.
 *
 * Static imports are hoisted: with `import { extractXlsx } from ...` at the
 * top, every child evaluated exceljs, mammoth and the PDF module before
 * `main()` installed anything — two libraries with no reason to be in a
 * process reading a PDF, loaded ahead of the console reroute, the canvas
 * block and the watchdog. Measured 25/10: ~350 ms of every child's start,
 * which is what pushed the attachment tests in `mail-poll.test.ts` past their
 * time limit under load.
 */
describe('the extraction child loads only the parser it was asked for', () => {
  it('imports no extractor statically', () => {
    const staticExtractorImports = CHILD_SOURCE.match(/^import [^;]*from '\.\/extractors\/[^']+';/gm) ?? [];
    expect(staticExtractorImports).toEqual([]);
  });

  // The positive half: each extractor is still reached, through a dynamic
  // import. Without it the test above passes on a child that reads nothing.
  it('reaches every extractor through a dynamic import', () => {
    for (const file of ['passthrough', 'xlsx', 'csv', 'docx', 'pdf']) {
      expect(CHILD_SOURCE, file).toContain(`await import('./extractors/${file}.js')`);
    }
  });

  // And it still works end to end, through the real spawn, for a parser whose
  // module is now loaded on demand.
  it('still extracts through the real child', async () => {
    const outcome = await runExtractor(
      'passthrough',
      fileURLToPath(new URL('./fixtures/small.txt', import.meta.url)),
    );
    expect(outcome.ok).toBe(true);
  });
});
