import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectSeparator, extractCsv, parseCsvText } from './csv.js';
import { extractPassthrough } from './passthrough.js';
import type { Cell, TableContent } from '../types.js';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const rowsOf = (content: unknown): Cell[][] => (content as TableContent).rows;

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'simple-extractor-'));
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
}

async function tempBytes(name: string, bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'simple-extractor-'));
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

describe('extractCsv', () => {
  // From the task brief verbatim (§4.3 Step 1).
  it('keeps a ragged row and flags it rather than dropping it', async () => {
    const [table] = await extractCsv(fixture('ragged.csv'));
    const rows = rowsOf(table?.content);
    expect(rows).toHaveLength(3);
    expect(table?.flags).toContain('ragged_rows');
  });

  it('detects a semicolon separator from the content', async () => {
    const [table] = await extractCsv(fixture('semicolons.csv'));
    const rows = rowsOf(table?.content);
    expect(rows[0]).toHaveLength(3);
  });

  it('places the ragged row at its true position, not appended at the end', async () => {
    const [table] = await extractCsv(fixture('ragged.csv'));
    const rows = rowsOf(table?.content);
    // ragged.csv's short row is the third physical line ("נועה,31").
    expect(rows[2]).toEqual([
      { v: 'נועה', t: 'string' },
      { v: 31, t: 'number' },
    ]);
    // The two full rows around it are untouched by the raggedness.
    expect(rows[0]).toHaveLength(3);
    expect(rows[1]).toHaveLength(3);
  });

  it('produces one table artefact with no partName', async () => {
    const artifacts = await extractCsv(fixture('ragged.csv'));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe('table');
    expect(artifacts[0]?.partName).toBeNull();
  });

  it('does not flag a well-formed file as ragged', async () => {
    const [table] = await extractCsv(fixture('semicolons.csv'));
    expect(table?.flags).not.toContain('ragged_rows');
  });

  it('classifies a round-tripping integer as a number', async () => {
    const path = await tempFile('numbers.csv', 'a,b\n42,-5\n');
    const [table] = await extractCsv(path);
    const rows = rowsOf(table?.content);
    expect(rows[1]).toEqual([
      { v: 42, t: 'number' },
      { v: -5, t: 'number' },
    ]);
  });

  it('keeps a leading-zero code as a string rather than parsing it as a number', async () => {
    const path = await tempFile('codes.csv', 'code\n007\n');
    const [table] = await extractCsv(path);
    const rows = rowsOf(table?.content);
    // "007" parses to 7 but does not round-trip back to "007" — a
    // silently-dropped leading zero is exactly the corruption the
    // round-trip rule (see csv.ts's docblock) exists to prevent.
    expect(rows[1]).toEqual([{ v: '007', t: 'string' }]);
  });

  it('keeps a trailing-precision price as a string rather than parsing it as a number', async () => {
    const path = await tempFile('prices.csv', 'price\n9.90\n');
    const [table] = await extractCsv(path);
    const rows = rowsOf(table?.content);
    expect(rows[1]).toEqual([{ v: '9.90', t: 'string' }]);
  });

  it('maps an empty field to an empty cell, not an empty string', async () => {
    const path = await tempFile('blank-field.csv', 'a,b,c\n1,,3\n');
    const [table] = await extractCsv(path);
    const rows = rowsOf(table?.content);
    expect(rows[1]?.[1]).toEqual({ v: null, t: 'empty' });
  });

  it('keeps a quoted field containing the separator as one field', async () => {
    const path = await tempFile('quoted-comma.csv', 'name,age\n"Doe, Jane",30\n');
    const [table] = await extractCsv(path);
    const rows = rowsOf(table?.content);
    expect(rows[1]).toEqual([
      { v: 'Doe, Jane', t: 'string' },
      { v: 30, t: 'number' },
    ]);
    // No raggedness: both rows have exactly 2 fields once the quoted
    // comma is correctly not treated as a delimiter.
    expect(table?.flags).not.toContain('ragged_rows');
  });

  it('keeps a quoted field containing an embedded newline as one field, not two rows', async () => {
    const path = await tempFile('quoted-newline.csv', 'name,note\nDana,"line one\nline two"\nNoa,fine\n');
    const [table] = await extractCsv(path);
    const rows = rowsOf(table?.content);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual([
      { v: 'Dana', t: 'string' },
      { v: 'line one\nline two', t: 'string' },
    ]);
    expect(rows[2]?.[0]).toEqual({ v: 'Noa', t: 'string' });
  });

  it('unescapes a doubled quote inside a quoted field', async () => {
    const path = await tempFile('doubled-quote.csv', 'quote\n"she said ""hi"""\n');
    const [table] = await extractCsv(path);
    const rows = rowsOf(table?.content);
    expect(rows[1]).toEqual([{ v: 'she said "hi"', t: 'string' }]);
  });

  it('produces one row of one field for a single line with no separator at all', async () => {
    const path = await tempFile('no-separator.txt.csv', 'hello world');
    const [table] = await extractCsv(path);
    const rows = rowsOf(table?.content);
    // The failure this must never produce: a separator we could not
    // determine silently yielding an empty-but-successful table.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([{ v: 'hello world', t: 'string' }]);
  });

  it('does not create a spurious empty row from a trailing newline', async () => {
    const path = await tempFile('trailing-newline.csv', 'a,b\n1,2\n');
    const [table] = await extractCsv(path);
    const rows = rowsOf(table?.content);
    expect(rows).toHaveLength(2);
  });

  it('strips a UTF-8 BOM before detecting the separator or parsing', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from('a,b\n1,2\n', 'utf8');
    const path = await tempBytes('bom.csv', Buffer.concat([bom, body]));
    const [table] = await extractCsv(path);
    const rows = rowsOf(table?.content);
    expect(rows[0]?.[0]).toEqual({ v: 'a', t: 'string' });
  });

  it('detectSeparator falls back to comma when no candidate splits any line', () => {
    expect(detectSeparator('hello world')).toBe(',');
  });

  it('detectSeparator picks the candidate with the most consistent field count, not the first candidate tried', () => {
    // Tabs are more consistent here (3 fields every line) than commas
    // (which only appear once, inside the third field of the second line).
    const text = 'a\tb\tc\n1\t2,2\t3\n';
    expect(detectSeparator(text)).toBe('\t');
  });

  it('parseCsvText treats an unterminated quote as running to end of input rather than throwing', () => {
    expect(parseCsvText('a,"unterminated', ',')).toEqual([['a', 'unterminated']]);
  });
});

describe('extractPassthrough', () => {
  it('wraps the whole file as one paragraph block, verbatim', async () => {
    const path = await tempFile('note.txt', 'שלום עולם\nשורה שנייה');
    const [artifact] = await extractPassthrough(path);
    expect(artifact?.kind).toBe('text');
    expect(artifact?.content).toEqual({
      blocks: [{ kind: 'paragraph', text: 'שלום עולם\nשורה שנייה' }],
    });
    expect(artifact?.flags).toEqual([]);
  });

  it('passes markdown and JSON content through unparsed, exactly as bytes', async () => {
    const mdPath = await tempFile('note.md', '# כותרת\n\nפסקה.');
    const [mdArtifact] = await extractPassthrough(mdPath);
    expect((mdArtifact?.content as { blocks: { text: string }[] }).blocks[0]?.text).toBe(
      '# כותרת\n\nפסקה.',
    );

    const jsonPath = await tempFile('note.json', '{"a": 1}');
    const [jsonArtifact] = await extractPassthrough(jsonPath);
    expect((jsonArtifact?.content as { blocks: { text: string }[] }).blocks[0]?.text).toBe(
      '{"a": 1}',
    );
  });

  it('strips a leading UTF-8 BOM rather than leaving it in the paragraph text', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from('hello', 'utf8');
    const path = await tempBytes('bom.txt', Buffer.concat([bom, body]));
    const [artifact] = await extractPassthrough(path);
    const text = (artifact?.content as { blocks: { text: string }[] }).blocks[0]?.text;
    expect(text).toBe('hello');
    expect(text?.charCodeAt(0)).not.toBe(0xfeff);
  });
});
