import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../test/db.js';
import { getPool } from '../db/pool.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { collectDigestFacts } from './digest-facts.js';

const BUSINESS = 'test-business';
const WINDOW = {
  kind: 'daily' as const,
  start: new Date('2026-10-06T08:00:00+03:00'),
  end: new Date('2026-10-07T08:00:00+03:00'),
  windowsCovered: 1,
};
/** Passed in, never loaded here — see the note on `collectDigestFacts`. */
const CEILINGS = { monthlyMinor: 50_000, currency: 'ILS' };

describe('collectDigestFacts', () => {
  let charterVersion: string;

  beforeEach(async () => {
    await resetDatabase();
    // `jobs.charter_version` is NOT NULL and a foreign key into
    // `charter_versions` — a bare INSERT INTO jobs without one fails the
    // constraint. One signed charter per test is enough; the FK is on
    // `charter_version` alone, not the pair, so a job for another business
    // can reference the same row.
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    charterVersion = bundle.charterVersion;
  });

  it('reports an empty window as empty rather than as missing', async () => {
    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.done.jobsCompleted).toBe(0);
    expect(facts.exceptions).toEqual([]);
    expect(facts.waiting.approvals).toBe(0);
  });

  /**
   * Spec §3.2 versus §3.3: a job that closed is a NUMBER, a job that failed is
   * a NAME. The two must not be counted together, or "7 tasks completed" would
   * include the one that broke.
   */
  it('counts a closed job and names a failed one with its Hebrew reason', async () => {
    const db = getPool();
    await db.query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested, closed_at)
       VALUES ('J-ok', $1, 'שליחת הצעת מחיר', 'closed', $3, 'boss', false, $2),
              ('J-bad', $1, 'עדכון המערכת', 'failed', $3, 'boss', false, $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00'), charterVersion],
    );
    await db.query(
      `INSERT INTO job_steps (job_id, from_phase, to_phase, actor, reason)
       VALUES ('J-bad', 'execute', 'failed', 'orchestrator', 'adapter_timeout')`,
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.done.jobsCompleted).toBe(1);
    expect(facts.exceptions).toHaveLength(1);
    expect(facts.exceptions[0]?.subject).toContain('עדכון המערכת');
    // Hebrew, never the raw engine code.
    expect(facts.exceptions[0]?.reason).not.toContain('adapter_timeout');
    expect(facts.exceptions[0]?.reason).not.toMatch(/[A-Za-z]/);
  });

  /**
   * Spec §3.1 is point-in-time, not window-scoped: an approval still pending
   * belongs in "waiting" whenever the digest is sent, regardless of whether it
   * was raised inside this window.
   */
  it('counts a pending approval raised BEFORE the window as still waiting', async () => {
    // `action_class`, `risk` and `proposed_input` are all NOT NULL with no
    // default (001_spine.sql) — the brief's draft insert omitted them.
    await getPool().query(
      `INSERT INTO approval_requests
         (approval_id, business_id, action_class, proposed_tool, summary, detail,
          risk, proposed_input, state, input_hash, expires_at, created_at)
       VALUES ('AP-1', $1, 'email.initiate', 'mail.send', 'הצעה לדנה', '',
               '{}'::jsonb, '{}'::jsonb, 'pending', 'h', $2, $3)`,
      [BUSINESS, new Date('2026-10-09T08:00:00+03:00'), new Date('2026-10-01T08:00:00+03:00')],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.waiting.approvals).toBe(1);
  });

  /**
   * Spec §3.4: a promotion means she may now act without asking, and nothing
   * else in the system tells the owner after the fact. If this block misses it,
   * he learns about it from the result.
   */
  it('names an autonomy promotion that happened inside the window', async () => {
    await getPool().query(
      // event_id is TEXT PRIMARY KEY with no default (migration 026).
      `INSERT INTO autonomy_events
         (event_id, business_id, action_class, direction, from_level, to_level, reason, at)
       VALUES ('AE-t1', $1, 'email.reply', 'promote', 'approve_required', 'auto_notify', '10 אישורים נקיים', $2)`,
      [BUSINESS, new Date('2026-10-07T06:00:00+03:00')],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.permissionChanges).toHaveLength(1);
    expect(facts.permissionChanges[0]?.subject).toContain('email.reply');
  });

  /**
   * Real columns: action_class and currency are both NOT NULL, there is no
   * `kind`, and `id` is BIGSERIAL (migration 001:202-216).
   */
  it('reports the window cost and the rolling 30 days against the ceiling', async () => {
    await getPool().query(
      `INSERT INTO spend_ledger
         (business_id, job_id, action_class, amount_minor, currency, idempotency_key, at)
       VALUES ($1, 'J-ok', 'email.reply', 1250, 'ILS', 'k1', $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00')],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.cost.windowMinor).toBe(1250);
    expect(facts.cost.rolling30Minor).toBeGreaterThanOrEqual(1250);
    expect(facts.cost.ceilingMinor).toBe(CEILINGS.monthlyMinor);
  });

  /**
   * The gate sums `at >= now() - interval '30 days'`. A calendar-month figure
   * shown against that ceiling is not comparable to it — this is the assertion
   * that keeps the two definitions from drifting apart.
   */
  it('counts spend from before the first of the month inside the rolling window', async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await getPool().query(
      `INSERT INTO spend_ledger
         (business_id, job_id, action_class, amount_minor, currency, idempotency_key, at)
       VALUES ($1, 'J-old', 'email.reply', 700, 'ILS', 'k2', $2)`,
      [BUSINESS, twentyDaysAgo],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.cost.rolling30Minor).toBe(700);
    expect(facts.cost.windowMinor).toBe(0);
  });

  it("keeps one business's facts out of another's window", async () => {
    // `jobs`'s FK on `charter_version` is actually composite
    // `(business_id, charter_version)` (migration 002) — a job for
    // `other-business` needs its OWN charter row, not `BUSINESS`'s.
    const otherBundle = await installCharter(buildCharter(), { businessId: 'other-business' });
    await getPool().query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested, closed_at)
       VALUES ('J-other', 'other-business', 'לא שלנו', 'closed', $2, 'boss', false, $1)`,
      [new Date('2026-10-07T07:00:00+03:00'), otherBundle.charterVersion],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.done.jobsCompleted).toBe(0);
  });

  /**
   * Step 6, mutation 2: no test above covers the lower bound on
   * `jobsCompleted` — a job closed well before the window must not be
   * counted just because it is closed.
   */
  it('does not count a job closed a week before the window', async () => {
    await getPool().query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested, closed_at)
       VALUES ('J-old-close', $1, 'משימה ישנה', 'closed', $3, 'boss', false, $2)`,
      [BUSINESS, new Date('2026-09-29T07:00:00+03:00'), charterVersion],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.done.jobsCompleted).toBe(0);
  });

  /**
   * Step 6, mutation 3: an approval that is `pending` but has already expired
   * must not count as something the owner is still waiting on.
   */
  it('does not count an already-expired pending approval as waiting', async () => {
    await getPool().query(
      `INSERT INTO approval_requests
         (approval_id, business_id, action_class, proposed_tool, summary, detail,
          risk, proposed_input, state, input_hash, expires_at, created_at)
       VALUES ('AP-expired', $1, 'email.initiate', 'mail.send', 'הצעה לדנה', '',
               '{}'::jsonb, '{}'::jsonb, 'pending', 'h', $2, $3)`,
      [BUSINESS, new Date('2026-10-01T08:00:00+03:00'), new Date('2026-09-25T08:00:00+03:00')],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.waiting.approvals).toBe(0);
  });
});
