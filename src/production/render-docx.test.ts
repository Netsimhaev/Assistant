import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { renderDocx, type ImageLoader } from './render-docx.js';
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
  it('he paragraphs carry w:bidi and w:jc right', async () => {
    const x = await xml(await renderDocx(spec(), opts));
    expect(x).toContain('<w:bidi');
    // In a w:bidi paragraph OOXML jc is start/end-relative: w:jc "left" is what
    // Word and LibreOffice draw flush RIGHT (the docx library applies this flip
    // for AlignmentType.RIGHT). A literal "right" would draw flush left.
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
});
