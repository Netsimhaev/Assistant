import { describe, expect, it } from 'vitest';
import { DocumentSpec, type Cell } from '../domain/document-spec.js';
import {
  CAPS,
  CONTRACT_DISCLAIMER_EN,
  CONTRACT_DISCLAIMER_HE,
  REQUIRED_STRUCTURE,
  validateSpec,
  type GroundingSources,
  type SpecProblem,
} from './validate-spec.js';
import { layoutSheet } from './xlsx-layout.js';

const PRICE_LIST = 'DOC-PRICES';

const sources = (over: Partial<GroundingSources> = {}): GroundingSources => ({
  instructionText: 'תכיני מחירון לפי הקובץ המצורף',
  documents: [
    {
      documentId: PRICE_LIST,
      artifacts: [
        { ordinal: 0, text: 'מחירון 2026' },
        { ordinal: 1, text: 'כיסא משרדי 1,890 ₪\nשולחן 3,200.00 ₪\nהנחה 15%' },
      ],
    },
  ],
  memories: [{ memoryId: 'MEM-1', body: 'הספק נותן תנאי שוטף+30' }],
  ...over,
});

const base = {
  language: 'he',
  title: 'מחירון',
  filename: 'מחירון',
  style: { theme: 'clean', accent: 'navy' },
  sources: [{ kind: 'instruction' }, { kind: 'document', documentId: PRICE_LIST, ordinal: 1 }],
};

const fromDoc = (v: number, ordinal = 1): Cell => ({
  v,
  src: { kind: 'document', documentId: PRICE_LIST, ordinal },
});

function xlsx(over: Record<string, unknown> = {}): DocumentSpec {
  return DocumentSpec.parse({
    ...base,
    kind: 'price_list',
    format: 'xlsx',
    sheets: [
      {
        name: 'מחירון',
        tables: [
          {
            header: ['פריט', 'מחיר'],
            rows: [
              [{ t: 'כיסא משרדי' }, fromDoc(1890)],
              [{ t: 'שולחן' }, fromDoc(3200)],
            ],
            totals: [{ t: 'סה"כ' }, { f: 'SUM(B2:B3)' }],
          },
        ],
      },
    ],
    ...over,
  });
}

function docx(blocks: unknown[], over: Record<string, unknown> = {}): DocumentSpec {
  return DocumentSpec.parse({ ...base, kind: 'letter', format: 'docx', blocks, ...over });
}

const codes = (problems: SpecProblem[]) => problems.map((p) => p.code);
const TODAY = { today: '2026-11-04' };

describe('validateSpec — cell grounding', () => {
  it('a price taken from the attached price list artifact passes', () => {
    const problems = validateSpec(xlsx(), sources(), TODAY);
    expect(problems).toEqual([]);
  });

  it('a price present nowhere fails with ungrounded_number', () => {
    const spec = xlsx({
      sheets: [
        {
          name: 'מחירון',
          tables: [{ header: ['פריט', 'מחיר'], rows: [[{ t: 'כיסא' }, fromDoc(1990)]] }],
        },
      ],
    });
    const problems = validateSpec(spec, sources(), TODAY);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.code).toBe('ungrounded_number');
    expect(problems[0]!.where).toBe('sheet 1 table 1 row 1 col 2');
    expect(problems[0]!.detail).toContain('1990');
    // Control: the same cell pointing at the right number grounds — the check ran.
    const ok = xlsx({
      sheets: [
        { name: 'מחירון', tables: [{ header: ['פריט', 'מחיר'], rows: [[{ t: 'כיסא' }, fromDoc(1890)]] }] },
      ],
    });
    expect(validateSpec(ok, sources(), TODAY)).toEqual([]);
  });

  it('a number grounds only against the source it names, not against another one', () => {
    const spec = xlsx({
      sheets: [{ name: 'a', tables: [{ header: ['x'], rows: [[fromDoc(1890, 0)]] }] }],
    });
    expect(codes(validateSpec(spec, sources(), TODAY))).toEqual(['ungrounded_number']);
  });

  it('1890 ≡ 1890.00 and 3200 grounds against "3,200.00"', () => {
    const instr = xlsx({
      sheets: [
        {
          name: 'a',
          tables: [{ header: ['x'], rows: [[{ v: 1890, src: { kind: 'instruction' } }]] }],
        },
      ],
    });
    expect(validateSpec(instr, sources({ instructionText: 'המחיר 1890.00' }), TODAY)).toEqual([]);
    expect(codes(validateSpec(instr, sources({ instructionText: 'המחיר 1980' }), TODAY))).toEqual([
      'ungrounded_number',
    ]);
  });

  it('a memory source grounds against its body', () => {
    const spec = xlsx({
      sheets: [
        { name: 'a', tables: [{ header: ['x'], rows: [[{ v: 30, src: { kind: 'memory', memoryId: 'MEM-1' } }]] }] },
      ],
    });
    expect(validateSpec(spec, sources(), TODAY)).toEqual([]);
    expect(codes(validateSpec(spec, sources({ memories: [{ memoryId: 'MEM-1', body: 'שוטף+60' }] }), TODAY))).toEqual([
      'ungrounded_number',
    ]);
  });

  it('a percent column grounds 0.15 against "15%"', () => {
    const spec = xlsx({
      sheets: [
        {
          name: 'a',
          tables: [{ header: ['הנחה'], rows: [[fromDoc(0.15)]], numberFormat: ['percent'] }],
        },
      ],
    });
    expect(validateSpec(spec, sources(), TODAY)).toEqual([]);
    const noPercent = xlsx({
      sheets: [{ name: 'a', tables: [{ header: ['הנחה'], rows: [[fromDoc(0.15)]] }] }],
    });
    expect(codes(validateSpec(noPercent, sources(), TODAY))).toEqual(['ungrounded_number']);
  });

  it('a source that does not exist → source_not_found', () => {
    const missingDoc = xlsx({
      sheets: [
        {
          name: 'a',
          tables: [{ header: ['x'], rows: [[{ v: 1890, src: { kind: 'document', documentId: 'DOC-X', ordinal: 0 } }]] }],
        },
      ],
    });
    expect(codes(validateSpec(missingDoc, sources(), TODAY))).toEqual(['source_not_found']);
    const missingOrdinal = xlsx({
      sheets: [{ name: 'a', tables: [{ header: ['x'], rows: [[fromDoc(1890, 9)]] }] }],
    });
    expect(codes(validateSpec(missingOrdinal, sources(), TODAY))).toEqual(['source_not_found']);
    const missingMemory = xlsx({
      sheets: [
        { name: 'a', tables: [{ header: ['x'], rows: [[{ v: 1, src: { kind: 'memory', memoryId: 'MEM-9' } }]] }] },
      ],
    });
    expect(codes(validateSpec(missingMemory, sources(), TODAY))).toEqual(['source_not_found']);
  });

  it('a spec-level source pointer that does not resolve → source_not_found', () => {
    const spec = xlsx({ sources: [{ kind: 'memory', memoryId: 'MEM-404' }] });
    const problems = validateSpec(spec, sources(), TODAY);
    expect(codes(problems)).toEqual(['source_not_found']);
    expect(problems[0]!.where).toBe('sources 1');
  });
});

describe('validateSpec — free text', () => {
  it('1,890 in text grounds against 1890 in the source', () => {
    const spec = docx([{ type: 'paragraph', text: 'מחיר הכיסא הוא 1,890 ₪' }]);
    expect(validateSpec(spec, sources({ instructionText: 'הכיסא עולה 1890' }), TODAY)).toEqual([]);
    // Control: a number nowhere in any source is flagged — the check ran.
    const bad = docx([{ type: 'paragraph', text: 'מחיר הכיסא הוא 1,990 ₪' }]);
    const problems = validateSpec(bad, sources({ instructionText: 'הכיסא עולה 1890' }), TODAY);
    expect(codes(problems)).toEqual(['ungrounded_number']);
    expect(problems[0]!.where).toBe('block 1');
  });

  it('a number in text may come from a formula result', () => {
    const spec = xlsx({
      sheets: [
        {
          name: 'מחירון',
          tables: [
            {
              title: 'סה"כ 5,090',
              header: ['פריט', 'מחיר'],
              rows: [
                [{ t: 'כיסא משרדי' }, fromDoc(1890)],
                [{ t: 'שולחן' }, fromDoc(3200)],
              ],
              totals: [{ t: 'סה"כ' }, { f: 'SUM(B3:B4)' }],
            },
          ],
        },
      ],
    });
    expect(validateSpec(spec, sources(), TODAY)).toEqual([]);
  });

  it('structural clause numbers are not flagged', () => {
    const spec = docx([
      { type: 'clause', title: 'מבוא', text: 'הצדדים מסכימים' },
      { type: 'clause', title: 'תשלום', text: 'בהתאם לסעיף 1 לעיל' },
      { type: 'clause', title: 'סיום', text: 'כאמור בסעיפים 1 ו-2' },
    ]);
    expect(validateSpec(spec, sources(), TODAY)).toEqual([]);
    // Control: a clause reference past the last clause is not structural.
    const past = docx([
      { type: 'clause', title: 'מבוא', text: 'הצדדים מסכימים' },
      { type: 'clause', title: 'תשלום', text: 'בהתאם לסעיף 7' },
    ]);
    expect(codes(validateSpec(past, sources(), TODAY))).toEqual(['ungrounded_number']);
  });

  it("today's date is structural; another year is not", () => {
    expect(validateSpec(docx([{ type: 'paragraph', text: 'נכון ל-4 בנובמבר 2026' }]), sources(), TODAY)).toEqual(
      [],
    );
    expect(codes(validateSpec(docx([{ type: 'paragraph', text: 'נכון לשנת 2031' }]), sources(), TODAY))).toEqual([
      'ungrounded_number',
    ]);
  });

  it('numbers in headings, list items, text cells and slide text are checked too', () => {
    const blocks = docx([
      { type: 'heading', level: 1, text: 'הצעה 777' },
      { type: 'list', style: 'bullet', items: ['פריט 888'] },
      { type: 'table', header: ['עמודה 999'], rows: [[{ t: 'תא 555' }]] },
    ]);
    expect(validateSpec(blocks, sources(), TODAY).map((p) => p.where)).toEqual([
      'block 1',
      'block 2 item 1',
      'block 3 header col 1',
      'block 3 row 1 col 1',
    ]);
    const slides = DocumentSpec.parse({
      ...base,
      kind: 'presentation',
      format: 'pptx',
      slides: [{ type: 'titleBullets', title: 'שקף', bullets: ['צמיחה של 444'] }],
    });
    expect(validateSpec(slides, sources(), TODAY).map((p) => p.where)).toEqual(['slide 1 bullet 1']);
  });
});

describe('validateSpec — formulas', () => {
  it('a formula with INDIRECT → formula_problem', () => {
    const spec = xlsx({
      sheets: [
        { name: 'a', tables: [{ header: ['x'], rows: [[fromDoc(1890)], [{ f: 'INDIRECT("A2")' }]] }] },
      ],
    });
    const problems = validateSpec(spec, sources(), TODAY);
    expect(codes(problems)).toEqual(['formula_problem']);
    expect(problems[0]!.where).toBe('sheet 1 table 1 row 2 col 1');
    expect(problems[0]!.detail).toContain('INDIRECT');
  });

  it('a reference to a sheet that does not exist → formula_problem', () => {
    const spec = xlsx({
      sheets: [{ name: 'a', tables: [{ header: ['x'], rows: [[{ f: "'גיליון חסר'!A1+1" }]] }] }],
    });
    const problems = validateSpec(spec, sources(), TODAY);
    expect(codes(problems)).toEqual(['formula_problem']);
    expect(problems[0]!.detail).toContain('גיליון חסר');
    // Control: a reference to a sheet that exists is fine (case-insensitive, as Excel).
    const ok = xlsx({
      sheets: [
        { name: 'Prices', tables: [{ header: ['x'], rows: [[fromDoc(1890)]] }] },
        { name: 'b', tables: [{ header: ['y'], rows: [[{ f: 'prices!A2*2' }]] }] },
      ],
    });
    expect(validateSpec(ok, sources(), TODAY)).toEqual([]);
  });

  it('a formula whose evaluation is an error → formula_problem', () => {
    const spec = xlsx({
      sheets: [{ name: 'a', tables: [{ header: ['x'], rows: [[fromDoc(1890)], [{ f: 'A2/0' }]] }] }],
    });
    const problems = validateSpec(spec, sources(), TODAY);
    expect(codes(problems)).toEqual(['formula_problem']);
    expect(problems[0]!.detail).toContain('#DIV/0!');
  });

  it('a workbook with a deviated cell is refused (one problem per deviated cell)', () => {
    // Text in arithmetic that contains a digit is refuse()d by the evaluator:
    // A2 deviates, and A3 reads it, so both are deviated.
    const spec = xlsx({
      sheets: [
        {
          name: 'a',
          tables: [{ header: ['x'], rows: [[{ t: '5 יח' }], [{ f: 'IFERROR(A2+1,0)' }], [{ f: 'A3*2' }]] }],
        },
      ],
    });
    const problems = validateSpec(spec, sources({ instructionText: '5' }), TODAY);
    expect(problems.filter((p) => p.code === 'formula_problem').map((p) => p.where)).toEqual([
      'sheet 1 table 1 row 2 col 1',
      'sheet 1 table 1 row 3 col 1',
    ]);
  });

  it('a deviated cell whose own value is a plain number is still refused', () => {
    // A4 reads the deviated A3 only through an untaken IF branch: its value is
    // 7, not an error, so only the `deviated` set (THE GUARANTEE) catches it.
    const spec = xlsx({
      sheets: [
        {
          name: 'a',
          tables: [{ header: ['x'], rows: [[{ t: '5 יח' }], [{ f: 'A2+1' }], [{ f: 'IF(1=1,7,A3)' }]] }],
        },
      ],
    });
    const problems = validateSpec(spec, sources({ instructionText: '5' }), TODAY);
    const a4 = problems.find((p) => p.where === 'sheet 1 table 1 row 3 col 1');
    expect(a4?.code).toBe('formula_problem');
    expect(a4?.detail).toContain('Excel');
  });

  it('a formula outside a workbook (docx table) → formula_problem', () => {
    const spec = docx([{ type: 'table', header: ['x'], rows: [[{ f: 'SUM(A1:A2)' }]] }]);
    expect(codes(validateSpec(spec, sources(), TODAY))).toEqual(['formula_problem']);
  });

  it('two sheets whose names differ only in case → formula_problem, not a throw', () => {
    const spec = xlsx({
      sheets: [
        { name: 'Data', tables: [{ header: ['x'], rows: [[fromDoc(1890)]] }] },
        { name: 'DATA', tables: [{ header: ['x'], rows: [[fromDoc(1890)]] }] },
      ],
    });
    expect(codes(validateSpec(spec, sources(), TODAY))).toEqual(['formula_problem']);
  });
});

describe('validateSpec — caps', () => {
  it('21 sheets → cap_exceeded', () => {
    const sheet = (i: number) => ({ name: `s${i}`, tables: [{ header: ['x'], rows: [[fromDoc(1890)]] }] });
    const spec = xlsx({ sheets: Array.from({ length: CAPS.sheets + 1 }, (_, i) => sheet(i)) });
    const problems = validateSpec(spec, sources(), TODAY);
    expect(codes(problems)).toEqual(['cap_exceeded']);
    const atCap = xlsx({ sheets: Array.from({ length: CAPS.sheets }, (_, i) => sheet(i)) });
    expect(validateSpec(atCap, sources(), TODAY)).toEqual([]);
  });

  it('more than 5000 rows in a sheet → cap_exceeded', () => {
    const rows = Array.from({ length: CAPS.rowsPerSheet + 1 }, () => [{ t: 'x' }]);
    const spec = xlsx({ sheets: [{ name: 'a', tables: [{ header: ['x'], rows }] }] });
    const problems = validateSpec(spec, sources(), TODAY);
    expect(codes(problems)).toEqual(['cap_exceeded']);
    expect(problems[0]!.where).toBe('sheet 1');
  });

  it('41 slides → cap_exceeded', () => {
    const slides = Array.from({ length: CAPS.slides + 1 }, () => ({ type: 'paragraph', text: 'x' }));
    const spec = DocumentSpec.parse({ ...base, kind: 'presentation', format: 'pptx', slides });
    expect(codes(validateSpec(spec, sources(), TODAY))).toEqual(['cap_exceeded']);
    const atCap = DocumentSpec.parse({ ...base, kind: 'presentation', format: 'pptx', slides: slides.slice(1) });
    expect(validateSpec(atCap, sources(), TODAY)).toEqual([]);
  });

  it('exact cap values', () => {
    expect(CAPS).toEqual({ sheets: 20, rowsPerSheet: 5000, pages: 60, slides: 40 });
  });
});

describe('validateSpec — images and filename', () => {
  it('an image of a document not in sources → unknown_image', () => {
    const spec = docx([{ type: 'image', documentId: 'DOC-ELSEWHERE' }]);
    const problems = validateSpec(spec, sources(), TODAY);
    expect(codes(problems)).toEqual(['unknown_image']);
    expect(problems[0]!.where).toBe('block 1');
    expect(validateSpec(docx([{ type: 'image', documentId: PRICE_LIST }]), sources(), TODAY)).toEqual([]);
  });

  it('collage and imageText slides are checked too', () => {
    const spec = DocumentSpec.parse({
      ...base,
      kind: 'presentation',
      format: 'pptx',
      slides: [
        { type: 'imageText', title: 'a', text: 'b', documentId: 'DOC-1' },
        { type: 'collage', documentIds: [PRICE_LIST, 'DOC-2'] },
      ],
    });
    expect(validateSpec(spec, sources(), TODAY).map((p) => [p.code, p.where])).toEqual([
      ['unknown_image', 'slide 1'],
      ['unknown_image', 'slide 2 image 2'],
    ]);
  });

  it('a filename with a path, a reserved name or a control character → filename_invalid', () => {
    for (const filename of ['../etc', 'a/b', 'a\\b', 'CON', 'nul.docx', '.hidden', 'a:b', 'name.', 'a*b']) {
      expect(codes(validateSpec(docx([{ type: 'paragraph', text: 'x' }], { filename }), sources(), TODAY))).toEqual([
        'filename_invalid',
      ]);
    }
    for (const filename of ['מחירון 2026', 'report_v2-final', 'דוח.רבעוני', 'report‮']) {
      expect(validateSpec(docx([{ type: 'paragraph', text: 'x' }], { filename }), sources(), TODAY)).toEqual([]);
    }
  });
});

describe('REQUIRED_STRUCTURE', () => {
  const contractBlocks = [
    { type: 'heading', level: 1, text: 'הצדדים' },
    { type: 'paragraph', text: 'בין המזמין לבין הספק' },
    { type: 'heading', level: 1, text: 'הגדרות' },
    { type: 'clause', title: 'התחייבות', text: 'הספק יספק' },
    { type: 'heading', level: 1, text: 'חתימות' },
  ];
  const contract = (blocks: unknown[]) =>
    docx(blocks, { kind: 'contract', legalBasis: [{ law: 'חוק החוזים (חלק כללי)' }] });

  it('a complete contract passes', () => {
    expect(REQUIRED_STRUCTURE.contract(contract(contractBlocks))).toEqual([]);
    expect(validateSpec(contract(contractBlocks), sources(), TODAY)).toEqual([]);
  });

  it("contract missing signatures lists 'חתימות' in missing_structure", () => {
    const spec = contract(contractBlocks.slice(0, 4));
    const problems = validateSpec(spec, sources(), TODAY);
    expect(codes(problems)).toEqual(['missing_structure']);
    expect(problems[0]!.detail).toContain('חתימות');
    expect(REQUIRED_STRUCTURE.contract(spec)).toEqual(['חתימות']);
  });

  it('a contract with no clause and no parties lists both', () => {
    const spec = contract([contractBlocks[2], contractBlocks[4]]);
    expect(REQUIRED_STRUCTURE.contract(spec)).toEqual(['צדדים', 'סעיפים']);
  });

  it('a protocol needs date, participants, decisions and tasks with owner and due date', () => {
    const protocol = (blocks: unknown[]) => docx(blocks, { kind: 'protocol' });
    const full = [
      { type: 'heading', level: 1, text: 'תאריך' },
      { type: 'table', header: ['תאריך'], rows: [[{ d: '2026-11-04' }]] },
      { type: 'heading', level: 1, text: 'משתתפים' },
      { type: 'list', style: 'bullet', items: ['דנה', 'רונית'] },
      { type: 'heading', level: 1, text: 'החלטות' },
      { type: 'list', style: 'ordered', items: ['לאשר את התקציב'] },
      {
        type: 'table',
        header: ['משימה', 'אחראי', 'מועד'],
        rows: [[{ t: 'לשלוח הצעה' }, { t: 'דנה' }, { d: '2026-11-10' }]],
      },
    ];
    expect(REQUIRED_STRUCTURE.protocol(protocol(full))).toEqual([]);
    const noOwner = full.slice(0, 6).concat([
      { type: 'table', header: ['משימה', 'מועד'], rows: [[{ t: 'לשלוח הצעה' }, { d: '2026-11-10' }]] },
    ]);
    expect(REQUIRED_STRUCTURE.protocol(protocol(noOwner))).toEqual(['משימות עם אחראי ומועד']);
    const emptyOwner = full.slice(0, 6).concat([
      {
        type: 'table',
        header: ['משימה', 'אחראי', 'מועד'],
        rows: [[{ t: 'לשלוח הצעה' }, { t: ' ' }, { d: '2026-11-10' }]],
      },
    ]);
    expect(REQUIRED_STRUCTURE.protocol(protocol(emptyOwner))).toEqual(['משימות עם אחראי ומועד']);
    expect(REQUIRED_STRUCTURE.protocol(protocol([{ type: 'paragraph', text: 'x' }]))).toEqual([
      'תאריך',
      'משתתפים',
      'החלטות',
      'משימות עם אחראי ומועד',
    ]);
  });

  it('other kinds require a title only', () => {
    for (const kind of ['price_list', 'profit_table', 'report', 'letter', 'presentation', 'other'] as const) {
      expect(REQUIRED_STRUCTURE[kind](docx([{ type: 'paragraph', text: 'x' }], { kind }))).toEqual([]);
      expect(REQUIRED_STRUCTURE[kind](docx([{ type: 'paragraph', text: 'x' }], { kind, title: '   ' }))).toEqual([
        'כותרת',
      ]);
    }
  });

  it('disclaimers are the exact strings', () => {
    expect(CONTRACT_DISCLAIMER_HE).toBe('טיוטה — מומלץ שעורך דין יעבור עליה');
    expect(CONTRACT_DISCLAIMER_EN).toBe('Draft — we recommend a lawyer review it');
  });
});

describe('xlsx layout', () => {
  it('places title, header, rows and totals from A1 with one blank row between tables', () => {
    const sheet = {
      name: 'a',
      tables: [
        { title: 'ט', header: ['x', 'y'], rows: [[{ t: 'a' }, { t: 'b' }]], totals: [{ t: 'c' }] },
        { header: ['z'], rows: [[{ t: 'd' }]] },
      ],
    };
    const placed = layoutSheet(sheet as never).map((c) => `${c.address}:${c.role}`);
    expect(placed).toEqual(['A1:title', 'A2:header', 'B2:header', 'A3:data', 'B3:data', 'A4:totals', 'A6:header', 'A7:data']);
  });
});
