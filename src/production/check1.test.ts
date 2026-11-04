import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { describe, expect, it } from 'vitest';
import type { DocxSpec, PdfSpec, PptxSpec, XlsxSpec } from '../domain/document-spec.js';
import { CHECK1_HE, runCheck1, type Check1Code, type Check1Result } from './check1.js';
import { renderDocx } from './render-docx.js';
import { renderFooterTemplate, renderHtml, type PdfAssets } from './render-html.js';
import { renderPdf, type PdfPrinter } from './render-pdf.js';
import { renderPptx } from './render-pptx.js';
import type { ImageLoader } from './render-shared.js';
import { renderXlsx } from './render-xlsx.js';
import { CONTRACT_DISCLAIMER_HE, type GroundingSources } from './validate-spec.js';

const TODAY = '2026-11-04';
const SRC = { kind: 'instruction' } as const;
const noImages: ImageLoader = async () => null;

/** Review Focus 1: the strings a Hebrew document gets wrong first, and one sentence carrying them all. */
const FOCUS = ['שולחן 160 ס"מ', 'Office Pro', '₪1,890', '39%', '(ראה סעיף 4.2)'] as const;
const SENTENCE = 'שולחן 160 ס"מ מדגם Office Pro עולה ₪1,890 אחרי הנחה של 39% (ראה סעיף 4.2)';

const sources: GroundingSources = {
  instructionText: `${SENTENCE}. העלות 1,150 והמכירה 1,890, מחיר שולחן 1,890 ש"ח ומחיר כיסא 450 ש"ח, הנחה 39% ו-15%.`,
  documents: [],
  memories: [],
};

const common = {
  language: 'he' as const,
  title: 'הצעת מחיר לריהוט',
  filename: 'offer',
  style: { theme: 'clean' as const, accent: 'navy' as const },
  sources: [SRC],
};

const contractDocx: DocxSpec = {
  format: 'docx',
  ...common,
  kind: 'contract',
  title: 'חוזה אספקת ריהוט',
  legalBasis: [{ law: 'חוק החוזים (חלק כללי), התשל"ג-1973' }],
  blocks: [
    { type: 'heading', level: 1, text: 'הצדדים' },
    { type: 'paragraph', text: 'בין החברה המספקת לבין הלקוח הקונה' },
    { type: 'heading', level: 1, text: 'הגדרות' },
    { type: 'clause', title: 'המוצר', text: SENTENCE },
    { type: 'clause', title: 'מועד האספקה', text: 'האספקה תתבצע בתיאום מראש' },
    { type: 'clause', title: 'אחריות', text: 'אחריות מלאה על כל פגם' },
    { type: 'clause', title: 'תשלום', text: 'התשלום יבוצע בהעברה בנקאית\nהמחיר כולל מע"מ והובלה' },
    {
      type: 'table',
      header: ['פריט', 'מחיר', 'הנחה'],
      rows: [[{ t: 'שולחן 160 ס"מ' }, { v: 1890, src: SRC }, { v: 0.39, src: SRC }]],
      numberFormat: ['int', 'money', 'percent'],
    },
    { type: 'heading', level: 1, text: 'חתימות' },
  ],
};
const contractPdf: PdfSpec = { ...contractDocx, format: 'pdf' };

const profitXlsx: XlsxSpec = {
  format: 'xlsx',
  ...common,
  kind: 'profit_table',
  title: 'טבלת רווח',
  sheets: [
    {
      name: 'רווח',
      tables: [
        {
          title: SENTENCE,
          header: ['פריט', 'עלות', 'מכירה', 'רווח'],
          rows: [
            [{ t: 'שולחן 160 ס"מ' }, { v: 1150, src: SRC }, { v: 1890, src: SRC }, { f: 'C3-B3' }],
            [{ t: 'כיסא Office Pro' }, { v: 450, src: SRC }, { v: 1890, src: SRC }, { f: 'C4-B4' }],
          ],
          totals: [{ t: 'סה"כ רווח' }, { t: '' }, { t: '' }, { f: 'SUM(D3:D4)' }],
          numberFormat: ['int', 'money', 'money', 'money'],
        },
      ],
    },
  ],
};

const profitPptx: PptxSpec = {
  format: 'pptx',
  ...common,
  kind: 'profit_table',
  title: 'טבלת רווח',
  slides: [
    { type: 'title', title: 'טבלת רווח לריהוט' },
    { type: 'paragraph', title: 'ההצעה', text: SENTENCE },
    { type: 'titleBullets', title: 'עיקרי ההצעה', bullets: ['מחיר שולחן 1,890 ש"ח', 'הנחה של 39% על Office Pro'] },
    {
      type: 'table',
      title: 'מחירים',
      header: ['פריט', 'מחיר'],
      rows: [[{ t: 'שולחן 160 ס"מ' }, { v: 1890, src: SRC }]],
      numberFormat: ['int', 'money'],
    },
    {
      type: 'chart',
      title: 'גרף מחירים',
      chartType: 'bar',
      header: ['פריט', 'מחיר'],
      rows: [
        [{ t: 'שולחן' }, { v: 1890, src: SRC }],
        [{ t: 'כיסא' }, { v: 450, src: SRC }],
      ],
      column: 1,
      labelColumn: 0,
    },
  ],
};

// ---------------------------------------------------------------- extraction stand-ins

/** docx → mammoth raw text (LibreOffice is not available in tests). */
async function docxText(bytes: Buffer): Promise<string> {
  return (await mammoth.extractRawText({ buffer: bytes })).value;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** pptx → every `<a:p>` of every slide, in slide order. */
async function pptxText(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const lines: string[] = [];
  for (const name of slides) {
    const xml = await zip.file(name)!.async('string');
    for (const p of xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []) {
      lines.push(decode([...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')));
    }
  }
  return lines.join('\n');
}

/** xlsx → every row, cells as a viewer formats them. */
async function xlsxText(bytes: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const lines: string[] = [];
  const show = (v: unknown, fmt: string | undefined): string => {
    if (v instanceof Date) {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${p(v.getUTCDate())}/${p(v.getUTCMonth() + 1)}/${v.getUTCFullYear()}`;
    }
    if (typeof v !== 'number') return v === null || v === undefined ? '' : String(v);
    if (fmt?.includes('%')) return `${Math.round(v * 10000) / 100}%`;
    const dec = fmt?.includes('.00') ? 2 : 0;
    const body = v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    return fmt?.includes('₪') ? `₪${body}` : body;
  };
  for (const ws of wb.worksheets) {
    ws.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell((cell) => {
        const v = cell.value as unknown;
        const value = v !== null && typeof v === 'object' && 'formula' in v ? (v as unknown as { result: unknown }).result : v;
        cells.push(show(value, cell.numFmt));
      });
      lines.push(cells.join(' '));
    });
  }
  return lines.join('\n');
}

/** A minimal PDF a stub printer returns; what it would say is passed as `rendered.text`. */
const FIXTURE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);
const FONT = 'data:font/ttf;base64,AAEAAA==';
const assets: PdfAssets = {
  fonts: { hebrewRegular: FONT, hebrewBold: FONT, latinRegular: FONT, latinBold: FONT },
  images: new Map(),
};
const stubPrinter: PdfPrinter = async () => FIXTURE_PDF;

/** What a correct text extraction of the printed page says: body text in reading order, then the footer. */
function htmlText(html: string): string {
  const body = html
    .replace(/^[\s\S]*<body>/, '')
    .replace(/<\/body>[\s\S]*$/, '')
    .replace(/<style>[\s\S]*?<\/style>/g, '');
  return decode(body.replace(/<\/(p|h\d|tr|td|th|div)>/g, '\n').replace(/<[^>]+>/g, ''));
}

async function buildPdf(spec: PdfSpec) {
  const bytes = await renderPdf(spec, { printer: stubPrinter, assets, currency: 'ILS' });
  const html = renderHtml(spec, assets, { currency: 'ILS' });
  const footer = htmlText(`<body>${renderFooterTemplate(spec, assets)}</body>`).replace(/\s*\/\s*$/, ' 1 / 1');
  return { bytes, text: `${htmlText(html)}\n${footer}` };
}

const rendered = (text: string, over: Partial<{ pageCount: number; textTruncated: boolean }> = {}) => ({
  text,
  pageCount: 1,
  textTruncated: false,
  ...over,
});

const codes = (r: Check1Result): Check1Code[] => r.findings.map((f) => f.code);

async function rezip(bytes: Buffer, edit: (zip: JSZip) => Promise<void>): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  await edit(zip);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

async function replaceIn(bytes: Buffer, part: string, from: string | RegExp, to: string): Promise<Buffer> {
  return rezip(bytes, async (zip) => {
    const xml = await zip.file(part)!.async('string');
    const next = xml.replace(from, to);
    expect(next).not.toBe(xml); // the tamper really happened
    zip.file(part, next);
  });
}

function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function expectFocusInOrder(text: string): void {
  const t = flat(text);
  const at = t.indexOf(SENTENCE);
  expect(at).toBeGreaterThanOrEqual(0);
  let from = at;
  for (const s of FOCUS) {
    const i = t.indexOf(s, from);
    expect(i, s).toBeGreaterThanOrEqual(from);
    from = i + s.length;
  }
}

// ---------------------------------------------------------------- tests

describe('runCheck1', () => {
  it('every code has a fixed Hebrew string, and findings carry it', async () => {
    for (const he of Object.values(CHECK1_HE)) expect(he).toMatch(/[֐-׿]/);
    const bytes = await renderDocx(contractDocx, { currency: 'ILS', images: noImages });
    const r = await runCheck1({
      spec: contractDocx,
      bytes,
      sources,
      rendered: rendered(await docxText(bytes), { pageCount: 61 }),
      today: TODAY,
    });
    const f = r.findings.find((x) => x.code === 'cap_exceeded');
    expect(f?.he).toBe(CHECK1_HE.cap_exceeded);
    expect(r.passed).toBe(false);
  });

  it('a passing file has findings = []', async () => {
    const bytes = await renderDocx(contractDocx, { currency: 'ILS', images: noImages });
    const r = await runCheck1({ spec: contractDocx, bytes, sources, rendered: rendered(await docxText(bytes)), today: TODAY });
    expect(r.findings).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('an English document passes with LTR direction', async () => {
    const en: DocxSpec = {
      ...contractDocx,
      language: 'en',
      kind: 'letter',
      title: 'Price offer',
      legalBasis: undefined as never,
      blocks: [
        { type: 'heading', level: 1, text: 'Our offer' },
        { type: 'paragraph', text: 'The Office Pro desk costs 1,890 after a 39% discount' },
      ],
    };
    delete (en as { legalBasis?: unknown }).legalBasis;
    const bytes = await renderDocx(en, { currency: 'ILS', images: noImages });
    const r = await runCheck1({ spec: en, bytes, sources, rendered: rendered(await docxText(bytes)), today: TODAY });
    expect(r.findings).toEqual([]);
  });

  describe('Review Focus 1: the mixed-run strings pass on a correctly built file', () => {
    it('docx (contract)', async () => {
      const bytes = await renderDocx(contractDocx, { currency: 'ILS', images: noImages });
      const text = await docxText(bytes);
      expectFocusInOrder(text);
      const r = await runCheck1({ spec: contractDocx, bytes, sources, rendered: rendered(text), today: TODAY });
      expect(r.findings).toEqual([]);
    });

    it('pdf (contract)', async () => {
      const { bytes, text } = await buildPdf(contractPdf);
      expectFocusInOrder(text);
      const r = await runCheck1({ spec: contractPdf, bytes, sources, rendered: rendered(text), today: TODAY });
      expect(r.findings).toEqual([]);
    });

    it('xlsx (profit_table)', async () => {
      const bytes = await renderXlsx(profitXlsx, { currency: 'ILS' });
      const text = await xlsxText(bytes);
      expectFocusInOrder(text);
      const r = await runCheck1({ spec: profitXlsx, bytes, sources, rendered: rendered(text), today: TODAY });
      expect(r.findings).toEqual([]);
    });

    it('pptx (profit_table, with a native chart)', async () => {
      const { buffer: bytes } = await renderPptx(profitPptx, { currency: 'ILS', images: noImages });
      const text = await pptxText(bytes);
      expectFocusInOrder(text);
      const r = await runCheck1({ spec: profitPptx, bytes, sources, rendered: rendered(text), today: TODAY });
      expect(r.findings).toEqual([]);
    });
  });

  describe('xlsx: formulas recomputed from the file', () => {
    it('a workbook whose cached result was tampered → formula_mismatch', async () => {
      const good = await renderXlsx(profitXlsx, { currency: 'ILS' });
      const bytes = await replaceIn(good, 'xl/worksheets/sheet1.xml', /(<f>SUM\(D3:D4\)<\/f><v>)\d+(<\/v>)/, '$19999$2');
      const r = await runCheck1({ spec: profitXlsx, bytes, sources, rendered: rendered(await xlsxText(good)), today: TODAY });
      expect(r.findings).toContainEqual({ code: 'formula_mismatch', where: 'sheet 1 D5', he: CHECK1_HE.formula_mismatch });
    });

    it('a formula that divides by zero (an empty divisor) → formula_error', async () => {
      const good = await renderXlsx(profitXlsx, { currency: 'ILS' });
      const bytes = await replaceIn(good, 'xl/worksheets/sheet1.xml', '<f>C3-B3</f>', '<f>C3/F9</f>');
      const r = await runCheck1({ spec: profitXlsx, bytes, sources, rendered: rendered(await xlsxText(good)), today: TODAY });
      expect(r.findings).toContainEqual(expect.objectContaining({ code: 'formula_error', where: 'sheet 1 D3' }));
    });

    it('a formula that references itself → formula_error', async () => {
      const good = await renderXlsx(profitXlsx, { currency: 'ILS' });
      const bytes = await replaceIn(good, 'xl/worksheets/sheet1.xml', '<f>C3-B3</f>', '<f>C3-D3</f>');
      const r = await runCheck1({ spec: profitXlsx, bytes, sources, rendered: rendered(await xlsxText(good)), today: TODAY });
      expect(r.findings).toContainEqual(expect.objectContaining({ code: 'formula_error', where: 'sheet 1 D3' }));
    });

    it('a formula that references an empty cell → formula_error, even when the value is unchanged', async () => {
      const good = await renderXlsx(profitXlsx, { currency: 'ILS' });
      const bytes = await replaceIn(good, 'xl/worksheets/sheet1.xml', '<f>C3-B3</f>', '<f>C3-B3+F9</f>');
      const r = await runCheck1({ spec: profitXlsx, bytes, sources, rendered: rendered(await xlsxText(good)), today: TODAY });
      expect(r.findings).toContainEqual(expect.objectContaining({ code: 'formula_error', where: 'sheet 1 D3' }));
      expect(codes(r)).not.toContain('formula_mismatch'); // same value: only the empty reference refused it
    });

    it('a workbook with a defined name → unsafe_part', async () => {
      const good = await renderXlsx(profitXlsx, { currency: 'ILS' });
      const bytes = await replaceIn(
        good,
        'xl/workbook.xml',
        '</sheets>',
        '</sheets><definedNames><definedName name="x">\'רווח\'!$A$1</definedName></definedNames>',
      );
      const r = await runCheck1({ spec: profitXlsx, bytes, sources, rendered: rendered(await xlsxText(good)), today: TODAY });
      expect(codes(r)).toEqual(['unsafe_part']);
    });

    it('a Hebrew sheet that is not rightToLeft → direction_wrong', async () => {
      const bytes = await renderXlsx({ ...profitXlsx, language: 'en' }, { currency: 'ILS' });
      const r = await runCheck1({ spec: profitXlsx, bytes, sources, rendered: rendered(await xlsxText(bytes)), today: TODAY });
      expect(r.findings).toEqual([{ code: 'direction_wrong', where: 'sheet 1', he: CHECK1_HE.direction_wrong }]);
    });
  });

  describe('docx', () => {
    it('a reversed Hebrew line in the extracted text → order_reversed', async () => {
      const bytes = await renderDocx(contractDocx, { currency: 'ILS', images: noImages });
      const text = (await docxText(bytes)).replace('בין החברה המספקת לבין הלקוח הקונה', 'הקונה הלקוח לבין המספקת החברה בין');
      const r = await runCheck1({ spec: contractDocx, bytes, sources, rendered: rendered(text), today: TODAY });
      expect(r.findings).toEqual([{ code: 'order_reversed', where: 'block 2', he: CHECK1_HE.order_reversed }]);
    });

    it('"1,890" extracted as "098,1" → digits_reversed', async () => {
      const bytes = await renderDocx(contractDocx, { currency: 'ILS', images: noImages });
      const text = (await docxText(bytes)).replace('עולה ₪1,890', 'עולה ₪098,1');
      const r = await runCheck1({ spec: contractDocx, bytes, sources, rendered: rendered(text), today: TODAY });
      expect(r.findings).toContainEqual({ code: 'digits_reversed', where: 'block 4', he: CHECK1_HE.digits_reversed });
      expect(codes(r)).not.toContain('order_reversed');
    });

    it('a run the extracted text simply lacks → text_missing', async () => {
      const bytes = await renderDocx(contractDocx, { currency: 'ILS', images: noImages });
      const text = (await docxText(bytes)).replace('אחריות מלאה על כל פגם', '');
      const r = await runCheck1({ spec: contractDocx, bytes, sources, rendered: rendered(text), today: TODAY });
      expect(r.findings).toEqual([{ code: 'text_missing', where: 'block 6', he: CHECK1_HE.text_missing }]);
    });

    it('a number on the page that nothing grounds → ungrounded_number', async () => {
      const bytes = await renderDocx(contractDocx, { currency: 'ILS', images: noImages });
      const text = `${await docxText(bytes)}\nתוספת של 7,777 ש"ח`;
      const r = await runCheck1({ spec: contractDocx, bytes, sources, rendered: rendered(text), today: TODAY });
      expect(r.findings).toEqual([
        { code: 'ungrounded_number', where: 'rendered text: 7777', he: CHECK1_HE.ungrounded_number },
      ]);
    });

    it('contract without disclaimer (render bypassed) → missing_structure', async () => {
      const bytes = await renderDocx({ ...contractDocx, kind: 'letter' }, { currency: 'ILS', images: noImages });
      const r = await runCheck1({ spec: contractDocx, bytes, sources, rendered: rendered(await docxText(bytes)), today: TODAY });
      expect(r.findings).toContainEqual({ code: 'missing_structure', where: 'disclaimer', he: CHECK1_HE.missing_structure });
      expect(r.findings).toContainEqual({ code: 'missing_structure', where: 'legal basis', he: CHECK1_HE.missing_structure });
    });

    it('docx with an extra word/vbaProject.bin part → unsafe_part', async () => {
      const good = await renderDocx(contractDocx, { currency: 'ILS', images: noImages });
      const bytes = await rezip(good, async (zip) => {
        zip.file('word/vbaProject.bin', Buffer.from('not really vba'));
      });
      const r = await runCheck1({ spec: contractDocx, bytes, sources, rendered: rendered(await docxText(good)), today: TODAY });
      expect(r.findings).toEqual([{ code: 'unsafe_part', where: 'part word/vbaProject.bin', he: CHECK1_HE.unsafe_part }]);
    });

    it('a relationship with TargetMode="External" → unsafe_part', async () => {
      const good = await renderDocx(contractDocx, { currency: 'ILS', images: noImages });
      const bytes = await replaceIn(
        good,
        'word/_rels/document.xml.rels',
        '</Relationships>',
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/x" TargetMode="External"/></Relationships>',
      );
      const r = await runCheck1({ spec: contractDocx, bytes, sources, rendered: rendered(await docxText(good)), today: TODAY });
      expect(r.findings).toEqual([{ code: 'unsafe_part', where: 'part word/_rels/document.xml.rels', he: CHECK1_HE.unsafe_part }]);
    });

    it('a Hebrew document rendered without bidi paragraphs → direction_wrong', async () => {
      const bytes = await renderDocx({ ...contractDocx, language: 'en' }, { currency: 'ILS', images: noImages });
      const r = await runCheck1({ spec: contractDocx, bytes, sources, rendered: rendered(await docxText(bytes)), today: TODAY });
      expect(codes(r)).toContain('direction_wrong');
    });

    it('a bidi control the renderer did not insert → bidi_control', async () => {
      const spec: DocxSpec = {
        ...contractDocx,
        blocks: contractDocx.blocks.map((b, i) => (i === 1 ? { type: 'paragraph', text: 'בין החברה המספקת‮ לבין הלקוח הקונה' } : b)),
      };
      const bytes = await renderDocx(spec, { currency: 'ILS', images: noImages });
      const r = await runCheck1({ spec, bytes, sources, rendered: rendered(await docxText(bytes)), today: TODAY });
      expect(r.findings).toEqual([{ code: 'bidi_control', where: 'word/document.xml', he: CHECK1_HE.bidi_control }]);
    });
  });

  it('a bidi control inside a workbook cell or a slide → bidi_control', async () => {
    const xspec: XlsxSpec = {
      ...profitXlsx,
      sheets: [
        {
          ...profitXlsx.sheets[0]!,
          tables: [{ ...profitXlsx.sheets[0]!.tables[0]!, header: ['פריט‮', 'עלות', 'מכירה', 'רווח'] }],
        },
      ],
    };
    const xbytes = await renderXlsx(xspec, { currency: 'ILS' });
    const x = await runCheck1({ spec: xspec, bytes: xbytes, sources, rendered: rendered(await xlsxText(xbytes)), today: TODAY });
    expect(x.findings).toEqual([{ code: 'bidi_control', where: 'workbook', he: CHECK1_HE.bidi_control }]);

    const pspec: PptxSpec = { ...profitPptx, slides: [{ type: 'title', title: 'טבלת רווח⁦ לריהוט' }] };
    const { buffer: pbytes } = await renderPptx(pspec, { currency: 'ILS', images: noImages });
    const p = await runCheck1({ spec: pspec, bytes: pbytes, sources, rendered: rendered(await pptxText(pbytes)), today: TODAY });
    expect(p.findings).toEqual([{ code: 'bidi_control', where: 'slide 1', he: CHECK1_HE.bidi_control }]);
  });

  describe('pptx', () => {
    it('a Hebrew deck whose text bodies are not rtl → direction_wrong', async () => {
      const { buffer: bytes } = await renderPptx({ ...profitPptx, language: 'en' }, { currency: 'ILS', images: noImages });
      const r = await runCheck1({ spec: profitPptx, bytes, sources, rendered: rendered(await pptxText(bytes)), today: TODAY });
      expect(r.findings).toContainEqual({ code: 'direction_wrong', where: 'slide 1', he: CHECK1_HE.direction_wrong });
    });

    it('an embedded chart workbook carrying an extra part → unsafe_part', async () => {
      const { buffer: good } = await renderPptx(profitPptx, { currency: 'ILS', images: noImages });
      let name = '';
      const bytes = await rezip(good, async (zip) => {
        name = Object.keys(zip.files).find((n) => /^ppt\/embeddings\/.+\.xlsx$/.test(n))!;
        const inner = await JSZip.loadAsync(await zip.file(name)!.async('nodebuffer'));
        inner.file('xl/vbaProject.bin', Buffer.from('x'));
        zip.file(name, await inner.generateAsync({ type: 'nodebuffer' }));
      });
      const r = await runCheck1({ spec: profitPptx, bytes, sources, rendered: rendered(await pptxText(good)), today: TODAY });
      expect(r.findings).toEqual([
        {
          code: 'unsafe_part',
          where: `part ${name} > xl/vbaProject.bin`,
          he: CHECK1_HE.unsafe_part,
        },
      ]);
    });
  });

  describe('pdf', () => {
    it('contract without the disclaimer on the page → missing_structure', async () => {
      const { bytes, text } = await buildPdf(contractPdf);
      const r = await runCheck1({
        spec: contractPdf,
        bytes,
        sources,
        rendered: rendered(text.replace(CONTRACT_DISCLAIMER_HE, '')),
        today: TODAY,
      });
      expect(r.findings).toEqual([{ code: 'missing_structure', where: 'disclaimer', he: CHECK1_HE.missing_structure }]);
    });

    it('a PDF carrying JavaScript → unsafe_part', async () => {
      const { text } = await buildPdf(contractPdf);
      const bytes = Buffer.from(
        FIXTURE_PDF.toString('latin1').replace('/Type /Catalog', '/Type /Catalog /OpenAction << /S /J#61vaScript /JS (x) >>'),
        'latin1',
      );
      const r = await runCheck1({ spec: contractPdf, bytes, sources, rendered: rendered(text), today: TODAY });
      expect(r.findings).toContainEqual(expect.objectContaining({ code: 'unsafe_part', where: 'pdf /OpenAction' }));
      expect(r.findings).toContainEqual(expect.objectContaining({ code: 'unsafe_part', where: 'pdf /JavaScript' }));
    });

    it('a bidi control in the extracted text → bidi_control', async () => {
      const { bytes, text } = await buildPdf(contractPdf);
      const r = await runCheck1({ spec: contractPdf, bytes, sources, rendered: rendered(`${text}⁧`), today: TODAY });
      expect(r.findings).toEqual([{ code: 'bidi_control', where: 'rendered text', he: CHECK1_HE.bidi_control }]);
    });
  });

  describe('all formats', () => {
    it('more than 60 pages → cap_exceeded', async () => {
      const { bytes, text } = await buildPdf(contractPdf);
      const r = await runCheck1({ spec: contractPdf, bytes, sources, rendered: rendered(text, { pageCount: 61 }), today: TODAY });
      expect(r.findings).toEqual([{ code: 'cap_exceeded', where: 'document', he: CHECK1_HE.cap_exceeded }]);
      const ok = await runCheck1({ spec: contractPdf, bytes, sources, rendered: rendered(text, { pageCount: 60 }), today: TODAY });
      expect(ok.findings).toEqual([]);
    });

    it('text that was not fully read → text_truncated, and the document does not pass', async () => {
      const { bytes, text } = await buildPdf(contractPdf);
      const r = await runCheck1({ spec: contractPdf, bytes, sources, rendered: rendered(text, { textTruncated: true }), today: TODAY });
      expect(r.findings).toEqual([{ code: 'text_truncated', where: 'document', he: CHECK1_HE.text_truncated }]);
      expect(r.passed).toBe(false);
    });

    it('a spec that does not validate is refused through its own findings', async () => {
      const bytes = await renderDocx(contractDocx, { currency: 'ILS', images: noImages });
      const r = await runCheck1({
        spec: contractDocx,
        bytes,
        sources: { ...sources, instructionText: 'הוראה בלי מספרים' },
        rendered: rendered(await docxText(bytes)),
        today: TODAY,
      });
      expect(codes(r)).toContain('ungrounded_number');
      expect(r.findings.some((f) => f.where.startsWith('block'))).toBe(true); // from validateSpec, not the page
    });

    it('bytes that are not the declared format → file_unreadable', async () => {
      const r = await runCheck1({ spec: profitXlsx, bytes: Buffer.from('nope'), sources, rendered: rendered(''), today: TODAY });
      expect(codes(r)).toContain('file_unreadable');
    });

    it('today is required', async () => {
      const bytes = await renderDocx(contractDocx, { currency: 'ILS', images: noImages });
      await expect(
        runCheck1({ spec: contractDocx, bytes, sources, rendered: rendered(''), today: undefined as unknown as string }),
      ).rejects.toThrow(TypeError);
    });
  });
});
