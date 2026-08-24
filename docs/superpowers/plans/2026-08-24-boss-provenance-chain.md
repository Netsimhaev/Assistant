# Per-Step Provenance Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the first-contact exemption reachable — a step may declare its instruction boss-derived only when the job's provenance is `boss`, its plan contains no content-ingesting step, and the job has never ingested external content.

**Architecture:** A positive `Record<string, boolean>` names every tool that pulls outside content into the agent's context. A monotonic `jobs.content_ingested` flag remembers that a job has touched such content — set *before* the read, never cleared. `runPlan` combines the three conditions into one boolean per step and passes it through `StepRequest` into `GateContext`; `buildFacts` already reads it from there, so no change is needed inside the gate itself.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` in every relative import), Postgres 17 via `pg`, zod, vitest against a real `assistant_test` database.

**Spec:** [docs/superpowers/specs/2026-08-24-boss-provenance-chain-design.md](../specs/2026-08-24-boss-provenance-chain-design.md) — approved by the owner on 2026-08-24. **Read it before Task 1**; §5.1 carries the tool-by-tool decisions with their reasoning, and this plan does not repeat them.

## Global Constraints

- **`.js` in every relative import**, including from `.ts` files (NodeNext + `"type": "module"`).
- **`noUncheckedIndexedAccess`** — `rows[0]?.x`, never `rows[0].x`.
- **`exactOptionalPropertyTypes`** — never assign `undefined` to an optional property; use conditional spread.
- **`verbatimModuleSyntax`** — `import type` for types, plain `import` for values, never mixed.
- **`noUnusedLocals` / `noUnusedParameters`** are on.
- **DB convention:** private `interface XRow` + `toX(row)`; SQL `snake_case`, TypeScript `camelCase`.
- **Hebrew for humans, English for code.** Rejection messages and docs in Hebrew; identifiers, comments and internal errors in English.
- **Controls are written positively.** A `Record<string, boolean>` over a `Set`, so a new tool is a compile error rather than a silent default. **A value that could not be read is never a permissive value.**
- **Tests need a real Postgres.** `.env` is present; `npm test` is wired to `TEST_DATABASE_URL`. No mocks.
- **`npm run typecheck` and `npm test` must both pass before any task is reported done.** The suite stands at **596 passing** at the start of this plan.
- **`/security-review` is mandatory at the end** — this plan adds a migration and changes when a safety control fires.

### Canonical test setup — verified, use these

The inline setup below is verified against `src/orchestrator/run-due.test.ts` and `src/orchestrator/external.test.ts`. If any helper signature disagrees with the source, **the source wins**.

```ts
// installCharter returns the PolicyBundle DIRECTLY — no { charterVersion, bundle }
// destructuring, no `actor` option. The version is bundle.charterVersion.
const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
  businessId: BUSINESS,
});

// A job reaches `execute` via intake → understand → plan → execute.
// There is no intake → plan edge. `actor` is a JobActor:
// 'orchestrator' | 'human' | 'system' | <AgentId>. 'test' is NOT valid.
for (const to of ['understand', 'plan', 'execute'] as const) {
  await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
}

// upsertBinding's options take `by` (REQUIRED), not `actor`.
await upsertBinding({ system: 'office-mail', status: 'live', endpoint: null,
  credentialRef: 'OFFICE_MAIL', lastOkAt: null, lastError: null },
  { businessId: BUSINESS, by: 'test' });
```

**Use a fixed clock in every test that reaches the gate.** `const NOON = new Date('2026-08-18T09:00:00.000Z')`, threaded via the `now` option. An earlier plan hit a real flake: without it, an evening run fell into quiet hours and silently changed a test's meaning.

**`ActionClass` has no `email.send`.** The outbound classes are `email.reply` and `email.initiate`.

---

### Task 1: The content-ingesting tool table

**Files:**
- Modify: `src/policy/classify.ts`
- Test: `src/policy/ingest-table.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function ingestsExternalContent(toolName: string): boolean`

- [ ] **Step 1: Read the spec's §5.1 and transcribe its decisions**

Open `docs/superpowers/specs/2026-08-24-boss-provenance-chain-design.md` §5.1. It classifies all 64 tools with a reason per group. **Transcribe those decisions exactly.** Do not re-derive them and do not add tools it does not name — if you believe a decision is wrong, implement the spec and say so in your report.

- [ ] **Step 2: Write the failing test**

Create `src/policy/ingest-table.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CLASSIFIED_TOOLS, READ_ONLY_TOOLS } from './classify.js';
import { ingestsExternalContent } from './classify.js';

describe('the content-ingesting table', () => {
  it('covers every tool the system knows about', () => {
    // A tool in neither bucket would default to "does not ingest" — the
    // permissive answer — which is exactly what this project forbids.
    const known = [...CLASSIFIED_TOOLS, ...READ_ONLY_TOOLS];
    const uncovered = known.filter((t) => ingestsExternalContent(t) === undefined as unknown as boolean);
    expect(uncovered).toEqual([]);
  });

  it('treats an unknown tool as ingesting', () => {
    // Fail-safe: a name nobody classified must not buy an exemption.
    expect(ingestsExternalContent('some.tool.invented.later')).toBe(true);
  });

  it('classifies the browser surface as ingesting, all of it', () => {
    for (const t of ['browser.navigate', 'browser.snapshot', 'browser.screenshot',
                     'browser.click', 'browser.fill', 'browser.submit_order']) {
      expect(ingestsExternalContent(t), t).toBe(true);
    }
  });

  it('classifies stored-content readers as ingesting', () => {
    // Provenance travels with a stored chunk forever (docs/06-memory.md), so
    // recall is a read of possibly-untrusted content however old it is.
    for (const t of ['memory.recall', 'memory.recall_shallow', 'doc.fetch',
                     'crm.read', 'accounting.read', 'calendar.read', 'tasks.read',
                     'artifact.read', 'recipe.load', 'media.inspect', 'code_execution',
                     'calendar.propose_slots']) {
      expect(ingestsExternalContent(t), t).toBe(true);
    }
  });

  it('does not classify local composition or outbound writes as ingesting', () => {
    for (const t of ['mail.draft', 'mail.send', 'template.render', 'render.markdown',
                     'chart.render', 'charter.read', 'charter.voice', 'norms.query',
                     'schema.map', 'assert.evaluate', 'escalate_to_human',
                     'wa.conversation_state', 'credential.request_session',
                     'calendar.write', 'crm.write', 'file.write']) {
      expect(ingestsExternalContent(t), t).toBe(false);
    }
  });
});
```

> **Note for the implementer:** the first test needs `CLASSIFIED_TOOLS` — a list of the keys of `TOOL_ACTION_CLASS`. `classify.ts` already exports something for the reachability invariant (see the comment "Every tool that maps to an action class"). Use whatever it actually exports; if the export has a different name, use that name and say so in your report. Do not add a new export if a suitable one exists.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/policy/ingest-table.test.ts`
Expected: FAIL — `ingestsExternalContent` is not exported.

- [ ] **Step 4: Write the implementation**

In `src/policy/classify.ts`, add after the read-only list:

```ts
/**
 * Tools that pull content from outside the instance's trust boundary into the
 * agent's context, where it could influence a later action.
 *
 * This is the input to the first-contact exemption: a job that has run any of
 * these can no longer claim its instruction came from the boss alone, because
 * the recipient or the wording may have been chosen by whoever wrote the
 * content. See `docs/superpowers/specs/2026-08-24-boss-provenance-chain-design.md`
 * §5.1 for the per-tool reasoning.
 *
 * A `Record<string, boolean>` and not a `Set`, for the reason
 * `NEVER_FULLY_AUTONOMOUS_TABLE` gives: a `Set` is maintained by hand and says
 * nothing when the tool list grows, so a newly added reader would land
 * silently outside the check. Every tool is written down with an explicit
 * answer.
 */
const INGESTS_EXTERNAL_CONTENT: Record<string, boolean> = {
  // — reads that bring in someone else's words —
  'doc.fetch': true,
  'browser.navigate': true,
  'browser.snapshot': true,
  'browser.screenshot': true,
  'browser.click': true,
  'browser.fill': true,
  'browser.submit_order': true,
  'crm.read': true,
  'accounting.read': true,
  'calendar.read': true,
  'calendar.propose_slots': true,
  'memory.recall': true,
  'memory.recall_shallow': true,
  'tasks.read': true,
  'artifact.read': true,
  'recipe.load': true,
  'media.inspect': true,
  'code_execution': true,

  // — local composition, owner-authored data, and outbound writes —
  'mail.draft': false,
  'charter.voice': false,
  'charter.read': false,
  'charter.evaluate': false,
  'charter.propose_amendment': false,
  'template.render': false,
  'template.load': false,
  'wa.can_send_freeform': false,
  'wa.conversation_state': false,
  'render.markdown': false,
  'chart.render': false,
  'tasks.update_state': false,
  'followup.schedule': false,
  'schema.map': false,
  'norms.query': false,
  'assert.evaluate': false,
  'recipe.save': false,
  'media.generate_image': false,
  'media.generate_video': false,
  'brand.check': false,
  'escalate_to_human': false,
  'agent.request_help': false,
  'mail.send': false,
  'wa.send_message': false,
  'calendar.write': false,
  'crm.write': false,
  'accounting.write': false,
  'credential.request_session': false,
  'payment.charge': false,
  'refund.issue': false,
  'quote.issue': false,
  'discount.grant': false,
  'commitment.make': false,
  'contract.sign': false,
  'data.export': false,
  'media.publish': false,
  'file.write': false,
  'doc.deliver': false,
  'memory.write_entity': false,
  'memory.write_chunk': false,
  'memory.upsert_preference': false,
  'memory.retire': false,
  'charter.apply_amendment': false,
};

/**
 * Whether running this tool means the job has touched outside content.
 *
 * **An unknown tool answers `true`.** A name nobody classified is a name
 * nobody reasoned about, and the exemption this feeds must read that as "we
 * cannot vouch for this chain" — never as "nothing was read". The `?? true`
 * is the whole fail-safe.
 */
export function ingestsExternalContent(toolName: string): boolean {
  return INGESTS_EXTERNAL_CONTENT[toolName] ?? true;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/policy/ingest-table.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck
npm test
git add src/policy/classify.ts src/policy/ingest-table.test.ts
git commit -m "Name every tool that brings outside content in, and default unknown ones to yes"
```

---

### Task 2: The monotonic job flag

**Files:**
- Create: `src/db/migrations/011_job_content_ingested.sql`
- Modify: `src/orchestrator/jobs.ts`
- Test: `src/orchestrator/content-ingested.test.ts`

**Interfaces:**
- Consumes: `Job`, `createJob`, `loadJob` from `src/orchestrator/jobs.js`.
- Produces:
  - `Job.contentIngested: boolean` (a required field on the interface)
  - `markContentIngested(jobId: string, options?: { businessId?: string; db?: Queryable }): Promise<void>`

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/011_job_content_ingested.sql`:

```sql
-- Whether this job has ever pulled content from outside the instance's trust
-- boundary. Monotonic: set to true before such a read is performed, and never
-- cleared.
--
-- It exists because `provenance` is stamped once on the job and inherited by
-- every step, so a job the boss opened still reads as `boss` after a step has
-- fetched an attacker-authored document. The first-contact exemption
-- (src/policy/risk.ts) must not fire for such a job, and the plan currently
-- bound is not enough to tell: a re-plan after the read produces a plan that
-- contains no reader at all.
--
-- Set BEFORE the read, not after. A crash between the read and the write would
-- otherwise leave a job that ingested content and does not remember it, which
-- is the one direction that hands out an exemption nobody earned.
ALTER TABLE jobs
    ADD COLUMN content_ingested BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 2: Write the failing test**

Create `src/orchestrator/content-ingested.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, loadJob, markContentIngested } from './jobs.js';

const BUSINESS = 'test-business';

async function newJob(): Promise<string> {
  const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
  });
  return job.jobId;
}

describe('the content-ingested flag', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('starts false on a new job', async () => {
    const jobId = await newJob();
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.contentIngested).toBe(false);
  });

  it('is true after marking', async () => {
    const jobId = await newJob();
    await markContentIngested(jobId, { businessId: BUSINESS });
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.contentIngested).toBe(true);
  });

  it('is idempotent — marking twice leaves it true', async () => {
    const jobId = await newJob();
    await markContentIngested(jobId, { businessId: BUSINESS });
    await markContentIngested(jobId, { businessId: BUSINESS });
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.contentIngested).toBe(true);
  });

  it('does not mark another business’s job', async () => {
    const jobId = await newJob();
    await markContentIngested(jobId, { businessId: 'other-business' });
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.contentIngested).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/content-ingested.test.ts`
Expected: FAIL — `markContentIngested` is not exported.

- [ ] **Step 4: Write the implementation**

In `src/orchestrator/jobs.ts`: add `contentIngested: boolean;` to `Job`, add `content_ingested: boolean;` to `JobRow`, and map it in `toJob` as `contentIngested: row.content_ingested`. `createJob` and every other `SELECT *` picks the column up with no further change — **verify that each query in the file really is `SELECT *` or explicitly lists columns**, and add the column where a list is explicit.

Then append:

```ts
/**
 * Record that this job has pulled content from outside the instance.
 *
 * One-way. There is no unmark, deliberately: a job that has read an
 * attacker-authored document does not become clean again, and the first-contact
 * exemption must stay off for the rest of its life.
 *
 * Called BEFORE the read runs. The window it protects is a crash between the
 * external call and this write — in that window the read happened and nothing
 * remembers it, and the next run would hand out an exemption nobody earned.
 * Marking early can only over-restrict, which is the safe direction.
 */
export async function markContentIngested(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const db = options.db ?? getPool();
  await db.query(
    `UPDATE jobs SET content_ingested = true, updated_at = now()
      WHERE job_id = $1 AND business_id = $2`,
    [jobId, options.businessId ?? config.businessId],
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run `npm run migrate:test` first if the suite does not migrate automatically, then:
Run: `npx vitest run src/orchestrator/content-ingested.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Typecheck, full suite, commit**

The `Job` interface gained a required field — every construction site must supply it. Run the whole suite.

```bash
npm run typecheck
npm test
git add src/db/migrations/011_job_content_ingested.sql src/orchestrator/jobs.ts src/orchestrator/content-ingested.test.ts
git commit -m "A job remembers, permanently, that it touched outside content"
```

---

### Task 3: Thread the signal through the executor, and set the flag

**Files:**
- Modify: `src/orchestrator/execute.ts`
- Test: `src/orchestrator/executor-provenance.test.ts`

**Interfaces:**
- Consumes: `ingestsExternalContent` (Task 1), `markContentIngested` (Task 2).
- Produces: `StepRequest.provenanceChainDerived?: boolean`

**Two changes, and they are independent:**

1. **Pass the caller's claim to the gate.** Add the optional field to `StepRequest` and forward it into the `evaluateToolCall` context with a conditional spread, exactly as `approval` and `notify` are forwarded. `GateContext extends FactsContext`, and `FactsContext` already declares `provenanceChainDerived?: boolean`, so **no change is needed inside `engine.ts` or `facts.ts`** — verify that yourself before touching either.

2. **Set the flag before an ingesting step performs.** After the gate has returned `allow` and immediately before `request.perform(...)` is called, if `ingestsExternalContent(toolName)` then `await markContentIngested(job.jobId, { businessId: job.businessId })`. Before, not after — see the migration comment.

**Delete the stale comment.** `execute.ts` currently carries a comment beginning "`provenanceChainDerived` is NOT set here" that explains why the executor cannot honour the signal. That reasoning is superseded by this plan — the caller now computes it from the plan and the job. Replace it with a comment saying the value is the caller's claim and naming what `runPlan` checks before making it.

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/executor-provenance.test.ts`. It drives `executeStep` directly with a recording `perform`.

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, loadJob, transition } from './jobs.js';
import { executeStep } from './execute.js';

const BUSINESS = 'test-business';
const NOON = new Date('2026-08-18T09:00:00.000Z');

async function jobInExecute() {
  const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return { job: loaded, bundle };
}

describe('the executor and the provenance signal', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('marks the job as having ingested content when the tool reads', async () => {
    const { job, bundle } = await jobInExecute();

    await executeStep({
      job,
      stepId: 's1',
      agent: 'know.reader',
      bundle,
      toolName: 'doc.fetch',
      toolInput: { uri: 'https://example.com/doc' },
      perform: async () => ({ output: 'text', externalId: null }),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.contentIngested).toBe(true);
  });

  it('leaves the flag alone for a tool that does not read', async () => {
    const { job, bundle } = await jobInExecute();

    await executeStep({
      job,
      stepId: 's1',
      agent: 'comms.email',
      bundle,
      toolName: 'mail.send',
      toolInput: { to: 'dana@example.com', subject: 's', body: 'b', counterpartyId: 'c_812' },
      perform: async () => ({ output: null, externalId: 'MSG-1' }),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.contentIngested).toBe(false);
  });
});
```

> **Note for the implementer:** `know.reader` must actually own `doc.fetch` in `src/charter/capabilities.ts` for the first test to reach `perform`. Check it; the capabilities table shows `'know.reader': ['doc.fetch', 'code_execution', 'memory.recall']`. If the gate refuses for an unrelated reason, fix the test's agent or input — **not** by weakening the assertion. `counterpartyId: 'c_812'` in the second test matches the known counterparty in `src/test/fixtures.ts`; verify it before relying on it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/executor-provenance.test.ts`
Expected: FAIL — the flag stays `false` for `doc.fetch`.

- [ ] **Step 3: Write the implementation**

Make both changes described above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/orchestrator/executor-provenance.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck
npm test
git add src/orchestrator/execute.ts src/orchestrator/executor-provenance.test.ts
git commit -m "The executor records a read before it happens, and carries the caller's claim to the gate"
```

---

### Task 4: Compute the claim in runPlan

**Files:**
- Modify: `src/orchestrator/run-plan.ts`
- Test: `src/orchestrator/plan-provenance.test.ts`

**Interfaces:**
- Consumes: `ingestsExternalContent` (Task 1), `Job.contentIngested` (Task 2), `StepRequest.provenanceChainDerived` (Task 3).
- Produces: nothing new exported. `runPlan` computes the boolean once and passes it to every step.

**The computation, once per run, before the step loop:**

```ts
// The three conditions of the spec, combined positively. Computed once for
// the whole plan rather than per step: a plan that reads anything was
// authored by a planner that had read it, so ordering within the plan says
// nothing about which steps the content could have influenced.
const planIngests = plan.steps.some((step) => ingestsExternalContent(step.toolName));
const provenanceChainDerived =
  job.provenance === 'boss' && !planIngests && !job.contentIngested;
```

Pass it into every `executeStep` call with a conditional spread. Do **not** pass `false` explicitly where the field is optional — a conditional spread keeps `exactOptionalPropertyTypes` happy and keeps "absent" meaning "no claim".

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/plan-provenance.test.ts`. It asserts the *observable* effect — whether the gate queues an approval — rather than the boolean itself, because the boolean is not exported.

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, markContentIngested, transition } from './jobs.js';
import { runPlan } from './run-plan.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';
const NOON = new Date('2026-08-18T09:00:00.000Z');

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail', label: 'תיבת המשרד', channel: 'api',
  serves: ['mail.send'], target: null, subprocessor: null,
};

const LIVE: ConnectionBinding = {
  system: 'office-mail', status: 'live', endpoint: null,
  credentialRef: 'OFFICE_MAIL', lastOkAt: null, lastError: null,
};

/** One step, to a stranger, with nothing read. The live thread's own plan. */
const SEND_ONLY: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [{
    id: 's1', agent: 'comms.email', intent: 'send',
    toolName: 'mail.send',
    input: { to: 'stranger@example.com', subject: 'הצעה', body: 'שלום' },
    expectedActionClass: 'email.initiate',
  }],
});

function registry(sent: MailMessage[]): AdapterRegistry {
  return new AdapterRegistry([
    createMailAdapter({
      system: 'office-mail',
      transport: { async send(m) { sent.push(m); return { messageId: 'MSG-1' }; } },
    }),
  ]);
}

async function jobInExecute(bundle: { charterVersion: string }) {
  const job = await createJob({
    charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

/**
 * The charter must permit the class, or its own ceiling forces an approval
 * regardless of the exemption — see the spec's §6. This is the charter change
 * the owner would make in production, expressed as a test override.
 */
function permissiveCharter() {
  return buildCharter({
    connections: [MAIL_CONNECTION],
    autonomyBase: { 'email.initiate': 'auto' },
  });
}

describe('the boss exemption, end to end through runPlan', () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await closePool(); });

  it('sends without an approval when the boss instructed it and nothing was read', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);
    const sent: MailMessage[] = [];

    const result = await runPlan({
      job, bundle, plan: SEND_ONLY, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    expect(result.status).toBe('done');
    expect(sent).toHaveLength(1);
  });

  it('still asks when the job has already ingested content', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);
    await markContentIngested(job.jobId, { businessId: BUSINESS });
    const fresh = await loadJob(job.jobId, { businessId: BUSINESS });
    if (fresh === null) throw new Error('job vanished');
    const sent: MailMessage[] = [];

    const result = await runPlan({
      job: fresh, bundle, plan: SEND_ONLY, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    expect(result.status).toBe('halted');
    expect(sent).toEqual([]);
  });

  it('still asks when the plan itself contains a reader, even after the send step', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);
    const sent: MailMessage[] = [];

    // The reader comes SECOND. Execution order must not matter: the planner
    // that wrote step 1 is the same planner that had read for step 2.
    const readAfter: Plan = Plan.parse({
      goal: 'send then read',
      steps: [
        SEND_ONLY.steps[0],
        { id: 's2', agent: 'know.reader', intent: 'read', toolName: 'doc.fetch',
          input: { uri: 'https://example.com/d' }, dependsOn: ['s1'],
          expectedActionClass: null },
      ],
    });

    const result = await runPlan({
      job, bundle, plan: readAfter, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    expect(result.status).toBe('halted');
    expect(sent).toEqual([]);
  });

  it('still asks when the job did not come from the boss', async () => {
    const bundle = await installCharter(permissiveCharter(), { businessId: BUSINESS });
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'unknown_external',
      businessId: BUSINESS,
    });
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }
    const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
    if (loaded === null) throw new Error('job vanished');
    const sent: MailMessage[] = [];

    const result = await runPlan({
      job: loaded, bundle, plan: SEND_ONLY, registry: registry(sent), bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [], rampLevel: 'auto', now: NOON,
    });

    expect(result.status).toBe('halted');
    expect(sent).toEqual([]);
  });
});
```

> **Note for the implementer:** the third test's second step must be a legal plan — `planStepIsFeasible` checks the agent owns the tool, and a local step needs no channel. If `know.reader` + `doc.fetch` is rejected for a reason unrelated to this feature, adjust the step so the plan is valid, and say what you changed. The assertion that matters is that the send does **not** go out.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/plan-provenance.test.ts`
Expected: the first test FAILS (`halted`, nothing sent) because the exemption never fires today. The other three should already pass — they assert today's behaviour, and they are the regression net.

- [ ] **Step 3: Write the implementation**

Add the computation and the conditional spread.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/orchestrator/plan-provenance.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prove it bites**

Temporarily change the computation to `const provenanceChainDerived = true;`. Confirm tests 2, 3 and 4 FAIL. Restore it. **Report the exact failure output.** A control that cannot be shown to fail when disabled has not been tested.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck
npm test
git add src/orchestrator/run-plan.ts src/orchestrator/plan-provenance.test.ts
git commit -m "A step may claim the boss instructed it, when all three conditions hold"
```

---

### Task 5: Lock the matrix, document, and review

**Files:**
- Modify: `src/policy/positive-controls.test.ts`
- Modify: `CLAUDE.md`
- Modify: `docs/05-approvals.md`

- [ ] **Step 1: Extend the positive-controls matrix**

`positive-controls.test.ts` already has `firstContactFacts(provenance, chainDerived)` and a loop over `TrustLevel.options` asserting `boss` → `routine` and everything else → `sensitive` when the signal is on. Read it before editing.

Add a second loop that asserts the **other** direction across the same enum: with `chainDerived = false`, **every** TrustLevel including `boss` scores `sensitive`. Both directions must be locked, so that neither the exemption widening nor the signal becoming default-on can pass silently.

```ts
it('scores every TrustLevel as sensitive when the chain was not derived', async () => {
  const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
  // The signal's absence is what holds the exemption shut. If a future change
  // makes it default to true, this loop is what fails.
  for (const level of TrustLevel.options) {
    const risk = await assessRisk(firstContactFacts(level, false), bundle);
    expect(risk.band, `provenance=${level}`).toBe('sensitive');
  }
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/policy/positive-controls.test.ts`
Expected: PASS.

- [ ] **Step 3: Document the rule in `CLAUDE.md`**

The existing entry in "כללים שהקוד אוכף בשקט" says the exemption "אינו נדלק בפועל" and that no caller sets the signal. **That is now false.** Rewrite it, in the same dense voice as its neighbours, to say:

- the three conditions, positively;
- that an unknown tool counts as ingesting (`?? true` is the fail-safe);
- that the job flag is monotonic and set **before** the read, and why that direction;
- that the plan-level check ignores step order, because the planner read before it wrote any step;
- that the exemption only removes the risk-band escalation and the charter's own ceiling still governs — so this alone does not remove an approval.

- [ ] **Step 4: Document the owner-facing half in `docs/05-approvals.md`**

Add a short Hebrew section: when a boss instruction is itself the approval, what voids it, and that the charter's baseline autonomy for the class must also permit it. This is the half the owner controls and it is not code.

- [ ] **Step 5: Run the security review**

Mandatory: this plan adds a migration and changes when a safety control fires.

Run: `/security-review`
Address anything it finds before Step 6.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck
npm test
git add src/policy/positive-controls.test.ts CLAUDE.md docs/05-approvals.md
git commit -m "Lock both directions of the exemption, and say what it does not do"
```

---

## Self-Review

**Spec coverage.** §3's rule → Task 4's computation. §4's two layers → the `planIngests` check (Task 4) and the job flag (Tasks 2–3). §5.1's table → Task 1. §5.2's flag → Task 2, with the before-the-read ordering in Task 3. §5.3's plumbing → Task 3; the gate needs no change because `GateContext extends FactsContext`, which the plan states and asks the implementer to verify. §5.4's "runPlan computes" → Task 4. §6's caveat → documented in Tasks 4 (`permissiveCharter`) and 5. §7's five test groups → Task 1 (table completeness), Task 2 (monotonic), Task 3 (executor), Task 4 (matrix + plan-level + end-to-end), Task 5 (both directions). §8's security review → Task 5.

**Placeholder scan.** No TBDs. Four implementer notes name a fact to verify against source and say what to do either way, rather than leaving behaviour unspecified.

**Type consistency.** `ingestsExternalContent(toolName: string): boolean` is defined in Task 1 and consumed by name in Tasks 3 and 4. `Job.contentIngested` and `markContentIngested` are defined in Task 2 and consumed in Tasks 3 and 4. `StepRequest.provenanceChainDerived` is defined in Task 3 and consumed in Task 4. `FactsContext.provenanceChainDerived` already exists and is unchanged.

**Known gap, deliberately not closed.** `counterpartyTags` remains `[]` on the production path; a tag resolver is separate work. It does not interact with this feature — an unresolved counterparty is what makes the audience `one_unknown` in the first place, which is exactly the case this exemption is about.
