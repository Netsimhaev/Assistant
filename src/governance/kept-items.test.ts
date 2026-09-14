import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
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
    await keepItem({ kind: 'document', itemId: 'DOC-1', note: 'החוזה' }, { businessId: BUSINESS });

    const kept = await listKept({ businessId: BUSINESS });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.itemId).toBe('DOC-1');
    expect(kept[0]?.note).toBe('החוזה');
  });

  it('keeping the same item twice updates the note rather than failing', async () => {
    await keepItem({ kind: 'document', itemId: 'DOC-1', note: 'ראשון' }, { businessId: BUSINESS });
    await keepItem({ kind: 'document', itemId: 'DOC-1', note: 'שני' }, { businessId: BUSINESS });

    const kept = await listKept({ businessId: BUSINESS });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.note).toBe('שני');
  });

  it('revokes and reports how many rows it touched', async () => {
    await keepItem({ kind: 'memory', itemId: 'MEM-1' }, { businessId: BUSINESS });

    expect(await revokeKeep('memory', 'MEM-1', { businessId: BUSINESS })).toBe(1);
    expect(await listKept({ businessId: BUSINESS })).toEqual([]);
    // Revoking nothing is a result, not a failure — and saying so is what
    // lets a caller tell "removed it" from "there was nothing there".
    expect(await revokeKeep('memory', 'MEM-1', { businessId: BUSINESS })).toBe(0);
  });

  it('keeps kinds apart, so one id kept as a document is not kept as a memory', async () => {
    await keepItem({ kind: 'document', itemId: 'X-1' }, { businessId: BUSINESS });

    expect(await keptIds('document', { businessId: BUSINESS })).toEqual(new Set(['X-1']));
    expect(await keptIds('memory', { businessId: BUSINESS })).toEqual(new Set());
  });

  it('does not read another business\'s kept items', async () => {
    await keepItem({ kind: 'document', itemId: 'DOC-1' }, { businessId: BUSINESS });
    expect(await listKept({ businessId: 'someone-else' })).toEqual([]);
  });
});
