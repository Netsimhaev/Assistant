import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
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
    const first = await appendAudit(entry('one'), { businessId: BUSINESS });
    const second = await appendAudit(entry('two'), { businessId: BUSINESS });

    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);

    const verification = await verifyChain(BUSINESS, getPool());
    expect(verification.intact).toBe(true);
  });

  it('keeps chains for different businesses independent', async () => {
    await appendAudit(entry('a'), { businessId: BUSINESS });
    const other = await appendAudit(entry('b'), { businessId: 'other-business' });

    // A second business starts its own chain at genesis rather than continuing
    // the first — instances must not be able to observe each other's history.
    expect(other.prevHash).toBe(GENESIS_HASH);
    expect((await verifyChain(BUSINESS, getPool())).intact).toBe(true);
    expect((await verifyChain('other-business', getPool())).intact).toBe(true);
  });

  it('detects a removed entry', async () => {
    await appendAudit(entry('one'), { businessId: BUSINESS });
    const middle = await appendAudit(entry('two'), { businessId: BUSINESS });
    await appendAudit(entry('three'), { businessId: BUSINESS });

    // The append-only trigger blocks DELETE, so removal requires disabling it —
    // which is exactly the scenario the chain exists to make detectable.
    await getPool().query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await getPool().query('DELETE FROM audit_log WHERE seq = $1', [middle.seq]);
    await getPool().query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');

    const verification = await verifyChain(BUSINESS, getPool());
    expect(verification.intact).toBe(false);
    if (!verification.intact) {
      expect(verification.reason).toMatch(/removed or reordered/);
    }
  });

  it('detects an altered payload', async () => {
    await appendAudit(entry('original'), { businessId: BUSINESS });

    await getPool().query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await getPool().query('UPDATE audit_log SET reason = $1 WHERE business_id = $2', [
      'tampered',
      BUSINESS,
    ]);
    await getPool().query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');

    const verification = await verifyChain(BUSINESS, getPool());
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
        appendAudit(entry(`concurrent-${i}`), { businessId: BUSINESS }),
      ),
    );

    const verification = await verifyChain(BUSINESS, getPool());
    expect(verification.intact).toBe(true);
    if (verification.intact) expect(verification.entries).toBe(12);

    const entries = await queryAudit({ businessId: BUSINESS, limit: 50 }, getPool());
    expect(new Set(entries.map((e) => e.hash)).size).toBe(12);
  });
});
