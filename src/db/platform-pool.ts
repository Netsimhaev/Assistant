import pg from 'pg';
import { config } from '../config.js';
import { isIdleOutsideTransaction, type Queryable } from './pool.js';

/**
 * The PLATFORM pool — logs in as the BYPASSRLS login, for the named
 * cross-business operations only (spec §5.7). Ordinary code never receives
 * it: only `src/tenancy/`, `src/cli/`, `src/db/` and
 * `src/orchestrator/run-scheduler.ts` may import this module.
 */
let platformPool: pg.Pool | undefined;

function getPlatformPool(): pg.Pool {
  platformPool ??= new pg.Pool({
    connectionString: config.databasePlatformUrl,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return platformPool;
}

export async function withPlatform<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await getPlatformPool().connect();
  try {
    return await fn(client);
  } finally {
    // A BYPASSRLS session left in an open or aborted transaction must not be
    // handed to the next cross-business operation.
    client.release(!isIdleOutsideTransaction(client));
  }
}

export async function closePlatformPool(): Promise<void> {
  const open = platformPool;
  platformPool = undefined;
  await open?.end();
}
