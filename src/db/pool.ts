import pg from 'pg';
import { config } from '../config.js';

/**
 * Postgres returns BIGINT (oid 20) as a string by default to avoid silent
 * precision loss. The audit sequence is a bigint and we want it as one, so we
 * parse it explicitly rather than letting a string leak into the domain types.
 */
pg.types.setTypeParser(20, (value: string) => BigInt(value));

/**
 * NUMERIC (oid 1700) also arrives as a string. We never store money as NUMERIC
 * — money is BIGINT minor units — so leaving this as a string is correct and
 * deliberate: anything that surfaces here is a decimal we must not float.
 */

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Every write that must be atomic with its audit entry goes through here —
 * "the memory write and its audit record land in the same transaction" is the
 * property that makes the trail trustworthy (docs/06-memory.md).
 */
export async function withTransaction<T>(
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      // Rollback failure means the connection is already broken; the original
      // error is the one worth propagating.
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Postgres advisory lock keyed on an arbitrary string, held for the transaction.
 *
 * Used for the serialisation rules that are non-negotiable: one outbound
 * message per counterparty thread, one writer per calendar, all spend in a job
 * serialised (docs/02-orchestrator.md).
 */
export async function acquireAdvisoryLock(
  tx: Queryable,
  scope: string,
): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope]);
}
