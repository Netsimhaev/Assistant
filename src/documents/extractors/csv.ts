/**
 * The `csv` extractor (spec §4.3): one `table` artefact, the same `{ v, t }`
 * cell shape `xlsx.ts` and `docx.ts` produce — a reader of the resulting
 * `TableContent` must not be able to tell a CSV apart from either of them.
 *
 * Runs inside the same isolated child every other extractor id runs in
 * (`extract-child.ts`) — this module never touches the database and never
 * opens a socket, and there is no external parsing library here to exploit:
 * the whole thing is a hand-written tokenizer over a string already read
 * into memory by the same isolated child every other extractor runs in.
 *
 * **Separator detected from content, never assumed.** §4.3 requires this
 * explicitly, and for good reason: a spreadsheet exported for a
 * semicolon-decimal locale, or a tab-separated dump, is exactly as common a
 * shape as comma-separated, and guessing wrong silently merges every column
 * into one. `detectSeparator` scores each of four candidates (comma,
 * semicolon, tab, pipe) by running the *real, quote-aware* `parseCsvText`
 * tokenizer against the whole text once per candidate, taking the first
 * few resulting rows, and picking the candidate whose field count is most
 * consistent (highest-frequency mode) across those rows — provided that
 * mode is actually greater than 1. A candidate that never splits a row at
 * all is not evidence *for* that candidate; it is the absence of evidence,
 * and is scored 0 regardless of how "consistent" that non-split looks. If
 * every candidate scores 0 (a genuinely single-column file — see the "one
 * line, no separator" case below), comma is the explicit fallback:
 * RFC4180's own default, not a silent guess.
 *
 * **Scoring must be quote-aware, not just parsing.** An earlier version of
 * this function scored candidates with a naive (quote-unaware) `.split()`,
 * on the theory that detection "only has to pick a candidate, not parse".
 * That is wrong for an entirely ordinary file — a semicolon-delimited
 * export whose first column is a quoted `"Last, First"` name:
 *
 * ```
 * "a,b";c
 * "d,e";f
 * "g,h";i
 * ```
 *
 * A naive split on `,` sees one comma per line (inside the quotes) and
 * scores comma as perfectly consistent (mode 2, every line), while a naive
 * split on `;` also sees exactly one semicolon per line and ties it. Array
 * order (`[',', ';', '\t', '|']`) then silently decides in comma's favour
 * — the wrong one — merging two real columns into one. Worse: because
 * *every* row comes out equally wrong, `ragged_rows` never fires either;
 * the corruption is invisible to a consumer of the table. Scoring with the
 * real tokenizer fixes this at the source: quotes are honoured during
 * scoring exactly as they are during the real parse, so a quoted comma
 * never gets counted as a delimiter for the comma candidate, and the
 * semicolon candidate's fields split cleanly and consistently instead.
 * Parsing the whole text once per candidate (four full passes) rather than
 * a cheaper prefix trades some work for correctness; it is bounded by the
 * same overall file-size cap (§3.4) every other extractor already accepts
 * running under, and CSV files are not a case where a saved pass matters
 * more than the separator being right.
 *
 * **Ragged rows are kept, never dropped.** A row whose field count differs
 * from the file's modal (most common) field count stays exactly where it
 * was parsed, with exactly the fields it had — never padded, never
 * truncated, never moved to the end. The artefact's `flags` gets
 * `ragged_rows` once if *any* row disagrees with the mode; that is a
 * document fact about the whole table, not a per-row marker (`Cell` has no
 * flag field of its own — only `{ v, t }`, per `../types.ts`), so a reader
 * who wants to find the ragged row(s) recounts fields per row, same as this
 * extractor did. An interior blank line is one such row: it survives as a
 * one-field empty row (see `parseCsvText` below) at its true position,
 * matching `xlsx.ts`'s rule that a blank row between two data rows is
 * "part of the sheet's structure, not padding" rather than something to
 * skip — the three extractors are meant to be interchangeable, and here
 * that means agreeing on what a structural blank means. Because nothing is
 * ever dropped or renumbered, a ragged row's index in `rows` is always its
 * true line position, blank interior lines included.
 *
 * **Encoding is UTF-8, with a leading BOM stripped if present.** No
 * encoding *detection* is attempted beyond that — §4.3 names UTF-8 as the
 * default, and this project has no other encoding to fall back to; bytes
 * that are not valid UTF-8 decode with U+FFFD replacement characters rather
 * than throwing, which is `TextDecoder`'s (and `Buffer#toString('utf8')`'s)
 * own behaviour and is consistent with treating a row this extractor
 * *could* read as never the empty, silently-successful one (see the
 * "one line, no separator" note above): replacement characters are visible
 * garbage in the output, not a quiet empty table.
 *
 * **Numeric cells: round-trip, not "looks numeric".** A field becomes
 * `{ t: 'number' }` only when `String(Number(field)) === field` — i.e. only
 * when parsing it as a number and printing that number back out gives the
 * exact same text. `"42"` passes. `"007"`, `"3.0"`, `"1e2"`, `"-0"`, and
 * `" 42"` (leading space) all *parse* fine but do not round-trip, and stay
 * `{ t: 'string' }`. This is deliberate, not an oversight: a leading zero
 * on a code, a trailing zero of precision on a price, or an entry someone
 * typed with a leading space, is information a person put there on
 * purpose, and Task 9's per-column numeric ranges (spec §6) run over the
 * `number`-typed cells alone. Under-classifying leaves a value readable as
 * text (visibly still there, just not counted in a numeric range);
 * over-classifying — treating `"007"` as `7` — silently discards the part
 * that made it a product code and not an arbitrary integer. Between "a
 * price list Task 9 reads as slightly incomplete" and "a price list Task 9
 * reads as subtly wrong", this extractor picks the first.
 *
 * **No whitespace trimming, quoted or not.** A parsed field — including one
 * that never had quotes — is kept exactly as it appeared between separators
 * (see `parseCsvText` below). Trimming everywhere would strip a
 * deliberately padded, *quoted* field's spaces exactly as readily as an
 * unquoted field's incidental ones, and there is no way from the parsed
 * output alone to tell those two apart after the fact — RFC4180 quoting
 * exists specifically to make padding significant when someone chose to
 * quote it. "Kept exactly as read" beats guessing intent.
 */

import { readFile } from 'node:fs/promises';
import type { Cell, DocumentArtifact, TableContent } from '../types.js';

const SEPARATOR_CANDIDATES: readonly string[] = [',', ';', '\t', '|'];
const DEFAULT_SEPARATOR = ',';
const DETECTION_ROW_LIMIT = 5;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The value with the highest frequency in `counts`, and that frequency. Ties keep whichever value was reached first (`Map` preserves first-insertion order), so this is deterministic without needing a documented tie-break rule beyond "first seen". */
function modeAndFrequency(counts: number[]): { mode: number; frequency: number } {
  const tally = new Map<number, number>();
  for (const count of counts) {
    tally.set(count, (tally.get(count) ?? 0) + 1);
  }
  let mode = 0;
  let frequency = 0;
  for (const [count, freq] of tally) {
    if (freq > frequency) {
      mode = count;
      frequency = freq;
    }
  }
  return { mode, frequency };
}

/**
 * Picks the separator whose *quote-aware* parsed field count is most
 * consistent across the first `DETECTION_ROW_LIMIT` rows. Scores each
 * candidate by actually tokenizing the text with it (`parseCsvText`, below
 * — hoisted, so the declaration order here is fine), not by a naive split;
 * see the module docblock's "Scoring must be quote-aware" note for the
 * ordinary-looking file a naive split gets wrong.
 */
export function detectSeparator(text: string): string {
  let best = { separator: DEFAULT_SEPARATOR, score: 0 };
  for (const separator of SEPARATOR_CANDIDATES) {
    const rows = parseCsvText(text, separator).slice(0, DETECTION_ROW_LIMIT);
    const counts = rows.map((row) => row.length);
    const { mode, frequency } = modeAndFrequency(counts);
    const score = mode > 1 ? frequency : 0;
    if (score > best.score) {
      best = { separator, score };
    }
  }
  return best.separator;
}

/**
 * A quote-aware tokenizer (RFC4180-shaped): a field that starts with `"`
 * runs until its closing quote, and inside that quote the separator and
 * any newline are literal characters rather than delimiters; `""` inside a
 * quoted field is one literal `"`. An unterminated trailing quote (a
 * malformed file) degrades gracefully — everything read after the opening
 * quote becomes that field's value — rather than throwing.
 *
 * **Every newline ends a row, including a blank one.** A blank interior
 * line — two newlines back to back, with real content on both sides —
 * becomes a genuine row of one empty field: `['']`. That is deliberate,
 * not a gap in the "never drop data" rule; a blank line is itself a fact
 * about the file's structure (matching `xlsx.ts`'s interior-blank-row
 * rule — see the module docblock), and skipping it would silently shift
 * every row after it up by one, which is exactly the kind of "row is at
 * the wrong index" corruption this extractor exists to avoid.
 *
 * **Except the very last one.** A trailing newline at end of file — the
 * single line terminator every well-formed text file ends with — produces
 * no spurious final empty row. The two cases are told apart by state, not
 * by counting newlines: mid-file, a newline is *always* a row boundary
 * (unconditional `pushRow()` below); at end of input, a final row is only
 * flushed if a field was actually pending (`rowStarted`, or a non-empty
 * `field`) — which is false exactly when the text's very last character
 * was itself a newline that already closed out the preceding row. A file
 * ending in *two* newlines (a genuinely blank final line, not just one
 * terminator) does still produce that blank row — consistent with every
 * other interior blank line, and distinct from the single-trailing-
 * newline case this paragraph is about.
 */
export function parseCsvText(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let rowStarted = false;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
    rowStarted = false;
  };

  const length = text.length;
  let i = 0;
  while (i < length) {
    const char = text.charAt(i);

    if (inQuotes) {
      if (char === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += char;
        i += 1;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      rowStarted = true;
      i += 1;
      continue;
    }

    if (char === separator) {
      pushField();
      rowStarted = true;
      i += 1;
      continue;
    }

    if (char === '\n' || char === '\r') {
      if (char === '\r' && text.charAt(i + 1) === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }

    field += char;
    rowStarted = true;
    i += 1;
  }

  if (rowStarted || field !== '') {
    pushRow();
  }

  return rows;
}

/** Round-trip numeric check — see the module docblock's "round-trip, not 'looks numeric'" note. */
const NUMERIC_SHAPE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function classifyField(raw: string): Cell {
  if (raw === '') return { v: null, t: 'empty' };
  if (NUMERIC_SHAPE.test(raw) && String(Number(raw)) === raw) {
    return { v: Number(raw), t: 'number' };
  }
  return { v: raw, t: 'string' };
}

export async function extractCsv(sourcePath: string): Promise<DocumentArtifact[]> {
  const buffer = await readFile(sourcePath);
  const text = stripBom(buffer.toString('utf8'));

  const separator = detectSeparator(text);
  const stringRows = parseCsvText(text, separator);
  const rows: Cell[][] = stringRows.map((fields) => fields.map(classifyField));

  const flags: string[] = [];
  if (rows.length > 0) {
    const { mode } = modeAndFrequency(rows.map((row) => row.length));
    if (rows.some((row) => row.length !== mode)) {
      flags.push('ragged_rows');
    }
  }

  const content: TableContent = { rows };
  return [{ ordinal: 0, kind: 'table', partName: null, content, flags }];
}
