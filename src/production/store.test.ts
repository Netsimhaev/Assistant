import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, withBusiness } from '../db/pool.js';
import type { DocxSpec } from '../domain/document-spec.js';
import { resetDatabase, TEST_BUSINESS } from '../test/db.js';
import {
  advanceStage,
  claimProduction,
  createProduction,
  EMPTY_WORK,
  latestVersion,
  loadProduction,
  productionsToday,
  releaseLease,
  saveVersion,
  saveVersionCheck,
  saveWork,
  type CreateProductionInput,
} from './store.js';

const B = 'test-business';
const TZ = 'Asia/Jerusalem';

const input = (over: Partial<CreateProductionInput> = {}): CreateProductionInput => ({
  originJobId: 'J-origin',
  instructionText: 'תכיני מכתב ללקוח',
  textOrigin: 'typed',
  format: 'docx',
  language: 'he',
  kind: 'letter',
  destination: { mode: 'save', folder: null },
  sourceDocumentIds: [],
  ...over,
});

const spec: DocxSpec = {
  format: 'docx',
  language: 'he',
  kind: 'letter',
  title: 'מכתב',
  filename: 'letter',
  style: { theme: 'clean', accent: 'navy' },
  sources: [],
  blocks: [{ type: 'paragraph', text: 'שלום' }],
};

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('production store', () => {
  it('creates a queued production and reads it back', async () => {
    const id = await withBusiness(B, (db) => createProduction(db, input({ destination: { mode: 'send', to: ['dana@acme.co.il'] } })));
    const p = await withBusiness(B, (db) => loadProduction(db, id));
    expect(p?.stage).toBe('queued');
    expect(p?.attempt).toBe(0);
    expect(p?.work).toEqual(EMPTY_WORK);
    expect(p?.destination).toEqual({ mode: 'send', to: ['dana@acme.co.il'] });
    expect(await withBusiness('other-business', (db) => loadProduction(db, id))).toBeNull();
  });

  it('a claim leases the row; a second claim gets nothing until the lease lapses', async () => {
    const id = await withBusiness(B, (db) => createProduction(db, input()));
    const first = await withBusiness(B, (db) => claimProduction(db, 'a', 60_000));
    expect(first?.productionId).toBe(id);
    expect(first?.leasedBy).toBe('a');
    expect(await withBusiness(B, (db) => claimProduction(db, 'b', 60_000))).toBeNull();
    await getPool().query(`UPDATE document_productions SET lease_until = now() - interval '1 second'`);
    expect((await withBusiness(B, (db) => claimProduction(db, 'b', 60_000)))?.leasedBy).toBe('b');
  });

  it('never claims a terminal production, nor one of another business', async () => {
    const id = await withBusiness(B, (db) => createProduction(db, input()));
    await getPool().query(`UPDATE document_productions SET stage = 'ready' WHERE production_id = $1`, [id]);
    await withBusiness('other-business', (db) => createProduction(db, input()));
    expect(await withBusiness(B, (db) => claimProduction(db, 'a', 60_000))).toBeNull();
    // Control: a queued one of this business is claimed.
    const live = await withBusiness(B, (db) => createProduction(db, input()));
    expect((await withBusiness(B, (db) => claimProduction(db, 'a', 60_000)))?.productionId).toBe(live);
  });

  it('two concurrent claims from two pools → exactly one wins', async () => {
    await withBusiness(B, (db) => createProduction(db, input()));
    // Two connections — each `withBusiness` checks out its own.
    const results = await Promise.all([
      withBusiness(B, (db) => claimProduction(db, 'pool-a', 60_000)),
      withBusiness(B, (db) => claimProduction(db, 'pool-b', 60_000)),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('advanceStage is conditional on the stage it moves from', async () => {
    const id = await withBusiness(B, (db) => createProduction(db, input()));
    expect(await withBusiness(TEST_BUSINESS, (db) => advanceStage(db, id, 'queued', 'drafting', { work: { ...EMPTY_WORK, drafted: true } }))).toBe(true);
    expect(await withBusiness(TEST_BUSINESS, (db) => advanceStage(db, id, 'queued', 'drafting', {}))).toBe(false);
    const p = await withBusiness(B, (db) => loadProduction(db, id));
    expect(p?.stage).toBe('drafting');
    expect(p?.work.drafted).toBe(true);
  });

  it('saveVersion is idempotent per version number and supersedes earlier versions', async () => {
    const id = await withBusiness(B, (db) => createProduction(db, input()));
    const sha = 'a'.repeat(64);
    const v1 = await withBusiness(TEST_BUSINESS, (db) => saveVersion(db, { productionId: id, versionNo: 1, spec, storedPath: 'x/1.docx', sha256: sha, sizeBytes: 10 }));
    const again = await withBusiness(TEST_BUSINESS, (db) => saveVersion(db, { productionId: id, versionNo: 1, spec, storedPath: 'x/1.docx', sha256: sha, sizeBytes: 10 }));
    expect(again).toBe(v1);
    const v2 = await withBusiness(TEST_BUSINESS, (db) => saveVersion(db, { productionId: id, versionNo: 2, spec, storedPath: 'x/2.docx', sha256: sha, sizeBytes: 11 }));
    const latest = await withBusiness(TEST_BUSINESS, (db) => latestVersion(db, id));
    expect(latest?.versionId).toBe(v2);
    expect(latest?.spec).toEqual(spec);
    const { rows } = await getPool().query<{ version_id: string; superseded: boolean }>(
      `SELECT version_id, superseded_at IS NOT NULL AS superseded FROM document_versions WHERE production_id = $1 ORDER BY version_no`,
      [id],
    );
    expect(rows).toEqual([
      { version_id: v1, superseded: true },
      { version_id: v2, superseded: false },
    ]);
  });

  it('productionsToday counts drafted productions since local midnight plus their fix attempts', async () => {
    // 2026-11-04 01:00 local = 2026-11-03T23:00Z; local midnight = 22:00Z.
    const now = new Date('2026-11-03T23:00:00Z');
    const drafted = { ...EMPTY_WORK, drafted: true };
    const a = await withBusiness(B, (db) => createProduction(db, input()));
    const b = await withBusiness(B, (db) => createProduction(db, input()));
    const yesterday = await withBusiness(B, (db) => createProduction(db, input()));
    await withBusiness(B, (db) => createProduction(db, input())); // queued, never drafted: not counted
    await getPool().query(`UPDATE document_productions SET work = $2, attempt = 2 WHERE production_id = $1`, [a, drafted]);
    await getPool().query(`UPDATE document_productions SET work = $2 WHERE production_id = $1`, [b, drafted]);
    await getPool().query(
      `UPDATE document_productions SET work = $2, attempt = 1, created_at = '2026-11-03T21:59:00Z' WHERE production_id = $1`,
      [yesterday, drafted],
    );
    await getPool().query(`UPDATE document_productions SET created_at = '2026-11-03T22:30:00Z' WHERE production_id <> $1`, [yesterday]);
    expect(await withBusiness(B, (db) => productionsToday(db, TZ, now))).toBe(4); // a: 1+2, b: 1
  });

  it('an unreadable working record fails closed (throws), never reads as empty', async () => {
    const id = await withBusiness(B, (db) => createProduction(db, input()));
    expect((await withBusiness(B, (db) => loadProduction(db, id)))?.work).toEqual(EMPTY_WORK);
    await getPool().query(`UPDATE document_productions SET work = '{"drafted":"yes"}' WHERE production_id = $1`, [id]);
    await expect(withBusiness(B, (db) => loadProduction(db, id))).rejects.toThrow(/unreadable work record/);
  });

  it('findings live in their own column; advanceStage writes them apart from work', async () => {
    const id = await withBusiness(B, (db) => createProduction(db, input()));
    const f = [{ check: 'spec' as const, code: 'cap_exceeded', where: 'document', he: 'x' }];
    expect(await withBusiness(TEST_BUSINESS, (db) => advanceStage(db, id, 'queued', 'fixing', { findings: f }))).toBe(true);
    const { rows } = await getPool().query<{ findings: unknown; work: unknown }>(
      'SELECT findings, work FROM document_productions WHERE production_id = $1',
      [id],
    );
    expect(rows[0]!.findings).toEqual(f);
    expect(rows[0]!.work).toEqual(EMPTY_WORK);
    expect((await withBusiness(B, (db) => loadProduction(db, id)))?.findings).toEqual(f);
  });
});

/**
 * The first wall (ruling R9): every statement that names a production or a
 * version by id also filters by the calling business, so business B's
 * connection cannot touch business A's row even when it holds the id.
 */
describe('production store — another business cannot touch a row by id', () => {
  const OTHER = 'other-business';

  it('releaseLease under another business leaves the lease in place', async () => {
    await withBusiness(B, (db) => createProduction(db, input()));
    const claimed = await withBusiness(B, (db) => claimProduction(db, 'a', 60_000));
    if (claimed === null) throw new Error('expected a claim');
    await withBusiness(OTHER, (db) => releaseLease(db, claimed.productionId, 'a'));
    expect((await withBusiness(B, (db) => loadProduction(db, claimed.productionId)))?.leasedBy).toBe('a');
    // Control: the owning business does release it.
    await withBusiness(B, (db) => releaseLease(db, claimed.productionId, 'a'));
    expect((await withBusiness(B, (db) => loadProduction(db, claimed.productionId)))?.leasedBy).toBeNull();
  });

  it('advanceStage and saveWork under another business move nothing', async () => {
    const id = await withBusiness(B, (db) => createProduction(db, input()));
    expect(await withBusiness(OTHER, (db) => advanceStage(db, id, 'queued', 'drafting', {}))).toBe(false);
    expect(await withBusiness(OTHER, (db) => saveWork(db, id, 'queued', { ...EMPTY_WORK, drafted: true }))).toBe(false);
    const p = await withBusiness(B, (db) => loadProduction(db, id));
    expect(p?.stage).toBe('queued');
    expect(p?.work).toEqual(EMPTY_WORK);
    // Control.
    expect(await withBusiness(B, (db) => advanceStage(db, id, 'queued', 'drafting', {}))).toBe(true);
  });

  it('saveVersion under another business writes no version; latestVersion and saveVersionCheck do not reach one', async () => {
    const id = await withBusiness(B, (db) => createProduction(db, input()));
    const row = { productionId: id, versionNo: 1, spec, storedPath: 'p', sha256: 'a'.repeat(64), sizeBytes: 1 };
    await withBusiness(OTHER, (db) => saveVersion(db, row));
    expect(await withBusiness(B, (db) => latestVersion(db, id))).toBeNull();

    const versionId = await withBusiness(B, (db) => saveVersion(db, row));
    expect(await withBusiness(OTHER, (db) => latestVersion(db, id))).toBeNull();
    await withBusiness(OTHER, (db) => saveVersionCheck(db, versionId, 'check1', { ok: true }));
    expect((await withBusiness(B, (db) => latestVersion(db, id)))?.check1).toBeNull();
    // Control.
    await withBusiness(B, (db) => saveVersionCheck(db, versionId, 'check1', { ok: true }));
    expect((await withBusiness(B, (db) => latestVersion(db, id)))?.check1).toEqual({ ok: true });
  });
});
