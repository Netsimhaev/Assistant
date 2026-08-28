/**
 * The structural outline (spec §6): "what is this file", computed from the
 * artefacts three extractors already produced, without ever calling a
 * model. `buildOutline` is pure and synchronous — no filesystem, no
 * network, no `fetch`, nothing async — which is the whole point: it is
 * testable without a database and it works on a machine with no API key,
 * the same property `know.reader` and the planner (docs/09-roadmap.md)
 * still lack.
 *
 * Consumes exactly what `extractXlsx`/`extractDocx`/`extractCsv`/
 * `extractPassthrough` emit (`DocumentArtifact[]`, see `./types.ts`) and
 * produces one more `DocumentArtifact` of `kind: 'outline'`,
 * `partName: null`, whose `content` is an `OutlineContent`.
 */

import type {
  Cell,
  DocumentArtifact,
  OutlineContent,
  OutlinePart,
  TableContent,
} from './types.js';

/** A cell counts as a header label only if it actually carries text. */
function isNonEmptyStringCell(cell: Cell): boolean {
  return cell.t === 'string' && typeof cell.v === 'string' && cell.v !== '';
}

/**
 * The header rule, stated exactly (spec §6, task-9-brief.md): the first row
 * counts as headers when every cell in it is a non-empty string **and** the
 * row below has at least one non-string cell. Otherwise there are no
 * headers — stated, not guessed.
 *
 * Both halves matter independently. Without the second half, a one-row
 * table (`tiny.xlsx`'s `פנימי` sheet) or a table whose first two rows are
 * both made of plain strings (`tiny.docx`'s table: `עמודה א/עמודה ב` over
 * `ערך 1/ערך 2` — a header row is genuinely indistinguishable from a second
 * data row here) would both get a header row invented from thin air. A
 * table with no row below the first has nothing to disqualify a guessed
 * header, which is exactly why it must not get one — "nothing contradicts
 * it" is not the same claim as "something confirms it".
 */
function detectHeaders(rows: readonly Cell[][]): string[] | null {
  const first = rows[0];
  const second = rows[1];
  if (!first || !second) return null;
  if (first.length === 0) return null;
  if (!first.every(isNonEmptyStringCell)) return null;
  if (!second.some((cell) => cell.t !== 'string')) return null;
  return first.map((cell) => cell.v as string);
}

interface ColumnStats {
  numbers: number[];
  dates: string[];
  /** A string or boolean cell was seen — the column is not homogeneous. */
  mixed: boolean;
}

/**
 * Decision 1 (task-9-brief.md, "a column that is numeric except for one
 * empty cell"): **an empty cell is skipped, never disqualifying.** A blank
 * cell in the middle of a numeric or date column is ordinary structure, not
 * evidence the column is not really numeric — `xlsx.ts`'s `trimGrid` and
 * `csv.ts`'s interior-blank-row handling both preserve an interior blank
 * deliberately (their own module docs call it "part of the structure, not
 * padding"), so this is the one reading of "wholly of that type" that does
 * not contradict what the extractors already promise to keep. A column
 * that is entirely empty carries no evidence either way and produces no
 * range (handled by the empty `numbers`/`dates` arrays below, not a special
 * case here).
 *
 * A **string or boolean** cell is different: it is a real type collision,
 * not a gap, so it disqualifies the column outright — `mixed` is what
 * guarantees "a column containing a string among the numbers must not
 * produce a numeric range" (the brief's second sentence), and it is
 * exercised by the real fixture: `tiny.xlsx`'s `מחירים` sheet has a merge
 * on its last row that overwrites the `כמות` (quantity) column's numeric
 * value with the merged label's string, so that column's own numeric range
 * must come out absent even though its other two rows are genuine numbers.
 */
function columnStats(rows: readonly Cell[][], columnIndex: number): ColumnStats {
  const stats: ColumnStats = { numbers: [], dates: [], mixed: false };
  for (const row of rows) {
    const cell = row[columnIndex];
    if (!cell || cell.t === 'empty') continue;
    if (cell.t === 'number' && typeof cell.v === 'number') {
      stats.numbers.push(cell.v);
    } else if (cell.t === 'date' && typeof cell.v === 'string') {
      stats.dates.push(cell.v);
    } else {
      stats.mixed = true;
    }
  }
  return stats;
}

function numberRangeOf(values: readonly number[]): { min: number; max: number } {
  let min = values[0] as number;
  let max = values[0] as number;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

/** Lexicographic min/max is correct here because every date is `YYYY-MM-DD` ISO text (see `xlsx.ts`'s `toIsoDate`) — the string ordering already matches calendar ordering. */
function dateRangeOf(values: readonly string[]): { from: string; to: string } {
  let from = values[0] as string;
  let to = values[0] as string;
  for (const value of values) {
    if (value < from) from = value;
    if (value > to) to = value;
  }
  return { from, to };
}

/**
 * One `table` artefact's part entry. `OutlinePart.dateRange` is a single
 * `{from, to}`, not a per-column `Record` the way `numericRanges` is — an
 * ordinary table has at most one date-bearing column, so the range that
 * matters is computed per wholly-date column exactly like the numeric one,
 * and every such column's span is folded into one overall `dateRange`
 * rather than inventing a second `Record` the type does not declare.
 */
function tablePart(name: string | null, content: TableContent): OutlinePart {
  const rows = Array.isArray(content?.rows) ? content.rows : [];
  const headers = detectHeaders(rows);
  const dataRows = headers ? rows.slice(1) : rows;
  const columnCount = dataRows.reduce((max, row) => Math.max(max, row.length), 0);

  const numericRanges: Record<string, { min: number; max: number }> = {};
  const dateSpans: Array<{ from: string; to: string }> = [];

  for (let column = 0; column < columnCount; column++) {
    const stats = columnStats(dataRows, column);
    if (stats.mixed) continue;

    if (stats.numbers.length > 0 && stats.dates.length === 0) {
      const key = headers?.[column] ?? String(column);
      numericRanges[key] = numberRangeOf(stats.numbers);
    } else if (stats.dates.length > 0 && stats.numbers.length === 0) {
      dateSpans.push(dateRangeOf(stats.dates));
    }
    // Both empty (a wholly-blank column) or both non-empty (a column that
    // somehow mixes number-typed and date-typed cells across rows, with no
    // string ever disqualifying it) contribute no range either way — there
    // is no single homogeneous type to report a range for.
  }

  const overallDateRange =
    dateSpans.length > 0
      ? {
          from: dateSpans.reduce((a, b) => (b.from < a ? b.from : a), dateSpans[0]?.from as string),
          to: dateSpans.reduce((a, b) => (b.to > a ? b.to : a), dateSpans[0]?.to as string),
        }
      : null;

  return {
    name,
    kind: 'table',
    rowCount: rows.length,
    ...(headers ? { headers } : {}),
    ...(Object.keys(numericRanges).length > 0 ? { numericRanges } : {}),
    ...(overallDateRange ? { dateRange: overallDateRange } : {}),
  };
}

/**
 * Decision 2 (task-9-brief.md, "what a `text` artefact contributes"): a
 * `text` artefact (`docx.ts`'s heading/paragraph/list `Block`s) has no rows
 * and no columns, so it gets no `rowCount`, no `headers`, no ranges —
 * `OutlinePart` has no field for "how many headings" or "how many
 * paragraphs" either, and inventing one here would be adding to the shared
 * contract from inside a single caller rather than answering what the type
 * already asks for. The part entry is deliberately just `{ name, kind }`:
 * enough to say "this document has prose here", which is exactly what §6
 * asks the outline to answer for a Word document's `text` artefact — the
 * verbal summary that actually reads the prose is explicitly out of scope
 * (§6: "requires a model, written to the same artefact table in
 * sub-project ב'").
 */
function textPart(name: string | null): OutlinePart {
  return { name, kind: 'text' };
}

/**
 * `buildOutline` never calls a model — the property that makes it testable
 * without a database or an API key and makes it work on a machine with
 * neither (spec §6). It is pure and synchronous on purpose: every fact it
 * reports is already sitting in the artefacts it was handed.
 *
 * An artefact whose own `kind` is already `'outline'` is skipped rather
 * than nested into a fresh one — no extractor in this codebase ever emits
 * one (`xlsx.ts`/`docx.ts`/`csv.ts`/`passthrough.ts` only ever produce
 * `table`/`text`), so this is a defensive floor against a future caller
 * accidentally re-running `buildOutline` over its own prior output, not a
 * path any current test exercises.
 */
export function buildOutline(artifacts: readonly DocumentArtifact[]): DocumentArtifact {
  const parts: OutlinePart[] = [];
  const flagSet = new Set<string>();

  for (const artifact of artifacts) {
    for (const flag of artifact.flags) flagSet.add(flag);

    if (artifact.kind === 'table') {
      parts.push(tablePart(artifact.partName, artifact.content as TableContent));
    } else if (artifact.kind === 'text') {
      parts.push(textPart(artifact.partName));
    }
  }

  // The outline's own ordinal follows every artefact it summarises, so a
  // caller that appends it to the extractor's output (`[...artifacts,
  // outline]`) before writing (`markExtracted`) gets a stable, gap-free
  // order back out of `loadArtifacts`'s `ORDER BY ordinal`. `-1` as the seed
  // makes an empty `artifacts` input land on ordinal `0` rather than
  // needing a separate branch.
  const maxOrdinal = artifacts.reduce((max, artifact) => Math.max(max, artifact.ordinal), -1);

  const content: OutlineContent = {
    parts,
    flags: [...flagSet].sort(),
  };

  return {
    ordinal: maxOrdinal + 1,
    kind: 'outline',
    partName: null,
    content,
    // The union of every input artefact's flags already lives inside
    // `content.flags` (spec §6). Duplicating it onto the outline
    // artefact's own top-level `flags` would be two copies of the same
    // fact that could drift apart from each other; the outline row itself
    // carries no state of its own to flag.
    flags: [],
  };
}
