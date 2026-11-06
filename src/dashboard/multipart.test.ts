import { describe, expect, it } from 'vitest';
import { boundaryOf, parseMultipart } from './multipart.js';

const BOUNDARY = '----test-boundary-7MA4YWxk';
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

type Part =
  | { kind: 'field'; name: string; value: string }
  | { kind: 'file'; name: string; filename: string; contentType?: string; bytes: Buffer };

function body(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
    if (part.kind === 'field') {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(Buffer.from(part.value, 'utf8'));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
          'utf8',
        ),
      );
      chunks.push(part.bytes);
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

describe('parseMultipart', () => {
  it('parses one file and fields', () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0x00]);
    const parsed = parseMultipart(
      body([
        { kind: 'field', name: 'csrf', value: 'tok-1' },
        { kind: 'field', name: 'text', value: 'תכיני טבלה\r\nלפי המחירון' },
        { kind: 'file', name: 'file', filename: 'מחירון אלפא.xlsx', bytes },
      ]),
      CONTENT_TYPE,
      { maxFileBytes: 1024 },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.fields.get('csrf')).toBe('tok-1');
    expect(parsed.fields.get('text')).toBe('תכיני טבלה\r\nלפי המחירון');
    expect(parsed.file?.filename).toBe('מחירון אלפא.xlsx');
    expect(parsed.file?.bytes.equals(bytes)).toBe(true);
  });

  it('reads an empty file input (no file chosen) as no file', () => {
    const parsed = parseMultipart(
      body([
        { kind: 'field', name: 'text', value: 'שלום' },
        { kind: 'file', name: 'file', filename: '', bytes: Buffer.alloc(0) },
      ]),
      CONTENT_TYPE,
      { maxFileBytes: 1024 },
    );
    expect(parsed.ok && parsed.file).toBe(null);
  });

  it('rejects two files', () => {
    const parsed = parseMultipart(
      body([
        { kind: 'file', name: 'file', filename: 'a.txt', bytes: Buffer.from('a') },
        { kind: 'file', name: 'file', filename: 'b.txt', bytes: Buffer.from('b') },
      ]),
      CONTENT_TYPE,
      { maxFileBytes: 1024 },
    );
    expect(parsed).toEqual({ ok: false, code: 'too_many_files' });
  });

  it('rejects over cap', () => {
    const under = parseMultipart(
      body([{ kind: 'file', name: 'file', filename: 'a.txt', bytes: Buffer.alloc(16, 0x61) }]),
      CONTENT_TYPE,
      { maxFileBytes: 16 },
    );
    expect(under.ok).toBe(true);
    const over = parseMultipart(
      body([{ kind: 'file', name: 'file', filename: 'a.txt', bytes: Buffer.alloc(17, 0x61) }]),
      CONTENT_TYPE,
      { maxFileBytes: 16 },
    );
    expect(over).toEqual({ ok: false, code: 'file_too_large' });
  });

  it('a filename with ../ is stored verbatim and never used', () => {
    const parsed = parseMultipart(
      body([{ kind: 'file', name: 'file', filename: '../../escape\\..\\x.xlsx', bytes: Buffer.from('x') }]),
      CONTENT_TYPE,
      { maxFileBytes: 1024 },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Verbatim: no basename, no normalisation — the name is data, never a path.
    expect(parsed.file?.filename).toBe('../../escape\\..\\x.xlsx');
  });

  it('refuses a body with no closing boundary and a missing boundary parameter', () => {
    const cut = body([{ kind: 'field', name: 'text', value: 'x' }]).subarray(0, 40);
    expect(parseMultipart(cut, CONTENT_TYPE, { maxFileBytes: 1024 }).ok).toBe(false);
    expect(boundaryOf('multipart/form-data')).toBe(null);
    expect(boundaryOf(`multipart/form-data; boundary="${BOUNDARY}"`)).toBe(BOUNDARY);
    expect(boundaryOf('application/x-www-form-urlencoded')).toBe(null);
  });
});
