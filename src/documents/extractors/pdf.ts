/**
 * The `pdf` extractor (spec §9.1 of
 * docs/superpowers/specs/2026-10-20-mailbox-connection-design.md): one
 * `text` artefact per page, each page's lines as paragraph blocks — the same
 * `TextContent` shape `docx.ts` and `passthrough.ts` produce, so a reader
 * cannot tell which extractor a page of text came from.
 *
 * A PDF arrives from senders nobody vouched for, and the format carries far
 * more than text: JavaScript actions, embedded font programs, XFA forms,
 * compressed streams of any declared size, and references to fonts, colour
 * profiles and WebAssembly decoders it expects to be fetched from a URL.
 * This module asks `pdfjs-dist` for text and as little else as the library
 * allows, and says so in `PDF_LOAD_OPTIONS`:
 *
 *   - **No script.** pdf.js never runs a document's JavaScript unless an
 *     embedder wires up its scripting sandbox; this module never does. The
 *     backstop is below the library: `run-extractor.ts` starts every
 *     extraction child with `--disallow-code-generation-from-strings`, so
 *     `eval` and `new Function` throw inside it whatever a parser attempts
 *     (`run-extractor.test.ts` proves the flag reaches the child).
 *     `isEvalSupported: false` is also passed, and is inert: pdfjs-dist 6
 *     removed the option along with its `new Function` font compiler. It is
 *     kept only so the setting reads as intended if a later version brings
 *     it back — it is not a control.
 *   - **Fonts are parsed, never installed.** Embedded font programs *are*
 *     parsed — pdf.js's worker runs them through `translateFont`, in
 *     JavaScript, even for text extraction, to learn glyph widths and the
 *     glyph-to-Unicode mapping. That parser is attack surface this module
 *     cannot switch off; the child's caps are what bound it.
 *     `disableFontFace: true` stops the parsed fonts from being installed as
 *     loaded font faces, and `useSystemFonts: false` stops any lookup of the
 *     machine's own fonts.
 *   - **No network, no URL fetches.** The file arrives as `data`, never a
 *     `url`; `cMapUrl`, `standardFontDataUrl`, `wasmUrl`, `iccUrl` and
 *     `docBaseUrl` are left unset, so the factories that would fetch them
 *     have nothing to fetch; `useWasm: false` keeps the WebAssembly image
 *     decoders out; `disableRange`/`disableStream`/`disableAutoFetch` close
 *     the incremental-loading paths, which only matter for a `url`. A CJK
 *     PDF whose text needs a CMap therefore extracts poorly or not at all —
 *     the price of never fetching one.
 *   - **No XFA.** `enableXfa: false`: an XFA form is a second document
 *     format inside the PDF, with its own parser.
 *   - **No worker.** Under Node pdf.js runs its "fake worker" on the main
 *     thread. This module hands it the worker module it imported itself
 *     (`globalThis.pdfjsWorker`), so pdf.js never resolves a `workerSrc`
 *     path or URL of its own. The isolation boundary is the child process
 *     `run-extractor.ts` spawns, not a web worker.
 *   - **Errors stop the read.** `stopAtErrors: true` makes a broken content
 *     stream reject instead of being silently skipped — a page pdf.js could
 *     only half-read would otherwise come back looking complete, and what we
 *     could not read is never the permissive answer. The rejection becomes
 *     the child's controlled `extractor_failed`, which `ingestDocument`
 *     records as a Hebrew rejection reason.
 *   - **No size limit inside pdf.js.** A FlateDecode stream inflates to
 *     whatever it inflates to, in off-heap buffers the V8 heap cap never
 *     sees. That is bounded outside this module, by the resident-set cap
 *     `run-extractor.ts` and the child's memory watchdog enforce.
 *
 * `pdfjs-dist` is imported lazily, inside `extractPdf`. The isolated child
 * (`extract-child.ts`) loads every extractor module, and a spreadsheet's
 * extraction has no reason to load pdf.js; and the child installs its
 * hardening (`child-hardening.ts`) before it dispatches — `console` rerouted
 * to stderr, and the optional native `@napi-rs/canvas` package pdf.js tries
 * to load on import refused — so pdf.js must be evaluated after that, not
 * hoisted ahead of it.
 *
 * **Lines and direction.** pdf.js returns text items in content-stream
 * order, and already reorders the characters *within* one item into logical
 * order (a Hebrew run stored visually comes back readable). It does not
 * order items *on a line*: a Hebrew line written as two runs, or a number
 * written before the Hebrew word it follows, comes back in the order the
 * producer happened to write them. `linesOf` therefore groups items into
 * lines by baseline, orders each line by position — right to left when most
 * of its letters are right-to-left, left to right otherwise — puts a space
 * between neighbours that a visible gap separates, and reassembles a run in
 * the other direction that the producer split into several items (see
 * `joinLine`).
 *
 * **Flags.** Two document-level facts go on the first artefact
 * (`ordinal: 0`), the same rule `docx.ts` and `xlsx.ts` follow:
 * `scanned_no_text` (no page read yielded a single character — a scan, or a
 * PDF of images; OCR is out of scope) and `truncated` from the page cap
 * (more than `MAX_PDF_PAGES` pages; the rest were never read). A page whose
 * own text exceeds the shared character cap (`capText`, `cell.ts`) is cut
 * and flagged `truncated` on that page's artefact only.
 */

import { readFile } from 'node:fs/promises';
import { capText } from '../cell.js';
import type { Block, DocumentArtifact, TextContent } from '../types.js';

/** Spec §9.1: pages read per PDF. A longer PDF is cut and flagged `truncated` on its first artefact. */
export const MAX_PDF_PAGES = 50;

/**
 * Everything handed to `getDocument` besides the bytes. Exported so the test
 * can lock it, and asserted again against what `getDocument` actually
 * received. See the module docblock for each choice.
 */
export const PDF_LOAD_OPTIONS = {
  // Inert in pdfjs-dist 6 — see the module docblock. Not a control.
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  enableXfa: false,
  useWasm: false,
  stopAtErrors: true,
  disableAutoFetch: true,
  disableStream: true,
  disableRange: true,
  // ERRORS only: pdf.js warnings about missing standard-font data are
  // expected (nothing is fetched) and would only fill the child's stderr.
  verbosity: 0,
} as const;

/** Items on one line sit within this fraction of the font size of each other's baseline. */
const SAME_LINE_TOLERANCE = 0.5;
/** A horizontal gap wider than this fraction of the font size is a word break. */
const WORD_GAP = 0.15;

interface PlacedText {
  str: string;
  rtl: boolean;
  x: number;
  y: number;
  width: number;
  size: number;
}

/**
 * A text item pdf.js returned, with its position, or `null` for anything
 * else (marked-content markers) and for whitespace-only items — the spaces
 * pdf.js synthesises between runs, which `joinLine` recomputes from the
 * geometry instead.
 */
function placedOf(item: unknown): PlacedText | null {
  if (typeof item !== 'object' || item === null) return null;
  const { str, dir, transform, width, height } = item as {
    str?: unknown;
    dir?: unknown;
    transform?: unknown;
    width?: unknown;
    height?: unknown;
  };
  if (typeof str !== 'string' || str.trim() === '') return null;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const [, , c, d, x, y] = transform as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const scale = typeof c === 'number' && typeof d === 'number' ? Math.hypot(c, d) : NaN;
  const fallback = typeof height === 'number' ? Math.abs(height) : NaN;
  const size = Number.isFinite(scale) && scale > 0 ? scale : Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
  return {
    str,
    rtl: dir === 'rtl',
    x,
    y,
    width: typeof width === 'number' && Number.isFinite(width) ? width : 0,
    size,
  };
}

/** Characters of a right-to-left script (Hebrew, Arabic, Syriac, Thaana, NKo). */
const RTL_LETTER = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
/** Terminators that belong to an adjacent number (₪1,890, 39%), as the bidi algorithm's ET class. */
const NUMBER_TERMINATOR = /^[\p{Sc}%‰°#+\-−]+$/u;
/** A neutral drawn in a right-to-left context is the mirrored glyph; its logical character is the other one. */
const MIRROR: Readonly<Record<string, string>> = {
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«',
};

/** R: right-to-left letters; L: other letters; EN: a number; N: neither (punctuation). */
type BidiClass = 'R' | 'L' | 'EN' | 'N';

function classOf(text: string): BidiClass {
  if (RTL_LETTER.test(text)) return 'R';
  if (LETTER.test(text)) return 'L';
  if (DIGIT.test(text)) return 'EN';
  return 'N';
}

function mirrored(text: string): string {
  return [...text].map((ch) => MIRROR[ch] ?? ch).join('');
}

/**
 * One line's items, in reading order, joined with a space wherever a visible
 * gap separates two.
 *
 * The base direction is right-to-left when the line has more right-to-left
 * LETTERS than other letters — digits and punctuation do not vote, so a
 * Hebrew table row of numbers is still a Hebrew row. Items are first taken in
 * visual order along the base direction. Some producers (headless Chromium
 * among them) write every glyph run as its own item, so a run in the OTHER
 * direction — a Latin word split at a ligature, a number with its currency
 * sign, a Hebrew phrase in an English line — arrives as several items whose
 * visual order is the reverse of their reading order. Consecutive items of
 * the other direction are therefore grouped into one run and the run is
 * reversed: items that touch always group; across a word gap only two
 * letters of that direction do (two numbers a gap apart are separate cells or
 * words). A terminator (₪, %) touching a number joins it; a neutral touching
 * two items of the other direction joins their run. Every other neutral
 * takes the base direction, and in a right-to-left context its bracket is the
 * mirrored glyph, so `(`/`)` are swapped back to the logical character.
 * Known limit: a producer that maps a mirrored glyph to its logical character
 * already would have its brackets swapped here.
 */
function joinLine(items: PlacedText[]): string {
  let rtlLetters = 0;
  let otherLetters = 0;
  for (const item of items) {
    for (const ch of item.str) {
      if (RTL_LETTER.test(ch)) rtlLetters += 1;
      else if (LETTER.test(ch)) otherLetters += 1;
    }
  }
  const rtl = rtlLetters > otherLetters;
  const ordered = [...items].sort((a, b) => (rtl ? b.x + b.width - (a.x + a.width) : a.x - b.x));

  // gapBefore[i]: a visible word gap between ordered[i - 1] and ordered[i].
  const gapBefore = ordered.map((item, i) => {
    const previous = ordered[i - 1];
    if (previous === undefined) return false;
    const gap = rtl ? previous.x - (item.x + item.width) : item.x - (previous.x + previous.width);
    return gap > WORD_GAP * Math.max(previous.size, item.size);
  });

  const classes = ordered.map((item) => classOf(item.str));
  // Terminators touching a number are part of it.
  classes.forEach((c, i) => {
    if (c !== 'N' || !NUMBER_TERMINATOR.test(ordered[i]?.str ?? '')) return;
    const touchesNumber =
      (classes[i - 1] === 'EN' && !gapBefore[i]) || (classes[i + 1] === 'EN' && gapBefore[i + 1] === false);
    if (touchesNumber) classes[i] = 'EN';
  });
  const isOther = (c: BidiClass | undefined) => (rtl ? c === 'L' || c === 'EN' : c === 'R');
  const otherLetter: BidiClass = rtl ? 'L' : 'R';
  // A neutral touching two items of the other direction joins their run.
  const foreign = classes.map(
    (c, i) =>
      isOther(c) ||
      (c === 'N' && isOther(classes[i - 1]) && isOther(classes[i + 1]) && !gapBefore[i] && gapBefore[i + 1] === false),
  );

  // Segments of consecutive ordered indices; other-direction runs are reversed.
  const segments: number[][] = [];
  for (let i = 0; i < ordered.length; i++) {
    const current = segments[segments.length - 1];
    const previous = i - 1;
    const joins =
      current !== undefined &&
      foreign[i] === true &&
      foreign[previous] === true &&
      (!gapBefore[i] || (classes[previous] === otherLetter && classes[i] === otherLetter));
    if (joins) current.push(i);
    else segments.push([i]);
  }

  let line = '';
  let first = true;
  for (const segment of segments) {
    const start = segment[0] as number;
    const reversed = foreign[start] === true && segment.length > 1;
    const sequence = reversed ? [...segment].reverse() : segment;
    sequence.forEach((index, k) => {
      const item = ordered[index] as PlacedText;
      // Space before this item: the boundary gap for a segment's first item,
      // otherwise the gap that separated it from its visual neighbour.
      const spaceBefore = first ? false : k === 0 ? gapBefore[start] : reversed ? gapBefore[index + 1] : gapBefore[index];
      if (spaceBefore === true && !/\s$/.test(line) && !/^\s/.test(item.str)) line += ' ';
      const neutralInRtl = classes[index] === 'N' && (rtl ? !foreign[index] : foreign[index] === true);
      line += neutralInRtl ? mirrored(item.str) : item.str;
      first = false;
    });
  }
  return line;
}

/**
 * A page's text items, as trimmed non-empty lines from the top of the page
 * down. One sort and one sweep, so a page of many tiny items costs
 * n log n — not one comparison per item per line.
 */
export function linesOf(items: readonly unknown[]): string[] {
  const placed = items.map(placedOf).filter((p): p is PlacedText => p !== null);
  placed.sort((a, b) => b.y - a.y);

  const lines: PlacedText[][] = [];
  let current: PlacedText[] = [];
  let anchor: PlacedText | null = null;
  for (const item of placed) {
    if (anchor !== null && Math.abs(anchor.y - item.y) > SAME_LINE_TOLERANCE * Math.min(anchor.size, item.size)) {
      lines.push(current);
      current = [];
      anchor = null;
    }
    if (anchor === null) anchor = item;
    current.push(item);
  }
  if (current.length > 0) lines.push(current);

  return lines.map((line) => joinLine(line).trim()).filter((line) => line !== '');
}

export async function extractPdf(sourcePath: string): Promise<DocumentArtifact[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  // pdf.js checks this global for an in-process worker before it ever
  // resolves `GlobalWorkerOptions.workerSrc` — see the module docblock.
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;

  // A copy: pdf.js transfers (detaches) the buffer it is given.
  const data = new Uint8Array(await readFile(sourcePath));
  const loadingTask = pdfjs.getDocument({ ...PDF_LOAD_OPTIONS, data });
  try {
    const doc = await loadingTask.promise;
    // Never an empty success: a document with no pages has nothing to mark
    // `scanned_no_text` on, and would reach the conductor as text-less.
    if (doc.numPages < 1) throw new Error('PDF has no pages');
    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);

    const artifacts: DocumentArtifact[] = [];
    let anyText = false;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const { items } = await page.getTextContent();
      page.cleanup();

      const { text, truncated } = capText(linesOf(items).join('\n'));
      if (text !== '') anyText = true;
      const blocks: Block[] =
        text === '' ? [] : text.split('\n').map((line) => ({ kind: 'paragraph', text: line }));

      artifacts.push({
        ordinal: pageNumber - 1,
        kind: 'text',
        partName: `עמוד ${pageNumber}`,
        content: { blocks } satisfies TextContent,
        flags: truncated ? ['truncated'] : [],
      });
    }

    const first = artifacts[0];
    if (first !== undefined) {
      const documentFlags: string[] = [];
      if (!anyText) documentFlags.push('scanned_no_text');
      if (doc.numPages > MAX_PDF_PAGES && !first.flags.includes('truncated')) {
        documentFlags.push('truncated');
      }
      first.flags = [...documentFlags, ...first.flags];
    }
    return artifacts;
  } finally {
    await loadingTask.destroy();
  }
}
