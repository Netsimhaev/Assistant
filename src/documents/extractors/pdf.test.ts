import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPdf, visualOrder } from '../fixtures/build-pdf.js';
import { runExtractor } from '../run-extractor.js';
import type { Block, TextContent } from '../types.js';
import { MAX_PDF_PAGES, PDF_LOAD_OPTIONS, extractPdf } from './pdf.js';

// A pass-through spy on the library's own entry point: every call still
// reaches the real `getDocument`, and the test can read back exactly what
// the extractor handed it — the options are asserted where they are used,
// not only where they are declared.
const getDocumentCalls = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', async (importOriginal) => {
  const real = await importOriginal<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>();
  return {
    ...real,
    getDocument: (params: Record<string, unknown>) => {
      getDocumentCalls.push(params);
      return real.getDocument(params as Parameters<typeof real.getDocument>[0]);
    },
  };
});

const blocksOf = (content: unknown): Block[] => (content as TextContent).blocks;
const textOf = (content: unknown): string =>
  blocksOf(content)
    .map((b) => (b.kind === 'list' ? b.items.join('\n') : b.text))
    .join('\n');

let DIR: string;
beforeAll(async () => {
  DIR = await mkdtemp(join(tmpdir(), 'pdf-extract-'));
});
afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

async function writePdf(name: string, bytes: Buffer): Promise<string> {
  const path = join(DIR, name);
  await writeFile(path, bytes);
  return path;
}

describe('extractPdf', () => {
  it('extracts the text of a two-page PDF as two artifacts', async () => {
    const path = await writePdf(
      'two.pdf',
      buildPdf([
        ['Invoice INV-17', 'Total 1200 NIS'],
        ['Payment due 30 days'],
      ]),
    );
    const artifacts = await extractPdf(path);

    expect(artifacts.map((a) => [a.ordinal, a.kind])).toEqual([
      [0, 'text'],
      [1, 'text'],
    ]);
    expect(artifacts.map((a) => a.partName)).toEqual(['עמוד 1', 'עמוד 2']);
    expect(blocksOf(artifacts[0]?.content)).toEqual([
      { kind: 'paragraph', text: 'Invoice INV-17' },
      { kind: 'paragraph', text: 'Total 1200 NIS' },
    ]);
    expect(textOf(artifacts[1]?.content)).toBe('Payment due 30 days');
    expect(artifacts.flatMap((a) => a.flags)).toEqual([]);
  });

  it('flags scanned_no_text for a PDF with no text layer', async () => {
    const path = await writePdf('scan.pdf', buildPdf([null, null]));
    const artifacts = await extractPdf(path);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]?.flags).toEqual(['scanned_no_text']);
    // Document-level: on the first artifact only, never painted on every page.
    expect(artifacts[1]?.flags).toEqual([]);
    expect(artifacts.every((a) => blocksOf(a.content).length === 0)).toBe(true);
  });

  it('does not flag scanned_no_text when any page carries text', async () => {
    const path = await writePdf('mixed.pdf', buildPdf([null, ['Signed copy']]));
    const artifacts = await extractPdf(path);
    expect(artifacts.flatMap((a) => a.flags)).toEqual([]);
  });

  it('stops at 50 pages and flags truncated on the first artifact', async () => {
    const pages = Array.from({ length: MAX_PDF_PAGES + 5 }, (_, i) => [`Page body ${i + 1}`]);
    const path = await writePdf('long.pdf', buildPdf(pages));
    const artifacts = await extractPdf(path);

    expect(MAX_PDF_PAGES).toBe(50);
    expect(artifacts).toHaveLength(50);
    expect(artifacts[0]?.flags).toEqual(['truncated']);
    expect(artifacts.slice(1).every((a) => a.flags.length === 0)).toBe(true);
    expect(textOf(artifacts[49]?.content)).toBe('Page body 50');
  });

  it('a PDF of exactly 50 pages is not truncated', async () => {
    const pages = Array.from({ length: 50 }, (_, i) => [`p${i}`]);
    const artifacts = await extractPdf(await writePdf('fifty.pdf', buildPdf(pages)));
    expect(artifacts).toHaveLength(50);
    expect(artifacts.flatMap((a) => a.flags)).toEqual([]);
  });

  it('caps one page at the shared character cap and flags truncated on that page', async () => {
    // 70 lines of 600 characters at 1pt: 42,000 characters, all on the page.
    const dense = Array.from({ length: 70 }, () => 'a'.repeat(600));
    const path = await writePdf('dense.pdf', buildPdf([['short'], dense], { fontSize: 1 }));
    const artifacts = await extractPdf(path);

    expect(artifacts[0]?.flags).toEqual([]);
    expect(artifacts[1]?.flags).toEqual(['truncated']);
    expect(textOf(artifacts[1]?.content).length).toBe(32_768);
  });

  it('a PDF with a JavaScript action extracts text and never evaluates it', async () => {
    const marker = '__pdfOpenActionRan';
    const path = await writePdf(
      'scripted.pdf',
      buildPdf([['Quote Q-9']], { openActionJs: `globalThis.${marker} = true; throw new Error('ran');` }),
    );
    getDocumentCalls.length = 0;
    const artifacts = await extractPdf(path);

    expect(textOf(artifacts[0]?.content)).toBe('Quote Q-9');
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();

    // The options the library actually received, not merely the constant.
    expect(getDocumentCalls).toHaveLength(1);
    const params = getDocumentCalls[0] ?? {};
    // `isEvalSupported` is deliberately not asserted: pdfjs-dist 6 ignores
    // it. "No eval" is enforced by the child's V8 flag, which
    // run-extractor.test.ts proves reaches the child.
    expect(params).toMatchObject({
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      useWasm: false,
      stopAtErrors: true,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
    });
    for (const urlOption of ['url', 'cMapUrl', 'standardFontDataUrl', 'wasmUrl', 'iccUrl', 'docBaseUrl']) {
      expect(params[urlOption], urlOption).toBeUndefined();
    }
    expect(params['data']).toBeInstanceOf(Uint8Array);
    expect(PDF_LOAD_OPTIONS).toMatchObject({ disableFontFace: true, useSystemFonts: false });
  });

  describe('Hebrew and mixed-direction lines', () => {
    const firstLine = async (name: string, line: Parameters<typeof buildPdf>[0][number]): Promise<string> => {
      const artifacts = await extractPdf(await writePdf(name, buildPdf([line])));
      return textOf(artifacts[0]?.content);
    };

    it('reads a single Hebrew run in logical order', async () => {
      expect(await firstLine('he-one.pdf', [visualOrder('שלום')])).toBe('שלום');
    });

    it('reads a number and a Hebrew word from two runs, number first in the stream, right to left', async () => {
      const line = [
        { text: '1200', x: 36 },
        { text: visualOrder('חשבונית'), x: 80 },
      ];
      expect(await firstLine('he-mixed.pdf', [line])).toBe('חשבונית 1200');
    });

    it('reads two Hebrew words with a space between them, whichever comes first in the stream', async () => {
      const left = { text: visualOrder('עולם'), x: 36 };
      const right = { text: visualOrder('שלום'), x: 100 };
      expect(await firstLine('he-left-first.pdf', [[left, right]])).toBe('שלום עולם');
      expect(await firstLine('he-right-first.pdf', [[right, left]])).toBe('שלום עולם');
    });

    it('leaves a left-to-right line of two runs in left-to-right order, spaced', async () => {
      const line = [
        { text: 'Total', x: 36 },
        { text: '1200 NIS', x: 80 },
      ];
      expect(await firstLine('en-two-runs.pdf', [line])).toBe('Total 1200 NIS');
      // Out of stream order too: position decides, not the order written.
      expect(await firstLine('en-reversed.pdf', [[line[1]!, line[0]!]])).toBe('Total 1200 NIS');
    });

    it('does not glue or split runs that touch', async () => {
      // "Invo" in Helvetica at 12pt is 22.68pt wide (278+556+500+556 per
      // mille): "ice" starts where "Invo" ends, so no space belongs there.
      const line = [
        { text: 'Invo', x: 36 },
        { text: 'ice', x: 58.68 },
      ];
      expect(await firstLine('en-touching.pdf', [line])).toBe('Invoice');
    });
  });

  it('rejects a malformed PDF by throwing — the child turns that into a controlled failure', async () => {
    const path = await writePdf('broken.pdf', Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n', 'latin1'));
    await expect(extractPdf(path)).rejects.toThrow();
  });
});

describe('the PDF extractor inside the isolated child', () => {
  it('round-trips pages through runExtractor, script and all, with string evaluation disabled', async () => {
    const path = await writePdf(
      'child.pdf',
      buildPdf([['First page'], ['Second page']], { openActionJs: "app.alert('hi')" }),
    );
    const outcome = await runExtractor('pdf', path);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.artifacts.map((a) => textOf(a.content))).toEqual(['First page', 'Second page']);
  });

  it('extracts with the native canvas package blocked in the child', async () => {
    // The child refuses to resolve @napi-rs/canvas (child-hardening.ts);
    // pdf.js falls back with a warning and text extraction does not need it.
    const outcome = await runExtractor('pdf', await writePdf('no-canvas.pdf', buildPdf([['Still read']])));
    expect(outcome).toMatchObject({ ok: true });
    if (outcome.ok) expect(textOf(outcome.artifacts[0]?.content)).toBe('Still read');
  });

  it('the real child refuses the native canvas package — its own refusal is on the child\'s stderr', async () => {
    // `runExtractor` keeps a successful child's stderr to itself, so the real
    // child is spawned here exactly as `runExtractor` spawns it (same flags,
    // same loader, same PATH-only env) to read its stderr. pdf.js's import
    // warning quotes the error it caught; that error text is the hook's own
    // (`child-hardening.ts`), so seeing it proves the hook ran in the real
    // child — not just in the `canvas-probe.ts` stub.
    const path = await writePdf('no-canvas-stderr.pdf', buildPdf([['Still read']]));
    const childPath = fileURLToPath(new URL('../extract-child.ts', import.meta.url));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--max-old-space-size=256', '--disallow-code-generation-from-strings', '--import', tsx, childPath, 'pdf', path, '512'],
        { env: process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (exit) => resolve({ stdout: out, stderr: err, code: exit }));
    });
    expect(code).toBe(0);
    expect(stdout).toContain('Still read');
    expect(stderr).toContain('Cannot load "@napi-rs/canvas" package');
    expect(stderr).toContain('native module @napi-rs/canvas is refused in the extraction child');
  }, 30_000);

  it('a decompression bomb is killed for memory, not extracted, within the time cap', async () => {
    // ~2 KB on disk per MiB inflated; 2 GiB inflated would be far past any cap.
    const bytes = buildPdf([['bomb']], { flateBombMib: 2048 });
    expect(bytes.length).toBeLessThan(8 * 1024 * 1024);
    const started = Date.now();
    const outcome = await runExtractor('pdf', await writePdf('bomb.pdf', bytes));
    expect(outcome).toMatchObject({ ok: false, code: 'extractor_memory' });
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('a malformed PDF is a controlled extractor_failed, not a crash', async () => {
    const path = await writePdf('child-broken.pdf', Buffer.from('%PDF-1.7\ngarbage', 'latin1'));
    const outcome = await runExtractor('pdf', path);
    expect(outcome).toMatchObject({ ok: false, code: 'extractor_failed' });
  });
});
