/**
 * `renderReadingBrief` — the artefacts of one document, rendered into the text
 * the reader is asked about (spec §5).
 *
 * Pure and synchronous: no filesystem, no network, no database, nothing async.
 * The same property that holds `buildOutline` (`./outline.ts`), and for the
 * same reason — it is fully testable on a machine with no API key, which is
 * where the bulk of this sub-project's coverage has to live.
 *
 * The ceilings here are far below intake's own (50,000 rows per sheet, §5.3 of
 * the intake spec). Those protect the machine; these protect cost and the
 * model's attention. Truncation is graded — table rows first, then text, then
 * the brief as a whole — so the outline, the cheapest and most certain part of
 * the document, is never the first thing to go.
 */

import type {
  Block,
  Cell,
  DocumentArtifact,
  OutlineContent,
  TableContent,
  TextContent,
} from './types.js';

/** Data rows shown per table, over and above the header row. */
export const BRIEF_TABLE_ROWS = 40;
/** Characters shown per text artefact. */
export const BRIEF_TEXT_CHARS = 8_000;
/** Characters in the whole brief. */
export const BRIEF_TOTAL_CHARS = 24_000;

const TRUNCATED = (what: string, kept: number): string =>
  `\n(קוצץ — מוצגים ${kept} ${what} בלבד; במסמך יש יותר)`;

function cellText(cell: Cell): string {
  if (cell.v === null) return '';
  return String(cell.v);
}

function renderTable(content: TableContent): string {
  const rows = content.rows;
  const header = rows[0];
  if (header === undefined) return '(טבלה ריקה)';

  const body = rows.slice(1);
  const shown = body.slice(0, BRIEF_TABLE_ROWS);
  const lines = [header.map(cellText).join(' | '), '---'];
  for (const row of shown) lines.push(row.map(cellText).join(' | '));

  const text = lines.join('\n');
  return body.length > shown.length ? text + TRUNCATED('שורות', shown.length) : text;
}

function renderBlock(block: Block): string {
  if (block.kind === 'heading') return `${'#'.repeat(Math.max(1, block.level))} ${block.text}`;
  if (block.kind === 'list') return block.items.map((item) => `- ${item}`).join('\n');
  return block.text;
}

function renderText(content: TextContent): string {
  const text = content.blocks.map(renderBlock).join('\n\n');
  if (text.length <= BRIEF_TEXT_CHARS) return text;
  return text.slice(0, BRIEF_TEXT_CHARS) + TRUNCATED('תווים', BRIEF_TEXT_CHARS);
}

function renderOutline(content: OutlineContent): string {
  const lines: string[] = [];
  for (const part of content.parts) {
    const bits = [`- ${part.name ?? '(ללא שם)'} — ${part.kind}`];
    if (part.rowCount !== undefined) bits.push(`${part.rowCount} שורות`);
    if (part.headers !== undefined && part.headers.length > 0) {
      bits.push(`עמודות: ${part.headers.join(', ')}`);
    }
    if (part.dateRange !== undefined) bits.push(`תאריכים: ${part.dateRange.from}–${part.dateRange.to}`);
    lines.push(bits.join(' · '));
  }
  if (content.flags.length > 0) lines.push(`דגלים: ${content.flags.join(', ')}`);
  return lines.length > 0 ? lines.join('\n') : '(אין מתאר)';
}

/**
 * `content` is `unknown` at the storage boundary (`./types.ts`), so each shape
 * is narrowed here rather than trusted. A shape that does not match its
 * declared `kind` renders as a stated gap — silence would read as "this part
 * was empty", which is a different and untrue claim.
 */
function renderContent(artifact: DocumentArtifact): string {
  const content = artifact.content;
  if (artifact.kind === 'outline') {
    const parts = (content as OutlineContent | null)?.parts;
    return Array.isArray(parts) ? renderOutline(content as OutlineContent) : '(מתאר לא קריא)';
  }
  if (artifact.kind === 'table') {
    const rows = (content as TableContent | null)?.rows;
    return Array.isArray(rows) ? renderTable(content as TableContent) : '(טבלה לא קריאה)';
  }
  const blocks = (content as TextContent | null)?.blocks;
  return Array.isArray(blocks) ? renderText(content as TextContent) : '(טקסט לא קריא)';
}

function renderTableFull(content: TableContent): string {
  const rows = content.rows;
  const header = rows[0];
  if (header === undefined) return '(טבלה ריקה)';
  const lines = [header.map(cellText).join(' | '), '---'];
  for (const row of rows.slice(1)) lines.push(row.map(cellText).join(' | '));
  return lines.join('\n');
}

function renderTextFull(content: TextContent): string {
  return content.blocks.map(renderBlock).join('\n\n');
}

/**
 * One artefact's content as plain text, laid out exactly the way
 * `renderContent`/`renderReadingBrief` does — cells pipe-separated, blocks
 * joined by a blank line, an outline as a bulleted list — but with NEITHER of
 * `renderReadingBrief`'s two caps (`BRIEF_TABLE_ROWS` rows per table,
 * `BRIEF_TEXT_CHARS` characters per text block) applied. `renderOutline` is
 * already uncapped, so it is reused as-is.
 *
 * Exists for `gov-verify.ts`'s `sources` (`governance/numeric-grounding.ts`'s
 * `ungroundedNumbers`, via `conduct.ts`'s `beginVerification`): that check
 * needs the DETERMINISTIC EXTRACTION IN FULL, in the same layout the brief
 * uses, never `JSON.stringify(artifact.content)` — `numbersIn` skips any
 * digit run immediately preceded by `:` (a date/time/range guard), and
 * `JSON.stringify` emits no space after a key's colon, so a numeric cell like
 * `{"v":11988,"t":"number"}` has its own value skipped by that exact guard.
 * Measured: on a one-cell `.xlsx`-shaped table, the JSON form grounds
 * nothing (`[]`) while this pipe-separated form grounds the number
 * correctly. Handing the judge JSON zeroed the entire grounded set for every
 * spreadsheet or table artefact — every number in the draft then read as
 * ungrounded, exactly the false-positive shape this module's own docblock
 * says teaches an owner to click past the control.
 *
 * **What this does NOT capture.** The extractors themselves cap BEFORE
 * storage — sheet count, rows per sheet/table, characters per cell — and
 * record that a cap applied on `artifact.flags` (`truncated`, and friends).
 * This function reads only `content`, never `flags`, so a number that fell
 * outside an EXTRACTION-time cap is invisible here the same way it is
 * invisible to `renderReadingBrief` and to every other reader of
 * `document_artifacts` that does not check `flags` itself — a known limit of
 * the extraction pipeline, not something this function introduces or fixes.
 */
export function renderArtifactFull(artifact: DocumentArtifact): string {
  const content = artifact.content;
  if (artifact.kind === 'outline') {
    const parts = (content as OutlineContent | null)?.parts;
    return Array.isArray(parts) ? renderOutline(content as OutlineContent) : '(מתאר לא קריא)';
  }
  if (artifact.kind === 'table') {
    const rows = (content as TableContent | null)?.rows;
    return Array.isArray(rows) ? renderTableFull(content as TableContent) : '(טבלה לא קריאה)';
  }
  const blocks = (content as TextContent | null)?.blocks;
  return Array.isArray(blocks) ? renderTextFull(content as TextContent) : '(טקסט לא קריא)';
}

/** Between two part sections. Counted against the total ceiling like any text. */
const SECTION_GAP = '\n\n';

/**
 * A brief, and the claim about it that citation integrity needs.
 *
 * Two values and not one, because the second is not derivable from the first
 * by anyone downstream: `readingProblems` was building its known-ordinal set
 * from the artefact array, and the total-brief ceiling can drop later parts
 * from the text entirely. A reading citing a part that was cut away therefore
 * passed the check — a claim attributed to text the model never saw, which is
 * exactly what the control exists to catch. Only the function that did the
 * cutting knows what survived it, so it says so.
 */
export interface ReadingBrief {
  /** The text the reader is asked about. */
  brief: string;
  /**
   * The ordinals whose section is in `brief` — and therefore the only ordinals
   * a `sourceRef` may legitimately cite.
   */
  includedOrdinals: number[];
}

/**
 * The brief, with the outline first and every part labelled by the ordinal a
 * `SourceRef` must cite.
 *
 * Artefacts are ordered outline-first and then by ordinal, not by the order
 * the caller happened to pass them: `loadArtifacts` already returns them by
 * ordinal, and a brief whose ordering depends on the caller is a brief whose
 * hash — and therefore whose cache key — depends on it too.
 *
 * The total ceiling now drops whole sections rather than slicing the joined
 * text mid-part. A half-rendered section is a part the model was shown some of
 * and cannot be told it was shown some of, and it made `includedOrdinals`
 * unanswerable: in or out, with no honest third answer. Sections are taken in
 * order until the next one would not fit, and the rest are dropped with the
 * cut stated in the brief itself.
 *
 * The one exception is the first section: if it alone overruns the ceiling it
 * is kept, cut to the ceiling and marked. A brief with no parts in it at all
 * is not a cheaper brief, it is a question about nothing.
 */
export function renderReadingBrief(artifacts: readonly DocumentArtifact[]): ReadingBrief {
  if (artifacts.length === 0) {
    return { brief: 'המסמך נקלט ולא הופק ממנו שום חלק.', includedOrdinals: [] };
  }

  const ordered = [...artifacts].sort((a, b) => {
    if (a.kind === 'outline' && b.kind !== 'outline') return -1;
    if (b.kind === 'outline' && a.kind !== 'outline') return 1;
    return a.ordinal - b.ordinal;
  });

  const sections: { ordinal: number; text: string }[] = [];
  for (const artifact of ordered) {
    const head = `[חלק ${artifact.ordinal}] ${artifact.partName ?? '(ללא שם)'} — ${artifact.kind}`;
    const flags = artifact.flags.length > 0 ? `\nדגלים: ${artifact.flags.join(', ')}` : '';
    sections.push({ ordinal: artifact.ordinal, text: `${head}${flags}\n${renderContent(artifact)}` });
  }

  const kept: string[] = [];
  const includedOrdinals: number[] = [];
  let used = 0;
  let dropped = false;

  for (const section of sections) {
    const cost = kept.length === 0 ? section.text.length : section.text.length + SECTION_GAP.length;
    if (kept.length > 0 && used + cost > BRIEF_TOTAL_CHARS) {
      dropped = true;
      break;
    }
    kept.push(section.text);
    includedOrdinals.push(section.ordinal);
    used += cost;
  }

  const joined = kept.join(SECTION_GAP);
  if (joined.length > BRIEF_TOTAL_CHARS) {
    // Only reachable for a lone first section over the ceiling.
    return {
      brief: joined.slice(0, BRIEF_TOTAL_CHARS) + TRUNCATED('תווים', BRIEF_TOTAL_CHARS),
      includedOrdinals,
    };
  }
  return {
    brief: dropped ? joined + TRUNCATED('חלקים', includedOrdinals.length) : joined,
    includedOrdinals,
  };
}
