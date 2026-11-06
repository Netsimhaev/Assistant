import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PdfSpec } from '../domain/document-spec.js';
import { renderFooterTemplate, renderHtml, type PdfAssets } from './render-html.js';
import { loadPdfAssets, MAX_PDF_HTML_BYTES, PDF_FONT_FILES, renderPdf, renderPdfWithHtml, type PdfPrinter } from './render-pdf.js';
import { SpecRenderError } from './render-error.js';
import type { ImageLoader } from './render-shared.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const FONT = 'data:font/ttf;base64,AAEAAA==';
const assets: PdfAssets = {
  fonts: { hebrewRegular: FONT, hebrewBold: FONT, latinRegular: FONT, latinBold: FONT },
  images: new Map(),
};

function spec(over: Partial<PdfSpec> = {}): PdfSpec {
  return {
    format: 'pdf',
    language: 'he',
    kind: 'contract',
    title: 'חוזה',
    filename: 'contract',
    style: { theme: 'clean', accent: 'navy' },
    sources: [],
    legalBasis: [{ law: 'חוק החוזים' }],
    blocks: [{ type: 'clause', title: 'הגדרות', text: 'המחיר ₪100' }],
    ...over,
  };
}

const PDF_BYTES = Buffer.from('%PDF-1.7\n%stub\n');

describe('renderPdf', () => {
  it('renderPdfWithHtml returns the exact HTML that was printed, beside the PDF', async () => {
    let printed = '';
    const printer: PdfPrinter = async (html) => {
      printed = html;
      return PDF_BYTES;
    };
    const s = spec();
    const out = await renderPdfWithHtml(s, { printer, assets, currency: 'ILS' });
    expect(out.pdf).toBe(PDF_BYTES);
    expect(out.html).toBe(printed);
    expect(out.html).toBe(renderHtml(s, assets, { currency: 'ILS' }));
  });

  it("the printer receives exactly renderHtml's output", async () => {
    const calls: { html: string; signal: AbortSignal; footer: string }[] = [];
    const printer: PdfPrinter = async (html, signal, options) => {
      calls.push({ html, signal, footer: options.footerTemplate });
      return PDF_BYTES;
    };
    const s = spec();
    const out = await renderPdf(s, { printer, assets, currency: 'ILS' });
    expect(out).toBe(PDF_BYTES);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.html).toBe(renderHtml(s, assets, { currency: 'ILS' }));
    expect(calls[0]?.footer).toBe(renderFooterTemplate(s, assets));
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.signal.aborted).toBe(false);
  });

  it('refuses printer output that is not a PDF', async () => {
    let ran = false;
    const printer: PdfPrinter = async () => {
      ran = true;
      return Buffer.from('<html>not a pdf</html>');
    };
    await expect(renderPdf(spec(), { printer, assets, currency: 'ILS' })).rejects.toThrow(/not a PDF/);
    expect(ran).toBe(true);
  });

  it('refuses an HTML over the size cap before printing (pdf_too_large)', async () => {
    let printed = false;
    const printer: PdfPrinter = async () => {
      printed = true;
      return PDF_BYTES;
    };
    const huge = spec({ blocks: [{ type: 'paragraph', text: 'א'.repeat(Math.ceil(MAX_PDF_HTML_BYTES / 2) + 10) }] });
    const err = await renderPdf(huge, { printer, assets, currency: 'ILS' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecRenderError);
    expect((err as SpecRenderError).code).toBe('pdf_too_large');
    expect(printed).toBe(false);
    expect(MAX_PDF_HTML_BYTES).toBe(60 * 1024 * 1024);
  });
});

describe('loadPdfAssets', () => {
  async function fontDir(files: readonly string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'pdf-fonts-'));
    for (const f of files) await writeFile(join(dir, f), Buffer.from([0, 1, 0, 0]));
    return dir;
  }
  const allFonts = Object.values(PDF_FONT_FILES);
  const images: ImageLoader = async (id) => (id === 'DOC-1' ? { bytes: PNG, mediaType: 'image/png' } : null);

  it('embeds every font and every image as a data url', async () => {
    const dir = await fontDir(allFonts);
    try {
      const a = await loadPdfAssets(spec({ blocks: [{ type: 'image', documentId: 'DOC-1' }] }), {
        images,
        fontPath: join(dir, PDF_FONT_FILES.hebrewRegular),
      });
      for (const url of Object.values(a.fonts)) expect(url).toBe('data:font/ttf;base64,AAEAAA==');
      expect(a.images.get('DOC-1')).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a missing font file is a clear error, never a silent fallback', async () => {
    const dir = await fontDir(allFonts.filter((f) => f !== PDF_FONT_FILES.latinBold));
    try {
      await expect(
        loadPdfAssets(spec(), { images, fontPath: join(dir, PDF_FONT_FILES.hebrewRegular) }),
      ).rejects.toThrow(/NotoSans-Bold\.ttf.*DOCUMENT_FONT_PATH/s);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the vendored default fonts load from the repo', async () => {
    const a = await loadPdfAssets(spec(), { images });
    expect(a.fonts.hebrewRegular.startsWith('data:font/ttf;base64,AAEAAA')).toBe(true);
    expect(a.fonts.latinBold.length).toBeGreaterThan(100_000);
  });

  it('a missing image is unknown_image, a bad one unsupported_image', async () => {
    const dir = await fontDir(allFonts);
    const fontPath = join(dir, PDF_FONT_FILES.hebrewRegular);
    try {
      const err = await loadPdfAssets(spec({ blocks: [{ type: 'image', documentId: 'DOC-2' }] }), { images, fontPath }).catch((e) => e);
      expect(err).toBeInstanceOf(SpecRenderError);
      expect((err as SpecRenderError).code).toBe('unknown_image');
      const gif: ImageLoader = async () => ({ bytes: Buffer.from('GIF89a'), mediaType: 'image/gif' });
      const err2 = await loadPdfAssets(spec({ blocks: [{ type: 'image', documentId: 'DOC-1' }] }), { images: gif, fontPath }).catch((e) => e);
      expect((err2 as SpecRenderError).code).toBe('unsupported_image');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
