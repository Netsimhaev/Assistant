/**
 * Test-only stub child for `run-extractor.test.ts`. Never exits on its own
 * and never writes to stdout — proves the parent's timeout actually kills a
 * wedged process, rather than the parent trusting the child to cooperate.
 *
 * Never wired into `extract-child.ts`, the real child: production code
 * carrying behaviour that exists only so a test can reach it is a defect.
 * `runExtractor`'s `childPath` option exists so a test can point at a stub
 * like this one instead.
 */
setInterval(() => {}, 0x7fffffff);
