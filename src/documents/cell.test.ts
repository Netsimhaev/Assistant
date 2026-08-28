import { describe, expect, it } from 'vitest';
import { MAX_CELL_CHARS, MAX_ROWS_PER_TABLE } from './cell.js';
import { MAX_CELL_CHARS as XLSX_MAX_CELL_CHARS, MAX_ROWS_PER_SHEET } from './extractors/xlsx.js';

// Locks the claim this module's own docblock makes: xlsx.ts keeps its own
// copies of these two caps (written before this module existed) rather than
// importing them from here, on the promise that the values stay identical
// either way. Nothing else enforces that promise — a change to one side
// alone would silently let a Word or CSV table hold a different cap than an
// Excel sheet, with no test failing anywhere but here.
describe('structural consistency: cell.ts caps match xlsx.ts caps', () => {
  it('MAX_ROWS_PER_TABLE (cell.ts) equals MAX_ROWS_PER_SHEET (xlsx.ts)', () => {
    expect(MAX_ROWS_PER_TABLE).toBe(MAX_ROWS_PER_SHEET);
  });

  it('MAX_CELL_CHARS is the same constant in both modules', () => {
    expect(MAX_CELL_CHARS).toBe(XLSX_MAX_CELL_CHARS);
  });
});
