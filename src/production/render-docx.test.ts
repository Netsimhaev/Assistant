import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { createDbImageLoader, renderDocx, type ImageLoader } from './render-docx.js';
import { CONTRACT_DISCLAIMER_HE } from './validate-spec.js';
import { SpecRenderError } from './render-error.js';
import type { DocxSpec } from '../domain/document-spec.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const noImages: ImageLoader = async () => null;
const opts = { currency: 'ILS', images: noImages };

function spec(over: Partial<DocxSpec> = {}): DocxSpec {
  return {
    format: 'docx',
    language: 'he',
    kind: 'letter',
    title: 'מכתב',
    filename: 'letter',
    style: { theme: 'clean', accent: 'navy' },
    sources: [],
    blocks: [{ type: 'paragraph', text: 'שלום עולם' }],
    ...over,
  };
}

async function xml(buf: Buffer, file = 'word/document.xml'): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  return zip.file(file)!.async('string');
}

describe('renderDocx', () => {
  it('he paragraphs carry w:bidi and the flipped w:jc left (drawn flush right)', async () => {
    const x = await xml(await renderDocx(spec(), opts));
    expect(x).toContain('<w:bidi');
    // docx 9.15.2 flips AlignmentType.RIGHT to "left" for bidirectional paragraphs
    // (RIGHT_TO_LEFT_ALIGNMENTS): in a w:bidi paragraph jc is start-relative, so
    // "left" is drawn flush RIGHT by Word and LibreOffice. A literal "right"
    // would draw flush left.
    expect(x).toContain('<w:jc w:val="left"');
    expect(x).not.toContain('<w:jc w:val="right"');
    expect(x).toContain('<w:rtl');
  });

  it('digit sequence is its own run without w:rtl', async () => {
    const x = await xml(
      await renderDocx(spec({ blocks: [{ type: 'paragraph', text: 'הנחה של 39% ומחיר ₪1,890 בלבד' }] }), opts),
    );
    const runs = x.match(/<w:r>.*?<\/w:r>/gs) ?? [];
    const pct = runs.find((r) => r.includes('>39%<'));
    const money = runs.find((r) => r.includes('>₪1,890<'));
    expect(pct).toBeDefined();
    expect(money).toBeDefined();
    expect(pct).not.toContain('<w:rtl');
    expect(money).not.toContain('<w:rtl');
    const heb = runs.find((r) => r.includes('הנחה של'));
    expect(heb).toContain('<w:rtl');
  });

  it('contract footer contains the Hebrew disclaimer, with signatures and legal basis', async () => {
    const buf = await renderDocx(
      spec({
        kind: 'contract',
        legalBasis: [{ law: 'חוק החוזים', note: 'סעיף 1' }],
        blocks: [{ type: 'clause', title: 'מבוא', text: 'טקסט' }],
      }),
      opts,
    );
    const zip = await JSZip.loadAsync(buf);
    const footers = Object.keys(zip.files).filter((n) => /^word\/footer\d*\.xml$/.test(n));
    expect(footers.length).toBeGreaterThan(0);
    const all = (await Promise.all(footers.map((f) => zip.file(f)!.async('string')))).join('');
    expect(all).toContain(CONTRACT_DISCLAIMER_HE);
    const body = await xml(buf);
    expect(body).toContain('הבסיס החוקי');
    expect(body).toContain('חוק החוזים');
    expect(body).toContain('חתימת צד א');
    const letter = await JSZip.loadAsync(await renderDocx(spec(), opts));
    const lf = Object.keys(letter.files).filter((n) => /^word\/footer/.test(n));
    expect(lf.length).toBe(0);
  });

  it('clause numbering is generated (1., 2., 2.1)', async () => {
    const x = await xml(
      await renderDocx(
        spec({
          blocks: [
            { type: 'clause', title: 'א', text: 'ראשון' },
            { type: 'clause', title: 'ב', text: 'שני\nשני-משנה' },
          ],
        }),
        opts,
      ),
    );
    expect(x).toContain('>1.<');
    expect(x).toContain('>2.<');
    expect(x).toContain('>2.1<');
    expect(x).toContain('>2.2<');
  });

  it('renders table cells formatted, and refuses a formula cell', async () => {
    const x = await xml(
      await renderDocx(
        spec({
          blocks: [
            {
              type: 'table',
              header: ['פריט', 'סכום', 'תאריך'],
              rows: [[{ t: 'א' }, { v: 1890, src: { kind: 'instruction' } }, { d: '2026-11-03' }]],
            },
          ],
        }),
        opts,
      ),
    );
    expect(x).toContain('<w:bidiVisual');
    expect(x).toContain('1,890');
    expect(x).toContain('03/11/2026');
    await expect(
      renderDocx(spec({ blocks: [{ type: 'table', header: ['a'], rows: [[{ f: 'A1+1' }]] }] }), opts),
    ).rejects.toMatchObject({ code: 'formula_in_document' });
  });

  it('accepts png, refuses a gif and an unknown image', async () => {
    const block = { type: 'image', documentId: 'DOC-1' } as const;
    const ok = await renderDocx(spec({ blocks: [block] }), {
      currency: 'ILS',
      images: async () => ({ bytes: PNG, mediaType: 'image/png' }),
    });
    expect(await xml(ok)).toContain('<w:drawing');
    const gif = renderDocx(spec({ blocks: [block] }), {
      currency: 'ILS',
      images: async () => ({ bytes: Buffer.from('GIF89a'), mediaType: 'image/gif' }),
    });
    await expect(gif).rejects.toBeInstanceOf(SpecRenderError);
    await expect(gif).rejects.toMatchObject({ code: 'unsupported_image' });
    await expect(renderDocx(spec({ blocks: [block] }), opts)).rejects.toMatchObject({ code: 'unknown_image' });
  });

  it('mammoth extracts the paragraph text in spec order', async () => {
    const buf = await renderDocx(
      spec({
        blocks: [
          { type: 'heading', level: 1, text: 'כותרת ראשית' },
          { type: 'paragraph', text: 'פסקה ראשונה' },
          { type: 'paragraph', text: 'פסקה שנייה' },
        ],
      }),
      opts,
    );
    const { value } = await mammoth.extractRawText({ buffer: buf });
    const a = value.indexOf('כותרת ראשית');
    const b = value.indexOf('פסקה ראשונה');
    const c = value.indexOf('פסקה שנייה');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it('isolates a leading minus with its number, but not a hyphen between letters', async () => {
    const x = await xml(
      await renderDocx(spec({ blocks: [{ type: 'paragraph', text: 'שינוי -12% וגם −5 ו-7 ותל-אביב' }] }), opts),
    );
    const runs = x.match(/<w:r>.*?<\/w:r>/gs) ?? [];
    for (const t of ['>-12%<', '>−5<']) {
      const r = runs.find((run) => run.includes(t));
      expect(r, t).toBeDefined();
      expect(r).not.toContain('<w:rtl');
    }
    // "ו-7": the hyphen follows a letter, so it stays in the Hebrew run.
    expect(runs.find((r) => r.includes('>7<'))).toBeDefined();
    expect(runs.find((r) => r.includes('>-7<'))).toBeUndefined();
  });

  it('does not number a clause title that already starts with its own number', async () => {
    const x = await xml(
      await renderDocx(
        spec({
          blocks: [
            { type: 'clause', title: '1. מבוא', text: 'א' },
            { type: 'clause', title: 'סעיף 2 תשלום', text: 'ב' },
          ],
        }),
        opts,
      ),
    );
    expect(x).toContain('מבוא');
    expect(x).toContain('תשלום');
    const { value } = await mammoth.extractRawText({ buffer: await renderDocx(
      spec({ blocks: [{ type: 'clause', title: '1. מבוא', text: 'א' }, { type: 'clause', title: 'סעיף 2 תשלום', text: 'ב' }] }),
      opts,
    ) });
    expect(value).toMatch(/1\.\s*מבוא/);
    expect(value).not.toMatch(/1\.\s*1/);
    expect(value).toMatch(/2\.\s*תשלום/);
    expect(value).not.toContain('סעיף 2');
  });

  it('formats table cells by the column numberFormat', async () => {
    const src = { kind: 'instruction' } as const;
    const x = await xml(
      await renderDocx(
        spec({
          blocks: [
            {
              type: 'table',
              header: ['מחיר', 'הנחה', 'כמות', 'ממוצע'],
              rows: [[{ v: 1890, src }, { v: 0.15, src }, { v: 3, src }, { v: 2.5, src }]],
              numberFormat: ['money', 'percent', 'int', 'decimal2'],
            },
          ],
        }),
        opts,
      ),
    );
    expect(x).toContain('>₪1,890<');
    expect(x).toContain('>15%<');
    expect(x).toContain('>3<');
    expect(x).toContain('>2.50<');
  });
});

describe('createDbImageLoader', () => {
  const dir = join(config.documentRoot, `__docx-loader-test-${process.pid}`);
  const rel = (n: string) => `__docx-loader-test-${process.pid}/${n}`;

  async function seed(id: string, business: string, storedPath: string, mediaType = 'image/png') {
    await testDb().query(
      `INSERT INTO documents (document_id, business_id, source, original_name, media_type, byte_size,
                              sha256, stored_path, status)
       VALUES ($1, $2, 'manual', 'x.png', $3, 10, rpad(md5($1), 64, '0'), $4, 'extracted')`,
      [id, business, mediaType, storedPath],
    );
  }

  beforeEach(async () => {
    await resetDatabase();
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.png'), PNG);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await closePool();
  });

  it('loads the file of this business', async () => {
    await seed('DOC-a', 'biz-1', rel('a.png'));
    const got = await withBusiness('biz-1', (db) => createDbImageLoader(db)('DOC-a'));
    expect(got?.mediaType).toBe('image/png');
    expect(got?.bytes.equals(PNG)).toBe(true);
  });

  it('does not serve a document of another business', async () => {
    await seed('DOC-b', 'biz-2', rel('a.png'));
    expect(await withBusiness('biz-1', (db) => createDbImageLoader(db)('DOC-b'))).toBeNull();
    // and the renderer turns that into unknown_image
    await expect(
      withBusiness('biz-1', (db) =>
        renderDocx(spec({ blocks: [{ type: 'image', documentId: 'DOC-b' }] }), {
          currency: 'ILS',
          images: createDbImageLoader(db),
        }),
      ),
    ).rejects.toMatchObject({ code: 'unknown_image' });
  });

  it('rejects traversal and absolute stored paths', async () => {
    await seed('DOC-t', 'biz-1', '../outside.png');
    const outside = join(tmpdir(), `docx-loader-outside-${process.pid}.png`);
    await writeFile(outside, PNG); // exists, so only the containment check can refuse it
    await seed('DOC-abs', 'biz-1', outside);
    expect(await withBusiness('biz-1', (db) => createDbImageLoader(db)('DOC-t'))).toBeNull();
    expect(await withBusiness('biz-1', (db) => createDbImageLoader(db)('DOC-abs'))).toBeNull();
    await rm(outside, { force: true });
    // control: the same file by its relative path loads
    await seed('DOC-ok', 'biz-1', rel('a.png'));
    expect(await withBusiness('biz-1', (db) => createDbImageLoader(db)('DOC-ok'))).not.toBeNull();
  });

  it('returns null for a missing file and rethrows other I/O errors', async () => {
    await seed('DOC-m', 'biz-1', rel('missing.png'));
    expect(await withBusiness('biz-1', (db) => createDbImageLoader(db)('DOC-m'))).toBeNull();
    await seed('DOC-dir', 'biz-1', rel('.'));
    await expect(withBusiness('biz-1', (db) => createDbImageLoader(db)('DOC-dir'))).rejects.toBeDefined();
  });

  it('refuses a file over 20MB', async () => {
    await writeFile(join(dir, 'big.png'), Buffer.alloc(20 * 1024 * 1024 + 1));
    await seed('DOC-big', 'biz-1', rel('big.png'));
    await expect(withBusiness('biz-1', (db) => createDbImageLoader(db)('DOC-big'))).rejects.toMatchObject({ code: 'image_too_large' });
  });
});
