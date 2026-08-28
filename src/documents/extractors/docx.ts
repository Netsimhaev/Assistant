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
 * degrades to "no tracked-changes info recovered from raw XML" rather than
 * throwing — the archive guard has already run, upstream, before this
 * extractor is ever invoked, so a `.docx` that reaches here is a ZIP mammoth
 * itself could open, and a failure here would only ever mean this narrow
 * fallback met something outside its scope.
 *
 * **Merged/spanning table cells are not expanded.** Unlike `xlsx.ts`'s
 * merged-cell handling (spec §4.1 requires it explicitly), §4.2 says
 * nothing about `w:gridSpan`/`w:vMerge`, and the fixture has no merged
 * cell. Each `w:tc` becomes exactly one `Cell`, in document order — a
 * spanning cell is not repeated across the columns it visually covers, so a
 * row that spans unevenly can come out shorter than its neighbours. Adding
 * span-expansion untested would be exactly the "branch nobody exercises"
 * this task's brief warns against.
 *
 * **A nested table does not get its own `table` artefact.** A table inside
 * a table cell is flattened into that cell's text by `collectText` (its
 * rows and cells joined with separators) instead of crashing or being
 * dropped silently — sane behaviour for something outside this task's
 * scope, not full support for it.
 */

import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import mammoth from 'mammoth';
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

function tableContentOf(table: MammothNode): TableContent {
  const rows: Cell[][] = (table.children ?? [])
    .filter((row) => row.type === 'tableRow')
    .map((row) =>
      (row.children ?? [])
        .filter((cell) => cell.type === 'tableCell')
        .map((cell): Cell => ({ v: collectText(cell).trim(), t: 'string' })),
    );
  return { rows };
}

// --- Raw-ZIP fallback for tracked-change deletions (see module docblock) ---

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const CENTRAL_DIR_FIXED_SIZE = 46;
const LOCAL_FILE_HEADER_FIXED_SIZE = 30;

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
      return inflateRawSync(compressed);
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

interface TrackedChangeInfo {
  /** Whether raw XML shows an insertion or a deletion element at all. */
  hasInsOrDel: boolean;
  /** Every `w:delText` run's content, in document order, unescaped. */
  deletedTexts: string[];
}

const NO_TRACKED_CHANGES: TrackedChangeInfo = { hasInsOrDel: false, deletedTexts: [] };

async function readTrackedChangeInfo(sourcePath: string): Promise<TrackedChangeInfo> {
  const buffer = await readFile(sourcePath);
  const xml = readZipEntry(buffer, 'word/document.xml');
  if (!xml) return NO_TRACKED_CHANGES;
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

  return { hasInsOrDel, deletedTexts };
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
  const tables: TableContent[] = [];
  let listItems: string[] | null = null;

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

    const text = collectText(node).trim();
    const level = headingLevelOf(node);

    if (level !== null) {
      flushList();
      if (text !== '') blocks.push({ kind: 'heading', level, text });
      continue;
    }

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

    flushList();
    if (text !== '') blocks.push({ kind: 'paragraph', text });
  }
  flushList();

  const { hasInsOrDel, deletedTexts } = await readTrackedChangeInfo(sourcePath);
  const trackedChanges = hasInsOrDel || document.comments.length > 0;

  if (deletedTexts.length > 0) {
    blocks.push({
      kind: 'paragraph',
      text: `טקסט שנמחק במעקב שינויים: ${deletedTexts.join(' | ')}`,
    });
  }

  const textArtifact: DocumentArtifact = {
    ordinal: 0,
    kind: 'text',
    partName: null,
    content: { blocks } satisfies TextContent,
    flags: trackedChanges ? ['tracked_changes'] : [],
  };

  const tableArtifacts: DocumentArtifact[] = tables.map((content, index) => ({
    ordinal: index + 1,
    kind: 'table',
    partName: null,
    content,
    flags: [],
  }));

  return [textArtifact, ...tableArtifacts];
}
