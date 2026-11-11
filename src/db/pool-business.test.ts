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
import { config } from '../config.js';

function testLogins(): NonNullable<typeof config.testLogins> {
  if (config.testLogins === null) throw new Error('test logins are derived only under NODE_ENV=test');
  return config.testLogins;
}

/** The backend `pid` is gone from the server — the connection was destroyed, not pooled. */
async function expectBackendGone(pid: number | undefined): Promise<void> {
  expect(pid).toBeTypeOf('number');
  for (let i = 0; i < 50; i += 1) {
    const { rows } = await testDb().query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (rows.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`backend ${String(pid)} is still connected`);
}

/** With `max: 1`, the next checkout is either the same client or a fresh one. */
async function nextAppPid(): Promise<number | undefined> {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await expect(client.query('SELECT app_business_id()')).rejects.toThrow(/no business context/);
    return rows[0]?.pid;
  } finally {
    client.release();
  }
}

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

  it('a connection left in an open transaction is destroyed, not reused', async () => {
    await __setAppPoolMaxForTest(1);
    let pidInside: number | undefined;
    await withBusiness('biz-a', async (db) => {
      const { rows } = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      pidInside = rows[0]?.pid;
      // A raw BEGIN that is never closed: RESET would run inside it, and a
      // later ROLLBACK would bring biz-a back.
      await db.query('BEGIN');
    });
    await expectBackendGone(pidInside);
    expect(await nextAppPid()).not.toBe(pidInside);
  });

  it('a connection left in an aborted transaction is destroyed', async () => {
    await __setAppPoolMaxForTest(1);
    let pidInside: number | undefined;
    await expect(
      withBusiness('biz-a', async (db) => {
        const { rows } = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        pidInside = rows[0]?.pid;
        await db.query('BEGIN');
        // Aborts the transaction; the RESET in `finally` then fails too.
        await db.query('SELECT 1 / 0');
      }),
    ).rejects.toThrow(/division by zero/);
    await expectBackendGone(pidInside);
    expect(await nextAppPid()).not.toBe(pidInside);
  });

  it('a platform connection left in a transaction is destroyed', async () => {
    let pidInside: number | undefined;
    await withPlatform(async (db) => {
      const { rows } = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      pidInside = rows[0]?.pid;
      await db.query('BEGIN');
    });
    await expectBackendGone(pidInside);
    let abortedPid: number | undefined;
    await expect(
      withPlatform(async (db) => {
        const { rows } = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        abortedPid = rows[0]?.pid;
        await db.query('BEGIN');
        await db.query('SELECT 1 / 0');
      }),
    ).rejects.toThrow(/division by zero/);
    await expectBackendGone(abortedPid);
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
          platform: testLogins().platform,
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

  it('derives the test passwords from TEST_DATABASE_URL, one per login', () => {
    const { app, platform } = testLogins();
    expect(app.password).toMatch(/^[0-9a-f]{64}$/);
    expect(platform.password).toMatch(/^[0-9a-f]{64}$/);
    expect(app.password).not.toBe(platform.password);
  });

  it('gives the app login no CREATEROLE, CREATEDB or REPLICATION', async () => {
    const { rows } = await testDb().query<{
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolreplication: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      'SELECT rolcreaterole, rolcreatedb, rolreplication, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [testLogins().app.user],
    );
    expect(rows[0]).toEqual({
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolsuper: false,
      rolbypassrls: false,
    });
  });

  it('refuses an app login that is a member of the admin role or of the platform login', async () => {
    const probe = 'assistant_role_probe_test';
    const admin = await testDb().connect();
    try {
      await admin.query(`CREATE ROLE ${probe} NOLOGIN`);
      const logins = (): Parameters<typeof ensureRoles>[1] => ({
        app: { user: probe, password: 'probe-only' },
        platform: testLogins().platform,
      });

      await admin.query(`GRANT ${testLogins().platform.user} TO ${probe}`);
      await expect(ensureRoles(admin, logins())).rejects.toThrow(/member of assistant_platform_test/);
      await admin.query(`REVOKE ${testLogins().platform.user} FROM ${probe}`);

      const { rows: me } = await admin.query<{ q: string }>('SELECT quote_ident(current_user) AS q');
      await admin.query(`GRANT ${me[0]?.q ?? 'postgres'} TO ${probe}`);
      await expect(ensureRoles(admin, logins())).rejects.toThrow(/member of the admin role/);

      // Refused, so nothing about the probe changed.
      const { rows } = await admin.query<{ rolcanlogin: boolean }>(
        'SELECT rolcanlogin FROM pg_roles WHERE rolname = $1',
        [probe],
      );
      expect(rows[0]?.rolcanlogin).toBe(false);
    } finally {
      // Had a refusal regressed, ensureRoles would have granted the probe
      // CONNECT on this database; DROP OWNED clears that before DROP ROLE.
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${probe}') THEN DROP OWNED BY ${probe}; END IF; END $$`,
      );
      await admin.query(`DROP ROLE IF EXISTS ${probe}`);
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
