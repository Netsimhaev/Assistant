/**
 * Migration 063's id guard, run against crafted state. The migration has
 * already run on the test database, so each case seeds a malformed business id
 * inside a transaction that is always rolled back, and runs the guard's own
 * `DO $$ … $$` block — read from the migration file, not copied.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from './pool.js';
import { ensureSchema, testDb } from '../test/db.js';

const MIGRATION = readFileSync(
  fileURLToPath(new URL('./migrations/063_businesses.sql', import.meta.url)),
  'utf8',
);
const GUARD = /DO \$\$[\s\S]*?END \$\$;/.exec(MIGRATION)?.[0];

async function runGuard(seedIds: readonly string[]): Promise<Error | null> {
  if (GUARD === undefined) throw new Error('063 has no guard block');
  const client = await testDb().connect();
  try {
    await client.query('BEGIN');
    // Transactional in Postgres, so the rollback below restores everything.
    await client.query('TRUNCATE charter_versions, jobs, dashboard_users CASCADE');
    for (const [i, id] of seedIds.entries()) {
      await client.query(
        `INSERT INTO dashboard_users (business_id, username, password_hash, password_salt, login)
         VALUES ($1, 'owner', 'x', 'y', $2)`,
        [id, `owner${i}@example.com`],
      );
    }
    try {
      await client.query(GUARD);
    } catch (error) {
      return error as Error;
    }
    return null;
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

describe('migration 063 id guard', () => {
  it('finds the block it tests', () => {
    expect(GUARD).toBeDefined();
  });

  it('passes when every id fits the format', async () => {
    expect(await runGuard(['dev-business', 'acme-1'])).toBeNull();
  });

  it('refuses, naming every offending id', async () => {
    const error = await runGuard(['dev-business', 'Bad_ID', 'ab']);
    expect(error?.message).toContain('Bad_ID');
    expect(error?.message).toContain('ab');
    expect(error?.message).not.toContain('dev-business');
  });
});
