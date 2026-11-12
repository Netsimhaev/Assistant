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
 * in `OVERRIDES`. A table neither can seed fails the test by name.
 *
 * Everything asserted runs on the APP login (`withBusiness` /
 * `withNoBusiness`), which is NOBYPASSRLS and owns nothing.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withBusiness, withNoBusiness, type Queryable } from '../db/pool.js';
import { withPlatform } from '../db/platform-pool.js';
import { ensureSchema, testDb } from '../test/db.js';
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
]);

const POLICY_NAME = 'tenant_isolation';

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
 * The tables among `tables` whose wall is not closed, each with what is
 * missing: RLS not enabled, not FORCEd (the owner would bypass it), or no
 * `tenant_isolation` policy that reads `app_business_id()` both ways.
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
    const { rows: policies } = await db.query<{ cmd: string; qual: string | null; with_check: string | null }>(
      `SELECT cmd, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = $1 AND policyname = $2`,
      [table, POLICY_NAME],
    );
    const policy = policies[0];
    const expected = '(business_id = app_business_id())';
    if (policy === undefined) {
      problems.push(`${table}: no ${POLICY_NAME} policy`);
    } else if (policy.cmd !== 'ALL' || policy.qual !== expected || policy.with_check !== expected) {
      problems.push(`${table}: ${POLICY_NAME} policy is not business_id = app_business_id() for ALL`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The generic seeder
// ---------------------------------------------------------------------------

interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
}

/** One row for a table: the columns and their SQL value expressions, with params. */
interface SeedRow {
  columns: string[];
  values: string[];
  params: unknown[];
}

/**
 * Column values the generic seeder cannot derive from a CHECK: a JSON shape a
 * CHECK names by type, a pair of columns one CHECK ties together. Each is a
 * value for one column, merged over the generic row. Keep it short — every
 * entry is a place the seeder could not read the schema.
 */
const OVERRIDES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // `window_end > window_start`: two columns, one CHECK.
  digests: { window_start: '2026-01-01T00:00:00Z', window_end: '2026-01-02T00:00:00Z' },
  // `(status = 'read') = (content IS NOT NULL)`: the status that needs no content.
  document_readings: { status: 'unreadable' },
  proposals: { status: 'unproposable' },
  // One field per kind: `family` with its family, the others left NULL.
  ledger_critical_rules: { kind: 'family', family: 'money_in' },
};

async function columnsOf(db: Queryable, table: string): Promise<ColumnInfo[]> {
  const { rows } = await db.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    is_identity: string;
  }>(
    `SELECT column_name, data_type, is_nullable, column_default, is_identity
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => ({
    name: r.column_name,
    dataType: r.data_type,
    nullable: r.is_nullable === 'YES',
    hasDefault: r.column_default !== null || r.is_identity === 'YES',
  }));
}

async function checksOf(db: Queryable, table: string): Promise<string[]> {
  const { rows } = await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = ('public.' || quote_ident($1))::regclass AND contype = 'c'`,
    [table],
  );
  return rows.map((r) => r.def);
}

function mentions(check: string, column: string): boolean {
  return new RegExp(`(^|[^a-z0-9_])${column}([^a-z0-9_]|$)`).test(check);
}

/**
 * A text value that satisfies the CHECKs naming `column`: the first literal of
 * an `= ANY (ARRAY[...])` or `= '...'` on it, a 64-hex digest for a sha256
 * shape, an upper-case ref for `^[A-Z0-9_]+$`. Plain `'x'` otherwise.
 */
function textValue(column: string, checks: readonly string[]): string {
  for (const check of checks.filter((c) => mentions(c, column))) {
    const anyOf = new RegExp(`${column} = ANY \\(ARRAY\\['((?:[^']|'')*)'`).exec(check);
    if (anyOf?.[1] !== undefined) return anyOf[1].replace(/''/g, "'");
    const equals = new RegExp(`${column} = '((?:[^']|'')*)'::text`).exec(check);
    if (equals?.[1] !== undefined) return equals[1].replace(/''/g, "'");
    if (/\[0-9a-f\]\{64\}/.test(check)) return 'a'.repeat(64);
    if (check.includes('[A-Z0-9_]')) return 'X';
  }
  return 'x';
}

/** The JSON a CHECK on `column` asks for by `jsonb_typeof`, else an empty object. */
function jsonValue(column: string, checks: readonly string[]): string {
  for (const check of checks.filter((c) => mentions(c, column))) {
    if (/jsonb_typeof\([^)]*\) = 'array'/.test(check)) return '[]';
  }
  return '{}';
}

async function seedRowFor(db: Queryable, table: string, businessId: string): Promise<SeedRow> {
  const columns = await columnsOf(db, table);
  const checks = await checksOf(db, table);
  const override = OVERRIDES[table] ?? {};
  const row: SeedRow = { columns: [], values: [], params: [] };
  const param = (value: unknown, cast: string): string => {
    row.params.push(value);
    return `$${row.params.length}::${cast}`;
  };

  for (const col of columns) {
    if (col.name === 'business_id') {
      row.columns.push(col.name);
      row.values.push(param(businessId, 'text'));
      continue;
    }
    if (Object.hasOwn(override, col.name)) {
      row.columns.push(col.name);
      row.values.push(param(override[col.name], col.dataType === 'ARRAY' ? 'text[]' : castFor(col.dataType)));
      continue;
    }
    if (col.nullable || col.hasDefault) continue;
    row.columns.push(col.name);
    row.values.push(generatedValue(col, checks, param));
  }
  return row;
}

function castFor(dataType: string): string {
  switch (dataType) {
    case 'character varying':
      return 'text';
    case 'timestamp with time zone':
      return 'timestamptz';
    case 'timestamp without time zone':
      return 'timestamp';
    default:
      return dataType;
  }
}

function generatedValue(
  col: ColumnInfo,
  checks: readonly string[],
  param: (value: unknown, cast: string) => string,
): string {
  switch (col.dataType) {
    case 'text':
    case 'character varying':
      return param(textValue(col.name, checks), 'text');
    case 'integer':
    case 'bigint':
    case 'smallint':
    case 'numeric':
      return `1::${col.dataType}`;
    case 'boolean':
      return 'true';
    case 'timestamp with time zone':
      return 'now()';
    case 'timestamp without time zone':
      return 'now()::timestamp';
    case 'date':
      return 'current_date';
    case 'jsonb':
    case 'json':
      return param(jsonValue(col.name, checks), col.dataType);
    case 'ARRAY':
      return `'{}'`;
    case 'bytea':
      return `decode('00', 'hex')`;
    case 'uuid':
      return 'gen_random_uuid()';
    default:
      throw new Error(`no generic value for ${col.name} (${col.dataType})`);
  }
}

function insertSql(table: string, row: SeedRow): string {
  return `INSERT INTO ${table} (${row.columns.join(', ')}) VALUES (${row.values.join(', ')})`;
}

/**
 * Seed one row for `businessId` in every table, on the migrator. A savepoint
 * per table, so one table that will not seed is named and the rest still are.
 */
async function seedEveryTable(tables: readonly string[], businessId: string): Promise<{ failed: string[] }> {
  const client = await testDb().connect();
  const failed: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    for (const table of tables) {
      await client.query('SAVEPOINT seed');
      try {
        const row = await seedRowFor(client, table, businessId);
        await client.query(insertSql(table, row), row.params);
        await client.query('RELEASE SAVEPOINT seed');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT seed');
        failed.push(`${table}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { failed };
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
        for (const table of tables) {
          const result = await db.query(`UPDATE ${table} SET business_id = business_id`);
          expect({ table, n: result.rowCount }).toEqual({ table, n: 0 });
        }
      });
    });

    it('(3) DELETE touches nothing', async () => {
      await withBusiness(BIZ_B, async (db) => {
        for (const table of tables) {
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
  it('withNoBusiness can use the unknown-user throttle, and only it', async () => {
    await withNoBusiness(async (db) => {
      await db.query('BEGIN');
      try {
        await db.query(
          `INSERT INTO dashboard_unknown_user_throttle (singleton, failed_attempts) VALUES (true, 1)
           ON CONFLICT (singleton) DO UPDATE SET failed_attempts = dashboard_unknown_user_throttle.failed_attempts + 1`,
        );
        await db.query('SELECT failed_attempts FROM dashboard_unknown_user_throttle');
        await db.query('UPDATE dashboard_unknown_user_throttle SET failed_attempts = 0');
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
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });
});
