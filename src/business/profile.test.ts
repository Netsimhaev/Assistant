import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { LOGO_MAX_BYTES } from './logo.js';
import { loadProfile, profileFragment, readLogo, saveAddress, saveLogo } from './profile.js';

const TECH = 'staff-1';

function pngBytes(extra = 0): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const length = Buffer.from([0x00, 0x00, 0x00, 0x0d]);
  const type = Buffer.from('IHDR', 'ascii');
  const data = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const crc = Buffer.from([0x1f, 0x15, 0xc4, 0x89]);
  return Buffer.concat([signature, length, type, data, crc, Buffer.alloc(extra, 0)]);
}

function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
}

let ROOT = '';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('business profile', () => {
  beforeEach(async () => {
    await resetDatabase();
    ROOT = await mkdtemp(join(tmpdir(), 'profile-'));
  });
  afterEach(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });
  afterAll(async () => {
    await closePool();
  });

  it('loads an empty profile when nothing was saved', async () => {
    expect(await withBusiness(TEST_BUSINESS, (db) => loadProfile(db))).toEqual({ address: null, logo: null });
    expect(await withBusiness(TEST_BUSINESS, (db) => readLogo(db, ROOT))).toBeNull();
  });

  it('saves the address trimmed, clears it with null, and refuses more than 300 characters', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveAddress(db, '  הרצל 1, תל אביב  ', TECH));
    expect(await withBusiness(TEST_BUSINESS, (db) => loadProfile(db))).toMatchObject({ address: 'הרצל 1, תל אביב' });
    await withBusiness(TEST_BUSINESS, (db) => saveAddress(db, null, TECH));
    expect(await withBusiness(TEST_BUSINESS, (db) => loadProfile(db))).toMatchObject({ address: null });
    await expect(withBusiness(TEST_BUSINESS, (db) => saveAddress(db, 'א'.repeat(301), TECH))).rejects.toThrow();
    await withBusiness(TEST_BUSINESS, (db) => saveAddress(db, 'א'.repeat(300), TECH));
  });

  it('stores a PNG logo under <root>/<business>/profile/logo.png and reads it back', async () => {
    const bytes = pngBytes();
    expect(await withBusiness(TEST_BUSINESS, (db) => saveLogo(db, bytes, ROOT, TECH))).toBe('ok');
    const file = join(ROOT, TEST_BUSINESS, 'profile', 'logo.png');
    expect(await readFile(file)).toEqual(bytes);
    const profile = await withBusiness(TEST_BUSINESS, (db) => loadProfile(db));
    expect(profile.logo).toMatchObject({ path: `${TEST_BUSINESS}/profile/logo.png`, mediaType: 'image/png' });
    expect(profile.logo?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await withBusiness(TEST_BUSINESS, (db) => readLogo(db, ROOT))).toEqual({ bytes, mediaType: 'image/png' });
  });

  it('stores JPEG bytes as JPEG (whatever name the upload carried) and removes the old PNG', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveLogo(db, pngBytes(), ROOT, TECH));
    expect(await withBusiness(TEST_BUSINESS, (db) => saveLogo(db, jpegBytes(), ROOT, TECH))).toBe('ok');
    expect(await exists(join(ROOT, TEST_BUSINESS, 'profile', 'logo.png'))).toBe(false);
    expect(await readFile(join(ROOT, TEST_BUSINESS, 'profile', 'logo.jpg'))).toEqual(jpegBytes());
    expect(await withBusiness(TEST_BUSINESS, (db) => loadProfile(db))).toMatchObject({
      logo: { path: `${TEST_BUSINESS}/profile/logo.jpg`, mediaType: 'image/jpeg' },
    });
  });

  it('rejects an SVG and a truncated PNG header, writing nothing', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(await withBusiness(TEST_BUSINESS, (db) => saveLogo(db, svg, ROOT, TECH))).toBe('not_image');
    expect(await withBusiness(TEST_BUSINESS, (db) => saveLogo(db, pngBytes().subarray(0, 8), ROOT, TECH))).toBe(
      'not_image',
    );
    expect(await exists(join(ROOT, TEST_BUSINESS))).toBe(false);
    expect(await withBusiness(TEST_BUSINESS, (db) => loadProfile(db))).toEqual({ address: null, logo: null });
  });

  it('accepts exactly 1 MB and rejects 1 MB + 1 byte as too_large', async () => {
    const atCap = pngBytes(LOGO_MAX_BYTES - pngBytes().length);
    expect(atCap.length).toBe(LOGO_MAX_BYTES);
    expect(await withBusiness(TEST_BUSINESS, (db) => saveLogo(db, atCap, ROOT, TECH))).toBe('ok');
    const overCap = pngBytes(LOGO_MAX_BYTES - pngBytes().length + 1);
    expect(await withBusiness(TEST_BUSINESS, (db) => saveLogo(db, overCap, ROOT, TECH))).toBe('too_large');
    // The stored logo is still the one at the cap.
    expect((await withBusiness(TEST_BUSINESS, (db) => readLogo(db, ROOT)))?.bytes.length).toBe(LOGO_MAX_BYTES);
  });

  it('returns null when the file on disk was overwritten after it was saved', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveLogo(db, pngBytes(), ROOT, TECH));
    await writeFile(join(ROOT, TEST_BUSINESS, 'profile', 'logo.png'), pngBytes(10));
    expect(await withBusiness(TEST_BUSINESS, (db) => readLogo(db, ROOT))).toBeNull();
  });

  it('returns null when the file is missing, and refuses a stored path outside the business folder', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveLogo(db, pngBytes(), ROOT, TECH));
    await rm(join(ROOT, TEST_BUSINESS, 'profile', 'logo.png'));
    expect(await withBusiness(TEST_BUSINESS, (db) => readLogo(db, ROOT))).toBeNull();

    // A tampered row pointing at another business's file is never read.
    await writeFile(join(ROOT, 'elsewhere.png'), pngBytes());
    await testDb().query(`UPDATE business_profiles SET logo_path = '../elsewhere.png' WHERE business_id = $1`, [
      TEST_BUSINESS,
    ]);
    expect(await withBusiness(TEST_BUSINESS, (db) => readLogo(db, ROOT))).toBeNull();
  });

  it('keeps the address when a logo is saved, and the logo when the address changes', async () => {
    await withBusiness(TEST_BUSINESS, (db) => saveAddress(db, 'הרצל 1', TECH));
    await withBusiness(TEST_BUSINESS, (db) => saveLogo(db, pngBytes(), ROOT, TECH));
    await withBusiness(TEST_BUSINESS, (db) => saveAddress(db, 'הרצל 2', TECH));
    const profile = await withBusiness(TEST_BUSINESS, (db) => loadProfile(db));
    expect(profile.address).toBe('הרצל 2');
    expect(profile.logo?.mediaType).toBe('image/png');
  });

  it('serialises concurrent saves: after PNG and JPEG saves race, the stored logo still reads back', async () => {
    // Without a lock around write → upsert → remove-other, a PNG save and a
    // JPEG save interleave so that the row names one format while the other
    // save has already removed that file — the logo is silently lost.
    for (let round = 0; round < 5; round += 1) {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          withBusiness(TEST_BUSINESS, (db) => saveLogo(db, i % 2 === 0 ? pngBytes() : jpegBytes(), ROOT, TECH)),
        ),
      );
      const logo = await withBusiness(TEST_BUSINESS, (db) => readLogo(db, ROOT));
      expect(logo, `round ${round}`).not.toBeNull();
    }
  });
  describe('profileFragment', () => {
    it('is {} when the business has no name on its profile', async () => {
      expect(await withBusiness(TEST_BUSINESS, (db) => profileFragment(db))).toEqual({});
    });

    it('carries the name and the address from the business’s own profile row', async () => {
      await testDb().query(
        `INSERT INTO business_profiles (business_id, display_name, updated_by) VALUES ($1, 'חנות אלפא', 'test')`,
        [TEST_BUSINESS],
      );
      expect(await withBusiness(TEST_BUSINESS, (db) => profileFragment(db))).toEqual({
        businessProfile: { name: 'חנות אלפא', address: null },
      });
      await withBusiness(TEST_BUSINESS, (db) => saveAddress(db, 'הרצל 2', TECH));
      expect(await withBusiness(TEST_BUSINESS, (db) => profileFragment(db))).toEqual({
        businessProfile: { name: 'חנות אלפא', address: 'הרצל 2' },
      });
    });

    it('never reads another business’s profile', async () => {
      await testDb().query(
        `INSERT INTO business_profiles (business_id, display_name, address, updated_by) VALUES ('other-biz', 'בטא', 'רחוב 1', 'test')`,
      );
      expect(await withBusiness(TEST_BUSINESS, (db) => profileFragment(db))).toEqual({});
    });

    it('swallows a failed read and returns {} — a missing profile only narrows what the model knows', async () => {
      const broken = {
        businessId: TEST_BUSINESS,
        inTransaction: false,
        query: async () => {
          throw new Error('boom');
        },
      } as unknown as Parameters<typeof profileFragment>[0];
      expect(await profileFragment(broken)).toEqual({});
    });
  });
});
