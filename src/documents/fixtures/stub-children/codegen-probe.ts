/**
 * Test-only stub child for `run-extractor.test.ts`. Tries both forms of
 * string code generation and reports whether each threw, through the normal
 * artefact channel — proving `--disallow-code-generation-from-strings`
 * really reaches the spawned child, rather than trusting the argv list.
 *
 * Never wired into `extract-child.ts` — see `hang.ts` in this directory for
 * why a stub like this stays test-only.
 */
let functionThrew = false;
try {
  new Function('return 1')();
} catch {
  functionThrew = true;
}
let evalThrew = false;
try {
  (0, eval)('1');
} catch {
  evalThrew = true;
}
const content = { functionThrew, evalThrew };
process.stdout.write(
  JSON.stringify({ artifacts: [{ ordinal: 0, kind: 'text', partName: null, content, flags: [] }] }),
);
