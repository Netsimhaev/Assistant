/**
 * Test-only stub child for `run-extractor.test.ts`. Exits 0 (a "successful"
 * process, by exit code alone) with syntactically valid JSON on stdout that
 * lacks a usable `artifacts` array — proving `runExtractor`'s `Array.isArray`
 * guard turns this into `extractor_crashed` rather than handing a caller
 * `{ ok: true, artifacts: undefined }`, which `buildOutline` would throw on.
 *
 * Never wired into `extract-child.ts` — see `hang.ts` in this directory for
 * why a stub like this stays test-only.
 */
process.stdout.write(JSON.stringify({ notArtifacts: 'oops' }));
