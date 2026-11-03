/**
 * Our own formula language: a parser with a positive function whitelist, and
 * an evaluator with Excel semantics. Pure TypeScript, no I/O, no dependency.
 *
 * Why not a library: HyperFormula is GPLv3 (spec §7, ruling C5), and every
 * other evaluator is a supply-chain surface for a grammar this small. The
 * evaluator exists to recompute every formula of a built workbook and to
 * write cached results, so a disagreement with Excel is a wrong number the
 * owner sees. The aim is to fail closed (an error value) where we cannot
 * match Excel exactly; the two known exceptions are listed below.
 *
 * Grammar: numbers, strings, TRUE/FALSE, `+ - * / ^ & = <> < <= > >=`, unary
 * `-`/`+`, postfix `%`, refs `A1`/`$A$1`, ranges `A1:B9`, sheet refs
 * `Sheet1!A1` / `'גיליון 1'!A1`, and calls to FORMULA_FUNCTIONS. Everything
 * else is a problem: an unknown function (INDIRECT, OFFSET, HYPERLINK,
 * WEBSERVICE, CALL among them — none is whitelisted), an external workbook
 * `[x]`, a defined name, or a syntax error.
 *
 * Known, deliberate deviations from Excel that yield an error where Excel
 * yields a value. Every one of them is raised through `refuse()`, so no
 * IFERROR — in the same cell or a cell that reads it — turns it into the
 * fallback; errors Excel itself raises stay plain and catchable:
 * - Text in arithmetic is #VALUE! even when it looks numeric (Excel: "5"+1=6).
 *   Text containing any digit is refused (Excel may coerce it); text with no
 *   digit is a plain #VALUE!, as in Excel.
 * - A function argument that must be a range but is not (Excel rejects the
 *   formula outright).
 * - INDEX asked for a whole row/column of a 2-D range (Excel: an array).
 * - A multi-cell range in scalar context is #VALUE! (no implicit intersection),
 *   so array idioms like SUMPRODUCT((A1:A3>1)*B1:B3) are #VALUE!.
 * - IFERROR over a multi-cell range is a #VALUE! that no IFERROR swallows
 *   (Excel 365 would spill an array).
 * - SUMIF's sum_range must have the criteria range's shape (Excel resizes).
 * - Approximate MATCH/VLOOKUP verify the lookup column is sorted (by Excel
 *   type rank) and return #N/A when it is not; Excel's binary search returns
 *   an arbitrary row there.
 * - IFERROR never catches #CIRC!: a cycle is never rescued into a number.
 * - A formula that does not parse evaluates to #NAME? (Excel cannot store it).
 *
 * Known deviations that can yield a DIFFERENT VALUE (parked, not fixed):
 * - Text ordering for < > and criteria/lookup order is lowercase code-unit
 *   order, not Excel's locale collation (punctuation, digits vs letters and
 *   Hebrew niqqud may sort differently).
 * - Number-to-text (`&`, text criteria) uses 15 significant digits with JS
 *   formatting (exponent at 1e21 / 1e-7), not Excel's General format (which
 *   switches to exponent notation past 11 characters).
 * - The add/subtract cancellation snap (a result below 2^-50 × the larger
 *   operand becomes 0) applies to every intermediate + and -, not only the
 *   final operation of the formula as in Excel. So (0.3-(0.1+0.2))*1e20 is 0
 *   here; Excel gives about -5.55e3.
 */

export const FORMULA_FUNCTIONS = [
  'SUM',
  'AVERAGE',
  'MIN',
  'MAX',
  'ROUND',
  'ROUNDUP',
  'ROUNDDOWN',
  'IF',
  'IFERROR',
  'AND',
  'OR',
  'COUNT',
  'COUNTA',
  'COUNTIF',
  'SUMIF',
  'SUMIFS',
  'SUMPRODUCT',
  'ABS',
  'INDEX',
  'MATCH',
  'VLOOKUP',
] as const;
export type FormulaFunction = (typeof FORMULA_FUNCTIONS)[number];

/** [min, max] argument counts. SUMIFS additionally needs an odd count. */
const ARITY: Record<FormulaFunction, readonly [number, number]> = {
  SUM: [1, 255],
  AVERAGE: [1, 255],
  MIN: [1, 255],
  MAX: [1, 255],
  ROUND: [2, 2],
  ROUNDUP: [2, 2],
  ROUNDDOWN: [2, 2],
  IF: [2, 3],
  IFERROR: [2, 2],
  AND: [1, 255],
  OR: [1, 255],
  COUNT: [1, 255],
  COUNTA: [1, 255],
  COUNTIF: [2, 2],
  SUMIF: [2, 3],
  SUMIFS: [3, 255],
  SUMPRODUCT: [1, 255],
  ABS: [1, 1],
  INDEX: [2, 3],
  MATCH: [2, 3],
  VLOOKUP: [3, 4],
};

function isWhitelisted(name: string): name is FormulaFunction {
  return Object.hasOwn(ARITY, name);
}

/** Excel's own limits; beyond them a formula is refused, not truncated. */
export const MAX_FORMULA_CHARS = 8192;
const MAX_NESTING = 64;
/** A range larger than this is refused at parse time (bounds evaluation cost). */
export const MAX_RANGE_CELLS = 100_000;
const MAX_COL = 16384; // XFD
const MAX_ROW = 1_048_576;

// ---------------------------------------------------------------- AST

export interface CellAddress {
  /** 1-based. */
  col: number;
  /** 1-based. */
  row: number;
}

export type FormulaAst =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'ref'; sheet: string | null; at: CellAddress }
  | { type: 'range'; sheet: string | null; from: CellAddress; to: CellAddress }
  | { type: 'unary'; op: '-' | '+'; arg: FormulaAst }
  | { type: 'percent'; arg: FormulaAst }
  | { type: 'binary'; op: BinaryOp; left: FormulaAst; right: FormulaAst }
  | { type: 'call'; name: FormulaFunction; args: FormulaAst[] };

type BinaryOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '<=' | '>' | '>=';

export type FormulaProblemKind = 'unknown_function' | 'external_reference' | 'defined_name' | 'syntax';
export interface FormulaProblem {
  kind: FormulaProblemKind;
  detail: string;
}

export type ParseResult = { ok: true; ast: FormulaAst } | { ok: false; problem: FormulaProblem };

class ProblemError extends Error {
  constructor(readonly problem: FormulaProblem) {
    super(problem.detail);
  }
}

function fail(kind: FormulaProblemKind, detail: string): never {
  throw new ProblemError({ kind, detail });
}

// ---------------------------------------------------------------- addresses

export function columnName(col: number): string {
  let s = '';
  let n = col;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function formatAddress(a: CellAddress): string {
  return `${columnName(a.col)}${a.row}`;
}

const REF_SHAPE = /^\$?([A-Za-z]{1,3})\$?([0-9]+)$/;

/** A1-style text → address, or null when it is not a cell inside the grid. */
function readRef(text: string): CellAddress | null {
  const m = REF_SHAPE.exec(text);
  if (!m) return null;
  const col = columnNumber(m[1]!.toUpperCase());
  const row = Number(m[2]);
  if (col < 1 || col > MAX_COL || row < 1 || row > MAX_ROW) return null;
  return { col, row };
}

const CELL_KEY = /^([A-Z]{1,3})([1-9][0-9]*)$/;

/** Parses an EvalSheet key; keys must be canonical (`A1`, uppercase, no `$`). */
function readCellKey(key: string): CellAddress {
  const m = CELL_KEY.exec(key);
  const at = m ? readRef(key) : null;
  if (!at) throw new Error(`invalid cell key: ${JSON.stringify(key)}`);
  return at;
}

// ---------------------------------------------------------------- tokens

type Token =
  | { t: 'num'; value: number }
  | { t: 'str'; value: string }
  | { t: 'bool'; value: boolean }
  | { t: 'ref'; sheet: string | null; at: CellAddress }
  | { t: 'func'; name: FormulaFunction }
  | { t: 'op'; value: string }
  | { t: 'end' };

const IDENT_START = /[\p{L}_\\$]/u;
const IDENT_PART = /[\p{L}\p{N}_.\\$]/u;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const peek = (k = 0) => src[i + k];

  const readIdent = (): string => {
    const start = i;
    while (i < src.length && IDENT_PART.test(src[i]!)) i++;
    return src.slice(start, i);
  };

  /** After `Sheet!`: must be a cell, or it is a sheet-scoped defined name. */
  const readQualifiedRef = (sheet: string): Token => {
    if (peek() === '[') fail('external_reference', 'הפניה לחוברת עבודה חיצונית');
    if (i >= src.length || !IDENT_START.test(src[i]!)) fail('syntax', `חסר תא אחרי ${sheet}!`);
    const ident = readIdent();
    const at = readRef(ident);
    if (!at) fail('defined_name', `שם מוגדר: ${sheet}!${ident}`);
    return { t: 'ref', sheet, at };
  };

  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '[' || ch === ']') fail('external_reference', 'הפניה לחוברת עבודה חיצונית');
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(peek(1) ?? ''))) {
      const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))!;
      i += m[0].length;
      const value = Number(m[0]);
      if (!Number.isFinite(value)) fail('syntax', `מספר לא תקין: ${m[0]}`);
      tokens.push({ t: 'num', value });
      continue;
    }
    if (ch === '"') {
      i++;
      let s = '';
      for (;;) {
        if (i >= src.length) fail('syntax', 'מחרוזת לא נסגרה');
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i];
        i++;
      }
      tokens.push({ t: 'str', value: s });
      continue;
    }
    if (ch === "'") {
      i++;
      let name = '';
      for (;;) {
        if (i >= src.length) fail('syntax', 'שם גיליון לא נסגר');
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            name += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (src[i] === '[' || src[i] === ']') fail('external_reference', 'הפניה לחוברת עבודה חיצונית');
        name += src[i];
        i++;
      }
      if (name === '') fail('syntax', 'שם גיליון ריק');
      if (peek() !== '!') fail('syntax', `חסר ! אחרי '${name}'`);
      i++;
      tokens.push(readQualifiedRef(name));
      continue;
    }
    if (IDENT_START.test(ch)) {
      const ident = readIdent();
      const next = peek();
      if (next === '!') {
        i++;
        tokens.push(readQualifiedRef(ident));
        continue;
      }
      if (next === '(') {
        const name = ident.toUpperCase();
        if (!isWhitelisted(name)) fail('unknown_function', `פונקציה לא מורשית: ${ident}`);
        tokens.push({ t: 'func', name });
        continue;
      }
      const upper = ident.toUpperCase();
      if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({ t: 'bool', value: upper === 'TRUE' });
        continue;
      }
      const at = readRef(ident);
      if (at) {
        tokens.push({ t: 'ref', sheet: null, at });
        continue;
      }
      if (/^\$?[A-Za-z]{1,3}$/.test(ident) && next === ':') fail('syntax', 'הפניה לעמודה שלמה אינה נתמכת');
      if (next === ':') fail('syntax', `טווח לא תקין אחרי ${ident}`);
      fail('defined_name', `שם מוגדר: ${ident}`);
    }
    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') {
      tokens.push({ t: 'op', value: two });
      i += 2;
      continue;
    }
    if ('+-*/^&=<>%(),:'.includes(ch)) {
      tokens.push({ t: 'op', value: ch });
      i++;
      continue;
    }
    fail('syntax', `תו לא צפוי: ${ch}`);
  }
  tokens.push({ t: 'end' });
  return tokens;
}

// ---------------------------------------------------------------- parser

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  private get tok(): Token {
    return this.tokens[this.pos]!;
  }

  private isOp(value: string): boolean {
    const t = this.tok;
    return t.t === 'op' && t.value === value;
  }

  private expectOp(value: string): void {
    if (!this.isOp(value)) fail('syntax', `חסר ${value}`);
    this.pos++;
  }

  private enter(): void {
    this.depth++;
    if (this.depth > MAX_NESTING) fail('syntax', 'קינון עמוק מדי');
  }

  parse(): FormulaAst {
    const ast = this.comparison();
    if (this.tok.t !== 'end') fail('syntax', 'תווים מיותרים בסוף הנוסחה');
    return ast;
  }

  private comparison(): FormulaAst {
    this.enter();
    let left = this.concat();
    for (;;) {
      const t = this.tok;
      if (t.t === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(t.value)) {
        this.pos++;
        left = { type: 'binary', op: t.value as BinaryOp, left, right: this.concat() };
      } else break;
    }
    this.depth--;
    return left;
  }

  private concat(): FormulaAst {
    let left = this.additive();
    while (this.isOp('&')) {
      this.pos++;
      left = { type: 'binary', op: '&', left, right: this.additive() };
    }
    return left;
  }

  private additive(): FormulaAst {
    let left = this.multiplicative();
    for (;;) {
      const t = this.tok;
      if (t.t === 'op' && (t.value === '+' || t.value === '-')) {
        this.pos++;
        left = { type: 'binary', op: t.value, left, right: this.multiplicative() };
      } else break;
    }
    return left;
  }

  private multiplicative(): FormulaAst {
    let left = this.power();
    for (;;) {
      const t = this.tok;
      if (t.t === 'op' && (t.value === '*' || t.value === '/')) {
        this.pos++;
        left = { type: 'binary', op: t.value, left, right: this.power() };
      } else break;
    }
    return left;
  }

  /** Excel's ^ is left-associative: 2^3^2 = 64. */
  private power(): FormulaAst {
    let left = this.postfix();
    while (this.isOp('^')) {
      this.pos++;
      left = { type: 'binary', op: '^', left, right: this.postfix() };
    }
    return left;
  }

  private postfix(): FormulaAst {
    let arg = this.unary();
    while (this.isOp('%')) {
      this.pos++;
      arg = { type: 'percent', arg };
    }
    return arg;
  }

  /** Negation binds tighter than ^ in Excel: -2^2 = 4. */
  private unary(): FormulaAst {
    const t = this.tok;
    if (t.t === 'op' && (t.value === '-' || t.value === '+')) {
      this.pos++;
      this.enter();
      const arg = this.unary();
      this.depth--;
      return { type: 'unary', op: t.value, arg };
    }
    return this.primary();
  }

  private primary(): FormulaAst {
    const t = this.tok;
    switch (t.t) {
      case 'num':
        this.pos++;
        return { type: 'number', value: t.value };
      case 'str':
        this.pos++;
        return { type: 'string', value: t.value };
      case 'bool':
        this.pos++;
        return { type: 'boolean', value: t.value };
      case 'ref':
        this.pos++;
        return this.maybeRange(t.sheet, t.at);
      case 'func':
        this.pos++;
        return this.call(t.name);
      case 'op':
        if (t.value === '(') {
          this.pos++;
          const inner = this.comparison();
          this.expectOp(')');
          return inner;
        }
        return fail('syntax', `אופרטור לא צפוי: ${t.value}`);
      case 'end':
        return fail('syntax', 'הנוסחה נגמרה באמצע');
    }
  }

  private maybeRange(sheet: string | null, from: CellAddress): FormulaAst {
    if (!this.isOp(':')) return { type: 'ref', sheet, at: from };
    this.pos++;
    const end = this.tok;
    if (end.t !== 'ref') fail('syntax', 'טווח לא תקין');
    if (end.sheet !== null && (sheet === null || !sameSheetName(end.sheet, sheet))) {
      fail('syntax', 'טווח על פני כמה גיליונות אינו נתמך');
    }
    this.pos++;
    const a = { col: Math.min(from.col, end.at.col), row: Math.min(from.row, end.at.row) };
    const b = { col: Math.max(from.col, end.at.col), row: Math.max(from.row, end.at.row) };
    if ((b.col - a.col + 1) * (b.row - a.row + 1) > MAX_RANGE_CELLS) fail('syntax', 'טווח גדול מדי');
    return { type: 'range', sheet, from: a, to: b };
  }

  private call(name: FormulaFunction): FormulaAst {
    this.enter();
    this.expectOp('(');
    const args: FormulaAst[] = [];
    if (!this.isOp(')')) {
      for (;;) {
        if (this.isOp(',') || this.isOp(')')) fail('syntax', `ארגומנט ריק ב-${name}`);
        args.push(this.comparison());
        if (this.isOp(',')) {
          this.pos++;
          continue;
        }
        break;
      }
    }
    this.expectOp(')');
    const [min, max] = ARITY[name];
    if (args.length < min || args.length > max || (name === 'SUMIFS' && args.length % 2 === 0)) {
      fail('syntax', `מספר ארגומנטים שגוי ל-${name}`);
    }
    this.depth--;
    return { type: 'call', name, args };
  }
}

/** Parses a formula stored without its leading `=`. Never throws. */
export function parseFormula(src: string): ParseResult {
  try {
    if (src.length > MAX_FORMULA_CHARS) fail('syntax', 'נוסחה ארוכה מדי');
    if (src.trim() === '') fail('syntax', 'נוסחה ריקה');
    return { ok: true, ast: new Parser(tokenize(src)).parse() };
  } catch (e) {
    if (e instanceof ProblemError) return { ok: false, problem: e.problem };
    throw e;
  }
}

function sameSheetName(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/**
 * Every cell the formula reads, in order of appearance, deduplicated, ranges
 * expanded row by row. Unqualified refs are `A1`; sheet-qualified ones are
 * `Sheet!A1` with the sheet name as written (unquoted).
 */
export function referencedCells(ast: FormulaAst): string[] {
  const out = new Set<string>();
  const prefix = (sheet: string | null) => (sheet === null ? '' : `${sheet}!`);
  const walk = (node: FormulaAst): void => {
    switch (node.type) {
      case 'ref':
        out.add(prefix(node.sheet) + formatAddress(node.at));
        return;
      case 'range':
        for (let r = node.from.row; r <= node.to.row; r++) {
          for (let c = node.from.col; c <= node.to.col; c++) out.add(prefix(node.sheet) + formatAddress({ col: c, row: r }));
        }
        return;
      case 'unary':
      case 'percent':
        walk(node.arg);
        return;
      case 'binary':
        walk(node.left);
        walk(node.right);
        return;
      case 'call':
        node.args.forEach(walk);
        return;
      default:
        return;
    }
  };
  walk(ast);
  return [...out];
}

// ---------------------------------------------------------------- values

export type FormulaErrorCode = '#DIV/0!' | '#REF!' | '#VALUE!' | '#N/A' | '#CIRC!' | '#NUM!' | '#NAME?';
export interface EvalError {
  error: FormulaErrorCode;
}
export type EvalValue = number | string | boolean | EvalError;

/** What a sheet cell may hold as input: a literal, a formula, or empty. */
export type SheetCellInput = number | string | boolean | { f: string } | null;

/**
 * A sheet to evaluate. Keys are canonical A1 addresses (uppercase, no `$`);
 * a formula is `{ f }` without its leading `=`; `null` (or no key) is empty.
 */
export interface EvalSheet {
  name: string;
  cells: Map<string, SheetCellInput>;
}

/** null = an empty cell. */
type Cell = EvalValue | null;
interface RangeOp {
  kind: 'range';
  rows: number;
  cols: number;
  at(r: number, c: number): Cell;
}
type Operand = Cell | RangeOp;

const mkErr = (error: FormulaErrorCode): EvalError => ({ error });

/**
 * Deviation errors: ones WE return where Excel would return a value (see the
 * module docblock). No IFERROR may swallow them, or the fallback becomes a
 * plausible wrong number. Tracked by identity — errors propagate as the same
 * object, also across cells (a cell stores the object it evaluated to).
 * Errors Excel itself raises stay plain and catchable.
 */
const UNCATCHABLE = new WeakSet<EvalError>();
function refuse(code: FormulaErrorCode): EvalError {
  const e = mkErr(code);
  UNCATCHABLE.add(e);
  return e;
}

function isErr(v: unknown): v is EvalError {
  return typeof v === 'object' && v !== null && 'error' in v;
}
function isRange(v: Operand): v is RangeOp {
  return typeof v === 'object' && v !== null && 'kind' in v;
}

function scalarRange(value: Cell): RangeOp {
  return { kind: 'range', rows: 1, cols: 1, at: () => value };
}

function toScalar(op: Operand): Cell {
  if (!isRange(op)) return op;
  if (op.rows === 1 && op.cols === 1) return op.at(0, 0);
  // Excel would intersect or compute an array here.
  return refuse('#VALUE!');
}

function toNumber(v: Cell): number | EvalError {
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  // Excel coerces numeric-looking text ("5", "1,000", "$5"); we refuse it as
  // a deviation. Text with no digit at all is #VALUE! in Excel too.
  if (typeof v === 'string') return /\p{Nd}/u.test(v) ? refuse('#VALUE!') : mkErr('#VALUE!');
  return v;
}

function toBool(v: Cell): boolean | EvalError {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const u = v.toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
    return mkErr('#VALUE!');
  }
  return v;
}

/** Excel shows and compares at 15 significant digits. */
function round15(n: number): number {
  return Number.isFinite(n) ? Number(n.toPrecision(15)) : n;
}

function formatNumber(n: number): string {
  return String(round15(n));
}

function toText(v: Cell): string | EvalError {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

/**
 * Excel returns 0 when an add/subtract cancels to within floating-point noise
 * of its operands (0.3-(0.1+0.2) = 0, not -5.55e-17).
 */
function snapCancellation(result: number, a: number, b: number): number {
  return Math.abs(result) < 2 ** -50 * Math.max(Math.abs(a), Math.abs(b)) ? 0 : result;
}

function finish(n: number): number | EvalError {
  if (!Number.isFinite(n)) return mkErr('#NUM!');
  return n === 0 ? 0 : n;
}

/** Excel ordering: numbers < text < booleans; text case-insensitive. */
function typeRank(v: number | string | boolean): number {
  return typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2;
}

function compareValues(a: number | string | boolean, b: number | string | boolean): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') {
    const x = round15(a);
    const y = round15(b);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x === y ? 0 : x < y ? -1 : 1;
  }
  return a === b ? 0 : a ? 1 : -1;
}

/** Comparison with Excel's handling of an empty operand. */
function compareCells(a: Cell, b: Cell): number | EvalError {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  if (a === null && b === null) return 0;
  const blankLike = (other: number | string | boolean) =>
    typeof other === 'number' ? 0 : typeof other === 'string' ? '' : false;
  const x = a === null ? blankLike(b as number | string | boolean) : a;
  const y = b === null ? blankLike(a as number | string | boolean) : b;
  return compareValues(x, y);
}

// ---------------------------------------------------------------- rounding

type RoundMode = 'half' | 'up' | 'down';

/**
 * Decimal rounding on the 15-significant-digit value Excel sees, so that
 * ROUND(1.005,2) = 1.01 although the double is 1.00499999999999989...
 * 'half' is half away from zero; 'up'/'down' are away from / toward zero.
 */
function roundDecimal(x: number, digits: number, mode: RoundMode): number | EvalError {
  if (x === 0) return 0;
  const n = Math.trunc(digits);
  const sign = x < 0 ? -1 : 1;
  const [mant, expText] = Math.abs(x).toExponential(14).split('e') as [string, string];
  const exp = Number(expText);
  const M = BigInt(mant.replace('.', ''));
  const p = exp - 14 + n;
  // Nothing to drop: return the 15-significant-digit value Excel works with.
  if (p >= 0) return finish(round15(x));
  const D = 10n ** BigInt(-p);
  let q = M / D;
  const r = M % D;
  if (mode === 'half' && 2n * r >= D) q += 1n;
  if (mode === 'up' && r > 0n) q += 1n;
  const result = sign * Number(`${q.toString()}e${-n}`);
  return finish(result);
}

// ---------------------------------------------------------------- criteria

function wildcardRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '~' && i + 1 < pattern.length) {
      re += escapeRegex(pattern[++i]!);
    } else if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else re += escapeRegex(ch);
  }
  return new RegExp(`^${re}$`, 'iu');
}

function escapeRegex(ch: string): string {
  return ch.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

const STRICT_DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?%?$/;

/**
 * Text that reads as a number in criteria and in COUNT's direct arguments: a
 * strict decimal with an optional exponent and trailing % (÷100). Anything
 * else — hex, padding, thousands separators — is text.
 */
function numericText(s: string): number | null {
  if (!STRICT_DECIMAL.test(s)) return null;
  const pct = s.endsWith('%');
  const n = Number(pct ? s.slice(0, -1) : s);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

type Criterion = (c: Cell) => boolean;

/** COUNTIF/SUMIF/SUMIFS criteria with Excel's operator prefixes and wildcards. */
function makeCriterion(crit: Cell): Criterion | EvalError {
  if (isErr(crit)) return crit;
  if (crit === null) crit = 0;
  if (typeof crit === 'number') {
    const n = round15(crit);
    return (c) => (typeof c === 'number' && round15(c) === n) || (typeof c === 'string' && numericText(c) !== null && round15(numericText(c)!) === n);
  }
  if (typeof crit === 'boolean') {
    const b = crit;
    return (c) => c === b;
  }
  let op = '=';
  let rest = crit;
  for (const candidate of ['>=', '<=', '<>', '>', '<', '=']) {
    if (crit.startsWith(candidate)) {
      op = candidate;
      rest = crit.slice(candidate.length);
      break;
    }
  }
  const num = numericText(rest);
  const test = (cmp: number): boolean => {
    switch (op) {
      case '>':
        return cmp > 0;
      case '>=':
        return cmp >= 0;
      case '<':
        return cmp < 0;
      case '<=':
        return cmp <= 0;
      default:
        return false;
    }
  };
  if (num !== null) {
    const n = round15(num);
    const eq: Criterion = (c) =>
      (typeof c === 'number' && round15(c) === n) || (typeof c === 'string' && numericText(c) !== null && round15(numericText(c)!) === n);
    if (op === '=') return eq;
    if (op === '<>') return (c) => !eq(c);
    return (c) => typeof c === 'number' && test(compareValues(c, n));
  }
  const upper = rest.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') {
    const b = upper === 'TRUE';
    if (op === '=') return (c) => c === b;
    if (op === '<>') return (c) => c !== b;
    return (c) => typeof c === 'boolean' && test(compareValues(c, b));
  }
  if (rest === '') {
    // "" matches empty cells and ="" results; "=" only truly empty cells;
    // "<>" every cell that holds anything, an ="" result included.
    if (crit === '') return (c) => c === null || c === '';
    if (op === '=') return (c) => c === null;
    if (op === '<>') return (c) => c !== null;
    return () => false;
  }
  if (op === '=' || op === '<>') {
    const re = wildcardRegex(rest);
    const eq: Criterion = (c) => typeof c === 'string' && re.test(c);
    return op === '=' ? eq : (c) => !eq(c);
  }
  return (c) => typeof c === 'string' && test(compareValues(c, rest));
}

// ---------------------------------------------------------------- lookups

function cellsOf(range: RangeOp): Cell[] {
  const out: Cell[] = [];
  for (let r = 0; r < range.rows; r++) for (let c = 0; c < range.cols; c++) out.push(range.at(r, c));
  return out;
}

/** -2: an approximate lookup over an unsorted column (a deviation, see docblock). */
const UNSORTED = -2;

/** Returns a 0-based index, -1 (not found) or UNSORTED. `type` is MATCH's match_type. */
function lookupIndex(values: Cell[], lookup: number | string | boolean, type: -1 | 0 | 1): number {
  if (type === 0) {
    if (typeof lookup === 'string') {
      const re = wildcardRegex(lookup);
      return values.findIndex((v) => typeof v === 'string' && re.test(v));
    }
    return values.findIndex((v) => v !== null && !isErr(v) && typeRank(v) === typeRank(lookup) && compareValues(v, lookup) === 0);
  }
  // Excel's binary search silently returns a wrong row on unsorted data; we
  // refuse instead. Order is by Excel type rank, then value.
  const present = values.filter((v): v is number | string | boolean => v !== null && !isErr(v));
  for (let i = 1; i < present.length; i++) {
    const cmp = compareValues(present[i - 1]!, present[i]!);
    if ((type === 1 && cmp > 0) || (type === -1 && cmp < 0)) return UNSORTED;
  }
  let found = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v === null || isErr(v) || typeRank(v) !== typeRank(lookup)) continue;
    const cmp = compareValues(v, lookup);
    if (type === 1) {
      if (cmp > 0) break;
      found = i;
    } else {
      if (cmp < 0) break;
      found = i;
    }
  }
  return found;
}

// ---------------------------------------------------------------- evaluator

interface SheetData {
  name: string;
  cells: Map<string, SheetCellInput>;
}

interface FormulaNode {
  sheet: number;
  at: CellAddress;
  key: string; // `${sheet}:${A1}`
  parsed: ParseResult;
}

class Workbook {
  readonly sheets: SheetData[];
  readonly nodes: FormulaNode[] = [];
  readonly nodeByKey = new Map<string, number>();
  readonly nodesBySheet: number[][];
  readonly values = new Map<number, EvalValue>();

  constructor(input: EvalSheet[]) {
    const seen = new Set<string>();
    this.sheets = input.map((s) => {
      const upper = s.name.toUpperCase();
      if (seen.has(upper)) throw new Error(`duplicate sheet name: ${s.name}`);
      seen.add(upper);
      return { name: s.name, cells: s.cells };
    });
    this.nodesBySheet = this.sheets.map(() => []);
    this.sheets.forEach((sheet, si) => {
      for (const [key, value] of sheet.cells) {
        const at = readCellKey(key);
        if (value !== null && typeof value === 'object') {
          const idx = this.nodes.length;
          this.nodes.push({ sheet: si, at, key: `${si}:${key}`, parsed: parseFormula(value.f) });
          this.nodeByKey.set(`${si}:${key}`, idx);
          this.nodesBySheet[si]!.push(idx);
        }
      }
    });
  }

  sheetIndex(name: string | null, current: number): number | null {
    if (name === null) return current;
    const i = this.sheets.findIndex((s) => sameSheetName(s.name, name));
    return i < 0 ? null : i;
  }

  /** Formula nodes this node reads, statically (untaken IF branches count). */
  deps(idx: number): number[] {
    const node = this.nodes[idx]!;
    if (!node.parsed.ok) return [];
    const out = new Set<number>();
    const walk = (n: FormulaAst): void => {
      switch (n.type) {
        case 'ref': {
          const si = this.sheetIndex(n.sheet, node.sheet);
          if (si === null) return;
          const dep = this.nodeByKey.get(`${si}:${formatAddress(n.at)}`);
          if (dep !== undefined) out.add(dep);
          return;
        }
        case 'range': {
          const si = this.sheetIndex(n.sheet, node.sheet);
          if (si === null) return;
          for (const dep of this.nodesBySheet[si]!) {
            const a = this.nodes[dep]!.at;
            if (a.col >= n.from.col && a.col <= n.to.col && a.row >= n.from.row && a.row <= n.to.row) out.add(dep);
          }
          return;
        }
        case 'unary':
        case 'percent':
          walk(n.arg);
          return;
        case 'binary':
          walk(n.left);
          walk(n.right);
          return;
        case 'call':
          n.args.forEach(walk);
          return;
        default:
          return;
      }
    };
    walk(node.parsed.ast);
    return [...out];
  }

  cell(sheet: number, col: number, row: number): Cell {
    const key = formatAddress({ col, row });
    const raw = this.sheets[sheet]!.cells.get(key);
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'object') {
      const idx = this.nodeByKey.get(`${sheet}:${key}`)!;
      const v = this.values.get(idx);
      if (v === undefined) throw new Error(`internal: formula ${key} read before evaluation`);
      return v;
    }
    if (typeof raw === 'number' && !Number.isFinite(raw)) return mkErr('#NUM!');
    return raw;
  }

  /**
   * Iterative Tarjan: SCCs come out dependencies-first, so evaluating in that
   * order never reads a formula that has not been computed. A multi-member SCC
   * or a self-loop is a cycle, and every member gets #CIRC!.
   */
  evaluateAll(): void {
    const n = this.nodes.length;
    const index = new Array<number>(n).fill(-1);
    const low = new Array<number>(n).fill(0);
    const onStack = new Array<boolean>(n).fill(false);
    const adj: number[][] = this.nodes.map((_, i) => this.deps(i));
    const stack: number[] = [];
    let counter = 0;

    for (let root = 0; root < n; root++) {
      if (index[root] !== -1) continue;
      const work: Array<{ v: number; edge: number }> = [{ v: root, edge: 0 }];
      index[root] = low[root] = counter++;
      stack.push(root);
      onStack[root] = true;
      while (work.length > 0) {
        const frame = work[work.length - 1]!;
        const edges = adj[frame.v]!;
        if (frame.edge < edges.length) {
          const w = edges[frame.edge++]!;
          if (index[w] === -1) {
            index[w] = low[w] = counter++;
            stack.push(w);
            onStack[w] = true;
            work.push({ v: w, edge: 0 });
          } else if (onStack[w]) {
            low[frame.v] = Math.min(low[frame.v]!, index[w]!);
          }
          continue;
        }
        work.pop();
        const v = frame.v;
        const parent = work[work.length - 1];
        if (parent) low[parent.v] = Math.min(low[parent.v]!, low[v]!);
        if (low[v] === index[v]) {
          const scc: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = false;
            scc.push(w);
          } while (w !== v);
          const cyclic = scc.length > 1 || adj[v]!.includes(v);
          for (const member of scc) {
            this.values.set(member, cyclic ? mkErr('#CIRC!') : this.evaluateNode(member));
          }
        }
      }
    }
  }

  private evaluateNode(idx: number): EvalValue {
    const node = this.nodes[idx]!;
    if (!node.parsed.ok) return refuse('#NAME?');
    const v = toScalar(this.eval(node.parsed.ast, node.sheet));
    if (v === null) return 0;
    if (typeof v === 'number') {
      const f = finish(v);
      return f;
    }
    return v;
  }

  private rangeOf(sheet: number, from: CellAddress, to: CellAddress): RangeOp {
    return {
      kind: 'range',
      rows: to.row - from.row + 1,
      cols: to.col - from.col + 1,
      at: (r, c) => this.cell(sheet, from.col + c, from.row + r),
    };
  }

  private eval(node: FormulaAst, sheet: number): Operand {
    switch (node.type) {
      case 'number':
        return node.value;
      case 'string':
        return node.value;
      case 'boolean':
        return node.value;
      case 'ref': {
        const si = this.sheetIndex(node.sheet, sheet);
        if (si === null) return mkErr('#REF!');
        return this.rangeOf(si, node.at, node.at);
      }
      case 'range': {
        const si = this.sheetIndex(node.sheet, sheet);
        if (si === null) return mkErr('#REF!');
        return this.rangeOf(si, node.from, node.to);
      }
      case 'unary': {
        const v = toNumber(toScalar(this.eval(node.arg, sheet)));
        if (isErr(v)) return v;
        return finish(node.op === '-' ? -v : v);
      }
      case 'percent': {
        const v = toNumber(toScalar(this.eval(node.arg, sheet)));
        if (isErr(v)) return v;
        return finish(v / 100);
      }
      case 'binary':
        return this.binary(node.op, toScalar(this.eval(node.left, sheet)), toScalar(this.eval(node.right, sheet)));
      case 'call':
        return this.call(node.name, node.args, sheet);
    }
  }

  private binary(op: BinaryOp, a: Cell, b: Cell): Operand {
    if (op === '&') {
      const x = toText(a);
      if (isErr(x)) return x;
      const y = toText(b);
      if (isErr(y)) return y;
      return x + y;
    }
    if (op === '=' || op === '<>' || op === '<' || op === '<=' || op === '>' || op === '>=') {
      const cmp = compareCells(a, b);
      if (isErr(cmp)) return cmp;
      switch (op) {
        case '=':
          return cmp === 0;
        case '<>':
          return cmp !== 0;
        case '<':
          return cmp < 0;
        case '<=':
          return cmp <= 0;
        case '>':
          return cmp > 0;
        default:
          return cmp >= 0;
      }
    }
    const x = toNumber(a);
    if (isErr(x)) return x;
    const y = toNumber(b);
    if (isErr(y)) return y;
    switch (op) {
      case '+':
        return finish(snapCancellation(x + y, x, y));
      case '-':
        return finish(snapCancellation(x - y, x, y));
      case '*':
        return finish(x * y);
      case '/':
        return y === 0 ? mkErr('#DIV/0!') : finish(x / y);
      default:
        if (x === 0 && y === 0) return mkErr('#NUM!');
        if (x === 0 && y < 0) return mkErr('#DIV/0!');
        return finish(Math.pow(x, y));
    }
  }

  private arg(args: FormulaAst[], i: number, sheet: number): Operand {
    return this.eval(args[i]!, sheet);
  }

  private scalarArg(args: FormulaAst[], i: number, sheet: number): Cell {
    return toScalar(this.arg(args, i, sheet));
  }

  private numberArg(args: FormulaAst[], i: number, sheet: number): number | EvalError {
    return toNumber(this.scalarArg(args, i, sheet));
  }

  /** SUM/AVERAGE/MIN/MAX: refs contribute numbers only; direct args coerce. */
  private collectNumbers(args: FormulaAst[], sheet: number): number[] | EvalError {
    const out: number[] = [];
    for (let i = 0; i < args.length; i++) {
      const op = this.arg(args, i, sheet);
      if (isRange(op)) {
        for (const c of cellsOf(op)) {
          if (isErr(c)) return c;
          if (typeof c === 'number') out.push(c);
        }
      } else {
        const n = toNumber(op);
        if (isErr(n)) return n;
        out.push(n);
      }
    }
    return out;
  }

  private rangeArg(args: FormulaAst[], i: number, sheet: number): RangeOp | EvalError {
    const op = this.arg(args, i, sheet);
    if (isRange(op)) return op;
    if (isErr(op)) return op;
    // Excel will not accept a non-range here at all.
    return refuse('#VALUE!');
  }

  private call(name: FormulaFunction, args: FormulaAst[], sheet: number): Operand {
    switch (name) {
      case 'SUM': {
        const ns = this.collectNumbers(args, sheet);
        return isErr(ns) ? ns : finish(ns.reduce((s, n) => s + n, 0));
      }
      case 'AVERAGE': {
        const ns = this.collectNumbers(args, sheet);
        if (isErr(ns)) return ns;
        if (ns.length === 0) return mkErr('#DIV/0!');
        return finish(ns.reduce((s, n) => s + n, 0) / ns.length);
      }
      case 'MIN':
      case 'MAX': {
        const ns = this.collectNumbers(args, sheet);
        if (isErr(ns)) return ns;
        if (ns.length === 0) return 0;
        // A loop, not Math.min(...ns): a 100k-cell range exceeds the spread limit.
        let best = ns[0]!;
        for (const v of ns) best = name === 'MIN' ? Math.min(best, v) : Math.max(best, v);
        return best;
      }
      case 'ROUND':
      case 'ROUNDUP':
      case 'ROUNDDOWN': {
        const x = this.numberArg(args, 0, sheet);
        if (isErr(x)) return x;
        const d = this.numberArg(args, 1, sheet);
        if (isErr(d)) return d;
        return roundDecimal(x, d, name === 'ROUND' ? 'half' : name === 'ROUNDUP' ? 'up' : 'down');
      }
      case 'ABS': {
        const x = this.numberArg(args, 0, sheet);
        return isErr(x) ? x : Math.abs(x);
      }
      case 'IF': {
        const cond = toBool(this.scalarArg(args, 0, sheet));
        if (isErr(cond)) return cond;
        if (cond) return this.arg(args, 1, sheet);
        return args.length > 2 ? this.arg(args, 2, sheet) : false;
      }
      case 'IFERROR': {
        const v = this.arg(args, 0, sheet);
        // A multi-cell range would be an array in Excel 365; we refuse the
        // shape with an error IFERROR itself does not swallow.
        if (isRange(v) && (v.rows !== 1 || v.cols !== 1)) return refuse('#VALUE!');
        const s = toScalar(v);
        // A cycle is never rescued into a number, nor is a refused shape.
        if (isErr(s) && (s.error === '#CIRC!' || UNCATCHABLE.has(s))) return s;
        return isErr(s) ? this.arg(args, 1, sheet) : v;
      }
      case 'AND':
      case 'OR': {
        let seen = 0;
        let all = true;
        let any = false;
        for (let i = 0; i < args.length; i++) {
          const op = this.arg(args, i, sheet);
          const bools: boolean[] = [];
          if (isRange(op)) {
            for (const c of cellsOf(op)) {
              if (isErr(c)) return c;
              if (typeof c === 'boolean') bools.push(c);
              else if (typeof c === 'number') bools.push(c !== 0);
            }
          } else {
            const b = toBool(op);
            if (isErr(b)) return b;
            bools.push(b);
          }
          for (const b of bools) {
            seen++;
            all &&= b;
            any ||= b;
          }
        }
        if (seen === 0) return mkErr('#VALUE!');
        return name === 'AND' ? all : any;
      }
      case 'COUNT':
      case 'COUNTA': {
        let count = 0;
        for (let i = 0; i < args.length; i++) {
          const op = this.arg(args, i, sheet);
          const values = isRange(op) ? cellsOf(op) : [op];
          const direct = !isRange(op);
          for (const c of values) {
            if (name === 'COUNTA') {
              if (c !== null) count++;
            } else if (
              typeof c === 'number' ||
              (direct && (typeof c === 'boolean' || (typeof c === 'string' && numericText(c) !== null)))
            ) {
              count++;
            }
          }
        }
        return count;
      }
      case 'COUNTIF': {
        const range = this.rangeArg(args, 0, sheet);
        if (isErr(range)) return range;
        const crit = makeCriterion(this.scalarArg(args, 1, sheet));
        if (isErr(crit)) return crit;
        return cellsOf(range).filter(crit).length;
      }
      case 'SUMIF': {
        const range = this.rangeArg(args, 0, sheet);
        if (isErr(range)) return range;
        const crit = makeCriterion(this.scalarArg(args, 1, sheet));
        if (isErr(crit)) return crit;
        const sumRange = args.length > 2 ? this.rangeArg(args, 2, sheet) : range;
        if (isErr(sumRange)) return sumRange;
        // Excel resizes SUMIF's sum_range; we refuse a different shape.
        if (sumRange.rows !== range.rows || sumRange.cols !== range.cols) return refuse('#VALUE!');
        return this.conditionalSum(sumRange, [[range, crit]]);
      }
      case 'SUMIFS': {
        const sumRange = this.rangeArg(args, 0, sheet);
        if (isErr(sumRange)) return sumRange;
        const pairs: Array<[RangeOp, Criterion]> = [];
        for (let i = 1; i < args.length; i += 2) {
          const range = this.rangeArg(args, i, sheet);
          if (isErr(range)) return range;
          const crit = makeCriterion(this.scalarArg(args, i + 1, sheet));
          if (isErr(crit)) return crit;
          pairs.push([range, crit]);
        }
        return this.conditionalSum(sumRange, pairs);
      }
      case 'SUMPRODUCT': {
        const ranges: RangeOp[] = [];
        for (let i = 0; i < args.length; i++) {
          const op = this.arg(args, i, sheet);
          if (isErr(op)) return op;
          ranges.push(isRange(op) ? op : scalarRange(op));
        }
        const first = ranges[0]!;
        if (ranges.some((r) => r.rows !== first.rows || r.cols !== first.cols)) return mkErr('#VALUE!');
        let total = 0;
        for (let r = 0; r < first.rows; r++) {
          for (let c = 0; c < first.cols; c++) {
            let product = 1;
            for (const range of ranges) {
              const v = range.at(r, c);
              if (isErr(v)) return v;
              product *= typeof v === 'number' ? v : 0;
            }
            total += product;
          }
        }
        return finish(total);
      }
      case 'INDEX': {
        const op = this.arg(args, 0, sheet);
        if (isErr(op)) return op;
        const range = isRange(op) ? op : scalarRange(op);
        const a = this.numberArg(args, 1, sheet);
        if (isErr(a)) return a;
        let row: number;
        let col: number;
        if (args.length > 2) {
          const b = this.numberArg(args, 2, sheet);
          if (isErr(b)) return b;
          row = Math.trunc(a);
          col = Math.trunc(b);
        } else if (range.rows === 1) {
          row = 1;
          col = Math.trunc(a);
        } else if (range.cols === 1) {
          row = Math.trunc(a);
          col = 1;
        } else {
          // Excel returns the whole row as an array.
          return refuse('#VALUE!');
        }
        if (row < 0 || col < 0) return mkErr('#VALUE!');
        if (row === 0) {
          if (range.rows !== 1) return refuse('#VALUE!');
          row = 1;
        }
        if (col === 0) {
          if (range.cols !== 1) return refuse('#VALUE!');
          col = 1;
        }
        if (row > range.rows || col > range.cols) return mkErr('#REF!');
        const value = range.at(row - 1, col - 1);
        return scalarRange(value);
      }
      case 'MATCH': {
        const lookup = this.scalarArg(args, 0, sheet);
        if (isErr(lookup)) return lookup;
        if (lookup === null) return mkErr('#N/A');
        const range = this.rangeArg(args, 1, sheet);
        if (isErr(range)) return range;
        if (range.rows !== 1 && range.cols !== 1) return mkErr('#N/A');
        let type: -1 | 0 | 1 = 1;
        if (args.length > 2) {
          const t = this.numberArg(args, 2, sheet);
          if (isErr(t)) return t;
          type = t > 0 ? 1 : t < 0 ? -1 : 0;
        }
        const i = lookupIndex(cellsOf(range), lookup, type);
        if (i === UNSORTED) return refuse('#N/A');
        return i < 0 ? mkErr('#N/A') : i + 1;
      }
      case 'VLOOKUP': {
        const lookup = this.scalarArg(args, 0, sheet);
        if (isErr(lookup)) return lookup;
        if (lookup === null) return mkErr('#N/A');
        const table = this.rangeArg(args, 1, sheet);
        if (isErr(table)) return table;
        const colNum = this.numberArg(args, 2, sheet);
        if (isErr(colNum)) return colNum;
        const col = Math.trunc(colNum);
        let approx = true;
        if (args.length > 3) {
          const b = toBool(this.scalarArg(args, 3, sheet));
          if (isErr(b)) return b;
          approx = b;
        }
        if (col < 1) return mkErr('#VALUE!');
        if (col > table.cols) return mkErr('#REF!');
        const firstColumn: Cell[] = [];
        for (let r = 0; r < table.rows; r++) firstColumn.push(table.at(r, 0));
        const i = lookupIndex(firstColumn, lookup, approx ? 1 : 0);
        // A value, not a reference (unlike INDEX).
        if (i === UNSORTED) return refuse('#N/A');
        return i < 0 ? mkErr('#N/A') : table.at(i, col - 1);
      }
    }
  }

  private conditionalSum(sumRange: RangeOp, pairs: Array<[RangeOp, Criterion]>): number | EvalError {
    if (pairs.some(([r]) => r.rows !== sumRange.rows || r.cols !== sumRange.cols)) return mkErr('#VALUE!');
    let total = 0;
    for (let r = 0; r < sumRange.rows; r++) {
      for (let c = 0; c < sumRange.cols; c++) {
        if (!pairs.every(([range, crit]) => crit(range.at(r, c)))) continue;
        const v = sumRange.at(r, c);
        if (isErr(v)) return v;
        if (typeof v === 'number') total += v;
      }
    }
    return finish(total);
  }

  results(): Map<string, EvalValue> {
    const out = new Map<string, EvalValue>();
    this.sheets.forEach((sheet, si) => {
      for (const [key, raw] of sheet.cells) {
        if (raw === null) continue;
        const at = readCellKey(key);
        const v = this.cell(si, at.col, at.row);
        if (v !== null) out.set(`${sheet.name}!${key}`, v);
      }
    });
    return out;
  }
}

/**
 * Evaluates every formula of a workbook with Excel semantics. The result
 * holds every non-empty cell — literal or formula — keyed `Sheet!A1` with the
 * sheet name unquoted. A cycle yields #CIRC! on every member; a formula that
 * does not parse yields #NAME?. Throws only on a caller bug (malformed key,
 * duplicate sheet name).
 */
export function evaluateWorkbook(sheets: EvalSheet[]): Map<string, EvalValue> {
  const wb = new Workbook(sheets);
  wb.evaluateAll();
  return wb.results();
}
