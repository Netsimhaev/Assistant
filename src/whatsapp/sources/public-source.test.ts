import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../../test/db.js';
import { setPublicFor } from '../public-documents.js';
import { publicSourceItems } from './public-source.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

async function seedDoc(id: string, name: string, text: string) {
  await testDb().query(
    `INSERT INTO documents (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
     VALUES ($1,$2,'manual',$3,'text/plain',$4,1,'p','extracted')`,
    [id, TEST_BUSINESS, name, id.padEnd(64, '0').slice(0, 64)],
  );
  await testDb().query(
    `INSERT INTO document_artifacts (business_id, document_id, ordinal, kind, content) VALUES ($1,$2,0,'text',$3::jsonb)`,
    [TEST_BUSINESS, id, JSON.stringify({ blocks: [{ text }] })],
  );
}

describe('publicSourceItems', () => {
  it('gives a supplier both+supplier documents only, as attachable public items', async () => {
    await seedDoc('D-C', 'client.txt', 'ללקוחות');
    await seedDoc('D-S', 'supplier.txt', 'לספקים');
    await seedDoc('D-B', 'both.txt', 'לכולם');
    for (const [id, v] of [['D-C', 'client'], ['D-S', 'supplier'], ['D-B', 'both']] as const) {
      await withBusiness(TEST_BUSINESS, (db) => setPublicFor(db, id, v, 'owner'));
    }
    const items = await withBusiness(TEST_BUSINESS, (db) => publicSourceItems(db, 'supplier'));
    expect(items.map((i) => i.documentId).sort()).toEqual(['D-B', 'D-S']);
    expect(items.every((i) => i.source === 'public' && i.at === null)).toBe(true);
    expect(items.find((i) => i.documentId === 'D-S')).toMatchObject({ label: 'מסמך ציבורי: supplier.txt', text: 'לספקים' });
  });

  it('strips bidi controls and line breaks from the name; honours the budget', async () => {
    await seedDoc('D-X', 'a‮b\nc.txt', 'x'.repeat(50));
    await withBusiness(TEST_BUSINESS, (db) => setPublicFor(db, 'D-X', 'both', 'owner'));
    const items = await withBusiness(TEST_BUSINESS, (db) => publicSourceItems(db, 'client', 10));
    expect(items[0]?.label).not.toMatch(/[‪-‮\n]/);
    expect(items[0]?.text).toHaveLength(10);
  });
});
