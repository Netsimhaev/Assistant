/**
 * Builds tiny, valid PDF files by hand for tests — no fixture binaries to
 * keep in sync, and no PDF-writing library pulled into the dependency tree
 * just so a test can produce input for the one that reads.
 *
 * Each page is a list of text lines (written with the non-embedded standard
 * font Helvetica, one `BT … Tj ET` per line) or `null` for a page with no
 * text layer at all — it draws a filled rectangle instead, which is what a
 * scanned page looks like to a text extractor: marks on the page, no text.
 *
 * The cross-reference table carries real byte offsets, so a strict parser
 * reads the file as written rather than falling back to reconstruction.
 * Text must be printable ASCII: Helvetica's WinAnsi encoding is all the
 * builder promises.
 */

export interface BuildPdfOptions {
  /** A document-level `/OpenAction << /S /JavaScript /JS (…) >>`. */
  openActionJs?: string;
  /** Appended after `%%EOF`, to make otherwise-identical files hash differently. */
  trailingComment?: string;
  /**
   * Point size, and line spacing, of the text. pdf.js drops text that runs
   * off the page, so a test that needs a lot of text on one page asks for a
   * small size rather than a line wider than the page.
   */
  fontSize?: number;
}

function escapePdfString(text: string): string {
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw new TypeError(`buildPdf: printable ASCII only, got ${JSON.stringify(text)}`);
  }
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

function contentStreamFor(lines: string[] | null, fontSize: number): string {
  if (lines === null) return '0.5 g 72 72 300 400 re f';
  const leading = fontSize + fontSize / 3;
  return lines
    .map((line, i) => `BT /F1 ${fontSize} Tf 36 ${756 - i * leading} Td (${escapePdfString(line)}) Tj ET`)
    .join('\n');
}

export function buildPdf(pages: (string[] | null)[], options: BuildPdfOptions = {}): Buffer {
  // Fixed object numbers: 1 catalog, 2 page tree, 3 font, 4 JS action
  // (always present, referenced only when asked for), then two objects per
  // page — the page and its content stream.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);

  const openAction = options.openActionJs !== undefined ? ' /OpenAction 4 0 R' : '';
  objects.push(`<< /Type /Catalog /Pages 2 0 R${openAction} >>`);
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push(`<< /S /JavaScript /JS (${escapePdfString(options.openActionJs ?? '')}) >>`);

  pages.forEach((lines, i) => {
    const contentId = pageIds[i]! + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const stream = contentStreamFor(lines, options.fontSize ?? 12);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });

  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  if (options.trailingComment !== undefined) body += `%${options.trailingComment}\n`;

  return Buffer.from(body, 'latin1');
}
