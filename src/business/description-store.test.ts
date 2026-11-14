import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import {
  loadActiveDescription,
  normaliseSentence,
  proposalRunsInLastDay,
  recordRejectedSentence,
  rejectedSentenceHashes,
  saveDescription,
  sentenceHash,
} from './description-store.js';

const OWNER = 'owner';

async function count(table: string, where = ''): Promise<number> {
  const { rows } = await testDb().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} ${where}`);
  return Number(rows[0]?.n ?? '0');
}

describe('business description store', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('saves a first version as 1 and the next as 2, and loads the latest', async () => {
    const a = await withBusiness(TEST_BUSINESS, (db) => saveDescription(db, { text: 'one', createdBy: OWNER }));
    const b = await withBusiness(TEST_BUSINESS, (db) => saveDescription(db, { text: 'two', createdBy: OWNER }));
    expect(a).toMatchObject({ saved: true, description: { version: 1 } });
    expect(b).toMatchObject({ saved: true, description: { version: 2 } });
    const active = await withBusiness(TEST_BUSINESS, (db) => loadActiveDescription(db));
    expect(active).toMatchObject({ version: 2, text: 'two', createdBy: OWNER });
  });

  it('refuses 8001 characters with a Hebrew message and writes nothing', async () => {
    const r = await withBusiness(TEST_BUSINESS, (db) => saveDescription(db, { text: 'x'.repeat(8001), createdBy: OWNER }));
    expect(r.saved).toBe(false);
    if (r.saved || r.reason !== 'too_long') throw new Error('expected too_long');
    expect(r.messageHe).toContain('8,000');
    expect(await count('business_descriptions')).toBe(0);
  });

  it('accepts exactly 8000 characters', async () => {
    const r = await withBusiness(TEST_BUSINESS, (db) => saveDescription(db, { text: 'x'.repeat(8000), createdBy: OWNER }));
    expect(r.saved).toBe(true);
  });

  it('an unchanged save (after trim) writes no version and no audit row', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveDescription(db, { text: 'same', createdBy: OWNER }));
    const r = await withBusiness(TEST_BUSINESS, (db) => saveDescription(db, { text: '  same \n', createdBy: OWNER }));
    expect(r).toEqual({ saved: false, reason: 'unchanged' });
    expect(await count('business_descriptions')).toBe(1);
    expect(await count('audit_log', "WHERE kind = 'description_change'")).toBe(1);
  });

  it('allows clearing the description with empty text', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveDescription(db, { text: 'something', createdBy: OWNER }));
    const r = await withBusiness(TEST_BUSINESS, (db) => saveDescription(db, { text: '   ', createdBy: OWNER }));
    expect(r).toMatchObject({ saved: true, description: { version: 2, text: '' } });
  });

  it('writes one description_change audit row whose inputHash is the text hash and whose reason carries the length, never the text', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveDescription(db, { text: 'zebrafish secret', createdBy: OWNER }));
    const { rows } = await testDb().query<{ reason: string; input_hash: string }>(
      "SELECT reason, input_hash FROM audit_log WHERE kind = 'description_change'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toContain('16');
    expect(rows[0]?.reason).not.toContain('zebrafish');
    expect(rows[0]?.input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the runtime account cannot UPDATE or DELETE a description row', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveDescription(db, { text: 'one', createdBy: OWNER }));
    await expect(
      withBusiness(TEST_BUSINESS, (db) => db.query("UPDATE business_descriptions SET text = 'x'")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withBusiness(TEST_BUSINESS, (db) => db.query('DELETE FROM business_descriptions')),
    ).rejects.toThrow(/permission denied/);
  });

  it("a second business does not see the first business's description", async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveDescription(db, { text: 'mine', createdBy: OWNER }));
    const other = await withBusiness('other-business', (db) => loadActiveDescription(db));
    expect(other).toBeNull();
  });

  it('proposalRunsInLastDay counts rows of the last 24 hours only', async () => {
    await testDb().query(
      `INSERT INTO business_descriptions (business_id, version, text, created_at, created_by)
       VALUES ($1, 1, 'old', now() - interval '25 hours', 'owner')`,
      [TEST_BUSINESS],
    );
    expect(await withBusiness(TEST_BUSINESS, (db) => proposalRunsInLastDay(db))).toBe(0);
    await withBusiness(TEST_BUSINESS, (db) => saveDescription(db, { text: 'new', createdBy: OWNER }));
    expect(await withBusiness(TEST_BUSINESS, (db) => proposalRunsInLastDay(db))).toBe(1);
  });

  it('rejected sentences are found by normalised hash', async () => {
    expect(normaliseSentence('Do  NOT\n call rival')).toBe('do not call rival');
    expect(sentenceHash('Do  NOT\n call rival')).toBe(sentenceHash('do not call rival'));
    await withBusiness(TEST_BUSINESS, (db) => recordRejectedSentence(db, 'Do  NOT\n call rival'));
    await withBusiness(TEST_BUSINESS, (db) => recordRejectedSentence(db, 'do not call rival'));
    const set = await withBusiness(TEST_BUSINESS, (db) => rejectedSentenceHashes(db));
    expect(set.size).toBe(1);
    expect(set.has(sentenceHash('do not call rival'))).toBe(true);
  });
});
