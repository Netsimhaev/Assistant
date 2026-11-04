/**
 * Renders a validated XlsxSpec to a real workbook: native formulas with cached
 * results (from evaluateWorkbook), RTL for Hebrew, no VBA / links / defined names.
 * Cells are placed exactly by `layoutSheet` — validation evaluated that layout.
 *
 * Format rules (deterministic):
 *  - money (MAJOR units): ILS `"₪"#,##0`, USD `"$"#,##0`, EUR `"€"#,##0`, other `#,##0 "CODE"`;
 *    if any value in the column has fractions, `.00` is added to the integer part.
 *  - percent (fractions): `0%`, or `0.0%` / `0.00%` — the fewest decimals that show every value exactly.
 *  - dates: Excel dates, `dd/mm/yyyy` for both languages.
 */
import ExcelJS from 'exceljs';
import type { AccentColor, XlsxSpec } from '../domain/document-spec.js';
import { SpecRenderError } from './render-error.js';
import { evaluateWorkbook, type EvalValue } from './formula.js';
import { layoutSheet, toEvalSheet } from './xlsx-layout.js';

export const ACCENT_HEX: Record<AccentColor, string> = {
  navy: '1F3A5F',
  teal: '14808A',
  green: '2E7D32',
  burgundy: '7B1E3A',
  gray: '5F6368',
  orange: 'D9730D',
};

const FONT = 'Arial';
const MAX_WIDTH = 60;
const MIN_WIDTH = 8;
const DATE_FORMAT = 'dd/mm/yyyy';

export function moneyFormat(currency: string, decimals: boolean): string {
  const d = decimals ? '.00' : '';
  switch (currency) {
    case 'ILS': return `"₪"#,##0${d}`;
    case 'USD': return `"$"#,##0${d}`;
    case 'EUR': return `"€"#,##0${d}`;
    default: return `#,##0${d} "${currency.replace(/"/g, '')}"`;
  }
}

function percentFormat(values: number[]): string {
  for (const dec of [0, 1, 2]) {
    const f = 10 ** dec;
    if (values.every((v) => Math.abs(v * 100 * f - Math.round(v * 100 * f)) < 1e-7)) {
      return dec === 0 ? '0%' : `0.${'0'.repeat(dec)}%`;
    }
  }
  return '0.00%';
}

/** Display length of a number under a column format (separators, symbol, decimals, percent). */
function shownLength(n: number, fmt: string | undefined): number {
  if (fmt === undefined) return String(n).length;
  const dec = (fmt.match(/.(0+)/)?.[1] ?? '').length;
  const pct = fmt.includes('%');
  const body = (pct ? n * 100 : n).toLocaleString('en-US', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
  const symbol = fmt.includes('"') ? (fmt.match(/"([^"]*)"/)?.[1] ?? '').length + 1 : 0;
  return body.length + symbol + (pct ? 1 : 0);
}

const isErr = (v: EvalValue): v is { error: never } => typeof v === 'object';

export async function renderXlsx(
  spec: XlsxSpec,
  options: { currency: string },
): Promise<Buffer> {
  const evaluation = evaluateWorkbook(spec.sheets.map(toEvalSheet));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'העוזרת';
  wb.title = spec.title;
  const rtl = spec.language === 'he';
  const accent = ACCENT_HEX[spec.style.accent];

  for (const sheet of spec.sheets) {
    const ws = wb.addWorksheet(sheet.name, { views: [{ rightToLeft: rtl }] });
    const placed = layoutSheet(sheet);
    const widths = new Map<number, number>();
    const bump = (col: number, len: number) =>
      widths.set(col, Math.max(widths.get(col) ?? MIN_WIDTH, Math.min(MAX_WIDTH, len + 2)));

    // Resolve values first, so column formats can see formula results.
    const valueOf = new Map<string, EvalValue>();
    for (const p of placed) {
      if (p.cell !== null && 'f' in p.cell) {
        const key = `${sheet.name}!${p.address}`;
        const v = evaluation.values.get(key);
        if (v === undefined || isErr(v) || evaluation.deviated.has(key)) {
          throw new SpecRenderError('formula_error', key);
        }
        valueOf.set(p.address, v);
      }
    }
    const numeric = (p: (typeof placed)[number]): number | null => {
      if (p.cell === null) return null;
      if ('v' in p.cell) return p.cell.v;
      if ('f' in p.cell) {
        const v = valueOf.get(p.address);
        return typeof v === 'number' ? v : null;
      }
      return null;
    };
    const colFormat = new Map<string, string>(); // `${table}:${col}`
    sheet.tables.forEach((table, t) => {
      (table.numberFormat ?? []).forEach((nf, c) => {
        const vals = placed
          .filter((p) => p.table === t && p.column === c && (p.role === 'data' || p.role === 'totals'))
          .map(numeric)
          .filter((x): x is number => x !== null);
        if (nf === 'int') colFormat.set(`${t}:${c}`, '#,##0');
        else if (nf === 'decimal2') colFormat.set(`${t}:${c}`, '#,##0.00');
        else if (nf === 'money') {
          colFormat.set(`${t}:${c}`, moneyFormat(options.currency, vals.some((v) => !Number.isInteger(v))));
        } else colFormat.set(`${t}:${c}`, percentFormat(vals));
      });
    });

    const headerRows: number[] = [];
    for (const p of placed) {
      const cell = ws.getCell(p.address);
      cell.font = { name: FONT, size: 11 };
      const col = cell.col as unknown as number;
      if (p.role === 'title') {
        cell.value = p.text;
        cell.font = { name: FONT, size: 13, bold: true };
      } else if (p.role === 'header') {
        cell.value = p.text;
        cell.font = { name: FONT, size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${accent}` } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        headerRows.push(Number(cell.row));
        bump(col, (p.text ?? '').length);
      } else if (p.cell !== null) {
        const c = p.cell;
        const fmt = colFormat.get(`${p.table}:${p.column}`);
        if ('v' in c) {
          cell.value = c.v;
          if (fmt) cell.numFmt = fmt;
          bump(col, shownLength(c.v, fmt));
        } else if ('t' in c) {
          cell.value = c.t;
          bump(col, c.t.length);
        } else if ('d' in c) {
          const [y, m, d] = c.d.split('-').map(Number) as [number, number, number];
          cell.value = new Date(Date.UTC(y, m - 1, d));
          cell.numFmt = DATE_FORMAT;
          bump(col, 10);
        } else {
          const result = valueOf.get(p.address) as number | string | boolean;
          cell.value = { formula: c.f, result };
          if (fmt && typeof result === 'number') cell.numFmt = fmt;
          bump(col, typeof result === 'number' ? shownLength(result, fmt) : String(result).length);
        }
        if (p.role === 'totals') cell.font = { name: FONT, size: 11, bold: true };
      }
    }
    for (const [col, w] of widths) ws.getColumn(col).width = w;
    const first = headerRows.length > 0 ? Math.min(...headerRows) : 0;
    if (first > 0) ws.views = [{ rightToLeft: rtl, state: 'frozen', ySplit: first }];
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
