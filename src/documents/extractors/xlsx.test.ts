import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { extractXlsx } from './xlsx.js';
import type { Cell, TableContent } from '../types.js';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const rowsOf = (content: unknown): Cell[][] => (content as TableContent).rows;

async function tempXlsxPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'xlsx-extractor-'));
  return join(dir, name);
}

describe('extractXlsx', () => {
  it('produces one table artefact per sheet, partName set to the sheet name', async () => {
    const artifacts = await extractXlsx(fixture('tiny.xlsx'));
    expect(artifacts.map((a) => a.partName)).toEqual(['מחירים', 'פנימי']);
    expect(artifacts.every((a) => a.kind === 'table')).toBe(true);
  });

  it('keeps the cached value of a formula and never recomputes it', async () => {
    const [sheet] = await extractXlsx(fixture('tiny.xlsx'));
    const rows = rowsOf(sheet?.content);
    expect(rows[1]?.[2]).toEqual({ v: 30, t: 'number' });
  });

  it('includes a hidden sheet and flags it', async () => {
    const artifacts = await extractXlsx(fixture('tiny.xlsx'));
    const hidden = artifacts.find((a) => a.flags.includes('hidden_sheet'));
    expect(hidden?.partName).toBe('פנימי');
  });

  it('spreads a merged cell across every cell it covered', async () => {
    // The merge in the fixture sits on the last data row (sheet row 4 /
    // rows[3]), not the header (rows[0]) — see task-6-brief.md's
    // correction. The header row's four labels are distinct and unmerged;
    // merging over them would have destroyed one of the four labels, which
    // is exactly the contradiction Task 1's ruling 6 fixed by moving the
    // merge here instead.
    const [sheet] = await extractXlsx(fixture('tiny.xlsx'));
    const rows = rowsOf(sheet?.content);
    expect(rows[3]?.[0]?.v).toBe(rows[3]?.[1]?.v);
  });

  it('normalises a date to ISO rather than leaving a serial number', async () => {
    const [sheet] = await extractXlsx(fixture('tiny.xlsx'));
    const rows = rowsOf(sheet?.content);
    expect(rows[1]?.[3]).toEqual({ v: '2026-01-15', t: 'date' });
  });

  it('classifies every cell kind in the fixture together, including a plain (non-formula) number', async () => {
    // Row 2 of the visible sheet exercises string, plain number, formula
    // (cached) number, and date all in one row — one assertion that pins
    // down the whole row rather than one cell at a time.
    const [sheet] = await extractXlsx(fixture('tiny.xlsx'));
    const rows = rowsOf(sheet?.content);
    expect(rows[1]).toEqual([
      { v: 'עט', t: 'string' },
      { v: 3, t: 'number' },
      { v: 30, t: 'number' },
      { v: '2026-01-15', t: 'date' },
    ]);
  });

  it('turns a formula with no cached result into an empty cell, never evaluating it', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s1');
    ws.getCell(1, 1).value = { formula: 'SUM(B1:B2)' } as ExcelJS.CellFormulaValue;
    // Real values elsewhere on the sheet — including in the formula cell's
    // own column and row — so trimming (correctly) does not remove the
    // formula cell's row or column as a wholly-blank edge. This test is
    // about the formula cell's own classification, not about trimming.
    ws.getCell(1, 2).value = 'anchor';
    ws.getCell(2, 1).value = 'keep-column-1';

    const path = await tempXlsxPath('no-cached-result.xlsx');
    await wb.xlsx.writeFile(path);

    const [sheet] = await extractXlsx(path);
    const rows = rowsOf(sheet?.content);
    expect(rows[0]?.[0]).toEqual({ v: null, t: 'empty' });
    expect(rows[0]?.[1]).toEqual({ v: 'anchor', t: 'string' });
  });

  it('classifies a boolean cell', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s1');
    ws.getCell(1, 1).value = true;

    const path = await tempXlsxPath('bool.xlsx');
    await wb.xlsx.writeFile(path);

    const [sheet] = await extractXlsx(path);
    const rows = rowsOf(sheet?.content);
    expect(rows[0]?.[0]).toEqual({ v: true, t: 'bool' });
  });

  it('trims wholly-empty leading and trailing rows and columns, and keeps an interior blank row and column', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s1');
    // Row 1: left fully blank (leading blank row).
    // Row 2: data in columns 2 and 4 (column 1 leading-blank, column 3
    //   interior-blank).
    ws.getCell(2, 2).value = 'A';
    ws.getCell(2, 4).value = 'B';
    // Row 3: left fully blank — an interior blank row between two data
    //   rows, which must survive trimming.
    // Row 4: more data in the same two columns.
    ws.getCell(4, 2).value = 'C';
    ws.getCell(4, 4).value = 'D';
    // Row 5: touching column 6 without assigning a value extends both
    //   rowCount to 5 (a trailing blank row) and columnCount to 6 (a
    //   trailing blank column at 5 and 6), without writing any real
    //   content there.
    ws.getCell(5, 6);

    const path = await tempXlsxPath('trim.xlsx');
    await wb.xlsx.writeFile(path);

    const [sheet] = await extractXlsx(path);
    const rows = rowsOf(sheet?.content);

    const empty: Cell = { v: null, t: 'empty' };
    expect(rows).toEqual([
      [{ v: 'A', t: 'string' }, empty, { v: 'B', t: 'string' }],
      [empty, empty, empty],
      [{ v: 'C', t: 'string' }, empty, { v: 'D', t: 'string' }],
    ]);
  });

  it('spreads a merge covering more than a pair of cells — a 2-row-by-3-column block — across every cell it covered', async () => {
    // The fixture only exercises a 2-cell merge (A4:B4); the extractor's
    // own claim is that it handles any merge shape by unwrapping through
    // `exceljs`'s `master`, not by special-casing a pair. This is the test
    // that backs that claim.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s1');
    ws.mergeCells('A1:C2');
    ws.getCell(1, 1).value = 'block';
    ws.getCell(3, 1).value = 'below-the-block'; // keeps row 3 from trimming away

    const path = await tempXlsxPath('block-merge.xlsx');
    await wb.xlsx.writeFile(path);

    const [sheet] = await extractXlsx(path);
    const rows = rowsOf(sheet?.content);

    expect(rows[0]).toEqual([
      { v: 'block', t: 'string' },
      { v: 'block', t: 'string' },
      { v: 'block', t: 'string' },
    ]);
    expect(rows[1]).toEqual([
      { v: 'block', t: 'string' },
      { v: 'block', t: 'string' },
      { v: 'block', t: 'string' },
    ]);
  });

  it('reports an empty sheet as zero rows rather than a grid of empty cells', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('blank');

    const path = await tempXlsxPath('blank.xlsx');
    await wb.xlsx.writeFile(path);

    const [sheet] = await extractXlsx(path);
    expect(rowsOf(sheet?.content)).toEqual([]);
  });

  it('caps rows at 50,000 per sheet and flags the artefact truncated, dropping what came after the cap', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('big');
    ws.getCell(1, 1).value = 'first';
    ws.getCell(50_000, 1).value = 'last-in-cap';
    ws.getCell(50_001, 1).value = 'beyond-cap';

    const path = await tempXlsxPath('row-cap.xlsx');
    await wb.xlsx.writeFile(path);

    const [sheet] = await extractXlsx(path);
    const rows = rowsOf(sheet?.content);

    expect(rows).toHaveLength(50_000);
    expect(rows[49_999]?.[0]).toEqual({ v: 'last-in-cap', t: 'string' });
    expect(rows.some((row) => row.some((cell) => cell.v === 'beyond-cap'))).toBe(false);
    expect(sheet?.flags).toContain('truncated');
  }, 20_000);

  it('caps a cell at 32,768 characters and flags the artefact truncated', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s1');
    ws.getCell(1, 1).value = 'א'.repeat(40_000);

    const path = await tempXlsxPath('cell-cap.xlsx');
    await wb.xlsx.writeFile(path);

    const [sheet] = await extractXlsx(path);
    const rows = rowsOf(sheet?.content);

    const cell = rows[0]?.[0];
    expect(cell?.t).toBe('string');
    expect((cell?.v as string).length).toBe(32_768);
    expect(sheet?.flags).toContain('truncated');
  });

  it('caps sheets at 50 and flags the last produced artefact truncated, dropping the rest', async () => {
    const wb = new ExcelJS.Workbook();
    for (let i = 1; i <= 51; i++) {
      wb.addWorksheet(`sheet-${i}`).getCell(1, 1).value = i;
    }

    const path = await tempXlsxPath('sheet-cap.xlsx');
    await wb.xlsx.writeFile(path);

    const artifacts = await extractXlsx(path);

    expect(artifacts).toHaveLength(50);
    expect(artifacts.map((a) => a.partName)).toEqual(
      Array.from({ length: 50 }, (_, i) => `sheet-${i + 1}`),
    );
    expect(artifacts[49]?.flags).toContain('truncated');
    // Nothing about the earlier sheets was cut, so none of them should
    // carry the flag that belongs to the sheet-count cap.
    expect(artifacts.slice(0, 49).some((a) => a.flags.includes('truncated'))).toBe(false);
  });

  it('flags has_macros on the workbook\'s first artefact when a macro part exists, and not otherwise', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('s1').getCell(1, 1).value = 'hi';
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    // `exceljs` cannot author a macro-enabled workbook, so this fixture is
    // built by hand: locate the end-of-central-directory record `exceljs`
    // just wrote (a real, valid one — nothing forged about the archive
    // itself), then use its own comment field — an ordinary, spec-legal
    // part of any ZIP's trailer — to carry the one marker a real .xlsm
    // would carry in cleartext somewhere in its bytes regardless of where.
    // This keeps the resulting file fully readable by `exceljs` (verified
    // below by the sheet still coming back), which appending raw bytes
    // after the EOCD without updating its declared comment length would
    // not have been guaranteed to do.
    const EOCD_SIGNATURE = 0x06054b50;
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= 0; i--) {
      if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) throw new Error('test setup: no EOCD found in generated xlsx');

    const marker = Buffer.from('xl/vbaProject.bin', 'ascii');
    const patched = Buffer.alloc(eocdOffset + 22 + marker.length);
    buffer.copy(patched, 0, 0, eocdOffset + 22);
    marker.copy(patched, eocdOffset + 22);
    patched.writeUInt16LE(marker.length, eocdOffset + 20);

    const { writeFile } = await import('node:fs/promises');
    const macroPath = await tempXlsxPath('macro.xlsx');
    await writeFile(macroPath, patched);

    const macroArtifacts = await extractXlsx(macroPath);
    expect(macroArtifacts[0]?.partName).toBe('s1');
    expect(macroArtifacts[0]?.flags).toContain('has_macros');

    // The negative case, from the same building blocks: an ordinary
    // workbook with no macro part must not carry the flag.
    const plainArtifacts = await extractXlsx(fixture('tiny.xlsx'));
    expect(plainArtifacts[0]?.flags).not.toContain('has_macros');
  });
});
