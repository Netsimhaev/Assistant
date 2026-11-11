import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, testDb } from '../test/db.js';
import { getPool, withBusiness } from '../db/pool.js';
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
const CEILINGS = { monthlyMinor: 50_000, currency: 'ILS', timeZone: 'Asia/Jerusalem' };

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
    const bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
    charterVersion = bundle.charterVersion;
  });

  it('reports an empty window as empty rather than as missing', async () => {
    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
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
      `INSERT INTO job_steps (job_id, business_id, from_phase, to_phase, actor, reason)
       VALUES ('J-bad', (SELECT business_id FROM jobs WHERE job_id = 'J-bad'), 'execute', 'failed', 'orchestrator', 'adapter_timeout')`,
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.done.jobsCompleted).toBe(1);
    expect(facts.exceptions).toHaveLength(1);
    expect(facts.exceptions[0]?.subject).toContain('עדכון המערכת');
    // Hebrew, never the raw engine code.
    expect(facts.exceptions[0]?.reason).not.toContain('adapter_timeout');
    expect(facts.exceptions[0]?.reason).not.toMatch(/[A-Za-z]/);
  });

  /**
   * Fix round 2, item 5: `resumeAfterDecision`
   * (`orchestrator/resume.ts:61-69`) deliberately CLOSES, rather than fails,
   * a job whose approval was denied — "a person said no. That is an outcome,
   * not a fault." A refusal is neither a counted success nor a named
   * exception, and reporting it as "N משימות הושלמו" is the one thing spec
   * §1.1 must not do. The discriminator is the `job_steps` row that same
   * function writes: `actor = 'human'`, `reason` beginning `denied:`
   * (the literal template is `` `${approval.state}:${approvalId} by
   * ${decidedBy}` `` — `'denied:AP-1 by owner'` here). A second, genuinely
   * completed job is seeded alongside it so this asserts SELECTIVE exclusion
   * (1, not 0 and not 2), not an accidentally-empty count.
   */
  it('does not count a job the owner refused as a completed job', async () => {
    const db = getPool();
    await db.query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested, closed_at)
       VALUES ('J-denied-close', $1, 'הצעת מחיר לרונית', 'closed', $3, 'boss', false, $2),
              ('J-ok-2', $1, 'תזכורת לדנה', 'closed', $3, 'boss', false, $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00'), charterVersion],
    );
    await db.query(
      `INSERT INTO job_steps (job_id, business_id, from_phase, to_phase, actor, reason)
       VALUES ('J-denied-close', (SELECT business_id FROM jobs WHERE job_id = 'J-denied-close'), 'await_approval', 'closed', 'human', 'denied:AP-1 by owner')`,
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.done.jobsCompleted).toBe(1);
  });

  /**
   * Spec §3.1 is point-in-time, not window-scoped: an approval still pending
   * belongs in "waiting" whenever the digest is sent, regardless of whether it
   * was raised inside this window.
   */
  it('counts a pending approval raised BEFORE the window as still waiting', async () => {
    // `action_class`, `risk` and `proposed_input` are all NOT NULL with no
    // default (001_spine.sql) — the brief's draft insert omitted them.
    await testDb().query(
      `INSERT INTO approval_requests
         (approval_id, business_id, action_class, proposed_tool, summary, detail,
          risk, proposed_input, state, input_hash, expires_at, created_at)
       VALUES ('AP-1', $1, 'email.initiate', 'mail.send', 'הצעה לדנה', '',
               '{}'::jsonb, '{}'::jsonb, 'pending', 'h', $2, $3)`,
      // `expires_at` is relative to the real clock, not to WINDOW: "waiting"
      // is filtered on `expires_at > now()`, so a fixed date here turned this
      // test red the day after it passed.
      [BUSINESS, new Date(Date.now() + 24 * 60 * 60 * 1000), new Date('2026-10-01T08:00:00+03:00')],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.waiting.approvals).toBe(1);
  });

  /**
   * Spec §3.4: a promotion means she may now act without asking, and nothing
   * else in the system tells the owner after the fact. If this block misses it,
   * he learns about it from the result.
   */
  it('names an autonomy promotion that happened inside the window', async () => {
    await testDb().query(
      // event_id is TEXT PRIMARY KEY with no default (migration 026).
      `INSERT INTO autonomy_events
         (event_id, business_id, action_class, direction, from_level, to_level, reason, at)
       VALUES ('AE-t1', $1, 'email.reply', 'promote', 'approve_required', 'auto_notify', '10 אישורים נקיים', $2)`,
      [BUSINESS, new Date('2026-10-07T06:00:00+03:00')],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.permissionChanges).toHaveLength(1);
    // The owner reads Hebrew: the class and both levels arrive translated
    // (`domain/labels.ts`), never as the identifiers stored in the row.
    expect(facts.permissionChanges[0]?.subject).toBe('מענה במייל');
    expect(facts.permissionChanges[0]?.reason).toContain('פועלת אחרי אישור');
    expect(facts.permissionChanges[0]?.reason).toContain('פועלת בלי לשאול');
    expect(facts.permissionChanges[0]?.reason).not.toMatch(/[A-Za-z]/);
  });

  /**
   * Real columns: action_class and currency are both NOT NULL, there is no
   * `kind`, and `id` is BIGSERIAL (migration 001:202-216).
   */
  it('reports the window cost and the rolling 30 days against the ceiling', async () => {
    // Relative to now, not the fixed `WINDOW`: the rolling figure is measured
    // against `now()`, and a seed on the fixed 2026-10-07 fell out of the
    // 30 days on 2026-11-06 — a test that rots by the calendar.
    const window = {
      ...WINDOW,
      start: new Date(Date.now() - 25 * 60 * 60 * 1000),
      end: new Date(Date.now() - 60 * 60 * 1000),
    };
    await testDb().query(
      `INSERT INTO spend_ledger
         (business_id, job_id, action_class, amount_minor, currency, idempotency_key, at)
       VALUES ($1, 'J-ok', 'email.reply', 1250, 'ILS', 'k1', $2)`,
      [BUSINESS, new Date(Date.now() - 2 * 60 * 60 * 1000)],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, window, CEILINGS));
    expect(facts.cost.windowMinor).toBe(1250);
    expect(facts.cost.rolling30Minor).toBe(1250);
    expect(facts.cost.ceilingMinor).toBe(CEILINGS.monthlyMinor);
  });

  /**
   * The gate sums `at >= now() - interval '30 days'`. A calendar-month figure
   * shown against that ceiling is not comparable to it — this is the assertion
   * that keeps the two definitions from drifting apart.
   *
   * **Fix round 2, item 9: seeded at `now - 25 days`, not `now - 20 days`,
   * with a decoy at `now - 40 days` that must be EXCLUDED.** The original
   * fixture seeded at 20 days back to prove "this is a rolling 30 days, not
   * a calendar month" — but on days 21-31 of any calendar month, `now - 20
   * days` is STILL inside the current calendar month, so a
   * `date_trunc('month', now())` implementation (exactly the bug this test
   * exists to catch) would satisfy it too: the test's own protection lapsed
   * for roughly a third of every month, depending only on what day it
   * happened to run. 25 days back is never inside the current calendar
   * month on ANY day of a 28-to-31-day month, so this holds year-round. The
   * decoy at 40 days back pins the OTHER edge — a rolling window that
   * silently widened past 30 days would still pass without it. The window is
   * relative to now, not the fixed `WINDOW`, because the fixed 2026-10-06
   * window collided with the 25-day seed on 2026-10-31.
   */
  it('counts spend from before the first of the month inside the rolling window, year-round', async () => {
    const twentyFiveDaysAgo = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000);
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await testDb().query(
      `INSERT INTO spend_ledger
         (business_id, job_id, action_class, amount_minor, currency, idempotency_key, at)
       VALUES ($1, 'J-old', 'email.reply', 700, 'ILS', 'k2', $2),
              ($1, 'J-too-old', 'email.reply', 999, 'ILS', 'k3', $3)`,
      [BUSINESS, twentyFiveDaysAgo, fortyDaysAgo],
    );

    // A one-day window ending an hour ago can never contain a row seeded 25
    // days back, so `windowMinor` is 0 on every date, unlike the fixed WINDOW.
    const window = {
      ...WINDOW,
      start: new Date(Date.now() - 25 * 60 * 60 * 1000),
      end: new Date(Date.now() - 60 * 60 * 1000),
    };
    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, window, CEILINGS));
    expect(facts.cost.rolling30Minor).toBe(700);
    expect(facts.cost.windowMinor).toBe(0);
  });

  it("keeps one business's facts out of another's window", async () => {
    // `jobs`'s FK on `charter_version` is actually composite
    // `(business_id, charter_version)` (migration 002) — a job for
    // `other-business` needs its OWN charter row, not `BUSINESS`'s.
    const otherBundle = await withBusiness('other-business', (bdb) => installCharter(bdb, buildCharter()));
    await testDb().query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested, closed_at)
       VALUES ('J-other', 'other-business', 'לא שלנו', 'closed', $2, 'boss', false, $1)`,
      [new Date('2026-10-07T07:00:00+03:00'), otherBundle.charterVersion],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.done.jobsCompleted).toBe(0);
  });

  /**
   * Step 6, mutation 2: no test above covers the lower bound on
   * `jobsCompleted` — a job closed well before the window must not be
   * counted just because it is closed.
   */
  it('does not count a job closed a week before the window', async () => {
    await testDb().query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested, closed_at)
       VALUES ('J-old-close', $1, 'משימה ישנה', 'closed', $3, 'boss', false, $2)`,
      [BUSINESS, new Date('2026-09-29T07:00:00+03:00'), charterVersion],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.done.jobsCompleted).toBe(0);
  });

  /**
   * Step 6, mutation 3: an approval that is `pending` but has already expired
   * must not count as something the owner is still waiting on.
   */
  it('does not count an already-expired pending approval as waiting', async () => {
    await testDb().query(
      `INSERT INTO approval_requests
         (approval_id, business_id, action_class, proposed_tool, summary, detail,
          risk, proposed_input, state, input_hash, expires_at, created_at)
       VALUES ('AP-expired', $1, 'email.initiate', 'mail.send', 'הצעה לדנה', '',
               '{}'::jsonb, '{}'::jsonb, 'pending', 'h', $2, $3)`,
      [BUSINESS, new Date('2026-10-01T08:00:00+03:00'), new Date('2026-09-25T08:00:00+03:00')],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
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
    await testDb().query(
      `INSERT INTO approval_requests
         (approval_id, business_id, action_class, proposed_tool, summary, detail,
          risk, proposed_input, state, input_hash, expires_at, created_at)
       VALUES ('AP-swept', $1, 'email.initiate', 'mail.send', 'הצעה לרונית', '',
               '{}'::jsonb, '{}'::jsonb, 'expired', 'h', $2, $3)`,
      [BUSINESS, new Date('2026-10-07T06:00:00+03:00'), new Date('2026-10-06T09:00:00+03:00')],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
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
      `INSERT INTO job_steps (job_id, business_id, from_phase, to_phase, actor, reason)
       VALUES ('J-denied', (SELECT business_id FROM jobs WHERE job_id = 'J-denied'), 'execute', 'failed', 'orchestrator',
               'draft_only:persist_as_draft — המחלקה עדיין בטיוטה בלבד')`,
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
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

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
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
    await testDb().query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested)
       VALUES ('J-parked', $1, 'הצעת מחיר לדנה', 'await_approval', $2, 'boss', false)`,
      [BUSINESS, charterVersion],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.waiting.deferred).toBe(1);
  });

  /**
   * Fix round 1, item 5 — the rejected-document exception branch had no
   * seeded coverage.
   */
  it('names a document rejected at intake inside the window', async () => {
    await testDb().query(
      `INSERT INTO documents
         (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status, reason, created_at)
       VALUES ('DOC-1', $1, 'manual', 'חוזה.pdf', 'application/pdf', $3, 12, 'p/doc', 'rejected',
               'הקובץ פגום ולא ניתן לקריאה.', $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00'), 'a'.repeat(64)],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.exceptions).toHaveLength(1);
    expect(facts.exceptions[0]?.subject).toBe('חוזה.pdf');
    expect(facts.exceptions[0]?.reason).toBe('הקובץ פגום ולא ניתן לקריאה.');
  });

  it('names a PDF kept stored because it could not be decoded, but not a pre-reading stored one', async () => {
    await testDb().query(
      `INSERT INTO documents
         (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status, reason, created_at)
       VALUES ('DOC-U', $1, 'mail', 'נעול.pdf', 'application/pdf', $3, 12, 'p/u', 'stored', 'הפענוח נכשל: password', $2),
              ('DOC-L', $1, 'mail', 'ישן.pdf', 'application/pdf', $4, 12, 'p/l', 'stored', NULL, $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00'), 'b'.repeat(64), 'c'.repeat(64)],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.exceptions).toEqual([{ subject: 'נעול.pdf', reason: 'הפענוח נכשל: password' }]);
  });

  /**
   * Fix round 1, item 4: a message is attributed to the window it was
   * actually SENT in, not the window its job later happens to close in. The
   * natural case is a job that closes well after the window ends — the
   * message already went out inside the window, and the job itself is still
   * open (or closes later) when the digest for that window is sent. Under
   * the old windowing (a join to `jobs`, bounded by `j.closed_at`) this step
   * would be invisible here and would only surface in whichever later
   * window the job happens to close in — a step that belongs to a
   * still-open job must still be counted as soon as it has actually sent.
   */
  it('counts a sent message by when it completed, not by when its job later closes', async () => {
    const db = getPool();
    await db.query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested, closed_at)
       VALUES ('J-later-close', $1, 'תזכורת לדנה', 'closed', $3, 'boss', false, $2)`,
      [BUSINESS, new Date('2026-10-08T07:00:00+03:00'), charterVersion],
    );
    await db.query(
      `INSERT INTO job_step_results
         (business_id, job_id, plan_hash, step_id, external_id, status, performed, completed_at)
       VALUES ($1, 'J-later-close', 'ph-1', 'step-1', 'msg-123', 'completed', true, $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00')],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.done.messagesSent).toBe(1);
  });

  /**
   * Fix round 2, item 10: `documentsRead` had no seeded coverage at all — the
   * empty-window test proves the SQL parses, never that it matches a real
   * row. Exactly the shape of the worst class of defect on this branch: a
   * query that executes cleanly and matches nothing, forever. Real columns
   * per migration `013_document_readings.sql`: `document_id` is a NOT NULL
   * FK into `documents`, and `content` is required exactly when `status =
   * 'read'` (`document_readings_content_present`).
   */
  it('counts a document read inside the window', async () => {
    const db = getPool();
    await db.query(
      `INSERT INTO documents
         (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
       VALUES ('DOC-read-1', $1, 'manual', 'חוזה.pdf', 'application/pdf', $2, 12, 'p/doc', 'extracted')`,
      [BUSINESS, 'b'.repeat(64)],
    );
    await db.query(
      `INSERT INTO document_readings
         (reading_id, business_id, document_id, status, content, provenance, model, prompt_version, brief_hash, created_at)
       VALUES ('READ-1', $1, 'DOC-read-1', 'read', $3::jsonb, 'boss', 'test-model', 'v1', 'hash-1', $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00'), JSON.stringify({ summary: 'תקציר' })],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.done.documentsRead).toBe(1);
  });

  /**
   * Fix round 2, item 10: `memoriesWritten` had the same gap. Real columns
   * per migration `024_memories.sql`: `kind` is a closed CHECK ('entity',
   * 'preference', 'chunk'), `attribute` must be NULL for 'chunk', and
   * `provenance` is NOT NULL with no default.
   */
  it('counts a memory written inside the window', async () => {
    await testDb().query(
      `INSERT INTO memories (memory_id, business_id, kind, subject_key, body, provenance, created_at)
       VALUES ('MEM-1', $1, 'chunk', 'כלשהו', $3::jsonb, 'boss', $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00'), JSON.stringify({ text: 'הערה' })],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.done.memoriesWritten).toBe(1);
  });

  /**
   * Fix round 2, item 4 (undercount): the old code capped each exception
   * source's own query at `MAX_NAMED_EXCEPTIONS + 1` (21) and computed
   * "hidden" from the COMBINED array's length minus 20 — so 25 failed jobs
   * (21 fetched, since only one source is populated here) reported hidden
   * as `21 - 20 = 1`, not the true `25 - 20 = 5`. `count(*) OVER ()` must
   * report the EXACT total regardless of the `LIMIT`.
   */
  it('states the exact hidden count for a single source with more than twenty matches', async () => {
    const db = getPool();
    const values: string[] = [];
    const params: unknown[] = [BUSINESS, new Date('2026-10-07T07:00:00+03:00'), charterVersion];
    for (let i = 0; i < 25; i += 1) {
      values.push(`('J-many-${i}', $1, 'משימה ${i}', 'failed', $3, 'boss', false, $2)`);
    }
    await db.query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested, closed_at)
       VALUES ${values.join(', ')}`,
      params,
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.exceptions).toHaveLength(20);
    expect(facts.exceptionsHiddenCount).toBe(5);
  });

  /**
   * Fix round 2, item 4 (crowding): the old code concatenated
   * failed-jobs → rejected-docs → expired-approvals and sliced at 20, so
   * twenty-plus failed jobs pushed the single rejected document out of the
   * named list entirely — in the one block spec §3.3 allows to be long.
   * `interleaveFairly` must name the document anyway: every non-empty
   * source gets at least one slot before any source gets a second.
   */
  it('still names a lone rejected document even with twenty-plus failed jobs', async () => {
    const db = getPool();
    const values: string[] = [];
    const params: unknown[] = [BUSINESS, new Date('2026-10-07T07:00:00+03:00'), charterVersion];
    for (let i = 0; i < 22; i += 1) {
      values.push(`('J-crowd-${i}', $1, 'משימה ${i}', 'failed', $3, 'boss', false, $2)`);
    }
    await db.query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested, closed_at)
       VALUES ${values.join(', ')}`,
      params,
    );
    await db.query(
      `INSERT INTO documents
         (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status, reason, created_at)
       VALUES ('DOC-crowd', $1, 'manual', 'הצעת-מחיר-יחידה.pdf', 'application/pdf', $3, 12, 'p/doc', 'rejected',
               'הקובץ פגום ולא ניתן לקריאה.', $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00'), 'c'.repeat(64)],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.exceptions.some((e) => e.subject === 'הצעת-מחיר-יחידה.pdf')).toBe(true);
    expect(facts.exceptions).toHaveLength(20);
    expect(facts.exceptionsHiddenCount).toBe(3); // 23 total − 20 named
  });

  /**
   * The ledger section (spec §7.9). `open` and `stuck` are point-in-time,
   * like `waiting`; `closedByEvidence` is window-scoped by its EVENT time.
   * `overdue` is decided in the CHARTER zone: a date-only due stores the
   * daily hour on that local date, and it is overdue only once the local
   * date has passed. `now` is 00:30 on 07.10 in Jerusalem — still 06.10 in
   * UTC — so a UTC-dated rule would miss `LI-dateonly-past`.
   */
  it('counts the ledger: open, overdue in the charter zone, stuck, and closures by evidence in the window', async () => {
    const db = getPool();
    const item = (id: string, status: string, due: Date | null, dateOnly: boolean, extra: Partial<{ importance: string; business: string; description: string; updatedAt: Date }> = {}) =>
      db.query(
        `INSERT INTO ledger_items
           (item_id, business_id, family, description, due_at, due_is_date_only, status, importance,
            origin_job_id, updated_at)
         VALUES ($1, $2, 'money_in', $3, $4, $5, $6, $7, 'J-origin', coalesce($8::timestamptz, now()))`,
        [id, extra.business ?? BUSINESS, extra.description ?? `שורה ${id}`, due, dateOnly, status,
         extra.importance ?? 'normal', extra.updatedAt ?? null],
      );
    // Open: 4 (2 overdue, 2 not).
    await item('LI-dateonly-past', 'open', new Date('2026-10-06T08:00:00+03:00'), true);
    await item('LI-dateonly-today', 'open', new Date('2026-10-07T08:00:00+03:00'), true);
    await item('LI-timed-past', 'open', new Date('2026-10-06T23:00:00+03:00'), false);
    await item('LI-timed-future', 'open', new Date('2026-10-07T01:00:00+03:00'), false);
    await item('LI-nodue', 'open', null, false);
    // Stuck: 6, so the named list caps at 5 with the critical one first.
    for (let i = 1; i <= 5; i += 1) {
      await item(`LI-stuck-${i}`, 'stuck', null, false, {
        description: `תקוע ${i}\nשורה שנייה`,
        updatedAt: new Date(`2026-10-0${i}T10:00:00+03:00`),
      });
    }
    await item('LI-stuck-critical', 'stuck', null, false, {
      importance: 'critical',
      description: 'תקוע קריטי',
      updatedAt: new Date('2026-09-01T10:00:00+03:00'),
    });
    // Closed by evidence: one inside the window, one before it.
    await item('LI-ev-in', 'closed_by_evidence', null, false);
    await item('LI-ev-out', 'closed_by_evidence', null, false);
    await db.query(
      `INSERT INTO ledger_events (event_id, business_id, item_id, kind, by_whom, at)
       VALUES ('LE-in', $1, 'LI-ev-in', 'closed_by_evidence', 'system', $2),
              ('LE-out', $1, 'LI-ev-out', 'closed_by_evidence', 'system', $3)`,
      [BUSINESS, new Date('2026-10-06T12:00:00+03:00'), new Date('2026-10-05T12:00:00+03:00')],
    );
    // Another business's rows count for nothing here.
    await item('LI-other-open', 'open', new Date('2026-10-01T08:00:00+03:00'), true, { business: 'other-business' });
    await item('LI-other-stuck', 'stuck', null, false, { business: 'other-business' });

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS, {
      now: new Date('2026-10-07T00:30:00+03:00'),
    }));

    expect(facts.ledger.open).toBe(5);
    expect(facts.ledger.overdue).toBe(2);
    expect(facts.ledger.stuck).toBe(6);
    expect(facts.ledger.closedByEvidence).toBe(1);
    expect(facts.ledger.topStuck).toHaveLength(5);
    expect(facts.ledger.topStuck[0]).toBe('תקוע קריטי');
  });

  it('reports a ledger with nothing in it as all zeros', async () => {
    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.ledger).toEqual({ open: 0, overdue: 0, stuck: 0, closedByEvidence: 0, topStuck: [] });
  });
  it('counts produced documents in the window, the ones sent, and the cards still waiting', async () => {
    const db = getPool();
    const inWindow = new Date('2026-10-06T12:00:00+03:00');
    const before = new Date('2026-10-01T12:00:00+03:00');
    const sha = 'a'.repeat(64);
    await db.query(
      `INSERT INTO document_productions (production_id, business_id, origin_job_id, instruction_text, text_origin,
                                         format, language, kind, destination, stage)
       VALUES ('DP-1', $1, 'J-o', 'x', 'typed', 'docx', 'he', 'letter', '{"mode":"save","folder":null}', 'ready')`,
      [BUSINESS],
    );
    const versions: Array<[string, number, Date | null]> = [
      ['DV-1', 1, new Date('2026-10-06T13:00:00+03:00')],
      ['DV-2', 2, null],
      ['DV-3', 3, null],
      ['DV-4', 4, null],
    ];
    for (const [id, no, superseded] of versions) {
      await db.query(
        `INSERT INTO document_versions (version_id, production_id, business_id, version_no, spec, stored_path, sha256, size_bytes, superseded_at)
         VALUES ($1, 'DP-1', (SELECT business_id FROM document_productions WHERE production_id = 'DP-1'), $2, '{}', 'p', $3, 1, $4)`,
        [id, no, sha, superseded],
      );
    }
    // DC-1 superseded (fixed) — produced, not waiting. DC-2 approved and its
    // delivery closed in the window — produced and sent. DC-3 open — produced
    // and waiting. DC-4 open but created before the window — waiting only.
    await db.query(
      `INSERT INTO document_cards (card_id, business_id, version_id, state, created_at, delivery_job_id)
       VALUES ('DC-1', $1, 'DV-1', 'superseded', $2, NULL),
              ('DC-2', $1, 'DV-2', 'approved', $2, 'J-del'),
              ('DC-3', $1, 'DV-3', 'open', $2, NULL),
              ('DC-4', $1, 'DV-4', 'open', $3, NULL)`,
      [BUSINESS, inWindow, before],
    );
    await db.query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested, closed_at)
       VALUES ('J-del', $1, 'מסירת מסמך', 'closed', $3, 'boss', false, $2),
              ('J-save', $1, 'מסירת מסמך', 'closed', $3, 'boss', false, $2)`,
      [BUSINESS, new Date('2026-10-06T14:00:00+03:00'), charterVersion],
    );
    await db.query(
      `INSERT INTO job_plans (business_id, job_id, plan_hash, plan)
       VALUES ($1, 'J-del', 'h1', '{"steps":[{"toolName":"mail.send"}]}'),
              ($1, 'J-save', 'h2', '{"steps":[{"toolName":"doc.save"}]}')`,
      [BUSINESS],
    );
    await db.query(
      `INSERT INTO document_deliveries (job_id, business_id, card_id, version_id)
       VALUES ('J-del', $1, 'DC-2', 'DV-2'), ('J-save', $1, 'DC-1', 'DV-1')`,
      [BUSINESS],
    );

    const facts = await withBusiness(BUSINESS, (db) => collectDigestFacts(db, WINDOW, CEILINGS));
    expect(facts.documents).toEqual({ produced: 3, sent: 1, waiting: 2 });
  });
});
