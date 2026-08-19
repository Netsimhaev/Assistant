import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { queryAudit } from '../audit/log.js';
import { resetDatabase } from '../test/db.js';
import { activeScopes, KillSwitchAuditUnrecordedError, release, trip } from './killswitch.js';

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

    -- The function is CREATE OR REPLACE (idempotent) but a bare CREATE
    -- TRIGGER is not: a run interrupted after this point (before afterEach's
    -- cleanup runs) leaves the trigger in place, and resetDatabase() only
    -- truncates tables — it does not drop triggers. Without this DROP,
    -- every later run would fail at "trigger already exists" instead of the
    -- test it was meant to run.
    DROP TRIGGER IF EXISTS force_audit_failure ON audit_log;
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

describe('trip() fails loud but does NOT roll back — the stop must hold', () => {
  afterEach(async () => {
    await removeAuditFailureTrigger();
  });

  it('leaves the kill switch TRIPPED when the audit append fails on first trip', async () => {
    await installAuditFailureTrigger();

    // Assert on the typed discriminator, not the message text — a caller
    // must be able to tell "stopped but unrecorded" from "the stop itself
    // failed" without regex-matching a human-readable string.
    let caught: unknown;
    try {
      await trip('all', BY, FORCE_FAILURE, { businessId: BUSINESS });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KillSwitchAuditUnrecordedError);
    const typedError = caught as KillSwitchAuditUnrecordedError;
    expect(typedError.switchInForce).toBe(true);
    // The original pg error survives as `cause` rather than being flattened
    // into the message string.
    expect(typedError.cause).toBeInstanceOf(Error);
    expect((typedError.cause as Error).message).toContain('forced audit failure');

    // The write must have committed even though the audit append failed and
    // the call threw: rolling back an emergency stop because its audit
    // couldn't also be written would defeat the one control meant to work
    // when everything else already has.
    const scopes = await activeScopes(BUSINESS);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.scope).toBe('all');
    expect(scopes[0]?.trippedBy).toBe(BY);
    // No audit row: the append genuinely failed and did not silently retry.
    expect(await queryAudit({ businessId: BUSINESS, kind: 'kill_switch' })).toEqual([]);
  });

  it('stamps the audit reason with the instant of the state write, not the append', async () => {
    const before = new Date();
    await trip('all', BY, 'עצירה עם חותמת זמן', { businessId: BUSINESS });
    const after = new Date();

    const entries = await queryAudit({ businessId: BUSINESS, kind: 'kill_switch' });
    expect(entries).toHaveLength(1);
    const match = entries[0]?.reason.match(/\[movedAt=([^\]]+)\]/);
    expect(match).not.toBeNull();
    const movedAt = new Date(match![1]!);
    // Sanity bounds rather than an exact match: movedAt was captured before
    // the state write, so it must fall between the moment the test called
    // trip() and the moment the audit query returned.
    expect(movedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(movedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('holds the new trip when re-tripping an already-tripped scope and the audit append fails', async () => {
    // First trip succeeds normally and is audited.
    await trip('all', BY, 'עצירה ראשונה', { businessId: BUSINESS });
    const firstAudit = await queryAudit({ businessId: BUSINESS, kind: 'kill_switch' });
    expect(firstAudit).toHaveLength(1);

    // Re-trip the same scope through the ON CONFLICT DO UPDATE path, with a
    // different actor and reason, while the audit append is forced to fail.
    await installAuditFailureTrigger();
    const secondBy = 'other.human@example.com';

    await expect(trip('all', secondBy, FORCE_FAILURE, { businessId: BUSINESS })).rejects.toThrow(
      KillSwitchAuditUnrecordedError,
    );

    // The re-trip's write must hold — trippedBy and reason reflect the
    // second call, not the first. A rollback here would silently keep the
    // switch attributed to the wrong actor with the wrong reason while
    // reporting (via the throw) that something went wrong, which is exactly
    // the kind of "looks stopped but isn't quite" state trip() must not
    // produce.
    const scopes = await activeScopes(BUSINESS);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.trippedBy).toBe(secondBy);
    expect(scopes[0]?.reason).toBe(FORCE_FAILURE);

    // Still only the one audit entry from the first, successful trip — the
    // second trip's audit entry never made it in.
    expect(await queryAudit({ businessId: BUSINESS, kind: 'kill_switch' })).toEqual(firstAudit);
  });
});

describe('release() is transactional with its audit entry — refusing to release is the safe failure', () => {
  afterEach(async () => {
    await removeAuditFailureTrigger();
  });

  it('rolls back a release if the audit append fails, leaving the scope still tripped', async () => {
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

  it('stamps the audit reason with the instant of the state write, not the append', async () => {
    await trip('all', BY, 'עצירה', { businessId: BUSINESS });

    const before = new Date();
    await release('all', BY, 'שחרור עם חותמת זמן', { businessId: BUSINESS });
    const after = new Date();

    const entries = await queryAudit({ businessId: BUSINESS, kind: 'kill_switch' });
    const released = entries.find((entry) => entry.reason.includes('RELEASED'));
    expect(released).toBeDefined();
    const match = released?.reason.match(/\[movedAt=([^\]]+)\]/);
    expect(match).not.toBeNull();
    const movedAt = new Date(match![1]!);
    expect(movedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(movedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('release() on a scope that was never tripped throws and writes no audit row', async () => {
    await expect(
      release('all', BY, 'לא היה מה לשחרר', { businessId: BUSINESS }),
    ).rejects.toThrow(/not tripped/);

    expect(await activeScopes(BUSINESS)).toEqual([]);
    expect(await queryAudit({ businessId: BUSINESS, kind: 'kill_switch' })).toEqual([]);
  });
});
