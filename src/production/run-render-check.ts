/**
 * `npm run doc:render-check` — the live check behind the seams.
 *
 * Builds one Hebrew docx, xlsx, pptx and pdf from FIXED specs, through the
 * real renderers, the real Chromium printer and the real page renderer
 * (LibreOffice + Chromium), and checks what came out:
 *
 *  - every format: the page images are PNGs, written to a fresh temp folder
 *    that is printed (and kept, so a person can look at them), and the
 *    extracted text is printed;
 *  - every format: the Review Focus 1 strings (`FOCUS`) appear in the
 *    extracted text, in the order the sentence writes them — Hebrew words not
 *    reversed, numbers not reversed, the parenthesis and the Latin model name
 *    where they belong;
 *  - the PDF: every embedded font (`/BaseFont`) is one of the vendored Noto
 *    faces, with no system font.
 *
 * Exits non-zero on any failure, and when LibreOffice or Chromium is not
 * configured: on a server, this script passing is a pre-launch check
 * (docs/11-pre-launch-checks.md). Tests never run it — it needs the binaries.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { stripBidiControls } from '../util/bidi.js';
import type { Block, DocxSpec, PdfSpec, PptxSpec, XlsxSpec } from '../domain/document-spec.js';
import { createChromiumPrinter } from './chromium.js';
import { createLocalPageRenderer, selectPages, type PageImages, type ProducedFormat } from './page-images.js';
import { renderDocx } from './render-docx.js';
import { loadPdfAssets, renderPdf } from './render-pdf.js';
import { renderPptx } from './render-pptx.js';
import type { ImageLoader } from './render-shared.js';
import { renderXlsx } from './render-xlsx.js';

/** Review Focus 1: the strings whose visual order a Hebrew document gets wrong first. */
const FOCUS = ['שולחן 160 ס"מ', 'Office Pro', '₪1,890', '39%', '(ראה סעיף 4.2)'] as const;
/** One sentence carrying them all, in the order `FOCUS` lists them. */
const SENTENCE = 'שולחן 160 ס"מ מדגם Office Pro עולה ₪1,890 אחרי הנחה של 39% (ראה סעיף 4.2)';

const CURRENCY = 'ILS';
const SRC = { kind: 'instruction' } as const;
const noImages: ImageLoader = async () => null;

const common = {
  language: 'he' as const,
  kind: 'price_list' as const,
  title: 'בדיקת הפקה — מחירון',
  filename: 'render-check',
  style: { theme: 'clean' as const, accent: 'navy' as const },
  sources: [SRC],
};

const BLOCKS: Block[] = [
  { type: 'heading', level: 1, text: 'מחירון ריהוט משרדי' },
  { type: 'paragraph', text: SENTENCE },
  {
    type: 'table',
    header: ['פריט', 'מחיר', 'הנחה'],
    rows: [[{ t: 'שולחן 160 ס"מ' }, { v: 1890, src: SRC }, { v: 0.39, src: SRC }]],
    numberFormat: ['int', 'money', 'percent'],
  },
];

const DOCX: DocxSpec = { format: 'docx', ...common, blocks: BLOCKS };
const PDF: PdfSpec = { format: 'pdf', ...common, blocks: BLOCKS };
const PPTX: PptxSpec = {
  format: 'pptx',
  ...common,
  slides: [
    { type: 'title', title: 'מחירון ריהוט משרדי' },
    { type: 'paragraph', title: 'הצעה', text: SENTENCE },
  ],
};
const XLSX: XlsxSpec = {
  format: 'xlsx',
  ...common,
  sheets: [
    {
      name: 'מחירון',
      tables: [
        {
          title: SENTENCE,
          header: ['פריט', 'מחיר', 'הנחה'],
          rows: [[{ t: 'שולחן 160 ס"מ' }, { v: 1890, src: SRC }, { v: 0.39, src: SRC }]],
          numberFormat: ['int', 'money', 'percent'],
        },
      ],
    },
  ],
};

const NOTO = /^NotoSans(Hebrew)?-(Regular|Bold)$/;

/** Every `/BaseFont` name in the file, subset prefix (`ABCDEF+`) removed. */
export function baseFonts(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const names = [...raw.matchAll(/\/BaseFont\s*\/([^\s/[\]<>()]+)/g)].map((m) => (m[1] as string).replace(/^[A-Z]{6}\+/, ''));
  return [...new Set(names)];
}

/**
 * Bidi controls removed (the renderers isolate number runs with them) and
 * whitespace collapsed, so a wrapped line still reads as one sentence.
 */
function flat(text: string): string {
  return stripBidiControls(text).replace(/\s+/g, ' ');
}

function checkOrder(text: string): string[] {
  const problems: string[] = [];
  const t = flat(text);
  let from = 0;
  for (const s of FOCUS) {
    const at = t.indexOf(s, from);
    if (at < 0) {
      problems.push(t.includes(s) ? `"${s}" found, but out of order` : `"${s}" not found in the extracted text`);
      continue;
    }
    from = at + s.length;
  }
  return problems;
}

async function main(): Promise<number> {
  const out = await mkdtemp(join(tmpdir(), 'doc-render-check-'));
  console.log(`page images folder: ${out}`);
  const failures: string[] = [];

  const chromiumPath = config.chromiumPath;
  const sofficePath = config.sofficePath;
  if (chromiumPath === null) {
    console.error('Chromium not configured: set DOCUMENT_CHROMIUM_PATH to the installed Chromium/Chrome.');
    return 1;
  }
  const printer = createChromiumPrinter({ executablePath: chromiumPath });
  const pages = createLocalPageRenderer({ sofficePath: sofficePath ?? '', chromiumPath });

  const build: Record<ProducedFormat, () => Promise<Buffer>> = {
    pdf: async () =>
      renderPdf(PDF, { printer, assets: await loadPdfAssets(PDF, { images: noImages }), currency: CURRENCY }),
    docx: () => renderDocx(DOCX, { currency: CURRENCY, images: noImages }),
    xlsx: () => renderXlsx(XLSX, { currency: CURRENCY }),
    pptx: async () => (await renderPptx(PPTX, { currency: CURRENCY, images: noImages })).buffer,
  };

  for (const format of ['pdf', 'docx', 'xlsx', 'pptx'] as const) {
    console.log(`\n=== ${format} ===`);
    if (format !== 'pdf' && sofficePath === null) {
      const msg = `${format}: LibreOffice not configured (DOCUMENT_SOFFICE_PATH) — page images cannot be made`;
      console.error(msg);
      failures.push(msg);
      continue;
    }
    try {
      const started = Date.now();
      const bytes = await build[format]();
      await writeFile(join(out, `render-check.${format}`), bytes);

      if (format === 'pdf') {
        const fonts = baseFonts(bytes);
        console.log(`embedded fonts: ${fonts.join(', ') || '(none)'}`);
        const foreign = fonts.filter((f) => !NOTO.test(f));
        if (fonts.length === 0) failures.push('pdf: no /BaseFont found');
        if (foreign.length > 0) failures.push(`pdf: non-Noto fonts embedded: ${foreign.join(', ')}`);
        if (!fonts.includes('NotoSansHebrew-Regular')) failures.push('pdf: NotoSansHebrew-Regular not embedded');
      }

      const result: PageImages = await pages({ format, bytes }, AbortSignal.timeout(180_000));
      console.log(`pages: ${result.pageCount}, images: ${result.pages.length}, ${Date.now() - started}ms`);
      const expected = selectPages(result.pageCount, []).length;
      if (result.pages.length !== expected) failures.push(`${format}: ${result.pages.length} images, expected ${expected}`);
      for (const [i, png] of result.pages.entries()) {
        const path = join(out, `${format}-page-${i + 1}.png`);
        await writeFile(path, png);
        console.log(`  ${path} (${png.length} bytes)`);
        if (png.subarray(0, 4).toString('hex') !== '89504e47') failures.push(`${format}: image ${i + 1} is not a PNG`);
      }
      console.log('--- extracted text ---');
      console.log(result.text);
      console.log('--- end ---');
      for (const p of checkOrder(result.text)) failures.push(`${format}: ${p}`);
    } catch (err) {
      const msg = `${format}: ${(err as Error).message}`;
      console.error(msg);
      failures.push(msg);
    }
  }

  console.log('');
  if (failures.length === 0) {
    console.log('doc:render-check PASSED');
    return 0;
  }
  console.error(`doc:render-check FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
