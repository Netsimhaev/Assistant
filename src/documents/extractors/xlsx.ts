/**
 * The `xlsx` extractor (spec §4.1, caps table §3.4): one `table` artefact
 * per sheet, `partName` set to the sheet's own name.
 *
 * Runs inside the same isolated child every other extractor id runs in
 * (`extract-child.ts`) — this module never touches the database and never
 * opens a socket. `exceljs` does the ZIP+XML parsing; nothing here (or in
 * `exceljs`, per the admitted-dependency review in the spec's §9.1) ever
 * evaluates a formula or runs a macro.
 *
 * **Cached values only.** A formula cell's `.value` getter returns
 * `{ formula, result, ... }` — never that. `.result` is `exceljs`'s own
 * accessor for the cached scalar alone, and reading it is the entire
 * contract: never recompute, only ever read what was last saved with the
 * formula. A formula with no cached result (`.result` is `undefined`)
 * resolves through `effectiveType` to `Null`, which `classifyCell` maps to
 * `{ v: null, t: 'empty' }` — never to a stale guess.
 *
 * **Merged cells expand.** `exceljs` exposes `cell.isMerged` /
 * `cell.master` per cell; `anchorOf` unwraps a merged cell to the anchor
 * that actually holds the value, for any merge shape — a 2-cell pair or a
 * block spanning many rows and columns; there is nothing size-specific
 * about the unwrap. `master.effectiveType` already resolves through a
 * formula anchor the same way a direct formula cell would, so a merged
 * formula anchor is handled by the same code path as an unmerged one.
 */

import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import type { Cell, DocumentArtifact, TableContent } from '../types.js';

const MAX_SHEETS = 50;
const MAX_ROWS_PER_SHEET = 50_000;
const MAX_CELL_CHARS = 32_768;

// Any conformant ZIP stores an entry's path as literal, uncompressed bytes
// in both its local file header and its central directory record —
// compression only ever applies to an entry's *data*, never its name. A
// macro-enabled workbook therefore contains this exact eighteen-character
// ASCII path somewhere in its raw bytes, unconditionally. A full ZIP
// central-directory parse (the way `archive-guard.ts` reads one, for a
// different purpose — bounding an untrusted archive before it is ever
// unpacked) would answer the same question at several times the code, for
// no practical gain: the odds of this literal string appearing by chance
// inside a DEFLATE-compressed stream are astronomically small, and this
// flag is advisory (§4.1), not a security boundary — the archive guard has
// already run, upstream, before this extractor is ever invoked.
const VBA_PROJECT_MARKER = Buffer.from('xl/vbaProject.bin');

async function hasMacroPart(sourcePath: string): Promise<boolean> {
  const buffer = await readFile(sourcePath);
  return buffer.includes(VBA_PROJECT_MARKER);
}

/** The cell that actually holds a value: itself, or a merge's anchor. */
function anchorOf(cell: ExcelJS.Cell): ExcelJS.Cell {
  return cell.isMerged ? cell.master : cell;
}

/**
 * The cell's own scalar, cache-only. `.value` is the right accessor for
 * every value kind except `Formula`, whose `.value` is the
 * `{ formula, result }` object — `.result` is the cached scalar alone.
 */
function scalarOf(cell: ExcelJS.Cell): unknown {
  return cell.type === ExcelJS.ValueType.Formula ? cell.result : cell.value;
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Maps one cell to the shared `{ v, t }` shape. `effectiveType` already
 * resolves a merge to its anchor's type and a formula to its cached
 * result's type (`Null` when there is no cached result) — this function
 * only has to react to what that resolution already settled on.
 */
function classifyCell(cell: ExcelJS.Cell): Cell {
  const anchor = anchorOf(cell);
  const effectiveType = anchor.effectiveType;
  const value = scalarOf(anchor);

  switch (effectiveType) {
    case ExcelJS.ValueType.Null:
      return { v: null, t: 'empty' };
    case ExcelJS.ValueType.Number:
      return { v: value as number, t: 'number' };
    case ExcelJS.ValueType.Boolean:
      return { v: value as boolean, t: 'bool' };
    case ExcelJS.ValueType.Date:
      return { v: toIsoDate(value as Date), t: 'date' };
    case ExcelJS.ValueType.String:
    case ExcelJS.ValueType.SharedString:
      return { v: value as string, t: 'string' };
    default:
      // RichText, Hyperlink, Error, and any future `exceljs` value kind
      // outside this contract's five types. None of Task 1's fixtures
      // carry one of these (see the task report), so this fallback is not
      // exercised by any test. `.text` is `exceljs`'s own universal
      // stringifier for a cell (used by every concrete `Value` subclass's
      // `toString()`), chosen over silently dropping real cell content to
      // `empty` — a value nobody could read is not the same as a value
      // that was never there.
      return { v: anchor.text, t: 'string' };
  }
}

interface SheetGrid {
  rows: Cell[][];
  truncated: boolean;
}

function isRowEmpty(row: Cell[]): boolean {
  return row.every((cell) => cell.t === 'empty');
}

function isColumnEmpty(rows: Cell[][], columnIndex: number): boolean {
  return rows.every((row) => (row[columnIndex] ?? { v: null, t: 'empty' }).t === 'empty');
}

/**
 * Trims wholly-empty leading and trailing rows and columns; a blank row or
 * column between two non-blank ones is left exactly where it was — it is
 * part of the sheet's structure, not padding.
 */
function trimGrid(grid: Cell[][]): Cell[][] {
  if (grid.length === 0) return grid;

  let top = 0;
  while (top < grid.length && isRowEmpty(grid[top] ?? [])) top++;
  let bottom = grid.length - 1;
  while (bottom >= top && isRowEmpty(grid[bottom] ?? [])) bottom--;
  if (top > bottom) return [];

  const verticallyTrimmed = grid.slice(top, bottom + 1);
  const columnCount = verticallyTrimmed.reduce((max, row) => Math.max(max, row.length), 0);

  let left = 0;
  while (left < columnCount && isColumnEmpty(verticallyTrimmed, left)) left++;
  let right = columnCount - 1;
  while (right >= left && isColumnEmpty(verticallyTrimmed, right)) right--;
  if (left > right) return [];

  return verticallyTrimmed.map((row) => row.slice(left, right + 1));
}

/**
 * Builds one sheet's rectangular grid: every cell in `[1, rowCount] x
 * [1, columnCount]`, capped and trimmed. The row cap and the per-cell
 * character cap both fold into the same `truncated` flag — a caller that
 * only cares "was something cut" does not need to know which cap did it,
 * and both caps land on the same artefact regardless.
 */
function buildSheetGrid(worksheet: ExcelJS.Worksheet): SheetGrid {
  const totalRows = worksheet.rowCount;
  const totalColumns = worksheet.columnCount;
  const rowLimit = Math.min(totalRows, MAX_ROWS_PER_SHEET);
  let truncated = totalRows > MAX_ROWS_PER_SHEET;

  const grid: Cell[][] = [];
  for (let r = 1; r <= rowLimit; r++) {
    const row = worksheet.getRow(r);
    const cells: Cell[] = [];
    for (let c = 1; c <= totalColumns; c++) {
      const mapped = classifyCell(row.getCell(c));
      if (mapped.t === 'string' && typeof mapped.v === 'string' && mapped.v.length > MAX_CELL_CHARS) {
        cells.push({ v: mapped.v.slice(0, MAX_CELL_CHARS), t: 'string' });
        truncated = true;
      } else {
        cells.push(mapped);
      }
    }
    grid.push(cells);
  }

  return { rows: trimGrid(grid), truncated };
}

export async function extractXlsx(sourcePath: string): Promise<DocumentArtifact[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);

  const allSheets = workbook.worksheets;
  const sheetsTruncated = allSheets.length > MAX_SHEETS;
  const sheets = sheetsTruncated ? allSheets.slice(0, MAX_SHEETS) : allSheets;

  const artifacts: DocumentArtifact[] = sheets.map((worksheet, index) => {
    const { rows, truncated } = buildSheetGrid(worksheet);

    const flags: string[] = [];
    // "hidden" and "veryHidden" are both a sheet someone deliberately kept
    // out of plain view — exactly the one worth flagging (§4.1).
    if (worksheet.state !== 'visible') flags.push('hidden_sheet');
    if (truncated) flags.push('truncated');

    const content: TableContent = { rows };
    return { ordinal: index, kind: 'table', partName: worksheet.name, content, flags };
  });

  const first = artifacts[0];
  if (first) {
    if (await hasMacroPart(sourcePath)) {
      first.flags.push('has_macros');
    }

    // The 50-sheet cap is a fact about the whole *document* — "there were
    // more sheets than we kept" — not about whichever sheet happened to be
    // produced last. `has_macros` above is document-level too, and both
    // belong in the same place: the first artefact, so a reader is not
    // left checking two different spots for the same kind of fact. The
    // guard against a double push earns its keep specifically here: the
    // first sheet's own row/cell truncation (`buildSheetGrid` above, via
    // `truncated` in the `.map` that built `artifacts`) can independently
    // already have set `truncated` on this exact artefact before the
    // sheet-count cap ever looks at it.
    if (sheetsTruncated && !first.flags.includes('truncated')) {
      first.flags.push('truncated');
    }
  }

  return artifacts;
}
