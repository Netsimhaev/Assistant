/**
 * The gate between what the drafter wrote and what gets built. A
 * `DocumentSpec` that parsed is only well-formed; this asks whether it is
 * TRUE to its sources and buildable:
 *
 * - **Cell numbers.** A `{v, src}` cell must be found in the one source it
 *   names — the instruction text, that artifact's text, or that memory's
 *   body — never in some other source. Matching is `ungroundedNumbers`
 *   (`governance/numeric-grounding.ts`), reused: thousands separators and
 *   trailing decimal zeros are normalised, so `1890` ≡ `1,890` ≡ `1890.00`.
 *   A cell in a `percent` column also grounds as its ×100 form (`0.15`
 *   against "15%"). A pointer that does not resolve is `source_not_found`,
 *   not ungrounded — the source is missing, not the number.
 * - **Free text** (titles, headings, paragraphs, list items, clause text,
 *   header strings, text cells, slide text): every number must appear in
 *   SOME source, in a formula result, or be structural. Structural numbers
 *   are a closed set: clause numbers 1..(number of clauses), slide numbers
 *   1..(number of slides), and today's year, month and day. Dates written
 *   with `/`, `-` or `:` are already excluded by `numbersIn`'s adjacency
 *   rule. `legalBasis` is NOT checked: it is a citation of a statute (whose
 *   name often carries a year), not a figure about the business.
 *   A known looseness of the structural set: with three clauses, a bare "3"
 *   anywhere in the text grounds. The alternative — parsing "סעיף 3" — is a
 *   Hebrew-grammar guess; this is the honest, closed rule.
 * - **Formulas** live in workbooks only. A formula in a docx/pdf/pptx table
 *   has no addresses to read and is `formula_problem`. In a workbook: every
 *   parse problem, every reference to a sheet that does not exist, and two
 *   sheets whose names differ only in case are `formula_problem` up front;
 *   then the workbook is evaluated (`evaluateWorkbook`) over the layout the
 *   renderer uses (`xlsx-layout.ts`). Every cell in `deviated` — THE
 *   GUARANTEE of `formula.ts` — is a `formula_problem`, ONE PROBLEM PER
 *   DEVIATED CELL (so the drafter sees each cell to fix); a formula cell that
 *   is not deviated but evaluates to an error is also one. A cell is reported
 *   once, deviated taking precedence.
 * - **Caps** (`CAPS`): sheets, rows per sheet, slides. Pages are checked
 *   after rendering (check 1), not here. Over a cap the spec is refused, not
 *   truncated.
 * - **Images** must name a `documentId` in `sources.documents`.
 * - **Filename**: the same positive rule as a folder segment (spec §9.2):
 *   letters, digits, space, `-`, `_`, and `.` not first or last; no Windows
 *   reserved name; bidi controls stripped first. The renderer appends the
 *   real extension.
 * - **Structure**: `REQUIRED_STRUCTURE[kind]`, Hebrew part names.
 *
 * Pure: no I/O, no model.
 */
import type {
  Block,
  Cell,
  DocumentKind,
  DocumentSpec,
  SourceRef,
  XlsxSheet,
} from '../domain/document-spec.js';
import { ungroundedNumbers } from '../governance/numeric-grounding.js';
import { stripBidiControls } from '../util/bidi.js';
import { evaluateWorkbook, parseFormula, type EvalError, type EvalValue, type FormulaAst } from './formula.js';
import { layoutSheet, toEvalSheet, type PlacedCell } from './xlsx-layout.js';

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
  /**
   * Today's LOCAL date (charter timezone), `YYYY-MM-DD`, for the structural
   * date numbers. Defaults to today's UTC date — callers in production pass
   * the charter-local date.
   */
  today?: string;
}

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

// ---------------------------------------------------------------- numbers

/** A number as plain digits — never exponent notation, never grouping. */
function plainNumber(v: number): string {
  return v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

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

class Collector {
  readonly problems: SpecProblem[] = [];
  constructor(
    private readonly sources: GroundingSources,
    /** Every source text, formula result and structural number, pooled. */
    private readonly pool: string[],
  ) {}

  add(code: SpecProblemCode, where: string, detail: string): void {
    this.problems.push({ code, where, detail });
  }

  text(where: string, text: string): void {
    const missing = ungroundedNumbers(text, this.pool);
    if (missing.length > 0) {
      this.add('ungrounded_number', where, `מספר שאין לו מקור: ${[...new Set(missing)].join(', ')}`);
    }
  }

  valueCell(where: string, cell: { v: number; src: SourceRef }, percent: boolean): void {
    const text = sourceText(cell.src, this.sources);
    if (text === null) {
      this.add('source_not_found', where, `המקור לא נמצא: ${describeRef(cell.src)}`);
      return;
    }
    const candidates = [plainNumber(cell.v)];
    if (percent) candidates.push(plainNumber(Number((cell.v * 100).toPrecision(15))));
    const grounded = candidates.some((c) => ungroundedNumbers(c, [text]).length === 0);
    if (!grounded) {
      this.add('ungrounded_number', where, `המספר ${plainNumber(cell.v)} לא נמצא ב${describeRef(cell.src)}`);
    }
  }

  /** A cell outside a workbook (docx/pdf/pptx table). */
  plainCell(where: string, cell: Cell): void {
    if ('v' in cell) this.valueCell(where, cell, false);
    else if ('t' in cell) this.text(where, cell.t);
    else if ('f' in cell) this.add('formula_problem', where, 'נוסחה מותרת רק בגיליון Excel');
  }

  plainTable(where: string, header: string[], rows: Cell[][]): void {
    header.forEach((h, c) => this.text(`${where} header col ${c + 1}`, h));
    rows.forEach((row, r) => row.forEach((cell, c) => this.plainCell(`${where} row ${r + 1} col ${c + 1}`, cell)));
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

/** Formula checks for a workbook; returns the numeric formula results for grounding. */
type AddProblem = (code: SpecProblemCode, where: string, detail: string) => void;

function checkWorkbook(sheets: XlsxSheet[], add: AddProblem): string[] {
  const layouts = sheets.map(layoutSheet);
  const upper = sheets.map((s) => s.name.toUpperCase());
  let duplicate = false;
  upper.forEach((name, i) => {
    if (upper.indexOf(name) !== i) {
      duplicate = true;
      add('formula_problem', `sheet ${i + 1}`, `שם הגיליון "${sheets[i]!.name}" כבר קיים (בלי הבדל בין אותיות גדולות לקטנות)`);
    }
  });

  let upFront = false;
  layouts.forEach((placed, si) => {
    for (const p of placed) {
      if (p.cell === null || !('f' in p.cell)) continue;
      const parsed = parseFormula(p.cell.f);
      if (!parsed.ok) {
        upFront = true;
        add('formula_problem', placedWhere(si, p), parsed.problem.detail);
        continue;
      }
      const named = new Set<string>();
      sheetNamesIn(parsed.ast, named);
      for (const name of named) {
        if (!upper.includes(name.toUpperCase())) {
          upFront = true;
          add('formula_problem', placedWhere(si, p), `הנוסחה מפנה לגיליון שאינו קיים: "${name}"`);
        }
      }
    }
  });
  // Evaluating would throw on a duplicate name, and a formula that did not
  // parse or names a missing sheet is already refused — the drafter fixes
  // those first; evaluation over them would only add derived noise.
  if (duplicate || upFront) return [];

  const evaluation = evaluateWorkbook(sheets.map(toEvalSheet));
  const results: string[] = [];
  layouts.forEach((placed, si) => {
    const name = sheets[si]!.name;
    const table = (t: number) => sheets[si]!.tables[t]!;
    for (const p of placed) {
      if (p.cell === null || !('f' in p.cell)) continue;
      const key = `${name}!${p.address}`;
      const value = evaluation.values.get(key);
      if (evaluation.deviated.has(key)) {
        add('formula_problem', placedWhere(si, p), 'לא ניתן לאמת שהנוסחה תחושב כמו ב-Excel');
      } else if (isEvalError(value)) {
        add('formula_problem', placedWhere(si, p), `הנוסחה מחזירה שגיאה: ${value.error}`);
      } else if (typeof value === 'number') {
        results.push(plainNumber(value), value.toFixed(2), value.toFixed(0));
        if (table(p.table).numberFormat?.[p.column] === 'percent') {
          const pct = value * 100;
          results.push(plainNumber(Number(pct.toPrecision(15))), pct.toFixed(2), pct.toFixed(0));
        }
      }
    }
  });
  return results;
}

// ---------------------------------------------------------------- filename

const FILENAME_CHARS = /^[\p{L}\p{M}\p{N} _\-.]+$/u;
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function filenameProblem(raw: string): string | null {
  const name = stripBidiControls(raw);
  if (name.trim().length === 0) return 'שם הקובץ ריק';
  if (!FILENAME_CHARS.test(name)) return 'שם הקובץ מכיל תו אסור (מותרים אותיות, ספרות, רווח, מקף, קו תחתון ונקודה)';
  if (name.startsWith('.') || name.endsWith('.') || name.endsWith(' ')) {
    return 'שם הקובץ לא יכול להתחיל בנקודה או להסתיים בנקודה או ברווח';
  }
  if (name.includes('..')) return 'שם הקובץ לא יכול להכיל ".."';
  const stem = name.split('.')[0]!.trim();
  if (WINDOWS_RESERVED.test(stem)) return `"${stem}" הוא שם שמור ב-Windows`;
  return null;
}

// ---------------------------------------------------------------- entry

function structuralNumbers(spec: DocumentSpec, today: string): string {
  const count = Math.max(clauseCount(spec), spec.format === 'pptx' ? spec.slides.length : 0);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const nums = [y, m, d];
  for (let i = 1; i <= count; i++) nums.push(i);
  return nums.join(' ');
}

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
        c.plainTable(where, b.header, b.rows);
        return;
      case 'clause':
        c.text(`${where} title`, b.title);
        c.text(where, b.text);
        return;
      case 'pageBreak':
      case 'image':
        return;
    }
  });
}

export function validateSpec(
  spec: DocumentSpec,
  sources: GroundingSources,
  options: ValidateSpecOptions = {},
): SpecProblem[] {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const early: SpecProblem[] = [];
  const add: AddProblem = (code, where, detail) => {
    early.push({ code, where, detail });
  };

  // Caps first: over a cap, nothing else is worth computing.
  if (spec.format === 'xlsx') {
    if (spec.sheets.length > CAPS.sheets) {
      add('cap_exceeded', 'document', `יש ${spec.sheets.length} גיליונות; המקסימום הוא ${CAPS.sheets}`);
    }
    spec.sheets.forEach((sheet, i) => {
      const rows = sheet.tables.reduce((n, t) => n + t.rows.length, 0);
      if (rows > CAPS.rowsPerSheet) {
        add('cap_exceeded', `sheet ${i + 1}`, `יש ${rows} שורות בגיליון; המקסימום הוא ${CAPS.rowsPerSheet}`);
      }
    });
  }
  if (spec.format === 'pptx' && spec.slides.length > CAPS.slides) {
    add('cap_exceeded', 'document', `יש ${spec.slides.length} שקפים; המקסימום הוא ${CAPS.slides}`);
  }
  if (early.length > 0) return early;

  const filename = filenameProblem(spec.filename);
  if (filename !== null) add('filename_invalid', 'filename', filename);

  const missing = REQUIRED_STRUCTURE[spec.kind](spec);
  if (missing.length > 0) add('missing_structure', 'document', `חסר במסמך: ${missing.join(', ')}`);

  spec.sources.forEach((ref, i) => {
    if (sourceText(ref, sources) === null) add('source_not_found', `sources ${i + 1}`, `המקור לא נמצא: ${describeRef(ref)}`);
  });

  const known = new Set(sources.documents.map((d) => d.documentId));
  for (const image of imageIds(spec)) {
    if (!known.has(image.documentId)) add('unknown_image', image.where, `התמונה מפנה למסמך שאינו בין המקורות: ${image.documentId}`);
  }

  const formulaResults = spec.format === 'xlsx' ? checkWorkbook(spec.sheets, add) : [];
  const pool = [
    sources.instructionText,
    ...sources.documents.flatMap((d) => d.artifacts.map((a) => a.text)),
    ...sources.memories.map((m) => m.body),
    ...formulaResults,
    structuralNumbers(spec, today),
  ];
  const c = new Collector(sources, pool);
  c.text('title', spec.title);

  switch (spec.format) {
    case 'docx':
    case 'pdf':
      checkBlocks(spec.blocks, c);
      break;
    case 'pptx':
      spec.slides.forEach((s, i) => {
        const where = `slide ${i + 1}`;
        if ('title' in s && s.title !== undefined) c.text(`${where} title`, s.title);
        switch (s.type) {
          case 'title':
            if (s.subtitle !== undefined) c.text(`${where} subtitle`, s.subtitle);
            return;
          case 'titleBullets':
            s.bullets.forEach((b, j) => c.text(`${where} bullet ${j + 1}`, b));
            return;
          case 'table':
          case 'chart':
            c.plainTable(where, s.header, s.rows);
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
          }
        }
      });
      break;
  }

  return [...early, ...c.problems];
}
