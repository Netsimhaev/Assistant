import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  Cell,
  DocumentFormat,
  DocumentKind,
  DocumentSpec,
  ProductionStage,
} from './document-spec.js';
import { documentFormatLabel, documentKindLabel, productionStageLabel } from './labels.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const base = {
  language: 'he',
  kind: 'report',
  title: 'דוח',
  filename: 'report',
  style: { theme: 'clean', accent: 'navy' },
  sources: [{ kind: 'instruction' }],
};
const xlsx = (over: object = {}): Record<string, unknown> => ({
  ...base,
  format: 'xlsx',
  sheets: [
    {
      name: 'a',
      tables: [{ header: ['x'], rows: [[{ v: 1, src: { kind: 'instruction' } }]] }],
    },
  ],
  ...over,
});
const docx = (blocks: unknown[]) => ({ ...base, format: 'docx', blocks });

describe('DocumentSpec', () => {
  it('accepts a valid spec (the code under test runs)', () => {
    expect(DocumentSpec.safeParse(xlsx()).success).toBe(true);
    expect(DocumentSpec.safeParse(docx([{ type: 'paragraph', text: 'hi' }])).success).toBe(true);
    expect(
      DocumentSpec.safeParse({ ...docx([{ type: 'pageBreak' }]), format: 'pdf' }).success,
    ).toBe(true);
  });

  it('rejects an unknown key at every level', () => {
    expect(DocumentSpec.safeParse(xlsx({ extra: 1 })).success).toBe(false);
    const sheet = xlsx() as { sheets: Array<Record<string, unknown>> };
    sheet.sheets[0]!['extra'] = 1;
    expect(DocumentSpec.safeParse(sheet).success).toBe(false);
    const cleanSheet = xlsx() as { sheets: Array<Record<string, unknown>> };
    expect(DocumentSpec.safeParse(cleanSheet).success).toBe(true);
    expect(Cell.safeParse({ t: 'a' }).success).toBe(true);
    expect(Cell.safeParse({ t: 'a', extra: 1 }).success).toBe(false);
    expect(DocumentSpec.safeParse(docx([{ type: 'paragraph', text: 'x' }])).success).toBe(true);
    expect(
      DocumentSpec.safeParse(docx([{ type: 'paragraph', text: 'x', extra: 1 }])).success,
    ).toBe(false);
  });

  it('contract without legalBasis fails', () => {
    const c = docx([{ type: 'clause', title: 't', text: 'x' }]);
    expect(DocumentSpec.safeParse({ ...c, kind: 'contract' }).success).toBe(false);
    expect(DocumentSpec.safeParse({ ...c, kind: 'contract', legalBasis: [] }).success).toBe(false);
    expect(
      DocumentSpec.safeParse({ ...c, kind: 'contract', legalBasis: [{ law: 'חוק החוזים' }] }).success,
    ).toBe(true);
  });

  it('cell number without src fails', () => {
    expect(Cell.safeParse({ v: 5 }).success).toBe(false);
    expect(Cell.safeParse({ v: 5, src: { kind: 'instruction' } }).success).toBe(true);
  });

  it('formula cell is a string without leading =', () => {
    expect(Cell.safeParse({ f: 'SUM(A1:A3)' }).success).toBe(true);
    expect(Cell.safeParse({ f: '=SUM(A1:A3)' }).success).toBe(false);
    expect(Cell.safeParse({ f: 3 }).success).toBe(false);
  });

  it('language defaults are not inferred — language is required', () => {
    const noLang = xlsx();
    delete noLang['language'];
    expect(DocumentSpec.safeParse(noLang).success).toBe(false);
    expect(DocumentSpec.safeParse(xlsx()).success).toBe(true);
  });

  it('a SourceRef documentId of "__proto__" fails', () => {
    expect(
      Cell.safeParse({ v: 1, src: { kind: 'document', documentId: '__proto__', ordinal: 0 } }).success,
    ).toBe(false);
    expect(
      Cell.safeParse({ v: 1, src: { kind: 'document', documentId: 'DOC-1', ordinal: 0 } }).success,
    ).toBe(true);
    expect(
      DocumentSpec.safeParse(docx([{ type: 'image', documentId: 'DOC-1' }])).success,
    ).toBe(true);
    expect(
      DocumentSpec.safeParse(docx([{ type: 'image', documentId: 'constructor' }])).success,
    ).toBe(false);
  });

  it('rejects an unknown key in a table, a slide, style and a legalBasis entry', () => {
    const tbl = { header: ['x'], rows: [[{ t: 'a' }]] };
    const withTable = (t: object) => xlsx({ sheets: [{ name: 'a', tables: [t] }] });
    expect(DocumentSpec.safeParse(withTable(tbl)).success).toBe(true);
    expect(DocumentSpec.safeParse(withTable({ ...tbl, extra: 1 })).success).toBe(false);

    const pptx = (slide: object) => ({ ...base, format: 'pptx', slides: [slide] });
    const slide = { type: 'titleBullets', title: 't', bullets: ['b'] };
    expect(DocumentSpec.safeParse(pptx(slide)).success).toBe(true);
    expect(DocumentSpec.safeParse(pptx({ ...slide, extra: 1 })).success).toBe(false);

    expect(DocumentSpec.safeParse(xlsx({ style: { theme: 'clean', accent: 'navy' } })).success).toBe(true);
    expect(
      DocumentSpec.safeParse(xlsx({ style: { theme: 'clean', accent: 'navy', x: 1 } })).success,
    ).toBe(false);

    const contract = (lb: object) => ({
      ...docx([{ type: 'clause', title: 't', text: 'x' }]),
      kind: 'contract',
      legalBasis: [lb],
    });
    expect(DocumentSpec.safeParse(contract({ law: 'חוק' })).success).toBe(true);
    expect(DocumentSpec.safeParse(contract({ law: 'חוק', extra: 1 })).success).toBe(false);
  });

  it('a d cell must be a real calendar date', () => {
    expect(Cell.safeParse({ d: '2026-02-28' }).success).toBe(true);
    expect(Cell.safeParse({ d: '2028-02-29' }).success).toBe(true);
    expect(Cell.safeParse({ d: '2026-13-45' }).success).toBe(false);
    expect(Cell.safeParse({ d: '2026-02-30' }).success).toBe(false);
  });
});

describe('labels are exhaustive', () => {
  it('every enum option has a non-empty Hebrew label', () => {
    for (const k of DocumentKind.options) expect(documentKindLabel[k]).toMatch(/\S/);
    for (const f of DocumentFormat.options) expect(documentFormatLabel[f].length).toBeGreaterThan(0);
    for (const s of ProductionStage.options) expect(productionStageLabel[s]).toMatch(/[֐-׿]/);
  });
});

describe('migration 053', () => {
  const insert = (w: boolean, e: boolean, s: boolean) =>
    getPool().query(
      `INSERT INTO document_settings (business_id, to_whatsapp, to_email, to_screen) VALUES ('b1',$1,$2,$3)`,
      [w, e, s],
    );

  it('document_settings accepts one channel (the code under test runs)', async () => {
    await insert(false, false, true);
    const r = await getPool().query('SELECT count(*)::int AS n FROM document_settings');
    expect(r.rows[0].n).toBe(1);
  });

  it('document_settings refuses a row with all three channels false', async () => {
    await expect(insert(false, false, false)).rejects.toThrow(
      /document_settings_at_least_one_channel/,
    );
  });

  it('document_versions refuses a non-hex sha256 and a duplicate version number', async () => {
    await getPool().query(
      `INSERT INTO document_productions (production_id,business_id,origin_job_id,instruction_text,text_origin,format,language,kind,destination)
       VALUES ('P1','b1','j','x','typed','xlsx','he','report','{"mode":"save","folder":"f"}')`,
    );
    const ins = (sha: string, no: number) =>
      getPool().query(
        `INSERT INTO document_versions (version_id,production_id,version_no,spec,stored_path,sha256,size_bytes)
         VALUES (gen_random_uuid()::text,'P1',$2,'{}','p',$1,1)`,
        [sha, no],
      );
    await expect(ins('ZZ', 1)).rejects.toThrow(/document_versions_sha256_hex/);
    await ins('a'.repeat(64), 1);
    await expect(ins('b'.repeat(64), 1)).rejects.toThrow(/document_versions_unique_no/);
    await expect(
      getPool().query(`UPDATE document_productions SET stage='bogus' WHERE production_id='P1'`),
    ).rejects.toThrow(/document_productions_stage_known/);
  });
});
