# Verification Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `gov.verify`'s judge actually run in production, by giving its job a two-step plan instead of killing it, so the verdict reaches the owner's approval card.

**Architecture:** `beginVerification` binds a two-step plan to the `gov.verify` job — `agent.request_help` (existing, unchanged) then `assert.evaluate` (new). The existing engine drives the rest: step 1 delegates and parks, re-parks while waiting, and completes when the result envelope lands; step 2 composes the answer from the child's reading, runs the judge, and files the outcome. No new loop, no new phase, no change to the generic delegation machinery.

**Tech Stack:** TypeScript NodeNext ESM, Postgres 17 via `pg`, zod, vitest against a real database.

**Spec:** [docs/superpowers/specs/2026-09-24-verification-loop-design.md](../specs/2026-09-24-verification-loop-design.md)

## Global Constraints

- `.js` on every relative import, including from `.ts` files — required by `NodeNext` + `"type": "module"`.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUnusedLocals` are all on. Index access needs `rows[0]?.x`; optional properties need conditional spread (`x !== undefined ? { x } : {}`); `import type` must be separated exactly.
- A zod schema and its inferred type share one name: `export const X = z.enum([...]); export type X = z.infer<typeof X>;`
- Hebrew for anything a human reads (rejection reasons, dashboard copy, docs). English for identifiers, comments and internal errors.
- DB modules use a private `interface XRow` plus a `toX(row)` function. SQL is snake_case, TS is camelCase.
- Every new migration is a NEW numbered file. **Never edit an existing migration** — the runner tracks by filename, so editing in place leaves every database that already ran it on the old schema while the file claims otherwise.
- Tests need a real Postgres. Run `npm run migrate:test` after adding a migration, before running tests.
- **A negative test must prove the code it covers actually ran.** Asserting only that a bad outcome is absent passes identically when the gate refused earlier than the author expected. Assert a positive marker too (a status, a recorded reason). The previous branch produced three tests that passed on nothing.
- **Controls are written positively, never as "everything except X".**
- **A value that could not be read is never the permissive value.**
- Read `CLAUDE.md`'s section "כללים שהקוד אוכף בשקט" before changing policy-adjacent code.
- The verdict is **informational only**. Nothing in this plan may block, defer or condition any action on it.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/orchestrator/verification-answer.ts` (create) | One pure function: turn a `Reading` into the bounded answer string the judge receives. No DB, no model. |
| `src/db/migrations/030_verification_not_judged.sql` (create) | Let `verification_verdicts` record "the judge did not run, and why". |
| `src/governance/verdict-store.ts` (modify) | Add the three-state read and the not-judged write. `Verdict` itself is untouched. |
| `src/orchestrator/local-tools.ts` (modify) | The `assert.evaluate` step: compose, judge, file. Plus its payload contract and a `verifier` injection seam. |
| `src/orchestrator/conduct.ts` (modify) | `beginVerification` binds the plan instead of calling `verifyDraft` and killing the job. |
| `src/dashboard/server.ts`, `src/dashboard/views.ts` (modify) | Render the third card state: attempted, not completed. |
| `src/policy/classify.ts` (modify) | `assert.evaluate` reads document-derived content: `ingestsExternalContent` → `true`. |
| `CLAUDE.md`, `docs/09-roadmap.md` (modify) | The claims this work makes false. |

---

## Task 1: The answer composer

**Files:**
- Create: `src/orchestrator/verification-answer.ts`
- Test: `src/orchestrator/verification-answer.test.ts`

**Interfaces:**
- Consumes: `Reading` from `src/domain/reading.ts` (`{ summary: string; findings: Finding[]; intents: Intent[]; unreadable: string[] }`; each `Intent` has `{ intent: IntentName; subject: EntityRef; sourceRef: SourceRef; note: string }`).
- Produces: `composeVerificationAnswer(reading: Reading): string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/orchestrator/verification-answer.test.ts
import { describe, expect, it } from 'vitest';
import { composeVerificationAnswer } from './verification-answer.js';
import type { Reading } from '../domain/reading.js';

function reading(over: Partial<Reading> = {}): Reading {
  return {
    summary: 'הספק מבקש אישור להצעת מחיר ומבקש תשובה עד יום חמישי.',
    findings: [],
    intents: [
      {
        intent: 'reply_to_sender',
        subject: { kind: 'sender' },
        sourceRef: { ordinal: 0, quote: 'נא אישורכם' },
        note: '',
      },
    ],
    unreadable: [],
    ...over,
  };
}

describe('composeVerificationAnswer', () => {
  it('carries the summary and the inferred intent names, and nothing else', () => {
    const answer = composeVerificationAnswer(reading());
    expect(answer).toContain('הספק מבקש אישור להצעת מחיר');
    expect(answer).toContain('reply_to_sender');
    // The note is model-authored free text about a hostile document and adds
    // nothing the summary does not already carry; it must not travel.
    expect(answer).not.toContain('נא אישורכם');
  });

  it('is deterministic: the same reading with intents in a different order composes identically', () => {
    const a = composeVerificationAnswer(
      reading({
        intents: [
          { intent: 'pay_invoice', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, quote: 'x' }, note: '' },
          { intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, quote: 'y' }, note: '' },
        ],
      }),
    );
    const b = composeVerificationAnswer(
      reading({
        intents: [
          { intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, quote: 'y' }, note: '' },
          { intent: 'pay_invoice', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, quote: 'x' }, note: '' },
        ],
      }),
    );
    expect(a).toBe(b);
  });

  it('lists a repeated intent once', () => {
    const answer = composeVerificationAnswer(
      reading({
        intents: [
          { intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, quote: 'x' }, note: '' },
          { intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 1, quote: 'y' }, note: '' },
        ],
      }),
    );
    expect(answer.match(/reply_to_sender/g)).toHaveLength(1);
  });

  it('does not truncate — the single cap lives in verifyDraft, which records it', () => {
    const long = 'א'.repeat(9000);
    expect(composeVerificationAnswer(reading({ summary: long }))).toContain(long);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/orchestrator/verification-answer.test.ts`
Expected: FAIL — `Cannot find module './verification-answer.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/orchestrator/verification-answer.ts
import type { Reading } from '../domain/reading.js';

/**
 * The answer `gov.verify`'s judge receives, composed from what `know.reader`
 * produced — deterministically, with no model call of its own.
 *
 * **Why this function exists at all, rather than handing the judge the
 * document.** `verifyDraft` already receives `sources` (the full artifact
 * rendering) but uses them for ONE thing: deterministic numeric grounding,
 * which makes no model call. The judge's own prompt fences exactly three
 * fields — `question`, `answer`, `draftText` — and the raw document text is
 * deliberately not among them. The moment hostile document text enters the
 * judge's prompt, its verdict is exposed to the same injection as the draft it
 * is judging, and a judge that can be talked out of its finding is worth
 * nothing. This function is the bounded channel that replaces it.
 *
 * **Two fields, and why not more.** The summary is `know.reader`'s own
 * one-paragraph account of the document. The intent names are a CLOSED enum
 * (`IntentName`) — no free text can arrive through them, and they are
 * literally "what the document asks for", which is the first half of
 * `VERIFICATION_QUESTION`. Everything else in a `Reading` is excluded on
 * purpose: `findings[].label` and `intents[].note` are model-authored free
 * text, `sourceRef.quote` is a verbatim fragment of the hostile document
 * itself, and none of them tells the judge anything the summary does not.
 *
 * **No truncation here.** `verifyDraft` caps the answer it receives and
 * records the cut on the verdict (`Verdict.answerTruncated`). A second cap
 * here would be a second place a cut can happen, and only one of them would
 * be recorded — so the owner could read a verdict with no truncation flag on
 * an answer that was in fact cut. One cap, one record.
 *
 * Deterministic in the reading: intents are de-duplicated and sorted, so the
 * same reading always composes the same string regardless of the order the
 * model happened to emit them in.
 */
export function composeVerificationAnswer(reading: Reading): string {
  const asks = [...new Set(reading.intents.map((intent) => intent.intent))].sort();
  return [`תקציר: ${reading.summary}`, `מה המסמך מבקש: ${asks.join(', ')}`].join('\n');
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/orchestrator/verification-answer.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/orchestrator/verification-answer.ts src/orchestrator/verification-answer.test.ts
git commit -m "The bounded answer the judge receives, composed from the reading"
```

---

## Task 2: Record "the judge did not run"

**Files:**
- Create: `src/db/migrations/030_verification_not_judged.sql`
- Modify: `src/governance/verdict-store.ts`
- Test: `src/governance/verdict-store.test.ts` (existing file, add cases)

**Interfaces:**
- Consumes: `Verdict`, `saveVerdict`, `loadVerdict` as they already are in `src/governance/verdict-store.ts`.
- Produces:
  - `export const NotJudgedReason = z.enum(['failed', 'timeout']);` plus its inferred type.
  - `export type VerificationOutcome = { status: 'judged'; verdict: Verdict } | { status: 'not_judged'; reason: NotJudgedReason };`
  - `saveNotJudged(jobId: string, reason: NotJudgedReason, options?: { businessId?: string; db?: Queryable }): Promise<void>`
  - `loadVerificationOutcome(jobId: string, options?: { businessId?: string; db?: Queryable }): Promise<VerificationOutcome | null>`

**Why a sibling column rather than a field inside `Verdict`:** `Verdict.criteria` is `.min(1)` — a real invariant, because a verdict with no criteria is a judge that said nothing. A "did not run" row has no criteria at all, so putting it inside `Verdict` means relaxing `.min(1)` for every row, including real ones. The three states live one level up instead, and `Verdict` keeps its invariant and its docblocks untouched.

- [ ] **Step 1: Write the migration**

```sql
-- src/db/migrations/030_verification_not_judged.sql
-- A verification that was attempted and could not complete is a different fact
-- from a verification that never started, and the card must tell them apart:
-- with no row at all meaning "still running", the absence of a row could
-- otherwise mean either "still running" or "gave up", at different times, with
-- nothing to distinguish them on screen.
--
-- Exactly one of the two columns is populated, enforced here rather than only
-- in TypeScript: `saveVerdict` and `saveNotJudged` both upsert on the same
-- primary key, and a future caller that forgets to clear the other column
-- would otherwise write a row claiming both at once.
ALTER TABLE verification_verdicts ALTER COLUMN verdict DROP NOT NULL;
ALTER TABLE verification_verdicts ADD COLUMN not_judged_reason TEXT;

ALTER TABLE verification_verdicts ADD CONSTRAINT verification_verdicts_one_shape
    CHECK (
        (verdict IS NOT NULL AND not_judged_reason IS NULL)
     OR (verdict IS NULL AND not_judged_reason IN ('failed', 'timeout'))
    );
```

- [ ] **Step 2: Apply it to the test database**

Run: `npm run migrate:test`
Expected: the runner reports `030_verification_not_judged.sql` applied.

- [ ] **Step 3: Write the failing tests**

Add to `src/governance/verdict-store.test.ts`. Follow the file's existing setup (it already has a `resetDatabase()` beforeEach and a helper that builds a `Verdict`; reuse them rather than writing new ones).

```ts
  it('records a verification that was attempted and did not complete', async () => {
    await saveNotJudged('JOB-1', 'timeout');
    const outcome = await loadVerificationOutcome('JOB-1');
    expect(outcome).toEqual({ status: 'not_judged', reason: 'timeout' });
  });

  it('reports no row at all as null — the state that means "still running"', async () => {
    expect(await loadVerificationOutcome('JOB-NONE')).toBeNull();
  });

  it('a real verdict written over a not-judged row clears the reason, and vice versa', async () => {
    // Both writers upsert the same primary key. Without each clearing the
    // other's column the CHECK rejects the second write, which would surface
    // as a raw Postgres error on a path that should simply overwrite.
    await saveNotJudged('JOB-2', 'failed');
    await saveVerdict('JOB-2', someVerdict());
    expect(await loadVerificationOutcome('JOB-2')).toEqual({
      status: 'judged',
      verdict: expect.objectContaining({ criteria: expect.any(Array) }),
    });

    await saveNotJudged('JOB-2', 'timeout');
    expect(await loadVerificationOutcome('JOB-2')).toEqual({
      status: 'not_judged',
      reason: 'timeout',
    });
  });

  it('loadVerdict returns null for a not-judged row instead of throwing', async () => {
    // `toVerdict` calls `Verdict.parse`. Before this change the column was NOT
    // NULL, so the parse always had an object; a not-judged row would hand it
    // `null` and throw — and the dashboard route wraps `loadVerdict` in a
    // try/catch that renders "a verdict exists but could not be read", which
    // would be a lie about a row that says the judge never ran.
    await saveNotJudged('JOB-3', 'failed');
    expect(await loadVerdict('JOB-3')).toBeNull();
  });

  it('refuses a reason outside the enum at the database, not only in zod', async () => {
    await expect(
      getPool().query(
        `INSERT INTO verification_verdicts (business_id, job_id, verdict, not_judged_reason)
         VALUES ($1, $2, NULL, 'whatever')`,
        [config.businessId, 'JOB-4'],
      ),
    ).rejects.toThrow(/verification_verdicts_one_shape/);
  });
```

- [ ] **Step 4: Run them and watch them fail**

Run: `npx vitest run src/governance/verdict-store.test.ts`
Expected: FAIL — `saveNotJudged` and `loadVerificationOutcome` are not exported.

- [ ] **Step 5: Implement**

In `src/governance/verdict-store.ts`:

```ts
/**
 * Why a verification produced no judgment. Both values come from
 * `DelegationOutcome` (`src/domain/envelope.ts`) — the helper failed, or it
 * never answered inside the envelope's deadline. `succeeded` is deliberately
 * absent: a delegation that succeeded produces a real `Verdict`, so there is
 * no third value this enum could carry without meaning "judged after all".
 */
export const NotJudgedReason = z.enum(['failed', 'timeout']);
export type NotJudgedReason = z.infer<typeof NotJudgedReason>;

/**
 * What verification has to say about a job, in the three states the card
 * distinguishes. `null` from `loadVerificationOutcome` is the fourth and it is
 * the important one: no row means the check is still running, and it means
 * ONLY that, because verification is attempted on every card the conductor
 * raises. Were it selective, absence would also cover "nobody tried".
 */
export type VerificationOutcome =
  | { status: 'judged'; verdict: Verdict }
  | { status: 'not_judged'; reason: NotJudgedReason };
```

Add the writer, and change `saveVerdict`'s upsert to clear the sibling column:

```ts
export async function saveNotJudged(
  jobId: string,
  reason: NotJudgedReason,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  await db.query(
    `INSERT INTO verification_verdicts (business_id, job_id, verdict, not_judged_reason)
     VALUES ($1, $2, NULL, $3)
     ON CONFLICT (business_id, job_id)
     DO UPDATE SET verdict = NULL, not_judged_reason = EXCLUDED.not_judged_reason`,
    [businessId, jobId, reason],
  );
}
```

In `saveVerdict`, the `DO UPDATE` becomes:

```ts
     DO UPDATE SET verdict = EXCLUDED.verdict, not_judged_reason = NULL`,
```

`loadVerdict` gains one predicate so a not-judged row reads as absent rather than throwing:

```ts
    `SELECT verdict FROM verification_verdicts
      WHERE business_id = $1 AND job_id = $2 AND verdict IS NOT NULL`,
```

And the three-state reader:

```ts
interface OutcomeRow {
  verdict: unknown;
  not_judged_reason: string | null;
}

export async function loadVerificationOutcome(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<VerificationOutcome | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { rows } = await db.query<OutcomeRow>(
    `SELECT verdict, not_judged_reason FROM verification_verdicts
      WHERE business_id = $1 AND job_id = $2`,
    [businessId, jobId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  if (row.not_judged_reason !== null) {
    // The DB CHECK already constrains this column, so a value outside the enum
    // means the constraint was dropped or bypassed. Parsed rather than cast for
    // the same reason every other read here is: a value we could not read is
    // not a value we report.
    return { status: 'not_judged', reason: NotJudgedReason.parse(row.not_judged_reason) };
  }
  return { status: 'judged', verdict: Verdict.parse(row.verdict) };
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx vitest run src/governance/verdict-store.test.ts`
Expected: PASS, including the five new cases.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/db/migrations/030_verification_not_judged.sql src/governance/verdict-store.ts src/governance/verdict-store.test.ts
git commit -m "A verification that was attempted and did not finish says so"
```

---

## Task 3: The `assert.evaluate` step

**Files:**
- Modify: `src/orchestrator/local-tools.ts`
- Modify: `src/policy/classify.ts`
- Test: `src/orchestrator/local-tools.test.ts` (existing file, add cases)

**Interfaces:**
- Consumes: `composeVerificationAnswer` (Task 1); `saveVerdict`, `saveNotJudged` (Task 2); `verifyDraft`, `type VerifyDraftResult` from `src/sdk/gov-verify.ts`; `loadEnvelopeForChildJob`, `loadResultForChildJob` from `src/governance/envelope-store.ts`; `ResultEnvelopePayload` from `src/domain/envelope.ts`; `loadLatestReading` from `src/documents/reading-store.ts`.
- Produces: an `assert.evaluate` entry in the local-tool implementation table; a `LOCAL_TOOL_CONTRACTS` entry for it; `LocalToolContext.verifier?: (input: VerifyDraftInput) => Promise<VerifyDraftResult>`.

**The payload this step reads** (the plan of Task 4 produces it):
`{ "subjectJobId": string, "documentId": string, "draftText": string, "question": string }`

- [ ] **Step 1: Add the injection seam and the input schema**

`verifyDraft` costs money. `LocalToolContext` already carries a `reader` seam for exactly this reason on `doc.fetch`; add its sibling, with the same reasoning in the docblock:

```ts
  /**
   * The second step that costs money, injectable so a test can drive
   * `assert.evaluate` without an API key — the same seam `ctx.reader` already
   * is for `doc.fetch`. Defaults to the real `verifyDraft` inside the handler
   * when omitted.
   */
  verifier?: (input: VerifyDraftInput) => Promise<VerifyDraftResult>;
```

Beside the other `parseOrFail` schemas in the file:

```ts
const AssertEvaluateInput = z.object({
  subjectJobId: z.string().min(1),
  documentId: z.string().min(1),
  draftText: z.string(),
  question: z.string().min(1).max(500),
});
```

- [ ] **Step 2: Write the failing tests**

Add to `src/orchestrator/local-tools.test.ts`, reusing the file's existing job/charter setup helpers.

```ts
  it('judges and files a verdict when the delegation succeeded', async () => {
    // Full shape: a gov.verify job parked on an envelope whose child answered.
    const { parentJobId, subjectJobId, documentId } = await seedAnsweredDelegation('succeeded');
    const outcome = await runLocalTool(
      'assert.evaluate',
      { subjectJobId, documentId, draftText: 'שלום, מאשר את ההצעה.', question: VERIFICATION_QUESTION },
      { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: stubJudge },
    );
    // Proves the handler RAN, not merely that nothing bad happened.
    expect(outcome).toMatchObject({ performed: true, status: 'judged' });
    expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toMatchObject({
      status: 'judged',
    });
  });

  it('files "not judged" and never calls the judge when the child failed', async () => {
    const { parentJobId, subjectJobId, documentId } = await seedAnsweredDelegation('failed');
    let judgeCalls = 0;
    const counting = async (input: VerifyDraftInput) => {
      judgeCalls += 1;
      return stubJudge(input);
    };
    const outcome = await runLocalTool(
      'assert.evaluate',
      { subjectJobId, documentId, draftText: 'טיוטה', question: VERIFICATION_QUESTION },
      { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: counting },
    );
    expect(outcome).toMatchObject({ performed: true, status: 'not_judged', reason: 'failed' });
    expect(judgeCalls).toBe(0);
    expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toEqual({
      status: 'not_judged',
      reason: 'failed',
    });
  });

  it('files "not judged" with reason timeout when the deadline fired', async () => {
    const { parentJobId, subjectJobId, documentId } = await seedAnsweredDelegation('timeout');
    const outcome = await runLocalTool(
      'assert.evaluate',
      { subjectJobId, documentId, draftText: 'טיוטה', question: VERIFICATION_QUESTION },
      { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: stubJudge },
    );
    expect(outcome).toMatchObject({ status: 'not_judged', reason: 'timeout' });
  });

  it('refuses when no result envelope exists — a state step 1 cannot produce', async () => {
    const { parentJobId, subjectJobId, documentId } = await seedUnansweredDelegation();
    await expect(
      runLocalTool(
        'assert.evaluate',
        { subjectJobId, documentId, draftText: 'טיוטה', question: VERIFICATION_QUESTION },
        { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: stubJudge },
      ),
    ).rejects.toThrow(/verification_answer_missing/);
  });

  it('running twice files one verdict, not two', async () => {
    const { parentJobId, subjectJobId, documentId } = await seedAnsweredDelegation('succeeded');
    const args = [
      'assert.evaluate',
      { subjectJobId, documentId, draftText: 'טיוטה', question: VERIFICATION_QUESTION },
      { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: stubJudge },
    ] as const;
    await runLocalTool(...args);
    await runLocalTool(...args);
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM verification_verdicts WHERE business_id = $1 AND job_id = $2`,
      [BUSINESS, subjectJobId],
    );
    expect(rows[0]?.n).toBe(1);
  });
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run src/orchestrator/local-tools.test.ts`
Expected: FAIL — `assert.evaluate` has no implementation, so `runLocalTool` reports `not_implemented`.

- [ ] **Step 4: Implement the handler**

```ts
  /**
   * The second half of `gov.verify`'s check: the step that runs once
   * `agent.request_help` has an answer.
   *
   * **It resolves the delegation's outcome itself rather than reading step 1's
   * output, because nothing threads a step's output into the next step's
   * input** — `runPlan` uses `completedSteps` only to decide what to skip.
   * Every step here reads what it needs from the durable record, and this one
   * reads the same `result` envelope step 1 read.
   *
   * **The judge does not run on a failed or timed-out delegation.** There is
   * no answer to judge, and a verdict formed on an empty answer is
   * indistinguishable on screen from one formed on a real one — worse than no
   * verdict. A row is still written, saying the judge did not run and why,
   * because with no row at all the absence would mean "still running" early
   * and "gave up" later with nothing to tell them apart.
   */
  'assert.evaluate': async (input, ctx) => {
    const parsed = parseOrFail(AssertEvaluateInput, input, 'assert.evaluate');
    if (ctx.bundle === undefined) {
      throw new Error('runLocalTool: assert.evaluate requires ctx.bundle (the active charter)');
    }
    const dbOpts = { businessId: ctx.businessId, ...(ctx.db !== undefined ? { db: ctx.db } : {}) };

    const governing = await loadEnvelopeForChildJob(ctx.jobId, dbOpts);
    if (governing === null) {
      throw new StepChannelError(
        'verification_answer_missing',
        `job ${ctx.jobId} carries no delegation envelope to read an answer from`,
        false,
      );
    }
    const stored = await loadEnvelopeWithChild(governing.id, dbOpts);
    const childJobId = stored?.childJobId ?? null;
    if (childJobId === null) {
      throw new StepChannelError(
        'verification_answer_missing',
        `envelope ${governing.id} has no child job to read an answer from`,
        false,
      );
    }
    const resultEnvelope = await loadResultForChildJob(childJobId, governing.correlationId, dbOpts);
    if (resultEnvelope === null) {
      throw new StepChannelError(
        'verification_answer_missing',
        `no result envelope for child ${childJobId} under correlation ${governing.correlationId}`,
        false,
      );
    }
    const payload = ResultEnvelopePayload.safeParse(resultEnvelope.payload);
    if (!payload.success) {
      throw new StepChannelError(
        'delegation_result_corrupted',
        `result envelope ${resultEnvelope.id} has an unreadable payload`,
        false,
      );
    }

    if (payload.data.outcome !== 'succeeded') {
      await saveNotJudged(parsed.subjectJobId, payload.data.outcome, dbOpts);
      return { performed: true, status: 'not_judged', reason: payload.data.outcome };
    }

    const job = await loadJob(ctx.jobId, dbOpts);
    if (job === null) {
      throw new Error(`runLocalTool: assert.evaluate could not load job ${ctx.jobId}`);
    }
    const reading = await loadLatestReading(parsed.documentId, job.provenance, dbOpts);
    if (reading === null) {
      throw new StepChannelError(
        'verification_answer_missing',
        `child ${childJobId} answered but no reading exists for document ${parsed.documentId}`,
        false,
      );
    }

    const artifacts = await loadArtifacts(parsed.documentId, dbOpts);
    const verify = ctx.verifier ?? verifyDraft;
    const result = await verify({
      parentJobId: ctx.jobId,
      subjectJobId: parsed.subjectJobId,
      documentId: parsed.documentId,
      draftText: parsed.draftText,
      sources: artifacts.map((artifact) => renderArtifactFull(artifact)),
      question: parsed.question,
      answer: composeVerificationAnswer(reading.reading),
      parentEnvelope: governing,
      businessId: ctx.businessId,
    });

    if ('status' in result && result.status === 'awaiting_delegation') {
      // `answer` was non-null on this call, so `verifyDraft` had no reason to
      // delegate again. Reaching here means its branching changed under us.
      throw new StepChannelError(
        'verification_delegated_again',
        `verifyDraft delegated a second time despite being given an answer (envelope ${result.envelopeId})`,
        false,
      );
    }
    await saveVerdict(parsed.subjectJobId, result, dbOpts);
    return { performed: true, status: 'judged' };
  },
```

Add the contract entry beside the others in `LOCAL_TOOL_CONTRACTS`:

```ts
  {
    toolName: 'assert.evaluate',
    payload:
      '`{"subjectJobId": מזהה המשימה שהטיוטה שלה נבדקת, "documentId": מזהה המסמך, ' +
      '"draftText": הטקסט שנשפט, "question": השאלה שנשאלה (עד 500 תווים)}`.',
  },
```

- [ ] **Step 5: Correct the ingest flag**

In `src/policy/classify.ts`, `ingestsExternalContent['assert.evaluate']` becomes `true`, with the reason in a comment: this step composes its answer from a reading of a document, so it ingests document-derived content. `false` was accurate only while nothing implemented the tool.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx vitest run src/orchestrator/local-tools.test.ts`
Expected: PASS, including the five new cases.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/orchestrator/local-tools.ts src/orchestrator/local-tools.test.ts src/policy/classify.ts
git commit -m "The step that judges once the helper has answered"
```

---

## Task 4: `beginVerification` binds a plan

**Files:**
- Modify: `src/orchestrator/conduct.ts`
- Test: `src/orchestrator/conduct.test.ts` (existing file, add cases)

**Interfaces:**
- Consumes: `bindPlanToJob(jobId, plan, options)` from `src/orchestrator/plan-store.ts`; `Plan`/`PlanStep` from `src/domain/plan.ts`; the `assert.evaluate` payload shape from Task 3.
- Produces: a `gov.verify` job that carries a two-step plan and is NOT transitioned to `failed`.

- [ ] **Step 1: Write the failing tests**

```ts
  it('binds a two-step plan to the gov.verify job and leaves it running', async () => {
    const { subjectJobId, documentId } = await seedCardRaised();
    await beginVerification({ subjectJobId, documentId, businessId: BUSINESS, /* …existing ctx */ });

    const verifyJob = await findGovVerifyJobFor(subjectJobId);
    // The bug this replaces: the job was transitioned to `failed`
    // unconditionally, every time, right after the delegation opened.
    expect(verifyJob?.phase).not.toBe('failed');
    const bound = await loadPlanForJob(verifyJob!.jobId, { businessId: BUSINESS });
    expect(bound?.plan.steps.map((s) => s.toolName)).toEqual([
      'agent.request_help',
      'assert.evaluate',
    ]);
    expect(bound?.plan.steps[1]?.dependsOn).toEqual([bound?.plan.steps[0]?.id]);
  });

  it('parks the gov.verify job on the delegation rather than ending it', async () => {
    const { subjectJobId, documentId } = await seedCardRaised();
    await beginVerification({ subjectJobId, documentId, businessId: BUSINESS /* … */ });
    const verifyJob = await findGovVerifyJobFor(subjectJobId);
    expect(verifyJob?.phase).toBe('followup');
    // Positive marker: the park is the delegation's, so the column that
    // `resumeDelegatedJobs` selects on must be set. A park with this column
    // null is a job nothing will ever wake.
    expect(verifyJob?.awaitingEnvelopeId).not.toBeNull();
  });

  it('raises the approval card immediately, with no verdict yet', async () => {
    const { subjectJobId, documentId } = await seedCardRaised();
    await beginVerification({ subjectJobId, documentId, businessId: BUSINESS /* … */ });
    expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toBeNull();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/orchestrator/conduct.test.ts`
Expected: FAIL — the job is `failed` and no plan is bound.

- [ ] **Step 3: Replace the direct call with a bound plan**

Delete the `ctx.verifier({...})` call and the unconditional `transition(delegatingJob.jobId, { to: 'failed', … })` that follows it. In their place:

```ts
    // The delegating job gets a real plan, and the engine drives it from here.
    //
    // **Why this replaces calling `verifyDraft` directly and then ending the
    // job.** A job in `execute` with no bound plan fails as `no_plan_bound` on
    // the next `runDueJobs` pass, so the previous version ended the job itself
    // to make that failure legible rather than mysterious. Binding a plan
    // removes the cause instead of labelling the symptom: step 1 parks the job
    // on the delegation, `resumeDelegatedJobs` wakes it when the answer lands,
    // the same step completes, and step 2 judges. Nothing in the generic
    // delegation machinery changes — see `agent.request_help`'s handler, which
    // already implements all three of its passes.
    const plan: Plan = {
      goal: `אימות הטיוטה של משימה ${ctx.subjectJobId}`,
      assumptions: [],
      clarifyingQuestion: null,
      estimatedCostMinor: 0,
      steps: [
        {
          id: 'ask-reader',
          agent: 'gov.verify',
          intent: 'לברר מה המסמך מבקש בפועל',
          toolName: 'agent.request_help',
          input: {
            to: 'know.reader',
            intent: 'read_for_question',
            payload: { question: VERIFICATION_QUESTION },
            contextRefs: [{ kind: 'document', documentId: ctx.documentId }],
          },
          dependsOn: [],
          expectedActionClass: null,
        },
        {
          id: 'judge',
          agent: 'gov.verify',
          intent: 'לשפוט את הטיוטה מול מה שהמסמך מבקש',
          toolName: 'assert.evaluate',
          input: {
            subjectJobId: ctx.subjectJobId,
            documentId: ctx.documentId,
            draftText: draftTextFor(action),
            question: VERIFICATION_QUESTION,
          },
          dependsOn: ['ask-reader'],
          expectedActionClass: null,
        },
      ],
    };
    await bindPlanToJob(delegatingJob.jobId, plan, { businessId: ctx.businessId });
    return { opened: true };
```

`ctx.verifier` becomes unused by `beginVerification` — the judge now runs inside the step, injected through `ctx.verifier` on `LocalToolContext` instead. Remove the option from `beginVerification`'s own input type if nothing else reads it; if its test helpers pass it, update them rather than keeping a dead field.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/orchestrator/conduct.test.ts`
Expected: PASS. Some existing cases in this file assert the `failed` transition that just went away — update them to the new behaviour, and state in each edited test's comment what the old assertion was locking so the change is legible in review.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/orchestrator/conduct.ts src/orchestrator/conduct.test.ts
git commit -m "The verification job gets a plan instead of a bullet"
```

---

## Task 5: The card's three states

**Files:**
- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard/views.ts`
- Test: `src/dashboard/server.test.ts` (existing file, add cases)

**Interfaces:**
- Consumes: `loadVerificationOutcome` (Task 2).
- Produces: `ApprovalCardOptions.notJudged?: NotJudgedReason` rendered by `views.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
    it('says the check is still running when no row exists', async () => {
      const { approvalId } = await seedApproval();
      const res = await get(`/a/${approvalId}`);
      expect(res.body).toContain('בבדיקה');
    });

    it('says the check was attempted and did not finish, with the reason', async () => {
      const { approvalId, jobId } = await seedApproval();
      await saveNotJudged(jobId, 'timeout', { businessId: BUSINESS });
      const res = await get(`/a/${approvalId}`);
      expect(res.body).toContain('הבדיקה לא הושלמה');
      // The distinction the whole third state exists for: this must not read
      // as "checked and found nothing wrong".
      expect(res.body).not.toContain('לא נמצאו בעיות');
    });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/dashboard/server.test.ts`
Expected: FAIL — neither string is rendered.

- [ ] **Step 3: Implement**

In `server.ts`, replace the `loadVerdict` call inside the existing try/catch with `loadVerificationOutcome`, keeping the catch and its `verdictUnreadable` behaviour exactly as it is, and mapping the three states onto the card options: `judged` → `verdict`, `not_judged` → `notJudged: reason`, `null` → neither.

In `views.ts`, add beside the existing `verdictUnreadable` line:

```ts
${options.notJudged ? `<p class="muted">בדיקת האימות (gov.verify) נוסתה ולא הושלמה — ${options.notJudged === 'timeout' ? 'העוזר לא השיב בזמן שהוקצב' : 'העוזר נכשל'}. הטיוטה לא נבדקה.</p>` : ''}
${options.verdict === undefined && options.notJudged === undefined && !options.verdictUnreadable ? '<p class="muted">בבדיקה — פסיקת האימות תופיע כאן כשתהיה מוכנה.</p>' : ''}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/dashboard/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/dashboard/server.ts src/dashboard/views.ts src/dashboard/server.test.ts
git commit -m "Three states on the card, and absence means one thing"
```

---

## Task 6: End-to-end proof, the structural invariants, and the documentation

**Files:**
- Create: `src/orchestrator/verification-loop.test.ts`
- Modify: `src/sdk/gov-verify.test.ts` (add one invariant)
- Modify: `CLAUDE.md`, `docs/09-roadmap.md`

- [ ] **Step 1: Write the end-to-end test**

Drive the real scheduler pass, with only the two paid calls injected — `ctx.reader` for the child's read and `ctx.verifier` for the judge. Everything else is production code.

```ts
// src/orchestrator/verification-loop.test.ts
it('runs the whole loop: delegate, park, wake, judge, close', async () => {
  const { subjectJobId, documentId } = await seedCardRaised();
  await beginVerification({ subjectJobId, documentId, businessId: BUSINESS /* … */ });
  const verifyJobId = (await findGovVerifyJobFor(subjectJobId))!.jobId;

  // Pass 1: step 1 delegates, the child runs and closes, the parent parks.
  await schedulerPass({ businessId: BUSINESS, reader: stubReader, verifier: stubJudge });
  expect((await loadJob(verifyJobId, { businessId: BUSINESS }))?.phase).toBe('followup');

  // Pass 2: the answer is there, so the parent wakes, step 1 completes and
  // step 2 judges.
  await schedulerPass({ businessId: BUSINESS, reader: stubReader, verifier: stubJudge });

  const finished = await loadJob(verifyJobId, { businessId: BUSINESS });
  expect(finished?.phase).toBe('closed');
  expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toMatchObject({
    status: 'judged',
  });
  // Exactly one delegation, not one per pass.
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM agent_envelopes
      WHERE business_id = $1 AND kind = 'help_request'`,
    [BUSINESS],
  );
  expect(rows[0]?.n).toBe(1);
});
```

If `schedulerPass` does not accept `reader`/`verifier`, thread them the way `notify` is already threaded (`buildRuntime` → `schedulerPass` → `runDueJobs` → `runPlanForJob` → `executeStep` → `runLocalTool`'s ctx) rather than reaching around the scheduler in the test. A test that bypasses the wiring proves the steps work and not that the loop does.

- [ ] **Step 2: Add the invariant that the judge never receives the document**

In `src/sdk/gov-verify.test.ts`:

```ts
it('the judge prompt carries the answer, never the sources', async () => {
  // The control `composeVerificationAnswer` exists to serve: `sources` feed
  // deterministic numeric grounding only. The moment raw document text reaches
  // the model call, the verdict is exposed to the same injection as the draft.
  const captured: string[] = [];
  await verifyDraft({ /* … */ sources: ['SENTINEL-DOCUMENT-TEXT'], answer: 'תשובה מורכבת',
    judge: async (call) => { captured.push(call.prompt, JSON.stringify(call.options.systemPrompt)); return stubVerdict(); } });
  expect(captured.join('\n')).toContain('תשובה מורכבת');
  expect(captured.join('\n')).not.toContain('SENTINEL-DOCUMENT-TEXT');
});
```

- [ ] **Step 3: Run both**

Run: `npx vitest run src/orchestrator/verification-loop.test.ts src/sdk/gov-verify.test.ts`
Expected: PASS.

- [ ] **Step 4: Correct the documentation this work makes false**

These passages are true today and become false with this plan. Each must change, and each must say what is true rather than being deleted:

1. **`CLAUDE.md`** — the paragraph stating `resumeDelegatedJobs` is a structural no-op on the conductor path and that no `result` envelope is ever written. Both halves stop being true: the conductor path now parks and wakes, and a `result` envelope is written on every verification.
2. **`CLAUDE.md`** — the paragraph saying the judge does not run in production at all, that `numeric-grounding.ts` has no consumer, and that the nonce fence governs nothing. All three become false.
3. **`docs/09-roadmap.md`** — the open-items paragraph carrying the same claims, plus the sentence about two extra jobs per card, one of them permanently `failed`. The permanent failure is gone; the second job remains.
4. **Add** to `CLAUDE.md`, in "כללים שהקוד אוכף בשקט": that `assert.evaluate` is a `READ_ONLY_TOOLS` member that nonetheless spends money and writes a governance record, that this leaves it with no `audit_log` row, and why the alternative was refused (a new `ActionClass` member would invalidate signed charters, because `CharterAutonomy.base` is an exhaustive record).
5. **Add** the recorded debt beside `INTENT_REGISTRY`: the child does not read `payload.question`; today's single intent is answered structurally by a general reading, and a second intent would silently receive the same general answer.

- [ ] **Step 5: Full suite, then commit**

```bash
npm run typecheck
npm test
git add -A
git commit -m "Prove the loop end to end, and correct what it makes false"
```

---

## Self-Review

**Spec coverage.** §1 goal → Tasks 3–4. §2 (do not rebuild) → honoured: no task touches `agent.request_help`'s handler or `resumeDelegatedJobs`. §3 gap א' → Task 4; gap ב' → Task 3. §4 two-step plan → Task 4. §5 answer composition → Task 1. §6 terminal semantics and the verdict-shape change → Tasks 2 and 3. §7 informational verdict and `assert.evaluate` staying read-only → Task 3 Step 5 plus Task 6 Step 4 item 4. §8 card → Task 5. §9 out-of-scope → no task touches the autonomy dial, the missing envelope kinds, the intents seam, or any unimplemented agent; the two debts are recorded in Task 6 Step 4 items 4 and 5. §10 invariants: 1 → Task 6 Step 1; 2 → Task 3 Step 2 case 1 and Task 6; 3 → Task 3 Step 2 cases 2 and 3; 4 → Task 6 Step 1's envelope count; 5 → Task 6 Step 2; 6 → Task 3 Step 2 case 5; 7 → Global Constraints, and every negative test above asserts a positive marker.

**Placeholder scan.** No "TBD", no "handle edge cases", no "similar to Task N". Two places name existing test helpers (`seedAnsweredDelegation`, `seedCardRaised`, `stubJudge`, `stubReader`) that the implementer must write or adapt from the neighbouring tests in those files — called out explicitly in each task rather than assumed.

**Type consistency.** `composeVerificationAnswer(reading: Reading): string` is defined in Task 1 and consumed in Task 3 with `reading.reading` (the `ReadingRecord` wrapper `loadLatestReading` returns — note the unwrap). `NotJudgedReason` and `VerificationOutcome` are defined in Task 2 and consumed in Tasks 3 and 5. `LocalToolContext.verifier` is declared in Task 3 Step 1 and used in Task 6's scheduler threading. The `assert.evaluate` payload is declared once in Task 3 and produced once in Task 4 with the same four field names.
