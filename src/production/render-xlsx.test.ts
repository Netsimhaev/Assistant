import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { XlsxSpec } from '../domain/document-spec.js';
import { evaluateWorkbook } from './formula.js';
import { SpecRenderError } from './render-error.js';
import { renderXlsx } from './render-xlsx.js';
import { toEvalSheet } from './xlsx-layout.js';

const src = { kind: 'instruction' } as const;

function spec(over: Record<string, unknown> = {}): XlsxSpec {
  return XlsxSpec.parse({
    format: 'xlsx',
    kind: 'price_list',
    language: 'he',
    title: 'מחירון',
    filename: 'מחירון',
    style: { theme: 'clean', accent: 'navy' },
    sources: [src],
    sheets: [
      {
        name: 'מחירון',
        tables: [
          {
            header: ['פריט', 'מחיר', 'הנחה', 'תאריך'],
            rows: [
              [{ t: 'כיסא' }, { v: 1890, src }, { v: 0.15, src }, { d: '2026-11-03' }],
              [{ t: 'שולחן' }, { v: 3200, src }, { v: 0.1, src }, { d: '2026-11-04' }],
            ],
            totals: [{ t: 'סה"כ' }, { f: 'SUM(B2:B3)' }, { f: 'AVERAGE(C2:C3)' }, { t: '' }],
            numberFormat: ['int', 'money', 'percent', 'int'],
          },
        ],
      },
    ],
    ...over,
  });
}

async function read(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe('renderXlsx', () => {
  it('he sheet is rightToLeft, en sheet is not', async () => {
    const he = await read(await renderXlsx(spec(), { currency: 'ILS' }));
    const en = await read(await renderXlsx(spec({ language: 'en' }), { currency: 'ILS' }));
    expect(he.worksheets[0]?.views[0]?.rightToLeft).toBe(true);
    expect(en.worksheets[0]?.views[0]?.rightToLeft).toBeFalsy();
  });

  it('formula cells carry formula and cached result equal to evaluateWorkbook', async () => {
    const s = spec();
    const ev = evaluateWorkbook(s.sheets.map(toEvalSheet));
    const ws = (await read(await renderXlsx(s, { currency: 'ILS' }))).worksheets[0]!;
    const b4 = ws.getCell('B4').value as { formula: string; result: number };
    expect(b4.formula).toBe('SUM(B2:B3)');
    expect(b4.result).toBe(ev.values.get('מחירון!B4'));
    expect(b4.result).toBe(5090);
    const c4 = ws.getCell('C4').value as { result: number };
    expect(c4.result).toBeCloseTo(0.125);
  });

  it('money column has the currency format; percent and date formats apply', async () => {
    const ws = (await read(await renderXlsx(spec(), { currency: 'ILS' }))).worksheets[0]!;
    expect(ws.getCell('B2').numFmt).toBe('"₪"#,##0');
    expect(ws.getCell('B4').numFmt).toBe('"₪"#,##0');
    expect(ws.getCell('C2').numFmt).toBe('0.0%'); // 12.5% average needs one decimal
    expect(ws.getCell('D2').numFmt).toBe('dd/mm/yyyy');
    const usd = (await read(await renderXlsx(spec(), { currency: 'USD' }))).worksheets[0]!;
    expect(usd.getCell('B2').numFmt).toBe('"$"#,##0');
    const chf = (await read(await renderXlsx(spec(), { currency: 'CHF' }))).worksheets[0]!;
    expect(chf.getCell('B2').numFmt).toBe('#,##0 "CHF"');
  });

  it('header is bold, accent-filled, frozen; font is Arial', async () => {
    const ws = (await read(await renderXlsx(spec(), { currency: 'ILS' }))).worksheets[0]!;
    const h = ws.getCell('A1');
    expect(h.font?.bold).toBe(true);
    expect(h.font?.name).toBe('Arial');
    expect((h.fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF1F3A5F');
    expect(ws.views[0]?.state).toBe('frozen');
    expect((ws.views[0] as { ySplit?: number }).ySplit).toBe(1);
  });

  it('no definedNames, no vba part, no external links in the zip; creator set', async () => {
    const buf = await renderXlsx(spec(), { currency: 'ILS' });
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    expect(names.length).toBeGreaterThan(3);
    expect(names.some((n) => /vba|externalLink/i.test(n))).toBe(false);
    const wbXml = await zip.file('xl/workbook.xml')!.async('string');
    expect(wbXml).not.toContain('definedName');
    const props = await zip.file('docProps/core.xml')!.async('string');
    expect(props).toContain('העוזרת');
  });

  it('throws SpecRenderError formula_error for an erroring formula (renderer ran)', async () => {
    const bad = spec({
      sheets: [
        {
          name: 'S',
          tables: [{ header: ['a'], rows: [[{ v: 1, src }], [{ f: 'A2/0' }]] }],
        },
      ],
    });
    const err = await renderXlsx(bad, { currency: 'ILS' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecRenderError);
    expect((err as SpecRenderError).code).toBe('formula_error');
    expect((err as SpecRenderError).where).toBe('S!A3');
  });
});
