/**
 * Where every cell of an `XlsxSheet` lands on the worksheet — the one
 * definition shared by validation (which evaluates the formulas) and the
 * renderer (which writes them). A formula names cells by A1 address, so the
 * address a spec cell gets is part of what the formula means: two layouts
 * would be two different workbooks, one validated and the other shipped.
 *
 * The layout is fixed and positional, from A1, columns from A:
 *   - a table's `title`, when present, is one row (column A);
 *   - then its header row; then its data rows; then its `totals` row, if any;
 *   - one blank row separates consecutive tables.
 */
import type { Cell, XlsxSheet } from '../domain/document-spec.js';
import { formatAddress, type EvalSheet, type SheetCellInput } from './formula.js';

export type PlacedRole = 'title' | 'header' | 'data' | 'totals';

export interface PlacedCell {
  /** Canonical A1 address on the sheet. */
  address: string;
  role: PlacedRole;
  /** 0-based table index within the sheet. */
  table: number;
  /** 1-based data row within the table (data cells only; 0 otherwise). */
  dataRow: number;
  /** 0-based column within the table. */
  column: number;
  /** The spec cell, for data and totals cells; header/title carry `text`. */
  cell: Cell | null;
  text: string | null;
}

export function layoutSheet(sheet: XlsxSheet): PlacedCell[] {
  const out: PlacedCell[] = [];
  let row = 1;
  sheet.tables.forEach((table, t) => {
    if (t > 0) row += 1; // the blank separator row
    const at = (col: number) => formatAddress({ col: col + 1, row });
    if (table.title !== undefined) {
      out.push({ address: at(0), role: 'title', table: t, dataRow: 0, column: 0, cell: null, text: table.title });
      row += 1;
    }
    table.header.forEach((text, c) => {
      out.push({ address: at(c), role: 'header', table: t, dataRow: 0, column: c, cell: null, text });
    });
    row += 1;
    table.rows.forEach((cells, r) => {
      cells.forEach((cell, c) => {
        out.push({ address: at(c), role: 'data', table: t, dataRow: r + 1, column: c, cell, text: null });
      });
      row += 1;
    });
    if (table.totals !== undefined) {
      table.totals.forEach((cell, c) => {
        out.push({ address: at(c), role: 'totals', table: t, dataRow: 0, column: c, cell, text: null });
      });
      row += 1;
    }
  });
  return out;
}

const DAY_MS = 86_400_000;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/** Excel's 1900-system serial for a `YYYY-MM-DD` date (valid from 1900-03-01). */
export function excelDateSerial(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - EXCEL_EPOCH_MS) / DAY_MS);
}

/** What the evaluator sees in a placed cell: a date is its serial, as in Excel. */
export function evalInput(placed: PlacedCell): SheetCellInput {
  if (placed.cell === null) return placed.text;
  const cell = placed.cell;
  if ('v' in cell) return cell.v;
  if ('t' in cell) return cell.t;
  if ('d' in cell) return excelDateSerial(cell.d);
  return { f: cell.f };
}

export function toEvalSheet(sheet: XlsxSheet): EvalSheet {
  const cells = new Map<string, SheetCellInput>();
  for (const placed of layoutSheet(sheet)) cells.set(placed.address, evalInput(placed));
  return { name: sheet.name, cells };
}
