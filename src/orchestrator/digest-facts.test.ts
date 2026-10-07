import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../test/db.js';
import { getPool } from '../db/pool.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { FAILED_GENERIC_TEXT, NOT_PERMITTED_TEXT } from './whatsapp-report.js';
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
    // `jobs.charter_version` is NOT NULL and, since migration
    // `002_charter_per_business.sql`, a COMPOSITE foreign key
    // `(business_id, charter_version)` into `charter_versions` — a bare
    // INSERT INTO jobs without one fails the constraint, and a job for
    // ANOTHER business cannot reference this row (see the cross-business
    // test below, which installs its own).
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

  /**
   * Fix round 1, item 1: `expireOverdue` (`src/governance/approvals.ts`) sets
   * ONLY `state = 'expired'` on sweep — `decided_at` stays NULL forever
   * (migration 001's `approval_decision_is_complete` CHECK carves 'expired'
   * out of the clause that requires it). Windowing the exception query on
   * `decided_at`, as the original draft did, matched zero rows always. This
   * seeds a row in exactly the shape `expireOverdue` actually produces —
   * `state = 'expired'`, `decided_at` left NULL — and requires it to surface.
   */
  it('names an approval that expired inside the window', async () => {
    await getPool().query(
      `INSERT INTO approval_requests
         (approval_id, business_id, action_class, proposed_tool, summary, detail,
          risk, proposed_input, state, input_hash, expires_at, created_at)
       VALUES ('AP-swept', $1, 'email.initiate', 'mail.send', 'הצעה לרונית', '',
               '{}'::jsonb, '{}'::jsonb, 'expired', 'h', $2, $3)`,
      [BUSINESS, new Date('2026-10-07T06:00:00+03:00'), new Date('2026-10-06T09:00:00+03:00')],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.exceptions).toHaveLength(1);
    expect(facts.exceptions[0]?.subject).toContain('הצעה לרונית');
    expect(facts.exceptions[0]?.reason).not.toMatch(/[A-Za-z]/);
  });

  /**
   * Fix round 1, item 2: `reasonInHebrew` must extract the leading code
   * (`leadingCode`) before calling `isGateDenialCode` — exactly as
   * `whatsapp-report.ts`'s own `classifyJob` does — because `execute.ts`
   * always writes the reason as `${code} — ${message}`. Calling
   * `isGateDenialCode` on the whole string silently fails every EXACT member
   * of `GATE_DENY_CODES`, including `draft_only:persist_as_draft` — the
   * single commonest reason while every action class sits at `draft_only`.
   * A plain "Hebrew came back" assertion cannot catch this regression: the
   * generic failure sentence is also Hebrew. This asserts the SPECIFIC
   * sentence.
   */
  it('reports a gate denial as "not permitted yet", never as a generic failure', async () => {
    const db = getPool();
    await db.query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested, closed_at)
       VALUES ('J-denied', $1, 'שליחת תזכורת', 'failed', $3, 'boss', false, $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00'), charterVersion],
    );
    await db.query(
      `INSERT INTO job_steps (job_id, from_phase, to_phase, actor, reason)
       VALUES ('J-denied', 'execute', 'failed', 'orchestrator',
               'draft_only:persist_as_draft — המחלקה עדיין בטיוטה בלבד')`,
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.exceptions).toHaveLength(1);
    expect(facts.exceptions[0]?.reason).toBe(NOT_PERMITTED_TEXT);
    expect(facts.exceptions[0]?.reason).not.toBe(FAILED_GENERIC_TEXT);
  });

  /**
   * Fix round 1, item 5 — `openQuestions` had no seeded coverage. A job
   * parked in `understand` with an instruction the owner has not yet
   * answered is a question he is still waiting on, point-in-time.
   */
  it('counts an unanswered clarifying question as waiting', async () => {
    const db = getPool();
    await db.query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested)
       VALUES ('J-asking', $1, 'מי זה רונית?', 'understand', $2, 'boss', false)`,
      [BUSINESS, charterVersion],
    );
    // `text_origin` is NOT NULL with no default (migration 039).
    await db.query(
      `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text, answer, question, text_origin)
       VALUES ('BI-1', $1, 'J-asking', 'תשלחי לרונית תזכורת', NULL, 'איזו רונית?', 'typed')`,
      [BUSINESS],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.waiting.openQuestions).toBe(1);
  });

  /**
   * Fix round 1, item 5 — `deferred` had no seeded coverage. The review
   * confirmed against `pendingApprovalForJob` that a job can genuinely sit in
   * `await_approval` with no live `pending` row right now (decided-but-not-
   * yet-resumed, or expired-but-not-yet-reaped) — this seeds that state
   * directly, with no approval row at all for the job.
   */
  it('counts a job parked in await_approval with no live approval as deferred', async () => {
    await getPool().query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested)
       VALUES ('J-parked', $1, 'הצעת מחיר לדנה', 'await_approval', $2, 'boss', false)`,
      [BUSINESS, charterVersion],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.waiting.deferred).toBe(1);
  });

  /**
   * Fix round 1, item 5 — the rejected-document exception branch had no
   * seeded coverage.
   */
  it('names a document rejected at intake inside the window', async () => {
    await getPool().query(
      `INSERT INTO documents
         (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status, reason, created_at)
       VALUES ('DOC-1', $1, 'manual', 'חוזה.pdf', 'application/pdf', $3, 12, 'p/doc', 'rejected',
               'הקובץ פגום ולא ניתן לקריאה.', $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00'), 'a'.repeat(64)],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.exceptions).toHaveLength(1);
    expect(facts.exceptions[0]?.subject).toBe('חוזה.pdf');
    expect(facts.exceptions[0]?.reason).toBe('הקובץ פגום ולא ניתן לקריאה.');
  });
});
