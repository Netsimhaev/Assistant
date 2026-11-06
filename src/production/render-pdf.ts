/**
 * PDF stage 2: load the page's assets, build the HTML (`render-html.ts`) and
 * hand it to a `PdfPrinter`. The printer is a seam: production injects
 * `createChromiumPrinter` (`chromium.ts`); tests inject a stub, so no test
 * needs Chromium. PDF is produced directly as a PDF (D17/D19), never
 * converted from Word.
 *
 * Fonts (spec §6.4(ג), embedded so the client sees them without having them):
 * `config.productionFontPath` (env `DOCUMENT_FONT_PATH`) names the Hebrew
 * Regular face; its three companions are FIXED file names in the same
 * directory (`PDF_FONT_FILES`). Noto Sans Hebrew covers Hebrew only — no
 * digits, no Latin, not even `.` or `,` — so Noto Sans (Latin) is embedded
 * beside it and the CSS stack falls through per glyph. A missing file throws
 * a clear internal error; there is no system-font fallback, because a PDF
 * that silently renders digits in whatever the server happens to have is
 * exactly the drift the embedding exists to prevent.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import type { PdfSpec } from '../domain/document-spec.js';
import { renderFooterTemplate, renderHtml, type PdfAssets, type PdfFonts } from './render-html.js';
import { SpecRenderError } from './render-error.js';
import { checkImage, type ImageLoader } from './render-shared.js';

export interface PrintOptions {
  /** Static footer markup (page numbers, contract disclaimer); see `renderFooterTemplate`. */
  footerTemplate: string;
}

/** HTML in, PDF bytes out. Must honour `signal`; the Chromium printer also has its own hard deadline. */
export type PdfPrinter = (html: string, signal: AbortSignal, options: PrintOptions) => Promise<Buffer>;

/** Upper bound on one print, enforced by `renderPdf` (signal) and by the printer (`withDeadline`). */
export const PDF_PRINT_TIMEOUT_MS = 60_000;

/**
 * Largest HTML handed to a printer. Checked before Chromium starts: the
 * printer's RSS watchdog is the real memory bound, this is the cheap
 * complement that refuses an absurd page without launching anything.
 */
export const MAX_PDF_HTML_BYTES = 60 * 1024 * 1024;

/** File names inside the font directory. `hebrewRegular` is the file `DOCUMENT_FONT_PATH` names. */
export const PDF_FONT_FILES: Record<keyof PdfFonts, string> = {
  hebrewRegular: 'NotoSansHebrew-Regular.ttf',
  hebrewBold: 'NotoSansHebrew-Bold.ttf',
  latinRegular: 'NotoSans-Regular.ttf',
  latinBold: 'NotoSans-Bold.ttf',
};

export interface LoadPdfAssetsOptions {
  images: ImageLoader;
  /** Defaults to `config.productionFontPath`. */
  fontPath?: string;
}

async function fontDataUrl(path: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new Error(
      `PDF font file missing or unreadable: ${path} (${(err as NodeJS.ErrnoException).code ?? 'error'}). ` +
        'Set DOCUMENT_FONT_PATH to the Hebrew Regular .ttf and keep its companions ' +
        `(${Object.values(PDF_FONT_FILES).join(', ')}) beside it — there is no fallback font.`,
      { cause: err },
    );
  }
  // TrueType (0x00010000) or 'true'; anything else is not a font we embed.
  const magic = bytes.subarray(0, 4).toString('hex');
  if (magic !== '00010000' && magic !== '74727565') {
    throw new Error(`PDF font file is not a TrueType font: ${path}. Check DOCUMENT_FONT_PATH.`);
  }
  return `data:font/ttf;base64,${bytes.toString('base64')}`;
}

/** Reads the four fonts and every image block into `data:` URLs. Missing image => `unknown_image`. */
export async function loadPdfAssets(spec: PdfSpec, options: LoadPdfAssetsOptions): Promise<PdfAssets> {
  const regular = options.fontPath ?? config.productionFontPath;
  const dir = dirname(regular);
  const pathOf = (key: keyof PdfFonts) => (key === 'hebrewRegular' ? regular : join(dir, PDF_FONT_FILES[key]));
  const fonts: PdfFonts = {
    hebrewRegular: await fontDataUrl(pathOf('hebrewRegular')),
    hebrewBold: await fontDataUrl(pathOf('hebrewBold')),
    latinRegular: await fontDataUrl(pathOf('latinRegular')),
    latinBold: await fontDataUrl(pathOf('latinBold')),
  };

  const images = new Map<string, string>();
  for (let i = 0; i < spec.blocks.length; i += 1) {
    const block = spec.blocks[i];
    if (block?.type !== 'image' || images.has(block.documentId)) continue;
    const where = `blocks[${i}]`;
    const img = await options.images(block.documentId);
    if (img === null) throw new SpecRenderError('unknown_image', where);
    const checked = checkImage(img, where);
    images.set(block.documentId, `data:${checked.mediaType};base64,${checked.bytes.toString('base64')}`);
  }
  return { fonts, images };
}

export interface RenderPdfDeps {
  printer: PdfPrinter;
  assets: PdfAssets;
  currency: string;
}

export async function renderPdf(spec: PdfSpec, deps: RenderPdfDeps): Promise<Buffer> {
  return (await renderPdfWithHtml(spec, deps)).pdf;
}

/**
 * The PDF and the exact HTML that was printed. Check 1 compares table rows
 * against this HTML (`Check1Input.html`): it is the PDF's structure in logical
 * order, where text read back from the pages is in visual order.
 */
export async function renderPdfWithHtml(spec: PdfSpec, deps: RenderPdfDeps): Promise<{ pdf: Buffer; html: string }> {
  const html = renderHtml(spec, deps.assets, { currency: deps.currency });
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_PDF_HTML_BYTES) throw new SpecRenderError('pdf_too_large', `html ${bytes} bytes`);
  const footerTemplate = renderFooterTemplate(spec, deps.assets);
  const pdf = await deps.printer(html, AbortSignal.timeout(PDF_PRINT_TIMEOUT_MS), { footerTemplate });
  if (pdf.length < 5 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('renderPdf: printer output is not a PDF');
  }
  return { pdf, html };
}
