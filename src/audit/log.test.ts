import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness, withBusinessTransaction } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { appendAudit, queryAudit, verifyChain } from './log.js';
import { GENESIS_HASH } from '../domain/audit.js';
import { canonicalHash } from '../util/canonical.js';

const BUSINESS = 'audit-test';

function entry(reason: string) {
  return {
    actor: 'orchestrator' as const,
    kind: 'decision' as const,
    charterVersion: 'v1',
    provenance: 'boss' as const,
    inputHash: canonicalHash({ reason }),
    reason,
  };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('hash-chained audit log', () => {
  it('anchors the first entry to genesis and links each one to its predecessor', async () => {
    const first = await withBusiness(BUSINESS, (bdb) => appendAudit(bdb, entry('one')));
    const second = await withBusiness(BUSINESS, (bdb) => appendAudit(bdb, entry('two')));

    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);

    const verification = await withBusiness(BUSINESS, (bdb) => verifyChain(bdb));
    expect(verification.intact).toBe(true);
  });

  it('keeps chains for different businesses independent', async () => {
    await withBusiness(BUSINESS, (bdb) => appendAudit(bdb, entry('a')));
    const other = await withBusiness('other-business', (bdb) => appendAudit(bdb, entry('b')));

    // A second business starts its own chain at genesis rather than continuing
    // the first — instances must not be able to observe each other's history.
    expect(other.prevHash).toBe(GENESIS_HASH);
    expect((await withBusiness(BUSINESS, (bdb) => verifyChain(bdb))).intact).toBe(true);
    expect((await withBusiness('other-business', (bdb) => verifyChain(bdb))).intact).toBe(true);
  });

  it('detects a removed entry', async () => {
    await withBusiness(BUSINESS, (bdb) => appendAudit(bdb, entry('one')));
    const middle = await withBusiness(BUSINESS, (bdb) => appendAudit(bdb, entry('two')));
    await withBusiness(BUSINESS, (bdb) => appendAudit(bdb, entry('three')));

    // The append-only trigger blocks DELETE, so removal requires disabling it —
    // which is exactly the scenario the chain exists to make detectable.
    await testDb().query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await testDb().query('DELETE FROM audit_log WHERE seq = $1', [middle.seq]);
    await testDb().query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');

    const verification = await withBusiness(BUSINESS, (bdb) => verifyChain(bdb));
    expect(verification.intact).toBe(false);
    if (!verification.intact) {
      expect(verification.reason).toMatch(/removed or reordered/);
    }
  });

  it('detects an altered payload', async () => {
    await withBusiness(BUSINESS, (bdb) => appendAudit(bdb, entry('original')));

    await testDb().query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await testDb().query('UPDATE audit_log SET reason = $1 WHERE business_id = $2', [
      'tampered',
      BUSINESS,
    ]);
    await testDb().query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');

    const verification = await withBusiness(BUSINESS, (bdb) => verifyChain(bdb));
    expect(verification.intact).toBe(false);
    if (!verification.intact) {
      expect(verification.reason).toMatch(/altered after being written/);
    }
  });

  it('serialises concurrent appends into one unbroken chain', async () => {
    // Without the advisory lock two appends could read the same tail and both
    // claim the same predecessor, silently forking the chain.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withBusiness(BUSINESS, (bdb) => appendAudit(bdb, entry(`concurrent-${i}`))),
      ),
    );

    const verification = await withBusiness(BUSINESS, (bdb) => verifyChain(bdb));
    expect(verification.intact).toBe(true);
    if (verification.intact) expect(verification.entries).toBe(12);

    const entries = await withBusiness(BUSINESS, (bdb) => queryAudit(bdb, { limit: 50 }));
    expect(new Set(entries.map((e) => e.hash)).size).toBe(12);
  });
});

describe('appendAudit takes the business from its BusinessDb', () => {
  it('writes the row under db.businessId and nowhere else', async () => {
    await withBusiness('tenant-a', (db) => appendAudit(db, entry('for a')));

    const { rows } = await testDb().query<{ business_id: string }>('SELECT business_id FROM audit_log');
    expect(rows.map((r) => r.business_id)).toEqual(['tenant-a']);
    expect(await withBusiness('tenant-b', (db) => queryAudit(db))).toEqual([]);
    expect(await withBusiness('tenant-a', (db) => queryAudit(db))).toHaveLength(1);
  });

  it("joins the caller's transaction, so a rollback takes the row with it", async () => {
    await expect(
      withBusinessTransaction('tenant-a', async (tx) => {
        await appendAudit(tx, entry('rolled back'));
        throw new Error('caller rolls back');
      }),
    ).rejects.toThrow('caller rolls back');

    const { rows } = await testDb().query('SELECT 1 FROM audit_log');
    expect(rows).toHaveLength(0);
  });
});
