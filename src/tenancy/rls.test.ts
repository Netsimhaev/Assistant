/**
 * Spec §5.6 — the second wall: Row Level Security on every business table.
 *
 * The code filters by business (the first wall). Above it the database itself
 * refuses to return or write a row of any business but the connection's, so a
 * filter dropped from one query is a loud error rather than a leak.
 *
 * The tables come from `information_schema.columns` (every base table in
 * `public` with a `business_id` column), never from a list written here: a
 * table added next year with a `business_id` and no policy fails this file
 * by name, without anyone remembering to update it. And the scan first proves
 * it found tables — an empty scan that passes is not a control.
 *
 * Seeding runs on `testDb()` (the migrator, a superuser that RLS does not
 * apply to) with `session_replication_role = replica`, which skips the
 * foreign-key triggers: the point is one row per table, not a consistent
 * graph. CHECK constraints still apply; the generic seeder reads them for the
 * literals it needs, and the few it cannot satisfy have a hand-written entry
 * in `OVERRIDES` (`src/test/seed-every-table.ts`). A table neither can seed
 * fails the test by name.
 *
 * Everything asserted runs on the APP login (`withBusiness` /
 * `withNoBusiness`), which is NOBYPASSRLS and owns nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withBusiness, withNoBusiness, type Queryable } from '../db/pool.js';
import { withPlatform } from '../db/platform-pool.js';
import { ensureSchema, testDb } from '../test/db.js';
import { insertSql, seedEveryTable, seedRowFor } from '../test/seed-every-table.js';
import { config } from '../config.js';

const BIZ_A = 'rls-biz-a';
const BIZ_B = 'rls-biz-b';

/** Tables with a `business_id` that are NOT business data, and so carry no business policy. */
const EXCLUDED: ReadonlySet<string> = new Set([
  'businesses',
  'schema_migrations',
  'platform_credentials',
  'server_key_state',
  'dashboard_unknown_user_throttle',
  // The operator panel's staff (migration 072): the server's, not a business's.
  // platform_activity_log's business_id names the business an action touched;
  // it does not scope the row.
  'platform_staff',
  'platform_staff_sessions',
  'platform_staff_devices',
  'platform_staff_links',
  'platform_activity_log',
  // The panel's unknown-login bucket (migration 074): one server row, like the dashboard's.
  'platform_staff_unknown_login_throttle',
]);

const POLICY_NAME = 'tenant_isolation';

/**
 * Tables the runtime account may only SELECT and INSERT (UPDATE and DELETE are
 * revoked), so tests (2) and (3) below cannot issue those statements on them:
 * the privilege wall refuses before the policy is reached. Their isolation is
 * still covered by SELECT, by the policy checks and by the grants test.
 */
const APPEND_ONLY = new Set(['business_descriptions']);

/** Every base table in `public` with a `business_id` column, minus the named exclusions. */
async function businessTables(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT DISTINCT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND c.column_name = 'business_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY 1`,
  );
  return rows.map((r) => r.table_name).filter((t) => !EXCLUDED.has(t));
}

/**
 * The inverse: every base table in `public` that has NO `business_id` and is
 * not excluded by name. Business data without the column the policy reads is
 * data the wall cannot see, so it fails here by name.
 */
async function tablesNeitherBusinessNorExcluded(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT t.table_name
       FROM information_schema.tables t
      WHERE t.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name
             AND c.column_name = 'business_id')
      ORDER BY 1`,
  );
  return rows.map((r) => r.table_name).filter((t) => !EXCLUDED.has(t));
}

/**
 * The tables among `tables` whose wall is not closed, each with what is
 * missing: RLS not enabled, not FORCEd (the owner would bypass it), or no
 * `tenant_isolation` policy that reads `app_business_id()` both ways, or
 * any other policy beside it.
 */
async function wallProblems(db: Queryable, tables: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const table of tables) {
    const { rows } = await db.query<{ enabled: boolean; forced: boolean }>(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1`,
      [table],
    );
    const rel = rows[0];
    if (rel === undefined) {
      problems.push(`${table}: not found`);
      continue;
    }
    if (!rel.enabled) problems.push(`${table}: row level security not enabled`);
    if (!rel.forced) problems.push(`${table}: row level security not forced`);
    // Every policy on the table, not only ours: policies of the same kind
    // are OR-ed, so a second PERMISSIVE policy (`USING (true)`, say) would
    // open the table whatever `tenant_isolation` says.
    const { rows: policies } = await db.query<{
      name: string;
      permissive: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT policyname AS name, permissive, cmd, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = $1
        ORDER BY policyname`,
      [table],
    );
    const others = policies.filter((p) => p.name !== POLICY_NAME).map((p) => p.name);
    if (others.length > 0) problems.push(`${table}: other policies beside ${POLICY_NAME}: ${others.join(', ')}`);
    const policy = policies.find((p) => p.name === POLICY_NAME);
    const expected = '(business_id = app_business_id())';
    if (policy === undefined) {
      problems.push(`${table}: no ${POLICY_NAME} policy`);
    } else if (policy.permissive !== 'PERMISSIVE') {
      problems.push(`${table}: ${POLICY_NAME} policy is not PERMISSIVE`);
    } else if (policy.cmd !== 'ALL' || policy.qual !== expected || policy.with_check !== expected) {
      problems.push(`${table}: ${POLICY_NAME} policy is not business_id = app_business_id() for ALL`);
    }
  }
  return problems;
}

async function clearSeed(tables: readonly string[]): Promise<void> {
  const client = await testDb().connect();
  try {
    await client.query('BEGIN');
    // audit_log is append-only by trigger; replica mode skips it for the cleanup.
    await client.query('SET LOCAL session_replication_role = replica');
    for (const table of tables) {
      await client.query(`DELETE FROM ${table} WHERE business_id = ANY($1::text[])`, [[BIZ_A, BIZ_B]]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------

let tables: string[] = [];

beforeAll(async () => {
  await ensureSchema();
  tables = await businessTables(testDb());
  await clearSeed(tables);
});

afterAll(async () => {
  await clearSeed(tables);
});

describe('row level security on every business table (spec §5.6)', () => {
  it('finds the business tables (an empty scan is not a control)', () => {
    expect(tables.length).toBeGreaterThanOrEqual(55);
  });

  it('every business table has RLS enabled, forced, and the tenant_isolation policy', async () => {
    expect(await wallProblems(testDb(), tables)).toEqual([]);
  });

  it('a table with business_id and no policy fails by name', async () => {
    const probe = 'rls_probe_without_policy';
    await testDb().query(`DROP TABLE IF EXISTS ${probe}`);
    await testDb().query(`CREATE TABLE ${probe} (business_id TEXT NOT NULL)`);
    try {
      const found = await businessTables(testDb());
      expect(found).toContain(probe);
      const problems = await wallProblems(testDb(), [probe]);
      expect(problems).toContain(`${probe}: row level security not enabled`);
      expect(problems).toContain(`${probe}: no ${POLICY_NAME} policy`);
    } finally {
      await testDb().query(`DROP TABLE IF EXISTS ${probe}`);
    }
  });

  it('a second permissive policy beside tenant_isolation fails by name', async () => {
    const probe = 'rls_probe_extra_policy';
    await testDb().query(`DROP TABLE IF EXISTS ${probe}`);
    await testDb().query(`CREATE TABLE ${probe} (business_id TEXT NOT NULL)`);
    try {
      await testDb().query(`ALTER TABLE ${probe} ENABLE ROW LEVEL SECURITY`);
      await testDb().query(`ALTER TABLE ${probe} FORCE ROW LEVEL SECURITY`);
      await testDb().query(
        `CREATE POLICY ${POLICY_NAME} ON ${probe}
           USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id())`,
      );
      expect(await wallProblems(testDb(), [probe])).toEqual([]);
      await testDb().query(`CREATE POLICY wide_open ON ${probe} USING (true)`);
      expect(await wallProblems(testDb(), [probe])).toEqual([
        `${probe}: other policies beside ${POLICY_NAME}: wide_open`,
      ]);
      // And a RESTRICTIVE tenant_isolation is not the policy the wall is made of.
      await testDb().query(`DROP POLICY wide_open ON ${probe}`);
      await testDb().query(`DROP POLICY ${POLICY_NAME} ON ${probe}`);
      await testDb().query(
        `CREATE POLICY ${POLICY_NAME} ON ${probe} AS RESTRICTIVE
           USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id())`,
      );
      expect(await wallProblems(testDb(), [probe])).toEqual([`${probe}: ${POLICY_NAME} policy is not PERMISSIVE`]);
    } finally {
      await testDb().query(`DROP TABLE IF EXISTS ${probe}`);
    }
  });

  it('every public table either has business_id or is excluded by name', async () => {
    expect(await tablesNeitherBusinessNorExcluded(testDb())).toEqual([]);
  });

  it('a new table with neither business_id nor an exclusion fails by name', async () => {
    const probe = 'rls_probe_no_business_id';
    await testDb().query(`DROP TABLE IF EXISTS ${probe}`);
    await testDb().query(`CREATE TABLE ${probe} (note TEXT)`);
    try {
      expect(await tablesNeitherBusinessNorExcluded(testDb())).toEqual([probe]);
    } finally {
      await testDb().query(`DROP TABLE IF EXISTS ${probe}`);
    }
  });

  describe('a row of business A, seen from business B', () => {
    beforeAll(async () => {
      const { failed } = await seedEveryTable(tables, BIZ_A);
      // Named, so a table the seeder cannot satisfy is a red with its name in it.
      expect(failed).toEqual([]);
    });

    it('is seeded in every table (as the migrator)', async () => {
      for (const table of tables) {
        const { rows } = await testDb().query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table} WHERE business_id = $1`,
          [BIZ_A],
        );
        expect({ table, n: rows[0]?.n }).toEqual({ table, n: '1' });
      }
    });

    it('is visible to business A itself (the policy is not a blanket deny)', async () => {
      await withBusiness(BIZ_A, async (db) => {
        for (const table of tables) {
          const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
          expect({ table, n: rows[0]?.n }).toEqual({ table, n: '1' });
        }
      });
    });

    it('(1) SELECT sees nothing', async () => {
      await withBusiness(BIZ_B, async (db) => {
        for (const table of tables) {
          const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
          expect({ table, n: rows[0]?.n }).toEqual({ table, n: '0' });
        }
      });
    });

    it('(2) UPDATE touches nothing', async () => {
      await withBusiness(BIZ_B, async (db) => {
        for (const table of tables.filter((t) => !APPEND_ONLY.has(t))) {
          const result = await db.query(`UPDATE ${table} SET business_id = business_id`);
          expect({ table, n: result.rowCount }).toEqual({ table, n: 0 });
        }
      });
    });

    it('(3) DELETE touches nothing', async () => {
      await withBusiness(BIZ_B, async (db) => {
        for (const table of tables.filter((t) => !APPEND_ONLY.has(t))) {
          const result = await db.query(`DELETE FROM ${table}`);
          expect({ table, n: result.rowCount }).toEqual({ table, n: 0 });
        }
      });
      // And A's row is still there, read as the migrator.
      for (const table of tables) {
        const { rows } = await testDb().query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table} WHERE business_id = $1`,
          [BIZ_A],
        );
        expect({ table, n: rows[0]?.n }).toEqual({ table, n: '1' });
      }
    });

    it("(4) an INSERT carrying business A's id is rejected by the policy", async () => {
      // The same row the seeder wrote — so the rejection must name the policy,
      // not a CHECK or a missing column: a test that passes on any error
      // proves nothing about RLS.
      const rows: Record<string, { sql: string; params: unknown[] }> = {};
      for (const table of tables) {
        const row = await seedRowFor(testDb(), table, BIZ_A);
        rows[table] = { sql: insertSql(table, row), params: row.params };
      }
      await withBusiness(BIZ_B, async (db) => {
        for (const table of tables) {
          const { sql, params } = rows[table] ?? { sql: '', params: [] };
          let message = '';
          try {
            await db.query(sql, params);
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect({ table, message }).toEqual({
            table,
            message: `new row violates row-level security policy for table "${table}"`,
          });
        }
      });
    });

    it('business A writes its own rows and cannot move one to business B', async () => {
      // One representative table: kept_items, with no foreign key to satisfy.
      await withBusiness(BIZ_A, async (db) => {
        const inserted = await db.query(
          `INSERT INTO kept_items (business_id, item_kind, item_id) VALUES ($1, 'job', 'rls-own-row')`,
          [BIZ_A],
        );
        expect(inserted.rowCount).toBe(1);
        const updated = await db.query(`UPDATE kept_items SET note = 'mine' WHERE item_id = 'rls-own-row'`);
        expect(updated.rowCount).toBe(1);
        await expect(
          db.query(`UPDATE kept_items SET business_id = $1 WHERE item_id = 'rls-own-row'`, [BIZ_B]),
        ).rejects.toThrow('new row violates row-level security policy for table "kept_items"');
      });
      const { rows } = await testDb().query<{ business_id: string; note: string | null }>(
        `SELECT business_id, note FROM kept_items WHERE item_id = 'rls-own-row'`,
      );
      expect(rows).toEqual([{ business_id: BIZ_A, note: 'mine' }]);
      await testDb().query(`DELETE FROM kept_items WHERE item_id = 'rls-own-row'`);
    });

    it('(5) a connection whose business was set and then RESET throws, never reads empty', async () => {
      await withBusiness(BIZ_A, async (db) => {
        await db.query('RESET app.business_id');
        for (const table of tables) {
          await expect(db.query(`SELECT count(*) FROM ${table}`), table).rejects.toThrow(/no business context/);
        }
      });
    });

    it('a withNoBusiness connection throws on every business table', async () => {
      await withNoBusiness(async (db) => {
        for (const table of tables) {
          await expect(db.query(`SELECT count(*) FROM ${table}`), table).rejects.toThrow(/no business context/);
        }
      });
    });

    it('a fresh app connection that never had a business throws too', async () => {
      const client = new pg.Client({ connectionString: config.databaseUrl });
      await client.connect();
      try {
        for (const table of tables) {
          await expect(client.query(`SELECT count(*) FROM ${table}`), table).rejects.toThrow(/no business context/);
        }
      } finally {
        await client.end();
      }
    });

    it('the platform login reads every business (BYPASSRLS)', async () => {
      await withPlatform(async (db) => {
        for (const table of tables) {
          const { rows } = await db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${table} WHERE business_id = $1`,
            [BIZ_A],
          );
          expect({ table, n: rows[0]?.n }).toEqual({ table, n: '1' });
        }
      });
    });
  });
});

describe('the excluded tables: only what the app path provably uses', () => {
  // `withNoBusiness` reaches two server tables and no business table: the
  // throttle (read, clear, upsert) and `server_key_state` (read only: the key
  // id and the key check's ciphertext, never a secret).
  it('withNoBusiness can use the unknown-user throttle and read server_key_state', async () => {
    await withNoBusiness(async (db) => {
      await db.query('BEGIN');
      try {
        await db.query(
          `INSERT INTO dashboard_unknown_user_throttle (singleton, failed_attempts) VALUES (true, 1)
           ON CONFLICT (singleton) DO UPDATE SET failed_attempts = dashboard_unknown_user_throttle.failed_attempts + 1`,
        );
        await db.query('SELECT failed_attempts FROM dashboard_unknown_user_throttle');
        await db.query('UPDATE dashboard_unknown_user_throttle SET failed_attempts = 0');
        await db.query('SELECT key_id, check_nonce, check_value FROM server_key_state');
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });

  it('the app reads server_key_state and cannot write it', async () => {
    await withBusiness(BIZ_A, async (db) => {
      await db.query('SELECT key_id FROM server_key_state');
      // Each write in a transaction that is rolled back, so a red run cannot
      // delete the key state another test relies on.
      const writes = [
        'DELETE FROM server_key_state',
        `INSERT INTO server_key_state (singleton, key_id, check_nonce, check_value)
         VALUES (true, 'k', decode('00', 'hex'), decode('00', 'hex'))`,
        "UPDATE server_key_state SET key_id = 'k'",
      ];
      for (const sql of writes) {
        await db.query('BEGIN');
        try {
          await expect(db.query(sql), sql).rejects.toThrow(/permission denied/);
        } finally {
          await db.query('ROLLBACK');
        }
      }
    });
  });

  it('the app cannot touch businesses, platform_credentials or schema_migrations', async () => {
    await withBusiness(BIZ_A, async (db) => {
      for (const table of ['businesses', 'platform_credentials', 'schema_migrations']) {
        await expect(db.query(`SELECT 1 FROM ${table}`), table).rejects.toThrow(/permission denied/);
      }
    });
  });

  it('the platform login keeps what the cross-business operations use', async () => {
    await withPlatform(async (db) => {
      await db.query('BEGIN');
      try {
        await db.query('SELECT 1 FROM businesses');
        await db.query(
          `INSERT INTO businesses (business_id, display_name) VALUES ('rls-probe-biz', 'x')
           ON CONFLICT (business_id) DO NOTHING`,
        );
        await db.query(`UPDATE businesses SET status = 'active' WHERE business_id = 'rls-probe-biz'`);
        await db.query('SELECT ref FROM platform_credentials');
        await db.query(`DELETE FROM platform_credentials WHERE ref = 'RLS_PROBE'`);
        await db.query('SELECT key_id FROM server_key_state');
        await db.query(`UPDATE server_key_state SET key_id = key_id`);
        await expect(db.query('SELECT 1 FROM schema_migrations')).rejects.toThrow(/permission denied/);
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });

  it('the app login may use every sequence (identity and serial columns still insert)', async () => {
    const { rows } = await testDb().query<{ seq: string; ok: boolean }>(
      `SELECT sequence_name AS seq, has_sequence_privilege('assistant_app', 'public.' || quote_ident(sequence_name), 'USAGE') AS ok
         FROM information_schema.sequences WHERE sequence_schema = 'public'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    // The one sequence of an excluded table (migration 072): the app account
    // reaches nothing of the panel's activity log, its sequence included.
    expect(rows.filter((r) => !r.ok && r.seq !== 'platform_activity_log_seq_seq')).toEqual([]);
    expect(rows.find((r) => r.seq === 'platform_activity_log_seq_seq')?.ok).toBe(false);
  });
});

/**
 * Migration 068's last block adds an EXISTING platform login to
 * `assistant_platform_group`, so a server keeps working between the migrate
 * and the next `db:roles`. It finds the login as "a BYPASSRLS login in
 * `assistant_app`". The block is read from the shipped file and run again, so
 * the test exercises the SQL that actually ships, not a copy.
 */
describe('migration 068 adds only the BYPASSRLS logins of assistant_app to the platform group', () => {
  const MIGRATION = fileURLToPath(new URL('../db/migrations/068_rls.sql', import.meta.url));

  function enrolBlock(): string {
    const sql = readFileSync(MIGRATION, 'utf8');
    const start = sql.lastIndexOf('\nDO $$');
    const block = sql.slice(start).trim();
    // Proof the slice is the block meant, not some other DO block.
    expect(block).toContain('GRANT assistant_platform_group TO %I');
    expect(block).toContain('m.rolbypassrls');
    return block;
  }

  it('picks (c) and leaves (a) and (b) alone', async () => {
    const probes = {
      a: 'rls_probe_login_app_nobypass',
      b: 'rls_probe_login_bypass_outside',
      c: 'rls_probe_login_bypass_in_app',
    };
    const db = testDb();
    try {
      for (const role of Object.values(probes)) await db.query(`DROP ROLE IF EXISTS ${role}`);
      await db.query(`CREATE ROLE ${probes.a} LOGIN NOBYPASSRLS IN ROLE assistant_app`);
      await db.query(`CREATE ROLE ${probes.b} LOGIN BYPASSRLS`);
      await db.query(`CREATE ROLE ${probes.c} LOGIN BYPASSRLS IN ROLE assistant_app`);

      await db.query(enrolBlock());

      const { rows } = await db.query<{ role: string; member: boolean }>(
        `SELECT r AS role, pg_has_role(r, 'assistant_platform_group', 'MEMBER') AS member
           FROM unnest($1::text[]) AS r ORDER BY r`,
        [Object.values(probes)],
      );
      expect(Object.fromEntries(rows.map((row) => [row.role, row.member]))).toEqual({
        [probes.a]: false,
        [probes.b]: false,
        [probes.c]: true,
      });
    } finally {
      for (const role of Object.values(probes)) await db.query(`DROP ROLE IF EXISTS ${role}`);
    }
  });
});
