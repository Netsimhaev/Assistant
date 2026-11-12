/**
 * Migration 067's carry-over block, run against crafted state.
 *
 * The migration has already run on the test database, so `credential_key_state`
 * is gone. Each case recreates it inside a transaction that is always rolled
 * back, seeds both tables, and runs 067's own `DO $$ … $$` block — read from
 * the migration file, not copied — so what is tested is the text that ships.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from './pool.js';
import { ensureSchema, testDb } from '../test/db.js';

const MIGRATION = readFileSync(
  fileURLToPath(new URL('./migrations/067_drop_business_key_state.sql', import.meta.url)),
  'utf8',
);
const DO_BLOCK = /DO \$\$[\s\S]*?END \$\$;/.exec(MIGRATION)?.[0];

interface KeyRow {
  businessId: string;
  keyId: string;
  /** One byte standing in for the sealed check value, so rows can be told apart. */
  mark: number;
}

interface ServerRow {
  key_id: string;
  check_business_id: string;
  check_value: Buffer;
}

/** Run the block on crafted state; return the server row it leaves, or the error it raised. */
async function runBlock(
  businessRows: readonly KeyRow[],
  serverRow: { keyId: string; mark: number } | null,
): Promise<{ rows: ServerRow[]; error: null } | { rows: null; error: Error }> {
  if (DO_BLOCK === undefined) throw new Error('067 has no DO block');
  const client: pg.PoolClient = await testDb().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TABLE credential_key_state (
         business_id TEXT PRIMARY KEY, key_id TEXT NOT NULL,
         check_nonce BYTEA NOT NULL, check_value BYTEA NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    await client.query('DELETE FROM server_key_state');
    for (const row of businessRows) {
      await client.query(
        `INSERT INTO credential_key_state (business_id, key_id, check_nonce, check_value) VALUES ($1, $2, $3, $4)`,
        [row.businessId, row.keyId, Buffer.from([row.mark]), Buffer.from([row.mark])],
      );
    }
    if (serverRow !== null) {
      await client.query(
        `INSERT INTO server_key_state (singleton, key_id, check_nonce, check_value) VALUES (true, $1, $2, $3)`,
        [serverRow.keyId, Buffer.from([serverRow.mark]), Buffer.from([serverRow.mark])],
      );
    }
    try {
      await client.query(DO_BLOCK);
    } catch (error) {
      return { rows: null, error: error as Error };
    }
    const { rows } = await client.query<ServerRow>(
      'SELECT key_id, check_business_id, check_value FROM server_key_state',
    );
    return { rows, error: null };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

beforeAll(async () => {
  await ensureSchema();
});

afterAll(async () => {
  await closePool();
});

describe('migration 067 carry-over block', () => {
  it('finds the block it tests', () => {
    expect(DO_BLOCK).toBeDefined();
  });

  it('one business row and no server row: copies it, naming its business', async () => {
    const result = await runBlock([{ businessId: 'dev-business', keyId: 'KEY-a', mark: 1 }], null);
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([{ key_id: 'KEY-a', check_business_id: 'dev-business', check_value: Buffer.from([1]) }]);
  });

  it('one business row beside a stale 064 copy: replaces the copy with the live row', async () => {
    const result = await runBlock([{ businessId: 'dev-business', keyId: 'KEY-new', mark: 2 }], { keyId: 'KEY-old', mark: 1 });
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([{ key_id: 'KEY-new', check_business_id: 'dev-business', check_value: Buffer.from([2]) }]);
  });

  it('several business rows and no server row: refuses', async () => {
    const result = await runBlock(
      [
        { businessId: 'biz-one', keyId: 'KEY-a', mark: 1 },
        { businessId: 'biz-two', keyId: 'KEY-b', mark: 2 },
      ],
      null,
    );
    expect(result.error?.message).toMatch(/holds 2 rows and server_key_state none/);
  });

  it('several business rows and a server row: takes the business of the row with the server key', async () => {
    const result = await runBlock(
      [
        { businessId: 'biz-one', keyId: 'KEY-a', mark: 1 },
        { businessId: 'biz-two', keyId: 'KEY-b', mark: 2 },
      ],
      { keyId: 'KEY-b', mark: 2 },
    );
    expect(result.error).toBeNull();
    // The server row's own seal is kept; only the business it names changes.
    expect(result.rows).toEqual([{ key_id: 'KEY-b', check_business_id: 'biz-two', check_value: Buffer.from([2]) }]);
  });

  it('several business rows and a server row that two of them name: refuses', async () => {
    const result = await runBlock(
      [
        { businessId: 'biz-one', keyId: 'KEY-a', mark: 1 },
        { businessId: 'biz-two', keyId: 'KEY-a', mark: 2 },
      ],
      { keyId: 'KEY-a', mark: 1 },
    );
    expect(result.error?.message).toMatch(/2 of them name the server key/);
  });

  it('several business rows and a server row that none of them name: refuses', async () => {
    const result = await runBlock(
      [
        { businessId: 'biz-one', keyId: 'KEY-a', mark: 1 },
        { businessId: 'biz-two', keyId: 'KEY-b', mark: 2 },
      ],
      { keyId: 'KEY-c', mark: 3 },
    );
    expect(result.error?.message).toMatch(/0 of them name the server key/);
  });
});
