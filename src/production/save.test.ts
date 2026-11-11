import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, getPool, withBusiness } from '../db/pool.js';
import type { XlsxSpec } from '../domain/document-spec.js';
import { documentKindLabel } from '../domain/labels.js';
import { saveDocumentSettings } from '../governance/document-settings.js';
import { runLocalTool } from '../orchestrator/local-tools.js';
import { StepChannelError } from '../orchestrator/step-error.js';
import { resetDatabase, TEST_BUSINESS } from '../test/db.js';
import { resolveSaveTarget, saveVersionToFolder, SAVE_FAILURE_HE } from './save.js';
import { createProduction, saveVersion } from './store.js';

const B = 'test-business';
const OTHER = 'other-business';
const DIR = `produced/__save-test-${process.pid}`;
const JOB = 'J-deliver';

/** A junction on Windows (a plain dir symlink needs admin there); a dir symlink elsewhere. */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

let scratch: string;
let base: string;
let outside: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'doc-save-'));
  base = join(scratch, 'base');
  outside = join(scratch, 'outside');
  await mkdir(base);
  await mkdir(outside);
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Everything under a directory, recursively, relative — to prove nothing was written. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    out.push(entry.name);
    if (entry.isDirectory()) for (const child of await tree(full)) out.push(`${entry.name}/${child}`);
  }
  return out.sort();
}

describe('resolveSaveTarget — Review Focus 3, refused in Hebrew and nothing written', () => {
  const refusals: { folder: string; why: string }[] = [
    { folder: '../../Windows', why: 'parent traversal' },
    { folder: 'C:\\x', why: 'drive letter' },
    { folder: 'c:x', why: 'drive-relative' },
    { folder: 'חוזים/../..', why: 'traversal after a real segment' },
    { folder: 'CON', why: 'reserved name' },
    { folder: 'con.txt', why: 'reserved name with extension, lower case' },
    { folder: 'לקוחות/Lpt9', why: 'reserved name deeper' },
    { folder: 'COM1 ', why: 'reserved name with a trailing space' },
    { folder: 'a/b/c/d/e/f', why: 'six segments' },
    { folder: '/etc', why: 'absolute posix' },
    { folder: '\\\\server\\share', why: 'UNC' },
    { folder: '.git', why: 'leading dot' },
    { folder: 'a//b', why: 'empty segment' },
    { folder: 'חוזים<x>', why: 'character outside the allowlist' },
    { folder: 'a.', why: 'trailing dot (Windows aliases it)' },
    { folder: 'x'.repeat(201), why: 'over 200 chars' },
    { folder: 'א'.repeat(128), why: 'a segment over 255 UTF-8 bytes' },
    { folder: 'COM¹', why: 'superscript device digit' },
    { folder: 'שָׁלוֹם', why: 'niqqud (combining marks are outside the allowlist)' },
  ];
  for (const { folder, why } of refusals) {
    it(`refuses ${JSON.stringify(folder.slice(0, 30))} (${why})`, async () => {
      const result = await resolveSaveTarget(base, folder, 'contract', 'חוזה.docx');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.he).toMatch(/[א-ת]/);
      expect(await tree(base)).toEqual([]);
      expect(await tree(outside)).toEqual([]);
    });
  }

  it('accepts five segments and 200 chars, and creates them inside the base', async () => {
    const result = await resolveSaveTarget(base, 'a/b/c/d/e', 'contract', 'חוזה.docx');
    expect(result).toMatchObject({ ok: true, name: 'חוזה.docx' });
    if (result.ok) expect(result.dir).toBe(join(await realpath(base), 'a', 'b', 'c', 'd', 'e'));
    const long = await resolveSaveTarget(base, 'y'.repeat(200), 'contract', 'חוזה.docx');
    expect(long.ok).toBe(true);
  });

  it('accepts either separator and Hebrew, digits, space, dash, underscore and an inner dot', async () => {
    const result = await resolveSaveTarget(base, 'לקוחות\\אלפא בע-מ_2026/v1.2', 'contract', 'חוזה.docx');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dir).toBe(join(await realpath(base), 'לקוחות', 'אלפא בע-מ_2026', 'v1.2'));
  });

  it('strips bidi controls before checking', async () => {
    const result = await resolveSaveTarget(base, 'חוזים\u202E', 'contract', 'חוזה.docx');
    expect(result.ok).toBe(true);
    expect(await tree(base)).toEqual(['חוזים']);
  });

  it('a null folder maps to the document kind label', async () => {
    const result = await resolveSaveTarget(base, null, 'profit_table', 'רווחיות.xlsx');
    expect(result.ok).toBe(true);
    expect(await tree(base)).toEqual([documentKindLabel.profit_table]);
  });

  it('refuses a filename that breaks the same rules', async () => {
    for (const name of ['../x.docx', 'CON.docx', 'a/b.docx', '.hidden.docx', 'a<b.docx']) {
      const result = await resolveSaveTarget(base, 'חוזים', 'contract', name);
      expect(result.ok, name).toBe(false);
    }
    expect(await tree(base)).toEqual([]);
  });

  it('refuses a symlink inside base pointing out, and writes nothing on either side', async () => {
    await symlink(outside, join(base, 'escape'), LINK_TYPE);
    expect((await lstat(join(base, 'escape'))).isSymbolicLink()).toBe(true);

    const direct = await resolveSaveTarget(base, 'escape', 'contract', 'חוזה.docx');
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.he).toMatch(/[א-ת]/);

    const through = await resolveSaveTarget(base, 'escape/sub', 'contract', 'חוזה.docx');
    expect(through.ok).toBe(false);

    expect(await tree(outside)).toEqual([]);
    expect(await tree(base)).toEqual(['escape']);
  });

  it('refuses a symlink even when it points back inside the base', async () => {
    await mkdir(join(base, 'real'));
    await symlink(join(base, 'real'), join(base, 'alias'), LINK_TYPE);
    const result = await resolveSaveTarget(base, 'alias', 'contract', 'חוזה.docx');
    expect(result.ok).toBe(false);
    expect(await tree(join(base, 'real'))).toEqual([]);
  });

  it('refuses an existing segment that is a file, not a directory', async () => {
    await writeFile(join(base, 'file'), 'x');
    const result = await resolveSaveTarget(base, 'file/sub', 'contract', 'חוזה.docx');
    expect(result.ok).toBe(false);
  });

  it('follows a base folder that is itself reached through a link, and stays inside its realpath', async () => {
    await symlink(base, join(scratch, 'base-link'), LINK_TYPE);
    const result = await resolveSaveTarget(join(scratch, 'base-link'), 'חוזים', 'contract', 'חוזה.docx');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dir.startsWith((await realpath(base)) + sep)).toBe(true);
    }
    expect(await tree(base)).toEqual(['חוזים']);
  });
});

describe('saveVersionToFolder', () => {
  const bytes = Buffer.from('PK\x03\x04 xlsx bytes');

  it('writes the exact bytes, and the written bytes hash equals the version sha', async () => {
    const result = await saveVersionToFolder(base, 'רווחיות.xlsx', bytes, sha(bytes));
    expect(result).toEqual({ ok: true, path: join(base, 'רווחיות.xlsx') });
    const written = await readFile(join(base, 'רווחיות.xlsx'));
    expect(sha(written)).toBe(sha(bytes));
  });

  it('never overwrites: an existing file → "name (2).xlsx", then " (3)"', async () => {
    await writeFile(join(base, 'רווחיות.xlsx'), 'owner file');
    const second = await saveVersionToFolder(base, 'רווחיות.xlsx', bytes, sha(bytes));
    expect(second).toEqual({ ok: true, path: join(base, 'רווחיות (2).xlsx') });
    const third = await saveVersionToFolder(base, 'רווחיות.xlsx', bytes, sha(bytes));
    expect(third).toEqual({ ok: true, path: join(base, 'רווחיות (3).xlsx') });
    expect(await readFile(join(base, 'רווחיות.xlsx'), 'utf8')).toBe('owner file');
  });

  it('refuses in Hebrew past " (99)", and writes nothing', async () => {
    await writeFile(join(base, 'a.xlsx'), 'x');
    for (let n = 2; n <= 99; n++) await writeFile(join(base, `a (${n}).xlsx`), 'x');
    const before = await tree(base);
    const result = await saveVersionToFolder(base, 'a.xlsx', bytes, sha(bytes));
    expect(result).toEqual({ ok: false, code: 'save_names_exhausted', he: SAVE_FAILURE_HE.save_names_exhausted });
    expect(await tree(base)).toEqual(before);
  });

  it('refuses in Hebrew when the " (2)" suffix would push the name past 255 UTF-8 bytes', async () => {
    const name = `${'א'.repeat(125)}.xlsx`; // exactly 255 bytes — allowed
    await writeFile(join(base, name), 'owner file');
    const result = await saveVersionToFolder(base, name, bytes, sha(bytes));
    expect(result).toMatchObject({ ok: false, code: 'save_folder_refused' });
    if (!result.ok) expect(result.he).toMatch(/[א-ת]/);
    expect(await tree(base)).toEqual([name]);
  });

  it('a read-back that throws discards what was written before rethrowing', async () => {
    let called = 0;
    const failing = async (): Promise<Buffer> => {
      called++;
      throw new Error('read-back exploded');
    };
    await expect(saveVersionToFolder(base, 'a.xlsx', bytes, sha(bytes), { readBack: failing })).rejects.toThrow(
      'read-back exploded',
    );
    expect(called).toBe(1);
    expect(await tree(base)).toEqual([]);
  });

  it('a hash that does not match after writing deletes what it wrote and fails', async () => {
    const result = await saveVersionToFolder(base, 'a.xlsx', bytes, sha(Buffer.from('other')));
    expect(result).toMatchObject({ ok: false, code: 'save_verify_failed' });
    expect(await tree(base)).toEqual([]);
  });

  it('does not write through a dangling link at the target name', async () => {
    await symlink(join(outside, 'gone'), join(base, 'a.xlsx'), LINK_TYPE);
    const result = await saveVersionToFolder(base, 'a.xlsx', bytes, sha(bytes));
    expect(result).toEqual({ ok: true, path: join(base, 'a (2).xlsx') });
    expect(await tree(outside)).toEqual([]);
  });
});

describe('doc.save handler', () => {
  const spec: XlsxSpec = {
    format: 'xlsx',
    language: 'he',
    kind: 'profit_table',
    title: 'רווחיות',
    filename: 'רווחיות מרץ',
    style: { theme: 'clean', accent: 'navy' },
    sources: [],
    sheets: [{ name: 'גיליון', tables: [{ header: ['א'], rows: [[{ t: 'x' }]] }] }],
  } as unknown as XlsxSpec;
  const CANONICAL = 'רווחיות מרץ.xlsx';
  const bytes = Buffer.from('PK\x03\x04 the approved xlsx');

  async function produced(businessId = B): Promise<string> {
    const productionId = await withBusiness(businessId, (db) => createProduction(db, {
      originJobId: 'J-origin',
      instructionText: 'תכיני טבלה',
      textOrigin: 'typed',
      format: 'xlsx',
      language: 'he',
      kind: 'profit_table',
      destination: { mode: 'save', folder: null },
      sourceDocumentIds: [],
    }));
    const storedPath = `${DIR}/${productionId}.xlsx`;
    await mkdir(join(config.documentRoot, DIR), { recursive: true });
    await writeFile(join(config.documentRoot, storedPath), bytes);
    return withBusiness(TEST_BUSINESS, (db) => saveVersion(db, { productionId, versionNo: 1, spec, storedPath, sha256: sha(bytes), sizeBytes: bytes.length }));
  }

  async function deliveryCard(versionId: string, businessId = B): Promise<void> {
    await getPool().query(
      `INSERT INTO document_cards (card_id, business_id, version_id, state, delivery_job_id)
       VALUES ($1, $2, $3, 'approved', $4)`,
      [`DC-${versionId}`, businessId, versionId, JOB],
    );
  }

  async function withBase(): Promise<void> {
    await saveDocumentSettings(
      { toWhatsApp: false, toEmail: true, toScreen: true, baseFolder: base },
      { businessId: B },
    );
  }

  function save(input: Record<string, unknown>) {
    return withBusiness(B, (db) => runLocalTool('doc.save', input, { ...{ jobId: JOB }, db }));
  }

  async function refusal(input: Record<string, unknown>): Promise<StepChannelError> {
    const err = await save(input).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StepChannelError);
    return err as StepChannelError;
  }

  beforeEach(async () => {
    await resetDatabase();
  });
  afterEach(async () => {
    await rm(join(config.documentRoot, DIR), { recursive: true, force: true });
  });
  afterAll(async () => {
    await closePool();
  });

  it('copies the approved bytes into base/folder and returns the absolute path', async () => {
    const versionId = await produced();
    await deliveryCard(versionId);
    await withBase();
    const result = await save({ producedVersionId: versionId, sha256: sha(bytes), folder: 'לקוחות/אלפא', filename: CANONICAL });
    const expected = join(await realpath(base), 'לקוחות', 'אלפא', CANONICAL);
    expect(result).toEqual({ performed: true, path: expected });
    expect(sha(await readFile(expected))).toBe(sha(bytes));
  });

  it('records where the copy landed on the delivery row, for the erasure preview (C7)', async () => {
    const versionId = await produced();
    await deliveryCard(versionId);
    await getPool().query(
      `INSERT INTO document_deliveries (job_id, business_id, card_id, version_id) VALUES ($1, $2, $3, $4)`,
      [JOB, B, `DC-${versionId}`, versionId],
    );
    await withBase();
    // An existing file at the name, so the copy lands as " (2)" — a name the
    // plan never knew, which is why the written path is what gets recorded.
    const dir = join(await realpath(base), 'לקוחות');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, CANONICAL), 'taken');
    const result = await save({ producedVersionId: versionId, sha256: sha(bytes), folder: 'לקוחות', filename: CANONICAL });
    expect(result['path']).toBe(join(dir, 'רווחיות מרץ (2).xlsx'));
    const { rows } = await getPool().query<{ saved_paths: string[] }>(
      'SELECT saved_paths FROM document_deliveries WHERE job_id = $1',
      [JOB],
    );
    expect(rows).toEqual([{ saved_paths: [result['path']] }]);

    // A second copy by the same delivery job is APPENDED, never overwrites
    // the first: the owner must be told about every copy on his disk.
    const again = await save({ producedVersionId: versionId, sha256: sha(bytes), folder: 'לקוחות', filename: CANONICAL });
    expect(again['path']).toBe(join(dir, 'רווחיות מרץ (3).xlsx'));
    const after = await getPool().query<{ saved_paths: string[] }>(
      'SELECT saved_paths FROM document_deliveries WHERE job_id = $1',
      [JOB],
    );
    expect(after.rows).toEqual([{ saved_paths: [result['path'], again['path']] }]);
  });

  it('logs, and still succeeds, when no delivery row records the copy', async () => {
    const versionId = await produced();
    await deliveryCard(versionId);
    await withBase();
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const result = await save({ producedVersionId: versionId, sha256: sha(bytes), folder: null, filename: CANONICAL });
      expect(result['performed']).toBe(true);
    } finally {
      console.error = original;
    }
    expect(logged.map((args) => String(args[0]))).toEqual([expect.stringContaining('no delivery row')]);
  });

  it('a null folder lands under the kind label', async () => {
    const versionId = await produced();
    await deliveryCard(versionId);
    await withBase();
    const result = await save({ producedVersionId: versionId, sha256: sha(bytes), folder: null, filename: CANONICAL });
    expect(result['path']).toBe(join(await realpath(base), documentKindLabel.profit_table, CANONICAL));
  });

  it('refuses on a job that is not a document delivery job, before touching the disk', async () => {
    const versionId = await produced();
    await withBase();
    const err = await refusal({ producedVersionId: versionId, sha256: sha(bytes), folder: 'x', filename: CANONICAL });
    expect(err.code).toBe('save_not_supported');
    expect(await tree(base)).toEqual([]);
  });

  it('refuses a delivery card of ANOTHER business naming the same job id', async () => {
    const versionId = await produced();
    await deliveryCard(versionId, OTHER);
    await withBase();
    const err = await refusal({ producedVersionId: versionId, sha256: sha(bytes), folder: 'x', filename: CANONICAL });
    expect(err.code).toBe('save_not_supported');
  });

  it("refuses a version other than the one this job's card approved, before touching the disk", async () => {
    const approved = await produced();
    const other = await produced();
    await deliveryCard(approved);
    await withBase();
    const err = await refusal({ producedVersionId: other, sha256: sha(bytes), folder: 'x', filename: CANONICAL });
    expect(err.code).toBe('save_not_supported');
    expect(await tree(base)).toEqual([]);
    // Control: the approved version saves on the same job.
    const ok = await save({ producedVersionId: approved, sha256: sha(bytes), folder: 'x', filename: CANONICAL });
    expect(ok['performed']).toBe(true);
  });

  it('refuses when no base folder is configured', async () => {
    const versionId = await produced();
    await deliveryCard(versionId);
    const err = await refusal({ producedVersionId: versionId, sha256: sha(bytes), folder: 'x', filename: CANONICAL });
    expect(err.code).toBe('save_no_base_folder');
    expect(err.message).toBe(SAVE_FAILURE_HE.save_no_base_folder);
  });

  it('refuses a filename that is not the canonical name, and writes nothing', async () => {
    const versionId = await produced();
    await deliveryCard(versionId);
    await withBase();
    const err = await refusal({ producedVersionId: versionId, sha256: sha(bytes), folder: 'x', filename: 'אחר.xlsx' });
    expect(err.code).toBe('save_name_mismatch');
    expect(await tree(base)).toEqual([]);
  });

  it('refuses a sha that is not the version sha', async () => {
    const versionId = await produced();
    await deliveryCard(versionId);
    await withBase();
    const err = await refusal({ producedVersionId: versionId, sha256: sha(Buffer.from('x')), folder: 'x', filename: CANONICAL });
    expect(err.code).toBe('save_hash_mismatch');
    expect(await tree(base)).toEqual([]);
  });

  it('refuses when the file on disk changed since approval', async () => {
    const versionId = await produced();
    await deliveryCard(versionId);
    await withBase();
    const swapped = Buffer.from('PK\x03\x04 the approved xlsy'); // same length, other bytes
    const dir = join(config.documentRoot, DIR);
    for (const f of await readdir(dir)) await writeFile(join(dir, f), swapped);
    const err = await refusal({ producedVersionId: versionId, sha256: sha(bytes), folder: 'x', filename: CANONICAL });
    expect(err.code).toBe('save_hash_mismatch');
    expect(await tree(base)).toEqual([]);
  });

  it('treats a version of another business as not found', async () => {
    const versionId = await produced(OTHER);
    await deliveryCard(versionId);
    await withBase();
    const err = await refusal({ producedVersionId: versionId, sha256: sha(bytes), folder: 'x', filename: CANONICAL });
    expect(err.code).toBe('save_not_found');
  });

  it('refuses a traversal folder with the Hebrew reason, and writes nothing', async () => {
    const versionId = await produced();
    await deliveryCard(versionId);
    await withBase();
    const err = await refusal({ producedVersionId: versionId, sha256: sha(bytes), folder: '../../Windows', filename: CANONICAL });
    expect(err.code).toBe('save_folder_refused');
    expect(err.message).toMatch(/[א-ת]/);
    expect(await tree(base)).toEqual([]);
    expect(await tree(outside)).toEqual([]);
  });

  it('refuses a malformed payload', async () => {
    const err = await refusal({ producedVersionId: 'v', sha256: 'nothex', folder: null, filename: CANONICAL });
    expect(err.code).toBe('local_tool_bad_input');
  });
});
