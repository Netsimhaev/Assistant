/**
 * Test-only stub child for `ingest.test.ts`. Exits 1 with a message on
 * stderr and nothing on stdout — the same controlled-failure exit code
 * `extract-child.ts`'s own top-level catch produces (its docblock: "1" is
 * this file's own contract). Proves `runExtractor`'s `extractor_failed`
 * outcome, and `ingestDocument`'s handling of it, without needing a real
 * extractor library to genuinely refuse a malformed file.
 *
 * Never wired into `extract-child.ts` — see `hang.ts` in this directory
 * for why a stub like this stays test-only.
 */
process.stderr.write('stub: controlled extractor failure');
process.exitCode = 1;
