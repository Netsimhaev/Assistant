import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

describe('the consumption columns', () => {
  it('start null, so an existing approval reads as unspent', async () => {
    const { rows } = await getPool().query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'approval_requests'
          AND column_name IN ('consumed_at', 'consumed_by_step')
        ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['consumed_at', 'consumed_by_step']);
    expect(rows.every((r) => r.column_default === null)).toBe(true);
  });
});
