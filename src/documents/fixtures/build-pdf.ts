/**
 * Builds tiny, valid PDF files by hand for tests — no fixture binaries to
 * keep in sync, and no PDF-writing library pulled into the dependency tree
 * just so a test can produce input for the one that reads.
 *
 * Each page is a list of lines, or `null` for a page with no text layer at
 * all — it draws a filled rectangle instead, which is what a scanned page
 * looks like to a text extractor: marks on the page, no text. A line is
 * either a string (one `BT … Tj ET` at the left margin) or a list of runs,
 * each its own `BT … Tj ET` at its own x position on the line's baseline, in
 * the order given — which is the content-stream order, not reading order.
 *
 * Text is written with the non-embedded standard font Helvetica. Printable
 * ASCII uses WinAnsi; the 27 Hebrew letters are mapped onto codes 128–154
 * through a `/Differences` array naming their standard glyphs
 * (`afii57664`…`afii57690`), the way a real PDF without an embedded font
 * names them. Characters are written in the order the caller gives them:
 * a Hebrew run as a real PDF stores it is in visual order (see
 * `visualOrder`), and that is the caller's to say.
 *
 * The cross-reference table carries real byte offsets, so a strict parser
 * reads the file as written rather than falling back to reconstruction.
 */

import { constants, deflateRawSync } from 'node:zlib';

/** A piece of text placed at `x` (points from the page's left edge). */
export interface PdfRun {
  text: string;
  x: number;
}

export type PdfLine = string | PdfRun[];

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
  /**
   * Replaces the first page's content stream with a FlateDecode stream that
   * inflates to this many MiB of spaces — a decompression bomb. The file
   * stays about a kilobyte per MiB.
   */
  flateBombMib?: number;
}

/** In logical order, `afii57664` through `afii57690`. */
const HEBREW = 'אבגדהוזחטיךכלםמןנסעףפץצקרשת';
const HEBREW_FIRST_CODE = 128;
const DIFFERENCES = [...HEBREW].map((_, i) => `/afii${57664 + i}`).join(' ');

/** Reverses a run into the visual (left-to-right glyph) order a PDF stores Hebrew in. */
export function visualOrder(logical: string): string {
  return [...logical].reverse().join('');
}

function encodePdfString(text: string): string {
  let out = '';
  for (const ch of text) {
    const hebrew = HEBREW.indexOf(ch);
    if (hebrew >= 0) {
      out += `\\${(HEBREW_FIRST_CODE + hebrew).toString(8)}`;
    } else if (/^[\x20-\x7e]$/.test(ch)) {
      out += ch === '\\' || ch === '(' || ch === ')' ? `\\${ch}` : ch;
    } else {
      throw new TypeError(`buildPdf: printable ASCII or Hebrew letters only, got ${JSON.stringify(ch)}`);
    }
  }
  return out;
}

function contentStreamFor(lines: PdfLine[] | null, fontSize: number): string {
  if (lines === null) return '0.5 g 72 72 300 400 re f';
  const leading = fontSize + fontSize / 3;
  const runs: string[] = [];
  lines.forEach((line, i) => {
    const y = 756 - i * leading;
    const parts = typeof line === 'string' ? [{ text: line, x: 36 }] : line;
    for (const run of parts) {
      runs.push(`BT /F1 ${fontSize} Tf ${run.x} ${y} Td (${encodePdfString(run.text)}) Tj ET`);
    }
  });
  return runs.join('\n');
}

/**
 * Raw deflate blocks ending in a full flush are byte-aligned and share no
 * dictionary, so one compressed MiB repeated N times is a valid stream that
 * inflates to N MiB — without compressing N MiB to build it. A final empty
 * fixed-Huffman block (`03 00`) closes it. The zlib wrapper's Adler-32 is
 * left as zeros: pdf.js does not check it.
 */
function flateBomb(mib: number): Buffer {
  const block = deflateRawSync(Buffer.alloc(1024 * 1024, 0x20), {
    level: 9,
    finishFlush: constants.Z_FULL_FLUSH,
  });
  const blocks = Buffer.concat(Array.from({ length: mib }, () => block));
  return Buffer.concat([Buffer.from([0x78, 0xda]), blocks, Buffer.from([0x03, 0x00]), Buffer.alloc(4)]);
}

function streamObject(dict: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<< /Length ${data.length}${dict} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

export function buildPdf(pages: (PdfLine[] | null)[], options: BuildPdfOptions = {}): Buffer {
  // Fixed object numbers: 1 catalog, 2 page tree, 3 font, 4 JS action
  // (always present, referenced only when asked for), then two objects per
  // page — the page and its content stream.
  const objects: Buffer[] = [];
  const text = (s: string): Buffer => Buffer.from(s, 'latin1');
  const pageIds = pages.map((_, i) => 5 + i * 2);

  const openAction = options.openActionJs !== undefined ? ' /OpenAction 4 0 R' : '';
  objects.push(text(`<< /Type /Catalog /Pages 2 0 R${openAction} >>`));
  objects.push(text(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`));
  objects.push(
    text(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding ' +
        `/BaseEncoding /WinAnsiEncoding /Differences [${HEBREW_FIRST_CODE} ${DIFFERENCES}] >> >>`,
    ),
  );
  objects.push(text(`<< /S /JavaScript /JS (${encodePdfString(options.openActionJs ?? '')}) >>`));

  pages.forEach((lines, i) => {
    const contentId = pageIds[i]! + 1;
    objects.push(
      text(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
          `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
    if (i === 0 && options.flateBombMib !== undefined) {
      objects.push(streamObject(' /Filter /FlateDecode', flateBomb(options.flateBombMib)));
    } else {
      objects.push(streamObject('', text(contentStreamFor(lines, options.fontSize ?? 12))));
    }
  });

  const chunks: Buffer[] = [text('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([text(`${i + 1} 0 obj\n`), obj, text('\nendobj\n')]);
    chunks.push(chunk);
    length += chunk.length;
  });

  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) tail += `${String(offset).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  if (options.trailingComment !== undefined) tail += `%${options.trailingComment}\n`;
  chunks.push(text(tail));

  return Buffer.concat(chunks);
}
