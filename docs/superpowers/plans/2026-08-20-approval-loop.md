# Approval Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the approval loop — a person sees the request, answers it, and the approved step actually runs, exactly once.

**Architecture:** Three independent strands. The gate learns to spend an approval a human already gave (four conditions, single-use). The first-contact escalation stops firing when the causal chain's origin is the boss, so the queue holds only what needs a human. A separate HTTP process shows pending requests and writes decisions — it never executes anything.

**Tech Stack:** TypeScript (NodeNext, ESM), PostgreSQL 17, vitest, `node:http` and `node:crypto` (no web framework), `nodemailer` (the one new runtime dependency).

**Spec:** [docs/superpowers/specs/2026-08-20-approval-loop-design.md](../specs/2026-08-20-approval-loop-design.md)

## Global Constraints

- **`.js` on every relative import**, including from `.ts` files. Required by `NodeNext` + `"type": "module"`.
- **Three tsconfig flags bite:** `noUncheckedIndexedAccess` (forces `rows[0]?.x`), `exactOptionalPropertyTypes` (forces conditional spread: `x ? { x } : {}`), `verbatimModuleSyntax` (forces `import type` separation).
- **Tests run against real Postgres.** No mocks, no in-memory database. `resetDatabase()` from `src/test/db.js` in `beforeEach`, `closePool()` in `afterAll`.
- **Never edit an applied migration.** Migrations 001–005 are applied to both databases. New work goes in `006_approval_consumption.sql`.
- **Controls are written positively, never as "everything except X".** A negative form has swept in unintended cases three times in this codebase.
- **Every guard must bite.** After a guard's test passes, break the implementation, confirm the test fails, restore. A test that passes in both states protects nothing.
- **Hebrew for humans, English for code.** Denial messages and owner-facing copy in Hebrew; identifiers, comments and internal errors in English.
- **Money is an integer in minor units, always.**
- **Module convention for DB rows:** a private `interface XRow` plus a `toX(row)` function. SQL in `snake_case`, TypeScript in `camelCase`.
- **`appendAudit` joins the caller's transaction only when one is supplied.** Passing a bare pool takes and releases the advisory lock inside one statement and silently defeats chain serialisation.
- **Verification after every task:** `npm run typecheck && npm test` must both be clean before the commit.

---

### Task 1: Schema

**Files:**
- Create: `src/db/migrations/006_approval_consumption.sql`
- Test: `src/governance/consume.test.ts` (created here, grows in Task 2)

**Interfaces:**
- Consumes: nothing.
- Produces: columns `approval_requests.consumed_at`, `approval_requests.consumed_by_step`; tables `dashboard_users`, `dashboard_sessions`, `dashboard_recovery_codes`.

- [ ] **Step 1: Write the migration**

```sql
-- An approval a person granted is spendable exactly once.
--
-- Without `consumed_at`, a job that loops back to the same step spends one
-- approval repeatedly: a single "yes" on a purchase becomes several real
-- orders. The column is the whole of that defence, and the conditional UPDATE
-- in `consumeApproval` is what makes it race-free.
--
-- `consumed_by_step` is for the audit trail alone: it answers "which step
-- spent this?" when reading the chain back afterwards.
ALTER TABLE approval_requests
    ADD COLUMN consumed_at      TIMESTAMPTZ,
    ADD COLUMN consumed_by_step TEXT;

-- The dashboard's own account. Exactly one row per business in stage 0.
--
-- No self-registration and no emailed reset link: the mailbox is what the
-- assistant itself reads, so a mailbox compromise must not also hand over the
-- screen that authorises spending.
CREATE TABLE dashboard_users (
    business_id      TEXT        NOT NULL,
    username         TEXT        NOT NULL,
    password_hash    TEXT        NOT NULL,
    password_salt    TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at    TIMESTAMPTZ,
    failed_attempts  INTEGER     NOT NULL DEFAULT 0,
    locked_until     TIMESTAMPTZ,

    PRIMARY KEY (business_id, username)
);

CREATE TABLE dashboard_sessions (
    session_id   TEXT PRIMARY KEY,
    business_id  TEXT        NOT NULL,
    username     TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX dashboard_session_owner_idx
    ON dashboard_sessions (business_id, username)
 WHERE revoked_at IS NULL;

-- Single-use recovery codes. Hashed with a per-code salt exactly like a
-- password: the code itself is shown once at creation and is never stored,
-- so it cannot be read back out of the database by anyone.
CREATE TABLE dashboard_recovery_codes (
    code_id      TEXT PRIMARY KEY,
    business_id  TEXT        NOT NULL,
    username     TEXT        NOT NULL,
    code_hash    TEXT        NOT NULL,
    code_salt    TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_at      TIMESTAMPTZ
);

CREATE INDEX dashboard_recovery_unused_idx
    ON dashboard_recovery_codes (business_id, username)
 WHERE used_at IS NULL;
```

- [ ] **Step 2: Apply to both databases**

Run: `npm run migrate && npm run migrate:test`
Expected: both report migration 006 applied.

- [ ] **Step 3: Write a test that the columns exist and default correctly**

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

describe('the consumption columns', () => {
  it('start null, so an existing approval reads as unspent', async () => {
    const { rows } = await getPool().query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'approval_requests'
          AND column_name IN ('consumed_at', 'consumed_by_step')
        ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['consumed_at', 'consumed_by_step']);
    expect(rows.every((r) => r.column_default === null)).toBe(true);
  });
});
```

- [ ] **Step 4: Run it**

Run: `npx vitest run src/governance/consume.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/006_approval_consumption.sql src/governance/consume.test.ts
git commit -m "Schema: an approval is spendable once, and the dashboard has an account"
```

---

### Task 2: Spending an approval

**Files:**
- Create: `src/governance/consume.ts`
- Modify: `src/governance/consume.test.ts`

**Interfaces:**
- Consumes: `getApproval`, `ApprovalRequest` from `src/governance/approvals.js`; `canonicalHash` from `src/util/canonical.js`.
- Produces:
  ```ts
  export type ConsumeCode =
    | 'unknown_approval' | 'wrong_job' | 'not_approved'
    | 'input_changed' | 'already_consumed';
  export type ConsumeOutcome = { ok: true } | { ok: false; code: ConsumeCode };
  export function consumeApproval(input: {
    approvalId: string; jobId: string; stepId: string;
    liveInputHash: string; businessId?: string; db?: Queryable;
  }): Promise<ConsumeOutcome>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/governance/consume.test.ts`. A helper builds an approved approval; each test then attacks one condition.

```ts
import { canonicalHash } from '../util/canonical.js';
import { decide, enqueueApproval } from './approvals.js';
import { consumeApproval } from './consume.js';

import type { ActionFacts } from '../domain/policy.js';
import type { RiskAssessment } from '../domain/risk.js';

const BUSINESS = 'test-business';
const INPUT = { to: 'dana@example.com', body: 'שלום' };

/**
 * Real `ActionFacts` and `RiskAssessment` values, never `as never`.
 *
 * A cast to `never` switches off exactly the checking that catches a drifted
 * fact shape — and a silently-empty fact field is a failure this codebase has
 * hit more than once. Build the objects; let the compiler read them.
 *
 * Fill every field the two schemas declare. Run `npm run typecheck` after
 * writing these helpers and before writing the tests: the compiler will name
 * anything missing.
 */
function factsFor(input: unknown): ActionFacts {
  return {
    toolName: 'mail.send',
    actionClass: 'email.initiate',
    provenance: 'boss',
    inputHash: canonicalHash(input),
    amountMinor: 0,
    amountDeclared: false,
    counterpartyId: null,
    counterpartyEmails: ['dana@example.com'],
    counterpartyPhones: [],
    counterpartyTags: [],
    infoClasses: [],
  };
}

/**
 * A real assessment from the real scorer.
 *
 * `RiskDimensions` is a closed shape of seven sub-objects; hand-writing one
 * would be forty lines of invented numbers that drift the moment the scorer
 * changes. Calling `assessRisk` costs one line and cannot drift.
 */
async function riskFor(input: unknown, bundle: PolicyBundle): Promise<RiskAssessment> {
  return assessRisk(factsFor(input), bundle);
}

async function pendingApproval(jobId: string, bundle: PolicyBundle, input: unknown = INPUT) {
  const approvalId = await enqueueApproval(
    {
      jobId,
      facts: factsFor(input),
      risk: await riskFor(input, bundle),
      proposedInput: input,
      summary: 'שליחת מייל',
    },
    { businessId: BUSINESS },
  );
  return approvalId;
}

async function approvedApproval(jobId: string, bundle: PolicyBundle, input: unknown = INPUT) {
  const approvalId = await pendingApproval(jobId, bundle, input);
  await decide(approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' },
    { businessId: BUSINESS });
  return approvalId;
}

describe('an approval is spent exactly once', () => {
  it('lets the step through when all four conditions hold', async () => {
    const approvalId = await approvedApproval('J-1', bundle);
    const out = await consumeApproval({
      approvalId, jobId: 'J-1', stepId: 's1',
      liveInputHash: canonicalHash(INPUT), businessId: BUSINESS,
    });
    expect(out).toEqual({ ok: true });
  });

  it('refuses the same approval a second time', async () => {
    const approvalId = await approvedApproval('J-1', bundle);
    const args = {
      approvalId, jobId: 'J-1', stepId: 's1',
      liveInputHash: canonicalHash(INPUT), businessId: BUSINESS,
    };
    expect(await consumeApproval(args)).toEqual({ ok: true });
    expect(await consumeApproval({ ...args, stepId: 's2' })).toEqual({
      ok: false, code: 'already_consumed',
    });
  });

  it('refuses when the input changed after the approval', async () => {
    const approvalId = await approvedApproval('J-1', bundle);
    const out = await consumeApproval({
      approvalId, jobId: 'J-1', stepId: 's1',
      liveInputHash: canonicalHash({ ...INPUT, body: 'משהו אחר' }),
      businessId: BUSINESS,
    });
    expect(out).toEqual({ ok: false, code: 'input_changed' });
  });

  it('refuses an approval that belongs to another job', async () => {
    const approvalId = await approvedApproval('J-1', bundle);
    const out = await consumeApproval({
      approvalId, jobId: 'J-2', stepId: 's1',
      liveInputHash: canonicalHash(INPUT), businessId: BUSINESS,
    });
    expect(out).toEqual({ ok: false, code: 'wrong_job' });
  });

  it('refuses an approval nobody decided yet', async () => {
    const approvalId = await pendingApproval('J-1', bundle);
    const out = await consumeApproval({
      approvalId, jobId: 'J-1', stepId: 's1',
      liveInputHash: canonicalHash(INPUT), businessId: BUSINESS,
    });
    expect(out).toEqual({ ok: false, code: 'not_approved' });
  });

  it('refuses an approval id that does not exist', async () => {
    const out = await consumeApproval({
      approvalId: 'A-nope', jobId: 'J-1', stepId: 's1',
      liveInputHash: canonicalHash(INPUT), businessId: BUSINESS,
    });
    expect(out).toEqual({ ok: false, code: 'unknown_approval' });
  });

  it('lets exactly one of two concurrent attempts through', async () => {
    const approvalId = await approvedApproval('J-1', bundle);
    const args = {
      approvalId, jobId: 'J-1', stepId: 's1',
      liveInputHash: canonicalHash(INPUT), businessId: BUSINESS,
    };
    const [a, b] = await Promise.all([
      consumeApproval(args),
      consumeApproval({ ...args, stepId: 's2' }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/governance/consume.test.ts`
Expected: FAIL — `Cannot find module './consume.js'`.

- [ ] **Step 3: Implement**

```ts
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';

/**
 * Why an approval could not be spent. Diagnostic only — every one of these is
 * the same outcome for the caller, which is that the normal path runs and a
 * fresh request is queued.
 */
export type ConsumeCode =
  | 'unknown_approval'
  | 'wrong_job'
  | 'not_approved'
  | 'input_changed'
  | 'already_consumed';

export type ConsumeOutcome = { ok: true } | { ok: false; code: ConsumeCode };

export interface ConsumeInput {
  approvalId: string;
  jobId: string;
  /** The step spending it. Recorded so the chain can be read back. */
  stepId: string;
  /** Hash of the input that is about to run, not of what was proposed. */
  liveInputHash: string;
  businessId?: string;
  db?: Queryable;
}

/**
 * Spend an approval a human already granted.
 *
 * The claim is ONE conditional UPDATE, and that is the entire race defence:
 * `consumed_at IS NULL` in the predicate means two runners racing on the same
 * approval produce exactly one winner, whatever the interleaving. A read
 * followed by a write would let both read null and both proceed, which for a
 * purchase means two real orders.
 *
 * The failure reason is derived by a SECOND query, deliberately outside that
 * atomicity. It is only ever used to explain the refusal in the audit trail —
 * the decision itself was already made by the UPDATE claiming nothing.
 *
 * Note what this does NOT re-check: the budget. Ceilings are step 9 of the
 * gate and have already run by the time step 10 reaches an approval, so a
 * spent approval cannot carry an action past a ceiling.
 */
export async function consumeApproval(input: ConsumeInput): Promise<ConsumeOutcome> {
  const businessId = input.businessId ?? config.businessId;
  const db = input.db ?? getPool();

  const claimed = await db.query<{ approval_id: string }>(
    `UPDATE approval_requests
        SET consumed_at = now(), consumed_by_step = $4
      WHERE approval_id = $1
        AND business_id = $2
        AND job_id = $3
        AND state IN ('approved', 'approved_with_edit')
        AND consumed_at IS NULL
        AND input_hash_at_decision = $5
      RETURNING approval_id`,
    [input.approvalId, businessId, input.jobId, input.stepId, input.liveInputHash],
  );

  if (claimed.rows[0]) return { ok: true };

  const { rows } = await db.query<{
    job_id: string | null;
    state: string;
    consumed_at: Date | null;
    input_hash_at_decision: string | null;
  }>(
    `SELECT job_id, state, consumed_at, input_hash_at_decision
       FROM approval_requests WHERE approval_id = $1 AND business_id = $2`,
    [input.approvalId, businessId],
  );

  const row = rows[0];
  if (!row) return { ok: false, code: 'unknown_approval' };
  if (row.job_id !== input.jobId) return { ok: false, code: 'wrong_job' };
  if (row.state !== 'approved' && row.state !== 'approved_with_edit') {
    return { ok: false, code: 'not_approved' };
  }
  if (row.consumed_at !== null) return { ok: false, code: 'already_consumed' };
  return { ok: false, code: 'input_changed' };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/governance/consume.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Bite-check the single-use guard**

Remove `AND consumed_at IS NULL` from the UPDATE predicate.
Run: `npx vitest run src/governance/consume.test.ts`
Expected: FAIL — "refuses the same approval a second time" and the concurrency test.
Restore the line, re-run, confirm green.

- [ ] **Step 6: Bite-check the TOCTOU guard**

Remove `AND input_hash_at_decision = $5`.
Expected: FAIL — "refuses when the input changed after the approval".
Restore, re-run, confirm green.

- [ ] **Step 7: Commit**

```bash
git add src/governance/consume.ts src/governance/consume.test.ts
git commit -m "An approval a person gave is spendable, once, for the input they saw"
```

---

### Task 3: The gate spends it

**Files:**
- Modify: `src/policy/engine.ts` (add `approvalId` to `GateContext`; consumption branch before `needsApproval`)
- Test: `src/policy/approval-consumption.test.ts`

**Interfaces:**
- Consumes: `consumeApproval`, `ConsumeOutcome` from Task 2.
- Produces: `GateContext.approvalId?: string`.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { decide } from '../governance/approvals.js';
import { evaluateToolCall } from './engine.js';

const BUSINESS = 'test-business';

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

/** A call that the gate queues: first contact, and provenance is not the boss. */
const CALL = {
  toolName: 'mail.send',
  input: { to: 'stranger@example.com', body: 'שלום' },
  ctx: {
    agent: 'comms.email' as const,
    jobId: 'J-1',
    stepId: 's1',
    provenance: 'unknown_external' as const,
    // `FactsContext` requires it: zero is a call with no delegation chain.
    chainDepth: 0,
    counterpartyTags: [] as string[],
    rampLevel: 'auto' as const,
    businessId: BUSINESS,
  },
};

describe('an approval already granted is honoured, not recomputed', () => {
  it('runs the step instead of queueing a second request', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    const first = await evaluateToolCall(CALL.toolName, CALL.input, { ...CALL.ctx, bundle });
    expect(first.outcome).toBe('queue_approval');
    if (first.outcome !== 'queue_approval') throw new Error('unreachable');

    await decide(first.approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS });

    const second = await evaluateToolCall(CALL.toolName, CALL.input, {
      ...CALL.ctx, bundle, approvalId: first.approvalId,
    });
    expect(second.outcome).toBe('allow');
  });

  it('queues a fresh request when the same approval is offered twice', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const first = await evaluateToolCall(CALL.toolName, CALL.input, { ...CALL.ctx, bundle });
    if (first.outcome !== 'queue_approval') throw new Error('unreachable');
    await decide(first.approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS });

    const ctx = { ...CALL.ctx, bundle, approvalId: first.approvalId };
    expect((await evaluateToolCall(CALL.toolName, CALL.input, ctx)).outcome).toBe('allow');

    const third = await evaluateToolCall(CALL.toolName, CALL.input, ctx);
    expect(third.outcome).toBe('queue_approval');
    if (third.outcome !== 'queue_approval') throw new Error('unreachable');
    expect(third.approvalId).not.toBe(first.approvalId);
  });

  it('queues a fresh request when the input changed after the approval', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const first = await evaluateToolCall(CALL.toolName, CALL.input, { ...CALL.ctx, bundle });
    if (first.outcome !== 'queue_approval') throw new Error('unreachable');
    await decide(first.approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS });

    const changed = await evaluateToolCall(
      CALL.toolName,
      { ...CALL.input, body: 'נוסח אחר לגמרי' },
      { ...CALL.ctx, bundle, approvalId: first.approvalId },
    );
    expect(changed.outcome).toBe('queue_approval');
  });

  it('does not let an approval carry an action past a denial', async () => {
    // The fixture cannot express a charter `forbidden` rule, so the denial
    // under test is the autonomy one at gate step 8. Either way the point is
    // the same: consumption is step 10, and every denial before it stands.
    const bundle = await installCharter(
      buildCharter({ autonomyBase: { 'email.initiate': 'forbidden' } }),
      { businessId: BUSINESS },
    );
    const denied = await evaluateToolCall(CALL.toolName, CALL.input, {
      ...CALL.ctx, bundle, approvalId: 'A-anything',
    });
    expect(denied.outcome).toBe('deny');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/policy/approval-consumption.test.ts`
Expected: FAIL — `approvalId` is not a known property of `GateContext`, and the second call queues rather than allows.

- [ ] **Step 3: Add the field to `GateContext`**

In `src/policy/engine.ts`, inside `interface GateContext`:

```ts
  /**
   * An approval a human already granted for THIS step.
   *
   * Supplied by the executor when it resumes a job that was parked on an
   * approval. Without it the gate recomputes `needsApproval` and queues a
   * second request, and the step never runs however many times it is approved.
   */
  approvalId?: string;
  /**
   * The step spending `approvalId`. The two travel together and neither is
   * useful alone: the gate sees one tool call and has no step of its own, and
   * `consumed_by_step` exists so the chain can be read back afterwards.
   */
  stepId?: string;
```

- [ ] **Step 4: Add the consumption branch**

In `evaluateToolCall`, between the `risk.band === 'blocked'` check and `const needsApproval`:

```ts
  // An approval a person already granted is spent here, before the gate asks
  // for another one. Placed after the `blocked` check on purpose: an approval
  // is permission to do something questionable, never permission to do
  // something the charter forbids outright.
  if (ctx.approvalId !== undefined) {
    const spent = await consumeApproval({
      approvalId: ctx.approvalId,
      // An approval always belongs to a job. A context carrying an approval
      // id and no job id cannot match any row, so it falls through and queues
      // a fresh request — which is the safe direction for a malformed call.
      jobId: ctx.jobId ?? '',
      stepId: ctx.stepId ?? '',
      liveInputHash: facts.inputHash,
      businessId,
      ...(ctx.db ? { db: ctx.db } : {}),
    });

    if (spent.ok) {
      await appendAudit(
        {
          actor: ctx.agent,
          kind: 'approval',
          jobId: ctx.jobId ?? null,
          envelopeId: ctx.envelopeId ?? null,
          actionClass: facts.actionClass,
          charterVersion: currentVersion,
          provenance: facts.provenance,
          inputHash: facts.inputHash,
          risk,
          reason: `approval_consumed:${ctx.approvalId} (intent seq ${intent.seq})`,
        },
        { businessId, ...(ctx.db ? { tx: ctx.db } : {}) },
      );

      return {
        outcome: 'allow',
        effectiveAutonomy: effective,
        redactedInput: redactPayload(toolInput, ctx.bundle),
      };
    }
    // Every failure code falls through to the normal path, which queues a
    // fresh request. That is the correct answer to all of them: the human
    // approved something, and it was not this.
  }
```

Add the import at the top: `import { consumeApproval } from '../governance/consume.js';`

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/policy/approval-consumption.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Bite-check the placement**

Make the autonomy denial defer to the approval — the mistake a reader is most likely to make here, reasoning "they approved it, so let it through":

```ts
  if (effective === 'forbidden' && ctx.approvalId === undefined) {
```

Expected: FAIL — "does not let an approval carry an action past a denial".
Restore the condition to `effective === 'forbidden'`, re-run, confirm green.

(The branch cannot simply be moved earlier to test this: it reads `effective` and `risk`, which steps 8 and 10 compute, so an earlier position does not compile. The position is enforced by that data dependency; this mutation covers the failure the dependency does not.)

- [ ] **Step 7: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: everything green; no existing test changes meaning.

- [ ] **Step 8: Commit**

```bash
git add src/policy/engine.ts src/policy/approval-consumption.test.ts
git commit -m "The gate spends an approval instead of asking for it again"
```

---

### Task 4: The executor supplies it, and runs what was approved

**Files:**
- Modify: `src/orchestrator/execute.ts` (`StepRequest.approvalId`, edited-input substitution)
- Test: `src/orchestrator/approved-step.test.ts`

**Interfaces:**
- Consumes: `GateContext.approvalId` from Task 3; `getApproval` from `src/governance/approvals.js`.
- Produces: `StepRequest.approvalId?: string`.

- [ ] **Step 1: Write the failing test**

Reuse the fixtures from `src/orchestrator/scheduler.test.ts` verbatim — `NOTHING`, `BUSINESS`, `NOON`, `install`, `jobInExecute` — then:

```ts
import { applyDecision } from './resume.js';
import { loadJob } from './jobs.js';
import { executeStep } from './execute.js';

/** A first contact from an untrusted origin: the gate queues this. */
const STRANGER = {
  stepId: 'step-1',
  agent: 'comms.email' as const,
  toolName: 'mail.send',
  toolInput: { to: 'stranger@example.com', body: 'נוסח מקורי' },
  counterpartyTags: [] as string[],
  rampLevel: 'auto' as const,
  provenance: 'unknown_external' as const,
};

async function parkOnApproval(bundle: PolicyBundle, job: Job) {
  const queued = await executeStep({
    ...STRANGER, job, bundle, perform: async () => NOTHING, now: NOON,
  });
  if (queued.status !== 'awaiting_approval') {
    throw new Error(`expected awaiting_approval, got ${queued.status}`);
  }
  return queued.approvalId;
}

describe('a step resumed from an approval', () => {
  it('runs, and performs exactly once', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const approvalId = await parkOnApproval(bundle, job);

    await applyDecision(approvalId, 'approved',
      { by: 'p_boss', channel: 'dashboard' }, { businessId: BUSINESS });

    const resumed = await loadJob(job.jobId, { businessId: BUSINESS });
    if (resumed === null) throw new Error('job vanished');

    let performed = 0;
    const outcome = await executeStep({
      ...STRANGER, job: resumed, bundle, approvalId,
      perform: async () => { performed += 1; return NOTHING; }, now: NOON,
    });

    expect(outcome.status).toBe('done');
    expect(performed).toBe(1);
  });

  it('does not queue a second request for the same step', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const approvalId = await parkOnApproval(bundle, job);
    await applyDecision(approvalId, 'approved',
      { by: 'p_boss', channel: 'dashboard' }, { businessId: BUSINESS });

    const resumed = await loadJob(job.jobId, { businessId: BUSINESS });
    if (resumed === null) throw new Error('job vanished');
    const outcome = await executeStep({
      ...STRANGER, job: resumed, bundle, approvalId,
      perform: async () => NOTHING, now: NOON,
    });

    expect(outcome.status).not.toBe('awaiting_approval');
  });

  it('runs the EDITED input when the boss changed it', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const approvalId = await parkOnApproval(bundle, job);

    await applyDecision(approvalId, 'approved',
      {
        by: 'p_boss',
        channel: 'dashboard',
        editedInput: { ...STRANGER.toolInput, body: 'נוסח ערוך' },
      },
      { businessId: BUSINESS });

    const resumed = await loadJob(job.jobId, { businessId: BUSINESS });
    if (resumed === null) throw new Error('job vanished');

    const seen: unknown[] = [];
    await executeStep({
      ...STRANGER, job: resumed, bundle, approvalId,
      perform: async (input) => { seen.push(input); return NOTHING; }, now: NOON,
    });

    expect(seen).toHaveLength(1);
    expect((seen[0] as { body: string }).body).toBe('נוסח ערוך');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/orchestrator/approved-step.test.ts`
Expected: FAIL — the step queues a second approval; the edited body never reaches `perform`.

- [ ] **Step 3: Add the field and the substitution**

In `StepRequest`:

```ts
  /**
   * The approval this step is resuming under, when it is resuming under one.
   *
   * The executor, not the gate, is what knows a run came back from a human
   * decision — the gate sees one tool call and has no memory of the job's
   * history.
   */
  approvalId?: string;
```

At the top of `executeStep`, before facts are built:

```ts
  // What runs is what was approved. On an approval-with-edit the boss changed
  // the action on the card, `decide` re-bound the approval's hash to that
  // edited input, and running the original would both do the wrong thing and
  // fail the gate's hash check — which is exactly how this was found.
  let effectiveInput = request.toolInput;
  if (request.approvalId !== undefined) {
    const approval = await getApproval(request.approvalId, { businessId: job.businessId });
    if (approval?.state === 'approved_with_edit' && approval.editedInput !== null) {
      effectiveInput = approval.editedInput as Record<string, unknown>;
    }
  }
```

Then use `effectiveInput` everywhere `request.toolInput` was used, and pass both fields into the gate context — `exactOptionalPropertyTypes` forces the conditional spread:

```ts
    ...(request.approvalId !== undefined
      ? { approvalId: request.approvalId, stepId: request.stepId }
      : {}),
```

`stepId` travels with `approvalId` and never alone: it exists so `consumed_by_step` names the step that spent the approval.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/orchestrator/approved-step.test.ts`
Expected: PASS.

- [ ] **Step 5: Bite-check the substitution**

Change `effectiveInput = approval.editedInput` back to `request.toolInput`.
Expected: FAIL — "runs the EDITED input when the boss changed it".
Restore, re-run, confirm green.

- [ ] **Step 6: Update the stale docblock**

`executeStep`'s docblock currently states that `awaiting_approval` is not a bookmark and that spending an approval is "work the gate has not been taught yet". That is no longer true. Replace those two paragraphs with what the code now does, including the fact that a spent approval is spent even if the step then fails — the retry queues a fresh request rather than reusing it.

- [ ] **Step 7: Full suite and commit**

```bash
npm run typecheck && npm test
git add src/orchestrator/execute.ts src/orchestrator/approved-step.test.ts
git commit -m "Resume under an approval, and run the input the boss actually approved"
```

---

### Task 5: The boss's own instruction is the approval

**Files:**
- Modify: `src/policy/risk.ts` (`FIRST_CONTACT_EXEMPT`, `bandFor`)
- Test: `src/policy/first-contact.test.ts`

**Interfaces:**
- Consumes: `TrustLevel` from `src/domain/trust.js`.
- Produces: no exported surface; behaviour change in `assessRisk`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { TrustLevel } from '../domain/trust.js';
import { assessRisk } from './risk.js';

/** Facts for a first contact: an address nothing in the charter resolves. */
function firstContact(provenance: TrustLevel): ActionFacts {
  return {
    toolName: 'mail.send',
    actionClass: 'email.initiate' as const,
    provenance,
    inputHash: 'h',
    amountMinor: 0,
    amountDeclared: false,
    counterpartyId: null,
    counterpartyEmails: ['stranger@example.com'],
    counterpartyPhones: [],
    counterpartyTags: [],
    infoClasses: [],
  };
}

describe('first contact escalates unless the boss named the counterparty', () => {
  it('does not escalate when the boss is the origin of the chain', async () => {
    const risk = await assessRisk(firstContact('boss'), BUNDLE);
    expect(risk.band).toBe('routine');
  });

  it('escalates when the chain passed through an inbound email', async () => {
    const risk = await assessRisk(firstContact('unknown_external'), BUNDLE);
    expect(risk.band).toBe('sensitive');
  });

  it('escalates for staff, which is not on the exempt list', async () => {
    const risk = await assessRisk(firstContact('staff'), BUNDLE);
    expect(risk.band).toBe('sensitive');
  });

  it('still escalates a boss-origin first contact that carries money', async () => {
    const facts = { ...firstContact('boss'), amountMinor: 500_00, amountDeclared: true };
    const risk = await assessRisk(facts, BUNDLE);
    expect(risk.band).not.toBe('routine');
  });
});
```

`BUNDLE` is `(await installCharter(buildCharter(), { businessId: BUSINESS }))`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/policy/first-contact.test.ts`
Expected: FAIL — the boss case returns `sensitive`.

- [ ] **Step 3: Implement**

Above `bandFor` in `src/policy/risk.ts`:

```ts
/**
 * Origins whose instruction IS the approval, so a first contact from them does
 * not escalate.
 *
 * A positive list, not "anything that is not untrusted": a TrustLevel added to
 * the enum later stays inside the escalation until someone decides otherwise
 * in this file, which is the safe direction to be wrong in.
 *
 * `provenance` is the LEAST trusted link in the causal chain, not whoever
 * spoke first — which is what makes this narrow. "Send a quote to
 * dana@newcompany.co.il" carries `boss` and goes. "Read this email and reply
 * to the sender" carries the inbound email's level and still escalates: the
 * boss gave a generic instruction and someone else chose the address.
 */
const FIRST_CONTACT_EXEMPT: ReadonlySet<TrustLevel> = new Set<TrustLevel>(['boss']);
```

In `bandFor`, replace the first-contact line:

```ts
  // First contact with a party we cannot resolve is the classic sensitive
  // case — unless the instruction came from the boss, in which case naming
  // the counterparty WAS the approval.
  if (
    dimensions.externalVisibility.audience === 'one_unknown' &&
    !FIRST_CONTACT_EXEMPT.has(facts.provenance)
  ) {
    return 'sensitive';
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/policy/first-contact.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Bite-check the positive form**

Change the set to `new Set(['boss', 'staff', 'known_counterparty'])`.
Expected: FAIL — "escalates for staff, which is not on the exempt list".
Restore, re-run, confirm green.

- [ ] **Step 6: Update `explain`**

`explain` in the same file writes the human-readable reason and has a branch for `one_unknown`. It must not tell the owner that a boss-origin action was escalated for first contact when it was not. Adjust the branch to use the same condition.

- [ ] **Step 7: Full suite and commit**

```bash
npm run typecheck && npm test
git add src/policy/risk.ts src/policy/first-contact.test.ts
git commit -m "A counterparty the boss named is not a stranger the gate must ask about"
```

---

### Task 6: Passwords, sessions and lockout

**Files:**
- Create: `src/dashboard/auth.ts`
- Test: `src/dashboard/auth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function hashPassword(plain: string): Promise<{ hash: string; salt: string }>;
  export function verifyPassword(plain: string, hash: string, salt: string): Promise<boolean>;
  export function createOwner(input: { username: string; password: string; businessId?: string }): Promise<void>;
  export function login(input: { username: string; password: string; businessId?: string; now?: Date }):
    Promise<{ ok: true; sessionId: string } | { ok: false; code: 'bad_credentials' | 'locked' }>;
  export function verifySession(sessionId: string, options?: { businessId?: string; now?: Date }):
    Promise<{ username: string } | null>;
  export function revokeAllSessions(username: string, options?: { businessId?: string }): Promise<number>;
  export function setPassword(input: { username: string; password: string; businessId?: string }): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

Cover: correct password logs in · wrong password does not · five wrong attempts lock · a locked account refuses even the correct password · lock expires · a session verifies · a revoked session does not · an expired session does not · `setPassword` revokes every open session · the same password hashes differently for two accounts (per-user salt).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/dashboard/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { getPool, withTransaction } from '../db/pool.js';

const scrypt = promisify(scryptCb) as (
  password: string, salt: string, keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const SESSION_HOURS = 12;

export async function hashPassword(plain: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(plain, salt, KEY_LENGTH);
  return { hash: derived.toString('hex'), salt };
}

/**
 * Compared in constant time. A plain `===` on hex strings leaks how many
 * leading characters matched through timing, which is enough to recover a
 * hash byte by byte given enough attempts.
 */
export async function verifyPassword(plain: string, hash: string, salt: string) {
  const derived = await scrypt(plain, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}
```

Then `createOwner`, `login` (increment `failed_attempts`, set `locked_until` at the threshold, reset both on success), `verifySession`, `revokeAllSessions`, and `setPassword` (hash, write, revoke all sessions, in one transaction).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/dashboard/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Bite-check the lockout**

Remove the `locked_until` check from `login`.
Expected: FAIL — "a locked account refuses even the correct password".
Restore, re-run, confirm green.

- [ ] **Step 6: Bite-check the session revocation on password change**

Remove the revoke call from `setPassword`.
Expected: FAIL — "setPassword revokes every open session".
Restore, re-run, confirm green.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/auth.ts src/dashboard/auth.test.ts
git commit -m "The dashboard has one account, hashed, rate-limited and session-bound"
```

---

### Task 7: Recovery codes

**Files:**
- Create: `src/dashboard/recovery.ts`
- Test: `src/dashboard/recovery.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword`, `revokeAllSessions`, `setPassword` from Task 6.
- Produces:
  ```ts
  export function issueRecoveryCodes(input: { username: string; businessId?: string; count?: number }): Promise<string[]>;
  export function redeemRecoveryCode(input: { username: string; code: string; businessId?: string }):
    Promise<{ ok: true } | { ok: false; code: 'no_match' | 'already_used' }>;
  export function remainingCodes(username: string, options?: { businessId?: string }): Promise<number>;
  ```

- [ ] **Step 1: Write the failing tests**

Cover: eight codes are issued and returned once · a valid code redeems · the same code refuses the second time · two concurrent redemptions of one code let exactly one through · redeeming revokes all sessions · redeeming is audited · re-issuing voids every older code · `remainingCodes` counts only unused ones · a code that was never issued refuses · codes are not stored in plaintext (assert the column holds neither the code nor a prefix of it).

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Eight single-use codes, shown once and never stored.
 *
 * 128 bits from a cryptographic source, not `Math.random`, which is seeded
 * predictably and is not a security primitive in any runtime.
 */
export async function issueRecoveryCodes(input: {
  username: string; businessId?: string; count?: number;
}): Promise<string[]> {
  // Re-issuing voids every older code first: two valid sets in circulation
  // means a code the owner believes they burned is still live.
  // DELETE existing rows, then insert `count` fresh ones, in one transaction.
}
```

Redemption tries each unused code's hash in turn — eight `scrypt` calls, and the deliberate slowness makes guessing more expensive rather than less. The claim is `UPDATE ... WHERE code_id = $1 AND used_at IS NULL RETURNING code_id`, so two concurrent redemptions cannot both spend one code. On success: revoke every session, append an audit entry of kind `incident` naming the source address, and return.

- [ ] **Step 4: Run to verify they pass**

Expected: PASS.

- [ ] **Step 5: Bite-check single use**

Remove `AND used_at IS NULL` from the claim.
Expected: FAIL — "the same code refuses the second time" and the concurrency test.
Restore, re-run, confirm green.

- [ ] **Step 6: Bite-check re-issue voiding**

Remove the DELETE from `issueRecoveryCodes`.
Expected: FAIL — "re-issuing voids every older code".
Restore, re-run, confirm green.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/recovery.ts src/dashboard/recovery.test.ts
git commit -m "Recovery codes: single-use, hashed, and they void the old set"
```

---

### Task 8: The two local commands

**Files:**
- Create: `src/cli/create-owner.ts`, `src/cli/owner-password.ts`
- Modify: `package.json` (`owner:create`, `owner:password`)
- Test: `src/cli/cli.test.ts`

**Interfaces:**
- Consumes: `createOwner`, `setPassword` (Task 6); `issueRecoveryCodes` (Task 7).
- Produces: two npm scripts.

- [ ] **Step 1: Write the failing test**

The tests call the exported `run(argv, io)` functions directly rather than spawning a process, with `io` supplying a fake prompt. Cover: a password passed as an argument is refused with a message naming shell history as the reason · the prompt path creates the account · creation prints eight codes · `owner:password` changes the password and revokes sessions.

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Each file exports `run(argv: string[], io: PromptIo): Promise<number>` and has a thin `main` guard. The refusal:

```ts
if (argv.some((a) => a.startsWith('--password'))) {
  io.error('סיסמה אינה מתקבלת כפרמטר — היא נשמרת בהיסטוריית הפקודות וגלויה לתהליכים אחרים. הרץ שוב בלי הדגל.');
  return 2;
}
```

- [ ] **Step 4: Run to verify it passes**

Expected: PASS.

- [ ] **Step 5: Bite-check the argument refusal**

Delete the guard.
Expected: FAIL — "a password passed as an argument is refused".
Restore, re-run, confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/cli package.json src/cli/cli.test.ts
git commit -m "Two local commands: create the owner, and reset the password"
```

---

### Task 9: The screen

**Files:**
- Create: `src/dashboard/server.ts`, `src/dashboard/views.ts`, `src/dashboard/csrf.ts`, `src/dashboard/run-dashboard.ts`
- Modify: `package.json` (`dashboard`)
- Test: `src/dashboard/server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6–7; `pendingApprovals`, `getApproval` from `src/governance/approvals.js`; `applyDecision` from `src/orchestrator/resume.js`.
- Produces: `createServer(options): http.Server` — injectable so tests bind port 0 rather than a fixed port.

Routes: `GET /login` · `POST /login` (password or recovery code) · `GET /` (pending list) · `GET /a/:id` (card) · `POST /a/:id/approve` · `POST /a/:id/deny` · `POST /logout`.

- [ ] **Step 1: Write the failing tests**

Each line below is one `it(...)`, with the assertion given. Bind the server to port 0 and read the assigned port, so tests never collide on a fixed one.

| Test name | Assertion |
|---|---|
| `redirects to login without a session` | `GET /` → status `302`, `location` is `/login` |
| `shows the pending list to a valid session` | body contains the approval's summary |
| `refuses an approve without a CSRF token` | `POST /a/:id/approve` → status `403`, and the approval is still `pending` |
| `approves with a valid token` | job phase becomes `execute`, approval state `approved` |
| `denies with a valid token` | job phase becomes `closed`, approval state `denied` |
| `hides another business's approval` | `GET /a/:id` → `404`, not `403` — existence is itself information |
| `refuses to decide another business's approval` | `POST` → `404`, approval still `pending` |
| `locks the session cookie down` | `set-cookie` contains `HttpOnly`, `Secure`, `SameSite=Strict` |
| `forces a password change after a recovery-code login` | `GET /` → `302` to `/password` until a new password is set |
| `shows how many recovery codes remain` | the logged-in page contains the count from `remainingCodes` |
| `escapes HTML in the proposed input` | an input containing `<script>alert(1)</script>` renders as `&lt;script&gt;`, and the raw string appears nowhere in the body |
| `expires a session past its lifetime` | a session dated beyond its expiry → `302` to `/login` |

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`node:http` only. `views.ts` renders server-side strings with an `escapeHtml` helper applied to every interpolated value — approval payloads are attacker-influenced content and this is where they reach a browser. `csrf.ts` issues a token bound to the session and verifies it on every `POST`.

- [ ] **Step 4: Run to verify they pass**

Expected: PASS.

- [ ] **Step 5: Bite-check CSRF**

Remove the token check from the approve route.
Expected: FAIL — "POST approve without a CSRF token is refused".
Restore, re-run, confirm green.

- [ ] **Step 6: Bite-check escaping**

Replace `escapeHtml(value)` with `value` in the card view.
Expected: FAIL — the `<script>` test.
Restore, re-run, confirm green.

- [ ] **Step 7: Bite-check business isolation**

Remove `business_id` from the pending-list query.
Expected: FAIL — "an approval belonging to another business is not visible".
Restore, re-run, confirm green.

- [ ] **Step 8: Write the exposure note**

Create `docs/dashboard-deployment.md`. The server **does not terminate TLS** and must never be bound to a public interface directly. It listens on the loopback address, and the installation is reached from the internet through a tunnel or reverse proxy that terminates TLS in front of it. State this as a requirement, not a suggestion: a `Secure` cookie over plain HTTP is silently never sent, so a misdeployment does not fail loudly — it just stops authenticating.

- [ ] **Step 9: Full suite and commit**

```bash
npm run typecheck && npm test
git add src/dashboard package.json docs/dashboard-deployment.md
git commit -m "A screen that shows what is waiting and writes what you decided"
```

---

### Task 10: Mail transport and the notifier

**Files:**
- Create: `src/mail/transport.ts`, `src/governance/notify.ts`
- Modify: `src/policy/engine.ts` (fire the notifier after `enqueueApproval`), `package.json` (`nodemailer`)
- Test: `src/governance/notify.test.ts`

**Interfaces:**
- Consumes: `MailTransport` from `src/orchestrator/adapters/mail.js`; `ApprovalRequest` from `src/governance/approvals.js`.
- Produces:
  ```ts
  export interface ApprovalNotifier { readonly channel: 'email';
    notify(request: ApprovalRequest, link: string): Promise<{ ok: boolean; error?: string }>; }
  export function createEmailNotifier(transport: MailTransport, to: string): ApprovalNotifier;
  export function createSmtpTransport(config: SmtpConfig): MailTransport;
  ```

- [ ] **Step 1: Write the failing tests**

Cover: the notifier is called with the new approval's id and a link containing it · **a notifier that throws does not fail `enqueueApproval`** — the request still exists and is still pending · the subject and body carry no secret beyond the summary · CRLF in any header field is rejected (the `MailTransport` contract already requires this).

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`createSmtpTransport` wraps `nodemailer` behind the existing `MailTransport` interface — the single new dependency, isolated to one file, so a swap later touches nothing else. The notifier call site is wrapped:

```ts
  // Delivery failing is not the request failing. The row exists, the screen
  // shows it, and the scheduler will expire it on schedule either way. An
  // approval that vanished because an SMTP server was down would be far worse
  // than one nobody was emailed about.
  try {
    const delivered = await notifier.notify(request, approvalLink(approvalId));
    if (!delivered.ok) throw new Error(delivered.error ?? 'notify returned not-ok');
  } catch (error) {
    await appendAudit(
      {
        actor: 'system',
        kind: 'incident',
        jobId: request.jobId,
        actionClass: request.actionClass,
        charterVersion: currentVersion,
        provenance: facts.provenance,
        inputHash: request.inputHash,
        reason:
          `approval_notify_failed:${approvalId} via ${notifier.channel} — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      },
      { businessId, ...(ctx.db ? { tx: ctx.db } : {}) },
    );
  }
```

- [ ] **Step 4: Run to verify they pass**

Expected: PASS.

- [ ] **Step 5: Bite-check the isolation**

Remove the `try`/`catch`.
Expected: FAIL — "a notifier that throws does not fail enqueueApproval".
Restore, re-run, confirm green.

- [ ] **Step 6: Full suite, audit, and commit**

```bash
npm run typecheck && npm test && npm audit --audit-level=high
git add src/mail src/governance/notify.ts src/policy/engine.ts package.json package-lock.json
git commit -m "Tell the owner a request is waiting, without making delivery load-bearing"
```

---

### Task 11: Documentation and the closing check

**Files:**
- Modify: `CLAUDE.md`, `docs/05-approvals.md`, `docs/09-roadmap.md`

- [ ] **Step 1: Correct the stale claim in `CLAUDE.md`**

The section "אישור הוא ההשהיה היחידה שעדיין לא נסגרת" is now false. Replace it with what the loop does, and state the two rules a reader would otherwise reverse: an approval is spent once and a failed step queues a fresh one rather than reusing it; the first-contact exemption is a positive list keyed on the chain's least-trusted link.

- [ ] **Step 2: Record the risk taken knowingly**

In `docs/05-approvals.md`: with novelty scoring returning zero until the norms engine lands in stage 2, a boss-initiated first contact now passes with no risk dimension stopping it, and the autonomy ramp is the only remaining brake.

- [ ] **Step 3: Mark the exit condition met in `docs/09-roadmap.md`**

- [ ] **Step 4: Run the full closing check**

```bash
npm run typecheck && npm test && npm audit --audit-level=high
```

Then `/security-review` — this work touched `policy/engine.ts`, `policy/risk.ts` and a migration, all three of which require it under CLAUDE.md.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "The approval loop closes; say so where the next reader will look"
```

---

## Dependency Order and the Natural Checkpoint

Tasks 1–5 are the gate and policy work. They close stage 0's third exit condition **at the level of logic** with no front end in existence, and they are worth reviewing as a unit before the dashboard begins.

Tasks 6–9 are the screen. Task 10 is delivery, and depends on nothing but Task 1.

**Task 10 needs SMTP credentials.** If none are available when the plan reaches it, do Tasks 1–9 and leave 10 last rather than blocking the sequence on an external account.
