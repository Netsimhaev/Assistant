/**
 * PDF stage 1: a validated `PdfSpec` -> one self-contained HTML document that
 * headless Chromium prints (`render-pdf.ts`, `chromium.ts`). Spec §6.4.
 *
 * **This HTML is the security boundary of the PDF path**, so it is built only
 * here, from fixed strings plus spec text, and three rules hold by construction:
 *
 *  - Every piece of spec text goes through `stripBidiControls` and then
 *    `escapeHtml` (`text()` below is the only way spec text reaches the
 *    output). A `<script>` in a paragraph is printed as `&lt;script&gt;`.
 *  - There is no script: no `<script>`, no event attribute, no `javascript:`;
 *    the page is also loaded with JavaScript disabled, and a CSP meta forbids
 *    everything except inline style and `data:` fonts/images.
 *  - Every URL is a `data:` URL: the fonts and images arrive pre-encoded in
 *    `PdfAssets` (`loadPdfAssets`, `render-pdf.ts`). Nothing here names a host.
 *
 * Direction comes from `spec.language` in code. Every digit run
 * (`splitNumberRuns`, shared with docx/pptx) is wrapped in `<bdi dir="ltr">`
 * so the bidi algorithm cannot reorder `₪1,890` or `03/11/2026` inside Hebrew.
 * Clauses are numbered by `numberClause` — the same helper docx uses.
 *
 * Page numbers and the contract disclaimer are NOT in this document: Chromium
 * did not print CSS `@page` margin boxes for most of its history, so they go
 * in Playwright's `footerTemplate` (`renderFooterTemplate`), which Chromium
 * draws in the bottom page margin of every page. The template is our own
 * static markup; the only variable text (the disclaimer) is a constant. It
 * carries the same CSP meta as the page — defence in depth: the template is
 * inserted into Chromium's own header/footer document, where a meta CSP may
 * not take effect, so the real control remains that the template holds
 * nothing but our constants and `data:` fonts.
 */
import { escapeHtml } from '../util/html.js';
import type { Block, PdfSpec, StyleTheme } from '../domain/document-spec.js';
import { stripBidiControls } from '../util/bidi.js';
import { formatCell } from './format-value.js';
import { SpecRenderError } from './render-error.js';
import { ACCENT_HEX, numberClause, splitNumberRuns } from './render-shared.js';
import { CONTRACT_DISCLAIMER_EN, CONTRACT_DISCLAIMER_HE } from './validate-spec.js';

export interface PdfFonts {
  hebrewRegular: string;
  hebrewBold: string;
  latinRegular: string;
  latinBold: string;
}

/** Everything the page may load, already encoded as `data:` URLs. */
export interface PdfAssets {
  fonts: PdfFonts;
  /** `documentId` -> `data:image/...;base64,...` for every image block. */
  images: ReadonlyMap<string, string>;
}

export interface RenderHtmlOptions {
  currency: string;
}

const FAMILY_HE = 'DocHebrew';
const FAMILY_LATIN = 'DocLatin';
const FONT_STACK = `"${FAMILY_HE}", "${FAMILY_LATIN}"`;

/** Fixed, closed per-theme CSS. `{accent}` is replaced by the palette hex. */
const THEME_CSS: Record<StyleTheme, string> = {
  clean: `
h1.title { border-bottom: 2px solid {accent}; padding-bottom: 6pt; }
th { background: #E7E6E6; }
td, th { border: 1px solid #BFBFBF; }`,
  formal: `
h1.title { border-top: 3px double {accent}; border-bottom: 3px double {accent}; padding: 8pt 0; letter-spacing: 0.5pt; }
h2, h3, h4 { text-decoration: underline; text-underline-offset: 3pt; }
th { background: #F2F2F2; }
td, th { border: 1px solid #7F7F7F; }`,
  bold: `
h1.title { background: {accent}; color: #FFFFFF !important; padding: 10pt; }
h2, h3, h4 { border-inline-start: 5pt solid {accent}; padding-inline-start: 6pt; }
th { background: {accent}; color: #FFFFFF; }
td, th { border: 1px solid #A6A6A6; }`,
  minimal: `
th { border-bottom: 1.5px solid {accent}; }
td { border-bottom: 1px solid #E0E0E0; }`,
};

/** Text -> HTML: strip bidi controls, escape, isolate each digit run as LTR. */
function text(value: string): string {
  return splitNumberRuns(stripBidiControls(value))
    .map((p) => (p.ltr ? `<bdi dir="ltr">${escapeHtml(p.text)}</bdi>` : escapeHtml(p.text)))
    .join('');
}

/** A generated label (`2.1`, `3.`) that must stay LTR. Always our own digits. */
function label(value: string): string {
  return `<bdi dir="ltr">${escapeHtml(value)}</bdi>`;
}

function fontFaces(fonts: PdfFonts, faces: readonly (keyof PdfFonts)[]): string {
  const desc: Record<keyof PdfFonts, [string, number]> = {
    hebrewRegular: [FAMILY_HE, 400],
    hebrewBold: [FAMILY_HE, 700],
    latinRegular: [FAMILY_LATIN, 400],
    latinBold: [FAMILY_LATIN, 700],
  };
  return faces
    .map((k) => {
      const [family, weight] = desc[k];
      return `@font-face { font-family: "${family}"; font-weight: ${weight}; font-style: normal; src: url("${cssUrl(fonts[k])}") format("truetype"); }`;
    })
    .join('\n');
}

/** A `data:` URL is the only thing allowed into CSS/attributes; anything else is a bug. */
function cssUrl(url: string): string {
  if (!/^data:(?:font\/ttf|image\/png|image\/jpeg);base64,[A-Za-z0-9+/=]*$/.test(url)) {
    throw new Error('renderHtml: an asset is not a base64 data: URL');
  }
  return url;
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; script-src 'none'; base-uri 'none'; form-action 'none'";

function tableHtml(block: Extract<Block, { type: 'table' }>, currency: string, where: string): string {
  const head = block.header.map((h) => `<th>${text(h)}</th>`).join('');
  const body = block.rows
    .map(
      (row, r) =>
        `<tr>${row
          .map((c, i) => `<td>${text(formatCell(c, block.numberFormat?.[i], currency, `${where}.rows[${r}][${i}]`))}</td>`)
          .join('')}</tr>`,
    )
    .join('\n');
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

export function renderHtml(spec: PdfSpec, assets: PdfAssets, options: RenderHtmlOptions): string {
  const rtl = spec.language === 'he';
  const accent = `#${ACCENT_HEX[spec.style.accent]}`;
  const parts: string[] = [];

  parts.push(`<h1 class="title">${text(spec.title)}</h1>`);

  let clauseNo = 0;
  spec.blocks.forEach((block, i) => {
    const where = `blocks[${i}]`;
    switch (block.type) {
      case 'heading':
        // h1 is the document title; spec levels 1-3 map to h2-h4.
        parts.push(`<h${block.level + 1}>${text(block.text)}</h${block.level + 1}>`);
        return;
      case 'paragraph':
        parts.push(`<p>${text(block.text)}</p>`);
        return;
      case 'list':
        parts.push(
          `<div class="list">${block.items
            .map((item, n) => `<p class="item">${label(block.style === 'ordered' ? `${n + 1}.` : '•')} ${text(item)}</p>`)
            .join('')}</div>`,
        );
        return;
      case 'table':
        parts.push(tableHtml(block, options.currency, where));
        return;
      case 'pageBreak':
        parts.push('<div class="page-break"></div>');
        return;
      case 'image': {
        const url = assets.images.get(block.documentId);
        if (url === undefined) throw new SpecRenderError('unknown_image', where);
        parts.push(`<p class="image"><img src="${cssUrl(url)}" alt=""></p>`);
        return;
      }
      case 'clause': {
        clauseNo += 1;
        const clause = numberClause(clauseNo, block.title, block.text);
        parts.push(`<p class="clause-title">${label(clause.label)} ${text(clause.title)}</p>`);
        for (const line of clause.lines) {
          parts.push(line.label === null ? `<p>${text(line.text)}</p>` : `<p class="sub">${label(line.label)} ${text(line.text)}</p>`);
        }
        return;
      }
    }
  });

  if (spec.kind === 'contract') {
    const sig = rtl ? ['חתימת צד א׳', 'חתימת צד ב׳'] : ['Party A signature', 'Party B signature'];
    const date = rtl ? 'תאריך: ____________' : 'Date: ____________';
    parts.push(
      `<table class="signatures"><tr>${sig
        .map((s) => `<td><p>______________________</p><p>${text(s)}</p><p>${text(date)}</p></td>`)
        .join('')}</tr></table>`,
    );
    parts.push(`<h3>${text(rtl ? 'הבסיס החוקי' : 'Legal basis')}</h3>`);
    for (const basis of spec.legalBasis ?? []) {
      parts.push(`<p class="item">${label('•')} ${text(basis.note ? `${basis.law} — ${basis.note}` : basis.law)}</p>`);
    }
  }

  const css = `
${fontFaces(assets.fonts, ['hebrewRegular', 'hebrewBold', 'latinRegular', 'latinBold'])}
@page { size: A4; margin: 20mm 18mm 22mm 18mm; }
html, body { margin: 0; padding: 0; }
body { font-family: ${FONT_STACK}; font-size: 11pt; line-height: 1.5; color: #1A1A1A; text-align: ${rtl ? 'right' : 'left'}; }
h1, h2, h3, h4 { color: ${accent}; font-weight: 700; margin: 12pt 0 6pt; page-break-after: avoid; }
h1.title { font-size: 22pt; text-align: center; margin-top: 0; }
h2 { font-size: 16pt; } h3 { font-size: 14pt; } h4 { font-size: 12pt; }
p { margin: 0 0 6pt; }
p.item { margin-inline-start: 12pt; }
p.clause-title { font-weight: 700; margin-top: 10pt; }
p.sub { margin-inline-start: 12pt; }
p.image { text-align: center; }
img { max-width: 100%; height: auto; }
bdi { unicode-bidi: isolate; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 12pt; page-break-inside: auto; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
td, th { padding: 4pt 6pt; vertical-align: top; text-align: ${rtl ? 'right' : 'left'}; }
th { font-weight: 700; }
table.signatures td { border: none !important; padding-top: 24pt; }
.page-break { page-break-after: always; break-after: page; }
${THEME_CSS[spec.style.theme].replaceAll('{accent}', accent)}
`;

  return `<!DOCTYPE html>
<html dir="${rtl ? 'rtl' : 'ltr'}" lang="${rtl ? 'he' : 'en'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(CSP)}">
<title>${escapeHtml(stripBidiControls(spec.title))}</title>
<style>${css}</style>
</head>
<body>
${parts.join('\n')}
</body>
</html>
`;
}

/**
 * Playwright `footerTemplate`: page X / Y on every page, plus the D6
 * disclaimer on a contract. Chromium renders it in a separate frame that does
 * not see the page's fonts, so it carries its own `@font-face` (Hebrew for
 * the disclaimer, Latin for the digits) and an explicit font size — the frame
 * otherwise defaults to a near-invisible size. `pageNumber`/`totalPages` are
 * the class names Chromium fills in.
 */
export function renderFooterTemplate(spec: PdfSpec, assets: PdfAssets): string {
  const rtl = spec.language === 'he';
  const disclaimer =
    spec.kind === 'contract'
      ? `<div>${escapeHtml(stripBidiControls(rtl ? CONTRACT_DISCLAIMER_HE : CONTRACT_DISCLAIMER_EN))}</div>`
      : '';
  return `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(CSP)}"><style>${fontFaces(assets.fonts, ['hebrewRegular', 'latinRegular'])}
.doc-footer { width: 100%; box-sizing: border-box; padding: 0 18mm; font-family: ${FONT_STACK}; font-size: 8pt; color: #595959; text-align: center; }
</style><div class="doc-footer" dir="${rtl ? 'rtl' : 'ltr'}" lang="${rtl ? 'he' : 'en'}">${disclaimer}<div><bdi dir="ltr"><span class="pageNumber"></span> / <span class="totalPages"></span></bdi></div></div>`;
}
