import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { renderPptx } from './render-pptx.js';
import { SpecRenderError } from './render-error.js';
import type { ImageLoader } from './render-shared.js';
import type { PptxSpec, Slide } from '../domain/document-spec.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const png: ImageLoader = async () => ({ bytes: PNG, mediaType: 'image/png' });
const none: ImageLoader = async () => null;

function spec(slides: Slide[], over: Partial<PptxSpec> = {}): PptxSpec {
  return {
    format: 'pptx',
    language: 'he',
    kind: 'presentation',
    title: 'מצגת',
    filename: 'deck',
    style: { theme: 'clean', accent: 'navy' },
    sources: [],
    slides,
    ...over,
  };
}

async function slideXml(buf: Buffer, n: number): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  return zip.file(`ppt/slides/slide${n}.xml`)!.async('string');
}

const bullets: Slide = { type: 'titleBullets', title: 'כותרת', bullets: ['נקודה ראשונה', 'נקודה שנייה'] };

describe('renderPptx', () => {
  it('he text bodies carry rtl="1" and algn="r"', async () => {
    const { buffer } = await renderPptx(spec([bullets]), { currency: 'ILS', images: none });
    const x = await slideXml(buffer, 1);
    expect(x).toContain('rtl="1"');
    expect(x).toContain('algn="r"');
    expect(x).toContain('lang="he-IL"');
  });

  it('en deck is not rtl', async () => {
    const { buffer } = await renderPptx(
      spec([{ type: 'titleBullets', title: 'Title', bullets: ['One'] }], { language: 'en' }),
      { currency: 'ILS', images: none },
    );
    const x = await slideXml(buffer, 1);
    expect(x).toContain('One');
    expect(x).not.toContain('rtl="1"');
  });

  it('collage of 5 lays out 5 pictures', async () => {
    const { buffer, placeholders } = await renderPptx(
      spec([{ type: 'collage', documentIds: ['a', 'b', 'c', 'd', 'e'] }]),
      { currency: 'ILS', images: png },
    );
    const x = await slideXml(buffer, 1);
    expect((x.match(/<p:pic>/g) ?? []).length).toBe(5);
    expect(placeholders).toBe(0);
  });

  it('missing image yields a placeholder and placeholders=1', async () => {
    const { buffer, placeholders } = await renderPptx(
      spec([{ type: 'imageText', title: 'תמונה', text: 'טקסט', documentId: 'missing' }]),
      { currency: 'ILS', images: none },
    );
    expect(placeholders).toBe(1);
    const x = await slideXml(buffer, 1);
    expect(x).toContain('כאן תמונה');
    expect(x).not.toContain('<p:pic>');
  });

  it('English placeholder says Image here', async () => {
    const { buffer, placeholders } = await renderPptx(
      spec([{ type: 'imageText', title: 'T', text: 'x', documentId: 'm' }], { language: 'en' }),
      { currency: 'ILS', images: none },
    );
    expect(placeholders).toBe(1);
    expect(await slideXml(buffer, 1)).toContain('Image here');
  });

  it('a present image with a wrong media type still throws', async () => {
    const bad: ImageLoader = async () => ({ bytes: PNG, mediaType: 'image/gif' });
    await expect(
      renderPptx(spec([{ type: 'imageText', title: 'T', text: 'x', documentId: 'g' }]), {
        currency: 'ILS',
        images: bad,
      }),
    ).rejects.toBeInstanceOf(SpecRenderError);
  });

  it('a png whose bytes are not png throws', async () => {
    const bad: ImageLoader = async () => ({ bytes: Buffer.from('not an image at all, really'), mediaType: 'image/png' });
    await expect(
      renderPptx(spec([{ type: 'collage', documentIds: ['a', 'b'] }]), { currency: 'ILS', images: bad }),
    ).rejects.toMatchObject({ code: 'unsupported_image' });
  });

  it('40 slides render', async () => {
    const slides = Array.from({ length: 40 }, () => bullets);
    const { buffer } = await renderPptx(spec(slides), { currency: 'ILS', images: none });
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))).toHaveLength(40);
  });

  it('table cells go through formatCell with the column format', async () => {
    const { buffer } = await renderPptx(
      spec([
        {
          type: 'table',
          title: 'מחירים',
          header: ['פריט', 'מחיר', 'הנחה'],
          rows: [[{ t: 'מוצר' }, { v: 1890, src: { kind: 'instruction' } }, { v: 0.15, src: { kind: 'instruction' } }]],
          numberFormat: ['int', 'money', 'percent'],
        },
      ]),
      { currency: 'ILS', images: none },
    );
    const x = await slideXml(buffer, 1);
    expect(x).toContain('₪1,890');
    expect(x).toContain('15%');
  });

  it('digit runs inside Hebrew text are their own run without rtl', async () => {
    const { buffer } = await renderPptx(
      spec([{ type: 'paragraph', text: 'הנחה של 39% ומחיר ₪1,890 בלבד' }]),
      { currency: 'ILS', images: none },
    );
    const x = await slideXml(buffer, 1);
    expect(x).toMatch(/<a:t>39%<\/a:t>/);
    expect(x).toMatch(/<a:t>₪1,890<\/a:t>/);
  });

  it('chart slide gets a native chart part', async () => {
    const { buffer } = await renderPptx(
      spec([
        {
          type: 'chart',
          title: 'מכירות',
          chartType: 'bar',
          header: ['חודש', 'סכום'],
          rows: [
            [{ t: 'ינואר' }, { v: 10, src: { kind: 'instruction' } }],
            [{ t: 'פברואר' }, { v: 20, src: { kind: 'instruction' } }],
          ],
          column: 1,
          labelColumn: 0,
        },
      ]),
      { currency: 'ILS', images: none },
    );
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files).some((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f))).toBe(true);
  });

  it('title slide renders title and subtitle', async () => {
    const { buffer } = await renderPptx(spec([{ type: 'title', title: 'ברוכים הבאים', subtitle: 'תת כותרת' }]), {
      currency: 'ILS',
      images: none,
    });
    const x = await slideXml(buffer, 1);
    expect(x).toContain('ברוכים הבאים');
    expect(x).toContain('תת כותרת');
  });

  const ref = { kind: 'instruction' } as const;
  const twoCol: Slide = {
    type: 'table',
    title: 'טבלה',
    header: ['שם', 'הנחה', 'מחיר'],
    rows: [
      [{ t: 'אלפא' }, { v: 0.15, src: ref }, { v: 1890, src: ref }],
      [{ t: 'בטא' }, { v: 0.5, src: ref }, { v: 20, src: ref }],
    ],
    numberFormat: ['int', 'percent', 'money'],
  };
  const texts = (x: string) => [...x.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);

  it('he table columns are reversed (first header rightmost) and formats follow their column', async () => {
    const { buffer } = await renderPptx(spec([twoCol]), { currency: 'ILS', images: none });
    const t = texts(await slideXml(buffer, 1));
    const at = (s: string) => t.indexOf(s);
    // XML order is left-to-right on screen: last column first, first column last.
    expect(at('מחיר')).toBeLessThan(at('הנחה'));
    expect(at('הנחה')).toBeLessThan(at('שם'));
    expect(t.slice(at('אלפא') - 2, at('אלפא') + 1)).toEqual(['₪1,890', '15%', 'אלפא']);
    expect(t.slice(at('בטא') - 2, at('בטא') + 1)).toEqual(['₪20', '50%', 'בטא']);
  });

  it('en table keeps column order', async () => {
    const { buffer } = await renderPptx(
      spec([{ ...twoCol, header: ['Name', 'Disc', 'Price'] } as Slide], { language: 'en' }),
      { currency: 'ILS', images: none },
    );
    const t = texts(await slideXml(buffer, 1));
    expect(t.indexOf('Name')).toBeLessThan(t.indexOf('Disc'));
    expect(t.indexOf('Disc')).toBeLessThan(t.indexOf('Price'));
  });

  it('header digit runs are their own run', async () => {
    const { buffer } = await renderPptx(
      spec([{ type: 'table', title: 'ט', header: ['שנת 2025'], rows: [[{ t: 'x' }]] }]),
      { currency: 'ILS', images: none },
    );
    expect(texts(await slideXml(buffer, 1))).toContain('2025');
  });

  const chart = (chartType: 'bar' | 'line' | 'pie'): Slide => ({
    type: 'chart',
    title: 'c',
    chartType,
    header: ['a', 'b'],
    rows: [[{ t: 'x' }, { v: 1, src: ref }]],
    column: 1,
    labelColumn: 0,
  });
  async function chartXml(chartType: 'bar' | 'line' | 'pie', language: 'he' | 'en'): Promise<string> {
    const { buffer } = await renderPptx(spec([chart(chartType)], { language }), { currency: 'ILS', images: none });
    const zip = await JSZip.loadAsync(buffer);
    const f = Object.keys(zip.files).find((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))!;
    return zip.file(f)!.async('string');
  }

  it('he bar and line charts reverse the category axis; en and pie do not', async () => {
    expect(await chartXml('bar', 'he')).toContain('<c:orientation val="maxMin"/>');
    expect(await chartXml('line', 'he')).toContain('<c:orientation val="maxMin"/>');
    expect(await chartXml('bar', 'en')).not.toContain('maxMin');
    expect(await chartXml('pie', 'he')).not.toContain('maxMin');
  });

  it('bar and line charts hide the value axis (data labels carry the values)', async () => {
    for (const type of ['bar', 'line'] as const) {
      const xml = await chartXml(type, 'he');
      const valAx = /<c:valAx>[\s\S]*?<\/c:valAx>/.exec(xml)?.[0] ?? '';
      expect(valAx, type).toContain('<c:delete val="1"/>');
      expect(xml, type).toContain('<c:showVal val="1"/>');
    }
  });
});
