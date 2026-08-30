/**
 * Test-only stub child for `run-extractor.test.ts`. Reports its own
 * `process.env` keys back through the normal artefact channel, so the test
 * can assert on what the child actually received rather than trusting that
 * `extract-child.ts` would have behaved -- the real child never reads
 * `process.env` for anything, which would make that assertion vacuous.
 *
 * Note (found empirically while building this): on Windows, Node's
 * `child_process.spawn` adds a handful of OS-required variables (SystemRoot,
 * the user's home/profile paths, etc.) to a child even when `env` names only
 * `PATH` -- this is Node's own Windows compatibility behaviour, not a leak
 * from this project's process. None of it is a secret; nothing this project
 * treats as sensitive (a database URL, an API key) is among them.
 *
 * Never wired into `extract-child.ts` -- see `hang.ts` in this directory
 * for why a stub like this stays test-only.
 */
process.stdout.write(
  JSON.stringify({
    artifacts: [
      {
        ordinal: 0,
        kind: 'text',
        partName: null,
        flags: [],
        content: { blocks: [{ kind: 'paragraph', text: JSON.stringify(Object.keys(process.env).sort()) }] },
      },
    ],
  }),
);
