import { describe, expect, it } from 'vitest';
import type { PdfSpec } from '../domain/document-spec.js';
import { renderFooterTemplate, renderHtml, type PdfAssets } from './render-html.js';
import { SpecRenderError } from './render-error.js';
import { CONTRACT_DISCLAIMER_HE } from './validate-spec.js';

const FONT = 'data:font/ttf;base64,AAEAAA==';
const PNG_URL = 'data:image/png;base64,iVBORw0KGgo=';
const assets: PdfAssets = {
  fonts: { hebrewRegular: FONT, hebrewBold: FONT, latinRegular: FONT, latinBold: FONT },
  images: new Map([['DOC-1', PNG_URL]]),
};
const opts = { currency: 'ILS' };

function spec(over: Partial<PdfSpec> = {}): PdfSpec {
  return {
    format: 'pdf',
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

describe('renderHtml', () => {
  it('he html has dir=rtl lang=he on <html>', () => {
    const html = renderHtml(spec(), assets, opts);
    expect(html).toMatch(/^<!DOCTYPE html>\s*<html dir="rtl" lang="he">/);
    expect(html).toContain('שלום עולם');
    const en = renderHtml(spec({ language: 'en', blocks: [{ type: 'paragraph', text: 'Hello' }] }), assets, opts);
    expect(en).toMatch(/<html dir="ltr" lang="en">/);
  });

  it('no <script> anywhere, and an injected "<script>" in a paragraph appears escaped', () => {
    const html = renderHtml(
      spec({
        title: '<img src=x onerror=alert(1)>',
        blocks: [
          { type: 'paragraph', text: 'לפני <script>alert("x")</script> אחרי' },
          { type: 'table', header: ['<b>"q"</b>'], rows: [[{ t: "</td><script>1</script>'" }]] },
        ],
      }),
      assets,
      opts,
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img src=x/i);
    expect(html).not.toMatch(/<b>/);
    // The text ran through the renderer and came out escaped, not dropped.
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;/td&gt;&lt;script&gt;');
    expect(html).toContain('&#39;');
  });

  it('a bidi control in source text is stripped', () => {
    const rlo = '‮';
    const html = renderHtml(
      spec({ title: `כותרת${rlo}`, blocks: [{ type: 'paragraph', text: `invoice${rlo}gpj.exe` }, { type: 'list', style: 'bullet', items: [`פריט⁦א⁩`] }] }),
      assets,
      opts,
    );
    expect(html).toContain('invoicegpj.exe');
    expect(html).toContain('פריטא');
    expect(html).not.toMatch(/[؜‎‏‪-‮⁦-⁩]/);
  });

  it('numbers are inside <bdi dir="ltr">', () => {
    const html = renderHtml(
      spec({
        blocks: [
          { type: 'paragraph', text: 'המחיר ₪1,890 ועוד 39% עד 03/11/2026' },
          { type: 'table', header: ['סכום'], rows: [[{ v: 1890.5, src: { kind: 'instruction' } }]], numberFormat: ['money'] },
          { type: 'list', style: 'ordered', items: ['ראשון', 'שני'] },
        ],
      }),
      assets,
      opts,
    );
    expect(html).toContain('<bdi dir="ltr">₪1,890</bdi>');
    expect(html).toContain('<bdi dir="ltr">39%</bdi>');
    expect(html).toContain('<bdi dir="ltr">03/11/2026</bdi>');
    expect(html).toContain('<bdi dir="ltr">₪1,890.5</bdi>');
    expect(html).toContain('<bdi dir="ltr">2.</bdi>');
    // No digit sits outside an LTR isolate in the body text.
    const body = html.slice(html.indexOf('<body'));
    const outside = body.replace(/<bdi dir="ltr">[^<]*<\/bdi>/g, '').replace(/<[^>]*>/g, '');
    expect(outside).not.toMatch(/\d/);
  });

  it('every asset url in the html is a data: url', () => {
    const html = renderHtml(spec({ blocks: [{ type: 'image', documentId: 'DOC-1' }] }), assets, opts);
    expect(html).toContain(`src="${PNG_URL}"`);
    expect(html).toContain(`url("${FONT}")`);
    const urls = [
      ...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g),
      ...html.matchAll(/url\(\s*"?([^")]*)"?\s*\)/g),
    ].map((m) => m[1]);
    expect(urls.length).toBeGreaterThanOrEqual(5);
    for (const u of urls) expect(u?.startsWith('data:')).toBe(true);
    expect(html).not.toMatch(/@import/);
  });

  it('a missing image is refused as unknown_image', () => {
    let err: unknown;
    try {
      renderHtml(spec({ blocks: [{ type: 'image', documentId: 'DOC-404' }] }), assets, opts);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SpecRenderError);
    expect((err as SpecRenderError).code).toBe('unknown_image');
  });

  it('numbers clauses like docx and a contract gets signatures and legal basis', () => {
    const html = renderHtml(
      spec({
        kind: 'contract',
        legalBasis: [{ law: 'חוק החוזים', note: 'חלק כללי' }],
        blocks: [
          { type: 'clause', title: '1. הגדרות', text: 'שורה אחת' },
          { type: 'clause', title: 'תשלום', text: 'א\n\nב' },
        ],
      }),
      assets,
      opts,
    );
    expect(html).toContain('<bdi dir="ltr">1.</bdi> הגדרות');
    expect(html).not.toContain('1. הגדרות');
    expect(html).toContain('<bdi dir="ltr">2.1</bdi> א');
    expect(html).toContain('<bdi dir="ltr">2.2</bdi> ב');
    expect(html).toContain('חתימת צד א׳');
    expect(html).toContain('הבסיס החוקי');
    expect(html).toContain('חוק החוזים — חלק כללי');
  });

  it('is deterministic and the A4 page size is fixed in CSS', () => {
    const s = spec({ style: { theme: 'formal', accent: 'teal' } });
    const a = renderHtml(s, assets, opts);
    expect(renderHtml(s, assets, opts)).toBe(a);
    expect(a).toMatch(/@page\s*\{[^}]*size:\s*A4/);
    expect(a).toContain('#1B7F8C');
    expect(a).toContain("Content-Security-Policy");
  });
});

describe('renderFooterTemplate', () => {
  it('carries page numbers, and the disclaimer only on a contract', () => {
    const letter = renderFooterTemplate(spec(), assets);
    expect(letter).toContain('<span class="pageNumber"></span>');
    expect(letter).toContain('<span class="totalPages"></span>');
    expect(letter).not.toContain(CONTRACT_DISCLAIMER_HE);
    const contract = renderFooterTemplate(spec({ kind: 'contract', legalBasis: [{ law: 'x' }] }), assets);
    expect(contract).toContain(CONTRACT_DISCLAIMER_HE);
    expect(contract).not.toMatch(/<script/i);
  });
});
