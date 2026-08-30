import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { buildOutline } from './outline.js';
import { extractXlsx } from './extractors/xlsx.js';
import { extractDocx } from './extractors/docx.js';
import { extractCsv } from './extractors/csv.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cell, DocumentArtifact, OutlineContent, TableContent } from './types.js';

const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

async function tempCsvPath(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'outline-'));
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
}

async function tempXlsxPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'outline-xlsx-'));
  return join(dir, name);
}

function tableArtifact(
  rows: Cell[][],
  overrides: Partial<DocumentArtifact> = {},
): DocumentArtifact {
  const content: TableContent = { rows };
  return {
    ordinal: 0,
    kind: 'table',
    partName: null,
    content,
    flags: [],
    ...overrides,
  };
}

const n = (v: number): Cell => ({ v, t: 'number' });
const s = (v: string): Cell => ({ v, t: 'string' });
const d = (v: string): Cell => ({ v, t: 'date' });
const empty: Cell = { v: null, t: 'empty' };

describe('buildOutline — tiny.xlsx (task-9-brief.md Step 1, verbatim)', () => {
  it('says what the file is without calling any model', async () => {
    const artifacts = await extractXlsx(fixture('tiny.xlsx'));
    const outline = buildOutline(artifacts);

    expect(outline.kind).toBe('outline');
    expect(outline.partName).toBeNull();
    const content = outline.content as OutlineContent;
    expect(content.parts.map((p) => p.name)).toEqual(['מחירים', 'פנימי']);
    expect(content.parts[0]?.rowCount).toBe(4);
    expect(content.parts[0]?.headers).toEqual(['פריט', 'כמות', 'מחיר', 'תאריך']);
    expect(content.parts[0]?.numericRanges?.['מחיר']).toEqual({ min: 10, max: 30 });
    expect(content.flags).toContain('hidden_sheet');
  });

  it('does not compute a numeric range for כמות, whose last row was overwritten by a merged string label', async () => {
    // The exact fixture fact CLAUDE.md and the brief both call out: a merge
    // on row 4 spreads the string "דבק" across A4:B4, silently turning the
    // כמות (quantity) column's third value from a number into a string.
    // That column must not get a numericRanges entry even though two of its
    // three rows genuinely are numbers — asserting absence, not just that
    // 'מחיר' is present, is what actually rules out "any string anywhere
    // disqualifies the whole part" collapsing into "only truly-wrong
    // columns are dropped".
    const artifacts = await extractXlsx(fixture('tiny.xlsx'));
    const outline = buildOutline(artifacts);
    const content = outline.content as OutlineContent;
    expect(content.parts[0]?.numericRanges).toEqual({ מחיר: { min: 10, max: 30 } });
  });

  it('computes a dateRange for תאריך, skipping the two rows where that column is empty (decision 1)', async () => {
    // Only sheet row 2 carries an actual date; rows 3 and 4 are `{t:
    // 'empty'}` in that column. If an empty cell disqualified the column,
    // this dateRange would be absent — it must not be.
    const artifacts = await extractXlsx(fixture('tiny.xlsx'));
    const outline = buildOutline(artifacts);
    const content = outline.content as OutlineContent;
    expect(content.parts[0]?.dateRange).toEqual({ from: '2026-01-15', to: '2026-01-15' });
  });

  it('reports the hidden sheet as a part with no headers (a single row has no row below to confirm them) and no ranges', async () => {
    const artifacts = await extractXlsx(fixture('tiny.xlsx'));
    const outline = buildOutline(artifacts);
    const content = outline.content as OutlineContent;
    expect(content.parts[1]).toEqual({ name: 'פנימי', kind: 'table', rowCount: 1 });
  });
});

describe('buildOutline — tiny.docx (a text artefact plus a table)', () => {
  it('gives the text artefact a part with just name and kind — no rowCount, no headers, no ranges', async () => {
    const artifacts = await extractDocx(fixture('tiny.docx'));
    const outline = buildOutline(artifacts);
    const content = outline.content as OutlineContent;
    expect(content.parts[0]).toEqual({ name: null, kind: 'text' });
  });

  it('reports the table part with no headers, because the row below the first is also all-string — the header rule\'s second half genuinely disqualifies it here', async () => {
    // tiny.docx's table is עמודה א/עמודה ב over ערך 1/ערך 2 — both rows are
    // entirely strings, so "the row below has at least one non-string" is
    // false and no header may be guessed.
    const artifacts = await extractDocx(fixture('tiny.docx'));
    const outline = buildOutline(artifacts);
    const content = outline.content as OutlineContent;
    const tablePart = content.parts.find((p) => p.kind === 'table');
    expect(tablePart).toEqual({ name: null, kind: 'table', rowCount: 2 });
  });

  it('carries tracked_changes into the outline\'s flags union', async () => {
    const artifacts = await extractDocx(fixture('tiny.docx'));
    const outline = buildOutline(artifacts);
    const content = outline.content as OutlineContent;
    expect(content.flags).toContain('tracked_changes');
  });

  it('places the outline after every artefact it summarises', async () => {
    const artifacts = await extractDocx(fixture('tiny.docx'));
    const maxOrdinal = Math.max(...artifacts.map((a) => a.ordinal));
    const outline = buildOutline(artifacts);
    expect(outline.ordinal).toBe(maxOrdinal + 1);
  });
});

describe('buildOutline — decision 1: an empty cell in a numeric column', () => {
  it('is skipped, not disqualifying — a price column with a blank interior cell still gets a range', async () => {
    // csv.ts now preserves an interior blank row deliberately (see its own
    // module docblock); this is the exact ordinary shape that produces.
    const path = await tempCsvPath('blank-price.csv', 'פריט,מחיר\nא,10\nב,\nג,30\n');
    const artifacts = await extractCsv(path);
    const outline = buildOutline(artifacts);
    const content = outline.content as OutlineContent;
    expect(content.parts[0]?.numericRanges).toEqual({ מחיר: { min: 10, max: 30 } });
  });

  it('a string among the numbers, unlike an empty cell, does disqualify the column entirely', () => {
    const artifact = tableArtifact([
      [s('פריט'), s('מחיר')],
      [s('א'), n(10)],
      [s('ב'), s('מבצע')],
      [s('ג'), n(30)],
    ]);
    const outline = buildOutline([artifact]);
    const content = outline.content as OutlineContent;
    expect(content.parts[0]?.numericRanges).toBeUndefined();
  });

  it('a wholly-empty column produces no range at all — no evidence either way', () => {
    const artifact = tableArtifact([
      [s('פריט'), s('הערה')],
      [s('א'), empty],
      [s('ב'), empty],
    ]);
    const outline = buildOutline([artifact]);
    const content = outline.content as OutlineContent;
    expect(content.parts[0]?.numericRanges).toBeUndefined();
  });
});

describe('buildOutline — header rule edge cases', () => {
  it('does not invent headers for a single-row table', () => {
    const artifact = tableArtifact([[s('פריט'), s('מחיר')]]);
    const outline = buildOutline([artifact]);
    const content = outline.content as OutlineContent;
    expect(content.parts[0]?.headers).toBeUndefined();
    expect(content.parts[0]?.rowCount).toBe(1);
  });

  it('does not treat a first row with an empty cell as headers, even if the row below has a number', () => {
    const artifact = tableArtifact([
      [s('פריט'), empty],
      [s('א'), n(10)],
    ]);
    const outline = buildOutline([artifact]);
    const content = outline.content as OutlineContent;
    expect(content.parts[0]?.headers).toBeUndefined();
  });

  it('does detect headers when the first row is all non-empty strings and the row below has a date', () => {
    const artifact = tableArtifact([
      [s('פריט'), s('תאריך')],
      [s('א'), d('2026-01-01')],
    ]);
    const outline = buildOutline([artifact]);
    const content = outline.content as OutlineContent;
    expect(content.parts[0]?.headers).toEqual(['פריט', 'תאריך']);
  });
});

describe('buildOutline — empty and zero-artefact input', () => {
  it('produces an empty outline (no parts, no flags) for zero artefacts, with ordinal 0', () => {
    const outline = buildOutline([]);
    expect(outline.ordinal).toBe(0);
    expect(outline.kind).toBe('outline');
    expect(outline.partName).toBeNull();
    expect(outline.content).toEqual({ parts: [], flags: [] });
  });

  it('reports zero rowCount for an artefact whose rows array is empty, with no headers and no ranges', () => {
    const artifact = tableArtifact([]);
    const outline = buildOutline([artifact]);
    const content = outline.content as OutlineContent;
    expect(content.parts[0]).toEqual({ name: null, kind: 'table', rowCount: 0 });
  });
});

describe('buildOutline — flags union', () => {
  it('unions flags across every artefact, deduplicated, without duplicating them onto the outline artefact\'s own flags', () => {
    const a = tableArtifact([[s('x')]], { flags: ['truncated', 'hidden_sheet'] });
    const b = tableArtifact([[s('y')]], { flags: ['hidden_sheet'] });
    const outline = buildOutline([a, b]);
    const content = outline.content as OutlineContent;
    expect([...content.flags].sort()).toEqual(['hidden_sheet', 'truncated']);
    expect(outline.flags).toEqual([]);
  });
});

// Controller review, round 2, finding 1: two columns sharing a header text
// must not let one column's range silently overwrite the other's under the
// same `numericRanges` key. The fix omits the range for *either* column and
// raises `duplicate_header` instead — both halves are asserted below, and
// this test would have failed against the pre-fix last-write-wins behaviour
// (which produced a `מחיר` key with the *second* column's range and no flag
// at all).
describe('buildOutline — duplicate header text across two columns', () => {
  it('omits the range under the shared key and raises duplicate_header, while a differently-named column still gets its own range', () => {
    const artifact = tableArtifact([
      [s('פריט'), s('מחיר'), s('מחיר'), s('כמות')],
      [s('א'), n(10), n(100), n(3)],
      [s('ב'), n(20), n(200), n(5)],
    ]);
    const outline = buildOutline([artifact]);
    const content = outline.content as OutlineContent;

    // No 'מחיר' key at all — not the first column's range, not the
    // second's, not a merge of the two.
    expect(content.parts[0]?.numericRanges).toEqual({ כמות: { min: 3, max: 5 } });
    expect(content.flags).toContain('duplicate_header');
  });

  it('does not raise duplicate_header when every header is unique', () => {
    const artifact = tableArtifact([
      [s('פריט'), s('מחיר')],
      [s('א'), n(10)],
    ]);
    const outline = buildOutline([artifact]);
    const content = outline.content as OutlineContent;
    expect(content.flags).not.toContain('duplicate_header');
  });
});

// Controller review, round 2, finding 2: the reviewer showed this branch is
// reachable *today*, through the already-merged `extractXlsx`, not a
// hypothetical future extractor — an ordinary date column where one row
// happens to hold a plain number, no string anywhere. Built as a real
// workbook via ExcelJS and read back through `extractXlsx`, the same way
// `xlsx.test.ts` builds its own synthetic fixtures.
describe('buildOutline — a column mixing number- and date-typed cells (no string), reachable through a real workbook', () => {
  it('reports neither a numeric range nor a date range for that column', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s1');
    ws.getCell(1, 1).value = 'תאריך';
    ws.getCell(2, 1).value = new Date('2026-01-01T00:00:00.000Z');
    ws.getCell(3, 1).value = 42;

    const path = await tempXlsxPath('mixed-number-date.xlsx');
    await wb.xlsx.writeFile(path);

    const artifacts = await extractXlsx(path);
    const outline = buildOutline(artifacts);
    const content = outline.content as OutlineContent;

    expect(content.parts[0]?.headers).toEqual(['תאריך']);
    expect(content.parts[0]?.numericRanges).toBeUndefined();
    expect(content.parts[0]?.dateRange).toBeUndefined();
  });
});
