/**
 * The gate between what the drafter wrote and what gets built. A
 * `DocumentSpec` that parsed is only well-formed; this asks whether it is
 * TRUE to its sources and buildable. Pure: no I/O, no model.
 *
 * **Matching** reuses `ungroundedNumbers` (`governance/numeric-grounding.ts`)
 * — thousands separators and trailing decimal zeros normalised, so `1890` ≡
 * `1,890` ≡ `1890.00`, and a sign is part of the value (`-500` grounds on
 * "-500" or "500-", never on "500"). That module is advisory and drops every
 * digit run touching `/`, `-` or `:`; here that would let "12,000/חודש" or
 * "3000-4000" through unchecked, so both draft and source text go through
 * the steps of `Collector.text` first:
 *   - a cross-reference to one of THIS spec's clauses — exactly `סעיף N` or
 *     `סעיף N.M` (glued particles allowed: "לסעיף 4"), "Clause N",
 *     "Section N", with 1 ≤ N ≤ the clause count and M of 1–2 digits — is
 *     blanked. Only N is verifiable: sub-clauses are not modelled;
 *   - every full date shape (`d/m/yy(yy)`, `d.m.yy(yy)`, `d-m-yy(yy)`, ISO,
 *     or a date in
 *     words such as "4 בנובמבר 2026") whose date exists is grounded exactly
 *     like a `{d}` cell — it must equal `today` or be a date some source
 *     writes in any of these shapes — and reported as a whole when not;
 *   - times (`h:mm`, `h:mm:ss`, valid hour and minute) are exempt;
 *   - then every `/` or `:` touching a digit, and every `-` between a digit
 *     and a letter or digit, becomes a space — each side of a range is its
 *     own number. A leading or trailing minus sign is untouched.
 *
 * **Cells.** A `{v, src}` cell grounds only in the one source it names. Money
 * values are MAJOR units exactly as the sources write them (1890 = ₪1,890).
 * In a `percent` column a value is a FRACTION (0.15 displays 15%): its
 * displayed ×100 form must ground ("15%"/"15"), and the raw fraction is also
 * accepted when it is not an integer and the source writes that exact number
 * NOT followed by `%`, "אחוז(ים)" or "percent" ("0.15") — so `{v: 15}` (1500%) does not ground on
 * "15%", nor `{v: 1.5}` (150%) on "1.5%". A `{d}`
 * cell must equal `today` or be a date some source writes (ISO, `d/m/yyyy`,
 * `d.m.yyyy`, two-digit years as 20yy, or in words). A pointer that does not
 * resolve is `source_not_found`.
 *
 * **Free text** — the title, the filename, sheet names, headings,
 * paragraphs, list items, clause titles and text, table and slide headers,
 * text cells, slide text, string literals inside formulas, and
 * `legalBasis[].note` (the `law` itself is a statute citation and exempt) —
 * must ground in some source or in an untainted formula result. Structural
 * numbers are exempt only where structural: a clause or slide title that is
 * just its own number, or starts with "סעיף N" / "N." where N is that
 * clause's (or slide's) own position — and the clause cross-references
 * above. Today's year is exempt as a bare 4-digit number. In the filename
 * a dash between a letter and a digit is a separator ("report-2026"), not a
 * sign. Any other number in body text, cells or bullets is checked.
 *
 * **Formulas** live in workbooks only (a `{f}` in a docx/pdf/pptx table has
 * no addresses: `formula_problem`). In a workbook:
 *   - every NUMBER LITERAL must ground in the sources (not in formula
 *     results — a literal cannot ground itself), except POSITIONALLY: in a
 *     parameter position (ROUND* `digits`, VLOOKUP `col_index` and
 *     `range_lookup`, MATCH `match_type`, each within its bounds), or as a
 *     direct `*`/`/` operand in {0, 1, 100, 12} whose other operand contains
 *     a cell reference. So exempt values cannot be combined by arithmetic
 *     (`100*100+12*12+1+1`). A negated literal outside those positions is
 *     grounded WITH its sign (`-1890` needs "-1890", not "1890"). A literal
 *     f also grounds as an inline percent: f×100 or (f−1)×100 written with a
 *     percent mark in a source (`A2*1.17` / `A2*0.17` on "17%").
 *   - TRUE/FALSE as an operand of `+ - * / ^`, a unary sign or `%` is
 *     `formula_problem` (`(TRUE+TRUE)*A2` manufactures a 2).
 *   - a literal (number, string or boolean) argument of SUM, AVERAGE, MIN,
 *     MAX, COUNT, COUNTA, COUNTIF, SUMIF, SUMIFS or SUMPRODUCT is
 *     `formula_problem` — those take cells (`COUNTA("a",…)*100` would count
 *     strings into a number). The criteria argument of COUNTIF/SUMIF/SUMIFS
 *     may be a literal; its digits ground like any string literal.
 *   - a cell with an ungrounded literal is TAINTED, and so is every formula
 *     reading a tainted cell, transitively; a tainted result never grounds
 *     free text (no laundering `{f:'18900'}` into a title).
 *   - PERTURBATION: the workbook is evaluated a second time, same layout,
 *     with every `{v}` input × its OWN factor (`perturbationFactor`, fix
 *     round 6 — a uniform factor left every ratio of inputs unmoved). A
 *     numeric result that does not move beyond a relative 1e-9 (or is not a
 *     number under the perturbation) is CONSTANT-DERIVED
 *     (`A2/A2*100*100*12`, reference-free formulas): its displayed value must
 *     ground in the sources like a literal, and it never grounds free text.
 *     The same test applies to every OPERAND (fix round 5): each operand of
 *     `+ - * /`, each SUM/AVERAGE/MIN/MAX argument and ROUND*'s first
 *     argument, at any depth (an IF branch included), is evaluated as a
 *     synthetic cell in both workbooks; one that does not move must ground
 *     its own value, and taints the cell (`A2/A2*100*100*12+A2`).
 *     Exempt by name: a COUNT/COUNTA/COUNTIF/MATCH call alone, or scaled by
 *     ONE exempt literal — counts and positions are layout-derived. Their
 *     results never ground free text. COUNT/COUNTA take distinct,
 *     non-overlapping refs/ranges and COUNTIF one ref/range
 *     (`COUNTA(A2,A2,A2)` is `formula_problem`).
 *   - a STRING result is free text grounded in the sources (and today's
 *     year) only, never in formula results (`"5"&"0"&"0"&"0"`, `A2&"0"`).
 *   - untainted, non-constant results ground free text in the form the column displays:
 *     `int` → integer, `money`/`decimal2` → 2 decimals, `percent` → ×100,
 *     no format → the exact value.
 *   - up front, `formula_problem`: a parse problem, a reference to a sheet
 *     that does not exist (case-insensitive, as Excel), two sheet names that
 *     differ only in case. If any exists, evaluation is skipped.
 *   - then the workbook is evaluated (`evaluateWorkbook`) over the shared
 *     layout (`xlsx-layout.ts`): ONE `formula_problem` PER DEVIATED CELL
 *     (THE GUARANTEE of `formula.ts`), and one per non-deviated formula whose
 *     value is an error. A cell is reported once, deviated first.
 *
 * **Caps** (`CAPS`, checked first; over a cap nothing else runs): sheets,
 * rows per sheet, slides — and an xlsx date before 1900-03-01, which Excel's
 * 1900 date system cannot hold, is also `cap_exceeded` (outside the supported
 * range). Pages are checked after rendering, not here.
 *
 * **Images** must name a `documentId` in `sources.documents`. **Filename**:
 * the positive rule of spec §9.2. **Structure**: `REQUIRED_STRUCTURE[kind]`.
 */
import type {
  Block,
  Cell,
  DocumentKind,
  DocumentSpec,
  SourceRef,
  XlsxSheet,
  XlsxTable,
} from '../domain/document-spec.js';
import { ungroundedNumbers } from '../governance/numeric-grounding.js';
import { stripBidiControls } from '../util/bidi.js';
import {
  evaluateWorkbook,
  formatAddress,
  parseFormula,
  referencedCells,
  type EvalError,
  type EvalSheet,
  type EvalValue,
  type FormulaAst,
} from './formula.js';
import { nameProblem } from './name-rules.js';
import { EXCEL_MIN_DATE, layoutSheet, toEvalSheet, type PlacedCell } from './xlsx-layout.js';

export interface GroundingSources {
  instructionText: string;
  documents: { documentId: string; artifacts: { ordinal: number; text: string }[] }[];
  memories: { memoryId: string; body: string }[];
}

export type SpecProblemCode =
  | 'formula_problem'
  | 'ungrounded_number'
  | 'source_not_found'
  | 'cap_exceeded'
  | 'missing_structure'
  | 'unknown_image'
  | 'filename_invalid';

export interface SpecProblem {
  code: SpecProblemCode;
  /** Machine-readable position, e.g. 'sheet 1 table 1 row 3 col 2' (1-based). */
  where: string;
  detail: string;
}

export const CAPS = { sheets: 20, rowsPerSheet: 5000, pages: 60, slides: 40 } as const;

export const CONTRACT_DISCLAIMER_HE = 'טיוטה — מומלץ שעורך דין יעבור עליה';
export const CONTRACT_DISCLAIMER_EN = 'Draft — we recommend a lawyer review it';

export interface ValidateSpecOptions {
  /** Today's LOCAL date in the charter timezone, `YYYY-MM-DD`. Required: no UTC default. */
  today: string;
}

/** Number literals a formula may carry without a source. Closed set. */
export const EXEMPT_LITERALS: ReadonlySet<number> = new Set([0, 1, 100, 12]);

type AddProblem = (code: SpecProblemCode, where: string, detail: string) => void;

// ---------------------------------------------------------------- structure

/** Every heading-like label of the spec: where section names are written. */
function labels(spec: DocumentSpec): string[] {
  switch (spec.format) {
    case 'docx':
    case 'pdf':
      return spec.blocks.flatMap((b) =>
        b.type === 'heading' ? [b.text] : b.type === 'clause' ? [b.title] : [],
      );
    case 'pptx':
      return spec.slides.flatMap((s) => ('title' in s && s.title !== undefined ? [s.title] : []));
    case 'xlsx':
      return spec.sheets.flatMap((s) => [s.name, ...s.tables.flatMap((t) => (t.title === undefined ? [] : [t.title]))]);
  }
}

const hasLabel = (spec: DocumentSpec, pattern: RegExp) => labels(spec).some((l) => pattern.test(l));

interface PlainTable {
  header: string[];
  rows: Cell[][];
}

function tablesOf(spec: DocumentSpec): PlainTable[] {
  switch (spec.format) {
    case 'docx':
    case 'pdf':
      return spec.blocks.flatMap((b) => (b.type === 'table' ? [b] : []));
    case 'pptx':
      return spec.slides.flatMap((s) => (s.type === 'table' || s.type === 'chart' ? [s] : []));
    case 'xlsx':
      return spec.sheets.flatMap((s) => s.tables);
  }
}

const cellFilled = (cell: Cell | undefined): boolean =>
  cell !== undefined && ('t' in cell ? cell.t.trim().length > 0 : true);

const OWNER_COLUMN = /אחראי|owner|responsible/i;
const DUE_COLUMN = /מועד|due|deadline/i;

function hasTaskTable(spec: DocumentSpec): boolean {
  return tablesOf(spec).some((table) => {
    const owner = table.header.findIndex((h) => OWNER_COLUMN.test(h));
    const due = table.header.findIndex((h) => DUE_COLUMN.test(h));
    if (owner < 0 || due < 0 || table.rows.length === 0) return false;
    return table.rows.every((row) => cellFilled(row[owner]) && cellFilled(row[due]));
  });
}

function hasDateCell(spec: DocumentSpec): boolean {
  return tablesOf(spec).some((t) => t.rows.some((row) => row.some((c) => 'd' in c)));
}

const clauseCount = (spec: DocumentSpec): number =>
  spec.format === 'docx' || spec.format === 'pdf' ? spec.blocks.filter((b) => b.type === 'clause').length : 0;

const titleOnly = (spec: DocumentSpec): string[] => (spec.title.trim().length > 0 ? [] : ['כותרת']);

/**
 * Missing parts per kind, in Hebrew, in a fixed order. Section names are
 * looked for in heading-like labels (headings, clause titles, slide titles,
 * sheet names and table titles) — never in body text, where "בין הצדדים"
 * would count as a parties section.
 */
export const REQUIRED_STRUCTURE: Record<DocumentKind, (spec: DocumentSpec) => string[]> = {
  contract: (spec) => [
    ...titleOnly(spec),
    ...(hasLabel(spec, /צדד|parties/i) ? [] : ['צדדים']),
    ...(hasLabel(spec, /הגדר|definition/i) ? [] : ['הגדרות']),
    ...(clauseCount(spec) >= 1 ? [] : ['סעיפים']),
    ...(hasLabel(spec, /חתימ|signature/i) ? [] : ['חתימות']),
    ...(spec.legalBasis !== undefined && spec.legalBasis.length > 0 ? [] : ['בסיס חוקי']),
  ],
  protocol: (spec) => [
    ...titleOnly(spec),
    ...(hasLabel(spec, /תאריך|date/i) || hasDateCell(spec) ? [] : ['תאריך']),
    ...(hasLabel(spec, /משתתפ|נוכח|participant|attendee/i) ? [] : ['משתתפים']),
    ...(hasLabel(spec, /החלט|decision/i) ? [] : ['החלטות']),
    ...(hasTaskTable(spec) ? [] : ['משימות עם אחראי ומועד']),
  ],
  price_list: titleOnly,
  profit_table: titleOnly,
  report: titleOnly,
  letter: titleOnly,
  presentation: titleOnly,
  other: titleOnly,
};

// ---------------------------------------------------------------- text preparation

/** A number as plain digits — never exponent notation, never grouping. */
function plainNumber(v: number): string {
  return v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

const at15 = (v: number) => Number(v.toPrecision(15));

function parseIsoDate(value: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? [y, mo, d] : null;
}


// Not inside a longer number or separator run (a particle dash like "ל-" is fine).
const BEFORE = String.raw`(?<![\d.,/:]|\d-)`;
const AFTER = String.raw`(?![\d/:-]|[.,]\d)`;
const SLASH_DATE = new RegExp(`${BEFORE}(\\d{1,2})/(\\d{1,2})/(\\d{4}|\\d{2})${AFTER}`, 'g');
const DOT_DATE = new RegExp(`${BEFORE}(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4}|\\d{2})${AFTER}`, 'g');
const ISO_DATE = new RegExp(`${BEFORE}(\\d{4})-(\\d{2})-(\\d{2})${AFTER}`, 'g');
const DASH_DATE = new RegExp(`${BEFORE}(\\d{1,2})-(\\d{1,2})-(\\d{4}|\\d{2})${AFTER}`, 'g');
/** A number written as a percentage ("1.5%", "15 %", "2.5 אחוזים", "2.5 percent"). */
const PERCENT_FOLLOWED = /\d[\d,]*(?:\.\d+)?\s*(?:%|אחוז(?:ים)?|percent)/giu;
const TIME = new RegExp(`${BEFORE}(?:[01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?${AFTER}`, 'g');

const MONTH_NAMES: readonly (readonly string[])[] = [
  ['ינואר', 'january', 'jan'],
  ['פברואר', 'february', 'feb'],
  ['מרץ', 'מרס', 'march', 'mar'],
  ['אפריל', 'april', 'apr'],
  ['מאי', 'may'],
  ['יוני', 'june', 'jun'],
  ['יולי', 'july', 'jul'],
  ['אוגוסט', 'august', 'aug'],
  ['ספטמבר', 'september', 'sep', 'sept'],
  ['אוקטובר', 'october', 'oct'],
  ['נובמבר', 'november', 'nov'],
  ['דצמבר', 'december', 'dec'],
];
const WORD_DATE = new RegExp(
  `(?<!\\d)(\\d{1,2})\\s+(?:[בל]-?)?(${MONTH_NAMES.flat().join('|')})\\s+(\\d{4})(?!\\d)`,
  'giu',
);

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` for parts, or null when the date does not exist. A 2-digit year is 20yy. */
function isoOf(y: string, m: string, d: string): string | null {
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const iso = `${year}-${pad2(Number(m))}-${pad2(Number(d))}`;
  return parseIsoDate(iso) === null ? null : iso;
}

const monthNumber = (name: string) => MONTH_NAMES.findIndex((names) => names.includes(name.toLowerCase())) + 1;

/**
 * Every full date shape in `text` — `d/m/yy(yy)`, `d.m.yy(yy)`, ISO, and a
 * date in words — whose date exists, mapped through `replace` (given its ISO
 * form). A shape whose date does not exist stays as written, so its digits
 * are then checked as plain numbers.
 */
function replaceDates(text: string, replace: (iso: string, raw: string) => string): string {
  const via = (all: string, y: string, m: string, d: string) => {
    const iso = isoOf(y, m, d);
    return iso === null ? all : replace(iso, all);
  };
  return text
    .replace(SLASH_DATE, (all, d: string, m: string, y: string) => via(all, y, m, d))
    .replace(DOT_DATE, (all, d: string, m: string, y: string) => via(all, y, m, d))
    .replace(ISO_DATE, (all, y: string, m: string, d: string) => via(all, y, m, d))
    .replace(DASH_DATE, (all, d: string, m: string, y: string) => via(all, y, m, d))
    .replace(WORD_DATE, (all, d: string, month: string, y: string) => via(all, y, String(monthNumber(month)), d));
}

/** Every date (ISO form) some source writes, in any of the date shapes. */
function datesIn(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    replaceDates(t, (iso) => {
      out.add(iso);
      return ' ';
    });
  }
  return out;
}

const CLAUSE_REF = /(?<!\p{L})(?:[ולבמהכש]{0,3}סעיף|clause|section)\s+(\d+)(?:\.(\d{1,2}))?(?!\d|\.\d)/giu;

/**
 * Blank cross-references to this spec's own clauses: exactly `סעיף N` or
 * `סעיף N.M` (glued Hebrew particles allowed: "לסעיף 4"), or "Clause N" /
 * "Section N" (and N.M), where 1 ≤ N ≤ the clause count. A reference to a
 * clause that does not exist stays and is checked as a number. Sub-clauses
 * are not modelled in a spec, so only N is verifiable, not M.
 */
function blankClauseRefs(text: string, clauses: number): string {
  if (clauses === 0) return text;
  return text.replace(CLAUSE_REF, (all, n: string) => (Number(n) >= 1 && Number(n) <= clauses ? ' ' : all));
}

/** Split separators touching digits so each side is its own number. */
function splitSeparators(text: string): string {
  return text.replace(/(?<=\d)[/:]|[/:](?=\d)/g, ' ').replace(/(?<=\d)-(?=[\p{L}\p{N}])/gu, ' ');
}

const OWN_NUMBER_PREFIX = [/^\s*(\d+)\s*$/, /^\s*סעיף\s+(\d+)(?!\d)/, /^\s*(\d+)\.(?!\d)/];

/** Remove a title's own structural number (clause/slide position `n`), if it carries one. */
export function stripOwnNumber(title: string, n: number): string {
  for (const pattern of OWN_NUMBER_PREFIX) {
    const m = pattern.exec(title);
    if (m && Number(m[1]) === n) return title.slice(m[0].length);
  }
  return title;
}

// ---------------------------------------------------------------- sources

function sourceText(ref: SourceRef, sources: GroundingSources): string | null {
  switch (ref.kind) {
    case 'instruction':
      return sources.instructionText;
    case 'document': {
      const doc = sources.documents.find((d) => d.documentId === ref.documentId);
      const artifact = doc?.artifacts.find((a) => a.ordinal === ref.ordinal);
      return artifact === undefined ? null : artifact.text;
    }
    case 'memory': {
      const memory = sources.memories.find((m) => m.memoryId === ref.memoryId);
      return memory === undefined ? null : memory.body;
    }
  }
}

function describeRef(ref: SourceRef): string {
  switch (ref.kind) {
    case 'instruction':
      return 'ההוראה';
    case 'document':
      return `מסמך ${ref.documentId} חלק ${ref.ordinal}`;
    case 'memory':
      return `זיכרון ${ref.memoryId}`;
  }
}

const allSourceTexts = (s: GroundingSources): string[] => [
  s.instructionText,
  ...s.documents.flatMap((d) => d.artifacts.map((a) => a.text)),
  ...s.memories.map((m) => m.body),
];


/** Every percent-marked number the sources write ("17%", "2.5 אחוזים"), as its own text. */
const percentMarked = (texts: string[]): string[] => texts.flatMap((t) => t.match(PERCENT_FOLLOWED) ?? []);

// ---------------------------------------------------------------- collector

class Collector {
  readonly problems: SpecProblem[] = [];
  constructor(
    private readonly sources: GroundingSources,
    private readonly today: string,
    /** Every date some source writes, ISO form. */
    private readonly sourceDates: ReadonlySet<string>,
    /** Clauses in this spec, for cross-references. */
    private readonly clauses: number,
    /** Prepared source texts plus untainted formula results. */
    private readonly pool: string[],
  ) {}

  private dateGrounded(iso: string): boolean {
    return iso === this.today || this.sourceDates.has(iso);
  }

  add(code: SpecProblemCode, where: string, detail: string): void {
    this.problems.push({ code, where, detail });
  }

  /** Ungrounded numbers and dates of free text, against `pool` (default: sources + untainted results). */
  missing(text: string, pool: string[] = this.pool): string[] {
    const dates: string[] = [];
    const rest = replaceDates(blankClauseRefs(text, this.clauses), (iso, raw) => {
      if (!this.dateGrounded(iso)) dates.push(raw.trim());
      return ' ';
    }).replace(TIME, ' ');
    return [...new Set([...dates, ...ungroundedNumbers(splitSeparators(rest), pool)])];
  }

  text(where: string, text: string): void {
    this.report(where, this.missing(text));
  }

  report(where: string, missing: string[]): void {
    if (missing.length > 0) {
      this.add('ungrounded_number', where, `מספר או תאריך שאין לו מקור: ${missing.join(', ')}`);
    }
  }

  valueCell(where: string, cell: { v: number; src: SourceRef }, percent: boolean): void {
    const raw = sourceText(cell.src, this.sources);
    if (raw === null) {
      this.add('source_not_found', where, `המקור לא נמצא: ${describeRef(cell.src)}`);
      return;
    }
    const text = splitSeparators(raw);
    const groundsIn = (candidate: string, source: string) => ungroundedNumbers(candidate, [source]).length === 0;
    const displayed = percent ? plainNumber(at15(cell.v * 100)) : plainNumber(cell.v);
    // A percent cell's raw fraction counts only where the source writes that
    // exact number NOT followed by `%` ("0.15", never "1.5%" for {v: 1.5},
    // which would display 150%), and never for an integer.
    const rawAccepted =
      percent && !Number.isInteger(cell.v) && groundsIn(plainNumber(cell.v), text.replace(PERCENT_FOLLOWED, ' '));
    const grounded = groundsIn(displayed, text) || rawAccepted;
    if (!grounded) {
      const shown = percent ? `${displayed}%` : displayed;
      this.add('ungrounded_number', where, `המספר ${shown} לא נמצא ב${describeRef(cell.src)}`);
    }
  }

  dateCell(where: string, date: string): void {
    if (!this.dateGrounded(date)) {
      this.add('ungrounded_number', where, `התאריך ${date} לא נמצא באף מקור`);
    }
  }

  /** A cell outside a workbook (docx/pdf/pptx table). */
  plainCell(where: string, cell: Cell, percent = false): void {
    if ('v' in cell) this.valueCell(where, cell, percent);
    else if ('t' in cell) this.text(where, cell.t);
    else if ('d' in cell) this.dateCell(where, cell.d);
    else this.add('formula_problem', where, 'נוסחה מותרת רק בגיליון Excel');
  }

  plainTable(where: string, header: string[], rows: Cell[][], numberFormat?: readonly string[]): void {
    header.forEach((h, c) => this.text(`${where} header col ${c + 1}`, h));
    rows.forEach((row, r) =>
      row.forEach((cell, c) =>
        this.plainCell(`${where} row ${r + 1} col ${c + 1}`, cell, numberFormat?.[c] === 'percent'),
      ),
    );
  }
}

// ---------------------------------------------------------------- workbook

function sheetNamesIn(ast: FormulaAst, out: Set<string>): void {
  switch (ast.type) {
    case 'ref':
    case 'range':
      if (ast.sheet !== null) out.add(ast.sheet);
      return;
    case 'unary':
    case 'percent':
      sheetNamesIn(ast.arg, out);
      return;
    case 'binary':
      sheetNamesIn(ast.left, out);
      sheetNamesIn(ast.right, out);
      return;
    case 'call':
      ast.args.forEach((a) => sheetNamesIn(a, out));
      return;
    default:
      return;
  }
}

/** Functions whose arguments are refs/ranges; a literal argument is refused. */
const AGGREGATES: ReadonlySet<string> = new Set([
  'SUM',
  'AVERAGE',
  'MIN',
  'MAX',
  'COUNT',
  'COUNTA',
  'COUNTIF',
  'SUMIF',
  'SUMIFS',
  'SUMPRODUCT',
]);

/** The criteria argument of COUNTIF/SUMIF (index 1) and SUMIFS (2, 4, 6, …). */
const isCriteriaPosition = (name: string, i: number) =>
  ((name === 'COUNTIF' || name === 'SUMIF') && i === 1) || (name === 'SUMIFS' && i >= 2 && i % 2 === 0);

/** A literal, possibly signed or with `%`. */
function isLiteral(n: FormulaAst): boolean {
  if (n.type === 'number' || n.type === 'string' || n.type === 'boolean') return true;
  return (n.type === 'unary' || n.type === 'percent') && isLiteral(n.arg);
}

/** A number literal's magnitude (through a unary sign), else null. */
function numberOf(n: FormulaAst): number | null {
  if (n.type === 'number') return n.value;
  return n.type === 'unary' ? numberOf(n.arg) : null;
}

function hasCellRef(n: FormulaAst): boolean {
  switch (n.type) {
    case 'ref':
    case 'range':
      return true;
    case 'unary':
    case 'percent':
      return hasCellRef(n.arg);
    case 'binary':
      return hasCellRef(n.left) || hasCellRef(n.right);
    case 'call':
      return n.args.some(hasCellRef);
    default:
      return false;
  }
}

/**
 * A parameter position (not a value): ROUND/ROUNDUP/ROUNDDOWN `digits`
 * (an integer in −15..15), VLOOKUP `col_index` (1..16384) and `range_lookup`
 * (0/1), MATCH `match_type` (−1/0/1). The sign counts here: `ROUND(x,-1)`.
 */
function isParameter(name: string, i: number, arg: FormulaAst): boolean {
  const magnitude = numberOf(arg);
  if (magnitude === null || !Number.isInteger(magnitude)) return false;
  const v = arg.type === 'unary' && arg.op === '-' ? -magnitude : magnitude;
  switch (name) {
    case 'ROUND':
    case 'ROUNDUP':
    case 'ROUNDDOWN':
      return i === 1 && v >= -15 && v <= 15;
    case 'VLOOKUP':
      return (i === 2 && v >= 1 && v <= 16384) || (i === 3 && (v === 0 || v === 1));
    case 'MATCH':
      return i === 2 && v >= -1 && v <= 1;
    default:
      return false;
  }
}

const ARITHMETIC: ReadonlySet<string> = new Set(['+', '-', '*', '/', '^']);

/** TRUE/FALSE, possibly signed or with `%`. */
function isBooleanLiteral(n: FormulaAst): boolean {
  if (n.type === 'boolean') return true;
  return (n.type === 'unary' || n.type === 'percent') && isBooleanLiteral(n.arg);
}

/**
 * Functions whose result is a count — or, for MATCH, a position: layout-
 * derived, so it need not move with the inputs. MATCH is this round's own
 * addition to the ruled COUNT/COUNTA/COUNTIF: `MATCH(A2,A2:A9,0)` is the
 * row a value sits on, not a value.
 */
const COUNTS: ReadonlySet<string> = new Set(['COUNT', 'COUNTA', 'COUNTIF', 'MATCH']);

/**
 * A formula exempt BY NAME from the constant-derived check: exactly a
 * COUNTS call, or such a call times/divided by ONE exempt
 * literal (`COUNTIF(...)*100`, a recorded residual). Nothing wider: counts
 * combined by arithmetic (`(COUNT(A2)+COUNT(A2))*100*12`) manufacture
 * numbers exactly like `A2/A2`.
 */
function isCountResult(ast: FormulaAst): boolean {
  if (ast.type === 'call') return COUNTS.has(ast.name);
  if (ast.type !== 'binary' || (ast.op !== '*' && ast.op !== '/')) return false;
  const isCount = (n: FormulaAst) => n.type === 'call' && COUNTS.has(n.name);
  const isExempt = (n: FormulaAst) => n.type === 'number' && EXEMPT_LITERALS.has(n.value);
  return (isCount(ast.left) && isExempt(ast.right)) || (ast.op === '*' && isExempt(ast.left) && isCount(ast.right));
}

type Rect = { sheet: string; c1: number; c2: number; r1: number; r2: number };

function rectOf(n: FormulaAst, sheet: string): Rect | null {
  if (n.type === 'ref') {
    return { sheet: (n.sheet ?? sheet).toUpperCase(), c1: n.at.col, c2: n.at.col, r1: n.at.row, r2: n.at.row };
  }
  if (n.type === 'range') {
    return {
      sheet: (n.sheet ?? sheet).toUpperCase(),
      c1: Math.min(n.from.col, n.to.col),
      c2: Math.max(n.from.col, n.to.col),
      r1: Math.min(n.from.row, n.to.row),
      r2: Math.max(n.from.row, n.to.row),
    };
  }
  return null;
}

const overlaps = (a: Rect, b: Rect) =>
  a.sheet === b.sheet && a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2;

/**
 * The shape of a count's arguments (fix round 5): COUNT/COUNTA take distinct,
 * non-overlapping refs or ranges — `COUNTA(A2,A2,A2,A2,A2)` manufactures a
 * 5 — and COUNTIF exactly one ref or range. Literal arguments are left to
 * the aggregate-literal rule, so a cell is not refused twice for one thing.
 */
function countArgProblems(ast: FormulaAst, sheet: string, out: string[]): void {
  switch (ast.type) {
    case 'unary':
    case 'percent':
      countArgProblems(ast.arg, sheet, out);
      return;
    case 'binary':
      countArgProblems(ast.left, sheet, out);
      countArgProblems(ast.right, sheet, out);
      return;
    case 'call': {
      if (ast.name === 'COUNT' || ast.name === 'COUNTA') {
        const rects: Rect[] = [];
        ast.args.forEach((arg, i) => {
          if (isLiteral(arg)) return;
          const r = rectOf(arg, sheet);
          if (r === null) {
            out.push(`${ast.name} (ארגומנט ${i + 1}) חייב להיות תא או טווח`);
          } else if (rects.some((q) => overlaps(q, r))) {
            out.push(`${ast.name} (ארגומנט ${i + 1}) חופף לארגומנט קודם`);
          } else {
            rects.push(r);
          }
        });
      }
      if (ast.name === 'COUNTIF' && ast.args[0] !== undefined && rectOf(ast.args[0], sheet) === null) {
        out.push('COUNTIF (ארגומנט 1) חייב להיות תא או טווח');
      }
      ast.args.forEach((a) => countArgProblems(a, sheet, out));
      return;
    }
    default:
      return;
  }
}

const OPERAND_FUNCTIONS: ReadonlySet<string> = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX']);
const ROUNDS: ReadonlySet<string> = new Set(['ROUND', 'ROUNDUP', 'ROUNDDOWN']);

/**
 * Every subexpression the per-operand perturbation test applies to (fix
 * round 5): each operand of `+ - * /`, each argument of SUM/AVERAGE/MIN/MAX,
 * and the first argument of ROUND/ROUNDUP/ROUNDDOWN — at any depth, inside
 * any function (an IF branch included). A bare ref or range is an input, not
 * a computation, and a literal is grounded by the literal rule: both skipped.
 */
function operandsOf(ast: FormulaAst, out: FormulaAst[]): void {
  const test = (n: FormulaAst) => {
    if (n.type !== 'ref' && n.type !== 'range' && !isLiteral(n)) out.push(n);
  };
  switch (ast.type) {
    case 'unary':
    case 'percent':
      operandsOf(ast.arg, out);
      return;
    case 'binary':
      if (ast.op === '+' || ast.op === '-' || ast.op === '*' || ast.op === '/') {
        test(ast.left);
        test(ast.right);
      }
      operandsOf(ast.left, out);
      operandsOf(ast.right, out);
      return;
    case 'call':
      ast.args.forEach((arg, i) => {
        if (OPERAND_FUNCTIONS.has(ast.name) || (ROUNDS.has(ast.name) && i === 0)) test(arg);
        operandsOf(arg, out);
      });
      return;
    default:
      return;
  }
}

const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'!`;

/** A formula text for a subexpression, fully parenthesised, that parses back to the same AST. */
function printFormula(ast: FormulaAst): string {
  switch (ast.type) {
    case 'number':
      return plainNumber(ast.value);
    case 'string':
      return `"${ast.value.replace(/"/g, '""')}"`;
    case 'boolean':
      return ast.value ? 'TRUE' : 'FALSE';
    case 'ref':
      return `${ast.sheet === null ? '' : quoteSheet(ast.sheet)}${formatAddress(ast.at)}`;
    case 'range':
      return `${ast.sheet === null ? '' : quoteSheet(ast.sheet)}${formatAddress(ast.from)}:${formatAddress(ast.to)}`;
    case 'unary':
      return `(${ast.op}${printFormula(ast.arg)})`;
    case 'percent':
      return `(${printFormula(ast.arg)}%)`;
    case 'binary':
      return `(${printFormula(ast.left)}${ast.op}${printFormula(ast.right)})`;
    case 'call':
      return `${ast.name}(${ast.args.map(printFormula).join(',')})`;
  }
}

/** Synthetic cells live in the last column, where no spec table reaches. */
const SYNTHETIC_COLUMN = 16384;

interface FormulaLiterals {
  /** Number literals that must ground (signed when negated outside an exempt position). */
  numbers: number[];
  /** A TRUE/FALSE literal is an operand of `+ - * / ^`, a unary sign or `%`. */
  booleanArithmetic: boolean;
  /** String literals: free text. */
  strings: string[];
  /** Literal arguments of an aggregate outside a criteria position. */
  aggregateLiterals: string[];
}

/**
 * Collect a formula's literals under the POSITIONAL exemption (fix round 3):
 * a literal needs no source only in a parameter position (`isParameter`), or
 * as a direct operand of `*` or `/` whose value is in EXEMPT_LITERALS and
 * whose OTHER operand contains a cell reference (`A2*100`, `B2/12`). Every
 * other number literal must ground — any `+`/`-` operand, a literal inside a
 * function argument, a literal times a literal — so exempt values cannot be
 * combined by arithmetic into an arbitrary number.
 */
function literalsIn(ast: FormulaAst, out: FormulaLiterals, exempt = false): void {
  switch (ast.type) {
    case 'number':
      if (!exempt) out.numbers.push(ast.value);
      return;
    case 'string':
      out.strings.push(ast.value);
      return;
    case 'unary':
      if (isBooleanLiteral(ast.arg)) out.booleanArithmetic = true;
      // A negated literal outside an exempt position is grounded WITH its
      // sign: `-1890` needs "-1890" (or "1890-") in a source, not "1890".
      if (ast.op === '-' && ast.arg.type === 'number') {
        if (!exempt) out.numbers.push(-ast.arg.value);
        return;
      }
      literalsIn(ast.arg, out, exempt);
      return;
    case 'percent':
      if (isBooleanLiteral(ast.arg)) out.booleanArithmetic = true;
      literalsIn(ast.arg, out);
      return;
    case 'binary': {
      if (ARITHMETIC.has(ast.op) && (isBooleanLiteral(ast.left) || isBooleanLiteral(ast.right))) {
        out.booleanArithmetic = true;
      }
      const scaling = ast.op === '*' || ast.op === '/';
      const ok = (self: FormulaAst, other: FormulaAst) => {
        const v = numberOf(self);
        return scaling && v !== null && EXEMPT_LITERALS.has(v) && hasCellRef(other);
      };
      literalsIn(ast.left, out, ok(ast.left, ast.right));
      literalsIn(ast.right, out, ok(ast.right, ast.left));
      return;
    }
    case 'call':
      ast.args.forEach((arg, i) => {
        if (AGGREGATES.has(ast.name) && isLiteral(arg) && !isCriteriaPosition(ast.name, i)) {
          out.aggregateLiterals.push(`${ast.name} (ארגומנט ${i + 1})`);
          return;
        }
        if (isParameter(ast.name, i, arg)) return;
        literalsIn(arg, out);
      });
      return;
    default:
      return;
  }
}

function placedWhere(sheetIndex: number, p: PlacedCell): string {
  const base = `sheet ${sheetIndex + 1} table ${p.table + 1}`;
  switch (p.role) {
    case 'data':
      return `${base} row ${p.dataRow} col ${p.column + 1}`;
    case 'totals':
      return `${base} totals col ${p.column + 1}`;
    case 'header':
      return `${base} header col ${p.column + 1}`;
    case 'title':
      return `${base} title`;
  }
}

const isEvalError = (v: EvalValue | undefined): v is EvalError => typeof v === 'object' && v !== null;

/** The text a result shows in its column, for grounding free text. */
function displayedResult(value: number, table: XlsxTable, column: number): string {
  switch (table.numberFormat?.[column]) {
    case 'int':
      return at15(value).toFixed(0);
    case 'money':
    case 'decimal2':
      return at15(value).toFixed(2);
    case 'percent':
      return plainNumber(at15(value * 100));
    case undefined:
      return plainNumber(value);
  }
}

interface FormulaCellInfo {
  /** Ungrounded number literals, as plain strings. */
  ungrounded: string[];
  /** String literals: free text. */
  strings: string[];
  /** A string-valued result: free text grounded in the sources only. */
  stringResult: string | null;
  /**
   * Constant-derived values no source gives: the cell's own displayed result,
   * or an operand's value (fix round 5). One problem per cell.
   */
  constantUngrounded: string[];
}

interface WorkbookCheck {
  /** Per formula cell, keyed `SHEETUPPER!A1`. */
  cells: Map<string, FormulaCellInfo>;
  /** Displayed forms of untainted numeric results. */
  results: string[];
  /**
   * Every untainted numeric formula value, counts and grounded constants
   * included — what the built workbook SHOWS in those cells. Only
   * `createTextGrounder` reads it: a count may be shown, never cited.
   */
  shown: { value: number; percent: boolean }[];
}

const cellKey = (sheet: string, address: string) => `${sheet.toUpperCase()}!${address}`;

/**
 * The factor of the k-th `{v}` input (fix round 6). Each input gets its OWN
 * factor — a uniform factor leaves every ratio of inputs unmoved, so a margin
 * `C2/B2` or a share `A2/SUM(A2:A5)` looked constant. The k-th factor is
 * 1.1 + 0.8·frac((k+1)·φ⁻¹): a low-discrepancy sequence, so any two factors
 * stay well apart (~1/N for N inputs, far above MOVE_TOLERANCE) however many
 * inputs a workbook holds; a hyperbolic 1+0.37(k+1)/(k+2) would crowd toward
 * 1.37 and let ratios of late cells look constant. The same cell always gets
 * the same factor, so `A2/A2` and `A2/B2*B2/A2` stay invariant.
 */
export function perturbationFactor(k: number): number {
  const golden = 0.6180339887498949;
  const frac = ((k + 1) * golden) % 1;
  return 1.1 + 0.8 * frac;
}

/** Relative tolerance under which a perturbed value has NOT moved. */
const MOVE_TOLERANCE = 1e-9;

/** Did a value move under the perturbation? A non-number never counts as moved. */
function moved(v: number, m: EvalValue | undefined): boolean {
  return typeof m === 'number' && Math.abs(m - v) > MOVE_TOLERANCE * Math.max(Math.abs(v), 1);
}

/**
 * The same workbook, same layout, with every `{v}` input multiplied by its
 * own factor; k counts `{v}` cells in a fixed order (sheet, table, row, then
 * totals, column), so the perturbation is deterministic per spec.
 */
function perturbWorkbook(sheets: XlsxSheet[]): XlsxSheet[] {
  let k = 0;
  const move = (cell: Cell): Cell => ('v' in cell ? { ...cell, v: cell.v * perturbationFactor(k++) } : cell);
  return sheets.map((sheet) => ({
    ...sheet,
    tables: sheet.tables.map((t) => ({
      ...t,
      rows: t.rows.map((row) => row.map(move)),
      ...(t.totals === undefined ? {} : { totals: t.totals.map(move) }),
    })),
  }));
}

/**
 * A formula literal grounds in the sources as written, or as an inline
 * percent (fix round 6): f×100 or (f−1)×100 written WITH a percent mark
 * ("17%", "17 אחוז") — so `A2*1.17` and `A2*0.17` ground on "17%", and
 * `A2*1.18` does not. `percentPool` holds only the percent-marked numbers.
 */
function literalGrounded(f: number, literalPool: string[], percentPool: string[]): boolean {
  if (ungroundedNumbers(plainNumber(f), literalPool).length === 0) return true;
  // `ungroundedNumbers` treats an EMPTY pool as "nothing to check": no
  // percent-marked number in any source must mean no percent grounding.
  if (percentPool.length === 0) return false;
  return [f * 100, (f - 1) * 100].some((x) => ungroundedNumbers(plainNumber(at15(x)), percentPool).length === 0);
}

function checkWorkbook(
  sheets: XlsxSheet[],
  literalPool: string[],
  percentPool: string[],
  add: AddProblem,
): WorkbookCheck {
  const layouts = sheets.map(layoutSheet);
  const upper = sheets.map((s) => s.name.toUpperCase());
  const cells = new Map<string, FormulaCellInfo>();
  const reads = new Map<string, string[]>();
  const countResults = new Set<string>();
  const asts = new Map<string, { sheet: number; ast: FormulaAst }>();
  let blocked = false;

  upper.forEach((name, i) => {
    if (upper.indexOf(name) !== i) {
      blocked = true;
      add('formula_problem', `sheet ${i + 1}`, `שם הגיליון "${sheets[i]!.name}" כבר קיים (בלי הבדל בין אותיות גדולות לקטנות)`);
    }
  });

  layouts.forEach((placed, si) => {
    for (const p of placed) {
      if (p.cell === null || !('f' in p.cell)) continue;
      const key = cellKey(sheets[si]!.name, p.address);
      const parsed = parseFormula(p.cell.f);
      if (!parsed.ok) {
        blocked = true;
        add('formula_problem', placedWhere(si, p), parsed.problem.detail);
        continue;
      }
      const named = new Set<string>();
      sheetNamesIn(parsed.ast, named);
      for (const name of named) {
        if (!upper.includes(name.toUpperCase())) {
          blocked = true;
          add('formula_problem', placedWhere(si, p), `הנוסחה מפנה לגיליון שאינו קיים: "${name}"`);
        }
      }
      const literals: FormulaLiterals = { numbers: [], booleanArithmetic: false, strings: [], aggregateLiterals: [] };
      literalsIn(parsed.ast, literals);
      if (literals.booleanArithmetic) {
        blocked = true;
        add('formula_problem', placedWhere(si, p), 'TRUE/FALSE אינם מספרים: אסור להשתמש בהם בחישוב');
      }
      if (literals.aggregateLiterals.length > 0) {
        blocked = true;
        add(
          'formula_problem',
          placedWhere(si, p),
          `פונקציה שמקבלת תאים קיבלה ערך קבוע: ${literals.aggregateLiterals.join(', ')}`,
        );
      } else {
        const shape: string[] = [];
        countArgProblems(parsed.ast, sheets[si]!.name, shape);
        if (shape.length > 0) {
          blocked = true;
          add('formula_problem', placedWhere(si, p), shape.join('; '));
        }
      }
      const ungrounded = literals.numbers
        .filter((n) => !literalGrounded(n, literalPool, percentPool))
        .map(plainNumber);
      cells.set(key, {
        ungrounded: [...new Set(ungrounded)],
        strings: literals.strings,
        stringResult: null,
        constantUngrounded: [],
      });
      asts.set(key, { sheet: si, ast: parsed.ast });
      if (isCountResult(parsed.ast)) countResults.add(key);
      reads.set(
        key,
        referencedCells(parsed.ast).map((ref) => {
          const bang = ref.lastIndexOf('!');
          return bang < 0 ? cellKey(sheets[si]!.name, ref) : cellKey(ref.slice(0, bang), ref.slice(bang + 1));
        }),
      );
    }
  });
  // Evaluating would throw on a duplicate name, and a formula that did not
  // parse or names a missing sheet is already refused — evaluation over them
  // would only add derived noise.
  if (blocked) return { cells, results: [], shown: [] };

  // Taint: an ungrounded literal, or reading a tainted cell, transitively.
  const propagate = (tainted: Set<string>) => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const [key, deps] of reads) {
        if (!tainted.has(key) && deps.some((d) => tainted.has(d))) {
          tainted.add(key);
          changed = true;
        }
      }
    }
    return tainted;
  };
  const literalTainted = propagate(new Set([...cells].filter(([, info]) => info.ungrounded.length > 0).map(([k]) => k)));

  const evaluation = evaluateWorkbook(sheets.map(toEvalSheet));
  // The perturbation check: the same workbook and layout with every `{v}`
  // input ×PERTURBATION. A numeric result that does not move is built from
  // constants, not from the inputs (`A2/A2*100*100*12`), so its displayed
  // value must ground like a literal, and it never grounds free text.
  const perturbed = evaluateWorkbook(perturbWorkbook(sheets).map(toEvalSheet));
  // Per-operand perturbation (fix round 5): every operand subexpression
  // (`operandsOf`) becomes a synthetic cell on its own sheet, in a copy of
  // both workbooks — same layout, so its refs mean what they mean in the
  // cell. An operand that does not move is constant-derived exactly like a
  // whole cell: `A2/A2*100*100*12+A2` moves, but its left operand does not.
  const synthetic: { key: string; evalKey: string; ast: FormulaAst }[] = [];
  const syntheticRows = sheets.map(() => 0);
  for (const [key, { sheet, ast }] of asts) {
    if (literalTainted.has(key)) continue;
    const ops: FormulaAst[] = [];
    operandsOf(ast, ops);
    for (const op of ops) {
      syntheticRows[sheet]! += 1;
      const address = formatAddress({ col: SYNTHETIC_COLUMN, row: syntheticRows[sheet]! });
      synthetic.push({ key, evalKey: `${sheets[sheet]!.name}!${address}`, ast: op });
    }
  }
  const withSynthetic = (evalSheets: EvalSheet[]) => {
    for (const cell of synthetic) {
      const bang = cell.evalKey.lastIndexOf('!');
      const target = evalSheets.find((e) => e.name === cell.evalKey.slice(0, bang))!;
      target.cells.set(cell.evalKey.slice(bang + 1), { f: printFormula(cell.ast) });
    }
    return evaluateWorkbook(evalSheets);
  };
  if (synthetic.length > 0) {
    const base = withSynthetic(sheets.map(toEvalSheet));
    const shifted = withSynthetic(perturbWorkbook(sheets).map(toEvalSheet));
    for (const cell of synthetic) {
      const v = base.values.get(cell.evalKey);
      if (typeof v !== 'number' || isCountResult(cell.ast)) continue;
      if (moved(v, shifted.values.get(cell.evalKey))) continue;
      const shown = plainNumber(at15(v));
      if (ungroundedNumbers(shown, literalPool).length > 0) cells.get(cell.key)!.constantUngrounded.push(shown);
    }
  }

  const constants = new Set<string>();
  const numeric: { key: string; shown: string }[] = [];
  const values: { key: string; value: number; percent: boolean }[] = [];
  layouts.forEach((placed, si) => {
    const name = sheets[si]!.name;
    for (const p of placed) {
      if (p.cell === null || !('f' in p.cell)) continue;
      const evalKey = `${name}!${p.address}`;
      const key = cellKey(name, p.address);
      const info = cells.get(key)!;
      const value = evaluation.values.get(evalKey);
      if (evaluation.deviated.has(evalKey)) {
        add('formula_problem', placedWhere(si, p), 'לא ניתן לאמת שהנוסחה תחושב כמו ב-Excel');
      } else if (isEvalError(value)) {
        add('formula_problem', placedWhere(si, p), `הנוסחה מחזירה שגיאה: ${value.error}`);
      } else if (typeof value === 'string') {
        info.stringResult = value;
      } else if (typeof value === 'number' && !literalTainted.has(key)) {
        const shown = displayedResult(value, sheets[si]!.tables[p.table]!, p.column);
        values.push({ key, value, percent: sheets[si]!.tables[p.table]!.numberFormat?.[p.column] === 'percent' });

        // A perturbed result that is not a number counts as NOT moved: the
        // stricter reading (a branch that errors on other inputs). A count or
        // MATCH result is exempt from grounding but never grounds free text.
        const counted = countResults.has(key);
        const constant = !counted && !moved(value, perturbed.values.get(evalKey));
        if (constant && ungroundedNumbers(shown, literalPool).length > 0) info.constantUngrounded.unshift(shown);
        if (constant || counted) constants.add(key);
        else numeric.push({ key, shown });
      }
    }
  });
  // A constant-derived value no source gives taints like an ungrounded literal.
  const tainted = propagate(
    new Set([...literalTainted, ...[...cells].filter(([, i]) => i.constantUngrounded.length > 0).map(([k]) => k)]),
  );
  const results = numeric.filter((n) => !tainted.has(n.key) && !constants.has(n.key)).map((n) => n.shown);
  for (const info of cells.values()) info.constantUngrounded = [...new Set(info.constantUngrounded)];
  return { cells, results, shown: values.filter((v) => !tainted.has(v.key)).map(({ value, percent }) => ({ value, percent })) };
}

// ---------------------------------------------------------------- filename

// The same rule `doc.save` applies to every folder segment and to the saved
// name (`name-rules.ts`, spec §9.2) — one copy, so a filename production
// accepts is never refused at save after the owner approved it.
const filenameProblem = nameProblem;

// ---------------------------------------------------------------- entry

function imageIds(spec: DocumentSpec): { where: string; documentId: string }[] {
  switch (spec.format) {
    case 'docx':
    case 'pdf':
      return spec.blocks.flatMap((b, i) => (b.type === 'image' ? [{ where: `block ${i + 1}`, documentId: b.documentId }] : []));
    case 'pptx':
      return spec.slides.flatMap((s, i) => {
        if (s.type === 'imageText') return [{ where: `slide ${i + 1}`, documentId: s.documentId }];
        if (s.type === 'collage') {
          return s.documentIds.map((documentId, j) => ({ where: `slide ${i + 1} image ${j + 1}`, documentId }));
        }
        return [];
      });
    case 'xlsx':
      return [];
  }
}

function checkBlocks(blocks: Block[], c: Collector): void {
  let clause = 0;
  blocks.forEach((b, i) => {
    const where = `block ${i + 1}`;
    switch (b.type) {
      case 'heading':
      case 'paragraph':
        c.text(where, b.text);
        return;
      case 'list':
        b.items.forEach((item, j) => c.text(`${where} item ${j + 1}`, item));
        return;
      case 'table':
        c.plainTable(where, b.header, b.rows, b.numberFormat);
        return;
      case 'clause':
        clause += 1;
        c.text(`${where} title`, stripOwnNumber(b.title, clause));
        c.text(where, b.text);
        return;
      case 'pageBreak':
      case 'image':
        return;
    }
  });
}

function checkCaps(spec: DocumentSpec, add: AddProblem): void {
  if (spec.format === 'xlsx') {
    if (spec.sheets.length > CAPS.sheets) {
      add('cap_exceeded', 'document', `יש ${spec.sheets.length} גיליונות; המקסימום הוא ${CAPS.sheets}`);
    }
    spec.sheets.forEach((sheet, i) => {
      const rows = sheet.tables.reduce((n, t) => n + t.rows.length, 0);
      if (rows > CAPS.rowsPerSheet) {
        add('cap_exceeded', `sheet ${i + 1}`, `יש ${rows} שורות בגיליון; המקסימום הוא ${CAPS.rowsPerSheet}`);
      }
      for (const p of layoutSheet(sheet)) {
        if (p.cell !== null && 'd' in p.cell && p.cell.d < EXCEL_MIN_DATE) {
          add('cap_exceeded', placedWhere(i, p), `תאריך לפני ${EXCEL_MIN_DATE} אינו נתמך ב-Excel`);
        }
      }
    });
  }
  if (spec.format === 'pptx' && spec.slides.length > CAPS.slides) {
    add('cap_exceeded', 'document', `יש ${spec.slides.length} שקפים; המקסימום הוא ${CAPS.slides}`);
  }
}

export function validateSpec(
  spec: DocumentSpec,
  sources: GroundingSources,
  options: ValidateSpecOptions,
): SpecProblem[] {
  const today = options?.today;
  const todayParts = typeof today === 'string' ? parseIsoDate(today) : null;
  if (today === undefined || todayParts === null) {
    throw new TypeError('validateSpec: options.today must be the charter-local date as YYYY-MM-DD');
  }

  const early: SpecProblem[] = [];
  const add: AddProblem = (code, where, detail) => {
    early.push({ code, where, detail });
  };

  // Caps first: over a cap, nothing else is worth computing.
  checkCaps(spec, add);
  if (early.length > 0) return early;

  const filename = stripBidiControls(spec.filename);
  const filenameIssue = filenameProblem(filename);
  if (filenameIssue !== null) add('filename_invalid', 'filename', filenameIssue);

  const missing = REQUIRED_STRUCTURE[spec.kind](spec);
  if (missing.length > 0) add('missing_structure', 'document', `חסר במסמך: ${missing.join(', ')}`);

  spec.sources.forEach((ref, i) => {
    if (sourceText(ref, sources) === null) add('source_not_found', `sources ${i + 1}`, `המקור לא נמצא: ${describeRef(ref)}`);
  });

  const known = new Set(sources.documents.map((d) => d.documentId));
  for (const image of imageIds(spec)) {
    if (!known.has(image.documentId)) add('unknown_image', image.where, `התמונה מפנה למסמך שאינו בין המקורות: ${image.documentId}`);
  }

  const sourcePool = allSourceTexts(sources).map(splitSeparators);
  // What a string formula result may ground in: sources and today's year, never formula results.
  const freeTextSources = [...sourcePool, today.slice(0, 4)];
  const workbook = spec.format === 'xlsx' ? checkWorkbook(spec.sheets, sourcePool, percentMarked(allSourceTexts(sources)), add) : null;
  const c = new Collector(sources, today, datesIn(allSourceTexts(sources)), clauseCount(spec), [
    ...sourcePool,
    ...(workbook?.results ?? []),
    // Today's year is structural as a bare number ("בשנת 2026"); free text only.
    today.slice(0, 4),
  ]);

  c.text('title', spec.title);
  // In a filename a dash between a letter and a digit is a separator
  // ("report-2026"), never a minus sign.
  if (filenameIssue === null) c.text('filename', filename.replace(/(?<=\p{L})-(?=\d)/gu, ' '));
  spec.legalBasis?.forEach((basis, i) => {
    if (basis.note !== undefined) c.text(`legalBasis ${i + 1} note`, basis.note);
  });

  switch (spec.format) {
    case 'docx':
    case 'pdf':
      checkBlocks(spec.blocks, c);
      break;
    case 'pptx':
      spec.slides.forEach((s, i) => {
        const where = `slide ${i + 1}`;
        if ('title' in s && s.title !== undefined) c.text(`${where} title`, stripOwnNumber(s.title, i + 1));
        switch (s.type) {
          case 'title':
            if (s.subtitle !== undefined) c.text(`${where} subtitle`, s.subtitle);
            return;
          case 'titleBullets':
            s.bullets.forEach((b, j) => c.text(`${where} bullet ${j + 1}`, b));
            return;
          case 'table':
          case 'chart':
            c.plainTable(where, s.header, s.rows, s.type === 'table' ? s.numberFormat : undefined);
            return;
          case 'imageText':
          case 'paragraph':
            c.text(where, s.text);
            return;
          case 'collage':
            return;
        }
      });
      break;
    case 'xlsx':
      spec.sheets.forEach((sheet, si) => {
        c.text(`sheet ${si + 1} name`, sheet.name);
        for (const p of layoutSheet(sheet)) {
          const where = placedWhere(si, p);
          if (p.text !== null) {
            c.text(where, p.text);
            continue;
          }
          const cell = p.cell;
          if (cell === null) continue;
          if ('v' in cell) {
            c.valueCell(where, cell, sheet.tables[p.table]!.numberFormat?.[p.column] === 'percent');
          } else if ('t' in cell) {
            c.text(where, cell.t);
          } else if ('d' in cell) {
            c.dateCell(where, cell.d);
          } else {
            const info = workbook?.cells.get(cellKey(sheet.name, p.address));
            if (info === undefined) continue; // did not parse: already a formula_problem
            if (info.ungrounded.length > 0) {
              c.add('ungrounded_number', where, `מספר בנוסחה שאין לו מקור: ${info.ungrounded.join(', ')}`);
            }
            if (info.constantUngrounded.length > 0) {
              c.add(
                'ungrounded_number',
                where,
                `ערך בנוסחה שאינו תלוי בנתונים ואין לו מקור: ${info.constantUngrounded.join(', ')}`,
              );
            }
            const reported = new Set<string>();
            for (const s of info.strings) {
              const missing = c.missing(s);
              missing.forEach((m) => reported.add(m));
              c.report(where, missing);
            }
            // A string result is checked against the sources only, never
            // against formula results ("5"&"0"&"0"&"0" shows 5000). A number a
            // string literal already reported is not reported twice.
            if (info.stringResult !== null) {
              c.report(where, c.missing(info.stringResult, freeTextSources).filter((m) => !reported.has(m)));
            }
          }
        }
      });
      break;
  }

  return [...early, ...c.problems];
}

// ---------------------------------------------------------------- text read back from a built file

/** Every `{v}` cell of the spec, with whether its column shows it as a percent. */
function valueCells(spec: DocumentSpec): { value: number; percent: boolean }[] {
  const out: { value: number; percent: boolean }[] = [];
  const take = (rows: Cell[][], numberFormat: readonly string[] | undefined) =>
    rows.forEach((row) =>
      row.forEach((cell, c) => {
        if ('v' in cell) out.push({ value: cell.v, percent: numberFormat?.[c] === 'percent' });
      }),
    );
  switch (spec.format) {
    case 'docx':
    case 'pdf':
      for (const b of spec.blocks) if (b.type === 'table') take(b.rows, b.numberFormat);
      break;
    case 'pptx':
      for (const s of spec.slides) {
        if (s.type === 'table') take(s.rows, s.numberFormat);
        else if (s.type === 'chart') take(s.rows, undefined);
      }
      break;
    case 'xlsx':
      for (const sheet of spec.sheets) {
        for (const t of sheet.tables) take([...t.rows, ...(t.totals === undefined ? [] : [t.totals])], t.numberFormat);
      }
      break;
  }
  return out;
}

/**
 * The forms a value takes on a page: as written, and rounded to 0–6
 * decimals (a column format or a viewer rounds); a percent cell shows ×100.
 */
function displayVariants(value: number, percent: boolean): string[] {
  const x = at15(percent ? value * 100 : value);
  const out = new Set([plainNumber(x)]);
  for (let d = 0; d <= 6; d += 1) out.add(plainNumber(Number(x.toFixed(d))));
  return [...out];
}

export interface TextGrounderOptions {
  /** Today's LOCAL date in the charter timezone, `YYYY-MM-DD`. */
  today: string;
  /** Structural numbers the caller knows the page carries (page numbers, clause labels). */
  extraPool?: readonly string[];
}

/**
 * Grounding for text READ BACK from a built file (check 1, `check1.ts`):
 * the same preparation as `Collector.text` — clause cross-references, dates
 * against `today` and the sources, times, separators — over a pool of the
 * sources, today's year, untainted formula results, `extraPool`, and the
 * DISPLAYED forms of the spec's own values (`{v}` cells and every untainted
 * formula value, counts included, rounded as a column or viewer shows them,
 * percent ×100). A built page shows "₪1,890" or "39%" where the spec holds
 * 1890 or 0.39; without those forms every correct table would fail.
 *
 * The spec's values are in the pool because `validateSpec` grounded them:
 * a caller MUST also run `validateSpec` on the same spec and refuse its
 * problems (check 1 does), or an ungrounded `{v}` would ground its own text.
 * What this catches is the file disagreeing with the spec — a number the
 * renderer, a tamper or a converter put on the page that no source, spec
 * value or structure explains.
 */
export function createTextGrounder(
  spec: DocumentSpec,
  sources: GroundingSources,
  options: TextGrounderOptions,
): (text: string) => string[] {
  const today = options?.today;
  if (typeof today !== 'string' || parseIsoDate(today) === null) {
    throw new TypeError('createTextGrounder: options.today must be the charter-local date as YYYY-MM-DD');
  }
  const texts = allSourceTexts(sources);
  const sourcePool = texts.map(splitSeparators);
  const workbook =
    spec.format === 'xlsx' ? checkWorkbook(spec.sheets, sourcePool, percentMarked(texts), () => undefined) : null;
  const displayed = [...valueCells(spec), ...(workbook?.shown ?? [])].flatMap((v) => displayVariants(v.value, v.percent));
  const c = new Collector(sources, today, datesIn(texts), clauseCount(spec), [
    ...sourcePool,
    ...(workbook?.results ?? []),
    today.slice(0, 4),
    displayed.join(' '),
    ...(options.extraPool ?? []).map(splitSeparators),
  ]);
  return (text) => c.missing(text);
}
