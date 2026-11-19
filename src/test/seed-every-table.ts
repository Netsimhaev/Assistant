/**
 * The generic seeder: one row for a business in every table it is given, its
 * values read off the schema (column types and CHECK literals), on the
 * migrator with `session_replication_role = replica` so foreign keys are not
 * checked. Shared by `tenancy/rls.test.ts` (the wall) and
 * `tenancy/business-deletion-sql.test.ts` (the whole-business delete), so a
 * table one of them can seed the other can too.
 */
import type { Queryable } from '../db/pool.js';
import { testDb } from './db.js';

interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
}

/** One row for a table: the columns and their SQL value expressions, with params. */
export interface SeedRow {
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

export async function seedRowFor(db: Queryable, table: string, businessId: string): Promise<SeedRow> {
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

export function insertSql(table: string, row: SeedRow): string {
  return `INSERT INTO ${table} (${row.columns.join(', ')}) VALUES (${row.values.join(', ')})`;
}

/**
 * Seed one row for `businessId` in every table, on the migrator. A savepoint
 * per table, so one table that will not seed is named and the rest still are.
 */
export async function seedEveryTable(tables: readonly string[], businessId: string): Promise<{ failed: string[] }> {
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
