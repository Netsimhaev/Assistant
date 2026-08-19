import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { queryAudit } from '../audit/log.js';
import { resetDatabase } from '../test/db.js';
import { activeScopes, release, trip } from './killswitch.js';

const BUSINESS = 'test-business';
const BY = 'net.simhaev@gmail.com';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

/**
 * A sentinel that forces the audit insert to fail, without stubbing
 * `appendAudit` or any other module. A BEFORE INSERT trigger raises a real
 * Postgres error for any row whose `reason` carries the sentinel, so `trip()`
 * and `release()` run their real code path all the way to a genuine
 * transaction abort — the same failure mode a full disk or a constraint
 * violation would produce in production.
 */
const FORCE_FAILURE = 'FORCE_AUDIT_FAILURE_SENTINEL';

async function installAuditFailureTrigger(): Promise<void> {
  await getPool().query(`
    CREATE OR REPLACE FUNCTION test_force_audit_failure() RETURNS trigger AS $$
    BEGIN
      IF NEW.reason LIKE '%${FORCE_FAILURE}%' THEN
        RAISE EXCEPTION 'forced audit failure for test';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER force_audit_failure
      BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION test_force_audit_failure();
  `);
}

async function removeAuditFailureTrigger(): Promise<void> {
  await getPool().query(`
    DROP TRIGGER IF EXISTS force_audit_failure ON audit_log;
    DROP FUNCTION IF EXISTS test_force_audit_failure();
  `);
}

describe('trip() and release() are transactional with their audit entry', () => {
  afterEach(async () => {
    await removeAuditFailureTrigger();
  });

  it('leaves the kill switch unchanged when the audit append fails inside trip()', async () => {
    await installAuditFailureTrigger();

    await expect(
      trip('all', BY, FORCE_FAILURE, { businessId: BUSINESS }),
    ).rejects.toThrow();

    // The row must not exist at all — not "exists but still false" — because
    // trip() upserts, and a partial commit would leave a row with garbage
    // tripped_by/tripped_at from this attempt.
    expect(await activeScopes(BUSINESS)).toEqual([]);
    const { rows } = await getPool().query(
      'SELECT * FROM kill_switch WHERE business_id = $1',
      [BUSINESS],
    );
    expect(rows).toEqual([]);
    expect(await queryAudit({ businessId: BUSINESS, kind: 'kill_switch' })).toEqual([]);
  });

  it('rolls back a trip that was already active if the release audit append fails', async () => {
    await trip('all', BY, 'תקלה בבדיקה', { businessId: BUSINESS });
    const before = await activeScopes(BUSINESS);

    await installAuditFailureTrigger();

    await expect(
      release('all', BY, FORCE_FAILURE, { businessId: BUSINESS }),
    ).rejects.toThrow();

    // Still tripped: the UPDATE inside release() must have rolled back along
    // with the failed audit append, not left the switch released with no
    // record of who released it.
    expect(await activeScopes(BUSINESS)).toEqual(before);
    const entries = await queryAudit({ businessId: BUSINESS, kind: 'kill_switch' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toContain('TRIPPED');
  });

  it('release() on a scope that was never tripped throws and writes no audit row', async () => {
    await expect(
      release('all', BY, 'לא היה מה לשחרר', { businessId: BUSINESS }),
    ).rejects.toThrow(/not tripped/);

    expect(await activeScopes(BUSINESS)).toEqual([]);
    expect(await queryAudit({ businessId: BUSINESS, kind: 'kill_switch' })).toEqual([]);
  });
});
