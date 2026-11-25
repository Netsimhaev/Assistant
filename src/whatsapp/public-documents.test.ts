import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { publicDocumentsFor, setPublicFor } from './public-documents.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

async function seedDoc(business: string, id: string, text: string, status = 'extracted') {
  await testDb().query(
    `INSERT INTO documents (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
     VALUES ($1,$2,'manual',$3,'text/plain',$4,1,'p',$5)`,
    [id, business, `${id}.txt`, id.padEnd(64, '0').slice(0, 64), status],
  );
  await testDb().query(
    `INSERT INTO document_artifacts (business_id, document_id, ordinal, kind, content)
     VALUES ($1,$2,0,'text',$3::jsonb)`,
    [business, id, JSON.stringify({ blocks: [{ text }] })],
  );
}

describe('public documents', () => {
  it('is visible to the matching kind only, and never to another business', async () => {
    await seedDoc(TEST_BUSINESS, 'D1', 'מחירון');
    await seedDoc('other-business', 'D2', 'סוד');
    expect(await withBusiness(TEST_BUSINESS, (db) => setPublicFor(db, 'D1', 'client', 'owner'))).toBe(true);
    expect(await withBusiness(TEST_BUSINESS, (db) => setPublicFor(db, 'D2', 'both', 'owner'))).toBe(false);
    const c = await withBusiness(TEST_BUSINESS, (db) => publicDocumentsFor(db, 'client', 10_000));
    expect(c.map((d) => d.documentId)).toEqual(['D1']);
    expect(c[0]?.text).toBe('מחירון');
    expect(await withBusiness(TEST_BUSINESS, (db) => publicDocumentsFor(db, 'supplier', 10_000))).toEqual([]);
    await withBusiness(TEST_BUSINESS, (db) => setPublicFor(db, 'D1', 'both', 'owner'));
    expect(await withBusiness(TEST_BUSINESS, (db) => publicDocumentsFor(db, 'supplier', 10_000))).toHaveLength(1);
    await withBusiness(TEST_BUSINESS, (db) => setPublicFor(db, 'D1', null, 'owner'));
    expect(await withBusiness(TEST_BUSINESS, (db) => publicDocumentsFor(db, 'client', 10_000))).toEqual([]);
  });
  it('keeps total text within the budget', async () => {
    await seedDoc(TEST_BUSINESS, 'D1', 'a'.repeat(60));
    await seedDoc(TEST_BUSINESS, 'D3', 'b'.repeat(60));
    await withBusiness(TEST_BUSINESS, (db) => setPublicFor(db, 'D1', 'both', 'owner'));
    await withBusiness(TEST_BUSINESS, (db) => setPublicFor(db, 'D3', 'both', 'owner'));
    const r = await withBusiness(TEST_BUSINESS, (db) => publicDocumentsFor(db, 'client', 100));
    expect(r.reduce((n, d) => n + d.text.length, 0)).toBeLessThanOrEqual(100);
    expect(r.map((d) => d.documentId)).toEqual(['D1', 'D3']);
  });
  it('ignores a non-extracted document', async () => {
    await seedDoc(TEST_BUSINESS, 'D1', 'x', 'pending');
    await withBusiness(TEST_BUSINESS, (db) => setPublicFor(db, 'D1', 'both', 'owner'));
    expect(await withBusiness(TEST_BUSINESS, (db) => publicDocumentsFor(db, 'client', 100))).toEqual([]);
  });
});
