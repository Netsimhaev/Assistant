import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, TEST_BUSINESS } from '../test/db.js';
import { loadCardContext, saveCardContext } from './card-context.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const ctx = {
  jobId: 'J1',
  kind: 'question' as const,
  topicId: null,
  summary: 'שאלה',
  sourceNames: ['public'],
  internalDocumentIds: ['D1'],
  auto: false,
};

describe('card context', () => {
  it('round trips', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveCardContext(db, ctx));
    expect(await withBusiness(TEST_BUSINESS, (db) => loadCardContext(db, 'J1'))).toEqual(ctx);
    expect(await withBusiness(TEST_BUSINESS, (db) => loadCardContext(db, 'nope'))).toBeNull();
  });
  it('cuts an over-long summary to 200, never rejects', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveCardContext(db, { ...ctx, summary: 'א'.repeat(500) }));
    const got = await withBusiness(TEST_BUSINESS, (db) => loadCardContext(db, 'J1'));
    expect(got?.summary.length).toBe(200);
  });
});
