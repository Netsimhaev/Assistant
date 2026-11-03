import { describe, expect, it } from 'vitest';
import {
  FORMULA_FUNCTIONS,
  evaluateWorkbook,
  parseFormula,
  referencedCells,
  type EvalSheet,
  type EvalValue,
  type SheetCellInput,
} from './formula.js';

type Cells = Record<string, SheetCellInput>;

function sheet(name: string, cells: Cells): EvalSheet {
  return { name, cells: new Map(Object.entries(cells)) };
}

/** Evaluates `f` in cell ZZ1 of a sheet named S, beside `cells`. */
function calc(f: string, cells: Cells = {}): EvalValue | undefined {
  const result = evaluateWorkbook([sheet('S', { ...cells, ZZ1: { f } })]);
  return result.get('S!ZZ1');
}

const err = (error: string) => ({ error });

function problemOf(src: string): string {
  const parsed = parseFormula(src);
  if (parsed.ok) throw new Error(`expected a problem for ${src}`);
  return parsed.problem.kind;
}

describe('parseFormula', () => {
  it('INDIRECT("A1") → unknown_function, naming the function', () => {
    const parsed = parseFormula('INDIRECT("A1")');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.kind).toBe('unknown_function');
    expect(parsed.problem.detail).toContain('INDIRECT');
  });

  it.each(['OFFSET(A1,1,1)', 'HYPERLINK("x")', 'WEBSERVICE("http://x")', 'CALL("x")', 'NOW()', 'sum2(A1)'])(
    '%s → unknown_function',
    (src) => {
      expect(problemOf(src)).toBe('unknown_function');
    },
  );

  it('[Book2]Sheet1!A1 → external_reference', () => {
    expect(problemOf('[Book2]Sheet1!A1')).toBe('external_reference');
    expect(problemOf("'[Book2]Sheet1'!A1+1")).toBe('external_reference');
    expect(problemOf('SUM([1]Sheet1!A1:A3)')).toBe('external_reference');
  });

  it('Total (defined name) → defined_name', () => {
    const parsed = parseFormula('Total*2');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.kind).toBe('defined_name');
    expect(parsed.problem.detail).toContain('Total');
    expect(problemOf('Sheet1!Total')).toBe('defined_name');
    // Beyond the grid is a name in Excel, not a cell.
    expect(problemOf('XFE1')).toBe('defined_name');
  });

  it.each([
    '',
    '1+',
    '(1',
    '1)',
    'SUM(1,)',
    'ROUND(1)',
    'IF(1)',
    'A:A',
    '1:1',
    '{1,2}',
    'A1:1',
    'Sheet1:Sheet3!A1',
    '=1',
    '"unterminated',
    'A1:XFD1048576',
  ])('%j → syntax', (src) => {
    expect(problemOf(src)).toBe('syntax');
  });

  it('accepts the grammar', () => {
    for (const src of [
      '1+2*3-4/5^2',
      '-A1%',
      '"a"&"b"',
      'A1<>B1',
      'A1<=B1',
      'A1>=B1',
      '$A$1+A$2+$B3',
      "'גיליון 1'!A1",
      'Sheet1!A1:B2',
      'sum(a1:a3)',
      'TRUE',
      'IF(A1>0,"כן","לא")',
      '1.5e3+.5',
    ]) {
      const parsed = parseFormula(src);
      expect(parsed.ok, src).toBe(true);
    }
  });

  it('rejects a formula longer than Excel allows', () => {
    expect(problemOf('1+'.repeat(5000) + '1')).toBe('syntax');
  });

  it('rejects absurd nesting instead of overflowing the stack', () => {
    expect(problemOf('('.repeat(200) + '1' + ')'.repeat(200))).toBe('syntax');
    expect(problemOf('-'.repeat(200) + '1')).toBe('syntax');
  });
});

describe('referencedCells', () => {
  it('lists refs and expands ranges, sheet-qualified where written', () => {
    const parsed = parseFormula("SUM(A1:B2)+'גיליון 1'!C3+$A$1");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(referencedCells(parsed.ast)).toEqual(['A1', 'B1', 'A2', 'B2', 'גיליון 1!C3']);
  });
});

describe('evaluateWorkbook — required cases', () => {
  it('SUM over a range with an empty cell = sum of the rest', () => {
    expect(calc('SUM(A1:A4)', { A1: 1, A2: null, A4: 5 })).toBe(6);
  });

  it('A1/B1 with B1=0 → #DIV/0!', () => {
    expect(calc('A1/B1', { A1: 4, B1: 0 })).toEqual(err('#DIV/0!'));
    // An empty divisor is 0 too.
    expect(calc('A1/B1', { A1: 4 })).toEqual(err('#DIV/0!'));
  });

  it('A1 = A1+1 → #CIRC!', () => {
    const result = evaluateWorkbook([sheet('S', { A1: { f: 'A1+1' } })]);
    expect(result.get('S!A1')).toEqual(err('#CIRC!'));
  });

  it('a cycle yields #CIRC! on every member, and only on them', () => {
    const result = evaluateWorkbook([
      sheet('S', { A1: { f: 'B1+1' }, B1: { f: 'C1+1' }, C1: { f: 'A1+1' }, D1: 5, E1: { f: 'D1*2' } }),
    ]);
    expect(result.get('S!A1')).toEqual(err('#CIRC!'));
    expect(result.get('S!B1')).toEqual(err('#CIRC!'));
    expect(result.get('S!C1')).toEqual(err('#CIRC!'));
    expect(result.get('S!E1')).toBe(10);
  });

  it('a cycle through a range is a cycle', () => {
    const result = evaluateWorkbook([sheet('S', { A1: 1, A2: { f: 'SUM(A1:A3)' } })]);
    expect(result.get('S!A2')).toEqual(err('#CIRC!'));
  });

  it('IFERROR(1/0, 7) = 7', () => {
    expect(calc('IFERROR(1/0, 7)')).toBe(7);
  });

  it('ROUND(2.345, 2) = 2.35, ROUND(-2.5,0) = -3', () => {
    expect(calc('ROUND(2.345, 2)')).toBe(2.35);
    expect(calc('ROUND(-2.5,0)')).toBe(-3);
    expect(calc('ROUND(1.005,2)')).toBe(1.01);
    expect(calc('ROUND(2.5,0)')).toBe(3);
    expect(calc('ROUND(1234.5,-2)')).toBe(1200);
    expect(calc('ROUND(0.1+0.2,15)')).toBe(0.3);
  });

  it('VLOOKUP exact match and #N/A', () => {
    const cells = { A1: 'תפוח', B1: 3, A2: 'אגס', B2: 7, A3: 'בננה', B3: 9 };
    expect(calc('VLOOKUP("אגס",A1:B3,2,FALSE)', cells)).toBe(7);
    expect(calc('VLOOKUP("שזיף",A1:B3,2,FALSE)', cells)).toEqual(err('#N/A'));
  });

  it('SUMIFS with two criteria', () => {
    const cells = {
      A1: 'צפון', B1: 'א', C1: 10,
      A2: 'צפון', B2: 'ב', C2: 20,
      A3: 'דרום', B3: 'א', C3: 40,
      A4: 'צפון', B4: 'א', C4: 80,
    };
    expect(calc('SUMIFS(C1:C4,A1:A4,"צפון",B1:B4,"א")', cells)).toBe(90);
  });

  it('cross-sheet ref with a Hebrew sheet name in quotes', () => {
    const result = evaluateWorkbook([
      sheet('גיליון 1', { A1: 41 }),
      sheet('סיכום', { A1: { f: "'גיליון 1'!A1+1" } }),
    ]);
    expect(result.get('סיכום!A1')).toBe(42);
  });

  it('a ref to a sheet that does not exist → #REF!', () => {
    expect(calc("'אין כזה'!A1+1")).toEqual(err('#REF!'));
  });
});

describe('evaluateWorkbook — Excel semantics', () => {
  it('operator precedence, unary minus before ^, ^ left-associative, %', () => {
    expect(calc('1+2*3')).toBe(7);
    expect(calc('-2^2')).toBe(4);
    expect(calc('2^3^2')).toBe(64);
    expect(calc('50%*4')).toBe(2);
    expect(calc('1+2&"x"')).toBe('3x');
    expect(calc('1+1=2')).toBe(true);
  });

  it('empty cells are 0 in arithmetic, "" in text, and a bare ref to one is 0', () => {
    expect(calc('A1+1')).toBe(1);
    expect(calc('A1&"x"')).toBe('x');
    expect(calc('A1')).toBe(0);
    expect(calc('A1=0')).toBe(true);
    expect(calc('A1=""')).toBe(true);
  });

  it('booleans coerce to 1/0 in arithmetic; text is #VALUE!', () => {
    expect(calc('TRUE+1')).toBe(2);
    expect(calc('A1+1', { A1: '5' })).toEqual(err('#VALUE!'));
    expect(calc('"a"*2')).toEqual(err('#VALUE!'));
  });

  it('SUM over a range ignores text and booleans; literal text args error', () => {
    expect(calc('SUM(A1:A3)', { A1: 1, A2: 'x', A3: true })).toBe(1);
    expect(calc('SUM(1,TRUE)')).toBe(2);
    expect(calc('SUM("x")')).toEqual(err('#VALUE!'));
  });

  it('the first error in an operand propagates', () => {
    expect(calc('A1+B1', { A1: { f: '1/0' }, B1: { f: '"a"*1' } })).toEqual(err('#DIV/0!'));
    expect(calc('SUM(A1:A2)', { A1: 1, A2: { f: '1/0' } })).toEqual(err('#DIV/0!'));
  });

  it('comparison: case-insensitive text, numbers before text before booleans', () => {
    expect(calc('"abc"="ABC"')).toBe(true);
    expect(calc('1<"a"')).toBe(true);
    expect(calc('"z"<TRUE')).toBe(true);
    expect(calc('0.1+0.2=0.3')).toBe(true);
  });

  it('formula chains evaluate in dependency order, across a long chain', () => {
    const cells: Cells = { A1: 1 };
    for (let r = 2; r <= 3000; r++) cells[`A${r}`] = { f: `A${r - 1}+1` };
    const result = evaluateWorkbook([sheet('S', cells)]);
    expect(result.get('S!A3000')).toBe(3000);
  });

  it('a formula that does not parse evaluates to #NAME?, it does not throw', () => {
    expect(calc('INDIRECT("A1")')).toEqual(err('#NAME?'));
  });

  it('literal cells appear in the result, empty ones do not', () => {
    const result = evaluateWorkbook([sheet('S', { A1: 3, A2: 'x', A3: null })]);
    expect(result.get('S!A1')).toBe(3);
    expect(result.get('S!A2')).toBe('x');
    expect(result.has('S!A3')).toBe(false);
  });

  it('rejects a malformed cell key and duplicate sheet names loudly', () => {
    expect(() => evaluateWorkbook([sheet('S', { a1: 1 })])).toThrow();
    expect(() => evaluateWorkbook([sheet('S', {}), sheet('s', {})])).toThrow();
  });
});

/**
 * One evaluating case per whitelisted function, at least. The invariant
 * below iterates the exported list, so adding a function without a case
 * here fails by name.
 */
const FUNCTION_CASES: Array<{ fn: string; f: string; expect: EvalValue; cells?: Cells }> = [
  { fn: 'SUM', f: 'SUM(A1:A3,10)', cells: { A1: 1, A2: 2, A3: 3 }, expect: 16 },
  { fn: 'AVERAGE', f: 'AVERAGE(A1:A4)', cells: { A1: 2, A2: 4, A3: 'x' }, expect: 3 },
  { fn: 'AVERAGE', f: 'AVERAGE(A1:A2)', expect: err('#DIV/0!') as EvalValue },
  { fn: 'MIN', f: 'MIN(A1:A3)', cells: { A1: 5, A2: -2, A3: 9 }, expect: -2 },
  { fn: 'MAX', f: 'MAX(A1:A3,20)', cells: { A1: 5, A2: -2, A3: 9 }, expect: 20 },
  { fn: 'MAX', f: 'MAX(A1:A3)', expect: 0 },
  { fn: 'ROUND', f: 'ROUND(-1.005,2)', expect: -1.01 },
  { fn: 'ROUNDUP', f: 'ROUNDUP(3.21,1)', expect: 3.3 },
  { fn: 'ROUNDUP', f: 'ROUNDUP(-3.2,0)', expect: -4 },
  { fn: 'ROUNDDOWN', f: 'ROUNDDOWN(-3.79,1)', expect: -3.7 },
  { fn: 'ROUNDDOWN', f: 'ROUNDDOWN(1999,-3)', expect: 1000 },
  { fn: 'IF', f: 'IF(A1>10,"גדול","קטן")', cells: { A1: 11 }, expect: 'גדול' },
  { fn: 'IF', f: 'IF(A1>10,1/0,2)', cells: { A1: 1 }, expect: 2 },
  { fn: 'IF', f: 'IF(FALSE,1)', expect: false },
  { fn: 'IFERROR', f: 'IFERROR(A1*2,0)', cells: { A1: 4 }, expect: 8 },
  { fn: 'AND', f: 'AND(TRUE,A1>0)', cells: { A1: 1 }, expect: true },
  { fn: 'AND', f: 'AND(A1:A2)', cells: { A1: true, A2: 0 }, expect: false },
  { fn: 'OR', f: 'OR(FALSE,A1>0)', cells: { A1: 0 }, expect: false },
  { fn: 'OR', f: 'OR(A1:A2)', cells: { A1: 'x', A2: 1 }, expect: true },
  { fn: 'COUNT', f: 'COUNT(A1:A5)', cells: { A1: 1, A2: 'x', A3: true, A5: 2.5 }, expect: 2 },
  { fn: 'COUNTA', f: 'COUNTA(A1:A5)', cells: { A1: 1, A2: 'x', A3: true, A5: 2.5 }, expect: 4 },
  { fn: 'COUNTIF', f: 'COUNTIF(A1:A4,">2")', cells: { A1: 1, A2: 3, A3: 5, A4: 'x' }, expect: 2 },
  { fn: 'COUNTIF', f: 'COUNTIF(A1:A3,"ת*")', cells: { A1: 'תפוח', A2: 'תמר', A3: 'אגס' }, expect: 2 },
  { fn: 'COUNTIF', f: 'COUNTIF(A1:A3,"<>")', cells: { A1: 1, A3: 'x' }, expect: 2 },
  { fn: 'SUMIF', f: 'SUMIF(A1:A3,"x",B1:B3)', cells: { A1: 'x', B1: 1, A2: 'y', B2: 2, A3: 'X', B3: 4 }, expect: 5 },
  { fn: 'SUMIF', f: 'SUMIF(A1:A3,">=2")', cells: { A1: 1, A2: 2, A3: 3 }, expect: 5 },
  { fn: 'SUMIFS', f: 'SUMIFS(C1:C2,A1:A2,"a",B1:B2,">1")', cells: { A1: 'a', B1: 2, C1: 7, A2: 'a', B2: 1, C2: 9 }, expect: 7 },
  { fn: 'SUMIFS', f: 'SUMIFS(C1:C2,A1:A3,"a")', expect: err('#VALUE!') as EvalValue },
  { fn: 'SUMPRODUCT', f: 'SUMPRODUCT(A1:A3,B1:B3)', cells: { A1: 1, A2: 2, A3: 3, B1: 4, B2: 5, B3: 6 }, expect: 32 },
  { fn: 'SUMPRODUCT', f: 'SUMPRODUCT(A1:A2,B1:B3)', expect: err('#VALUE!') as EvalValue },
  { fn: 'ABS', f: 'ABS(-3.5)', expect: 3.5 },
  { fn: 'INDEX', f: 'INDEX(A1:B2,2,2)', cells: { A1: 1, B1: 2, A2: 3, B2: 4 }, expect: 4 },
  { fn: 'INDEX', f: 'INDEX(A1:C1,3)', cells: { A1: 1, B1: 2, C1: 3 }, expect: 3 },
  { fn: 'INDEX', f: 'INDEX(A1:B2,3,1)', expect: err('#REF!') as EvalValue },
  { fn: 'MATCH', f: 'MATCH("b",A1:A3,0)', cells: { A1: 'a', A2: 'B', A3: 'c' }, expect: 2 },
  { fn: 'MATCH', f: 'MATCH(25,A1:A3)', cells: { A1: 10, A2: 20, A3: 30 }, expect: 2 },
  { fn: 'MATCH', f: 'MATCH(5,A1:A3)', cells: { A1: 10, A2: 20, A3: 30 }, expect: err('#N/A') as EvalValue },
  { fn: 'MATCH', f: 'MATCH(25,A1:A3,-1)', cells: { A1: 30, A2: 20, A3: 10 }, expect: 1 },
  { fn: 'VLOOKUP', f: 'VLOOKUP(25,A1:B3,2)', cells: { A1: 10, B1: 'a', A2: 20, B2: 'b', A3: 30, B3: 'c' }, expect: 'b' },
  { fn: 'VLOOKUP', f: 'VLOOKUP(10,A1:B3,3,FALSE)', cells: { A1: 10, B1: 'a' }, expect: err('#REF!') as EvalValue },
];

describe('every whitelisted function evaluates', () => {
  it.each(FUNCTION_CASES.map((c) => [c.f, c] as const))('%s', (_label, c) => {
    expect(calc(c.f, c.cells)).toEqual(c.expect);
  });

  it('every name in FORMULA_FUNCTIONS has at least one evaluating test', () => {
    expect(FORMULA_FUNCTIONS.length).toBe(21);
    for (const fn of FORMULA_FUNCTIONS) {
      const cases = FUNCTION_CASES.filter((c) => c.fn === fn);
      expect(cases.length, `no evaluating case for ${fn}`).toBeGreaterThan(0);
      // The case must really call the function, not just carry its label.
      for (const c of cases) expect(c.f.startsWith(`${fn}(`), c.f).toBe(true);
    }
  });
});

describe('large ranges', () => {
  it('MAX over the largest allowed range does not overflow', () => {
    const cells: Cells = { A1: 3, A99999: 8 };
    expect(calc('MAX(A1:A100000)', cells)).toBe(8);
    expect(calc('MIN(A1:A100000)', cells)).toBe(3);
  });
});

describe('fix round 1 — no plausible wrong number', () => {
  it('IFERROR over a multi-cell range refuses the shape with an uncaught #VALUE!', () => {
    const cells = { A1: 1, A2: 2, A3: 3 };
    expect(calc('SUM(IFERROR(A1:A3,0))', cells)).toEqual(err('#VALUE!'));
    expect(calc('IFERROR(IFERROR(A1:A3,0),5)', cells)).toEqual(err('#VALUE!'));
    // A single-cell ref still works and is still caught.
    expect(calc('IFERROR(A1,0)', cells)).toBe(1);
  });

  it('IFERROR does not rescue a cycle into a number', () => {
    const result = evaluateWorkbook([sheet('S', { A1: { f: 'A1+1' }, B1: { f: 'IFERROR(A1,0)' } })]);
    expect(result.get('S!A1')).toEqual(err('#CIRC!'));
    expect(result.get('S!B1')).toEqual(err('#CIRC!'));
  });

  it('VLOOKUP returns a value, not a reference: TRUE → 1, text → #VALUE! under SUM', () => {
    const cells = { A1: 'a', B1: true, A2: 'b', B2: 'טקסט' };
    expect(calc('SUM(VLOOKUP("a",A1:B2,2,FALSE))', cells)).toBe(1);
    expect(calc('SUM(VLOOKUP("b",A1:B2,2,FALSE))', cells)).toEqual(err('#VALUE!'));
  });

  it('INDEX stays a reference: SUM ignores the text/boolean it points at', () => {
    const cells = { A1: true, A2: 'טקסט' };
    expect(calc('SUM(INDEX(A1:A2,1))', cells)).toBe(0);
    expect(calc('SUM(INDEX(A1:A2,2))', cells)).toBe(0);
  });

  it('criteria numbers are strict decimals; % divides by 100', () => {
    const cells = { A1: 0.4, A2: 0.6, A3: 16 };
    expect(calc('COUNTIF(A1:A3,">50%")', { A1: 0.4, A2: 0.6 })).toBe(1);
    expect(calc('COUNTIF(A1:A2,">50%")', { A1: 0.4, A2: 0.6 })).toBe(1);
    expect(calc('SUMIF(A1:A2,">50%")', { A1: 0.4, A2: 0.6 })).toBe(0.6);
    expect(calc('COUNTIF(A1:A3,">0x10")', cells)).toBe(0);
    expect(calc('COUNTIF(A1:A3,"= 16")', cells)).toBe(0);
    expect(calc('COUNTIF(A1:A3,"1,000")', { A1: 1000 })).toBe(0);
    expect(calc('COUNTIF(A1:A3,">=1e1")', cells)).toBe(1);
  });

  it('add/subtract cancellation snaps to 0 like Excel', () => {
    expect(calc('0.3-(0.1+0.2)')).toBe(0);
    const result = evaluateWorkbook([sheet('S', { C1: { f: '0.3-(0.1+0.2)' }, D1: { f: 'C1=0' } })]);
    expect(result.get('S!D1')).toBe(true);
    // A genuinely small difference is not snapped.
    expect(calc('1e-20-0')).toBe(1e-20);
  });

  it('approximate MATCH/VLOOKUP on an unsorted column → #N/A', () => {
    const unsorted = { A1: 10, B1: 'a', A2: 30, B2: 'b', A3: 20, B3: 'c' };
    expect(calc('MATCH(25,A1:A3)', unsorted)).toEqual(err('#N/A'));
    expect(calc('VLOOKUP(25,A1:B3,2)', unsorted)).toEqual(err('#N/A'));
    expect(calc('MATCH(25,A1:A3,-1)', { A1: 10, A2: 30, A3: 20 })).toEqual(err('#N/A'));
    // Sorted still works (control).
    expect(calc('MATCH(25,A1:A3)', { A1: 10, A2: 20, A3: 30 })).toBe(2);
    // Exact match does not need sorting.
    expect(calc('MATCH(20,A1:A3,0)', unsorted)).toBe(3);
  });

  it('COUNT counts numeric text passed directly', () => {
    expect(calc('COUNT("5",1)')).toBe(2);
    expect(calc('COUNT("x",1)')).toBe(1);
    // In a range, numeric text is still not counted.
    expect(calc('COUNT(A1:A2)', { A1: '5', A2: 1 })).toBe(1);
  });

  it('"<>" counts ="" formula cells; "=" matches truly empty only; "" matches both', () => {
    const cells = { A1: { f: '""' }, A2: null, A3: 'x' };
    expect(calc('COUNTIF(A1:A4,"<>")', cells)).toBe(2);
    expect(calc('COUNTIF(A1:A4,"=")', cells)).toBe(2); // A2 and A4 are truly empty
    expect(calc('COUNTIF(A1:A4,"")', cells)).toBe(3);
  });
});

describe('fix round 2 — IFERROR never launders a deviation error', () => {
  const nums = { A1: 1, A2: 2, A3: 3, B1: 4, B2: 5, B3: 6 };

  it('multi-cell range in scalar context', () => {
    expect(calc('SUM(IFERROR(A1:A3*1,0))', nums)).toEqual(err('#VALUE!'));
    expect(calc('IFERROR(ABS(A1:A3),0)', nums)).toEqual(err('#VALUE!'));
  });

  it('SUMPRODUCT array arithmetic', () => {
    expect(calc('IFERROR(SUMPRODUCT((A1:A3>1)*B1:B3),0)', nums)).toEqual(err('#VALUE!'));
  });

  it('numeric-looking text in arithmetic, literal and via a cell', () => {
    expect(calc('IFERROR("5"+1,0)')).toEqual(err('#VALUE!'));
    expect(calc('IFERROR(A1+1,0)', { A1: '5' })).toEqual(err('#VALUE!'));
    // Where Excel itself errors, IFERROR still catches (control).
    expect(calc('IFERROR("a"*2,0)')).toBe(0);
  });

  it('IFERROR over a multi-cell range (already uncatchable)', () => {
    expect(calc('IFERROR(IFERROR(A1:A3,0),9)', nums)).toEqual(err('#VALUE!'));
  });

  it('SUMIF sum-range shape mismatch', () => {
    expect(calc('IFERROR(SUMIF(A1:A3,">0",B1:B2),0)', nums)).toEqual(err('#VALUE!'));
    // SUMIFS mismatch is an Excel error, so it stays catchable (control).
    expect(calc('IFERROR(SUMIFS(B1:B2,A1:A3,">0"),0)', nums)).toBe(0);
  });

  it('unsorted approximate MATCH/VLOOKUP', () => {
    const unsorted = { A1: 10, B1: 'a', A2: 30, B2: 'b', A3: 20, B3: 'c' };
    expect(calc('IFERROR(MATCH(25,A1:A3),0)', unsorted)).toEqual(err('#N/A'));
    expect(calc('IFERROR(VLOOKUP(25,A1:B3,2),"x")', unsorted)).toEqual(err('#N/A'));
    // A genuine not-found on sorted data is an Excel #N/A and stays catchable.
    expect(calc('IFERROR(MATCH(5,A1:A3),0)', { A1: 10, A2: 20, A3: 30 })).toBe(0);
  });

  it('INDEX asked for a whole row/column of a 2-D range', () => {
    expect(calc('IFERROR(INDEX(A1:B3,2),0)', nums)).toEqual(err('#VALUE!'));
    expect(calc('IFERROR(INDEX(A1:B3,0,1),0)', nums)).toEqual(err('#VALUE!'));
  });

  it('a formula that does not parse (#NAME?)', () => {
    const result = evaluateWorkbook([sheet('S', { A1: { f: 'INDIRECT("B1")' }, C1: { f: 'IFERROR(A1,0)' } })]);
    expect(result.get('S!C1')).toEqual(err('#NAME?'));
  });

  it('a cycle (#CIRC!) — already uncatchable', () => {
    const result = evaluateWorkbook([sheet('S', { A1: { f: 'A1' }, C1: { f: 'IFERROR(A1,0)' } })]);
    expect(result.get('S!C1')).toEqual(err('#CIRC!'));
  });

  it('across cells: B1=IFERROR(dev,0), C1=IFERROR(B1,5) stays an error', () => {
    const result = evaluateWorkbook([
      sheet('S', { A1: 1, A2: 2, A3: 3, B1: { f: 'IFERROR(A1:A3*1,0)' }, C1: { f: 'IFERROR(B1,5)' }, D1: { f: 'B1+1' } }),
    ]);
    expect(result.get('S!B1')).toEqual(err('#VALUE!'));
    expect(result.get('S!C1')).toEqual(err('#VALUE!'));
    expect(calcIn(result, 'S!D1')).toEqual(err('#VALUE!'));
  });
});

function calcIn(result: Map<string, EvalValue>, key: string): EvalValue | undefined {
  return result.get(key);
}
