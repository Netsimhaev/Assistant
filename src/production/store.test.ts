import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, getPool } from '../db/pool.js';
import type { DocxSpec } from '../domain/document-spec.js';
import { resetDatabase } from '../test/db.js';
import {
  advanceStage,
  claimProduction,
  createProduction,
  EMPTY_WORK,
  latestVersion,
  loadProduction,
  productionsToday,
  saveVersion,
  type CreateProductionInput,
} from './store.js';

const B = 'test-business';
const TZ = 'Asia/Jerusalem';

const input = (over: Partial<CreateProductionInput> = {}): CreateProductionInput => ({
  businessId: B,
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
    const id = await createProduction(input({ destination: { mode: 'send', to: ['dana@acme.co.il'] } }));
    const p = await loadProduction(B, id);
    expect(p?.stage).toBe('queued');
    expect(p?.attempt).toBe(0);
    expect(p?.work).toEqual(EMPTY_WORK);
    expect(p?.destination).toEqual({ mode: 'send', to: ['dana@acme.co.il'] });
    expect(await loadProduction('other-business', id)).toBeNull();
  });

  it('a claim leases the row; a second claim gets nothing until the lease lapses', async () => {
    const id = await createProduction(input());
    const first = await claimProduction(B, 'a', 60_000);
    expect(first?.productionId).toBe(id);
    expect(first?.leasedBy).toBe('a');
    expect(await claimProduction(B, 'b', 60_000)).toBeNull();
    await getPool().query(`UPDATE document_productions SET lease_until = now() - interval '1 second'`);
    expect((await claimProduction(B, 'b', 60_000))?.leasedBy).toBe('b');
  });

  it('never claims a terminal production, nor one of another business', async () => {
    const id = await createProduction(input());
    await getPool().query(`UPDATE document_productions SET stage = 'ready' WHERE production_id = $1`, [id]);
    await createProduction(input({ businessId: 'other-business' }));
    expect(await claimProduction(B, 'a', 60_000)).toBeNull();
    // Control: a queued one of this business is claimed.
    const live = await createProduction(input());
    expect((await claimProduction(B, 'a', 60_000))?.productionId).toBe(live);
  });

  it('two concurrent claims from two pools → exactly one wins', async () => {
    await createProduction(input());
    const other = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
    try {
      const results = await Promise.all([
        claimProduction(B, 'pool-a', 60_000, getPool()),
        claimProduction(B, 'pool-b', 60_000, other),
      ]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    } finally {
      await other.end();
    }
  });

  it('advanceStage is conditional on the stage it moves from', async () => {
    const id = await createProduction(input());
    expect(await advanceStage(id, 'queued', 'drafting', { work: { ...EMPTY_WORK, drafted: true } })).toBe(true);
    expect(await advanceStage(id, 'queued', 'drafting', {})).toBe(false);
    const p = await loadProduction(B, id);
    expect(p?.stage).toBe('drafting');
    expect(p?.work.drafted).toBe(true);
  });

  it('saveVersion is idempotent per version number and supersedes earlier versions', async () => {
    const id = await createProduction(input());
    const sha = 'a'.repeat(64);
    const v1 = await saveVersion({ productionId: id, versionNo: 1, spec, storedPath: 'x/1.docx', sha256: sha, sizeBytes: 10 });
    const again = await saveVersion({ productionId: id, versionNo: 1, spec, storedPath: 'x/1.docx', sha256: sha, sizeBytes: 10 });
    expect(again).toBe(v1);
    const v2 = await saveVersion({ productionId: id, versionNo: 2, spec, storedPath: 'x/2.docx', sha256: sha, sizeBytes: 11 });
    const latest = await latestVersion(id);
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
    const a = await createProduction(input());
    const b = await createProduction(input());
    const yesterday = await createProduction(input());
    await createProduction(input()); // queued, never drafted: not counted
    await getPool().query(`UPDATE document_productions SET findings = $2, attempt = 2 WHERE production_id = $1`, [a, drafted]);
    await getPool().query(`UPDATE document_productions SET findings = $2 WHERE production_id = $1`, [b, drafted]);
    await getPool().query(
      `UPDATE document_productions SET findings = $2, attempt = 1, created_at = '2026-11-03T21:59:00Z' WHERE production_id = $1`,
      [yesterday, drafted],
    );
    await getPool().query(`UPDATE document_productions SET created_at = '2026-11-03T22:30:00Z' WHERE production_id <> $1`, [yesterday]);
    expect(await productionsToday(B, TZ, getPool(), now)).toBe(4); // a: 1+2, b: 1
  });
});
