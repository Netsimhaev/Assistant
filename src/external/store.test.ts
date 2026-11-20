import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import {
  countCallsToday,
  deleteDraft,
  insertEvent,
  loadDrafts,
  loadReadsForJob,
  markEventsCurated,
  uncuratedEvents,
  claimEventsForCuration,
  eventsForCurationJob,
  releaseCurationClaim,
  recordScanAttempt,
  loadSystemState,
  recordCall,
  recordExternalRead,
  recordRejectedHook,
  saveDraft,
} from './store.js';

const OTHER = 'other-business';
const fields = [{ label: 'שם', value: 'דנה' }];

describe('external store', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('upserts, loads and deletes drafts', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveDraft(db, { systemId: 'crm', definition: { a: 1 }, staffId: 's1' }));
    await withBusiness(TEST_BUSINESS, (db) => saveDraft(db, { systemId: 'crm', definition: { a: 2 }, staffId: 's2' }));
    const rows = await withBusiness(TEST_BUSINESS, (db) => loadDrafts(db));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ systemId: 'crm', definition: { a: 2 }, updatedByStaff: 's2' });
    expect(await withBusiness(TEST_BUSINESS, (db) => deleteDraft(db, 'crm'))).toBe(1);
    expect(await withBusiness(TEST_BUSINESS, (db) => loadDrafts(db))).toHaveLength(0);
    expect(await withBusiness(TEST_BUSINESS, (db) => deleteDraft(db, 'crm'))).toBe(0);
  });

  it('records and loads reads per job', async () => {
    await withBusiness(TEST_BUSINESS, (db) =>
      recordExternalRead(db, { jobId: 'J1', stepId: 's1', systemId: 'crm', operation: 'lookup', fields }),
    );
    const reads = await withBusiness(TEST_BUSINESS, (db) => loadReadsForJob(db, 'J1'));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ jobId: 'J1', systemId: 'crm', fields });
    expect(await withBusiness(TEST_BUSINESS, (db) => loadReadsForJob(db, 'J2'))).toHaveLength(0);
  });

  it('insertEvent returns false on a repeated item_hash and keeps one row', async () => {
    const e = { systemId: 'crm', source: 'webhook' as const, eventType: 'new', itemHash: 'h1', fields };
    expect(await withBusiness(TEST_BUSINESS, (db) => insertEvent(db, e))).toBe(true);
    expect(await withBusiness(TEST_BUSINESS, (db) => insertEvent(db, e))).toBe(false);
    const { rows } = await testDb().query('SELECT 1 FROM external_events');
    expect(rows).toHaveLength(1);
  });

  it('lists uncurated events, claims them for one job only, and marks them curated', async () => {
    await withBusiness(TEST_BUSINESS, async (db) => {
      await insertEvent(db, { systemId: 'crm', source: 'scan', eventType: 'x', itemHash: 'a', fields });
      await insertEvent(db, { systemId: 'crm', source: 'webhook', eventType: 'x', itemHash: 'b', fields });
      await insertEvent(db, { systemId: 'erp', source: 'scan', eventType: 'x', itemHash: 'c', fields });
    });
    const first = await withBusiness(TEST_BUSINESS, (db) => uncuratedEvents(db, 'crm', 20));
    expect(first.map((e) => e.itemHash)).toEqual(['a', 'b']);
    expect(await withBusiness(TEST_BUSINESS, (db) => uncuratedEvents(db, 'crm', 1))).toHaveLength(1);

    const ids = first.map((e) => e.eventId);
    expect(await withBusiness(TEST_BUSINESS, (db) => claimEventsForCuration(db, ids, 'J-1'))).toHaveLength(2);
    // Claimed rows are neither listed again nor claimable by a second job.
    expect(await withBusiness(TEST_BUSINESS, (db) => uncuratedEvents(db, 'crm', 20))).toHaveLength(0);
    expect(await withBusiness(TEST_BUSINESS, (db) => claimEventsForCuration(db, ids, 'J-2'))).toEqual([]);
    expect((await withBusiness(TEST_BUSINESS, (db) => eventsForCurationJob(db, 'J-1'))).map((e) => e.itemHash)).toEqual(['a', 'b']);

    // A release gives them back; a mark makes them curated for good.
    await withBusiness(TEST_BUSINESS, (db) => releaseCurationClaim(db, 'J-1'));
    expect(await withBusiness(TEST_BUSINESS, (db) => uncuratedEvents(db, 'crm', 20))).toHaveLength(2);
    await withBusiness(TEST_BUSINESS, (db) => markEventsCurated(db, ids));
    expect(await withBusiness(TEST_BUSINESS, (db) => uncuratedEvents(db, 'crm', 20))).toHaveLength(0);
  });

  it('a failed scan attempt records its outcome without moving last_scan_at', async () => {
    const ok = new Date('2026-11-01T08:00:00Z');
    const bad = new Date('2026-11-02T08:00:00Z');
    await withBusiness(TEST_BUSINESS, (db) => recordScanAttempt(db, 'crm', { at: ok, outcome: 'ok', succeeded: true }));
    await withBusiness(TEST_BUSINESS, (db) =>
      recordScanAttempt(db, 'crm', { at: bad, outcome: 'external_auth', succeeded: false }),
    );
    const state = await withBusiness(TEST_BUSINESS, (db) => loadSystemState(db, 'crm'));
    expect(state?.lastScanAt?.toISOString()).toBe(ok.toISOString());
    expect(state?.lastScanAttemptAt?.toISOString()).toBe(bad.toISOString());
    expect(state?.lastScanOutcome).toBe('external_auth');
    expect(await withBusiness(TEST_BUSINESS, (db) => loadSystemState(db, 'nope'))).toBeNull();
  });

  it('counts calls from local midnight of the zone, not UTC midnight', async () => {
    // Pacific/Kiritimati is UTC+14: a call 20 hours ago is before its local midnight
    // whenever local time is before 20:00, and a call 1 minute ago is always after it
    // unless local time is 00:00 sharp.
    await withBusiness(TEST_BUSINESS, (db) => recordCall(db, { systemId: 'crm', outcome: 'ok' }));
    await testDb().query(
      `INSERT INTO external_calls (business_id, system_id, at, outcome)
       VALUES ($1, 'crm', now() - interval '47 hours', 'ok')`,
      [TEST_BUSINESS],
    );
    expect(await withBusiness(TEST_BUSINESS, (db) => countCallsToday(db, 'crm', 'Pacific/Kiritimati'))).toBe(1);
    // A call just before the zone's local midnight, seeded exactly.
    const { rows } = await testDb().query<{ start: Date }>(
      `SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem' AS start`,
    );
    const start = rows[0]!.start;
    await testDb().query(
      `INSERT INTO external_calls (business_id, system_id, at, outcome) VALUES ($1,'zz',$2,'ok'),($1,'zz',$3,'ok')`,
      [TEST_BUSINESS, new Date(start.getTime() - 60_000), new Date(start.getTime() + 60_000)],
    );
    expect(await withBusiness(TEST_BUSINESS, (db) => countCallsToday(db, 'zz', 'Asia/Jerusalem'))).toBe(1);
  });

  it('tracks rejected hooks and the last scan per system', async () => {
    await withBusiness(TEST_BUSINESS, (db) => recordRejectedHook(db, 'crm', 'bad_signature'));
    await withBusiness(TEST_BUSINESS, (db) => recordRejectedHook(db, 'crm', 'bad_signature'));
    const { rows } = await testDb().query('SELECT rejected_hooks FROM external_system_state');
    expect(rows[0].rejected_hooks).toBe(2);
    expect((await withBusiness(TEST_BUSINESS, (db) => loadSystemState(db, 'crm')))?.lastScanAt).toBeNull();
    const at = new Date('2026-11-18T10:00:00Z');
    await withBusiness(TEST_BUSINESS, (db) => recordScanAttempt(db, 'crm', { at, outcome: 'ok', succeeded: true }));
    const state = await withBusiness(TEST_BUSINESS, (db) => loadSystemState(db, 'crm'));
    expect(state?.lastScanAt?.toISOString()).toBe(at.toISOString());
    expect(state?.lastScanAttemptAt?.toISOString()).toBe(at.toISOString());
  });

  it('refuses an item an erasure tombstoned, and only that one (migration 080)', async () => {
    await testDb().query(
      `INSERT INTO external_erased_items (business_id, system_id, item_hash) VALUES ($1, 'crm', 'gone')`,
      [TEST_BUSINESS],
    );
    await withBusiness(TEST_BUSINESS, async (db) => {
      expect(await insertEvent(db, { systemId: 'crm', source: 'scan', eventType: 'x', itemHash: 'gone', fields })).toBe(false);
      // Another system, or another hash, is stored.
      expect(await insertEvent(db, { systemId: 'erp', source: 'scan', eventType: 'x', itemHash: 'gone', fields })).toBe(true);
      expect(await insertEvent(db, { systemId: 'crm', source: 'scan', eventType: 'x', itemHash: 'changed', fields })).toBe(true);
    });
    await withBusiness(OTHER, async (db) => {
      expect(await insertEvent(db, { systemId: 'crm', source: 'scan', eventType: 'x', itemHash: 'gone', fields })).toBe(true);
    });
  });

  it('hides a business\'s rows from another business', async () => {
    await withBusiness(TEST_BUSINESS, async (db) => {
      await saveDraft(db, { systemId: 'crm', definition: {}, staffId: 's' });
      await insertEvent(db, { systemId: 'crm', source: 'scan', eventType: 'x', itemHash: 'h', fields });
      await recordCall(db, { systemId: 'crm', outcome: 'ok' });
    });
    await withBusiness(OTHER, async (db) => {
      expect(await loadDrafts(db)).toHaveLength(0);
      expect(await uncuratedEvents(db, 'crm', 20)).toHaveLength(0);
      expect(await countCallsToday(db, 'crm', 'UTC')).toBe(0);
      // the same hash is a fresh event for the other business
      expect(await insertEvent(db, { systemId: 'crm', source: 'scan', eventType: 'x', itemHash: 'h', fields })).toBe(true);
    });
  });
});
