import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { addColleague, listColleagues, removeColleague, updateColleague } from './colleagues.js';

const yossi = { name: 'יוסי', role: 'מנהל משמרת', phone: '+972 50 111 2222' };

describe('confirmed colleagues', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('adds, lists, updates and removes a colleague', async () => {
    const id = await withBusiness(TEST_BUSINESS, (db) => addColleague(db, yossi));
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await withBusiness(TEST_BUSINESS, (db) => listColleagues(db))).toMatchObject([
      { colleagueId: id, name: 'יוסי', role: 'מנהל משמרת', phone: '+972501112222' },
    ]);

    expect(
      await withBusiness(TEST_BUSINESS, (db) => updateColleague(db, id, { ...yossi, role: 'אחראי מטבח' })),
    ).toBe(true);
    expect(await withBusiness(TEST_BUSINESS, (db) => listColleagues(db))).toMatchObject([{ role: 'אחראי מטבח' }]);

    expect(await withBusiness(TEST_BUSINESS, (db) => removeColleague(db, id))).toBe(true);
    expect(await withBusiness(TEST_BUSINESS, (db) => listColleagues(db))).toEqual([]);
    expect(await withBusiness(TEST_BUSINESS, (db) => removeColleague(db, id))).toBe(false);
  });

  it('rejects a local phone form and writes nothing', async () => {
    await expect(withBusiness(TEST_BUSINESS, (db) => addColleague(db, { ...yossi, phone: '050-1234567' }))).rejects.toThrow();
    const { rows } = await testDb().query('SELECT 1 FROM business_colleagues');
    expect(rows).toHaveLength(0);
  });

  it('cannot update or see another business’s colleague', async () => {
    const id = await withBusiness('other-business', (db) => addColleague(db, yossi));
    expect(await withBusiness(TEST_BUSINESS, (db) => listColleagues(db))).toEqual([]);
    expect(await withBusiness(TEST_BUSINESS, (db) => updateColleague(db, id, yossi))).toBe(false);
    expect(await withBusiness(TEST_BUSINESS, (db) => removeColleague(db, id))).toBe(false);
    expect(await withBusiness('other-business', (db) => listColleagues(db))).toHaveLength(1);
  });
});
