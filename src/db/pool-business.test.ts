import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  __setAppPoolMaxForTest,
  getPool,
  isValidBusinessId,
  transaction,
  withBusiness,
  withBusinessTransaction,
} from './pool.js';
import { closePlatformPool, withPlatform } from './platform-pool.js';
import { ensureSchema, testDb } from '../test/db.js';
import { ensureRoles } from './roles.js';

beforeAll(async () => {
  await ensureSchema();
});

afterEach(async () => {
  await __setAppPoolMaxForTest(10);
});

afterAll(async () => {
  await closePlatformPool();
});

describe('withBusiness', () => {
  it('sets the business for the connection', async () => {
    const rows = await withBusiness('biz-a', async (db) => {
      expect(db.businessId).toBe('biz-a');
      expect(db.inTransaction).toBe(false);
      const { rows } = await db.query<{ b: string }>('SELECT app_business_id() AS b');
      return rows;
    });
    expect(rows[0]?.b).toBe('biz-a');
  });

  it('a connection that errored mid-use comes back with no business', async () => {
    await __setAppPoolMaxForTest(1);

    let pidInside: number | undefined;
    await expect(
      withBusiness('biz-a', async (db) => {
        const { rows } = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        pidInside = rows[0]?.pid;
        // A query that throws, not merely a JS throw.
        await db.query('SELECT 1 / 0');
      }),
    ).rejects.toThrow(/division by zero/);

    // max: 1, so this is the very same pooled client.
    const client = await getPool().connect();
    try {
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(rows[0]?.pid).toBe(pidInside);
      await expect(client.query('SELECT app_business_id()')).rejects.toThrow(
        /no business context/,
      );
    } finally {
      client.release();
    }
  });

  it('refuses a malformed business id before touching the pool', async () => {
    const fn = vi.fn(async () => 'never');
    const before = getPool().totalCount;
    await expect(withBusiness('Bad_ID', fn)).rejects.toThrow(/business id/);
    await expect(withBusinessTransaction('__proto__', fn)).rejects.toThrow(/business id/);
    expect(fn).not.toHaveBeenCalled();
    expect(getPool().totalCount).toBe(before);
  });

  it('transaction joins an open transaction', async () => {
    await withBusiness('biz-a', async (db) => {
      await db.query('CREATE TEMP TABLE tx_probe (x int)');
      try {
        await expect(
          transaction(db, async (tx) => {
            expect(tx.inTransaction).toBe(true);
            expect(tx.businessId).toBe('biz-a');
            await tx.query('INSERT INTO tx_probe (x) VALUES (1)');
            await transaction(tx, async (inner) => {
              expect(inner.inTransaction).toBe(true);
              await inner.query('INSERT INTO tx_probe (x) VALUES (2)');
              throw new Error('inner boom');
            });
          }),
        ).rejects.toThrow('inner boom');
        expect(db.inTransaction).toBe(false);
        const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM tx_probe');
        expect(rows[0]?.n).toBe(0);
      } finally {
        await db.query('DROP TABLE tx_probe');
      }
    });
  });

  it('withBusinessTransaction commits on success with the business set', async () => {
    const b = await withBusinessTransaction('biz-b', async (tx) => {
      expect(tx.inTransaction).toBe(true);
      const { rows } = await tx.query<{ b: string }>('SELECT app_business_id() AS b');
      return rows[0]?.b;
    });
    expect(b).toBe('biz-b');
  });

  it('runs as a role that cannot bypass RLS', async () => {
    const bypass = await withBusiness('biz-a', async (db) => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        'SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      return rows[0]?.rolbypassrls;
    });
    expect(bypass).toBe(false);
  });

  it('the platform pool runs as a role that bypasses RLS', async () => {
    const bypass = await withPlatform(async (db) => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        'SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      return rows[0]?.rolbypassrls;
    });
    expect(bypass).toBe(true);
  });
});

describe('ensureRoles', () => {
  it('refuses to turn the admin role (a superuser) into an application login', async () => {
    const admin = await testDb().connect();
    try {
      const { rows } = await admin.query<{ u: string }>('SELECT current_user AS u');
      const self = rows[0]?.u ?? '';
      await expect(
        ensureRoles(admin, {
          app: { user: self, password: 'x' },
          platform: { user: 'assistant_platform_test', password: 'assistant-platform-test-only' },
        }),
      ).rejects.toThrow(/refusing to turn/);
      const { rows: after } = await admin.query<{ rolsuper: boolean }>(
        'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
      );
      expect(after[0]?.rolsuper).toBe(true);
    } finally {
      admin.release();
    }
  });
});

describe('isValidBusinessId', () => {
  it('accepts the documented shape and refuses everything else', () => {
    expect(isValidBusinessId('dev-business')).toBe(true);
    expect(isValidBusinessId('test-business-health-probe-throw-mid-outage')).toBe(true);
    expect(isValidBusinessId('a'.repeat(63))).toBe(true);
    expect(isValidBusinessId('a'.repeat(64))).toBe(false);
    expect(isValidBusinessId('ab')).toBe(false);
    expect(isValidBusinessId('Bad_ID')).toBe(false);
    expect(isValidBusinessId('biz a')).toBe(false);
    expect(isValidBusinessId('')).toBe(false);
    // Match the regex, refused by SafeLookupKey.
    expect(isValidBusinessId('constructor')).toBe(false);
    expect(isValidBusinessId('prototype')).toBe(false);
  });
});
