import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('the admitted parsing libraries', () => {
  it('reads a workbook without evaluating its formulas', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fixture('tiny.xlsx'));
    expect(wb.worksheets.length).toBe(2);
  });

  it('reads a document and keeps its structure', async () => {
    const { value } = await mammoth.convertToHtml({ path: fixture('tiny.docx') });
    expect(value).toContain('<table');
  });
});
