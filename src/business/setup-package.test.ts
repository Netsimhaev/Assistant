import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { installCharter } from '../charter/store.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import {
  clearSetupBoss,
  clearSetupPeople,
  loadSetupPackage,
  MAX_SETUP_COLLEAGUES,
  MAX_SETUP_CONTACTS,
  PersonEntry,
  saveSetupPackage,
  SetupLockedError,
  type SetupPackage,
} from './setup-package.js';

const TECH = 'staff-1';
const dana = { name: 'דנה כהן', role: 'לקוחה', phone: '+972 50 123 4567' };
const yossi = { name: 'יוסי', role: 'מנהל משמרת', phone: '+972501112222' };

async function rowCount(): Promise<number> {
  const { rows } = await testDb().query<{ n: string }>('SELECT count(*)::text AS n FROM setup_packages');
  return Number(rows[0]?.n ?? '0');
}

describe('setup package', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('loads null when nothing was saved', async () => {
    expect(await withBusiness(TEST_BUSINESS, (db) => loadSetupPackage(db))).toBeNull();
  });

  it('saves and loads the boss number, contacts and colleagues, phones in canonical + form', async () => {
    await withBusiness(TEST_BUSINESS, (db) =>
      saveSetupPackage(db, { bossWhatsapp: '+972 52-000-1111', contacts: [dana], colleagues: [yossi] }, TECH),
    );
    const pkg = await withBusiness(TEST_BUSINESS, (db) => loadSetupPackage(db));
    expect(pkg).toEqual({
      bossWhatsapp: '+972520001111',
      contacts: [{ name: 'דנה כהן', role: 'לקוחה', phone: '+972501234567' }],
      colleagues: [{ name: 'יוסי', role: 'מנהל משמרת', phone: '+972501112222' }],
    });
    const { rows } = await testDb().query<{ updated_by: string }>('SELECT updated_by FROM setup_packages');
    expect(rows[0]?.updated_by).toBe(TECH);
  });

  it('refuses after the owner signed a charter, and writes nothing', async () => {
    await withBusiness(TEST_BUSINESS, (db) => installCharter(db, buildCharter()));
    const pkg: SetupPackage = { bossWhatsapp: '+972520001111', contacts: [], colleagues: [] };
    await expect(withBusiness(TEST_BUSINESS, (db) => saveSetupPackage(db, pkg, TECH))).rejects.toBeInstanceOf(
      SetupLockedError,
    );
    expect(await rowCount()).toBe(0);
  });

  it('rejects a local phone form (050-1234567)', async () => {
    expect(PersonEntry.safeParse({ ...dana, phone: '050-1234567' }).success).toBe(false);
    await expect(
      withBusiness(TEST_BUSINESS, (db) =>
        saveSetupPackage(db, { bossWhatsapp: null, contacts: [{ ...dana, phone: '050-1234567' }], colleagues: [] }, TECH),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(TEST_BUSINESS, (db) =>
        saveSetupPackage(db, { bossWhatsapp: '050-1234567', contacts: [], colleagues: [] }, TECH),
      ),
    ).rejects.toThrow();
    expect(await rowCount()).toBe(0);
  });

  it('rejects blank or over-long fields', () => {
    expect(PersonEntry.safeParse({ ...dana, name: '   ' }).success).toBe(false);
    expect(PersonEntry.safeParse({ ...dana, role: '' }).success).toBe(false);
    expect(PersonEntry.safeParse({ ...dana, name: 'א'.repeat(121) }).success).toBe(false);
    expect(PersonEntry.safeParse({ ...dana, role: 'א'.repeat(121) }).success).toBe(false);
    expect(PersonEntry.safeParse({ ...dana, name: `  ${'א'.repeat(120)}  ` }).success).toBe(true);
  });

  it(`allows at most ${MAX_SETUP_CONTACTS} contacts and ${MAX_SETUP_COLLEAGUES} colleagues`, async () => {
    expect(MAX_SETUP_CONTACTS).toBe(200);
    expect(MAX_SETUP_COLLEAGUES).toBe(50);
    const many = (n: number) => Array.from({ length: n }, () => dana);
    await withBusiness(TEST_BUSINESS, (db) =>
      saveSetupPackage(db, { bossWhatsapp: null, contacts: many(200), colleagues: many(50) }, TECH),
    );
    await expect(
      withBusiness(TEST_BUSINESS, (db) => saveSetupPackage(db, { bossWhatsapp: null, contacts: many(201), colleagues: [] }, TECH)),
    ).rejects.toThrow();
    await expect(
      withBusiness(TEST_BUSINESS, (db) => saveSetupPackage(db, { bossWhatsapp: null, contacts: [], colleagues: many(51) }, TECH)),
    ).rejects.toThrow();
  });

  it('clearing people keeps the boss number; clearing the boss then deletes the empty row', async () => {
    await withBusiness(TEST_BUSINESS, (db) =>
      saveSetupPackage(db, { bossWhatsapp: '+972520001111', contacts: [dana], colleagues: [yossi] }, TECH),
    );
    await withBusiness(TEST_BUSINESS, (db) => clearSetupPeople(db));
    expect(await withBusiness(TEST_BUSINESS, (db) => loadSetupPackage(db))).toEqual({
      bossWhatsapp: '+972520001111',
      contacts: [],
      colleagues: [],
    });
    await withBusiness(TEST_BUSINESS, (db) => clearSetupBoss(db));
    expect(await rowCount()).toBe(0);
  });

  it('clearing the boss first keeps the people; clearing them then deletes the row', async () => {
    await withBusiness(TEST_BUSINESS, (db) =>
      saveSetupPackage(db, { bossWhatsapp: '+972520001111', contacts: [dana], colleagues: [] }, TECH),
    );
    await withBusiness(TEST_BUSINESS, (db) => clearSetupBoss(db));
    expect(await withBusiness(TEST_BUSINESS, (db) => loadSetupPackage(db))).toMatchObject({ bossWhatsapp: null });
    expect(await rowCount()).toBe(1);
    await withBusiness(TEST_BUSINESS, (db) => clearSetupPeople(db));
    expect(await rowCount()).toBe(0);
  });

  it('the clears work after the charter is signed (they are how confirmed data leaves)', async () => {
    await withBusiness(TEST_BUSINESS, (db) =>
      saveSetupPackage(db, { bossWhatsapp: '+972520001111', contacts: [dana], colleagues: [] }, TECH),
    );
    await withBusiness(TEST_BUSINESS, (db) => installCharter(db, buildCharter()));
    await withBusiness(TEST_BUSINESS, (db) => clearSetupPeople(db));
    await withBusiness(TEST_BUSINESS, (db) => clearSetupBoss(db));
    expect(await rowCount()).toBe(0);
  });
});
