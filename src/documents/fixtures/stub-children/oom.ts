/**
 * Test-only stub child for `run-extractor.test.ts`. Allocates without bound
 * until V8 aborts at the `--max-old-space-size` heap cap `runExtractor`
 * puts on every child's own command line — a real resource condition, not
 * a simulated one, so the `extractor_crashed` outcome it proves is backed
 * by something that actually happens rather than a mocked exit code.
 *
 * Never wired into `extract-child.ts` — see `hang.ts` in this directory for
 * why a stub like this stays test-only.
 */
const chunks: string[] = [];
for (;;) {
  chunks.push('x'.repeat(1_000_000));
}
