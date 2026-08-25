# Live Thread: a Production Caller for the Run Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `runPlanForJob` a production caller, so one seeded job runs end to end — gate → approval queued → notification email → owner decides → scheduler wakes → engine resumes → mail actually sent — with every hop on the audit trail.

**Architecture:** Approach A, approved 2026-08-22. `tick()` is left exactly as it is: it wakes jobs and expires approvals inside a transaction-scoped advisory lock. A new `runDueJobs()` runs **after** that transaction has committed, takes a **session-scoped** advisory lock per job, and executes each job that sits in `execute` with a stored plan. The scheduler process calls both in sequence. A new `runtime.ts` is the single place that assembles what the engine needs (adapter registry, credentials, approval notifier); `ramp.ts` is the first reader the `autonomy_ramp` table has ever had.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` in every relative import), Postgres 17 via `pg`, zod, vitest against a real `assistant_test` database, nodemailer.

**Spec:** No separate spec document — the user approved the design in-chat on 2026-08-22 and asked to go straight to the plan. The Design section below **is** the spec; it is reproduced here so an executor reading only this file has the whole argument.

## Design (approved)

Five components, in dependency order:

| Component | Responsibility |
|---|---|
| `ramp.ts` | Read `autonomy_ramp`. Missing or unreadable row → `draft_only`. Also derives a whole plan's ceiling. |
| `plan-store.ts` (extend) | Return the stored plan **body**, not just its hash. The `plan JSONB` column has existed since migration 004 and nothing ever read it. |
| `execute.ts` / `run-plan.ts` (extend) | Thread an optional `notify` through to `GateContext`, so a queued approval actually emails the owner. |
| `runtime.ts` | Assemble registry + credentials + notifier from the environment. Returns warnings; never silently degrades. |
| `run-due.ts` | Find jobs ready to run, lock each, run it. Called by the scheduler process after `tick()`. |
| `cli/seed-job.ts` | Create a job, store a plan, raise the ramp for that one action class, and run it. |

## Global Constraints

Copied verbatim from `CLAUDE.md`; every task's requirements implicitly include these.

- **`.js` in every relative import**, including from `.ts` files. Required by `NodeNext` + `"type": "module"`.
- **`noUncheckedIndexedAccess`** — index access is `T | undefined`; DB code must write `rows[0]?.x`.
- **`exactOptionalPropertyTypes`** — an optional property may not be assigned `undefined`. Use conditional spread: `ctx.norms ? { norms: ctx.norms } : {}`.
- **`verbatimModuleSyntax`** — types are imported with `import type`, values with `import`. Never mixed.
- **DB row convention:** a private `interface XRow` plus a `toX(row)` function per module. SQL is `snake_case`, TypeScript is `camelCase`.
- **Hebrew for humans, English for code.** Rejection messages and docs in Hebrew; identifiers, comments and internal errors in English.
- **Positive controls only.** Never write a control as "everything that is not X". A value that could not be read is never a permissive value.
- **Tests need real Postgres.** `npm test` runs against `TEST_DATABASE_URL`; there is no mock and no in-memory database. `resetDatabase()` truncates between tests.
- **New table in `resetDatabase()`:** this plan adds no table, but any test that writes `autonomy_ramp` relies on it already being in the truncate list — it is (`src/test/db.ts`).
- **Money is integer minor units, always.**
- **`npm run typecheck` and `npm test` must both pass before any task is reported done.**
- **`/security-review` is required at the end** because Task 1 feeds an autonomy ceiling into `evaluateToolCall`.

### Canonical test setup — use these, not the inline setup in task bodies

**The inline test setup shown inside each task below was drafted from greps and carries known signature errors.** A pre-flight scan against the real code on 2026-08-22 found six. Where a task's test code sets up a charter, a job, or a binding, **replace that setup with the helpers here**, which are verified against `src/orchestrator/external.test.ts` and `src/orchestrator/channels.test.ts`. Everything else in each task's test — the assertions, the plan literals, the recording adapters — stands as written.

```ts
// installCharter returns the PolicyBundle DIRECTLY. There is no { charterVersion, bundle }
// destructuring and no `actor` option. The version lives on the bundle.
const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
  businessId: BUSINESS,
});

// A job reaches `execute` through `understand` first — LEGAL_TRANSITIONS has no
// intake → plan edge. `actor` is a JobActor: 'orchestrator' | 'human' | 'system' | an AgentId.
// 'test' is NOT a JobActor and will fail to parse.
async function jobInExecute(bundle: PolicyBundle): Promise<Job> {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, {
      to,
      actor: 'orchestrator',
      reason: 'setup',
      businessId: BUSINESS,
    });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

// upsertBinding's second argument requires `by`, not `actor`, and `by` is mandatory.
await upsertBinding(
  {
    system: 'office-mail',
    status: 'live',
    endpoint: null,
    credentialRef: 'OFFICE_MAIL',
    lastOkAt: null,
    lastError: null,
  },
  { businessId: BUSINESS, by: 'test' },
);
```

**`ActionClass` has no member `email.send`.** The outbound email classes are `email.reply` and `email.initiate`. Every reference in this plan is `email.initiate`: the seeded message carries no threading field, so `refineActionClass` classifies it as an initiation, and `email.reply` would be the wrong row to raise.

**To make the gate queue an approval in a test**, pass `autonomyBase` to `buildCharter` — e.g. `buildCharter({ connections: [MAIL_CONNECTION], autonomyBase: { 'email.initiate': 'approve_required' } })`. `CharterOverrides` supports `autonomyBase`, `connections`, ceilings, and the do-not-contact fields; read `src/test/fixtures.ts` before assuming any other override exists.

**Before transcribing any helper call from a task body, open the real file and check the signature.** The six defects found pre-flight were all of this kind. If a signature in a task body disagrees with the source, the source wins — implement against the source and say so in your report.

---

### Task 1: The autonomy ramp reader

The `autonomy_ramp` table has existed since migration 001 and no code has ever read it. `RunPlanRequest.rampLevel` is required, so until now every caller was a test passing a literal. This is the control that holds the system at "draft only" until a level is deliberately raised.

**Files:**
- Create: `src/orchestrator/ramp.ts`
- Test: `src/orchestrator/ramp.test.ts`

**Interfaces:**
- Consumes: `AutonomyLevel`, `mostRestrictiveAutonomy` from `src/domain/trust.js`; `ActionClass` from `src/domain/action.js`; `Plan` from `src/domain/plan.js`; `Queryable`, `getPool` from `src/db/pool.js`; `config` from `src/config.js`.
- Produces:
  - `loadRampLevel(actionClass: ActionClass, options?: { businessId?: string; db?: Queryable }): Promise<AutonomyLevel>`
  - `setRampLevel(actionClass: ActionClass, level: AutonomyLevel, options?: { businessId?: string; db?: Queryable }): Promise<void>`
  - `rampLevelForPlan(plan: Plan, options?: { businessId?: string; db?: Queryable }): Promise<AutonomyLevel>`

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/ramp.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { Plan } from '../domain/plan.js';
import { loadRampLevel, rampLevelForPlan, setRampLevel } from './ramp.js';

const BUSINESS = 'test-business';

function planWith(classes: (string | null)[]): Plan {
  return Plan.parse({
    goal: 'test',
    steps: classes.map((cls, i) => ({
      id: `s${i}`,
      agent: 'comms.email',
      intent: 'send',
      toolName: 'mail.send',
      input: {},
      expectedActionClass: cls,
    })),
  });
}

describe('autonomy ramp', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('returns draft_only when the business has no row for the class', async () => {
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('returns the stored level once one is set', async () => {
    await setRampLevel('email.initiate', 'approve_required', { businessId: BUSINESS });
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('approve_required');
  });

  it('does not read another business’s row', async () => {
    await setRampLevel('email.initiate', 'auto', { businessId: 'other-business' });
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('falls back to draft_only when the stored level is not a known level', async () => {
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    const { getPool } = await import('../db/pool.js');
    await getPool().query(
      `UPDATE autonomy_ramp SET level = 'wide_open'
        WHERE business_id = $1 AND action_class = $2`,
      [BUSINESS, 'email.initiate'],
    );
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('setRampLevel overwrites rather than inserting a second row', async () => {
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'approve_required', { businessId: BUSINESS });
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('approve_required');
  });

  it('takes the most restrictive level across every class a plan declares', async () => {
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    await setRampLevel('crm.write', 'approve_required', { businessId: BUSINESS });
    const plan = planWith(['email.initiate', 'crm.write']);
    expect(await rampLevelForPlan(plan, { businessId: BUSINESS })).toBe('approve_required');
  });

  it('treats a step that declares no class as draft_only', async () => {
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    const plan = planWith(['email.initiate', null]);
    expect(await rampLevelForPlan(plan, { businessId: BUSINESS })).toBe('draft_only');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/ramp.test.ts`
Expected: FAIL — `Cannot find module './ramp.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/orchestrator/ramp.ts`:

```ts
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import type { ActionClass } from '../domain/action.js';
import type { Plan } from '../domain/plan.js';
import { AutonomyLevel, mostRestrictiveAutonomy } from '../domain/trust.js';

/**
 * The level an action class has when nothing says otherwise.
 *
 * Matches the column default in migration 001, and matters far more than that
 * suggests: this is the value a missing row, an unknown business, or a level
 * string this code does not recognise all resolve to. A value nobody could
 * read is never a permissive value — and `draft_only` is the level at which
 * work is produced and nothing leaves the building.
 */
const RAMP_FLOOR: AutonomyLevel = 'draft_only';

interface RampRow {
  level: string;
}

/**
 * The earned autonomy for one action class.
 *
 * The first reader this table has ever had. `RunPlanRequest.rampLevel` has
 * been required since the engine was written, so every caller until now was a
 * test passing a literal — which meant the one control that holds a new
 * install at "draft only" was carried entirely by nobody having wired a
 * production caller yet.
 */
export async function loadRampLevel(
  actionClass: ActionClass,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AutonomyLevel> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<RampRow>(
    `SELECT level FROM autonomy_ramp
      WHERE business_id = $1 AND action_class = $2`,
    [options.businessId ?? config.businessId, actionClass],
  );

  const stored = rows[0]?.level;
  if (stored === undefined) return RAMP_FLOOR;

  // Parsed rather than cast. The column is TEXT, so a level this build does
  // not know about — a rollback, a hand-edited row — is representable, and
  // treating it as an AutonomyLevel would hand the gate a ceiling it cannot
  // rank.
  const parsed = AutonomyLevel.safeParse(stored);
  return parsed.success ? parsed.data : RAMP_FLOOR;
}

/**
 * Set the earned autonomy for one action class.
 *
 * Deliberately blunt and deliberately not automatic: promotion out of
 * `draft_only` is a decision, and until the ramp mechanics of stage 2 exist
 * the only thing that should move this row is a person running a command.
 */
export async function setRampLevel(
  actionClass: ActionClass,
  level: AutonomyLevel,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const db = options.db ?? getPool();
  await db.query(
    `INSERT INTO autonomy_ramp (business_id, action_class, level, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (business_id, action_class)
     DO UPDATE SET level = EXCLUDED.level, updated_at = now()`,
    [options.businessId ?? config.businessId, actionClass, level],
  );
}

/**
 * One ceiling for a whole plan: the most restrictive level across every class
 * its steps declare.
 *
 * `runPlan` takes a single `rampLevel` for the run, while a plan may touch
 * several action classes. Taking the minimum is the only combination that
 * keeps a ceiling a ceiling.
 *
 * A step whose `expectedActionClass` is null contributes `RAMP_FLOOR`. That
 * field is advisory to the gate — the gate classifies the call itself — but
 * here it is the only thing available before the step runs, and "the planner
 * did not say" must not read as "no ceiling applies".
 */
export async function rampLevelForPlan(
  plan: Plan,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AutonomyLevel> {
  const levels: AutonomyLevel[] = [];
  for (const step of plan.steps) {
    if (step.expectedActionClass === null) {
      levels.push(RAMP_FLOOR);
      continue;
    }
    levels.push(await loadRampLevel(step.expectedActionClass, options));
  }
  // `mostRestrictiveAutonomy` throws on an empty list rather than defaulting
  // to permissive; `Plan.steps` has `.min(1)`, so this is never empty.
  return mostRestrictiveAutonomy(levels);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/orchestrator/ramp.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/orchestrator/ramp.ts src/orchestrator/ramp.test.ts
git commit -m "The autonomy ramp table gets its first reader, and it fails safe"
```

---

### Task 2: Load the stored plan body, not just its hash

Migration 004 stores `plan JSONB` on `job_plans`. `loadStoredPlan` selects only `business_id, job_id, plan_hash` — so nothing can reconstruct the plan a job was bound to, and a scheduler waking a job has nothing to hand the engine. This is the single missing link for resumption.

**Files:**
- Modify: `src/orchestrator/plan-store.ts`
- Test: `src/orchestrator/plan-body.test.ts`

**Interfaces:**
- Consumes: `bindPlanToJob`, `planHashOf` from `src/orchestrator/plan-store.js`; `Plan` from `src/domain/plan.js`.
- Produces:
  - `export interface StoredPlanBody { planHash: string; plan: Plan }`
  - `loadPlanBody(jobId: string, options?: { businessId?: string; db?: Queryable }): Promise<StoredPlanBody | null>`

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/plan-body.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { Plan } from '../domain/plan.js';
import { createJob } from './jobs.js';
import { bindPlanToJob, loadPlanBody, planHashOf } from './plan-store.js';

const BUSINESS = 'test-business';

const PLAN: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the confirmation',
      toolName: 'mail.send',
      input: { to: 'dana@example.com', subject: 'hi', body: 'hello' },
      expectedActionClass: 'email.initiate',
    },
  ],
});

async function seedJob(): Promise<string> {
  const { charterVersion } = await installCharter(buildCharter(), {
    businessId: BUSINESS,
    actor: 'test',
  });
  const job = await createJob({
    charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'plan body test',
  });
  return job.jobId;
}

describe('loadPlanBody', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('returns null for a job that is bound to no plan', async () => {
    const jobId = await seedJob();
    expect(await loadPlanBody(jobId, { businessId: BUSINESS })).toBeNull();
  });

  it('returns the plan a job was bound to, byte for byte', async () => {
    const jobId = await seedJob();
    await bindPlanToJob(jobId, PLAN, { businessId: BUSINESS });

    const loaded = await loadPlanBody(jobId, { businessId: BUSINESS });
    expect(loaded).not.toBeNull();
    expect(loaded?.plan).toEqual(PLAN);
    expect(loaded?.planHash).toBe(planHashOf(PLAN));
    // The point of the whole task: a round trip through the database must
    // still hash to the same plan, or resumption silently re-plans.
    expect(planHashOf(loaded!.plan)).toBe(planHashOf(PLAN));
  });

  it('does not read another business’s row', async () => {
    const jobId = await seedJob();
    await bindPlanToJob(jobId, PLAN, { businessId: BUSINESS });
    expect(await loadPlanBody(jobId, { businessId: 'other-business' })).toBeNull();
  });

  it('throws rather than returning a plan that no longer parses', async () => {
    const jobId = await seedJob();
    await bindPlanToJob(jobId, PLAN, { businessId: BUSINESS });
    await getPool().query(
      `UPDATE job_plans SET plan = '{"goal":"broken"}'::jsonb
        WHERE business_id = $1 AND job_id = $2`,
      [BUSINESS, jobId],
    );

    await expect(loadPlanBody(jobId, { businessId: BUSINESS })).rejects.toThrow(
      /stored plan/i,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/plan-body.test.ts`
Expected: FAIL — `loadPlanBody is not a function` / no exported member.

- [ ] **Step 3: Write minimal implementation**

In `src/orchestrator/plan-store.ts`, add `Plan` to the existing type import at the top (it already imports `import type { Plan } from '../domain/plan.js';` — change it to a **value** import, because `Plan.safeParse` is now called):

```ts
// was: import type { Plan } from '../domain/plan.js';
import { Plan } from '../domain/plan.js';
```

Then append:

```ts
/** A job's plan as stored, parsed back into the domain type. */
export interface StoredPlanBody {
  planHash: string;
  plan: Plan;
}

interface PlanBodyRow {
  plan_hash: string;
  plan: unknown;
}

/**
 * The plan a job is executing, body and all.
 *
 * `loadStoredPlan` returns only the hash, which answers "is this job bound?"
 * and nothing else. Resumption needs the plan itself: the scheduler wakes a
 * job hours after the run that stored it, in a different process, with no
 * memory of what the planner produced. The `plan` column has been written
 * since migration 004 and had no reader until this function.
 *
 * A row that no longer parses throws rather than resolving to null. Null means
 * "this job is bound to nothing", and a caller acting on that would bind a
 * *new* plan over a job whose completed steps belong to the old one — the
 * exact merge `bindPlanToJob` refuses. A stored plan this build cannot read is
 * a different fact and deserves a different, loud ending.
 */
export async function loadPlanBody(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<StoredPlanBody | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<PlanBodyRow>(
    `SELECT plan_hash, plan FROM job_plans
      WHERE business_id = $1 AND job_id = $2`,
    [options.businessId ?? config.businessId, jobId],
  );

  const row = rows[0];
  if (!row) return null;

  const parsed = Plan.safeParse(row.plan);
  if (!parsed.success) {
    throw new Error(
      `loadPlanBody: stored plan for job ${jobId} does not parse as a Plan — ` +
        `refusing to treat it as unbound (${parsed.error.message})`,
    );
  }

  return { planHash: row.plan_hash, plan: parsed.data };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/orchestrator/plan-body.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the whole suite, then commit**

The import change from `import type { Plan }` to `import { Plan }` affects a file other modules depend on; run everything.

```bash
npm run typecheck
npm test
git add src/orchestrator/plan-store.ts src/orchestrator/plan-body.test.ts
git commit -m "The stored plan can be read back, not just recognised by its hash"
```

---

### Task 3: Thread the approval notifier through to the gate

`GateContext.notify` exists and `createEmailNotifier` is built and tested, but `executeStep` constructs its `GateContext` without a `notify` field and `RunPlanRequest` has no way to supply one. So an approval is queued and nobody is told.

**Files:**
- Modify: `src/orchestrator/execute.ts` (add to `StepRequest`, pass into `evaluateToolCall`)
- Modify: `src/orchestrator/run-plan.ts` (add to `RunPlanRequest`, pass into `executeStep`)
- Test: `src/orchestrator/notify-wiring.test.ts`

**Interfaces:**
- Consumes: `ApprovalNotifier` from `src/governance/notify.js`.
- Produces:
  - `StepRequest.notify?: { notifier: ApprovalNotifier; dashboardBaseUrl: string }`
  - `RunPlanRequest.notify?: { notifier: ApprovalNotifier; dashboardBaseUrl: string }`

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/notify-wiring.test.ts`. It drives a real plan through `runPlan` with a notifier that records, and asserts the notifier was called when the gate queued an approval.

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import type { ApprovalNotifier } from '../governance/notify.js';
import { createJob, transition } from './jobs.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter } from './adapters/mail.js';
import { envCredentials } from './credentials.js';
import { runPlan } from './run-plan.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const LIVE: ConnectionBinding = {
  system: 'office-mail',
  status: 'live',
  endpoint: null,
  credentialRef: 'OFFICE_MAIL',
  lastOkAt: null,
  lastError: null,
};

const PLAN: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the confirmation',
      toolName: 'mail.send',
      input: { to: 'dana@example.com', subject: 'אישור', body: 'שלום' },
      expectedActionClass: 'email.initiate',
    },
  ],
});

function recordingNotifier(): { calls: { approvalId: string; link: string }[]; notifier: ApprovalNotifier } {
  const calls: { approvalId: string; link: string }[] = [];
  return {
    calls,
    notifier: {
      channel: 'email',
      async notify(request, link) {
        calls.push({ approvalId: request.approvalId, link });
        return { ok: true };
      },
    },
  };
}

function registry(): AdapterRegistry {
  return new AdapterRegistry([
    createMailAdapter({
      system: 'office-mail',
      transport: {
        async send() {
          return { messageId: 'MSG-1' };
        },
      },
    }),
  ]);
}

describe('approval notification wiring', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('notifies the owner when the gate queues an approval', async () => {
    const charter = buildCharter({ connections: [MAIL_CONNECTION] });
    const { charterVersion, bundle } = await installCharter(charter, {
      businessId: BUSINESS,
      actor: 'test',
    });
    const job = await createJob({
      charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'notify wiring',
    });
    await transition(job.jobId, {
      to: 'plan',
      actor: 'test',
      reason: 'test',
      businessId: BUSINESS,
    });
    await transition(job.jobId, {
      to: 'execute',
      actor: 'test',
      reason: 'test',
      businessId: BUSINESS,
    });

    const { calls, notifier } = recordingNotifier();

    const result = await runPlan({
      job: { ...job, phase: 'execute' },
      bundle,
      plan: PLAN,
      registry: registry(),
      bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [],
      rampLevel: 'approve_required',
      notify: { notifier, dashboardBaseUrl: 'http://127.0.0.1:8787' },
    });

    expect(result.status).toBe('halted');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.link).toContain('http://127.0.0.1:8787');
  });

  it('runs unchanged when no notifier is supplied', async () => {
    const charter = buildCharter({ connections: [MAIL_CONNECTION] });
    const { charterVersion, bundle } = await installCharter(charter, {
      businessId: BUSINESS,
      actor: 'test',
    });
    const job = await createJob({
      charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'no notifier',
    });
    await transition(job.jobId, {
      to: 'plan',
      actor: 'test',
      reason: 'test',
      businessId: BUSINESS,
    });
    await transition(job.jobId, {
      to: 'execute',
      actor: 'test',
      reason: 'test',
      businessId: BUSINESS,
    });

    const result = await runPlan({
      job: { ...job, phase: 'execute' },
      bundle,
      plan: PLAN,
      registry: registry(),
      bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [],
      rampLevel: 'approve_required',
    });

    expect(result.status).toBe('halted');
  });
});
```

> **Note for the implementer:** if `buildCharter()`'s defaults make `mail.send` at `approve_required` resolve to `allow` rather than `queue_approval`, the first assertion will fail on `calls`. Do **not** weaken the assertion. Inspect `src/test/fixtures.ts` and pass whatever `CharterOverrides` puts `email.initiate` in the approval band, exactly as `src/orchestrator/external.test.ts` and `src/orchestrator/approved-step.test.ts` already do for their own cases — copy the override shape from whichever of those queues an approval.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/notify-wiring.test.ts`
Expected: FAIL — `notify` is not a known property of the `runPlan` argument (TypeScript error), and `calls` is empty.

- [ ] **Step 3: Write minimal implementation**

In `src/orchestrator/execute.ts`, add the import:

```ts
import type { ApprovalNotifier } from '../governance/notify.js';
```

Add to `StepRequest`, after `approvalId`:

```ts
  /**
   * How to tell the owner an approval is waiting.
   *
   * Optional because the gate treats notification as best-effort — the request
   * row and the dashboard exist either way, and `evaluateToolCall` records
   * `approval_notify_failed` rather than throwing. Absent, an approval is
   * queued and nobody is told, which is exactly the state this field exists to
   * end.
   */
  notify?: { notifier: ApprovalNotifier; dashboardBaseUrl: string };
```

In the `evaluateToolCall(...)` call, add a conditional spread alongside the existing `approval` one (`exactOptionalPropertyTypes` forbids passing `undefined`):

```ts
    ...(request.notify !== undefined ? { notify: request.notify } : {}),
```

In `src/orchestrator/run-plan.ts`, add the same import, add to `RunPlanRequest`:

```ts
  /** Passed through to the gate so a queued approval reaches the owner. */
  notify?: { notifier: ApprovalNotifier; dashboardBaseUrl: string };
```

and in the object literal `runPlan` builds for `executeStep`, add:

```ts
      ...(request.notify !== undefined ? { notify: request.notify } : {}),
```

`RunPlanForJobRequest` is `Omit<RunPlanRequest, 'bindings'>`, so it picks the field up with no further change.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/orchestrator/notify-wiring.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck
npm test
git add src/orchestrator/execute.ts src/orchestrator/run-plan.ts src/orchestrator/notify-wiring.test.ts
git commit -m "An approval the gate queues now reaches the owner"
```

---

### Task 4: The runtime assembly

One place that builds what the engine needs from the environment. Everything it cannot build, it reports as a warning — it never returns a quietly degraded runtime.

**Files:**
- Create: `src/orchestrator/runtime.ts`
- Test: `src/orchestrator/runtime.test.ts`

**Interfaces:**
- Consumes: `AdapterRegistry`, `createMailAdapter`, `createSmtpTransport`, `createEmailNotifier`, `envCredentials`, `browserAdapter`.
- Produces:
  - `export interface Runtime { registry: AdapterRegistry; credentials: CredentialSource; notify?: { notifier: ApprovalNotifier; dashboardBaseUrl: string }; warnings: string[] }`
  - `buildRuntime(env?: Record<string, string | undefined>): Runtime`

Environment variables it reads (all optional; each missing one produces a warning, never a throw):

| Variable | Meaning |
|---|---|
| `MAIL_SYSTEM` | The charter's system name for the mailbox, e.g. `office-mail`. Defaults to `office-mail`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASS` | The outgoing mail account. All six required together. |
| `APPROVAL_NOTIFY_TO` | Where approval notifications go. |
| `DASHBOARD_BASE_URL` | Base of the approval link. Defaults to `http://127.0.0.1:8787`. |

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/runtime.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildRuntime } from './runtime.js';

const FULL = {
  MAIL_SYSTEM: 'office-mail',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  SMTP_FROM: 'assistant@example.com',
  SMTP_USER: 'assistant',
  SMTP_PASS: 'pw',
  APPROVAL_NOTIFY_TO: 'boss@example.com',
  DASHBOARD_BASE_URL: 'http://127.0.0.1:8787',
};

describe('buildRuntime', () => {
  it('registers a mail adapter under the configured system name', () => {
    const runtime = buildRuntime(FULL);
    expect(runtime.registry.get('office-mail')).not.toBeNull();
    expect(runtime.warnings).toEqual([]);
  });

  it('builds a notifier when a destination and SMTP are both configured', () => {
    const runtime = buildRuntime(FULL);
    expect(runtime.notify?.notifier.channel).toBe('email');
    expect(runtime.notify?.dashboardBaseUrl).toBe('http://127.0.0.1:8787');
  });

  it('warns loudly rather than silently omitting the mail adapter', () => {
    const { SMTP_HOST: _host, ...withoutHost } = FULL;
    const runtime = buildRuntime(withoutHost);
    expect(runtime.registry.get('office-mail')).toBeNull();
    expect(runtime.warnings.join(' ')).toMatch(/SMTP_HOST/);
  });

  it('warns when SMTP is configured but nobody is set to receive notifications', () => {
    const { APPROVAL_NOTIFY_TO: _to, ...withoutTo } = FULL;
    const runtime = buildRuntime(withoutTo);
    expect(runtime.notify).toBeUndefined();
    expect(runtime.warnings.join(' ')).toMatch(/APPROVAL_NOTIFY_TO/);
  });

  it('always supplies a credential source', () => {
    const runtime = buildRuntime({});
    expect(typeof runtime.credentials.resolve).toBe('function');
  });

  it('registers the browser driver as the browser channel default', () => {
    const runtime = buildRuntime(FULL);
    // Registered as a channel default rather than under a system name; the
    // registry has no public getter for that, so the check is that
    // construction did not throw and mail is still reachable.
    expect(runtime.registry.get('office-mail')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/runtime.test.ts`
Expected: FAIL — `Cannot find module './runtime.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/orchestrator/runtime.ts`:

```ts
import { createEmailNotifier, type ApprovalNotifier } from '../governance/notify.js';
import { createSmtpTransport } from '../mail/transport.js';
import { browserAdapter } from './adapters/browser.js';
import { createMailAdapter } from './adapters/mail.js';
import { AdapterRegistry } from './adapters/registry.js';
import { envCredentials } from './credentials.js';
import type { CredentialSource } from './credentials.js';

/**
 * Everything a production run needs that is not per-job.
 *
 * Assembled in one place so the scheduler, the seed command and anything later
 * agree on which adapters exist and where notifications go. Two callers each
 * building their own registry is two chances to disagree about which system
 * name the charter uses.
 */
export interface Runtime {
  registry: AdapterRegistry;
  credentials: CredentialSource;
  notify?: { notifier: ApprovalNotifier; dashboardBaseUrl: string };
  /**
   * What could not be assembled, and why.
   *
   * Returned rather than logged here, and never swallowed: a runtime missing
   * its mail adapter still starts — the scheduler must keep expiring approvals
   * — but the operator has to be told, or "no mail ever went out" looks
   * exactly like "there was nothing to send".
   */
  warnings: string[];
}

const DEFAULT_MAIL_SYSTEM = 'office-mail';
const DEFAULT_DASHBOARD_BASE_URL = 'http://127.0.0.1:8787';

const SMTP_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_FROM',
  'SMTP_USER',
  'SMTP_PASS',
] as const;

export function buildRuntime(
  env: Record<string, string | undefined> = process.env,
): Runtime {
  const warnings: string[] = [];

  const missing = SMTP_KEYS.filter((key) => {
    const value = env[key];
    return value === undefined || value.length === 0;
  });

  const systemAdapters = [];
  let notify: Runtime['notify'];

  if (missing.length > 0) {
    warnings.push(
      `no mail adapter: ${missing.join(', ')} not set — every mail.send step ` +
        `will be refused, and no approval notification can be sent`,
    );
  } else {
    const port = Number(env['SMTP_PORT']);
    if (!Number.isInteger(port) || port <= 0) {
      warnings.push(`no mail adapter: SMTP_PORT is not a positive integer`);
    } else {
      const transport = createSmtpTransport({
        host: env['SMTP_HOST'] as string,
        port,
        // Positive check. `!== 'false'` would make a typo mean TLS.
        secure: env['SMTP_SECURE'] === 'true',
        from: env['SMTP_FROM'] as string,
        auth: { user: env['SMTP_USER'] as string, pass: env['SMTP_PASS'] as string },
      });

      systemAdapters.push(
        createMailAdapter({
          system: env['MAIL_SYSTEM'] ?? DEFAULT_MAIL_SYSTEM,
          transport,
        }),
      );

      const to = env['APPROVAL_NOTIFY_TO'];
      if (to === undefined || to.length === 0) {
        warnings.push(
          `no approval notifier: APPROVAL_NOTIFY_TO not set — approvals will ` +
            `queue and appear on the dashboard, and nobody will be emailed`,
        );
      } else {
        notify = {
          notifier: createEmailNotifier(transport, to),
          dashboardBaseUrl: env['DASHBOARD_BASE_URL'] ?? DEFAULT_DASHBOARD_BASE_URL,
        };
      }
    }
  }

  return {
    registry: new AdapterRegistry(systemAdapters, [browserAdapter]),
    credentials: envCredentials(env),
    ...(notify !== undefined ? { notify } : {}),
    warnings,
  };
}
```

> **Note for the implementer:** confirm `browserAdapter` is exported from `src/orchestrator/adapters/browser.ts` under that exact name and is a value (not a factory). `src/orchestrator/external.test.ts` imports it as `import { browserAdapter } from './adapters/browser.js';` — follow whatever that file does. If it is a factory, call it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/orchestrator/runtime.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/orchestrator/runtime.ts src/orchestrator/runtime.test.ts
git commit -m "One place assembles the adapters, credentials and notifier"
```

---

### Task 5: `runDueJobs` — the production caller

The heart of the plan. Finds every job sitting in `execute` with a stored plan, takes a **session-scoped** advisory lock per job, and runs it.

Why session-scoped and not `pg_advisory_xact_lock`: the run makes external calls that can take up to the adapter deadline. Holding a database transaction open across a network call is how a connection pool dies. The lock is taken on a dedicated client and released in a `finally`.

**Files:**
- Create: `src/orchestrator/run-due.ts`
- Test: `src/orchestrator/run-due.test.ts`

**Interfaces:**
- Consumes: `loadPlanBody` (Task 2), `rampLevelForPlan` (Task 1), `Runtime`/`buildRuntime` (Task 4), `loadActiveCharter` from `src/charter/store.js`, `runPlanForJob` from `src/orchestrator/run-plan.js`, `getPool` from `src/db/pool.js`.
- Produces:
  - `export interface RanJob { jobId: string; status: 'done' | 'halted' | 'rejected'; detail: string | null }`
  - `export interface RunDueResult { ran: RanJob[]; lockedOut: string[]; unbound: string[] }`
  - `runDueJobs(options?: { businessId?: string; limit?: number; runtime?: Runtime; now?: Date }): Promise<RunDueResult>`

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/run-due.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection } from '../domain/connection.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { upsertBinding } from './bindings.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, transition } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';
import { setRampLevel } from './ramp.js';
import { runDueJobs } from './run-due.js';
import type { Runtime } from './runtime.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const PLAN: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the confirmation',
      toolName: 'mail.send',
      input: { to: 'dana@example.com', subject: 'נושא', body: 'גוף' },
      expectedActionClass: 'email.initiate',
    },
  ],
});

function runtimeWith(sent: MailMessage[]): Runtime {
  return {
    registry: new AdapterRegistry([
      createMailAdapter({
        system: 'office-mail',
        transport: {
          async send(message) {
            sent.push(message);
            return { messageId: 'MSG-1' };
          },
        },
      }),
    ]),
    credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
    warnings: [],
  };
}

async function seedExecutableJob(): Promise<string> {
  const { charterVersion } = await installCharter(
    buildCharter({ connections: [MAIL_CONNECTION] }),
    { businessId: BUSINESS, actor: 'test' },
  );
  const job = await createJob({
    charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'run-due',
  });
  await transition(job.jobId, { to: 'plan', actor: 'test', reason: 't', businessId: BUSINESS });
  await transition(job.jobId, { to: 'execute', actor: 'test', reason: 't', businessId: BUSINESS });
  await upsertBinding(
    {
      system: 'office-mail',
      status: 'live',
      endpoint: null,
      credentialRef: 'OFFICE_MAIL',
      lastOkAt: null,
      lastError: null,
    },
    { businessId: BUSINESS, actor: 'test' },
  );
  await bindPlanToJob(job.jobId, PLAN, { businessId: BUSINESS });
  return job.jobId;
}

describe('runDueJobs', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('does nothing when no job is in execute', async () => {
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith([]) });
    expect(result.ran).toEqual([]);
  });

  it('runs a job that is in execute with a stored plan', async () => {
    const jobId = await seedExecutableJob();
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent) });

    expect(result.ran.map((r) => r.jobId)).toEqual([jobId]);
    expect(sent).toHaveLength(1);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('verify');
  });

  it('reports a job in execute that is bound to no plan, and does not run it', async () => {
    const { charterVersion } = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION] }),
      { businessId: BUSINESS, actor: 'test' },
    );
    const job = await createJob({
      charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'unbound',
    });
    await transition(job.jobId, { to: 'plan', actor: 'test', reason: 't', businessId: BUSINESS });
    await transition(job.jobId, { to: 'execute', actor: 'test', reason: 't', businessId: BUSINESS });

    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith([]) });
    expect(result.unbound).toEqual([job.jobId]);
    expect(result.ran).toEqual([]);
  });

  it('honours the ramp: with no ramp row the send is capped and no mail goes out', async () => {
    await seedExecutableJob();
    // No setRampLevel call at all — the floor is draft_only.
    const sent: MailMessage[] = [];
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent) });
    expect(sent).toEqual([]);
  });

  it('does not run a job belonging to another business', async () => {
    const jobId = await seedExecutableJob();
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    const result = await runDueJobs({
      businessId: 'other-business',
      runtime: runtimeWith([]),
    });
    expect(result.ran.map((r) => r.jobId)).not.toContain(jobId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/run-due.test.ts`
Expected: FAIL — `Cannot find module './run-due.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/orchestrator/run-due.ts`:

```ts
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { loadActiveCharter } from '../charter/store.js';
import { loadPlanBody } from './plan-store.js';
import { rampLevelForPlan } from './ramp.js';
import { runPlanForJob } from './run-plan.js';
import { buildRuntime, type Runtime } from './runtime.js';
import { loadJob } from './jobs.js';

export interface RanJob {
  jobId: string;
  status: 'done' | 'halted' | 'rejected';
  /** The halt reason or rejection code; null on a clean completion. */
  detail: string | null;
}

export interface RunDueResult {
  ran: RanJob[];
  /** Jobs another runner held while this pass went by. */
  lockedOut: string[];
  /** Jobs in `execute` with no plan stored — nothing to run, and worth saying. */
  unbound: string[];
}

interface DueRow {
  job_id: string;
}

/**
 * Run every job that is ready to run.
 *
 * The production caller `runPlanForJob` never had. Called by the scheduler
 * process **after** `tick()` has committed — deliberately not inside it.
 * `tick` holds `pg_try_advisory_xact_lock` for the length of its transaction,
 * and a plan makes external calls bounded only by the adapter deadline;
 * running one inside that transaction would hold a pooled connection open
 * across the network and serialise every other business operation behind it.
 *
 * The per-job lock is session-scoped (`pg_try_advisory_lock`) on a dedicated
 * client for the same reason: it has to outlive no transaction in particular
 * and be released explicitly. `try` and not the blocking form — a second
 * runner should leave a job to whoever holds it and come back next tick, not
 * queue behind it and repeat its work.
 */
export async function runDueJobs(
  options: { businessId?: string; limit?: number; runtime?: Runtime; now?: Date } = {},
): Promise<RunDueResult> {
  const businessId = options.businessId ?? config.businessId;
  const limit = options.limit ?? 20;
  const runtime = options.runtime ?? buildRuntime();

  const { rows } = await getPool().query<DueRow>(
    `SELECT job_id FROM jobs
      WHERE business_id = $1
        AND phase = 'execute'
        AND closed_at IS NULL
      ORDER BY updated_at ASC
      LIMIT $2`,
    [businessId, limit],
  );

  const result: RunDueResult = { ran: [], lockedOut: [], unbound: [] };

  for (const row of rows) {
    const jobId = row.job_id;
    const client = await getPool().connect();
    let held = false;
    try {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [`job-run:${businessId}:${jobId}`],
      );
      if (lock.rows[0]?.locked !== true) {
        result.lockedOut.push(jobId);
        continue;
      }
      held = true;

      // Re-read under the lock. The phase may have moved between the query
      // above and the lock being granted, and `runPlan` checks the phase
      // itself — but binding a plan to a job that is no longer in `execute`
      // is the failure that check exists to prevent, and cheaper to avoid.
      const job = await loadJob(jobId, { businessId });
      if (job === null || job.phase !== 'execute') continue;

      const stored = await loadPlanBody(jobId, { businessId });
      if (stored === null) {
        result.unbound.push(jobId);
        continue;
      }

      const active = await loadActiveCharter(businessId);
      if (active === null) {
        // An absent charter is fatal, never permissive.
        result.ran.push({ jobId, status: 'rejected', detail: 'no_active_charter' });
        continue;
      }

      const rampLevel = await rampLevelForPlan(stored.plan, { businessId });

      const outcome = await runPlanForJob({
        job,
        bundle: active.bundle,
        plan: stored.plan,
        registry: runtime.registry,
        credentials: runtime.credentials,
        counterpartyTags: [],
        rampLevel,
        ...(runtime.notify !== undefined ? { notify: runtime.notify } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });

      result.ran.push({
        jobId,
        status: outcome.status,
        detail:
          outcome.status === 'done'
            ? null
            : outcome.status === 'halted'
              ? outcome.reason
              : outcome.code,
      });
    } finally {
      if (held) {
        await client
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
            `job-run:${businessId}:${jobId}`,
          ])
          .catch(() => {
            // The lock dies with the session anyway; a failed unlock must not
            // mask whatever error is already on its way up.
          });
      }
      client.release();
    }
  }

  return result;
}
```

> **Note for the implementer:** `counterpartyTags: []` is written explicitly and must stay explicit. `CLAUDE.md` is emphatic that this field being optional made it permanently empty and silently disabled every tag-scoped rule; `[]` here says "nobody resolved tags", which is a different statement from "we did not look". A tag resolver is stage 1 work and out of scope.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/orchestrator/run-due.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck
npm test
git add src/orchestrator/run-due.ts src/orchestrator/run-due.test.ts
git commit -m "The run engine gets a production caller"
```

---

### Task 6: Wire the runner into the scheduler process

**Files:**
- Modify: `src/orchestrator/run-scheduler.ts`
- Modify: `src/orchestrator/scheduler.ts` (only if `startScheduler` needs an after-tick hook — see Step 3)
- Test: `src/orchestrator/scheduler-runs-plans.test.ts`

**Interfaces:**
- Consumes: `tick` from `src/orchestrator/scheduler.js`, `runDueJobs` from `src/orchestrator/run-due.js`.
- Produces: `schedulerPass(options): Promise<{ tick: TickResult; due: RunDueResult }>` exported from `src/orchestrator/scheduler.ts`.

The process must not call `tick` and `runDueJobs` as two loose statements — that pairing is the thing being tested, and a pairing that lives only inside a process file cannot be tested. Wrap it.

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/scheduler-runs-plans.test.ts`. Reuse the seeding helper shape from Task 5's test (copy it — the executor may be reading tasks out of order).

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection } from '../domain/connection.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { upsertBinding } from './bindings.js';
import { envCredentials } from './credentials.js';
import { createJob, transition } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';
import { setRampLevel } from './ramp.js';
import { schedulerPass } from './scheduler.js';
import type { Runtime } from './runtime.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const PLAN: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the confirmation',
      toolName: 'mail.send',
      input: { to: 'dana@example.com', subject: 'נושא', body: 'גוף' },
      expectedActionClass: 'email.initiate',
    },
  ],
});

function runtimeWith(sent: MailMessage[]): Runtime {
  return {
    registry: new AdapterRegistry([
      createMailAdapter({
        system: 'office-mail',
        transport: {
          async send(message) {
            sent.push(message);
            return { messageId: 'MSG-1' };
          },
        },
      }),
    ]),
    credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
    warnings: [],
  };
}

describe('schedulerPass', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('wakes a sleeping job and runs its plan in the same pass', async () => {
    const { charterVersion } = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION] }),
      { businessId: BUSINESS, actor: 'test' },
    );
    const job = await createJob({
      charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'wake and run',
    });
    await transition(job.jobId, { to: 'plan', actor: 'test', reason: 't', businessId: BUSINESS });
    await transition(job.jobId, { to: 'execute', actor: 'test', reason: 't', businessId: BUSINESS });
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        credentialRef: 'OFFICE_MAIL',
        lastOkAt: null,
        lastError: null,
      },
      { businessId: BUSINESS, actor: 'test' },
    );
    await bindPlanToJob(job.jobId, PLAN, { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    // Park it asleep, due now.
    await transition(job.jobId, {
      to: 'followup',
      actor: 'test',
      reason: 'parked',
      wakeAt: new Date(Date.now() - 1000),
      businessId: BUSINESS,
    });

    const sent: MailMessage[] = [];
    const pass = await schedulerPass({ businessId: BUSINESS, runtime: runtimeWith(sent) });

    expect(pass.tick.wokenJobs).toContain(job.jobId);
    expect(pass.due.ran.map((r) => r.jobId)).toContain(job.jobId);
    expect(sent).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/scheduler-runs-plans.test.ts`
Expected: FAIL — `schedulerPass` is not exported from `./scheduler.js`.

- [ ] **Step 3: Write minimal implementation**

In `src/orchestrator/scheduler.ts`, add the import and the new function. Leave `tick` untouched.

```ts
import { runDueJobs, type RunDueResult } from './run-due.js';
import type { Runtime } from './runtime.js';

export interface SchedulerPassResult {
  tick: TickResult;
  due: RunDueResult;
}

/**
 * One full pass: tick, then run whatever the tick made ready.
 *
 * Two calls, one after the other, and the order is the whole point — a job
 * woken by the tick is in `execute` by the time `runDueJobs` looks, so it runs
 * in the same pass instead of waiting a full interval.
 *
 * `runDueJobs` is called **after** `tick` has returned and its transaction has
 * committed, never inside it: `tick` holds a transaction-scoped advisory lock,
 * and a plan's external calls have no business inside a database transaction.
 *
 * A skipped tick — another scheduler holds the lock — still runs the due pass.
 * The per-job locks in `runDueJobs` are what keep two runners apart, and they
 * are finer-grained than the business-wide tick lock.
 */
export async function schedulerPass(
  options: { businessId?: string; now?: Date; limit?: number; runtime?: Runtime } = {},
): Promise<SchedulerPassResult> {
  const tickResult = await tick(options);
  const due = await runDueJobs(options);
  return { tick: tickResult, due };
}
```

> `tick` and `runDueJobs` both accept `{ businessId?, now?, limit? }` and ignore what they do not use, so `options` passes through to both unchanged. `runDueJobs` additionally reads `runtime`.

Then change `startScheduler`'s `run` to call `schedulerPass` instead of `tick`, keeping the existing in-flight guard and `onError` behaviour exactly as they are.

In `src/orchestrator/run-scheduler.ts`:
- Replace `import { startScheduler, tick } from './scheduler.js';` with `import { schedulerPass, startScheduler } from './scheduler.js';`
- Add `import { buildRuntime } from './runtime.js';`
- Build the runtime once at startup and print every warning before the loop starts:

```ts
const runtime = buildRuntime();
for (const warning of runtime.warnings) console.warn(`warning: ${warning}`);
```

- Replace the initial `const first = await tick();` with `const first = await schedulerPass({ runtime });`, and read `first.tick.skipped` where it read `first.skipped`.
- Pass `runtime` into `startScheduler({ ..., runtime })`, threading it through `startScheduler`'s options into the `schedulerPass` call.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/orchestrator/scheduler-runs-plans.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck
npm test
git add src/orchestrator/scheduler.ts src/orchestrator/run-scheduler.ts src/orchestrator/scheduler-runs-plans.test.ts
git commit -m "The scheduler runs the plans it wakes"
```

---

### Task 7: The seed command, and the live-thread runbook

The thread's starting pistol: create a job, store a plan, raise the ramp for exactly one action class, and print what it permitted.

**Files:**
- Create: `src/cli/seed-job.ts`
- Modify: `package.json` (add `"job:seed"` script)
- Create: `docs/live-thread-runbook.md`
- Test: `src/cli/seed-job.test.ts`

**Interfaces:**
- Consumes: `createJob`, `transition` from `src/orchestrator/jobs.js`; `bindPlanToJob` from `src/orchestrator/plan-store.js`; `setRampLevel` from `src/orchestrator/ramp.js`; `activeCharterVersion` from `src/charter/store.js`; `Plan` from `src/domain/plan.js`.
- Produces: `seedMailJob(options: { to: string; subject: string; body: string; businessId?: string; system?: string }): Promise<{ jobId: string; planHash: string }>` — exported so the test drives it without spawning a process.

- [ ] **Step 1: Write the failing test**

Create `src/cli/seed-job.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { CharterConnection } from '../domain/connection.js';
import { loadJob } from '../orchestrator/jobs.js';
import { loadPlanBody } from '../orchestrator/plan-store.js';
import { loadRampLevel } from '../orchestrator/ramp.js';
import { seedMailJob } from './seed-job.js';

const BUSINESS = 'test-business';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

describe('seedMailJob', () => {
  beforeEach(async () => {
    await resetDatabase();
    await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
      businessId: BUSINESS,
      actor: 'test',
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it('leaves the job in execute, bound to a one-step plan', async () => {
    const { jobId } = await seedMailJob({
      to: 'dana@example.com',
      subject: 'נושא',
      body: 'גוף',
      businessId: BUSINESS,
    });

    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('execute');
    const stored = await loadPlanBody(jobId, { businessId: BUSINESS });
    expect(stored?.plan.steps).toHaveLength(1);
    expect(stored?.plan.steps[0]?.toolName).toBe('mail.send');
    expect(stored?.plan.steps[0]?.expectedActionClass).toBe('email.initiate');
  });

  it('raises the ramp for email.initiate only, and only to approve_required', async () => {
    await seedMailJob({
      to: 'dana@example.com',
      subject: 'נושא',
      body: 'גוף',
      businessId: BUSINESS,
    });

    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('approve_required');
    // Every other class stays on the floor. A seed command that raised the
    // whole business would be a far larger grant than it appears.
    expect(await loadRampLevel('purchase.place', { businessId: BUSINESS })).toBe('draft_only');
    expect(await loadRampLevel('crm.write', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('refuses when no charter is installed', async () => {
    await resetDatabase();
    await expect(
      seedMailJob({ to: 'dana@example.com', subject: 's', body: 'b', businessId: BUSINESS }),
    ).rejects.toThrow(/charter/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/seed-job.test.ts`
Expected: FAIL — `Cannot find module './seed-job.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/seed-job.ts`:

```ts
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { activeCharterVersion } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { bindPlanToJob, planHashOf } from '../orchestrator/plan-store.js';
import { setRampLevel } from '../orchestrator/ramp.js';

export interface SeedMailJobOptions {
  to: string;
  subject: string;
  body: string;
  businessId?: string;
  /** The charter's system name for the mailbox. */
  system?: string;
}

/**
 * Create the one job the live thread runs.
 *
 * A hand-written plan, not a planned one: the planner is a model behind an API
 * key this machine does not have, and the point of the thread is to prove the
 * execution path, not the planning path. When the planner is wired this
 * command keeps its value as an operational tool — "run exactly this, now".
 *
 * The ramp is raised to `approve_required` for `email.initiate` and nothing else.
 * `auto` would skip the approval, which is half the thread; raising the whole
 * business would be a far larger grant than the command appears to make.
 */
export async function seedMailJob(
  options: SeedMailJobOptions,
): Promise<{ jobId: string; planHash: string }> {
  const businessId = options.businessId ?? config.businessId;

  const charterVersion = await activeCharterVersion(businessId);
  if (charterVersion === null) {
    throw new Error(
      `seedMailJob: no active charter for business ${businessId} — install one first`,
    );
  }

  const plan = Plan.parse({
    goal: `send one mail to ${options.to}`,
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'send the seeded message',
        toolName: 'mail.send',
        input: { to: options.to, subject: options.subject, body: options.body },
        expectedActionClass: 'email.initiate',
      },
    ],
  });

  const job = await createJob({
    charterVersion,
    // The owner ran this command; nothing untrusted contributed to it.
    provenance: 'boss',
    businessId,
    title: `live thread: mail to ${options.to}`,
  });

  await transition(job.jobId, {
    to: 'plan',
    actor: 'boss',
    reason: 'seeded by job:seed',
    businessId,
  });
  await transition(job.jobId, {
    to: 'execute',
    actor: 'boss',
    reason: 'seeded by job:seed',
    businessId,
  });

  await bindPlanToJob(job.jobId, plan, { businessId });
  await setRampLevel('email.initiate', 'approve_required', { businessId });

  return { jobId: job.jobId, planHash: planHashOf(plan) };
}

/**
 * The process wrapper. Kept separate from `seedMailJob` so the test drives the
 * logic without spawning a process or reading argv.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };

  const to = read('--to');
  const subject = read('--subject') ?? 'הודעת בדיקה מהעוזרת';
  const body = read('--body') ?? 'זו הודעת בדיקה שנשלחה על ידי החוט החי.';

  if (to === undefined) {
    console.error('usage: npm run job:seed -- --to <address> [--subject <s>] [--body <b>]');
    process.exit(1);
    return;
  }

  const { jobId, planHash } = await seedMailJob({ to, subject, body });

  console.log(`job ${jobId} created, in phase execute`);
  console.log(`plan ${planHash} stored — one step, mail.send to ${to}`);
  console.log(`ramp: email.initiate raised to approve_required for ${config.businessId}`);
  console.log('every other action class remains at draft_only');
  console.log('start `npm run scheduler` to run it');
  await closePool();
}

// Only run when executed directly, never on import from the test.
if (process.argv[1]?.endsWith('seed-job.ts') || process.argv[1]?.endsWith('seed-job.js')) {
  await main();
}
```

> **Note for the implementer:** confirm `activeCharterVersion`'s exact signature in `src/charter/store.ts` (it is exported at line ~166) and its null behaviour. If it takes `(businessId, db)` positionally rather than an options object, match it. If it throws instead of returning null when nothing is installed, drop the null check and let it throw — but keep the test's `rejects.toThrow(/charter/i)` passing.

Add to `package.json` scripts:

```json
"job:seed": "tsx src/cli/seed-job.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/seed-job.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the runbook**

Create `docs/live-thread-runbook.md`, in Hebrew, documenting exactly this sequence:

1. הרם תיבת דואר מקומית לבדיקה: `npx maildev` (מאזין ל-SMTP ב-1025, ממשק ב-1080).
2. הגדר ב-`.env`: `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`, `SMTP_SECURE=false`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASS`, `APPROVAL_NOTIFY_TO`, `DASHBOARD_BASE_URL`, `ASSISTANT_CREDENTIAL_OFFICE_MAIL`.
3. ודא שיש תקנון מותקן ושחיבור `office-mail` במצב `live`.
4. `npm run dashboard` בחלון אחד.
5. `npm run job:seed -- --to dana@example.com` בחלון שני.
6. `npm run scheduler` בחלון שלישי.
7. מייל בקשת האישור מופיע ב-maildev; פתח את הקישור, אשר במסך.
8. הפעימה הבאה מעירה את המשימה, המנוע ממשיך מהצעד שעצר, והמייל השני נשלח.
9. `SELECT * FROM audit_log ORDER BY seq` — כל שלב מתועד.

Include a "מה לא יעבוד ולמה" section listing: no charter installed, binding not `live`, `ASSISTANT_CREDENTIAL_OFFICE_MAIL` unset, ramp not raised, and what each looks like in the logs.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck
npm test
git add src/cli/seed-job.ts src/cli/seed-job.test.ts package.json docs/live-thread-runbook.md
git commit -m "Seed one job, and a runbook for driving the live thread"
```

---

### Task 8: Prove the thread, then close the books

**Files:**
- Modify: `CLAUDE.md` (the "מה שנשאר פתוח" claims that are now false, and the stale test count)
- Modify: `docs/09-roadmap.md` (stage 0 exit condition)

- [ ] **Step 1: Run the thread end to end**

Follow `docs/live-thread-runbook.md` against a local maildev instance. Record what actually happened — including anything that did not work. Do not proceed on a partial run.

- [ ] **Step 2: Run the security review**

`CLAUDE.md` requires it: Task 1 feeds an autonomy ceiling into `evaluateToolCall`.

Run: `/security-review`
Address anything it finds before Step 3.

- [ ] **Step 3: Correct the documentation**

In `CLAUDE.md`:
- `runPlanForJob` — remove "**ואין לו עדיין קורא בייצור**"; it has one now (`runDueJobs`, called by `schedulerPass`).
- The notify paragraph — remove "**שום קורא בייצור אינו מספק `GateContext.notify`**"; `buildRuntime` supplies it.
- The scheduler paragraph — it now runs plans, not only wakes and expires.
- The test count: `npm test` — update `416` to the real number.
- Add a line to "כללים שהקוד אוכף בשקט": the ramp floor is `draft_only`, a plan's ceiling is the minimum across its steps' declared classes, and a step declaring no class contributes the floor.

In `docs/09-roadmap.md`, update the stage 0 exit-condition note with what the live thread actually proved and what it did not (no live model call; no planner; the thread ran against a local mailbox unless a real SMTP account was used).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/09-roadmap.md
git commit -m "Say what is wired now that the thread has actually run"
```

---

## Self-Review

**Spec coverage.** Every component in the approved design has a task: ramp reader → Task 1; plan body loader → Task 2; notifier threading → Task 3; runtime assembly → Task 4; runner → Task 5; scheduler wiring → Task 6; seed command → Task 7. The approved "prove it against a local mailbox with no test-only code" is Task 7 Step 5 and Task 8 Step 1. The required `/security-review` is Task 8 Step 2.

**Placeholder scan.** No TBDs. Three implementer notes flag facts to confirm against the codebase (`buildCharter` overrides that queue an approval, `browserAdapter`'s export form, `activeCharterVersion`'s signature) rather than leaving behaviour unspecified — each names the file to check and what to do either way.

**Type consistency.** `Runtime` is defined in Task 4 and consumed by name in Tasks 5 and 6. `RunDueResult`/`RanJob` are defined in Task 5 and consumed in Task 6. `StoredPlanBody`/`loadPlanBody` are defined in Task 2 and consumed in Tasks 5 and 7. `loadRampLevel`/`setRampLevel`/`rampLevelForPlan` are defined in Task 1 and consumed in Tasks 5 and 7. `notify: { notifier; dashboardBaseUrl }` has the same shape in `GateContext`, `StepRequest`, `RunPlanRequest` and `Runtime`.

**Known gap, deliberately not closed.** `counterpartyTags` is `[]` throughout. A resolver is stage 1 work; `[]` is the honest statement that nobody resolved tags, and `CLAUDE.md` requires it be written rather than omitted.
