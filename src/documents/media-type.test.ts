import { describe, expect, it } from 'vitest';
import { CSV, DOCX, JSON as JSON_TYPE, MARKDOWN, TEXT, XLSX, sniffMediaType } from './media-type.js';

describe('sniffMediaType', () => {
  it('reads the type from the bytes, not the extension', () => {
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(sniffMediaType(zipHeader, 'prices.xlsx')).toBe(XLSX);
    // A text file wearing a spreadsheet's name is not a spreadsheet.
    expect(sniffMediaType(Buffer.from('שלום'), 'prices.xlsx')).toBe('text/plain');
  });

  it('returns null for a type nobody named', () => {
    expect(sniffMediaType(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'x.bin')).toBeNull();
  });

  it('picks docx among zip containers by extension', () => {
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(sniffMediaType(zipHeader, 'contract.docx')).toBe(DOCX);
  });

  it('rejects a zip container whose extension names neither supported format', () => {
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(sniffMediaType(zipHeader, 'archive.zip')).toBeNull();
  });

  it('refines text by extension to csv, markdown and json', () => {
    expect(sniffMediaType(Buffer.from('a,b,c'), 'data.csv')).toBe(CSV);
    expect(sniffMediaType(Buffer.from('# title'), 'notes.md')).toBe(MARKDOWN);
    expect(sniffMediaType(Buffer.from('{}'), 'data.json')).toBe(JSON_TYPE);
  });

  it('falls back to plain text when the extension names no known refinement', () => {
    expect(sniffMediaType(Buffer.from('hello'), 'notes.txt')).toBe(TEXT);
    expect(sniffMediaType(Buffer.from('hello'), 'notes')).toBe(TEXT);
  });

  it('never lets an extension promote a non-zip file to a zip format', () => {
    expect(sniffMediaType(Buffer.from('not actually a zip'), 'workbook.xlsx')).toBe(TEXT);
    expect(sniffMediaType(Buffer.from('not actually a zip'), 'contract.docx')).toBe(TEXT);
  });

  it('treats control bytes as not-text', () => {
    expect(sniffMediaType(Buffer.from([0x41, 0x00, 0x42]), 'x.txt')).toBeNull();
  });

  it('accepts tab, newline and carriage return as ordinary text whitespace', () => {
    expect(sniffMediaType(Buffer.from('a\tb\nc\r\n'), 'notes.txt')).toBe(TEXT);
  });
});
