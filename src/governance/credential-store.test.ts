import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, getPool } from '../db/pool.js';
import { canonicalJson } from '../util/canonical.js';
import { resetDatabase } from '../test/db.js';
import type { Queryable } from '../db/pool.js';
import { MasterKeyError, writeKeyState } from './master-key.js';
import {
  CredentialStoreError,
  listSecretRefs,
  putSecret,
  removeSecret,
  storedCredentials,
} from './credential-store.js';

const BIZ_A = 'biz-a';
const BIZ_B = 'biz-b';
const REF = 'OFFICE_MAIL';
const SECRET = 'hunter2-the-mailbox-password';
const KEY_ID = 'key-1';
const OPERATOR = 'operator@example.com';

let KEY: Buffer;

beforeEach(async () => {
  await resetDatabase();
  KEY = randomBytes(32);
  // The key state is per-installation and holds one row, so it is written
  // under `config.businessId` — the same default `putSecret` reads it under.
  await writeKeyState(KEY, KEY_ID);
});

afterAll(async () => {
  await closePool();
});

/**
 * A `Queryable` that records that it was reached and then refuses.
 *
 * Used where the point of the test is that the store answers *without* a
 * query: a stub that merely returned an empty result would let the test pass
 * whether the query ran or not.
 */
function refusingDb(): { db: Queryable; calls: () => number } {
  let calls = 0;
  const db = {
    query: async () => {
      calls += 1;
      throw new Error('the store reached the database when it should not have');
    },
  } as unknown as Queryable;
  return { db, calls: () => calls };
}

describe('storedCredentials', () => {
  it('returns the secret that was stored', async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, KEY);

    const handle = await storedCredentials(KEY).resolve(REF, BIZ_A);

    expect(handle).not.toBeNull();
    expect(handle?.ref).toBe(REF);
    expect(handle?.value).toBe(SECRET);
  });

  /**
   * The boundary as a whole: one business does not read another's secret.
   *
   * This is the outcome both controls exist for, and it is upheld by EITHER
   * of them alone — measured, not assumed: with `AND business_id = $1`
   * removed from the query this test stays green, because the cipher refuses
   * the row the query then hands over. It is therefore not the test that
   * isolates the query filter; the one below it is.
   *
   * The first assertion is what makes the `null` mean something (spec §9.7):
   * the very same ref under its own business resolves in this same test, so
   * the refusal below is a refusal and not a store that returns nothing at
   * all.
   */
  it("does not return another business's secret", async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, KEY);
    const source = storedCredentials(KEY);

    expect((await source.resolve(REF, BIZ_A))?.value).toBe(SECRET);
    expect(await source.resolve(REF, BIZ_B)).toBeNull();
  });

  /**
   * Control one of two (spec §9.1), isolated: the query must find the RIGHT
   * row, not merely withhold a wrong one.
   *
   * Written as two businesses holding the SAME ref, because that is the only
   * shape in which the business filter is observable on its own. With the
   * cipher's AAD binding in place, dropping `AND business_id = $1` can never
   * hand one customer another's secret — it can only make a lookup miss. So
   * the failure the filter prevents is stated here as the miss it actually
   * is: without it both resolves read whichever single row the query returns
   * first, and at least one of the two assertions below goes red whichever
   * that is.
   */
  it('returns each business its own secret when both have stored the same ref', async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: 'a-secret', updatedBy: OPERATOR }, KEY);
    await putSecret({ businessId: BIZ_B, ref: REF, value: 'b-secret', updatedBy: OPERATOR }, KEY);
    const source = storedCredentials(KEY);

    expect((await source.resolve(REF, BIZ_A))?.value).toBe('a-secret');
    expect((await source.resolve(REF, BIZ_B))?.value).toBe('b-secret');
  });

  /**
   * Control two of two, and it is tested SEPARATELY (spec §9.1): even if the
   * query handed over the wrong row, the cipher refuses to open it. The row
   * is moved under `BIZ_B`'s business_id by hand — so the `WHERE` clause
   * cannot save us, it finds the row — and the resolve must still be `null`.
   *
   * The row-count assertion is the §9.7 half: without it a `null` here would
   * also be what an empty table produces, and the test would pass with the
   * cipher's AAD binding deleted.
   */
  it('refuses a row whose ciphertext belongs to another business, even when the query hands it over', async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, KEY);
    // Sealed for BIZ_A, now sitting in BIZ_B's row — the hand-copied row of
    // spec §4.4. Nothing about the bytes changes; only which business the
    // query will find them under.
    await getPool().query('UPDATE credentials SET business_id = $1 WHERE business_id = $2', [
      BIZ_B,
      BIZ_A,
    ]);

    const present = await getPool().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM credentials WHERE business_id = $1 AND ref = $2',
      [BIZ_B, REF],
    );
    expect(present.rows[0]?.n).toBe('1');

    expect(await storedCredentials(KEY).resolve(REF, BIZ_B)).toBeNull();
  });

  it('replaces a secret rather than storing a second row for the same ref', async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: 'first', updatedBy: OPERATOR }, KEY);
    await putSecret({ businessId: BIZ_A, ref: REF, value: 'second', updatedBy: 'someone-else' }, KEY);

    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM credentials WHERE business_id = $1 AND ref = $2',
      [BIZ_A, REF],
    );
    expect(rows[0]?.n).toBe('1');
    expect((await storedCredentials(KEY).resolve(REF, BIZ_A))?.value).toBe('second');
  });

  it('returns null for a ref that was never stored', async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, KEY);

    // A stored ref alongside, so the null below is "this ref is absent" and
    // not "this business has nothing at all".
    expect(await storedCredentials(KEY).resolve('CALENDAR_TOKEN', BIZ_A)).toBeNull();
  });

  it('refuses a ref that is not the legal shape, without reaching the database', async () => {
    const { db, calls } = refusingDb();
    const source = storedCredentials(KEY, { db });

    expect(await source.resolve('office_mail', BIZ_A)).toBeNull();
    expect(await source.resolve('OFFICE-MAIL', BIZ_A)).toBeNull();
    expect(await source.resolve('', BIZ_A)).toBeNull();
    expect(await source.resolve('OFFICE MAIL', BIZ_A)).toBeNull();
    expect(calls()).toBe(0);
  });

  it('refuses to open a row sealed under a different key', async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, KEY);

    // Same row, same business, same ref — only the key is wrong.
    expect(await storedCredentials(randomBytes(32)).resolve(REF, BIZ_A)).toBeNull();
    // And the row really is openable, so the null above is the key.
    expect((await storedCredentials(KEY).resolve(REF, BIZ_A))?.value).toBe(SECRET);
  });

  /**
   * The handle's protection is the reason a secret cannot reach the
   * append-only audit log. Asserted as BEHAVIOUR on a real handle rather than
   * as a claim about the type (spec §9.2).
   */
  it('hands back a handle whose value survives neither JSON nor the canonical serialiser', async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, KEY);

    const handle = await storedCredentials(KEY).resolve(REF, BIZ_A);
    if (handle === null) throw new Error('expected a handle');

    // The secret is really in there — otherwise both assertions below would
    // hold for a handle that carried nothing at all.
    expect(handle.value).toBe(SECRET);
    expect(JSON.stringify(handle)).not.toContain(SECRET);
    expect(canonicalJson(handle)).not.toContain(SECRET);
    // …and the ref, which identifies without revealing, does survive both.
    expect(JSON.stringify(handle)).toContain(REF);
    expect(canonicalJson(handle)).toContain(REF);
  });
});

describe('putSecret', () => {
  /**
   * The condition the key check's AAD separation rests on. `master-key.ts`
   * seals its check value under the ref `key-check` — lowercase and
   * hyphenated — precisely because `CREDENTIAL_REF_PATTERN` cannot match it,
   * which makes the key-check row and every real secret disjoint BY
   * CONSTRUCTION rather than by a rule someone maintains. That holds only
   * while every write path validates, so this is the test of that condition.
   */
  it('refuses a ref that is not the legal shape, and seals nothing', async () => {
    for (const ref of ['key-check', 'office_mail', 'OFFICE-MAIL', '']) {
      await expect(
        putSecret({ businessId: BIZ_A, ref, value: SECRET, updatedBy: OPERATOR }, KEY),
      ).rejects.toThrow(CredentialStoreError);
    }

    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM credentials',
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('labels the row with the installation key id rather than one the caller chose', async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, KEY);

    const { rows } = await getPool().query<{ key_id: string }>(
      'SELECT key_id FROM credentials WHERE business_id = $1 AND ref = $2',
      [BIZ_A, REF],
    );
    expect(rows[0]?.key_id).toBe(KEY_ID);
  });

  it('refuses a key that is not the one this installation sealed its rows with', async () => {
    await expect(
      putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, randomBytes(32)),
    ).rejects.toThrow(MasterKeyError);

    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM credentials',
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('refuses to write before a key exists, rather than labelling the row with nothing', async () => {
    await getPool().query('DELETE FROM credential_key_state WHERE business_id = $1', [
      config.businessId,
    ]);

    await expect(
      putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, KEY),
    ).rejects.toThrow(CredentialStoreError);
  });

  it('writes the value nowhere but the ciphertext column', async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, KEY);

    // Every text column of the row, read back as text. The secret must not be
    // in any of them, and the ciphertext must not be the plaintext either.
    const { rows } = await getPool().query<{
      business_id: string;
      ref: string;
      updated_by: string;
      ciphertext: Buffer;
    }>('SELECT business_id, ref, updated_by, ciphertext FROM credentials');
    const row = rows[0];
    if (row === undefined) throw new Error('expected a row');
    expect(JSON.stringify([row.business_id, row.ref, row.updated_by])).not.toContain(SECRET);
    expect(row.ciphertext.toString('utf8')).not.toContain(SECRET);
  });
});

describe('listSecretRefs', () => {
  it('lists refs with their metadata and never a value', async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, KEY);
    await putSecret(
      { businessId: BIZ_A, ref: 'CALENDAR_TOKEN', value: 'tok', updatedBy: OPERATOR },
      KEY,
    );
    await putSecret({ businessId: BIZ_B, ref: REF, value: 'other', updatedBy: OPERATOR }, KEY);

    const list = await listSecretRefs(BIZ_A);

    // `toEqual` against the exact shape, not a field-by-field check: an extra
    // property carrying the value would fail here, and a subset assertion
    // would not.
    expect(list).toEqual([
      {
        ref: 'CALENDAR_TOKEN',
        keyId: KEY_ID,
        updatedAt: expect.any(Date),
        updatedBy: OPERATOR,
      },
      { ref: REF, keyId: KEY_ID, updatedAt: expect.any(Date), updatedBy: OPERATOR },
    ]);
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(JSON.stringify(list)).not.toContain('other');
  });
});

describe('removeSecret', () => {
  it('removes the named secret and reports that it did', async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, KEY);

    expect(await removeSecret(REF, BIZ_A)).toBe(true);
    expect(await storedCredentials(KEY).resolve(REF, BIZ_A)).toBeNull();
  });

  it("does not remove another business's secret", async () => {
    await putSecret({ businessId: BIZ_A, ref: REF, value: SECRET, updatedBy: OPERATOR }, KEY);

    expect(await removeSecret(REF, BIZ_B)).toBe(false);
    // Still there — the false above is a refusal, not a silent deletion
    // reported as a miss.
    expect((await storedCredentials(KEY).resolve(REF, BIZ_A))?.value).toBe(SECRET);
  });

  it('reports false for a ref that was never stored', async () => {
    expect(await removeSecret('CALENDAR_TOKEN', BIZ_A)).toBe(false);
  });
});
