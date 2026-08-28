/**
 * The shared `{ v, t }` cell contract every extractor that does not already
 * get typing for free from its own format must classify text through
 * (docs/superpowers/specs/2026-08-28-document-intake-design.md §4, §5.3).
 *
 * `xlsx.ts` is the one extractor that does **not** use `classifyField`
 * below: `exceljs` already tells it the real cell type (`ValueType.Number`,
 * `.Date`, …), and running that back through a string-only classifier would
 * throw away information the format already carries. `csv.ts` and `docx.ts`
 * have no such source — a CSV field and a Word table cell are both, at the
 * moment they reach this module, plain text — so both classify through the
 * same function here. Before this module existed, `docx.ts` built every
 * table cell as `{ v: text.trim(), t: 'string' }` unconditionally, which
 * meant no Word table could ever produce headers, a numeric range, or a
 * date range in `outline.ts` (`detectHeaders` needs a non-string second
 * row; `columnStats` marks any non-empty non-number non-date `mixed`) —
 * lifting `csv.ts`'s classifier here and having `docx.ts` build cells
 * through it is what makes the three extractors' tables genuinely
 * interchangeable, the bar every one of their module docblocks already
 * claims to meet.
 *
 * **`docx.ts` keeps `.trim()`; `csv.ts` deliberately does not — this is a
 * considered difference, not leftover inconsistency.** `csv.ts`'s own
 * docblock explains why it preserves whitespace exactly as parsed: RFC4180
 * quoting exists specifically to make padding *inside a quoted field*
 * significant, and there is no way to tell a deliberately-padded quoted
 * field apart from an unquoted field's incidental whitespace once both are
 * parsed — so CSV keeps everything, quoted or not. A Word table cell has no
 * analogous "the author explicitly asked to keep this space" signal:
 * `collectText`'s output is runs and paragraph breaks flattened to a
 * string, and leading/trailing whitespace there is run/paragraph structure
 * noise (an empty run before a tab stop, e.g.), never a user-chosen quoting
 * convention. Trimming it is not the same kind of guess CSV refuses to
 * make, so `docx.ts` trims before calling `classifyField` here, same as it
 * did before this module existed.
 *
 * This module also holds the two content caps spec §5.3 lists under
 * "protecting the parsing engine" and §3.4's caps table names —
 * `MAX_ROWS_PER_TABLE` and `MAX_CELL_CHARS` — so `csv.ts` and `docx.ts` can
 * enforce them the same way `xlsx.ts` already does (`xlsx.ts` keeps its own
 * copies of these two numbers rather than importing them from here, since
 * it was written before this module existed and the values must stay
 * identical either way; a structural-consistency test locks the three
 * extractors' caps together — see `cell.test.ts`).
 */

import type { Cell } from './types.js';

/** spec §3.4: rows per sheet/table. Shared so a CSV or Word table that is legitimately huge (§5.3's 200,000-row price list) is cut and flagged `truncated` exactly like an oversized Excel sheet, instead of landing in one unbounded `jsonb` row or dying against the child's stdout cap. */
export const MAX_ROWS_PER_TABLE = 50_000;

/** spec §3.4: characters per cell — Excel's own ceiling (§3.4's table names it as such), reused here as the one character cap every extractor's cells agree on. */
export const MAX_CELL_CHARS = 32_768;

/** Round-trip numeric check — only when parsing a field as a number and printing that number back out gives the exact same text. `"42"` passes; `"007"`, `"3.0"`, `"1e2"`, `"-0"`, and `" 42"` do not (see the original docblock this was lifted from, `csv.ts`'s git history) — deliberately narrower than "looks numeric", so a leading zero on a code or a padded value stays readable as text rather than silently losing the part that made it not an arbitrary integer. */
const NUMERIC_SHAPE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Classifies one piece of already-extracted text into the shared `{ v, t }` shape. An empty string is `{ v: null, t: 'empty' }`, never `{ v: '', t: 'string' }` — the same reading `xlsx.ts`'s `Null` case and `docx.ts`'s own span placeholder already use, so an empty cell reads the same regardless of which extractor produced it. */
export function classifyField(raw: string): Cell {
  if (raw === '') return { v: null, t: 'empty' };
  if (NUMERIC_SHAPE.test(raw) && String(Number(raw)) === raw) {
    return { v: Number(raw), t: 'number' };
  }
  return { v: raw, t: 'string' };
}

/**
 * Caps one string cell's length at `MAX_CELL_CHARS`, mirroring the per-cell
 * half of `xlsx.ts`'s `buildSheetGrid`. Non-string cells (`number`, `date`,
 * `bool`, `empty`) pass through untouched — the cap is a character cap, and
 * none of those hold a `string` value to be long in the first place.
 */
export function capCellChars(cell: Cell): { cell: Cell; truncated: boolean } {
  if (cell.t === 'string' && typeof cell.v === 'string' && cell.v.length > MAX_CELL_CHARS) {
    return { cell: { v: cell.v.slice(0, MAX_CELL_CHARS), t: 'string' }, truncated: true };
  }
  return { cell, truncated: false };
}

/** Caps a plain string at `MAX_CELL_CHARS` — the same cap `capCellChars` applies to a cell's value, reused for `docx.ts`'s block text (a paragraph, heading, or list item is not a table cell, but the same "one piece of text must not carry an unbounded number of characters into `jsonb`" reasoning applies to it identically). */
export function capText(text: string): { text: string; truncated: boolean } {
  if (text.length > MAX_CELL_CHARS) {
    return { text: text.slice(0, MAX_CELL_CHARS), truncated: true };
  }
  return { text, truncated: false };
}
