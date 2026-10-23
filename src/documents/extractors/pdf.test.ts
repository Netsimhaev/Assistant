import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPdf } from '../fixtures/build-pdf.js';
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
    expect(params).toMatchObject({
      isEvalSupported: false,
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
    expect(PDF_LOAD_OPTIONS).toMatchObject({ isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
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

  it('a malformed PDF is a controlled extractor_failed, not a crash', async () => {
    const path = await writePdf('child-broken.pdf', Buffer.from('%PDF-1.7\ngarbage', 'latin1'));
    const outcome = await runExtractor('pdf', path);
    expect(outcome).toMatchObject({ ok: false, code: 'extractor_failed' });
  });
});
