import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
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
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const item = await createLedgerItem(base(), { businessId: B, by: 'boss', db: client });
      await updateLedgerItem(item.itemId, { description: 'x' }, { kind: 'updated', by: 'boss' }, { businessId: B, db: client });
      const moved = await moveLedgerStatus(item.itemId, ['open'], 'done', { kind: 'done', by: 'boss' }, { businessId: B, db: client });
      expect(moved).toBe(true);
      const events = await listLedgerEvents(item.itemId, { businessId: B, db: client });
      expect(events.map((e) => e.kind)).toEqual(['created', 'updated', 'done']);
      await client.query('ROLLBACK');
      expect(await loadLedgerItem(item.itemId, { businessId: B })).toBeNull();
      expect(await listLedgerEvents(item.itemId, { businessId: B })).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('creates an item with a created event', async () => {
    const item = await createLedgerItem(base(), { businessId: B, by: 'boss' });
    expect(item.itemId).toMatch(/^LI-/);
    expect(item.status).toBe('open');
    expect(item.amountMinor).toBe(150000);
    expect(item.stages).toEqual([{ title: 'שלב', done: false }]);
    const events = await listLedgerEvents(item.itemId, { businessId: B });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('created');
    expect(events[0]?.eventId).toMatch(/^LE-/);
    expect(events[0]?.byWhom).toBe('boss');
  });

  it('moveLedgerStatus refuses a status not in from', async () => {
    const item = await createLedgerItem(base(), { businessId: B, by: 'boss' });
    const moved = await moveLedgerStatus(item.itemId, ['stuck'], 'done', { kind: 'done', by: 'boss' }, { businessId: B });
    expect(moved).toBe(false);
    const events = await listLedgerEvents(item.itemId, { businessId: B });
    expect(events.map((e) => e.kind)).toEqual(['created']);
    expect((await loadLedgerItem(item.itemId, { businessId: B }))?.status).toBe('open');
    // positive control: the same call with a matching `from` does run.
    const ok = await moveLedgerStatus(item.itemId, ['open'], 'done', { kind: 'done', by: 'boss' }, { businessId: B });
    expect(ok).toBe(true);
    const after = await loadLedgerItem(item.itemId, { businessId: B });
    expect(after?.status).toBe('done');
    expect(after?.closedAt).not.toBeNull();
  });

  it('reopen moves evidence_after forward', async () => {
    const item = await createLedgerItem(base(), { businessId: B, by: 'boss' });
    await getPool().query(
      `UPDATE ledger_items SET evidence_after = now() - interval '2 days' WHERE item_id = $1`,
      [item.itemId],
    );
    await moveLedgerStatus(item.itemId, ['open'], 'closed_by_evidence', { kind: 'closed_by_evidence', by: 'system' }, { businessId: B });
    const closed = await loadLedgerItem(item.itemId, { businessId: B });
    expect(closed?.closedAt).not.toBeNull();
    await moveLedgerStatus(item.itemId, ['closed_by_evidence'], 'open', { kind: 'reopened', by: 'boss' }, { businessId: B });
    const reopened = await loadLedgerItem(item.itemId, { businessId: B });
    expect(reopened?.status).toBe('open');
    expect(reopened?.closedAt).toBeNull();
    expect(reopened!.evidenceAfter.getTime()).toBeGreaterThan(closed!.evidenceAfter.getTime());
  });

  it('is scoped by business', async () => {
    const item = await createLedgerItem(base(), { businessId: B, by: 'boss' });
    expect(await loadLedgerItem(item.itemId, { businessId: OTHER })).toBeNull();
    expect(await listLedgerItems({ businessId: OTHER })).toEqual([]);
    expect(await listLedgerEvents(item.itemId, { businessId: OTHER })).toEqual([]);
    expect(
      await moveLedgerStatus(item.itemId, ['open'], 'done', { kind: 'done', by: 'x' }, { businessId: OTHER }),
    ).toBe(false);
    expect((await loadLedgerItem(item.itemId, { businessId: B }))?.status).toBe('open');
  });

  it('updateLedgerItem on a missing id throws LedgerItemNotFoundError', async () => {
    await expect(
      updateLedgerItem('LI-missing', { description: 'x' }, { kind: 'updated', by: 'boss' }, { businessId: B }),
    ).rejects.toBeInstanceOf(LedgerItemNotFoundError);
  });

  it('updateLedgerItem patches, bumps updated_at and writes an event', async () => {
    const item = await createLedgerItem(base(), { businessId: B, by: 'boss' });
    const updated = await updateLedgerItem(
      item.itemId,
      { description: 'חדש', amountMinor: null, importance: 'critical', importanceManual: true },
      { kind: 'updated', by: 'boss', jobId: 'J-2', note: 'n' },
      { businessId: B },
    );
    expect(updated.description).toBe('חדש');
    expect(updated.amountMinor).toBeNull();
    expect(updated.importance).toBe('critical');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(item.updatedAt.getTime());
    const events = await listLedgerEvents(item.itemId, { businessId: B });
    expect(events.map((e) => e.kind)).toEqual(['created', 'updated']);
    expect(events[1]?.jobId).toBe('J-2');
  });

  it('lists critical first, then due date with nulls last', async () => {
    const a = await createLedgerItem(base({ description: 'a', dueAt: null }), { businessId: B, by: 'b' });
    const b = await createLedgerItem(base({ description: 'b', dueAt: new Date('2026-12-05T00:00:00Z') }), { businessId: B, by: 'b' });
    const c = await createLedgerItem(base({ description: 'c', importance: 'critical', dueAt: null }), { businessId: B, by: 'b' });
    const d = await createLedgerItem(base({ description: 'd', dueAt: new Date('2026-12-02T00:00:00Z') }), { businessId: B, by: 'b' });
    const list = await listLedgerItems({ businessId: B });
    expect(list.map((i) => i.itemId)).toEqual([c.itemId, d.itemId, b.itemId, a.itemId]);
    await moveLedgerStatus(a.itemId, ['open'], 'cancelled', { kind: 'cancelled', by: 'b' }, { businessId: B });
    const open = await listLedgerItems({ businessId: B, statuses: ['open'] });
    expect(open.map((i) => i.itemId)).not.toContain(a.itemId);
    expect(open).toHaveLength(3);
  });
});
