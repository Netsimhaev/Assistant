import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CSV, DOCX, JSON as JSON_TYPE, MARKDOWN, TEXT, XLSX, sniffMediaType } from './media-type.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

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

  it('recovers from a UTF-8 character cut off at the buffer boundary', () => {
    // 'a' followed by Hebrew shin (a 2-byte UTF-8 character: 0xD7 0xA9).
    // Dropping the last byte leaves a dangling lead byte with no
    // continuation — exactly what happens when `head` is a prefix of a
    // larger file and the cut lands mid-character, not evidence the file is
    // binary.
    const full = Buffer.from('aש', 'utf-8');
    const truncated = full.subarray(0, full.length - 1);
    expect(sniffMediaType(truncated, 'notes.txt')).toBe(TEXT);
  });

  it('reads the real xlsx fixture bytes as XLSX, not just a constructed header', () => {
    const head = readFileSync(fixture('tiny.xlsx')).subarray(0, 8);
    expect(sniffMediaType(head, 'tiny.xlsx')).toBe(XLSX);
  });

  it('reads the real docx fixture bytes as DOCX, not just a constructed header', () => {
    const head = readFileSync(fixture('tiny.docx')).subarray(0, 8);
    expect(sniffMediaType(head, 'tiny.docx')).toBe(DOCX);
  });
});
