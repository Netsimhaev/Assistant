import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, TEST_BUSINESS } from '../test/db.js';
import { loadClearance, writeClearance } from './auto-clearance.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const c = { jobId: 'J1', stepId: 'S1', inputHash: 'a'.repeat(64), conversationId: 'C1', topicId: 'T1' };

describe('auto clearance', () => {
  it('round trips', async () => {
    await withBusiness(TEST_BUSINESS, (db) => writeClearance(db, c));
    expect(await withBusiness(TEST_BUSINESS, (db) => loadClearance(db, 'J1', 'S1'))).toEqual({
      inputHash: c.inputHash,
      conversationId: 'C1',
      topicId: 'T1',
    });
    expect(await withBusiness(TEST_BUSINESS, (db) => loadClearance(db, 'J1', 'S2'))).toBeNull();
  });
  it('throws on a malformed hash', async () => {
    await expect(
      withBusiness(TEST_BUSINESS, (db) => writeClearance(db, { ...c, inputHash: 'xyz' })),
    ).rejects.toThrow();
  });
});
