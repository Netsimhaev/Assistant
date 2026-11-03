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
import { excelDateSerial, layoutSheet } from './xlsx-layout.js';

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
      { type: 'clause', title: '1', text: 'הצדדים מסכימים' },
      { type: 'clause', title: 'סעיף 2 — תשלום', text: 'התשלום יבוצע בהעברה' },
      { type: 'clause', title: '3. סיום', text: 'ההסכם יסתיים בהודעה' },
    ]);
    expect(validateSpec(spec, sources(), TODAY)).toEqual([]);
    // Controls: a clause number is structural only as ITS OWN number, and only
    // in its title — a body cross-reference is checked like any number.
    const wrongNumber = docx([
      { type: 'clause', title: 'מבוא', text: 'הצדדים מסכימים' },
      { type: 'clause', title: 'סעיף 5 — תשלום', text: 'x' },
    ]);
    expect(validateSpec(wrongNumber, sources(), TODAY).map((p) => [p.code, p.where])).toEqual([
      ['ungrounded_number', 'block 2 title'],
    ]);
    const inBody = docx([
      { type: 'clause', title: 'מבוא', text: 'הצדדים מסכימים' },
      { type: 'clause', title: 'תשלום', text: 'בהתאם לסעיף 1 לעיל, תוך 2 ימים' },
    ]);
    // A cross-reference to an existing clause is exempt (round 2); a bare 2 is not.
    expect(validateSpec(inBody, sources(), TODAY).map((p) => [p.where, p.detail])).toEqual([
      ['block 2', 'מספר או תאריך שאין לו מקור: 2'],
    ]);
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
        { name: 'b', tables: [{ header: ['y'], rows: [[{ f: 'prices!A2*100' }]] }] },
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
    const a4 = problems.find((p) => p.where === 'sheet 1 table 1 row 3 col 1' && p.code === 'formula_problem');
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
    const sheet = (i: number) => ({ name: `גיליון ${String.fromCharCode(0x5d0 + i)}`, tables: [{ header: ['x'], rows: [[fromDoc(1890)]] }] });
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
    for (const filename of ['מחירון 2026', 'report_final-draft', 'דוח.רבעוני', 'report‮']) {
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

describe('fix round 1', () => {
  const sheetWith = (rows: Cell[][], over: Record<string, unknown> = {}) =>
    xlsx({ sheets: [{ name: 'a', tables: [{ header: ['x'], rows, ...over }] }] });
  const wheres = (problems: SpecProblem[], code: string) =>
    problems.filter((p) => p.code === code).map((p) => p.where);

  describe('numeric literals inside formulas', () => {
    it('a literal no source carries is refused, in the cell itself', () => {
      const added = validateSpec(sheetWith([[fromDoc(1890)], [{ f: 'A2+99999' }]]), sources(), TODAY);
      expect(added.map((p) => [p.code, p.where])).toEqual([['ungrounded_number', 'sheet 1 table 1 row 2 col 1']]);
      expect(added[0]!.detail).toContain('99999');
      const bare = validateSpec(sheetWith([[{ f: '18900' }]]), sources(), TODAY);
      expect(wheres(bare, 'ungrounded_number')).toEqual(['sheet 1 table 1 row 1 col 1']);
      // Controls: a grounded literal, and the closed exemption set.
      expect(validateSpec(sheetWith([[fromDoc(1890)], [{ f: 'A2+3200' }]]), sources(), TODAY)).toEqual([]);
      expect(validateSpec(sheetWith([[fromDoc(1890)], [{ f: 'ROUND(A2*12/100,0)+1-0' }]]), sources(), TODAY)).toEqual([]);
      // A negated literal is checked as its magnitude.
      expect(wheres(validateSpec(sheetWith([[{ f: '-77777' }]]), sources(), TODAY), 'ungrounded_number')).toHaveLength(1);
    });

    it('a result built on an ungrounded literal does not ground free text (also through a chain)', () => {
      const direct = sheetWith([[{ f: '18900' }]], { title: 'סה"כ 18900' });
      expect(wheres(validateSpec(direct, sources(), TODAY), 'ungrounded_number')).toEqual([
        'sheet 1 table 1 title',
        'sheet 1 table 1 row 1 col 1',
      ]);
      const chained = sheetWith([[fromDoc(1890)], [{ f: 'A3+98110' }], [{ f: 'A4*100' }]], {
        title: 'סה"כ 10000000',
      });
      expect(wheres(validateSpec(chained, sources(), TODAY), 'ungrounded_number')).toEqual([
        'sheet 1 table 1 title',
        'sheet 1 table 1 row 2 col 1',
      ]);
      // Control: an untainted result still grounds the same title shape.
      const clean = sheetWith([[fromDoc(1890)], [{ f: 'A3*100' }]], { title: 'סה"כ 189000' });
      expect(validateSpec(clean, sources(), TODAY)).toEqual([]);
    });

    it('a string literal in a formula is free text', () => {
      const spec = sheetWith([[{ f: '"מחיר 99999"' }]]);
      expect(wheres(validateSpec(spec, sources(), TODAY), 'ungrounded_number')).toEqual(['sheet 1 table 1 row 1 col 1']);
      expect(validateSpec(sheetWith([[{ f: '"מחיר 1,890"' }]]), sources(), TODAY)).toEqual([]);
    });
  });

  describe('separators', () => {
    const para = (text: string) => docx([{ type: 'paragraph', text }]);
    it('"12,000/חודש" and both sides of "3000-4000" are checked', () => {
      expect(codes(validateSpec(para('שכר 12,000/חודש'), sources(), TODAY))).toEqual(['ungrounded_number']);
      expect(validateSpec(para('שכר 12,000/חודש'), sources({ instructionText: 'שכר 12,000/חודש' }), TODAY)).toEqual([]);
      const range = validateSpec(para('טווח 3000-4000'), sources({ instructionText: 'לפחות 3000' }), TODAY);
      expect(range).toHaveLength(1);
      expect(range[0]!.detail).toContain('4000');
      expect(range[0]!.detail).not.toContain('3000');
      expect(validateSpec(para('טווח 3000-4000'), sources({ instructionText: 'בין 3000-4000' }), TODAY)).toEqual([]);
      expect(codes(validateSpec(para('שעה 10:99'), sources(), TODAY))).toEqual(['ungrounded_number']);
    });

    it('times are exempt; impossible dates are checked as numbers', () => {
      for (const text of ['בשעה 10:30', 'בין 9:00 ל-17:45:00']) {
        expect(validateSpec(para(text), sources(), TODAY)).toEqual([]);
      }
      expect(codes(validateSpec(para('עד 45/45/2026'), sources(), TODAY))).toEqual(['ungrounded_number']);
    });
  });

  describe('percent columns', () => {
    const pct = (v: number) => sheetWith([[fromDoc(v)]], { numberFormat: ['percent'] });
    it('a 100× mismatch is refused: {v:15} would display 1500%', () => {
      const problems = validateSpec(pct(15), sources(), TODAY);
      expect(codes(problems)).toEqual(['ungrounded_number']);
      expect(validateSpec(pct(0.15), sources(), TODAY)).toEqual([]);
    });
    it('the raw fraction grounds when the source writes it', () => {
      const s = sources({
        documents: [{ documentId: PRICE_LIST, artifacts: [{ ordinal: 1, text: 'שיעור 0.15' }] }],
      });
      expect(validateSpec(pct(0.15), s, TODAY)).toEqual([]);
    });
  });

  describe('structural numbers', () => {
    it('40 slides do not ground "מחיר 35 ש"ח"', () => {
      const slides: unknown[] = Array.from({ length: 39 }, () => ({ type: 'paragraph', text: 'x' }));
      slides.push({ type: 'paragraph', text: 'מחיר 35 ש"ח' });
      const spec = DocumentSpec.parse({ ...base, kind: 'presentation', format: 'pptx', slides });
      expect(wheres(validateSpec(spec, sources(), TODAY), 'ungrounded_number')).toEqual(['slide 40']);
    });
    it('empty clauses do not ground "מחיר 7"', () => {
      const clauses = Array.from({ length: 8 }, () => ({ type: 'clause', title: '', text: '' }));
      const spec = docx([...clauses, { type: 'paragraph', text: 'מחיר 7' }]);
      expect(wheres(validateSpec(spec, sources(), TODAY), 'ungrounded_number')).toEqual(['block 9']);
    });
    it('a slide title that is its own number is structural', () => {
      const spec = DocumentSpec.parse({
        ...base,
        kind: 'presentation',
        format: 'pptx',
        slides: [
          { type: 'paragraph', title: '1. פתיחה', text: 'x' },
          { type: 'paragraph', title: '2', text: 'y' },
        ],
      });
      expect(validateSpec(spec, sources(), TODAY)).toEqual([]);
    });
    it("today's parts ground only inside a date", () => {
      const t = { today: '2027-01-05' };
      expect(validateSpec(docx([{ type: 'paragraph', text: 'נכון ל-5 בינואר 2027' }]), sources(), t)).toEqual([]);
      expect(codes(validateSpec(docx([{ type: 'paragraph', text: 'בשנת 2027' }]), sources(), t))).toEqual([
        'ungrounded_number',
      ]);
      expect(codes(validateSpec(docx([{ type: 'paragraph', text: '5 יחידות' }]), sources(), t))).toEqual([
        'ungrounded_number',
      ]);
    });
  });

  it('legalBasis notes are free text; the law name is not', () => {
    const contract = (note: string) =>
      docx(
        [
          { type: 'heading', level: 1, text: 'הצדדים' },
          { type: 'heading', level: 1, text: 'הגדרות' },
          { type: 'clause', title: 'התחייבות', text: 'x' },
          { type: 'heading', level: 1, text: 'חתימות' },
        ],
        { kind: 'contract', legalBasis: [{ law: 'חוק החוזים (חלק כללי), התשל"ג-1973', note }] },
      );
    const problems = validateSpec(contract('קנס של 99999'), sources(), TODAY);
    expect(problems.map((p) => [p.code, p.where])).toEqual([['ungrounded_number', 'legalBasis 1 note']]);
    expect(validateSpec(contract('קנס של 1,890'), sources(), TODAY)).toEqual([]);
  });

  it('sheet names and the filename are checked for numbers', () => {
    const named = xlsx({ sheets: [{ name: 'רבעון 9', tables: [{ header: ['x'], rows: [[fromDoc(1890)]] }] }] });
    expect(validateSpec(named, sources(), TODAY).map((p) => p.where)).toEqual(['sheet 1 name']);
    const filed = docx([{ type: 'paragraph', text: 'x' }], { filename: 'דוח 777' });
    expect(validateSpec(filed, sources(), TODAY).map((p) => [p.code, p.where])).toEqual([['ungrounded_number', 'filename']]);
  });

  it('formula results ground free text in the form the column displays', () => {
    const spec = (fmt: 'int' | 'money' | null, text: string) =>
      xlsx({
        sheets: [
          {
            name: 'a',
            tables: [
              {
                title: text,
                header: ['x'],
                rows: [[fromDoc(3200)], [{ f: 'A3/3' }]],
                ...(fmt === null ? {} : { numberFormat: [fmt] }),
              },
            ],
          },
        ],
      });

    const s = sources({ instructionText: 'חלוקה ל-3' });
    expect(validateSpec(spec('int', 'סה"כ 1067'), s, TODAY)).toEqual([]);
    expect(codes(validateSpec(spec('int', 'סה"כ 1066.67'), s, TODAY))).toEqual(['ungrounded_number']);
    expect(validateSpec(spec('money', 'סה"כ 1066.67'), s, TODAY)).toEqual([]);
    expect(codes(validateSpec(spec(null, 'סה"כ 1067'), s, TODAY))).toEqual(['ungrounded_number']);
  });

  describe('date cells', () => {
    const dated = (d: string) => docx([{ type: 'table', header: ['מועד'], rows: [[{ d }]] }]);
    it('a date no source carries is refused', () => {
      const problems = validateSpec(dated('2026-11-10'), sources(), TODAY);
      expect(problems.map((p) => [p.code, p.where])).toEqual([['ungrounded_number', 'block 1 row 1 col 1']]);
    });
    it('grounds in ISO, d/m/yyyy, d.m.yyyy, or as today', () => {
      for (const text of ['פגישה 2026-11-10', 'פגישה ב-10/11/2026', 'פגישה 10.11.2026', 'פגישה 10/11/2026.']) {
        expect(validateSpec(dated('2026-11-10'), sources({ instructionText: text }), TODAY)).toEqual([]);
      }
      expect(validateSpec(dated('2026-11-04'), sources(), TODAY)).toEqual([]);
      expect(codes(validateSpec(dated('2026-11-10'), sources({ instructionText: '110/11/2026' }), TODAY))).toEqual([
        'ungrounded_number',
      ]);
    });
    it('an xlsx date before 1900-03-01 is refused, and excelDateSerial throws on it', () => {
      const spec = xlsx({ sheets: [{ name: 'a', tables: [{ header: ['x'], rows: [[{ d: '1899-12-31' }]] }] }] });
      expect(codes(validateSpec(spec, sources({ instructionText: '1899-12-31' }), TODAY))).toEqual(['cap_exceeded']);
      expect(() => excelDateSerial('1899-12-31')).toThrow(RangeError);
      expect(excelDateSerial('1900-03-01')).toBe(61);
    });
  });

  it('today is required and must be a real date', () => {
    expect(() => validateSpec(docx([{ type: 'paragraph', text: 'x' }]), sources(), {} as never)).toThrow(TypeError);
    expect(() => validateSpec(docx([{ type: 'paragraph', text: 'x' }]), sources(), { today: '2026-02-30' })).toThrow(
      TypeError,
    );
  });

  describe('negative values', () => {
    const neg = (text: string) =>
      validateSpec(sheetWith([[{ v: -500, src: { kind: 'instruction' } }]]), sources({ instructionText: text }), TODAY);
    it('a negative cell grounds on "-500" or "500-", never on "500"', () => {
      expect(neg('יתרה -500')).toEqual([]);
      expect(neg('יתרה 500-')).toEqual([]);
      expect(codes(neg('יתרה 500'))).toEqual(['ungrounded_number']);
    });
    it('a negative number in text does not ground on its positive', () => {
      const p = docx([{ type: 'paragraph', text: 'יתרה -500' }]);
      expect(codes(validateSpec(p, sources({ instructionText: 'יתרה 500' }), TODAY))).toEqual(['ungrounded_number']);
      expect(validateSpec(p, sources({ instructionText: 'יתרה 500-' }), TODAY)).toEqual([]);
    });
  });
});

describe('fix round 2', () => {
  const para = (text: string) => docx([{ type: 'paragraph', text }]);
  const sevenClauses = Array.from({ length: 7 }, (_, i) => ({ type: 'clause', title: `נושא`, text: `תוכן ${'א'.repeat(i + 1)}` }));

  describe('clause cross-references', () => {
    const withRef = (text: string) => docx([...sevenClauses, { type: 'paragraph', text }]);
    it('a reference to an existing clause passes, in every allowed form', () => {
      for (const text of ['בהתאם לסעיף 4', 'כאמור בסעיף 4.2 לעיל', 'ראו סעיף 7', 'see Clause 3', 'under Section 6.1']) {
        expect(validateSpec(withRef(text), sources(), TODAY)).toEqual([]);
      }
    });
    it('"סעיף 9" with 7 clauses is refused', () => {
      const problems = validateSpec(withRef('בהתאם לסעיף 9'), sources(), TODAY);
      expect(problems.map((p) => [p.code, p.where])).toEqual([['ungrounded_number', 'block 8']]);
      expect(problems[0]!.detail).toContain('9');
    });
    it('"מחיר 4" with 7 clauses is refused', () => {
      expect(codes(validateSpec(withRef('מחיר 4'), sources(), TODAY))).toEqual(['ungrounded_number']);
    });
    it('a reference with no clauses at all is refused', () => {
      expect(codes(validateSpec(para('בהתאם לסעיף 1'), sources(), TODAY))).toEqual(['ungrounded_number']);
    });
  });

  describe('dates in free text are grounded like date cells', () => {
    it('an invented "15/12/2026" is refused', () => {
      const problems = validateSpec(para('התשלום עד 15/12/2026'), sources(), TODAY);
      expect(codes(problems)).toEqual(['ungrounded_number']);
      expect(problems[0]!.detail).toContain('15/12/2026');
    });
    it('the same date present in the instruction passes, in any of the forms', () => {
      for (const instructionText of ['עד 15/12/2026', 'עד 15.12.2026', 'עד 2026-12-15', 'עד 15 בדצמבר 2026']) {
        expect(validateSpec(para('התשלום עד 15/12/2026'), sources({ instructionText }), TODAY)).toEqual([]);
      }
      expect(validateSpec(para('עד 2026-12-15'), sources({ instructionText: 'עד 15/12/2026' }), TODAY)).toEqual([]);
      expect(validateSpec(para('עד 15.12.26'.replace('.26', '.2026')), sources({ instructionText: 'עד 15/12/26' }), TODAY)).toEqual([]);
    });
    it("today's date passes in every shape", () => {
      for (const text of ['נכון ל-04/11/2026', 'נכון ל-4.11.2026', 'נכון ל-2026-11-04', 'נכון ל-4/11/26', 'נכון ל-4 בנובמבר 2026']) {
        expect(validateSpec(para(text), sources(), TODAY)).toEqual([]);
      }
    });
    it('an invented date in words is refused', () => {
      const problems = validateSpec(para('עד 20 בדצמבר 2026'), sources(), TODAY);
      expect(codes(problems)).toEqual(['ungrounded_number']);
    });
  });
});
