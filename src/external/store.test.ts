import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import {
  countCallsToday,
  deleteDraft,
  insertEvent,
  lastScanAt,
  loadDrafts,
  loadReadsForJob,
  markEventsCurated,
  newEventsSince,
  recordCall,
  recordExternalRead,
  recordRejectedHook,
  saveDraft,
  setLastScanAt,
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
    await withBusiness(TEST_BUSINESS, (db) => deleteDraft(db, 'crm'));
    expect(await withBusiness(TEST_BUSINESS, (db) => loadDrafts(db))).toHaveLength(0);
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

  it('lists uncurated events after a cursor and marks them curated', async () => {
    await withBusiness(TEST_BUSINESS, (db) =>
      insertEvent(db, { systemId: 'crm', source: 'scan', eventType: 'x', itemHash: 'a', fields }),
    );
    const first = await withBusiness(TEST_BUSINESS, (db) => newEventsSince(db, null));
    expect(first).toHaveLength(1);
    await withBusiness(TEST_BUSINESS, (db) => markEventsCurated(db, first.map((e) => e.eventId)));
    expect(await withBusiness(TEST_BUSINESS, (db) => newEventsSince(db, null))).toHaveLength(0);
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
    expect(await withBusiness(TEST_BUSINESS, (db) => lastScanAt(db, 'crm'))).toBeNull();
    const at = new Date('2026-11-18T10:00:00Z');
    await withBusiness(TEST_BUSINESS, (db) => setLastScanAt(db, 'crm', at));
    expect((await withBusiness(TEST_BUSINESS, (db) => lastScanAt(db, 'crm')))?.toISOString()).toBe(at.toISOString());
  });

  it('hides a business\'s rows from another business', async () => {
    await withBusiness(TEST_BUSINESS, async (db) => {
      await saveDraft(db, { systemId: 'crm', definition: {}, staffId: 's' });
      await insertEvent(db, { systemId: 'crm', source: 'scan', eventType: 'x', itemHash: 'h', fields });
      await recordCall(db, { systemId: 'crm', outcome: 'ok' });
    });
    await withBusiness(OTHER, async (db) => {
      expect(await loadDrafts(db)).toHaveLength(0);
      expect(await newEventsSince(db, null)).toHaveLength(0);
      expect(await countCallsToday(db, 'crm', 'UTC')).toBe(0);
      // the same hash is a fresh event for the other business
      expect(await insertEvent(db, { systemId: 'crm', source: 'scan', eventType: 'x', itemHash: 'h', fields })).toBe(true);
    });
  });
});
