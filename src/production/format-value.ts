import { formatMinor } from '../util/money.js';
import type { Cell } from '../domain/document-spec.js';
import { SpecRenderError } from './render-error.js';

export type CellNumberFormat = 'int' | 'money' | 'percent' | 'decimal2';

/**
 * Format a number for display in a document body (docx/pdf/pptx). Money values
 * are MAJOR units as the spec writes them; percent values are fractions.
 * The xlsx renderer does not use this — it keeps native number formats.
 */
export function formatNumber(value: number, format: CellNumberFormat | undefined, currency: string): string {
  switch (format) {
    case 'money':
      return formatMinor(Math.round(value * 100), currency);
    case 'percent':
      return `${(value * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
    case 'int':
      return Math.round(value).toLocaleString('en-US');
    case 'decimal2':
      return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    default:
      return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
  }
}

/** `2026-11-03` -> `03/11/2026`. */
export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Text of one cell as a document body shows it. A formula cell is refused. */
export function formatCell(
  cell: Cell,
  format: CellNumberFormat | undefined,
  currency: string,
  where: string,
): string {
  if ('f' in cell) throw new SpecRenderError('formula_in_document', where);
  if ('v' in cell) return formatNumber(cell.v, format, currency);
  if ('d' in cell) return formatIsoDate(cell.d);
  return cell.t;
}
