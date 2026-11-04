/**
 * Check 1 (spec §7.1): the mechanical verification of the BUILT file, with
 * no model. It reads the produced bytes — never the spec alone — and refuses
 * a wrong formula, an ungrounded number, reversed Hebrew or digits, missing
 * structure, an unsafe part, a cap breach, or a stray bidi control. It is the
 * owner's main guarantee before a document is shown as "ready".
 *
 * **Inputs.** `bytes` is the file as stored; `rendered` is what
 * `page-images.ts` read back from its pages (pdf.js over our Chromium PDF, or
 * over LibreOffice's temporary PDF for docx/xlsx/pptx) — the text the client
 * will see. `today` is the charter-local date, required: grounding needs it.
 *
 * **What runs, in order** (findings are deduplicated by code and position):
 *  1. `validateSpec` again (defence in depth; its codes map through
 *     `SPEC_CODE`). Check 1's page grounding trusts the spec's own values
 *     only because they grounded here.
 *  2. `rendered.pageCount > CAPS.pages` → `cap_exceeded`;
 *     `rendered.textTruncated` → `text_truncated` and the text checks are
 *     skipped — a document whose text was not fully read never passes.
 *  3. The file itself, per format:
 *     - docx/xlsx/pptx: `inspectArchive` (the inbound zip guard), then a
 *       POSITIVE part allowlist (`PART_ALLOWLIST`, frozen from what our
 *       renderers emit) — anything else is `unsafe_part`; so is any `.rels`
 *       Target with `TargetMode="External"`, and a content type naming a
 *       macro, an OLE object or ActiveX. A pptx chart carries a pptxgenjs
 *       data workbook under `ppt/embeddings/`; it is the one embedded object
 *       our renderer makes, and it gets the same guard, its own allowlist and
 *       the same rels check.
 *     - xlsx: loaded with exceljs; `rightToLeft` per language; no defined
 *       names; every formula is re-read FROM THE FILE and recomputed with
 *       `evaluateWorkbook` over the file's own cells: a deviated cell →
 *       `formula_problem`, an error (computed or cached) or a direct
 *       reference to an empty cell → `formula_error`, a cached result that
 *       differs (or is missing) → `formula_mismatch`.
 *     - docx: in Hebrew every paragraph with text carries `w:bidi` and every
 *       run with Hebrew letters `w:rtl` (in English neither appears); for a
 *       contract the footer carries the D6 disclaimer and the body the legal
 *       basis heading, every cited law, and the signature block. mammoth's
 *       text of the file is order-checked against the spec too.
 *     - pptx: in Hebrew every slide paragraph with text has `rtl="1"`.
 *     - pdf: `%PDF-` magic; no action/script/embedded-file/link name
 *       (`PDF_FORBIDDEN_NAMES`, `#xx` escapes decoded). This is a token scan:
 *       a name inside a compressed object stream is not seen. Our Chromium
 *       PDFs carry none; the scan is the backstop, not the boundary. For a
 *       contract the disclaimer, heading, laws and signatures are looked
 *       for in `rendered.text` (Chromium prints the footer).
 *  4. Bidi controls: the renderers isolate digit runs structurally (separate
 *     runs, `<bdi>`), never with control characters, so
 *     `RENDERER_BIDI_CONTROLS` is empty and any control in the file's own
 *     text (pdf: the extracted text) is `bidi_control`.
 *  5. Text (`rendered.text`, bidi controls stripped, whitespace collapsed):
 *     - order: every spec text run of two or more words must appear as
 *       written. Its words reversed (or its characters) → `order_reversed`;
 *       its digit sequences reversed → `digits_reversed`; neither →
 *       `text_missing`. A number the spec shows (cells, single-word runs)
 *       absent while its reverse is present → `digits_reversed`.
 *     - grounding: `createTextGrounder` (the same code as `validateSpec`)
 *       over the extracted text, with page numbers, clause labels, ordered
 *       list numbers and the cited laws as structure.
 *
 * Every finding's `he` is the fixed string of its code (`CHECK1_HE`): the
 * fix loop sends these back to the drafter, never text from a source.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { inspectArchive } from '../documents/archive-guard.js';
import type { Block, Cell, DocumentSpec } from '../domain/document-spec.js';
import { stripBidiControls } from '../util/bidi.js';
import { formatNumber } from './format-value.js';
import {
  evaluateWorkbook,
  formatAddress,
  parseFormula,
  type EvalSheet,
  type EvalValue,
  type FormulaAst,
  type SheetCellInput,
} from './formula.js';
import { numberClause } from './render-shared.js';
import {
  CAPS,
  CONTRACT_DISCLAIMER_EN,
  CONTRACT_DISCLAIMER_HE,
  createTextGrounder,
  stripOwnNumber,
  validateSpec,
  type GroundingSources,
  type SpecProblemCode,
} from './validate-spec.js';

export type Check1Code =
  | 'formula_mismatch'
  | 'formula_error'
  | 'formula_problem'
  | 'direction_wrong'
  | 'unsafe_part'
  | 'missing_structure'
  | 'ungrounded_number'
  | 'order_reversed'
  | 'digits_reversed'
  | 'text_missing'
  | 'cap_exceeded'
  | 'bidi_control'
  | 'text_truncated'
  | 'file_unreadable'
  | 'spec_invalid';

/** The one owner-facing string per code. Fixed: no finding carries source text. */
export const CHECK1_HE: Record<Check1Code, string> = {
  formula_mismatch: 'ערך שמור בנוסחה אינו שווה לחישוב מחדש',
  formula_error: 'נוסחה מחזירה שגיאה או מפנה לתא ריק',
  formula_problem: 'לא ניתן לאמת שהנוסחה מחושבת כמו ב-Excel',
  direction_wrong: 'כיוון הטקסט בקובץ אינו תואם לשפת המסמך',
  unsafe_part: 'הקובץ מכיל חלק אסור (מאקרו, קישור חיצוני או אובייקט מוטמע)',
  missing_structure: 'חסר בקובץ חלק חובה של סוג המסמך',
  ungrounded_number: 'בקובץ יש מספר או תאריך שאין לו מקור',
  order_reversed: 'שורת טקסט מופיעה בקובץ בסדר מילים הפוך',
  digits_reversed: 'מספר מופיע בקובץ עם ספרות בסדר הפוך',
  text_missing: 'טקסט שתוכנן למסמך לא נמצא בקובץ',
  cap_exceeded: 'המסמך ארוך מהמותר',
  bidi_control: 'הקובץ מכיל תווי בקרת כיווניות נסתרים',
  text_truncated: 'לא ניתן היה לקרוא את כל הטקסט של המסמך, ולכן הבדיקה לא הושלמה',
  file_unreadable: 'לא ניתן לקרוא את הקובץ שנבנה',
  spec_invalid: 'תיאור המסמך לא עבר את הבדיקה המוקדמת',
};

export interface Check1Finding {
  code: Check1Code;
  /** Machine-readable position ('block 4', 'sheet 1 D5', 'part word/vbaProject.bin'). */
  where: string;
  he: string;
}

export interface Check1Result {
  passed: boolean;
  findings: Check1Finding[];
}

export interface Check1Rendered {
  text: string;
  pageCount: number;
  textTruncated: boolean;
}

export interface Check1Input {
  spec: DocumentSpec;
  bytes: Buffer;
  sources: GroundingSources;
  rendered: Check1Rendered;
  /** Today's LOCAL date in the charter timezone, `YYYY-MM-DD`. Required. */
  today: string;
}

/** How a `validateSpec` problem reads as a check-1 finding. Exhaustive. */
const SPEC_CODE: Record<SpecProblemCode, Check1Code> = {
  formula_problem: 'formula_problem',
  ungrounded_number: 'ungrounded_number',
  source_not_found: 'ungrounded_number',
  cap_exceeded: 'cap_exceeded',
  missing_structure: 'missing_structure',
  unknown_image: 'spec_invalid',
  filename_invalid: 'spec_invalid',
};

// ---------------------------------------------------------------- part allowlists

type ZipFormat = 'docx' | 'xlsx' | 'pptx';

/** The data workbook behind a pptxgenjs chart: the one embedded object our renderer makes. */
const EMBEDDED_CHART_WORKBOOK = /^ppt\/embeddings\/Microsoft_Excel_Worksheet\d+\.xlsx$/;

const exact = (names: string[]): RegExp[] => names.map((n) => new RegExp(`^${n.replace(/[.[\]]/g, '\\$&')}$`));

/**
 * Every part our renderers emit, per format — listed from real outputs of
 * `render-docx.ts` (docx 9.15.2), `render-xlsx.ts` (exceljs 4.4.0) and
 * `render-pptx.ts` (pptxgenjs 4.0.1), then frozen. A library upgrade that
 * adds a part fails check 1 loudly; widening this list is a reviewed change.
 * Directory entries (names ending in `/`) carry no bytes and are not parts:
 * they are skipped, whatever their name.
 */
export const PART_ALLOWLIST: Record<ZipFormat, readonly RegExp[]> = {
  docx: [
    ...exact([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'docProps/app.xml',
      'docProps/custom.xml',
      'word/document.xml',
      'word/_rels/document.xml.rels',
      'word/styles.xml',
      'word/settings.xml',
      'word/fontTable.xml',
      'word/_rels/fontTable.xml.rels',
      'word/theme/theme1.xml',
      'word/numbering.xml',
      'word/footnotes.xml',
      'word/_rels/footnotes.xml.rels',
      'word/endnotes.xml',
      'word/_rels/endnotes.xml.rels',
      'word/footer1.xml',
      'word/_rels/footer1.xml.rels',
    ]),
    /^word\/media\/image\d+\.(?:png|jpe?g)$/,
  ],
  xlsx: [
    ...exact([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'docProps/core.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/styles.xml',
      'xl/sharedStrings.xml',
      'xl/theme/theme1.xml',
    ]),
    /^xl\/worksheets\/sheet\d+\.xml$/,
  ],
  pptx: [
    ...exact([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'docProps/core.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/presentation.xml',
      'ppt/presProps.xml',
      'ppt/tableStyles.xml',
      'ppt/viewProps.xml',
      'ppt/theme/theme1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      'ppt/notesMasters/notesMaster1.xml',
      'ppt/notesMasters/_rels/notesMaster1.xml.rels',
    ]),
    /^ppt\/slides\/slide\d+\.xml$/,
    /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/,
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/,
    /^ppt\/notesSlides\/_rels\/notesSlide\d+\.xml\.rels$/,
    /^ppt\/media\/image-\d+-\d+\.(?:png|jpe?g)$/,
    /^ppt\/charts\/chart\d+\.xml$/,
    /^ppt\/charts\/_rels\/chart\d+\.xml\.rels$/,
    EMBEDDED_CHART_WORKBOOK,
  ],
};

/** The data workbook pptxgenjs writes behind a native chart. */
export const CHART_WORKBOOK_ALLOWLIST: readonly RegExp[] = exact([
  '[Content_Types].xml',
  '_rels/.rels',
  'docProps/app.xml',
  'docProps/core.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/workbook.xml',
  'xl/styles.xml',
  'xl/sharedStrings.xml',
  'xl/theme/theme1.xml',
  'xl/tables/table1.xml',
  'xl/worksheets/_rels/sheet1.xml.rels',
  'xl/worksheets/sheet1.xml',
]);

const UNSAFE_CONTENT_TYPE = /macroEnabled|vbaProject|oleObject|activeX/i;
const EXTERNAL_TARGET = /TargetMode\s*=\s*["']External["']/i;

/** PDF names that run something, open something, or carry a file. */
export const PDF_FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  'JavaScript',
  'JS',
  'Launch',
  'OpenAction',
  'AA',
  'URI',
  'GoToR',
  'GoToE',
  'SubmitForm',
  'ImportData',
  'EmbeddedFile',
  'EmbeddedFiles',
  'RichMedia',
  'XFA',
]);

/** Controls our renderers insert on purpose. None: digit runs are isolated by runs and `<bdi>`, not by characters. */
const RENDERER_BIDI_CONTROLS: ReadonlySet<string> = new Set();

// ---------------------------------------------------------------- helpers

class Findings {
  private readonly seen = new Set<string>();
  readonly list: Check1Finding[] = [];
  add(code: Check1Code, where: string): void {
    const key = `${code}\u0000${where}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ code, where, he: CHECK1_HE[code] });
  }
}

/** A position string safe to carry: a part name or number never brings markup or controls along. */
const safeWhere = (s: string) => s.replace(/[^\p{L}\p{N} ._/\-[\]>:,]/gu, '?').slice(0, 200);

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const normalise = (s: string) => stripBidiControls(s).replace(/\s+/g, ' ').trim();

function hasForeignBidi(text: string): boolean {
  for (const ch of text) {
    if (stripBidiControls(ch) === '' && !RENDERER_BIDI_CONTROLS.has(ch)) return true;
  }
  return false;
}

const HEBREW = /[֐-׿]/;
const DIGIT_RUN = /\d+(?:[,.:/]\d+)*/g;
const reverseString = (s: string) => [...s].reverse().join('');
const digitsOnly = (s: string) => s.replace(/\D/g, '');

async function guardArchive(bytes: Buffer, label: string, f: Findings): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'check1-'));
  try {
    const path = join(dir, 'file.zip');
    await writeFile(path, bytes);
    const verdict = await inspectArchive(path);
    if (verdict.ok) return true;
    f.add(verdict.code === 'archive_malformed' ? 'file_unreadable' : 'unsafe_part', `${label}archive ${verdict.code}`);
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Part allowlist, external relationships and content types of one zip. */
async function checkZipParts(zip: JSZip, allow: readonly RegExp[], label: string, f: Findings): Promise<void> {
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (!allow.some((re) => re.test(name))) {
      f.add('unsafe_part', `part ${label}${safeWhere(name)}`);
      continue;
    }
    if (name.endsWith('.rels')) {
      const xml = await zip.file(name)!.async('string');
      if (EXTERNAL_TARGET.test(xml)) f.add('unsafe_part', `part ${label}${safeWhere(name)}`);
    }
  }
  const types = await zip.file('[Content_Types].xml')?.async('string');
  if (types === undefined) f.add('file_unreadable', `part ${label}[Content_Types].xml`);
  else if (UNSAFE_CONTENT_TYPE.test(types)) f.add('unsafe_part', `part ${label}[Content_Types].xml`);
}

async function loadZip(bytes: Buffer, format: ZipFormat, f: Findings): Promise<JSZip | null> {
  if (!(await guardArchive(bytes, '', f))) return null;
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    f.add('file_unreadable', 'archive');
    return null;
  }
  await checkZipParts(zip, PART_ALLOWLIST[format], '', f);
  return zip;
}

const xmlTexts = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => decodeXml(m[1] ?? ''));

const partsMatching = (zip: JSZip, re: RegExp) =>
  Object.keys(zip.files)
    .filter((n) => re.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0));

// ---------------------------------------------------------------- xlsx

interface FileFormula {
  sheet: number;
  sheetName: string;
  address: string;
  formula: string;
  cached: unknown;
}

const DAY_MS = 86_400_000;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function isErrorValue(v: unknown): v is { error: string } {
  return typeof v === 'object' && v !== null && 'error' in v;
}

/** A cached formula result as the evaluator would state it. */
function cachedValue(v: unknown): EvalValue | undefined {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Date) return (v.getTime() - EXCEL_EPOCH_MS) / DAY_MS;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  return undefined;
}

function sameValue(computed: EvalValue, cached: EvalValue): boolean {
  if (typeof computed === 'number' && typeof cached === 'number') {
    return Math.abs(computed - cached) <= 1e-9 * Math.max(1, Math.abs(computed));
  }
  return computed === cached;
}

function directRefs(ast: FormulaAst, out: { sheet: string | null; address: string }[]): void {
  switch (ast.type) {
    case 'ref':
      out.push({ sheet: ast.sheet, address: formatAddress(ast.at) });
      return;
    case 'unary':
    case 'percent':
      directRefs(ast.arg, out);
      return;
    case 'binary':
      directRefs(ast.left, out);
      directRefs(ast.right, out);
      return;
    case 'call':
      ast.args.forEach((a) => directRefs(a, out));
      return;
    default:
      return;
  }
}

async function checkXlsx(input: Check1Input, f: Findings, ownText: string[]): Promise<void> {
  const zip = await loadZip(input.bytes, 'xlsx', f);
  if (zip === null) return;
  const workbookXml = (await zip.file('xl/workbook.xml')?.async('string')) ?? '';
  if (/<definedNames?[\s>]/.test(workbookXml)) f.add('unsafe_part', 'workbook defined names');

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(input.bytes as unknown as ArrayBuffer);
  } catch {
    f.add('file_unreadable', 'workbook');
    return;
  }
  const rtl = input.spec.language === 'he';
  const evalSheets: EvalSheet[] = [];
  const filled = new Map<string, Set<string>>();
  const formulas: FileFormula[] = [];

  wb.worksheets.forEach((ws, i) => {
    ownText.push(ws.name);
    if ((ws.views?.[0]?.rightToLeft === true) !== rtl) f.add('direction_wrong', `sheet ${i + 1}`);
    const cells = new Map<string, SheetCellInput>();
    const present = new Set<string>();
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const address = cell.address.replace(/\$/g, '').toUpperCase();
        const v = cell.value as unknown;
        let input: SheetCellInput = null;
        if (typeof v === 'number' || typeof v === 'boolean') input = v;
        else if (typeof v === 'string') input = v;
        else if (v instanceof Date) input = (v.getTime() - EXCEL_EPOCH_MS) / DAY_MS;
        else if (typeof v === 'object' && v !== null) {
          if ('formula' in v || 'sharedFormula' in v) {
            const formula = cell.formula;
            input = { f: formula };
            formulas.push({ sheet: i, sheetName: ws.name, address, formula, cached: (v as { result?: unknown }).result });
          } else if ('richText' in v) {
            input = (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('');
          } else if ('error' in v) {
            f.add('formula_error', `sheet ${i + 1} ${address}`);
          } else if ('text' in v) {
            input = String((v as { text: unknown }).text);
          }
        }
        if (typeof input === 'string') ownText.push(input);
        if (input !== null && input !== '') present.add(address);
        cells.set(address, input);
      });
    });
    evalSheets.push({ name: ws.name, cells });
    filled.set(ws.name.toUpperCase(), present);
  });

  let evaluation: ReturnType<typeof evaluateWorkbook>;
  try {
    evaluation = evaluateWorkbook(evalSheets);
  } catch {
    f.add('formula_problem', 'workbook');
    return;
  }
  for (const cell of formulas) {
    const where = `sheet ${cell.sheet + 1} ${cell.address}`;
    const parsed = parseFormula(cell.formula);
    if (!parsed.ok) {
      f.add('formula_problem', where);
      continue;
    }
    const refs: { sheet: string | null; address: string }[] = [];
    directRefs(parsed.ast, refs);
    if (refs.some((r) => !(filled.get((r.sheet ?? cell.sheetName).toUpperCase())?.has(r.address) ?? false))) {
      f.add('formula_error', where);
    }
    const key = `${cell.sheetName}!${cell.address}`;
    if (evaluation.deviated.has(key)) {
      f.add('formula_problem', where);
      continue;
    }
    const computed = evaluation.values.get(key);
    if (computed === undefined || isErrorValue(computed) || isErrorValue(cell.cached)) {
      f.add('formula_error', where);
      continue;
    }
    const cached = cachedValue(cell.cached);
    if (cached === undefined || !sameValue(computed, cached)) f.add('formula_mismatch', where);
  }
}

// ---------------------------------------------------------------- docx

const W_PARAGRAPH = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const W_RUN = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
const isOn = (xml: string, tag: string) => {
  const m = new RegExp(`<${tag}(\\s[^>]*)?/?>`).exec(xml);
  if (!m) return false;
  return !/w:val\s*=\s*["'](?:0|false|off)["']/.test(m[1] ?? '');
};

interface Contract {
  disclaimer: string;
  heading: string;
  signature: string;
}

const CONTRACT_HE: Contract = { disclaimer: CONTRACT_DISCLAIMER_HE, heading: 'הבסיס החוקי', signature: 'חתימת צד א׳' };
const CONTRACT_EN: Contract = { disclaimer: CONTRACT_DISCLAIMER_EN, heading: 'Legal basis', signature: 'Party A signature' };

/** D6 structure of a contract, looked for in the text the file carries. */
function checkContract(spec: DocumentSpec, body: string, footer: string, f: Findings): void {
  if (spec.kind !== 'contract') return;
  const c = spec.language === 'he' ? CONTRACT_HE : CONTRACT_EN;
  const b = normalise(body);
  if (!normalise(footer).includes(normalise(c.disclaimer))) f.add('missing_structure', 'disclaimer');
  const laws = (spec.legalBasis ?? []).map((l) => normalise(l.law));
  if (!b.includes(normalise(c.heading)) || laws.length === 0 || laws.some((l) => !b.includes(l))) {
    f.add('missing_structure', 'legal basis');
  }
  if (!b.includes(normalise(c.signature))) f.add('missing_structure', 'signatures');
}

async function checkDocx(input: Check1Input, f: Findings, ownText: string[]): Promise<string | null> {
  const zip = await loadZip(input.bytes, 'docx', f);
  if (zip === null) return null;
  const rtl = input.spec.language === 'he';
  const parts = partsMatching(zip, /^word\/(?:document|footer\d+|header\d+)\.xml$/);
  let body = '';
  let footer = '';
  for (const name of parts) {
    const xml = await zip.file(name)!.async('string');
    const lines: string[] = [];
    let wrong = false;
    for (const p of xml.match(W_PARAGRAPH) ?? []) {
      const text = xmlTexts(p, 'w:t').join('');
      if (text.length === 0) continue;
      lines.push(text);
      const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(p)?.[0] ?? '';
      if (isOn(pPr, 'w:bidi') !== rtl) wrong = true;
      for (const r of p.match(W_RUN) ?? []) {
        const runText = xmlTexts(r, 'w:t').join('');
        const runRtl = isOn(/<w:rPr>[\s\S]*?<\/w:rPr>/.exec(r)?.[0] ?? '', 'w:rtl');
        if (rtl ? HEBREW.test(runText) && !runRtl : runRtl) wrong = true;
      }
    }
    if (wrong) f.add('direction_wrong', name);
    const all = lines.join('\n');
    if (hasForeignBidi(all)) f.add('bidi_control', name);
    ownText.push(all);
    if (name === 'word/document.xml') body = all;
    else footer += `\n${all}`;
  }
  checkContract(input.spec, body, footer, f);
  try {
    return (await mammoth.extractRawText({ buffer: input.bytes })).value;
  } catch {
    f.add('file_unreadable', 'docx text');
    return null;
  }
}

// ---------------------------------------------------------------- pptx

async function checkPptx(input: Check1Input, f: Findings, ownText: string[]): Promise<void> {
  const zip = await loadZip(input.bytes, 'pptx', f);
  if (zip === null) return;
  for (const name of Object.keys(zip.files).filter((n) => EMBEDDED_CHART_WORKBOOK.test(n))) {
    const label = `${name} > `;
    const inner = await zip.file(name)!.async('nodebuffer');
    if (!(await guardArchive(inner, label, f))) continue;
    try {
      await checkZipParts(await JSZip.loadAsync(inner), CHART_WORKBOOK_ALLOWLIST, label, f);
    } catch {
      f.add('file_unreadable', `part ${label}`);
    }
  }
  const rtl = input.spec.language === 'he';
  for (const name of partsMatching(zip, /^ppt\/slides\/slide\d+\.xml$/)) {
    const xml = await zip.file(name)!.async('string');
    const n = /(\d+)\.xml$/.exec(name)?.[1] ?? '?';
    let wrong = false;
    const lines: string[] = [];
    for (const p of xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []) {
      const text = xmlTexts(p, 'a:t').join('');
      if (text.length === 0) continue;
      lines.push(text);
      const isRtl = /<a:pPr\s[^>]*\brtl\s*=\s*["']1["']/.test(p);
      if (isRtl !== rtl) wrong = true;
    }
    if (wrong) f.add('direction_wrong', `slide ${n}`);
    const all = lines.join('\n');
    if (hasForeignBidi(all)) f.add('bidi_control', `slide ${n}`);
    ownText.push(all);
  }
}

// ---------------------------------------------------------------- pdf

function checkPdf(input: Check1Input, f: Findings): void {
  const raw = input.bytes.toString('latin1');
  if (!raw.startsWith('%PDF-')) {
    f.add('file_unreadable', 'pdf');
    return;
  }
  for (const m of raw.matchAll(/\/([^\s/<>[\]()%{}]+)/g)) {
    const name = (m[1] ?? '').replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    if (PDF_FORBIDDEN_NAMES.has(name)) f.add('unsafe_part', `pdf /${name}`);
  }
  const text = input.rendered.text;
  checkContract(input.spec, text, text, f);
}

// ---------------------------------------------------------------- text

interface TextRun {
  where: string;
  text: string;
}

/** Every piece of spec text as the renderers put it on the page. */
function specTextRuns(spec: DocumentSpec, currency: string): { runs: TextRun[]; numbers: string[] } {
  // docx/pdf print the title as the first line; xlsx/pptx keep it as file metadata only.
  const runs: TextRun[] = spec.format === 'docx' || spec.format === 'pdf' ? [{ where: 'title', text: spec.title }] : [];
  const numbers: string[] = [];
  const cells = (where: string, header: string[], rows: Cell[][], numberFormat?: readonly string[]) => {
    header.forEach((h, c) => runs.push({ where: `${where} header col ${c + 1}`, text: h }));
    rows.forEach((row, r) =>
      row.forEach((cell, c) => {
        if ('t' in cell) runs.push({ where: `${where} row ${r + 1} col ${c + 1}`, text: cell.t });
        else if ('v' in cell) {
          const fmt = numberFormat?.[c] as 'int' | 'money' | 'percent' | 'decimal2' | undefined;
          numbers.push(formatNumber(cell.v, fmt, currency));
        }
      }),
    );
  };
  const blocks = (list: Block[]) => {
    let clause = 0;
    list.forEach((b, i) => {
      const where = `block ${i + 1}`;
      switch (b.type) {
        case 'heading':
        case 'paragraph':
          b.text.split(/\r?\n/).forEach((line) => runs.push({ where, text: line }));
          return;
        case 'list':
          b.items.forEach((item, j) => runs.push({ where: `${where} item ${j + 1}`, text: item }));
          return;
        case 'table':
          cells(where, b.header, b.rows, b.numberFormat);
          return;
        case 'clause': {
          clause += 1;
          const numbered = numberClause(clause, b.title, b.text);
          runs.push({ where: `${where} title`, text: numbered.title });
          numbered.lines.forEach((line, j) =>
            runs.push({ where: numbered.lines.length === 1 ? where : `${where} line ${j + 1}`, text: line.text }),
          );
          return;
        }
        case 'pageBreak':
        case 'image':
          return;
      }
    });
  };
  switch (spec.format) {
    case 'docx':
    case 'pdf':
      blocks(spec.blocks);
      if (spec.kind === 'contract') {
        spec.legalBasis?.forEach((l, i) => {
          runs.push({ where: `legalBasis ${i + 1}`, text: l.law });
          if (l.note !== undefined) runs.push({ where: `legalBasis ${i + 1} note`, text: l.note });
        });
      }
      break;
    case 'pptx':
      spec.slides.forEach((s, i) => {
        const where = `slide ${i + 1}`;
        if (s.type === 'title') runs.push({ where: `${where} title`, text: s.title });
        else if ('title' in s && s.title !== undefined) {
          runs.push({ where: `${where} title`, text: stripOwnNumber(s.title, i + 1).trim() });
        }
        switch (s.type) {
          case 'title':
            if (s.subtitle !== undefined) runs.push({ where: `${where} subtitle`, text: s.subtitle });
            return;
          case 'titleBullets':
            s.bullets.forEach((b, j) => runs.push({ where: `${where} bullet ${j + 1}`, text: b }));
            return;
          case 'table':
            cells(where, s.header, s.rows, s.numberFormat);
            return;
          case 'imageText':
          case 'paragraph':
            runs.push({ where, text: s.text });
            return;
          case 'chart':
          case 'collage':
            return; // chart text lives in the chart part, not on the page text layer
        }
      });
      break;
    case 'xlsx':
      spec.sheets.forEach((sheet, si) =>
        sheet.tables.forEach((t, ti) => {
          const where = `sheet ${si + 1} table ${ti + 1}`;
          if (t.title !== undefined) runs.push({ where: `${where} title`, text: t.title });
          cells(where, t.header, [...t.rows, ...(t.totals === undefined ? [] : [t.totals])], t.numberFormat);
        }),
      );
      break;
  }
  return { runs, numbers };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `s` as a pattern in which every digit sequence is a capture group: the words fixed, the digits read off the page. */
function shapePattern(s: string): { pattern: RegExp; tokens: string[] } {
  const tokens = s.match(DIGIT_RUN) ?? [];
  const literal = s.split(DIGIT_RUN).map(escapeRegExp);
  return { pattern: new RegExp(literal.join(String.raw`(\d+(?:[,.:/]\d+)*)`), 'g'), tokens };
}

type Placement = 'exact' | 'digits_reversed' | 'mismatch';

/**
 * Where `candidate`'s words appear on the page, how do its digit sequences
 * read there? `original(i)` is the digit sequence the spec wrote for the
 * i-th one. The best placement wins: exact over reversed over a different number.
 */
function placement(candidate: string, t: string, original: (token: string) => string): Placement | null {
  const { pattern, tokens } = shapePattern(candidate);
  let best: Placement | null = null;
  for (const m of t.matchAll(pattern)) {
    let result: Placement = 'exact';
    tokens.forEach((token, i) => {
      const want = original(token);
      const got = m[i + 1] ?? '';
      if (got === want) return;
      if (got === reverseString(want)) {
        if (result === 'exact') result = 'digits_reversed';
      } else result = 'mismatch';
    });
    if (result === 'exact') return result;
    if (best === null || (best === 'mismatch' && result === 'digits_reversed')) best = result;
  }
  return best;
}

function checkOrder(runs: TextRun[], numbers: string[], extracted: string, f: Findings): void {
  const t = normalise(extracted);
  for (const run of runs) {
    const text = normalise(run.text);
    if (text.split(' ').length < 2) {
      if (text.length > 0) numbers.push(text);
      continue;
    }
    if (t.includes(text)) continue;
    const asWritten = placement(text, t, (tok) => tok);
    if (asWritten === 'digits_reversed') {
      f.add('digits_reversed', run.where);
      continue;
    }
    // Reversed word by word (digits kept), or character by character (a visual-order extraction).
    const byWord = placement(text.split(' ').reverse().join(' '), t, (tok) => tok);
    const byChar = placement(reverseString(text), t, reverseString);
    const reversed = [byWord, byChar].filter((p): p is Placement => p !== null && p !== 'mismatch');
    if (reversed.length > 0) {
      f.add('order_reversed', run.where);
      if (!reversed.includes('exact')) f.add('digits_reversed', run.where);
      continue;
    }
    f.add('text_missing', run.where);
  }
  // A number the spec shows, absent from the page while its digits reversed are present.
  const onPage = new Set((t.match(DIGIT_RUN) ?? []).map(digitsOnly));
  for (const shown of numbers) {
    for (const token of shown.match(DIGIT_RUN) ?? []) {
      const fwd = digitsOnly(token);
      const rev = reverseString(fwd);
      if (fwd.length >= 2 && rev !== fwd && !onPage.has(fwd) && onPage.has(rev)) f.add('digits_reversed', `number ${fwd}`);
    }
  }
}

/** Numbers the page carries by structure: page numbers, clause and list numbers, cited laws. */
function structuralPool(spec: DocumentSpec, pageCount: number): string[] {
  let top = Math.max(1, pageCount);
  const labels: string[] = [];
  if (spec.format === 'docx' || spec.format === 'pdf') {
    let clause = 0;
    for (const b of spec.blocks) {
      if (b.type === 'list') top = Math.max(top, b.items.length);
      if (b.type === 'clause') {
        clause += 1;
        for (const line of numberClause(clause, b.title, b.text).lines) if (line.label !== null) labels.push(line.label);
      }
    }
    top = Math.max(top, clause);
  }
  if (spec.format === 'pptx') top = Math.max(top, spec.slides.length);
  if (spec.format === 'xlsx') top = Math.max(top, spec.sheets.length);
  const ints = Array.from({ length: top }, (_, i) => String(i + 1)).join(' ');
  return [ints, labels.join(' '), ...(spec.legalBasis ?? []).map((l) => l.law)];
}

// ---------------------------------------------------------------- entry

/** The currency only shapes the symbol around digits; digits are what the order check compares. */
const DIGITS_CURRENCY = 'ILS';

export async function runCheck1(input: Check1Input): Promise<Check1Result> {
  const { spec, sources, rendered, today } = input;
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new TypeError('runCheck1: today must be the charter-local date as YYYY-MM-DD');
  }
  const f = new Findings();

  for (const p of validateSpec(spec, sources, { today })) f.add(SPEC_CODE[p.code], p.where);

  if (rendered.pageCount > CAPS.pages) f.add('cap_exceeded', 'document');
  if (rendered.textTruncated) f.add('text_truncated', 'document');

  const ownText: string[] = [];
  let fileText: string | null = null;
  switch (spec.format) {
    case 'xlsx':
      await checkXlsx(input, f, ownText);
      break;
    case 'docx':
      fileText = await checkDocx(input, f, ownText);
      break;
    case 'pptx':
      await checkPptx(input, f, ownText);
      break;
    case 'pdf':
      checkPdf(input, f);
      if (hasForeignBidi(rendered.text)) f.add('bidi_control', 'rendered text');
      break;
  }
  if (spec.format === 'xlsx' && ownText.some(hasForeignBidi)) f.add('bidi_control', 'workbook');

  if (!rendered.textTruncated) {
    const { runs, numbers } = specTextRuns(spec, DIGITS_CURRENCY);
    checkOrder(runs, [...numbers], rendered.text, f);
    if (fileText !== null) checkOrder(runs, [...numbers], fileText, f);
    const grounder = createTextGrounder(spec, sources, { today, extraPool: structuralPool(spec, rendered.pageCount) });
    for (const missing of grounder(normalise(rendered.text))) f.add('ungrounded_number', `rendered text: ${safeWhere(missing)}`);
  }

  return { passed: f.list.length === 0, findings: f.list };
}
