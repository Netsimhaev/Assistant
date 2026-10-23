import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';
import type { DigestWindow } from './digest-window.js';
import { failedText, isGateDenialCode, leadingCode, NOT_PERMITTED_TEXT } from './whatsapp-report.js';

/** One thing that did not go smoothly, already phrased in Hebrew. */
export interface DigestException {
  /** What it was — a job title, a document name, an approval summary. */
  subject: string;
  /** Why, in Hebrew. Never an engine code and never English. */
  reason: string;
}

export interface DigestFacts {
  window: DigestWindow;
  /**
   * The charter's own IANA zone — never the process's. `window.start`/`end`
   * are instants computed in this zone by `digest-window.ts`; the renderer
   * must format them back through the SAME zone, or the header's stated
   * period and the stored row's actual boundaries read as two different
   * days on any process whose default zone (container, VPS) is not the
   * charter's. No default here, on purpose: a caller that forgets to supply
   * one gets a compile error, never a silent fallback to the process zone —
   * the exact failure mode this field exists to close off.
   */
  timeZone: string;
  /** Point-in-time, NOT window-scoped — spec §3.1. */
  waiting: {
    approvals: number;
    openQuestions: number;
    deferred: number;
  };
  /** Window-scoped counts — spec §3.2. */
  done: {
    jobsCompleted: number;
    messagesSent: number;
    documentsRead: number;
    memoriesWritten: number;
  };
  /**
   * Window-scoped and NAMED — spec §3.3. Already capped to
   * `MAX_NAMED_EXCEPTIONS` and fairly interleaved across sources (every
   * non-empty source is named at least once before any source is named a
   * second time) — the renderer lists these verbatim, with no slicing of
   * its own.
   */
  exceptions: readonly DigestException[];
  /**
   * The EXACT number of matching exceptions beyond those named in
   * `exceptions` — measured per source via `count(*) OVER ()` in the
   * database, never estimated from how many rows were fetched. "ועוד N"
   * states a measured number, because this feature's entire premise is
   * that every number the owner reads was measured.
   */
  exceptionsHiddenCount: number;
  /** Window-scoped — spec §3.4. */
  permissionChanges: readonly DigestException[];
  /**
   * Spec §3.5 — both measures. `rolling30Minor` and `ceilingMinor` use the
   * **rolling 30-day window the money gate actually enforces**
   * (`spentInWindows`, policy/budget.ts:26-33), NEVER a calendar month: a
   * spend figure shown against a ceiling measured over a different window is
   * two numbers on one line that cannot be compared, and nothing on the screen
   * would say so.
   */
  cost: {
    windowMinor: number;
    rolling30Minor: number;
    ceilingMinor: number;
    currency: string;
  };
}

/** The cap from spec §9. The renderer adds "ועוד N" above it. */
export const MAX_NAMED_EXCEPTIONS = 20;

async function countOf(db: Queryable, sql: string, params: readonly unknown[]): Promise<number> {
  const { rows } = await db.query<{ n: string }>(sql, [...params]);
  return Number(rows[0]?.n ?? '0');
}

/**
 * Interleaves several already-sorted, already-capped lists round-robin, so
 * every non-empty source names at least one item before any source names a
 * second — one failed job, one rejected document, one expired approval, in
 * that order, before a second failed job. Without this rule a noisy source
 * (dozens of failed jobs, the commonest terminal outcome while every action
 * class sits at `draft_only`) fills all `cap` slots before a quieter source
 * (one rejected document, one expired approval) ever gets named at all —
 * exactly the one block spec §3.3 allows to be long, silently narrowed to one
 * source.
 *
 * `totals[i]` is the EXACT count of matching rows for source `i`, which may
 * exceed `lists[i].length` when that source was itself capped at the
 * database — so the `hiddenCount` this returns is a measured number across
 * every source, never an estimate from array lengths.
 */
function interleaveFairly(
  lists: readonly (readonly DigestException[])[],
  totals: readonly number[],
  cap: number,
): { named: DigestException[]; hiddenCount: number } {
  const named: DigestException[] = [];
  const cursors = lists.map(() => 0);
  let advanced = true;
  while (advanced && named.length < cap) {
    advanced = false;
    for (let i = 0; i < lists.length && named.length < cap; i += 1) {
      const list = lists[i];
      const cursor = cursors[i];
      if (list === undefined || cursor === undefined) continue;
      const item = list[cursor];
      if (item === undefined) continue;
      named.push(item);
      cursors[i] = cursor + 1;
      advanced = true;
    }
  }
  const totalAll = totals.reduce((sum, n) => sum + n, 0);
  return { named, hiddenCount: totalAll - named.length };
}

/**
 * The Hebrew sentence for a failure, deciding gate denial against breakage the
 * way `whatsapp-report.ts` already does — **by calling it, never by repeating
 * the rule.** A gate denial is not a failure: the assistant did not break, she
 * is not permitted to do that yet, and while every action class sits at
 * `draft_only` this is the commonest reason of all.
 *
 * **Must extract the leading code first, exactly as `whatsapp-report.ts`'s
 * own `classifyJob` does** (`const code = reason === null ? null :
 * leadingCode(reason); if (code !== null && isGateDenialCode(code)) ...`) —
 * fix round 1, item 2. `isGateDenialCode` matches exact strings for most of
 * `GATE_DENY_CODES` (only three members are prefix-matched); calling it on
 * the whole `${code} — ${message}` string `execute.ts` actually writes
 * (e.g. `draft_only:persist_as_draft — ...`) silently fails every exact
 * member, including `draft_only:persist_as_draft` itself — the single
 * commonest reason while every action class sits at `draft_only`. Fell back
 * to `failedText`'s generic sentence, misreporting the owner's single most
 * common case as a breakage instead of a permission she has not yet granted.
 */
function reasonInHebrew(rawReason: string | null): string {
  const code = rawReason === null ? null : leadingCode(rawReason);
  if (code !== null && isGateDenialCode(code)) return NOT_PERMITTED_TEXT;
  return failedText(rawReason);
}

/**
 * `ceilings` (now also carrying `timeZone`) is passed IN, not loaded here.
 * The money ceiling lives in the signed charter
 * (`CompiledCeilings.monthlyMinor`, domain/policy.ts:107-116) — there is none
 * in `src/config.ts` — and the zone lives in `charter.identity.timezone`.
 * Both callers already hold the whole bundle, so this is a field on an
 * object they already build, not a new failure mode in a module that must
 * stay read-only and throw-free.
 */
export async function collectDigestFacts(
  window: DigestWindow,
  ceilings: { monthlyMinor: number; currency: string; timeZone: string },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<DigestFacts> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { start, end } = window;

  // ---- §3.1 waiting: point-in-time, deliberately NOT bounded by the window.
  const approvals = await countOf(
    db,
    `SELECT count(*)::text AS n FROM approval_requests
      WHERE business_id = $1 AND state = 'pending' AND expires_at > now()`,
    [businessId],
  );
  const openQuestions = await countOf(
    db,
    `SELECT count(*)::text AS n FROM boss_instructions i
       JOIN jobs j ON j.job_id = i.job_id AND j.business_id = i.business_id
      WHERE i.business_id = $1 AND i.answer IS NULL AND j.phase = 'understand'`,
    [businessId],
  );
  const deferred = await countOf(
    db,
    `SELECT count(*)::text AS n FROM jobs
      WHERE business_id = $1 AND phase = 'await_approval'
        AND NOT EXISTS (
          SELECT 1 FROM approval_requests a
           WHERE a.business_id = jobs.business_id AND a.job_id = jobs.job_id
             AND a.state = 'pending' AND a.expires_at > now())`,
    [businessId],
  );

  // ---- §3.2 done: window-scoped counts, no names.
  //
  // **Excludes a job the owner REFUSED.** `resumeAfterDecision`
  // (`orchestrator/resume.ts:61-69`) deliberately closes, rather than fails, a
  // job whose approval was denied — its own comment: "a person said no. That
  // is an outcome, not a fault." Counting that `closed` row here would report
  // a refusal as a success, the one thing spec §1.1's split between counted
  // successes and named non-successes must not do. The discriminator is the
  // `job_steps` row that same function writes on the way to `closed`: `actor
  // = 'human'` and `reason` beginning `denied:` (the literal template is
  // `` `${approval.state}:${approvalId} by ${decidedBy}` ``, and `state` is
  // `'denied'` on that path). No new owner-facing category is added for
  // it — that is a product decision this module does not make — a refusal is
  // simply not counted as a completion.
  const jobsCompleted = await countOf(
    db,
    `SELECT count(*)::text AS n FROM jobs j
      WHERE j.business_id = $1 AND j.phase = 'closed' AND j.closed_at >= $2 AND j.closed_at < $3
        AND NOT EXISTS (
          SELECT 1 FROM job_steps s
           WHERE s.job_id = j.job_id AND s.actor = 'human' AND s.reason LIKE 'denied:%')`,
    [businessId, start, end],
  );
  // Windowed on the STEP's own `completed_at` — fix round 1, item 4. Windowing
  // on the job's `closed_at` (the previous version, via a join to `jobs`)
  // attributed a sent message to whichever window its job happened to CLOSE
  // in, and dropped it entirely until the job reached a terminal phase — a
  // message sent today inside a job that does not close until next week
  // would not be counted until next week's digest. `completed_at` is NOT
  // NULL DEFAULT now() (`004_plan_resumption.sql`) and is written the moment
  // the step itself finished, so no join to `jobs` is needed at all.
  //
  // A step that really sent, inside a job that later fails, is still counted
  // here AND its job is still named in `exceptions` below. That is one true
  // fact reported twice — the message went out, and the job it was part of
  // nonetheless failed — not a failure disguised as a success. Do not add a
  // join back in to suppress one of the two; nothing here is wrong.
  const messagesSent = await countOf(
    db,
    `SELECT count(*)::text AS n FROM job_step_results r
      WHERE r.business_id = $1 AND r.status = 'completed' AND r.performed IS TRUE
        AND r.external_id IS NOT NULL AND r.completed_at >= $2 AND r.completed_at < $3`,
    [businessId, start, end],
  );
  const documentsRead = await countOf(
    db,
    `SELECT count(*)::text AS n FROM document_readings
      WHERE business_id = $1 AND created_at >= $2 AND created_at < $3`,
    [businessId, start, end],
  );
  const memoriesWritten = await countOf(
    db,
    `SELECT count(*)::text AS n FROM memories
      WHERE business_id = $1 AND created_at >= $2 AND created_at < $3`,
    [businessId, start, end],
  );

  // ---- §3.3 exceptions: window-scoped and NAMED, with the Hebrew reason.
  //
  // Spec §3.3 names SIX sources — משימה שנכשלה, מסמך שנדחה, אישור שפג,
  // הקלטה שלא תומללה, הוראה שסורבה, גשר שנפל — and the three queries below
  // build exactly the first three. The other THREE are missing, not two,
  // and they are not the same kind of missing:
  //   - הקלטה שלא תומללה (an untranscribed recording) and גשר שנפל (a
  //     downed bridge) are zero-exposure today because there is no
  //     producer to read from at all — the WhatsApp bridge is wired
  //     nowhere yet (CLAUDE.md, "ערוץ הוואטסאפ... בנוי במלואו ואינו פעיל
  //     באף התקנה").
  //   - הוראה שסורבה (an instruction the owner's refusal closed) has a
  //     real producer and a real decision behind its absence: fix round 2,
  //     item 5 deliberately chose NOT to surface a refusal anywhere in the
  //     digest — not as a success (excluded from `jobsCompleted` above)
  //     and not as a named exception here, because "the owner said no" is
  //     an outcome, not a fault, and inventing a seventh block for it is a
  //     product decision this module does not make. See that fix's own
  //     comment on `jobsCompleted`.
  // Naming the gap here is so the next reader does not take the three
  // sources below as §3.3 complete, and does not mistake the third
  // omission for an oversight.
  //
  // **Each query carries `count(*) OVER ()` alongside its `LIMIT` — an EXACT
  // total of matching rows, not an estimate from the length of the capped
  // array.** The old code capped each query at `MAX_NAMED_EXCEPTIONS + 1` and
  // computed "hidden" from the combined array's length — so eighty unnamed
  // failures (capped to 21 fetched) were reported as "ועוד 1", off by
  // exactly the gap between what was fetched and what truly matched. A
  // window function is evaluated over all rows the WHERE clause matches,
  // before the query's own `ORDER BY`/`LIMIT` trim the result set, so every
  // returned row (including the last one kept by `LIMIT`) carries the real
  // total — not merely the count of what was fetched.
  const { rows: failedJobs } = await db.query<{
    title: string | null; reason: string | null; total_count: string;
  }>(
    `SELECT j.title, (
        SELECT s.reason FROM job_steps s
         WHERE s.job_id = j.job_id ORDER BY s.at DESC LIMIT 1
      ) AS reason,
      count(*) OVER ()::text AS total_count
       FROM jobs j
      WHERE j.business_id = $1 AND j.phase = 'failed'
        AND j.closed_at >= $2 AND j.closed_at < $3
      ORDER BY j.closed_at DESC
      LIMIT ${MAX_NAMED_EXCEPTIONS}`,
    [businessId, start, end],
  );
  // The column is `reason` — there is no `rejected_reason` (migration 012).
  // A `stored` row WITH a reason is a PDF that could not be decoded (ruling
  // P7): downloadable, never read — a failure the owner is told about. A
  // `stored` row without one predates PDF reading and is not.
  const { rows: rejectedDocs } = await db.query<{
    original_name: string; reason: string | null; total_count: string;
  }>(
    `SELECT original_name, reason, count(*) OVER ()::text AS total_count
       FROM documents
      WHERE business_id = $1
        AND (status = 'rejected' OR (status = 'stored' AND reason IS NOT NULL))
        AND created_at >= $2 AND created_at < $3
      ORDER BY created_at DESC
      LIMIT ${MAX_NAMED_EXCEPTIONS}`,
    [businessId, start, end],
  );
  // **Windowed on `expires_at`, never `decided_at` — fix round 1, item 1.**
  // `expireOverdue` (`src/governance/approvals.ts`) sets ONLY `state =
  // 'expired'`; `decided_at` stays NULL forever — migration 001's
  // `approval_decision_is_complete` CHECK explicitly carves `'expired'` and
  // `'cancelled'` out of the clause that requires `decided_by`/`decided_at`.
  // Windowing on `decided_at` therefore matched zero rows, always — exactly
  // the "silently matches nothing" outcome this module exists to prevent.
  // `expires_at` is the moment that actually happened inside the window.
  //
  // This makes the result reliable only because `expireOverdue` runs inside
  // `tick()` and the digest collector runs AFTER `tick()` in the same
  // `schedulerPass` — so by the time this query runs, every approval whose
  // fuse ran out before `end` has already been swept to `'expired'`. A
  // reorder of the scheduler that runs the digest before (or without) that
  // sweep would reintroduce the same "matches nothing" failure one layer up.
  const { rows: expiredApprovals } = await db.query<{ summary: string; total_count: string }>(
    `SELECT summary, count(*) OVER ()::text AS total_count
       FROM approval_requests
      WHERE business_id = $1 AND state = 'expired'
        AND expires_at >= $2 AND expires_at < $3
      ORDER BY expires_at DESC
      LIMIT ${MAX_NAMED_EXCEPTIONS}`,
    [businessId, start, end],
  );

  const totalOf = (rows: readonly { total_count: string }[]): number =>
    rows.length === 0 ? 0 : Number(rows[0]?.total_count ?? '0');

  const failedList: DigestException[] = failedJobs.map((r) => ({
    subject: r.title ?? FAILED_JOB_UNTITLED,
    reason: reasonInHebrew(r.reason),
  }));
  const rejectedList: DigestException[] = rejectedDocs.map((r) => ({
    subject: r.original_name,
    reason: r.reason ?? REJECTED_DOCUMENT_GENERIC_TEXT,
  }));
  const expiredList: DigestException[] = expiredApprovals.map((r) => ({
    subject: r.summary,
    reason: EXPIRED_APPROVAL_TEXT,
  }));

  const { named: exceptions, hiddenCount: exceptionsHiddenCount } = interleaveFairly(
    [failedList, rejectedList, expiredList],
    [totalOf(failedJobs), totalOf(rejectedDocs), totalOf(expiredApprovals)],
    MAX_NAMED_EXCEPTIONS,
  );

  // ---- §3.4 permission changes: window-scoped.
  const { rows: autonomyRows } = await db.query<{
    action_class: string;
    direction: string;
    from_level: string;
    to_level: string;
  }>(
    `SELECT action_class, direction, from_level, to_level FROM autonomy_events
      WHERE business_id = $1 AND at >= $2 AND at < $3
      ORDER BY at DESC`,
    [businessId, start, end],
  );
  const permissionChanges: DigestException[] = autonomyRows.map((r) => ({
    subject: r.action_class,
    reason:
      r.direction === 'promote'
        ? `הורשתה לפעול בלי לשאול (מ-${r.from_level} ל-${r.to_level}).`
        : `הוחזרה לשאול לפני פעולה (מ-${r.from_level} ל-${r.to_level}).`,
  }));

  // ---- §3.5 cost: both measures.
  const windowMinor = await countOf(
    db,
    `SELECT coalesce(sum(amount_minor), 0)::text AS n FROM spend_ledger
      WHERE business_id = $1 AND at >= $2 AND at < $3`,
    [businessId, start, end],
  );
  // **The gate's own window, verbatim.** `spentInWindows`
  // (policy/budget.ts:26-33) sums `at >= now() - interval '30 days'`, and
  // `checkBudget` compares that sum to `ceilings.monthlyMinor`. A calendar
  // month here would print a figure that is not comparable to the ceiling
  // beside it, and nothing the owner sees would say so.
  const rolling30Minor = await countOf(
    db,
    `SELECT coalesce(sum(amount_minor), 0)::text AS n FROM spend_ledger
      WHERE business_id = $1 AND at >= now() - interval '30 days'`,
    [businessId],
  );

  return {
    window,
    timeZone: ceilings.timeZone,
    waiting: { approvals, openQuestions, deferred },
    done: { jobsCompleted, messagesSent, documentsRead, memoriesWritten },
    exceptions,
    exceptionsHiddenCount,
    permissionChanges,
    cost: {
      windowMinor,
      rolling30Minor,
      ceilingMinor: ceilings.monthlyMinor,
      currency: ceilings.currency,
    },
  };
}

/** `jobs.title` is nullable; a failed job somehow untitled still needs a label. */
const FAILED_JOB_UNTITLED = 'משימה בלי כותרת';

const REJECTED_DOCUMENT_GENERIC_TEXT = 'המסמך נדחה בקליטה.';

const EXPIRED_APPROVAL_TEXT = 'האישור פג בלי שהוכרע, והעבודה לא בוצעה.';
