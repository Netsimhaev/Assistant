/**
 * The `pdf` extractor (spec §9.1 of
 * docs/superpowers/specs/2026-10-20-mailbox-connection-design.md): one
 * `text` artefact per page, each page's lines as paragraph blocks — the same
 * `TextContent` shape `docx.ts` and `passthrough.ts` produce, so a reader
 * cannot tell which extractor a page of text came from.
 *
 * A PDF arrives from senders nobody vouched for, and the format carries far
 * more than text: JavaScript actions, embedded fonts (programs a renderer
 * interprets), XFA forms, and references to fonts, colour profiles and
 * WebAssembly decoders it expects to be fetched from a URL. This module asks
 * `pdfjs-dist` for text and nothing else, and says so in `PDF_LOAD_OPTIONS`:
 *
 *   - **No script.** pdf.js never runs a document's JavaScript unless an
 *     embedder wires up its scripting sandbox; this module never does.
 *     `isEvalSupported: false` is passed as well, but in pdfjs-dist 6 the
 *     option no longer exists — the library dropped its `new Function` font
 *     compiler, and the 6.x build contains no string evaluation at all. The
 *     control that actually holds is a level below the library:
 *     `run-extractor.ts` starts every extraction child with
 *     `--disallow-code-generation-from-strings`, so `eval` and `new Function`
 *     throw inside the child no matter what any parser attempts.
 *   - **No fonts.** `disableFontFace: true` and `useSystemFonts: false`:
 *     embedded font programs are never turned into loaded faces, and no
 *     system font is looked up. Text extraction reads the text operators and
 *     the font's encoding, never the glyph programs.
 *   - **No network, no URL fetches.** The file arrives as `data`, never a
 *     `url`; `cMapUrl`, `standardFontDataUrl`, `wasmUrl`, `iccUrl` and
 *     `docBaseUrl` are left unset, so the factories that would fetch them
 *     have nothing to fetch; `useWasm: false` keeps the WebAssembly image
 *     decoders out entirely; `disableRange`/`disableStream`/`disableAutoFetch`
 *     close the incremental-loading paths, which only matter for a `url`.
 *     A CJK PDF whose text needs a CMap therefore extracts poorly or not at
 *     all — the price of never fetching one.
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
 *
 * `pdfjs-dist` is imported lazily, inside `extractPdf`, for two reasons. The
 * isolated child (`extract-child.ts`) loads every extractor module, and a
 * spreadsheet's extraction has no reason to load pdf.js (which, on import,
 * also loads the optional native `@napi-rs/canvas` package to polyfill
 * `DOMMatrix`). And the child reroutes `console` to stderr before it
 * dispatches — its stdout is the one JSON object the parent parses — so
 * pdf.js must be evaluated after that reroute, not hoisted ahead of it.
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

/** Spec §9.1: pages read per PDF. A longer PDF is cut here and flagged `truncated` on its first artefact. */
export const MAX_PDF_PAGES = 50;

/**
 * Everything handed to `getDocument` besides the bytes. Exported so the test
 * can lock it, and asserted again against what `getDocument` actually
 * received. See the module docblock for each choice.
 */
export const PDF_LOAD_OPTIONS = {
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

interface TextItemLike {
  str: string;
  hasEOL: boolean;
}

function isTextItem(item: unknown): item is TextItemLike {
  return typeof item === 'object' && item !== null && typeof (item as { str?: unknown }).str === 'string';
}

/** A page's text items, folded into trimmed non-empty lines. */
function linesOf(items: readonly unknown[]): string[] {
  const lines: string[] = [];
  let current = '';
  for (const item of items) {
    if (!isTextItem(item)) continue;
    current += item.str;
    if (item.hasEOL) {
      lines.push(current);
      current = '';
    }
  }
  lines.push(current);
  return lines.map((line) => line.trim()).filter((line) => line !== '');
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
      const blocks: Block[] = text === '' ? [] : text.split('\n').map((line) => ({ kind: 'paragraph', text: line }));

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
      if (doc.numPages > MAX_PDF_PAGES && !first.flags.includes('truncated')) documentFlags.push('truncated');
      first.flags = [...documentFlags, ...first.flags];
    }
    return artifacts;
  } finally {
    await loadingTask.destroy();
  }
}
