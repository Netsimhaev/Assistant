import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { keepItem, keptIds, listKept, revokeKeep } from './kept-items.js';

const BUSINESS = 'test-business';

describe('kept items', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('keeps an item and lists it back', async () => {
    await withBusiness(BUSINESS, (bdb) => keepItem(bdb, { kind: 'document', itemId: 'DOC-1', note: 'החוזה' }));

    const kept = await withBusiness(BUSINESS, (bdb) => listKept(bdb));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.itemId).toBe('DOC-1');
    expect(kept[0]?.note).toBe('החוזה');
  });

  it('keeping the same item twice updates the note rather than failing', async () => {
    await withBusiness(BUSINESS, (bdb) => keepItem(bdb, { kind: 'document', itemId: 'DOC-1', note: 'ראשון' }));
    await withBusiness(BUSINESS, (bdb) => keepItem(bdb, { kind: 'document', itemId: 'DOC-1', note: 'שני' }));

    const kept = await withBusiness(BUSINESS, (bdb) => listKept(bdb));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.note).toBe('שני');
  });

  it('revokes and reports how many rows it touched', async () => {
    await withBusiness(BUSINESS, (bdb) => keepItem(bdb, { kind: 'memory', itemId: 'MEM-1' }));

    expect(await withBusiness(BUSINESS, (bdb) => revokeKeep(bdb, 'memory', 'MEM-1'))).toBe(1);
    expect(await withBusiness(BUSINESS, (bdb) => listKept(bdb))).toEqual([]);
    // Revoking nothing is a result, not a failure — and saying so is what
    // lets a caller tell "removed it" from "there was nothing there".
    expect(await withBusiness(BUSINESS, (bdb) => revokeKeep(bdb, 'memory', 'MEM-1'))).toBe(0);
  });

  it('keeps kinds apart, so one id kept as a document is not kept as a memory', async () => {
    await withBusiness(BUSINESS, (bdb) => keepItem(bdb, { kind: 'document', itemId: 'X-1' }));

    expect(await withBusiness(BUSINESS, (bdb) => keptIds(bdb, 'document'))).toEqual(new Set(['X-1']));
    expect(await withBusiness(BUSINESS, (bdb) => keptIds(bdb, 'memory'))).toEqual(new Set());
  });

  it('does not read another business\'s kept items', async () => {
    await withBusiness(BUSINESS, (bdb) => keepItem(bdb, { kind: 'document', itemId: 'DOC-1' }));
    expect(await withBusiness('someone-else', (bdb) => listKept(bdb))).toEqual([]);
  });
});
