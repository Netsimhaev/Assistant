import pg from 'pg';
import { config } from '../config.js';
import { SafeLookupKey } from '../domain/charter.js';

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

/**
 * The app pool's size: `DATABASE_POOL_MAX`, default 20 (`config.ts`).
 *
 * **A capacity bound, not a tuning knob.** Every authenticated dashboard
 * request holds ONE connection for its whole life (`withBusiness` in the
 * server's `handleRequest`) — including slow ones: a model call behind
 * `/instruct`, a provider round trip behind an OAuth callback, an upload. So
 * the number of requests in flight at once, plus whatever the scheduler holds,
 * is capped by this. Code on a request path must therefore never acquire a
 * SECOND connection while its request's one is held — that is hold-and-wait,
 * and at pool-size concurrency every request waits for a connection only
 * another waiting request can free. Pass the request's `db` down instead
 * (`CredentialSource.resolve`'s optional `db` exists for exactly that).
 */
let pool: pg.Pool | undefined;
let appPoolMax = config.databasePoolMax;
let migratorPool: pg.Pool | undefined;

function buildPool(connectionString: string, max: number): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/**
 * The APPLICATION pool: logs in as a member of `assistant_app` — NOBYPASSRLS,
 * owner of nothing. `withBusiness` checks out from this same pool.
 *
 * Kept for now; Task 12 deletes it from production code, at which point every
 * query goes through `withBusiness`.
 */
export function getPool(): pg.Pool {
  pool ??= buildPool(config.databaseUrl, appPoolMax);
  return pool;
}

/**
 * The MIGRATOR pool — the role that owns every table. Migrations, `db:roles`
 * and test seeding/teardown only (TRUNCATE, DDL, trigger toggles). Never a
 * run-time path: a process that queries as the table owner is a process RLS
 * does not apply to.
 */
export function getMigratorPool(): pg.Pool {
  migratorPool ??= buildPool(config.databaseMigrateUrl, 4);
  return migratorPool;
}

export async function closePool(): Promise<void> {
  const open = [pool, migratorPool];
  pool = undefined;
  migratorPool = undefined;
  await Promise.all(open.map((p) => p?.end()));
}

/**
 * Test-only: rebuild the app pool with another `max`, so a test can prove the
 * NEXT checkout of a connection is the very one that just errored (`max: 1`).
 */
export async function __setAppPoolMaxForTest(max: number): Promise<void> {
  if (!config.isTest) throw new Error('__setAppPoolMaxForTest is test-only');
  if (max === appPoolMax && pool !== undefined) return;
  const old = pool;
  pool = undefined;
  appPoolMax = max;
  await old?.end();
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * A connection scoped to one business. `app.business_id` is set on the
 * session for as long as the caller holds it, and `app_business_id()` (what
 * every RLS policy calls) returns it.
 */
export interface BusinessDb extends Queryable {
  readonly businessId: string;
  readonly inTransaction: boolean;
}

/** Global Constraints: `^[a-z0-9-]{3,63}$`, and a key that is safe as an object key. */
const BUSINESS_ID_SHAPE = /^[a-z0-9-]{3,63}$/;

export function isValidBusinessId(id: string): boolean {
  return BUSINESS_ID_SHAPE.test(id) && SafeLookupKey.safeParse(id).success;
}

function assertBusinessId(id: string): void {
  if (!isValidBusinessId(id)) {
    // The id is not echoed: it may be whatever a caller passed in.
    throw new Error('invalid business id — expected ^[a-z0-9-]{3,63}$');
  }
}

function businessDb(client: pg.PoolClient, businessId: string, inTransaction: boolean): BusinessDb {
  return {
    businessId,
    inTransaction,
    query: client.query.bind(client) as Queryable['query'],
  };
}

/**
 * True only when the server's last ReadyForQuery said "idle" ('I'): not in a
 * transaction ('T'), not in an aborted one ('E'), and not unknown (null).
 * A connection that is anything else must be destroyed, never pooled.
 */
export function isIdleOutsideTransaction(client: pg.PoolClient): boolean {
  return client.getTransactionStatus() === 'I';
}

/**
 * Run `fn` on one app-pool connection whose SESSION carries `businessId`.
 *
 * Session-level, never transaction-level (`set_config(..., false)`): code that
 * holds a session advisory lock and queries outside a transaction must be
 * covered too. In `finally` the setting is RESET before the connection goes
 * back; a connection whose RESET fails, or that is still inside a
 * transaction (open or aborted), is destroyed (`release(true)`), never
 * returned — a pooled connection carrying business A that reaches a request
 * for business B is exactly the leak the wall exists to prevent.
 *
 * The id is validated before the pool is touched.
 */
export async function withBusiness<T>(
  businessId: string,
  fn: (db: BusinessDb) => Promise<T>,
): Promise<T> {
  assertBusinessId(businessId);
  const client = await getPool().connect();
  let destroy = false;
  try {
    try {
      await client.query("SELECT set_config('app.business_id', $1, false)", [businessId]);
    } catch (error) {
      destroy = true;
      throw error;
    }
    return await fn(businessDb(client, businessId, false));
  } finally {
    if (!destroy) {
      try {
        await client.query('RESET app.business_id');
      } catch {
        // Aborted transaction, broken socket — either way the session may
        // still carry the business. It must not be reused.
        destroy = true;
      }
    }
    // A RESET that ran inside a transaction `fn` left open does not last: a
    // later ROLLBACK restores the old business. Only a connection that is
    // idle — no open, no aborted transaction — goes back to the pool.
    if (!isIdleOutsideTransaction(client)) destroy = true;
    client.release(destroy);
  }
}

/**
 * Run `fn` on one app-pool connection that carries NO business — for the few
 * server-wide rows the app role touches before any business is known (the
 * dashboard's unknown-login throttle, `dashboard_unknown_user_throttle`).
 *
 * The connection is explicitly cleared first, so `app_business_id()` raises
 * on it: a query here that reaches a table with a business policy fails
 * loudly instead of reading some business's rows. Released under the same
 * rule as `withBusiness` — anything but idle is destroyed.
 */
export async function withNoBusiness<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let destroy = false;
  try {
    try {
      await client.query('RESET app.business_id');
    } catch (error) {
      destroy = true;
      throw error;
    }
    return await fn(client);
  } finally {
    if (!isIdleOutsideTransaction(client)) destroy = true;
    client.release(destroy);
  }
}

/**
 * Run `fn` in a transaction on `db`. On a db already in a transaction it joins
 * (runs `fn(db)`), so a throw anywhere rolls back the outermost one.
 */
export async function transaction<T>(
  db: BusinessDb,
  fn: (tx: BusinessDb) => Promise<T>,
): Promise<T> {
  if (db.inTransaction) return fn(db);
  const tx: BusinessDb = { businessId: db.businessId, inTransaction: true, query: db.query };
  await db.query('BEGIN');
  try {
    const result = await fn(tx);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {
      // A failed rollback leaves the session in a transaction; `withBusiness`'s
      // RESET then fails too and the connection is destroyed. The original
      // error is the one worth propagating.
    });
    throw error;
  }
}

export async function withBusinessTransaction<T>(
  businessId: string,
  fn: (tx: BusinessDb) => Promise<T>,
): Promise<T> {
  return withBusiness(businessId, (db) => transaction(db, fn));
}

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
