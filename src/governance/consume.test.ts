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

  it('reject approval_requests with consumed_at set but consumed_by_step null', async () => {
    const pool = getPool();

    // Insert a valid approval_request first
    await pool.query(
      `INSERT INTO approval_requests
       (approval_id, business_id, action_class, summary, detail, risk,
        proposed_tool, proposed_input, input_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        'approval-123',
        'test-business',
        'email.send',
        'Test approval',
        'Test detail',
        '{}',
        'email.send',
        '{}',
        'abc123',
        new Date(Date.now() + 3600000).toISOString(),
      ],
    );

    // Try to set consumed_at without consumed_by_step — should fail
    await expect(
      pool.query(
        `UPDATE approval_requests SET consumed_at = NOW() WHERE approval_id = $1`,
        ['approval-123'],
      ),
    ).rejects.toThrow(/approval_consumption_both_or_neither|CHECK constraint/i);
  });

  it('reject dashboard_sessions for a username with no matching dashboard_users row', async () => {
    const pool = getPool();

    // Try to insert a session for a non-existent user
    await expect(
      pool.query(
        `INSERT INTO dashboard_sessions (session_id, business_id, username, expires_at)
         VALUES ($1, $2, $3, $4)`,
        ['session-123', 'test-business', 'nonexistent-user', new Date(Date.now() + 3600000).toISOString()],
      ),
    ).rejects.toThrow(/dashboard_sessions_owner_fk|FOREIGN KEY constraint/i);
  });
});
