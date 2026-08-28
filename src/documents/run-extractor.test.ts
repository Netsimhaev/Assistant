import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runExtractor } from './run-extractor.js';
import type { TextContent } from './types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const stubChild = (name: string) =>
  fileURLToPath(new URL(`./fixtures/stub-children/${name}`, import.meta.url));

describe('runExtractor', () => {
  it('kills a child that will not stop, and says so', async () => {
    const outcome = await runExtractor('passthrough', fixture('small.txt'), {
      timeoutMs: 200,
      childPath: stubChild('hang.ts'),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('extractor_timeout');
  }, 10_000);

  it('records a crash rather than throwing it', async () => {
    // The real child, fed a path that does not exist. extractPassthrough's
    // readFile rejects with ENOENT, extract-child.ts's top-level catch
    // turns that into a stderr message and exit 1 -- its one designed
    // failure path.
    const outcome = await runExtractor('passthrough', '/no/such/file');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('extractor_failed');
      expect(outcome.detail.length).toBeGreaterThan(0);
    }
  });

  it('stops reading a child that floods stdout, without buffering the whole thing first', async () => {
    // The real child and the real passthrough extractor: huge.txt is 5000
    // bytes of text, comfortably over the 1024-byte cap once it becomes a
    // JSON artefact on stdout. No stub needed -- an ordinary, legitimate
    // extractor output is enough to cross a small enough cap.
    const outcome = await runExtractor('passthrough', fixture('huge.txt'), {
      maxOutputBytes: 1024,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('extractor_output_too_large');
  });

  it('reports a crash distinctly from a controlled failure, backed by a real resource condition', async () => {
    // oom.ts allocates without bound. Given a tiny heap cap it hits V8's
    // --max-old-space-size limit fast: a genuine engine-level abort (exit
    // code 134 on this platform), never reaching any application-level
    // catch -- the real-world case extractor_crashed exists to name.
    const outcome = await runExtractor('passthrough', fixture('small.txt'), {
      memoryMb: 32,
      childPath: stubChild('oom.ts'),
      timeoutMs: 15_000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('extractor_crashed');
  }, 20_000);

  it('runs the real child end to end and round-trips the passthrough extractor', async () => {
    const outcome = await runExtractor('passthrough', fixture('small.txt'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.artifacts).toHaveLength(1);
    const [artifact] = outcome.artifacts;
    expect(artifact?.kind).toBe('text');
    expect(artifact?.partName).toBeNull();
    expect(artifact?.flags).toEqual([]);
    const content = artifact?.content as TextContent;
    expect(content.blocks).toEqual([
      { kind: 'paragraph', text: 'hello from a real fixture\n' },
    ]);
  });

  it('gives the child PATH and nothing secret, even when the parent process holds secrets', async () => {
    // Simulates what the real parent process holds by the time it would
    // call runExtractor: a database URL and an API key, exactly the two
    // named in the isolation contract as what must never reach a process
    // parsing an untrusted file. env-echo.ts reports back what it actually
    // received in process.env, through the normal artefact channel -- this
    // asserts on the spawn boundary itself, not on the real child's good
    // behaviour (it never reads process.env for anything).
    const injected = {
      DATABASE_URL: 'postgres://should-never-cross@localhost/db',
      ANTHROPIC_API_KEY: 'sk-should-never-cross',
      DOCUMENT_INTAKE_TEST_SECRET: 'should-never-cross',
    };
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(injected)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const outcome = await runExtractor('passthrough', fixture('small.txt'), {
        childPath: stubChild('env-echo.ts'),
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const content = outcome.artifacts[0]?.content as TextContent;
      const block = content.blocks[0];
      if (block?.kind !== 'paragraph') throw new Error('expected a paragraph block');
      const childKeys: string[] = JSON.parse(block.text) as string[];
      for (const key of Object.keys(injected)) {
        expect(childKeys).not.toContain(key);
      }
      expect(childKeys.some((k) => k.toUpperCase() === 'PATH')).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
