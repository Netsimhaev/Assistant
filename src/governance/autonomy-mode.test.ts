import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { loadAutonomyMode, rampBoundsForMode, setAutonomyMode } from './autonomy-mode.js';

const BUSINESS = 'test-business';

describe('the owner dial', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('is off when nobody has set it', async () => {
    expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('off');
  });

  /**
   * The bounds are the whole mechanism (spec 3.1): the dial does not enter the
   * gate, it decides only the window the ramp may sit in.
   *
   * BOTH ends matter, and the ceiling is the half an earlier draft of this
   * plan left out. With a floor alone, `off` could not pull a class that had
   * already been promoted back down — a switch labelled "off" that does not
   * stop her.
   */
  it('maps each mode to the window the ramp may sit in', () => {
    expect(rampBoundsForMode('off')).toEqual({ floor: 'draft_only', ceiling: 'draft_only' });
    expect(rampBoundsForMode('ask')).toEqual({
      floor: 'approve_required', ceiling: 'approve_required',
    });
    expect(rampBoundsForMode('learn')).toEqual({
      floor: 'approve_required', ceiling: 'auto_notify',
    });
  });

  it('stores what the owner chose and reads it back', async () => {
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('learn');
  });

  it('records the change in the audit trail, naming both levels and who', async () => {
    await setAutonomyMode('ask', 'owner@example.com', { businessId: BUSINESS });
    const { rows } = await getPool().query<{ reason: string; on_behalf_of: string }>(
      `SELECT reason, on_behalf_of FROM audit_log
        WHERE business_id = $1 AND kind = 'autonomy_change' ORDER BY seq DESC LIMIT 1`,
      [BUSINESS],
    );
    expect(rows[0]?.reason).toContain('off');
    expect(rows[0]?.reason).toContain('ask');
    expect(rows[0]?.on_behalf_of).toBe('owner@example.com');
  });

  /**
   * A value this build cannot rank must never be treated as a permission.
   * The CHECK constraint stops it at the database, so this writes past the
   * constraint deliberately to prove the reader is defended on its own.
   */
  it('falls to off on a mode string this build does not know', async () => {
    await getPool().query('ALTER TABLE autonomy_mode DROP CONSTRAINT autonomy_mode_known');
    try {
      await getPool().query(
        `INSERT INTO autonomy_mode (business_id, mode, updated_by) VALUES ($1, 'wide_open', 'x')`,
        [BUSINESS],
      );
      expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('off');
    } finally {
      // The row inserted above still holds 'wide_open', and ADD CONSTRAINT
      // validates every existing row — it would fail on the very row this
      // test put there on purpose. Clean it up before restoring the
      // constraint, or the constraint can never come back.
      await getPool().query('DELETE FROM autonomy_mode WHERE business_id = $1', [BUSINESS]);
      await getPool().query(
        `ALTER TABLE autonomy_mode ADD CONSTRAINT autonomy_mode_known
           CHECK (mode IN ('off', 'ask', 'learn'))`,
      );
    }
  });
});
