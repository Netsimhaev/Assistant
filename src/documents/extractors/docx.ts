/**
 * The `docx` extractor (spec §4.2): one `text` artefact carrying the whole
 * document's structure, plus one `table` artefact per table — the same
 * `{ v, t }` cell shape `xlsx.ts` produces, so a reader cannot tell which
 * extractor a table came from.
 *
 * Runs inside the same isolated child every other extractor id runs in
 * (`extract-child.ts`) — this module never touches the database and never
 * opens a socket. `mammoth` does the ZIP+XML parsing for everything except
 * tracked-change deletions (below); nothing here ever fetches a linked
 * field, a remote reference, or anything else outside the file itself.
 *
 * **`transformDocument` is the read path, not `convertToHtml`'s HTML.**
 * `mammoth`'s public `Options` (`index.d.ts`) documents `transformDocument`
 * as a hook `convert()` (`lib/index.js`) runs on the parsed document tree
 * *before* rendering it to HTML — a supported extension point, not an
 * internal reach-around. Capturing the tree there and building `Block`s and
 * `TableContent` from it directly gives real structure (heading level,
 * list-item grouping, table rows/cells) without round-tripping through HTML
 * and reparsing that back into the same shape. The rendered HTML itself
 * (`result.value`) is discarded — this extractor never uses it.
 *
 * **Insertions are already in mammoth's tree; deletions never are.** Word
 * marks tracked-change content with `w:ins`/`w:del`. `mammoth`'s own
 * `body-reader.js` treats `w:ins`'s children as ordinary paragraph content
 * (`"w:ins": readChildElements`) — an insertion is indistinguishable from
 * unmarked text once it reaches the tree, which is exactly what this
 * extractor wants: the inserted text is already in the paragraph it flows
 * from, in place, with no code required to keep it. A `w:del` wrapping a
 * run is not read at all — it sits in `body-reader.js`'s `ignoreElements`
 * map, so deleted text never reaches the tree and mammoth has no path that
 * recovers it. §4.2's "what was deleted matters as much as what remains" is
 * therefore not something `mammoth` can be asked to do; `deletedTextIn`
 * below reads `word/document.xml`'s raw bytes directly for `w:delText`
 * runs, and `extractDocx` appends whatever it finds as one extra paragraph
 * block rather than leaving it out of the `text` artefact entirely.
 *
 * That extra block is a deliberate scope line, not full fidelity: it
 * reports deleted text once, gathered from the whole document, rather than
 * splicing each deletion back into the exact paragraph and position it was
 * cut from. Doing the latter correctly would mean re-deriving paragraph
 * boundaries from raw XML and keeping that walk in lock-step with
 * `mammoth`'s own paragraph count — mammoth already merges a wholly-deleted
 * paragraph's content into the paragraph that follows it (`body-reader.js`,
 * "17.13.5.15 del (Deleted Paragraph)"), which breaks a naive
 * Nth-raw-`<w:p>`-equals-Nth-tree-paragraph correspondence. A block that is
 * honestly document-level beats one that is silently wrong about which
 * paragraph a deletion belonged to.
 *
 * **No new dependency for the raw-XML pass.** `word/document.xml` is read
 * with a hand-written ZIP central-directory walk plus `node:zlib`'s
 * `inflateRawSync` — the same trade-off `xlsx.ts` already made for its
 * macro-part check (a byte-level answer to one narrow question beats a
 * general-purpose parser pulled in for it), and the same central-directory
 * shape `archive-guard.ts` already walks for a different purpose. Only
 * `deflate` (method 8, what every part Word/`mammoth` write) and `store`
 * (method 0) are handled; anything else, or a part that isn't found at all,
 * degrades to "raw XML unreadable" rather than throwing — the archive guard
 * has already run, upstream, before this extractor is ever invoked, so a
 * `.docx` that reaches here is a ZIP mammoth itself could open, and a
 * failure here would only ever mean this narrow fallback met something
 * outside its scope. "Unreadable" is not "clean", though: see
 * `TrackedChangeScan` below for what `extractDocx` does with that outcome.
 * One of those failure sources is deliberate, not incidental:
 * `MAX_INFLATED_ENTRY_BYTES` bounds `inflateRawSync`'s own output, because
 * the archive guard's declared-size caps can be lied to by an entry that
 * *understates* its true inflated size (see `archive-guard.ts`'s docblock)
 * — this is the one inflate call in the pipeline that is not otherwise
 * bounded by anything but the child process's own heap and timeout.
 *
 * **Merged/spanning table cells are expanded, matching `xlsx.ts`.** §4.2
 * says nothing about `w:gridSpan`/`w:vMerge` the way §4.1 explicitly
 * requires merge-expansion for Excel, but the brief's own bar — a table
 * from Word and a table from a spreadsheet must be interchangeable — rules
 * out leaving them raw. Two different things go wrong if a merge is left
 * unexpanded, and only one of them is cosmetic: a `w:gridSpan` (horizontal
 * merge) just makes a `Cell` for one column instead of several, so the row
 * comes out short — visibly wrong, easy to notice. A `w:vMerge` (vertical
 * merge) is worse: mammoth's own `body-reader.js` *removes* a merge's
 * continuation cell from `row.children` entirely once it has folded that
 * cell's presence into the anchor cell's `rowSpan` one column over
 * (`calculateRowSpans`) — so every cell after it in that row silently
 * shifts one index to the left. Read positionally, that is not a short row,
 * it is the wrong column's value sitting at another column's index.
 *
 * `expandTableRows` below reconstructs the true grid from `colSpan`/
 * `rowSpan`: a `Map` of columns still "occupied" by a still-open vertical
 * span is consulted at every column position before consuming the row's
 * next real cell, so a continuation row's surviving cells land at their
 * real column index rather than sliding into a gap the tree no longer
 * marks. A spanned cell's value is written to every coordinate it covers,
 * the same rule `xlsx.ts`'s `anchorOf`/merge-spreading already applies to
 * Excel. If the tree ever failed to carry enough to reconstruct a position
 * (colSpan/rowSpan resolving to something other than a positive integer),
 * an explicit `{ v: null, t: 'empty' }` placeholder fills that coordinate
 * instead of ever letting a real cell's value drift into it — the ruling
 * this responds to was explicit that a shifted row is worse than a short
 * one, and must never happen silently.
 *
 * **A nested table does not get its own `table` artefact.** A table inside
 * a table cell is flattened into that cell's text by `collectText` (its
 * rows and cells joined with separators) instead of crashing or being
 * dropped silently — sane behaviour for something outside this task's
 * scope, not full support for it.
 *
 * **Cells classify through the same `../cell.ts` function `csv.ts` uses,
 * not an unconditional `{ v: text, t: 'string' }`.** Before this existed,
 * every Word table cell — including an empty one — came out as a string,
 * which meant no Word table could ever produce headers, a numeric range, or
 * a date range in `outline.ts` (both of those need a non-string cell
 * somewhere to detect). `collectText(cellNode).trim()`'s result is still
 * trimmed before classification (see `../cell.ts`'s docblock for why that
 * differs from `csv.ts`, which trims nothing), then run through
 * `classifyField` the same way a CSV field is.
 *
 * **§5.3's content caps apply here too.** A table's rows are capped at
 * `MAX_ROWS_PER_TABLE` and each cell's text at `MAX_CELL_CHARS` — the same
 * two numbers `xlsx.ts` already enforces — and a document's `text`
 * artefact's block text (a paragraph, heading, or list item) is capped at
 * `MAX_CELL_CHARS` too, since a `jsonb` row has the same reason to bound one
 * piece of prose as one spreadsheet cell. Either kind of truncation pushes
 * `truncated` onto the artefact it happened in — the table it shortened, or
 * the text artefact (ordinal 0) for capped block text.
 */

import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import mammoth from 'mammoth';
import { MAX_ROWS_PER_TABLE, capCellChars, capText, classifyField } from '../cell.js';
import type { Block, Cell, DocumentArtifact, TableContent, TextContent } from '../types.js';

// The subset of mammoth's internal document-tree shape
// (`node_modules/mammoth/lib/documents.js`) this module reads. mammoth's own
// `.d.ts` types `transformDocument`'s parameter as `any` — this tree is real
// but not part of mammoth's typed public surface, so every field access
// below goes through the narrow, defensive helpers underneath rather than
// trusting these interfaces to describe every node mammoth can ever produce.
interface MammothNode {
  type: string;
  value?: string;
  children?: MammothNode[];
}

interface MammothDocument {
  type: 'document';
  children: MammothNode[];
  comments: unknown[];
}

/** `true` only for a non-empty string — a node with no styleId at all (`null`) must not be confused with one whose id failed to resolve. */
function styleIdOf(node: MammothNode): string | null {
  const value = (node as { styleId?: unknown }).styleId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * `colSpan`/`rowSpan` on a `tableCell` node, defensively — a positive
 * integer if the tree carries one, `1` (the "no span" default) for
 * anything else. mammoth's own `documents.js` `TableCell` always
 * initialises both to `1` when absent, so `1` is not a guess, it is this
 * module's own copy of that same default for the one field
 * (`documents.js`'s constructor default) it cannot import a type for.
 */
function spanOf(node: MammothNode, key: 'colSpan' | 'rowSpan'): number {
  const value = (node as { colSpan?: unknown; rowSpan?: unknown })[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

/**
 * A paragraph is a list item exactly when `readNumberingProperties`
 * (`body-reader.js`) resolved a numbering level for it — `null` otherwise,
 * never `undefined` (see `documents.js`'s `Paragraph`). Reading `styleId`
 * ("ListParagraph") instead would be wrong: that style is also used for
 * plain indented paragraphs with no list numbering at all.
 */
function isListItem(node: MammothNode): boolean {
  return (node as { numbering?: unknown }).numbering != null;
}

/**
 * Word's own heading style ids ("Heading1".."Heading9") are locale-
 * independent — only the *name* shown in the UI is translated, per
 * `style-reader.js`'s split between `w:styleId` and `w:name`. Matching the
 * id directly (rather than the resolved, localisable name `styleName`)
 * is what keeps this working against the Hebrew fixture without a
 * name-matching table.
 */
function headingLevelOf(node: MammothNode): number | null {
  const styleId = styleIdOf(node);
  if (styleId === null) return null;
  const match = /^Heading([1-9])$/.exec(styleId);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Flattens a subtree to plain text. Handles every node type this module's
 * own docblock claims to: `text` (a leaf), `tab`, `break`, and the three
 * table levels (row/cell get separators a plain concatenation would lose).
 * Everything else — run, hyperlink, paragraph read as a sub-node, and any
 * node type outside mammoth's documented set (checkbox, image,
 * commentReference, bookmarkStart, …) — falls through to "join whatever
 * children it has, or contribute nothing": never a crash, because this
 * walks a tree this module does not fully control the shape of.
 */
function collectText(node: MammothNode): string {
  switch (node.type) {
    case 'text':
      return node.value ?? '';
    case 'tab':
      return '\t';
    case 'break':
      return '\n';
    case 'tableRow':
      return (node.children ?? []).map(collectText).join(' | ');
    case 'table':
      return (node.children ?? []).map(collectText).join('\n');
    case 'tableCell':
      return (node.children ?? []).map(collectText).join(' ');
    default:
      return (node.children ?? []).map(collectText).join('');
  }
}

interface PendingSpan {
  value: Cell;
  remainingRows: number;
}

/**
 * Reconstructs a table's true grid from mammoth's row/cell tree, expanding
 * `colSpan` and `rowSpan` the way a browser lays out `rowspan`/`colspan` in
 * HTML — a running `pending` map of columns still covered by a vertical
 * span from an earlier row, consulted at every column position before ever
 * consuming the row's own next cell. See the module docblock for why this
 * exists: a `w:vMerge` continuation cell is missing from `row.children`
 * entirely by the time the tree reaches this module, and mapping a row's
 * surviving cells straight to sequential indices would silently shift every
 * cell after the gap into the wrong column.
 */
interface ExpandedTable {
  rows: Cell[][];
  truncated: boolean;
}

function expandTableRows(table: MammothNode): ExpandedTable {
  const allRows = (table.children ?? []).filter((row) => row.type === 'tableRow');
  // §5.3/§3.4: capped up front, matching xlsx.ts's row cap — a table beyond
  // MAX_ROWS_PER_TABLE is cut and flagged truncated, never rejected outright
  // or left to grow an unbounded jsonb row.
  const rowsTruncated = allRows.length > MAX_ROWS_PER_TABLE;
  const rows = rowsTruncated ? allRows.slice(0, MAX_ROWS_PER_TABLE) : allRows;

  const pending = new Map<number, PendingSpan>();
  const grid: Cell[][] = [];
  let cellsTruncated = false;

  for (const row of rows) {
    const cells = (row.children ?? []).filter((cell) => cell.type === 'tableCell');
    const outputRow: Cell[] = [];
    let column = 0;
    let cellIndex = 0;

    while (cellIndex < cells.length || pending.has(column)) {
      const occupied = pending.get(column);
      if (occupied) {
        outputRow[column] = occupied.value;
        const remainingRows = occupied.remainingRows - 1;
        if (remainingRows > 0) {
          pending.set(column, { value: occupied.value, remainingRows });
        } else {
          pending.delete(column);
        }
        column += 1;
        continue;
      }

      const cellNode = cells[cellIndex];
      if (cellNode === undefined) break; // unreachable given the loop condition; satisfies noUncheckedIndexedAccess
      cellIndex += 1;

      // Trimmed before classification (docx keeps `.trim()`; see the module
      // docblock for why that differs from csv.ts), then capped at
      // MAX_CELL_CHARS the same way xlsx.ts caps a cell's string value.
      const { cell: value, truncated: cellTruncated } = capCellChars(
        classifyField(collectText(cellNode).trim()),
      );
      if (cellTruncated) cellsTruncated = true;
      const colSpan = spanOf(cellNode, 'colSpan');
      const rowSpan = spanOf(cellNode, 'rowSpan');

      for (let offset = 0; offset < colSpan; offset++) {
        outputRow[column + offset] = value;
        if (rowSpan > 1) {
          pending.set(column + offset, { value, remainingRows: rowSpan - 1 });
        }
      }
      column += colSpan;
    }

    // Never let a hole in `outputRow` surface as a shifted row: the loop
    // above should never leave one (every column from 0 up is accounted for
    // by either a pending span or a real cell), but the ruling this
    // responds to was explicit that a position the tree didn't carry enough
    // to reconstruct must get a placeholder, not a neighbour's value.
    for (let i = 0; i < outputRow.length; i++) {
      if (outputRow[i] === undefined) outputRow[i] = { v: null, t: 'empty' };
    }

    grid.push(outputRow);
  }

  return { rows: grid, truncated: rowsTruncated || cellsTruncated };
}

function tableContentOf(table: MammothNode): { content: TableContent; truncated: boolean } {
  const { rows, truncated } = expandTableRows(table);
  return { content: { rows }, truncated };
}

// --- Raw-ZIP fallback for tracked-change deletions (see module docblock) ---

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const CENTRAL_DIR_FIXED_SIZE = 46;
const LOCAL_FILE_HEADER_FIXED_SIZE = 30;

/**
 * Caps `inflateRawSync`'s output for this raw-XML fallback read alone
 * (`archive-guard.ts`'s guard already ran upstream, but — see that module's
 * docblock — it cannot stop an entry whose declared `uncompressedSize`
 * understates what its compressed stream truly inflates to; nothing in this
 * codebase bounds that except a cap placed directly on the inflate call
 * itself). 64MB is far beyond any real `word/document.xml` — even a
 * multi-thousand-page contract's XML runs to a few MB — while staying well
 * under the 256MB heap cap the isolated child already runs under (spec
 * §3.4), so a hostile entry cannot force an allocation the process could
 * not have survived anyway. Node's zlib throws `ERR_BUFFER_TOO_LARGE` (a
 * `RangeError`) the instant the decompressed size would exceed this —
 * `readEntryData`'s existing `catch { return null }` already
 * turns that into "raw XML unreadable", which `extractDocx` already treats
 * as `scanned: false` and flags `tracked_changes` rather than clearing it —
 * fail-closed for free, no new branch required.
 */
const MAX_INFLATED_ENTRY_BYTES = 64 * 1024 * 1024;

/** One named ZIP entry's decompressed bytes, or `null` — see module docblock for what "degrades" here rather than throwing. */
function readZipEntry(buffer: Buffer, entryName: string): Buffer | null {
  const size = buffer.length;
  const tailSize = Math.min(size, EOCD_FIXED_SIZE + MAX_COMMENT_SIZE);
  const tail = buffer.subarray(size - tailSize);

  let eocdOffset = -1;
  for (let i = tail.length - EOCD_FIXED_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return null;

  const totalEntries = tail.readUInt16LE(eocdOffset + 10);
  const centralDirSize = tail.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = tail.readUInt32LE(eocdOffset + 16);
  if (centralDirOffset + centralDirSize > size) return null;

  const cd = buffer.subarray(centralDirOffset, centralDirOffset + centralDirSize);

  let pos = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + CENTRAL_DIR_FIXED_SIZE > cd.length) return null;
    if (cd.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE) return null;

    const method = cd.readUInt16LE(pos + 10);
    const compressedSize = cd.readUInt32LE(pos + 20);
    const nameLength = cd.readUInt16LE(pos + 28);
    const extraLength = cd.readUInt16LE(pos + 30);
    const commentLength = cd.readUInt16LE(pos + 32);
    const localHeaderOffset = cd.readUInt32LE(pos + 42);
    const name = cd.toString(
      'utf8',
      pos + CENTRAL_DIR_FIXED_SIZE,
      pos + CENTRAL_DIR_FIXED_SIZE + nameLength,
    );

    if (name === entryName) {
      return readEntryData(buffer, localHeaderOffset, method, compressedSize);
    }

    pos += CENTRAL_DIR_FIXED_SIZE + nameLength + extraLength + commentLength;
  }

  return null;
}

function readEntryData(
  buffer: Buffer,
  localHeaderOffset: number,
  method: number,
  compressedSize: number,
): Buffer | null {
  if (localHeaderOffset + LOCAL_FILE_HEADER_FIXED_SIZE > buffer.length) return null;
  const nameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + LOCAL_FILE_HEADER_FIXED_SIZE + nameLength + extraLength;
  if (dataStart + compressedSize > buffer.length) return null;
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) return Buffer.from(compressed);
  if (method === 8) {
    try {
      return inflateRawSync(compressed, { maxOutputLength: MAX_INFLATED_ENTRY_BYTES });
    } catch {
      return null;
    }
  }
  return null;
}

function unescapeXmlText(value: string): string {
  // `&amp;` last, or `&amp;lt;` would unescape twice into `<`.
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * `scanned: false` means the raw-XML pass could not complete — the entry
 * wasn't found under its expected name, the ZIP couldn't be parsed at all,
 * or its declared sizes didn't fit the file. This is a distinct outcome
 * from `scanned: true, hasInsOrDel: false`, which means the pass *did*
 * complete and genuinely found nothing. Collapsing the two into one
 * "no tracked changes" value is exactly the bug this type exists to
 * prevent: a value this module could not read must never be written down
 * as the permissive one (`CLAUDE.md`'s rule for the sibling
 * governance codebase, and no less true here — see `extractDocx` below,
 * which treats `scanned: false` as "flag it", not "clear it").
 */
type TrackedChangeScan =
  | { scanned: true; hasInsOrDel: boolean; deletedTexts: string[] }
  | { scanned: false };

const SCAN_INCOMPLETE: TrackedChangeScan = { scanned: false };

/**
 * Exported for `docx.test.ts` alone: end-to-end coverage of "the raw scan
 * could not complete" needs mammoth to still succeed while this function's
 * *own* read of the same `word/document.xml` fails — achievable (a
 * relationship pointing the main document part at a non-default path,
 * verified against `mammoth` directly) for "the entry isn't where this
 * function assumes it is", but every corruption tried against a truly
 * malformed central directory or compressed stream broke `mammoth`'s own
 * (`JSZip`-based) read identically, since both readers are bound by the
 * same declared sizes/signatures for the one entry both need. Testing this
 * function directly against bytes that are not a ZIP at all is what
 * actually exercises its "malformed package" branches without that
 * confound.
 */
export async function readTrackedChangeInfo(sourcePath: string): Promise<TrackedChangeScan> {
  const buffer = await readFile(sourcePath);
  const xml = readZipEntry(buffer, 'word/document.xml');
  if (!xml) return SCAN_INCOMPLETE;
  const text = xml.toString('utf8');

  // `<w:del` also matches `<w:delText`'s prefix, which is correct here: a
  // `w:delText` run is always nested inside a `w:del` element (ECMA-376
  // 17.13.5.14), so this single prefix check covers both without a second
  // pattern.
  const hasInsOrDel = /<w:ins[ >]/.test(text) || /<w:del[ >]/.test(text);

  const deletedTexts: string[] = [];
  const delTextPattern = /<w:delText[^>]*>([\s\S]*?)<\/w:delText>/g;
  for (const match of text.matchAll(delTextPattern)) {
    deletedTexts.push(unescapeXmlText(match[1] ?? ''));
  }

  return { scanned: true, hasInsOrDel, deletedTexts };
}

// --- Block assembly ---

export async function extractDocx(sourcePath: string): Promise<DocumentArtifact[]> {
  let captured: MammothDocument | null = null;
  await mammoth.convertToHtml(
    { path: sourcePath },
    {
      transformDocument: (doc: MammothDocument) => {
        captured = doc;
        return doc;
      },
    },
  );
  // `convert()` (`lib/index.js`) always applies `transformDocument` to the
  // parsed document before ever attempting HTML rendering, so `captured`
  // is set on every successful call above — this is not a branch a real
  // `.docx` can leave untaken.
  const document: MammothDocument = captured ?? { type: 'document', children: [], comments: [] };

  const blocks: Block[] = [];
  const tables: { content: TableContent; truncated: boolean }[] = [];
  let listItems: string[] | null = null;
  // §5.3/§3.4: a block's text (paragraph, heading, or list item) is capped
  // at MAX_CELL_CHARS the same way a table cell's string value is — one
  // flag on the document-level text artefact, not per-block, since
  // TextContent's `Block` type carries no flag field of its own.
  let textTruncated = false;

  const flushList = (): void => {
    if (listItems !== null && listItems.length > 0) {
      blocks.push({ kind: 'list', items: listItems });
    }
    listItems = null;
  };

  for (const node of document.children) {
    if (node.type === 'table') {
      flushList();
      tables.push(tableContentOf(node));
      continue;
    }

    if (node.type !== 'paragraph') continue;

    const { text, truncated: paragraphTruncated } = capText(collectText(node).trim());
    if (paragraphTruncated) textTruncated = true;

    if (isListItem(node)) {
      // An empty list item contributes nothing but also does not interrupt
      // the run — Word can carry a bookmark-only or otherwise blank
      // numbered paragraph without it being a deliberate break in the list.
      if (text !== '') {
        listItems = listItems ?? [];
        listItems.push(text);
      }
      continue;
    }

    // An empty non-list paragraph — the blank line Word leaves behind when
    // someone presses Enter between two bullets while editing — carries no
    // content of its own and must not interrupt a list run either. Checked
    // *before* `flushList()` runs: the earlier version called `flushList()`
    // unconditionally here and only gated the *push* on `text !== ''`,
    // which flushed (and so split) a list across exactly this kind of blank
    // paragraph. A real, non-empty paragraph or heading is a genuine break
    // in the list and does still flush, below. A blank paragraph carrying a
    // heading style (an empty "Heading1" paragraph, say) hits this same
    // check first and is skipped identically — it never reaches
    // `headingLevelOf` below, so it does not produce an empty `heading`
    // block either.
    if (text === '') continue;

    flushList();
    const level = headingLevelOf(node);
    if (level !== null) {
      blocks.push({ kind: 'heading', level, text });
    } else {
      blocks.push({ kind: 'paragraph', text });
    }
  }
  flushList();

  const scan = await readTrackedChangeInfo(sourcePath);
  // A scan that could not complete is treated as "flag it", never "clear
  // it" — see `TrackedChangeScan`'s docblock. `deletedTexts` has nothing to
  // contribute when the scan didn't complete either; there is no raw text
  // to have recovered anything from.
  const deletedTexts = scan.scanned ? scan.deletedTexts : [];
  const trackedChanges = !scan.scanned || scan.hasInsOrDel || document.comments.length > 0;

  if (deletedTexts.length > 0) {
    const { text: deletedBlockText, truncated: deletedTruncated } = capText(
      `טקסט שנמחק במעקב שינויים: ${deletedTexts.join(' | ')}`,
    );
    if (deletedTruncated) textTruncated = true;
    blocks.push({ kind: 'paragraph', text: deletedBlockText });
  }

  const textFlags: string[] = [];
  if (trackedChanges) textFlags.push('tracked_changes');
  if (textTruncated) textFlags.push('truncated');

  const textArtifact: DocumentArtifact = {
    ordinal: 0,
    kind: 'text',
    partName: null,
    content: { blocks } satisfies TextContent,
    flags: textFlags,
  };

  const tableArtifacts: DocumentArtifact[] = tables.map(({ content, truncated }, index) => ({
    ordinal: index + 1,
    kind: 'table',
    partName: null,
    content,
    flags: truncated ? ['truncated'] : [],
  }));

  return [textArtifact, ...tableArtifacts];
}
