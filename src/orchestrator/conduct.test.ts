import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { ingestDocument } from '../documents/ingest.js';
import { conductPendingDocuments } from './conduct.js';
import type { Reading } from '../domain/reading.js';
import type { Proposal } from '../domain/proposal.js';

const BUSINESS = 'biz-conduct';

// Field names here follow the current `domain/reading.ts` / `domain/proposal.ts`
// schemas (`Finding.value`, `Intent.subject`/`sourceRef`, `Proposal.clarifyingQuestion`,
// `Reading.unreadable`) rather than the brief's literal snippet, which predates a
// rename in those schemas and does not typecheck as written (`as Reading` /
// `as Proposal` refused for insufficient overlap — TS2352). The content is the
// same; only the shape was brought back in line with what `z.infer` requires.
const READING: Reading = {
  summary: 'חוזה שיווק עם ספק',
  findings: [{ label: 'מחיר', value: 'המחיר 4,000 ש"ח', sourceRef: { ordinal: 0, locator: null } }],
  intents: [
    {
      intent: 'reply_to_sender',
      subject: { kind: 'sender' },
      sourceRef: { ordinal: 0, locator: null },
      note: 'לאשר קבלה',
    },
  ],
  unreadable: [],
};

const ACTING: Proposal = {
  headline: 'קראתי את החוזה',
  stance: 'act',
  reasons: [{ text: 'המחיר תואם', findingLabel: 'מחיר', sourceRef: { ordinal: 0, locator: null } }],
  clarifyingQuestion: null,
  action: {
    headline: 'אשלח מייל לדנה',
    purpose: 'לאשר קבלה',
    agent: 'comms.email',
    intent: 'reply_to_sender',
    toolName: 'mail.send',
    expectedActionClass: 'email.initiate',
    input: { to: 'dana@example.com', subject: 'התקבל', body: 'תודה' },
  },
};

const PASSIVE: Proposal = {
  headline: 'אני נגד חתימה',
  stance: 'advise_against',
  reasons: [
    { text: 'המחיר שונה ממה שסוכם', findingLabel: 'מחיר', sourceRef: { ordinal: 0, locator: null } },
  ],
  clarifyingQuestion: null,
  action: null,
};

async function aDocument(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cd-'));
  const path = join(dir, `${text.slice(0, 6)}.txt`);
  await writeFile(path, text, 'utf8');
  const doc = await ingestDocument(
    { path, source: 'manual' },
    { businessId: BUSINESS, documentRoot: dir },
  );
  return doc.documentId;
}

/**
 * A `verifier` stub that opens nothing further of its own — no `requestHelp`
 * call, no `know.reader` child job — for tests whose own concern (the daily
 * ceiling, two racing passes) has nothing to do with verification. Without
 * it, those tests would be coupled to exactly how many jobs the REAL
 * `verifyDraft` happens to open today (the verification job itself, plus a
 * `know.reader` child from its own `requestHelp` call) — a number this task
 * owns and a future one may change, unrelated to what those tests actually
 * assert.
 */
async function noopVerifier() {
  return { status: 'awaiting_delegation' as const, envelopeId: 'noop', childJobId: null, ungroundedNumbers: [] };
}

function deps(proposal: Proposal = ACTING) {
  const calls = { reads: 0, proposals: 0 };
  return {
    calls,
    reader: async () => {
      calls.reads += 1;
      // `ReadOutcome` (src/sdk/know-reader.ts) carries `denials` and `turns`
      // on both branches — a stub missing them does not typecheck.
      return { status: 'read' as const, reading: READING, raw: '{}', denials: [], turns: 1 };
    },
    proposer: async () => {
      calls.proposals += 1;
      return { status: 'proposed' as const, proposal, raw: '{}' };
    },
  };
}

describe('conductPendingDocuments', () => {
  beforeEach(async () => {
    await resetDatabase();
    await installCharter(buildCharter(), { businessId: BUSINESS });
  });

  // I3: the conductor writes `approval_requests` without passing through the
  // gate, and the gate was carrying two things at that point — the row, and
  // the notification that the row exists. The only `notifier.notify(...)`
  // call in the codebase is inside `evaluateToolCall`, so before this a fully
  // configured installation (six SMTP variables plus APPROVAL_NOTIFY_TO) got
  // no email at all for a conductor card: the card existed, the fuse burned,
  // `expireOverdue` retired it, and the owner never knew.
  it('emails the owner about the card it raised', async () => {
    await aDocument('חוזה שיווק להודעה');
    const d = deps();
    const notified: { approvalId: string; link: string }[] = [];

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: d.reader,
      proposer: d.proposer,
      notify: {
        notifier: {
          channel: 'email',
          async notify(request, link) {
            notified.push({ approvalId: request.approvalId, link });
            return { ok: true };
          },
        },
        dashboardBaseUrl: 'http://127.0.0.1:8787',
      },
    });

    expect(result.carded).toBe(1);
    const { rows } = await getPool().query<{ approval_id: string }>(
      `SELECT approval_id FROM approval_requests`,
    );
    const approvalId = rows[0]?.approval_id;
    expect(approvalId).toBeTruthy();
    // Not just "something was notified": the notification names the card that
    // was actually written, and the link points at it.
    expect(notified).toEqual([
      { approvalId, link: `http://127.0.0.1:8787/a/${approvalId}` },
    ]);
  });

  // The gate's contract, kept exactly: delivery failing is not the request
  // failing. The row exists, the dashboard shows it, and the scheduler will
  // expire it on schedule either way.
  it('cards the document anyway when the notification fails, and records why', async () => {
    await aDocument('חוזה שיווק כשל שליחה');
    const d = deps();

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: d.reader,
      proposer: d.proposer,
      notify: {
        notifier: {
          channel: 'email',
          async notify() {
            return { ok: false, error: 'SMTP unreachable' };
          },
        },
        dashboardBaseUrl: 'http://127.0.0.1:8787',
      },
    });

    // The card was still raised and the job still moved — nothing about the
    // failed send is load-bearing.
    expect(result.carded).toBe(1);
    expect(result.failed).toBe(0);
    const jobs = await getPool().query<{ phase: string }>(
      `SELECT phase FROM jobs WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(jobs.rows[0]?.phase).toBe('await_approval');

    // And the failure is on the audit chain under the same code the gate
    // writes, not swallowed.
    const audit = await getPool().query<{ reason: string; kind: string }>(
      `SELECT reason, kind FROM audit_log WHERE business_id = $1 AND kind = 'incident'`,
      [BUSINESS],
    );
    expect(audit.rows[0]?.reason).toContain('approval_notify_failed:');
    expect(audit.rows[0]?.reason).toContain('SMTP unreachable');
  });

  it('takes a document all the way to a pending card', async () => {
    const documentId = await aDocument('חוזה שיווק');
    const d = deps();

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: d.reader,
      proposer: d.proposer,
    });

    expect(result.carded).toBe(1);
    const { rows } = await getPool().query<{ state: string; job_id: string }>(
      `SELECT state, job_id FROM approval_requests`,
    );
    expect(rows[0]?.state).toBe('pending');

    const jobs = await getPool().query<{ provenance: string; phase: string }>(
      `SELECT provenance, phase FROM jobs WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(jobs.rows[0]?.provenance).toBe('unknown_external');
    expect(jobs.rows[0]?.phase).toBe('await_approval');
    expect(documentId).toBeTruthy();
  });

  /**
   * Found by approving a card, on 11/09, and by nothing else.
   *
   * The conductor raised a card and moved the job to `await_approval` without
   * ever binding a plan. `resumeAfterDecision` then moved the approved job to
   * `execute`, `runDueJobs` found it with nothing to run, and moved it to
   * `failed` with `no_plan_bound` — so approving a conductor card did
   * nothing at all, and would have gone on doing nothing however high the
   * ramp rose. `proposalToPlan` had been built and tested since the proposal
   * planner shipped; no production caller ever used it.
   *
   * Bound BEFORE the card is raised, deliberately. A crash between the two
   * leaves either a `plan`-phase job carrying a plan nothing will run — inert,
   * because `runDueJobs` only takes jobs in `execute` — or, in the other
   * order, a card the owner can approve into the very failure this fixes.
   */
  it('binds the compiled plan before it raises the card', async () => {
    await aDocument('חוזה שיווק');
    const d = deps();

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: d.reader,
      proposer: d.proposer,
    });
    expect(result.carded).toBe(1);

    const jobs = await getPool().query<{ job_id: string }>(
      `SELECT job_id FROM jobs WHERE business_id = $1`, [BUSINESS]);
    const jobId = jobs.rows[0]?.job_id;
    expect(jobId).toBeTruthy();

    const plans = await getPool().query<{ plan: unknown }>(
      `SELECT plan FROM job_plans WHERE business_id = $1 AND job_id = $2`, [BUSINESS, jobId]);
    expect(plans.rows).toHaveLength(1);

    // The step must be the proposal's action verbatim, because the approval
    // was enqueued against that exact payload: `unspentApprovalFor` finds the
    // row by the hash of the step's input, and `consumeApproval` binds the
    // tool name too. A compilation that reshaped either would leave the
    // approval unfindable and the owner asked a second time.
    const row = plans.rows[0]?.plan;
    const plan = typeof row === 'string' ? JSON.parse(row) : (row as { steps: unknown[] });
    const steps = (plan as { steps: { toolName: string; input: unknown }[] }).steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]?.toolName).toBe(ACTING.action?.toolName);
    expect(steps[0]?.input).toEqual(ACTING.action?.input);
  });

  it('stores a passive proposal and raises no card', async () => {
    await aDocument('חוזה גרוע');
    const d = deps(PASSIVE);

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: d.reader,
      proposer: d.proposer,
    });

    expect(result.carded).toBe(0);
    expect(result.readOnly).toBe(1);
    const approvals = await getPool().query(`SELECT 1 FROM approval_requests`);
    expect(approvals.rows).toHaveLength(0);
    const proposals = await getPool().query(`SELECT 1 FROM proposals`);
    expect(proposals.rows, 'the proposal must still be stored').toHaveLength(1);

    // I4: `readOnly += 1` and `continue` sit outside the `to: 'closed'`
    // transition, so without this assertion the test held whether or not
    // that transition ran at all — the third instance of that pattern in
    // this plan. The job must actually close, not sit in `plan` forever.
    const jobs = await getPool().query<{ phase: string }>(
      `SELECT phase FROM jobs WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(jobs.rows[0]?.phase).toBe('closed');
  });

  it('stops at the daily ceiling and leaves the rest for tomorrow', async () => {
    await aDocument('מסמך אחד');
    await aDocument('מסמך שני');
    const d = deps();

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      readsPerDay: 1,
      reader: d.reader,
      proposer: d.proposer,
      verifier: noopVerifier,
    });

    expect(result.ceilingReached).toBe(true);
    expect(d.calls.reads, 'the second document must not be read').toBe(1);
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM document_readings WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows[0]?.n).toBe('1');

    // M6: the test's own title is "leaves the rest for tomorrow" — assert
    // that, not just that the first document's reading count stopped at one.
    const docs = await getPool().query<{ read_attempts: number }>(
      `SELECT read_attempts FROM documents WHERE business_id = $1 ORDER BY created_at ASC`,
      [BUSINESS],
    );
    expect(
      docs.rows[1]?.read_attempts,
      'the skipped document must be untouched',
    ).toBe(0);
    const jobs = await getPool().query(`SELECT 1 FROM jobs WHERE business_id = $1`, [BUSINESS]);
    // Two, not one: the carded document's own job, plus the `gov.verify` job
    // `beginVerification` opens beside its card (`noopVerifier` stops it
    // there — no third, `know.reader` child job). The point of this
    // assertion is still "nothing for the SECOND document" — it stays at two
    // rather than growing to four.
    expect(jobs.rows, 'no job for the document left for tomorrow').toHaveLength(2);
  });

  it('records a failure and carries on to the next document', async () => {
    await aDocument('נופל');
    await aDocument('עובד');
    let first = true;
    const d = deps();

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: async (...args: Parameters<typeof d.reader>) => {
        if (first) {
          first = false;
          throw new Error('model exploded');
        }
        return d.reader(...args);
      },
      proposer: d.proposer,
    });

    expect(result.failed).toBe(1);
    expect(result.carded, 'the second document must still get its card').toBe(1);
    const { rows } = await getPool().query<{ read_attempts: number; read_error: string }>(
      `SELECT read_attempts, read_error FROM documents WHERE read_attempts > 0`,
    );
    expect(rows[0]?.read_attempts).toBe(1);
    expect(rows[0]?.read_error).toContain('model exploded');

    // I1: the throw happens inside `readDocument`, after `createJob` already
    // put a row in `intake → understand`. No phase reader anywhere in
    // production selects `intake`, `understand` or `plan` — `run-due.ts`
    // selects `execute`, `wakeDueJobs` selects `followup`,
    // `closeVerifiedJobs` selects `verify`/`remember` — so a job left there
    // is not resting, it is leaked forever. The first job must be closed out
    // to `failed`; the second must still reach its card.
    const jobs = await getPool().query<{ phase: string }>(
      `SELECT phase FROM jobs WHERE business_id = $1 ORDER BY created_at ASC`,
      [BUSINESS],
    );
    expect(jobs.rows[0]?.phase, 'the orphaned job must not be stranded').toBe('failed');
    expect(jobs.rows[1]?.phase).toBe('await_approval');
  });

  it('does nothing at all when no charter is installed', async () => {
    await resetDatabase();
    await aDocument('בלי תקנון');
    const d = deps();

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: d.reader,
      proposer: d.proposer,
    });

    expect(result.considered).toBe(0);
    expect(d.calls.reads).toBe(0);
  });

  it('two overlapping passes never both take the same document (I3)', async () => {
    // Without the advisory lock, two overlapping passes read the same
    // `remaining` budget and the same waiting-document list, and can turn
    // one document into two jobs, two model calls and two cards. With it,
    // whichever pass loses the race does nothing at all — and even in the
    // (unlikely, event-loop-timing-dependent) case where the two passes
    // happen not to overlap, `documentsAwaitingRead`'s proposal marker (I2)
    // still stops the second one from finding a document the first already
    // finished. Either way these two invariants hold regardless of which
    // pass wins: only one job is ever created, and the model is called
    // exactly once — never twice, never zero.
    await aDocument('חוזה מירוץ');
    const d = deps();

    const [a, b] = await Promise.all([
      conductPendingDocuments({
        businessId: BUSINESS,
        reader: d.reader,
        proposer: d.proposer,
        verifier: noopVerifier,
      }),
      conductPendingDocuments({
        businessId: BUSINESS,
        reader: d.reader,
        proposer: d.proposer,
        verifier: noopVerifier,
      }),
    ]);

    expect(a.considered + b.considered, 'the single document is considered exactly once').toBe(1);
    expect(d.calls.reads, 'the model must not be called twice for one document').toBe(1);
    const jobs = await getPool().query(`SELECT 1 FROM jobs WHERE business_id = $1`, [BUSINESS]);
    // Two, not one: the document's own job, plus the `gov.verify` job opened
    // beside its card (`noopVerifier` stops it there). The invariant this
    // test exists for is unchanged — the race must not double either count.
    expect(jobs.rows, 'exactly one document worth of jobs').toHaveLength(2);
  });

  // Task 11: the conductor opens a `gov.verify` job beside the card it
  // raises, never before it — raising the card must never wait on, and must
  // never be undone by, a verification that stumbles or never even starts.
  it('opens a gov.verify job beside the card and never before it', async () => {
    await aDocument('חוזה שיווק לאימות');
    const d = deps();
    let verifierCalls = 0;

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: d.reader,
      proposer: d.proposer,
      verifier: async () => {
        verifierCalls += 1;
        throw new Error('gov.verify boom');
      },
    });

    // The card exists regardless of the throw above — proof that raising it
    // does not depend on the verification finishing, or even succeeding.
    expect(result.carded).toBe(1);
    expect(result.failed, 'a stumbling verification must not fail the document').toBe(0);
    const approvals = await getPool().query(`SELECT 1 FROM approval_requests`);
    expect(approvals.rows).toHaveLength(1);
    expect(verifierCalls).toBe(1);
    // Fix round 1, Important 3: a stumbling verification is counted, not
    // silently indistinguishable from "never attempted".
    expect(result.verificationFailed).toBe(1);

    const jobs = await getPool().query<{ title: string | null; phase: string }>(
      `SELECT title, phase FROM jobs WHERE business_id = $1 ORDER BY created_at ASC`,
      [BUSINESS],
    );
    // The document's own job still reached the card, untouched by the
    // verification job's own failure.
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows[0]?.phase).toBe('await_approval');
    // The second job is the one `beginVerification` opened, and a throw
    // inside `beginVerification` must not leave it in a phase with no
    // reader (`intake`/`understand`/`plan`) — it is closed out, terminal.
    expect(jobs.rows[1]?.title).toContain('אימות');
    expect(jobs.rows[1]?.phase).toBe('failed');
  });

  /**
   * Fix round 1, Critical 1. The real `verifyDraft` — no injected `verifier`
   * — actually calls `requestHelp`, which refuses immediately unless the job
   * named as `parentJobId` is in `execute`. `beginVerification` opens a FRESH
   * job for exactly that and passes the document's own job (sitting in
   * `await_approval`) as `subjectJobId` instead. A version that conflated the
   * two — passed the document's own job as `parentJobId` — makes this
   * `requestHelp` call refuse with `job_not_executable`, `verifyDraft` throw,
   * and `beginVerification` count it as a failure. This test exercises that
   * real wiring end to end without any stub standing in for it, and without
   * any model call (the branch this module always takes never reaches the
   * judge).
   */
  it('opens the delegation through the real verifyDraft, with the two job ids kept apart', async () => {
    await aDocument('חוזה שיווק לאימות אמיתי');
    const d = deps();

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: d.reader,
      proposer: d.proposer,
      // No `verifier` override — the real `verifyDraft` runs.
    });

    expect(result.carded).toBe(1);
    expect(
      result.verificationFailed,
      'the real verifyDraft must not refuse — parentJobId and subjectJobId must be two different jobs',
    ).toBe(0);
  });

  /**
   * Fix round 1, Critical 2. A round-0 version of `beginVerification`'s
   * docblock claimed a delegated verification job would "sit in `execute`
   * un-rerun" — false: `resumeDelegatedJobs` wakes a parked parent once its
   * child finishes, and `run-due.ts` fails a job it finds in `execute` with
   * no plan bound (`run_due: no_plan_bound`), printing an operator-visible
   * error line for every single card the conductor ever raises. This test
   * pins the actual fix: the delegating job is ended, by this module,
   * the moment the delegation opens — never left parked for that later
   * failure to happen.
   */
  it('ends the verification job itself rather than leaving it parked for run_due to fail later', async () => {
    await aDocument('חוזה שיווק לאימות תקין');
    const d = deps();

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: d.reader,
      proposer: d.proposer,
      // A well-behaved stand-in for the real `verifyDraft` on the branch
      // this module always takes (`answer: null`): it opens a delegation and
      // returns normally, exactly the shape `beginVerification` must end
      // itself rather than leave parked.
      verifier: async () => ({
        status: 'awaiting_delegation' as const,
        envelopeId: 'env-noop',
        childJobId: null,
        ungroundedNumbers: [],
      }),
    });

    expect(result.carded).toBe(1);
    // Not a failure — this is the deliberate, immediate close, not a caught
    // exception.
    expect(result.verificationFailed).toBe(0);

    const jobs = await getPool().query<{ title: string | null; phase: string }>(
      `SELECT title, phase FROM jobs WHERE business_id = $1 ORDER BY created_at ASC`,
      [BUSINESS],
    );
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows[0]?.phase).toBe('await_approval');
    expect(jobs.rows[1]?.title).toContain('אימות');
    // Terminal, not `execute` — never left for `resumeDelegatedJobs` /
    // `run-due.ts` to find and fail later.
    expect(jobs.rows[1]?.phase).toBe('failed');
  });

  /**
   * Structural, in the style of `conductor-invariants.test.ts` — anchored per
   * call, never per file (that file's own docblock explains why a file-wide
   * scan lets one call's literal answer for another). `conduct.ts` now makes
   * TWO `createJob` calls — the document's own job, and the `gov.verify` job
   * `beginVerification` opens beside the card — and both must set the same
   * fixed literal: a caller that could choose either job's provenance could
   * launder trust into it.
   */
  it('the verification job carries unknown_external as a literal', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'orchestrator', 'conduct.ts'), 'utf8');

    const marker = 'createJob(';
    const blocks: string[] = [];
    let searchFrom = 0;
    for (;;) {
      const start = src.indexOf(marker, searchFrom);
      if (start === -1) break;
      let depth = 0;
      let i = start + 'createJob'.length;
      for (; i < src.length; i += 1) {
        const ch = src[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
      }
      blocks.push(src.slice(start, i));
      searchFrom = i;
    }

    // Both calls must actually be found — a test that silently checked zero
    // blocks would pass for the wrong reason.
    expect(blocks.length, 'conduct.ts must call createJob exactly twice').toBe(2);

    for (const block of blocks) {
      const matches = [...block.matchAll(/provenance\s*:\s*([^,\n}]+)/g)];
      expect(matches.length, `every createJob(...) call must set provenance: ${block}`).toBe(1);
      const rhs = (matches[0]?.[1] ?? '').trim();
      expect(
        rhs,
        `conduct.ts createJob(...): provenance must be the literal 'unknown_external', not an expression a caller could steer`,
      ).toBe("'unknown_external'");
    }
  });
});
