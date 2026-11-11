import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, withBusiness, type BusinessDb } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  LedgerItemNotFoundError,
  createLedgerItem,
  listLedgerEvents,
  listLedgerItems,
  loadLedgerItem,
  moveLedgerStatus,
  updateLedgerItem,
  type NewLedgerItem,
} from './store.js';

const B = 'biz-a';
const OTHER = 'biz-b';

function base(over: Partial<NewLedgerItem> = {}): NewLedgerItem {
  return {
    family: 'money_in',
    description: 'חשבונית 123',
    dueAt: new Date('2026-12-01T10:00:00Z'),
    dueIsDateOnly: false,
    importance: 'normal',
    importanceManual: false,
    counterpartyName: 'דנה',
    counterpartyEmail: 'dana@acme.co.il',
    counterpartyEmailVerified: true,
    counterpartyDomain: 'acme.co.il',
    reference: null,
    amountMinor: 150000,
    stages: [{ title: 'שלב', done: false }],
    proposedStages: null,
    originJobId: 'J-1',
    ...over,
  };
}

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('ledger store', () => {
  it('keeps event order and atomicity on a caller client', async () => {
    await withBusiness(B, async (db) => {
      await db.query('BEGIN');
      // The caller's transaction: every store call below joins it.
      const client: BusinessDb = { businessId: db.businessId, inTransaction: true, query: db.query };
      const item = await createLedgerItem(client, base(), { by: 'boss' });
      await updateLedgerItem(client, item.itemId, { description: 'x' }, { kind: 'updated', by: 'boss' });
      const moved = await moveLedgerStatus(client, item.itemId, ['open'], 'done', { kind: 'done', by: 'boss' });
      expect(moved).toBe(true);
      const events = await listLedgerEvents(client, item.itemId);
      expect(events.map((e) => e.kind)).toEqual(['created', 'updated', 'done']);
      await db.query('ROLLBACK');
      expect(await withBusiness(B, (db2) => loadLedgerItem(db2, item.itemId))).toBeNull();
      expect(await withBusiness(B, (db2) => listLedgerEvents(db2, item.itemId))).toEqual([]);
    });
  });

  it('creates an item with a created event', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    expect(item.itemId).toMatch(/^LI-/);
    expect(item.status).toBe('open');
    expect(item.amountMinor).toBe(150000);
    expect(item.stages).toEqual([{ title: 'שלב', done: false }]);
    const events = await withBusiness(B, (db) => listLedgerEvents(db, item.itemId));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('created');
    expect(events[0]?.eventId).toMatch(/^LE-/);
    expect(events[0]?.byWhom).toBe('boss');
  });

  it('moveLedgerStatus refuses a status not in from', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const moved = await withBusiness(B, (db) => moveLedgerStatus(db, item.itemId, ['stuck'], 'done', { kind: 'done', by: 'boss' }));
    expect(moved).toBe(false);
    const events = await withBusiness(B, (db) => listLedgerEvents(db, item.itemId));
    expect(events.map((e) => e.kind)).toEqual(['created']);
    expect((await withBusiness(B, (db) => loadLedgerItem(db, item.itemId)))?.status).toBe('open');
    // positive control: the same call with a matching `from` does run.
    const ok = await withBusiness(B, (db) => moveLedgerStatus(db, item.itemId, ['open'], 'done', { kind: 'done', by: 'boss' }));
    expect(ok).toBe(true);
    const after = await withBusiness(B, (db) => loadLedgerItem(db, item.itemId));
    expect(after?.status).toBe('done');
    expect(after?.closedAt).not.toBeNull();
  });

  it('reopen moves evidence_after forward', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    await getPool().query(
      `UPDATE ledger_items SET evidence_after = now() - interval '2 days' WHERE item_id = $1`,
      [item.itemId],
    );
    await withBusiness(B, (db) => moveLedgerStatus(db, item.itemId, ['open'], 'closed_by_evidence', { kind: 'closed_by_evidence', by: 'system' }));
    const closed = await withBusiness(B, (db) => loadLedgerItem(db, item.itemId));
    expect(closed?.closedAt).not.toBeNull();
    await withBusiness(B, (db) => moveLedgerStatus(db, item.itemId, ['closed_by_evidence'], 'open', { kind: 'reopened', by: 'boss' }));
    const reopened = await withBusiness(B, (db) => loadLedgerItem(db, item.itemId));
    expect(reopened?.status).toBe('open');
    expect(reopened?.closedAt).toBeNull();
    expect(reopened!.evidenceAfter.getTime()).toBeGreaterThan(closed!.evidenceAfter.getTime());
  });

  it('is scoped by business', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    expect(await withBusiness(OTHER, (db) => loadLedgerItem(db, item.itemId))).toBeNull();
    expect(await withBusiness(OTHER, (db) => listLedgerItems(db))).toEqual([]);
    expect(await withBusiness(OTHER, (db) => listLedgerEvents(db, item.itemId))).toEqual([]);
    expect(
      await withBusiness(OTHER, (db) => moveLedgerStatus(db, item.itemId, ['open'], 'done', { kind: 'done', by: 'x' })),
    ).toBe(false);
    expect((await withBusiness(B, (db) => loadLedgerItem(db, item.itemId)))?.status).toBe('open');
  });

  it('updateLedgerItem on a missing id throws LedgerItemNotFoundError', async () => {
    await expect(
      withBusiness(B, (db) => updateLedgerItem(db, 'LI-missing', { description: 'x' }, { kind: 'updated', by: 'boss' })),
    ).rejects.toBeInstanceOf(LedgerItemNotFoundError);
  });

  it('updateLedgerItem patches, bumps updated_at and writes an event', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const updated = await withBusiness(B, (db) => updateLedgerItem(
      db,
      item.itemId,
      { description: 'חדש', amountMinor: null, importance: 'critical', importanceManual: true },
      { kind: 'updated', by: 'boss', jobId: 'J-2', note: 'n' },
    ));
    expect(updated.description).toBe('חדש');
    expect(updated.amountMinor).toBeNull();
    expect(updated.importance).toBe('critical');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(item.updatedAt.getTime());
    const events = await withBusiness(B, (db) => listLedgerEvents(db, item.itemId));
    expect(events.map((e) => e.kind)).toEqual(['created', 'updated']);
    expect(events[1]?.jobId).toBe('J-2');
  });

  it('lists critical first, then due date with nulls last', async () => {
    const a = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'a', dueAt: null }), { by: 'b' }));
    const b = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'b', dueAt: new Date('2026-12-05T00:00:00Z') }), { by: 'b' }));
    const c = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'c', importance: 'critical', dueAt: null }), { by: 'b' }));
    const d = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'd', dueAt: new Date('2026-12-02T00:00:00Z') }), { by: 'b' }));
    const list = await withBusiness(B, (db) => listLedgerItems(db));
    expect(list.map((i) => i.itemId)).toEqual([c.itemId, d.itemId, b.itemId, a.itemId]);
    await withBusiness(B, (db) => moveLedgerStatus(db, a.itemId, ['open'], 'cancelled', { kind: 'cancelled', by: 'b' }));
    const open = await withBusiness(B, (db) => listLedgerItems(db, { statuses: ['open'] }));
    expect(open.map((i) => i.itemId)).not.toContain(a.itemId);
    expect(open).toHaveLength(3);
  });
});
