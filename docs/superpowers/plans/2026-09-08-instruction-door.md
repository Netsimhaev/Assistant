# The Instruction Door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner types an instruction into the dashboard and the assistant carries it out, without asking again about what was already asked for.

**Architecture:** A text box on the dashboard opens a job stamped `boss`, hands the instruction straight to the existing planner, validates the plan through the three gates that already exist, grants a standing authorisation scoped to recipients the owner either named verbatim or the charter already knows, binds the plan, and lets the scheduler run it. The authorisation cancels only the risk-band term of the approval question — money, five named classes, and the charter's own ceiling all still stop.

**Tech Stack:** TypeScript (NodeNext ESM), Postgres 17 via `pg`, zod, vitest against a real database, the Agent SDK for the one model call.

**Spec:** [docs/superpowers/specs/2026-09-08-instruction-door-design.md](../specs/2026-09-08-instruction-door-design.md)

## Global Constraints

- `.js` extension on every relative import, including from `.ts` files (NodeNext + `"type": "module"`).
- `import type` for type-only imports (`verbatimModuleSyntax`).
- Conditional spread for optional properties: `opts.db !== undefined ? { db: opts.db } : {}` (`exactOptionalPropertyTypes`).
- `rows[0]?.x` — never `rows[0].x` (`noUncheckedIndexedAccess`).
- Hebrew for anything the owner reads; English for identifiers, comments, and audit reasons.
- Every module reading DB rows: a private `interface XRow` plus a `toX(row)`. SQL `snake_case`, TS `camelCase`.
- **A control is written in the positive, never as everything-except-X.** This plan has two such lists and both are load-bearing.
- Instruction length cap: **4,000 characters**, checked before a job is opened and before any model call.
- A test that still passes when the code it covers is deleted is not a test.
- Tests need a real Postgres. Never run the full `npm test` while another run is active — a `tx.query` failure inside `withTransaction`, a row that comes back `undefined` right after being written, an "unknown job" for a job just created, or a duplicate-key violation you did not cause is a collision: wait, re-run, and say you did.

## Controller ruling recorded before execution

**The class allowlist in Task 3 gates the whole grant, not only the typed half.** Spec §5.2 introduces the allowlist while discussing typed recipients, which leaves it arguable whether a *known* counterparty escapes it. It does not. The spec's own stated intent for the restriction — "one stop where a mistake costs the most: a purchase, a commitment, a quote, a discount" — applies at least as strongly to a supplier already on file, since that is precisely who a purchase would go to. Reading it the other way would let a purchase from a known supplier run unasked, which no section of the spec asks for.

---

### Task 1: The instruction record

**Files:**
- Create: `src/db/migrations/022_boss_instructions.sql`
- Create: `src/governance/instructions.ts`
- Test: `src/governance/instructions.test.ts`

**Interfaces:**
- Consumes: `jobs` (migration 001).
- Produces:
  - `MAX_INSTRUCTION_CHARS = 4000`
  - `saveInstruction(input: { jobId: string; text: string }, options?: { businessId?: string; db?: Queryable }): Promise<InstructionRecord>`
  - `recordAnswer(instructionId: string, answer: string, options?: { businessId?: string; db?: Queryable }): Promise<void>`
  - `loadInstructionForJob(jobId: string, options?: { businessId?: string; db?: Queryable }): Promise<InstructionRecord | null>`
  - `InstructionRecord = { instructionId: string; businessId: string; jobId: string; text: string; answer: string | null; createdAt: string }`

- [ ] **Step 1: Write the migration**

```sql
-- 022_boss_instructions.sql
--
-- What the owner typed, kept beside the job it opened.
--
-- A table rather than a column on `jobs`, for two reasons. `jobs.title` is a
-- display field and an instruction is a paragraph. And this row is the evidence
-- the standing authorisation was derived from — it has to be readable back
-- alongside the audit trail, not compressed into a label.
--
-- `job_id` is UNIQUE: one instruction opens one job, and a second instruction
-- is a second job. Without the constraint, "the instruction for this job"
-- would be a question with more than one answer.

CREATE TABLE boss_instructions (
    instruction_id TEXT        PRIMARY KEY,
    business_id    TEXT        NOT NULL,
    job_id         TEXT        NOT NULL UNIQUE REFERENCES jobs (job_id) ON DELETE CASCADE,
    -- Verbatim, as typed. Never reformatted: the recipient rule in
    -- `authorisedRecipients` matches against exactly these bytes.
    text           TEXT        NOT NULL,
    -- The owner's reply to a clarifying question, when one was asked.
    -- Stored beside the instruction and never in place of it, so the re-plan
    -- sees both and the audit trail shows what was asked and what was answered.
    answer         TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT boss_instructions_text_not_empty CHECK (length(btrim(text)) > 0),
    CONSTRAINT boss_instructions_text_bounded   CHECK (length(text) <= 4000)
);

CREATE INDEX boss_instructions_business_idx ON boss_instructions (business_id, created_at DESC);
```

- [ ] **Step 2: Run the migration on both databases**

```bash
npm run migrate
npm run migrate:test
```

- [ ] **Step 3: Write the failing tests**

Create `src/governance/instructions.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { createJob } from '../orchestrator/jobs.js';
import {
  MAX_INSTRUCTION_CHARS,
  loadInstructionForJob,
  recordAnswer,
  saveInstruction,
} from './instructions.js';

const BUSINESS = 'test-business';

async function aBossJob(): Promise<string> {
  const charter = buildCharter();
  await installCharter(charter, { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: charter.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'הוראה',
  });
  return job.jobId;
}

describe('the instruction record', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('stores the text verbatim and reads it back by job', async () => {
    const jobId = await aBossJob();
    // Trailing spaces and an inner newline are kept: the recipient rule
    // matches against these exact bytes, so normalising here would silently
    // change what counts as "named in the instruction".
    const text = 'תשלחי לדנה  \ndana@example.com את ההצעה';

    const saved = await saveInstruction({ jobId, text }, { businessId: BUSINESS });
    const read = await loadInstructionForJob(jobId, { businessId: BUSINESS });

    expect(saved.text).toBe(text);
    expect(read?.text).toBe(text);
    expect(read?.answer).toBeNull();
    expect(read?.instructionId).toBe(saved.instructionId);
  });

  it('records an answer beside the instruction, not in place of it', async () => {
    const jobId = await aBossJob();
    const saved = await saveInstruction(
      { jobId, text: 'תשלחי לדנה את ההצעה' },
      { businessId: BUSINESS },
    );

    await recordAnswer(saved.instructionId, 'דנה כהן, dana@example.com', {
      businessId: BUSINESS,
    });

    const read = await loadInstructionForJob(jobId, { businessId: BUSINESS });
    expect(read?.text).toBe('תשלחי לדנה את ההצעה');
    expect(read?.answer).toBe('דנה כהן, dana@example.com');
  });

  it('refuses an empty instruction', async () => {
    const jobId = await aBossJob();
    await expect(
      saveInstruction({ jobId, text: '   ' }, { businessId: BUSINESS }),
    ).rejects.toThrow();
  });

  it('refuses an instruction past the cap', async () => {
    const jobId = await aBossJob();
    const tooLong = 'א'.repeat(MAX_INSTRUCTION_CHARS + 1);
    await expect(
      saveInstruction({ jobId, text: tooLong }, { businessId: BUSINESS }),
    ).rejects.toThrow();
  });

  it('never returns another business\'s instruction', async () => {
    const jobId = await aBossJob();
    await saveInstruction({ jobId, text: 'תשלחי לדנה' }, { businessId: BUSINESS });
    expect(await loadInstructionForJob(jobId, { businessId: 'someone-else' })).toBeNull();
  });

  it('refuses a second instruction on the same job', async () => {
    const jobId = await aBossJob();
    await saveInstruction({ jobId, text: 'ראשונה' }, { businessId: BUSINESS });
    await expect(
      saveInstruction({ jobId, text: 'שנייה' }, { businessId: BUSINESS }),
    ).rejects.toThrow();
    const { rows } = await getPool().query(`SELECT 1 FROM boss_instructions`);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run the tests and watch them fail**

Run: `npx vitest run src/governance/instructions.test.ts`
Expected: FAIL — cannot find module `./instructions.js`.

- [ ] **Step 5: Implement the store**

Create `src/governance/instructions.ts`:

```ts
/**
 * What the owner typed, and the answer they gave when asked to clarify.
 *
 * The text is stored byte-for-byte as submitted. `authorisedRecipients`
 * (`src/governance/typed-recipients.ts`) matches candidate addresses against
 * exactly these bytes, so trimming or normalising here would quietly change
 * which recipients count as named by the owner.
 */
import { ulid } from 'ulid';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';

/** Enforced here and by a CHECK constraint, so neither path can drift alone. */
export const MAX_INSTRUCTION_CHARS = 4000;

export interface InstructionRecord {
  instructionId: string;
  businessId: string;
  jobId: string;
  text: string;
  answer: string | null;
  createdAt: string;
}

interface InstructionRow {
  instruction_id: string;
  business_id: string;
  job_id: string;
  text: string;
  answer: string | null;
  created_at: string;
}

function toInstruction(row: InstructionRow): InstructionRecord {
  return {
    instructionId: row.instruction_id,
    businessId: row.business_id,
    jobId: row.job_id,
    text: row.text,
    answer: row.answer,
    createdAt: row.created_at,
  };
}

const COLUMNS = 'instruction_id, business_id, job_id, text, answer, created_at::text AS created_at';

export async function saveInstruction(
  input: { jobId: string; text: string },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<InstructionRecord> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  // Checked here as well as in the CHECK constraint. The constraint is the
  // one that cannot be bypassed; this one gives a message in the owner's
  // language instead of a Postgres error string.
  if (input.text.trim().length === 0) {
    throw new Error('ההוראה ריקה');
  }
  if (input.text.length > MAX_INSTRUCTION_CHARS) {
    throw new Error(
      `ההוראה ארוכה מ-${MAX_INSTRUCTION_CHARS} תווים (${input.text.length}). ` +
        'תיבת ההוראות אינה המקום להדביק מסמך שלם — לתיקיית הקליטה יש מסלול משלה.',
    );
  }

  const { rows } = await db.query<InstructionRow>(
    `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [`INS-${ulid()}`, businessId, input.jobId, input.text],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('instruction insert returned no row');
  return toInstruction(row);
}

export async function recordAnswer(
  instructionId: string,
  answer: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  await db.query(
    `UPDATE boss_instructions SET answer = $3
      WHERE instruction_id = $1 AND business_id = $2`,
    [instructionId, businessId, answer],
  );
}

export async function loadInstructionForJob(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<InstructionRecord | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<InstructionRow>(
    `SELECT ${COLUMNS} FROM boss_instructions
      WHERE job_id = $1 AND business_id = $2`,
    [jobId, businessId],
  );
  const row = rows[0];
  return row === undefined ? null : toInstruction(row);
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/governance/instructions.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Prove the business scoping bites**

Delete `AND business_id = $2` from `loadInstructionForJob`, re-run, confirm `never returns another business's instruction` fails, restore. Redirect both runs to `task-1-mut-fail.txt` / `task-1-mut-pass.txt` with `2>&1`.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add -A && git commit -m "What the owner typed, kept beside the job it opened"
```

---

### Task 2: The planner accepts an instruction

**Files:**
- Modify: `src/sdk/planner.ts`
- Test: `src/sdk/planner.test.ts` (add cases)

**Interfaces:**
- Consumes: `PlanRequest = { bundle: PolicyBundle; intents: unknown; provenance: TrustLevel; rampLevel: AutonomyLevel }`, `buildPlannerPrompt(request): string`, `makePlan(request): Promise<PlanOutcome>`, `parsePlan(raw): PlanOutcome`.
- Produces: `PlanRequest` gains `instruction?: string`. When present, the prompt's final section carries the owner's words instead of the intents array.

- [ ] **Step 1: Write the failing tests**

Add to `src/sdk/planner.test.ts`:

```ts
  it('puts the owner\'s instruction in the final section, not the intents array', () => {
    const prompt = buildPlannerPrompt({
      bundle: BUNDLE,
      intents: [],
      instruction: 'תשלחי לדנה את ההצעה',
      provenance: 'boss',
      rampLevel: 'approve_required',
    });

    expect(prompt).toContain('תשלחי לדנה את ההצעה');
    expect(prompt).toContain('# ההוראה מבעל העסק');
    expect(prompt).not.toContain('# ה-intents');
  });

  it('keeps everything before the final section byte-identical either way', () => {
    // The cacheable prefix is the whole point of assembling the prompt in this
    // order (see the function's docblock). If an instruction changed anything
    // above the final heading, every instruction would miss the cache.
    const base = { bundle: BUNDLE, intents: [], provenance: 'boss' as const, rampLevel: 'approve_required' as const };
    const withIntents = buildPlannerPrompt(base);
    const withInstruction = buildPlannerPrompt({ ...base, instruction: 'תשלחי לדנה' });

    const prefixOf = (p: string): string => p.slice(0, p.lastIndexOf('# '));
    expect(prefixOf(withInstruction)).toBe(prefixOf(withIntents));
  });

  it('still renders the intents array when no instruction is given', () => {
    const prompt = buildPlannerPrompt({
      bundle: BUNDLE,
      intents: [{ name: 'reply_to_sender' }],
      provenance: 'boss',
      rampLevel: 'approve_required',
    });

    expect(prompt).toContain('# ה-intents');
    expect(prompt).toContain('reply_to_sender');
  });
```

Use the file's existing bundle fixture; if it is named something other than `BUNDLE`, use that name rather than introducing one.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/sdk/planner.test.ts`
Expected: FAIL — `instruction` is not a property of `PlanRequest`.

- [ ] **Step 3: Extend the request and the prompt**

In `src/sdk/planner.ts`, add to `PlanRequest`:

```ts
  /**
   * The owner's own words, when the job came through the instruction door.
   *
   * Mutually exclusive with `intents` in practice: triage produces intents
   * from content nobody vouches for, and this carries a sentence the owner
   * typed behind a session. Both land in the same final section of the prompt
   * so the cacheable prefix above it is untouched either way — see the
   * assembly order in `buildPlannerPrompt`.
   *
   * The planner's own header says "never the raw message", and that rule was
   * written about hostile input. Spec §4 of the instruction door records the
   * deliberate exception and why it does not extend to any other caller.
   */
  instruction?: string;
```

Replace the last two entries of the returned array in `buildPlannerPrompt`:

```ts
    // Last, and the only part that varies per job: everything above is the
    // cacheable prefix.
    ...(request.instruction === undefined
      ? ['# ה-intents', JSON.stringify(request.intents)]
      : ['# ההוראה מבעל העסק', request.instruction]),
```

and widen the system prompt in `makePlan` to cover both, in one string so there is still only one cache variant:

```ts
    systemPrompt:
      'אתה המתכנן. אתה מקבל intents מובנים או הוראה ישירה מבעל העסק, ומחזיר תוכנית JSON. ' +
      'אינך מבצע דבר ואין לך כלים — התוכנית שלך היא הצעה שעוברת אימות.',
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/sdk/planner.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add -A && git commit -m "The planner can take the owner's own words"
```

---

### Task 3: Which recipients an instruction authorises

**Files:**
- Create: `src/governance/typed-recipients.ts`
- Modify: `src/governance/authorization.ts` (add `memory.write_longterm` to the entailed list)
- Test: `src/governance/typed-recipients.test.ts`

**Interfaces:**
- Consumes: `PolicyBundle['knownCounterparties']` = `{ entityIds: string[]; emailDomains: string[]; phones: string[]; tags: string[] }`; `ActionClass` from `src/domain/action.js`.
- Produces:
  - `TYPED_RECIPIENT_CLASSES: readonly ActionClass[]`
  - `authorisedRecipients(input: { instruction: string; actionClass: ActionClass; candidates: string[]; known: PolicyBundle['knownCounterparties'] }): string[]`

- [ ] **Step 1: Write the failing tests**

Create `src/governance/typed-recipients.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ActionClass } from '../domain/action.js';
import { TYPED_RECIPIENT_CLASSES, authorisedRecipients } from './typed-recipients.js';

const NO_ONE_KNOWN = { entityIds: [], emailDomains: [], phones: [], tags: [] };

describe('authorisedRecipients', () => {
  it('covers an address the owner typed verbatim', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי לדנה dana@example.com את ההצעה',
        actionClass: 'email.initiate',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['dana@example.com']);
  });

  it('does not cover an address the owner never typed', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי לדנה את ההצעה',
        actionClass: 'email.initiate',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('matches an address case-insensitively', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי ל-Dana@Example.COM',
        actionClass: 'email.reply',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['dana@example.com']);
  });

  it('matches a phone written with separators against one written without', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי לדנה בוואטסאפ 054-123-4567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0541234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['0541234567']);
  });

  it('matches a local phone against the same number in international form', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי ל-054-1234567',
        actionClass: 'whatsapp.initiate',
        candidates: ['+972541234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['+972541234567']);
  });

  it('covers a counterparty the charter already knows, even unnamed in the text', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי לספק את ההזמנה',
        actionClass: 'email.initiate',
        candidates: ['orders@supplier.co.il'],
        known: { ...NO_ONE_KNOWN, emailDomains: ['supplier.co.il'] },
      }),
    ).toEqual(['orders@supplier.co.il']);
  });

  it('covers nobody at all for a class outside the allowlist, however the address arrived', () => {
    // The ruling this test exists for: the class allowlist gates the whole
    // grant, not only the typed half. A purchase from a supplier already on
    // file is exactly the case where one confirmation is worth most.
    for (const known of [NO_ONE_KNOWN, { ...NO_ONE_KNOWN, emailDomains: ['supplier.co.il'] }]) {
      expect(
        authorisedRecipients({
          instruction: 'תזמיני מ-orders@supplier.co.il חמישים יחידות',
          actionClass: 'purchase.place',
          candidates: ['orders@supplier.co.il'],
          known,
        }),
      ).toEqual([]);
    }
  });

  it('returns only the covered subset when a step reaches several people', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי ל-dana@example.com',
        actionClass: 'email.initiate',
        candidates: ['dana@example.com', 'stranger@elsewhere.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['dana@example.com']);
  });

  it('names its allowlist rather than deriving it, and admits no other class', () => {
    // Written out so a class added to the enum tomorrow is excluded by
    // default, and so rewriting this control as "everything except purchase"
    // fails here immediately.
    expect([...TYPED_RECIPIENT_CLASSES]).toEqual([
      'email.reply',
      'email.initiate',
      'whatsapp.reply',
      'whatsapp.initiate',
      'calendar.create',
      'calendar.move',
      'calendar.cancel',
      'doc.deliver',
    ]);

    const admitted = ActionClass.options.filter((cls) =>
      TYPED_RECIPIENT_CLASSES.includes(cls),
    );
    expect(admitted).toEqual([...TYPED_RECIPIENT_CLASSES]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/governance/typed-recipients.test.ts`
Expected: FAIL — cannot find module `./typed-recipients.js`.

- [ ] **Step 3: Implement**

Create `src/governance/typed-recipients.ts`:

```ts
/**
 * Which of a step's recipients an instruction is allowed to authorise.
 *
 * The owner's emphasis is that an instruction is its own approval. The danger
 * is that the recipients in a plan come from a model reading the owner's text:
 * paste a supplier's mail containing an address, add "handle this", and that
 * address would be in the plan. Granting whatever the plan names would let a
 * paste buy authority.
 *
 * Two positive sources, and nothing else:
 *
 *   1. the charter already knows the counterparty, or
 *   2. the owner typed the address or number verbatim in the instruction.
 *
 * The second is the owner's own rule, and it is the right distinction: it
 * separates *the model inferred a destination* from *the boss named one*.
 * Spec §6 records what it does not protect against — it sees that an address
 * is in the text, not who put it there — and the class allowlist below is the
 * hedge the owner chose alongside it.
 */
import type { ActionClass } from '../domain/action.js';
import type { PolicyBundle } from '../domain/policy.js';

/**
 * The classes where a recipient can be authorised by an instruction at all.
 *
 * Named individually, never derived. A class added to the enum tomorrow is
 * excluded until someone puts it here on purpose, and rewriting this as
 * "everything except a purchase" would fail the invariant test that pins it.
 *
 * What is deliberately absent: `purchase.place`, `commitment.make`,
 * `quote.issue` and `discount.grant` — the four where a mistake costs most —
 * plus every class the code never automates regardless.
 *
 * **This gates the whole grant, not only the typed half.** A supplier already
 * on file is exactly who a purchase would go to, so exempting known
 * counterparties here would defeat the restriction at the only moment it
 * matters.
 */
export const TYPED_RECIPIENT_CLASSES: readonly ActionClass[] = [
  'email.reply',
  'email.initiate',
  'whatsapp.reply',
  'whatsapp.initiate',
  'calendar.create',
  'calendar.move',
  'calendar.cancel',
  'doc.deliver',
];

/** Digits only, and the last nine of them. */
function phoneKey(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  // Nine is the length of an Israeli subscriber number without its leading
  // zero, which is what survives both `054-123-4567` and `+972541234567`.
  // Shorter than that is not a phone number, and comparing it would match
  // half the digits in the instruction by accident.
  return digits.length < 9 ? null : digits.slice(-9);
}

function typedInInstruction(candidate: string, instruction: string): boolean {
  const haystack = instruction.toLowerCase();
  if (haystack.includes(candidate.toLowerCase())) return true;

  const wanted = phoneKey(candidate);
  if (wanted === null) return false;

  // Every run of digits and separators in the instruction, compared by the
  // same key. A textual search would miss `054-123-4567` against `0541234567`.
  const runs = instruction.match(/[+\d][\d\s().-]{6,}/g) ?? [];
  return runs.some((run) => phoneKey(run) === wanted);
}

function knownToCharter(
  candidate: string,
  known: PolicyBundle['knownCounterparties'],
): boolean {
  const lower = candidate.toLowerCase();

  const at = lower.lastIndexOf('@');
  if (at !== -1) {
    const domain = lower.slice(at + 1);
    // Anchored on the label boundary, so `evil-supplier.co.il` does not match
    // a known `supplier.co.il`.
    if (
      known.emailDomains.some(
        (d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`),
      )
    ) {
      return true;
    }
  }

  const wanted = phoneKey(candidate);
  if (wanted !== null && known.phones.some((p) => phoneKey(p) === wanted)) return true;

  return known.entityIds.some((id) => id.toLowerCase() === lower);
}

export function authorisedRecipients(input: {
  instruction: string;
  actionClass: ActionClass;
  candidates: string[];
  known: PolicyBundle['knownCounterparties'];
}): string[] {
  if (!TYPED_RECIPIENT_CLASSES.includes(input.actionClass)) return [];

  return input.candidates.filter(
    (candidate) =>
      knownToCharter(candidate, input.known) ||
      typedInInstruction(candidate, input.instruction),
  );
}
```

- [ ] **Step 4: Let the grant see phone numbers at all**

**Found in preflight, and this blocks the spec's own example.** `coveredByAuthorization` computes the addresses a step would reach as `readEmails(facts.input)` — emails only. A WhatsApp step carries its recipient in `phone` / `toNumber` / `msisdn`, so `going` comes back empty, the function returns `false` at its empty-list guard, and **no phone recipient can ever be covered** however the grant was written. Spec §5.1 promises the opposite in so many words: "תשלחי לדנה, 054-1234567" is meant to flow.

`readPhones` already exists in `src/policy/facts.ts` and is private. Export it, beside the already-exported `readEmails` which is exported for exactly this reason:

```ts
export function readPhones(input: Record<string, unknown>): string[] {
```

Then in `coveredByAuthorization`, widen the one line:

```ts
  // Emails and phones both, because a WhatsApp step's recipient is a number
  // and an authorisation that cannot see it could never cover one. The
  // `every` below still applies to the combined list: one authorised address
  // does not vouch for a stranger's number standing beside it.
  const going = [...readEmails(facts.input), ...readPhones(facts.input)];
```

Add two tests to `authorization.test.ts`: a `whatsapp.initiate` call whose `phone` is in the grant's recipients **is** covered; the same call with a second, ungranted number in the payload is **not**.

- [ ] **Step 5: Add `memory.write_longterm` to the entailed list**

In `src/governance/authorization.ts`, the private constant currently reads `['crm.write']`. Change it to:

```ts
const ENTAILED_INTERNAL_CLASSES: readonly ActionClass[] = ['crm.write', 'memory.write_longterm'];
```

and extend its docblock with:

```
 * `memory.write_longterm` joins it for the same reason `crm.write` is there:
 * remembering a preference the owner stated reaches nobody, spends nothing,
 * and can be corrected. Spec §7 of the instruction door names these two and
 * says why writing a file is not among them — the same action class covers
 * running code.
```

Add a test to the file's existing suite asserting a `memory.write_longterm` call with no recipients is covered by an authorisation, and that `artifact.write` is not.

- [ ] **Step 6: Run the tests**

```bash
npx vitest run src/governance/typed-recipients.test.ts src/governance/authorization.test.ts
```
Expected: PASS.

- [ ] **Step 7: Prove the allowlist bites**

Add `'purchase.place'` to `TYPED_RECIPIENT_CLASSES`, re-run, confirm `covers nobody at all for a class outside the allowlist` fails, restore. Redirect to `task-3-mut-fail.txt` / `task-3-mut-pass.txt`.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add -A && git commit -m "An instruction authorises who the owner named, and only where it is safe to"
```

---

### Task 4: The pipeline

**Files:**
- Create: `src/orchestrator/instruct.ts`
- Test: `src/orchestrator/instruct.test.ts`

**Interfaces:**
- Consumes: `saveInstruction`, `loadInstructionForJob`, `recordAnswer` (Task 1); `makePlan`, `PlanRequest`, `PlanOutcome` (Task 2); `authorisedRecipients` (Task 3); `createJob({ charterVersion, provenance, title?, businessId? })`, `transition(jobId, { to, actor, reason, businessId })`, `loadActiveCharter(businessId)` → `{ charter, bundle } | null`, `planProblems(plan): PlanProblem[]`, `bindPlanToJob(jobId, plan, { businessId })`, `grantAuthorization({ jobId, actionClass, recipients }, { businessId, db })`, `readEmails(input): string[]` **and `readPhones(input): string[]`** from `src/policy/facts.js` (Task 3 exports the second), `rampLevelForPlan`.
- Produces: `runInstruction(input: { text: string }, options?: RunInstructionOptions): Promise<InstructionOutcome>` where
  `RunInstructionOptions = { businessId?: string; planner?: (request: PlanRequest) => Promise<PlanOutcome> }` and
  `InstructionOutcome = { status: 'planned'; jobId: string; instructionId: string; granted: { actionClass: ActionClass; recipients: string[] }[] } | { status: 'needs_answer'; jobId: string; instructionId: string; question: string } | { status: 'refused'; reason: string }`

- [ ] **Step 1: Write the failing tests**

Create `src/orchestrator/instruct.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import type { CharterConnection } from '../domain/connection.js';
import { loadPlanBody } from './plan-store.js';
import { loadInstructionForJob } from '../governance/instructions.js';
import { runInstruction } from './instruct.js';
import type { Plan } from '../domain/plan.js';

const BUSINESS = 'test-business';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

function mailPlan(to: string): Plan {
  return {
    goal: 'לשלוח לדנה את ההצעה',
    assumptions: [],
    clarifyingQuestion: null,
    estimatedCostMinor: 0,
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'לשלוח את ההצעה',
        toolName: 'mail.send',
        input: { to, subject: 'הצעה', body: 'מצורף' },
        dependsOn: [],
        expectedActionClass: 'email.initiate',
      },
    ],
  };
}

async function withCharter(): Promise<void> {
  await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
    businessId: BUSINESS,
  });
}

describe('runInstruction', () => {
  beforeEach(async () => {
    await resetDatabase();
    await withCharter();
  });

  afterAll(async () => {
    await closePool();
  });

  it('opens a boss job, stores the instruction, binds the plan', async () => {
    const result = await runInstruction(
      { text: 'תשלחי ל-dana@example.com את ההצעה' },
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('unreachable');

    const jobs = await getPool().query<{ provenance: string; phase: string }>(
      `SELECT provenance, phase FROM jobs WHERE job_id = $1`,
      [result.jobId],
    );
    expect(jobs.rows[0]?.provenance).toBe('boss');
    expect(jobs.rows[0]?.phase).toBe('execute');

    expect(await loadPlanBody(result.jobId, { businessId: BUSINESS })).not.toBeNull();
    const stored = await loadInstructionForJob(result.jobId, { businessId: BUSINESS });
    expect(stored?.text).toBe('תשלחי ל-dana@example.com את ההצעה');
  });

  it('grants a standing authorisation for the address the owner typed', async () => {
    const result = await runInstruction(
      { text: 'תשלחי ל-dana@example.com את ההצעה' },
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
    );
    if (result.status !== 'planned') throw new Error('unreachable');

    expect(result.granted).toEqual([
      { actionClass: 'email.initiate', recipients: ['dana@example.com'] },
    ]);

    const { rows } = await getPool().query<{ action_class: string; recipients: string[] }>(
      `SELECT action_class, recipients FROM job_authorizations WHERE job_id = $1`,
      [result.jobId],
    );
    expect(rows[0]?.action_class).toBe('email.initiate');
    expect(rows[0]?.recipients).toEqual(['dana@example.com']);
  });

  it('grants nothing when the owner never named the address', async () => {
    const result = await runInstruction(
      { text: 'תשלחי לדנה את ההצעה' },
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
    );
    if (result.status !== 'planned') throw new Error('unreachable');

    // The job still runs — the step simply takes the ordinary approval path.
    expect(result.granted).toEqual([]);
    const { rows } = await getPool().query(`SELECT 1 FROM job_authorizations`);
    expect(rows).toHaveLength(0);
  });

  it('waits for an answer instead of planning when the planner asks', async () => {
    const asking: Plan = { ...mailPlan('x@example.com'), clarifyingQuestion: 'איזו דנה?' };
    const result = await runInstruction(
      { text: 'תשלחי לדנה את ההצעה' },
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: asking }) },
    );

    expect(result.status).toBe('needs_answer');
    if (result.status !== 'needs_answer') throw new Error('unreachable');
    expect(result.question).toBe('איזו דנה?');

    // Nothing bound, and the job is not in execute — a question is not a plan.
    expect(await loadPlanBody(result.jobId, { businessId: BUSINESS })).toBeNull();
    const jobs = await getPool().query<{ phase: string }>(
      `SELECT phase FROM jobs WHERE job_id = $1`,
      [result.jobId],
    );
    expect(jobs.rows[0]?.phase).not.toBe('execute');
    const auths = await getPool().query(`SELECT 1 FROM job_authorizations`);
    expect(auths.rows).toHaveLength(0);
  });

  it('refuses an unparseable plan without opening anything runnable', async () => {
    const result = await runInstruction(
      { text: 'תשלחי לדנה' },
      {
        businessId: BUSINESS,
        planner: async () => ({ status: 'unparseable', raw: '{{', reason: 'bad json' }),
      },
    );

    expect(result.status).toBe('refused');
    const { rows } = await getPool().query(`SELECT 1 FROM job_authorizations`);
    expect(rows).toHaveLength(0);
  });

  it('refuses a plan whose steps do not form a DAG', async () => {
    const cyclic: Plan = {
      ...mailPlan('dana@example.com'),
      steps: [
        { ...mailPlan('dana@example.com').steps[0]!, id: 's1', dependsOn: ['s2'] },
        { ...mailPlan('dana@example.com').steps[0]!, id: 's2', dependsOn: ['s1'] },
      ],
    };
    const result = await runInstruction(
      { text: 'תשלחי לדנה' },
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: cyclic }) },
    );

    expect(result.status).toBe('refused');
    expect(await getPool().query(`SELECT 1 FROM job_plans`).then((r) => r.rows)).toHaveLength(0);
  });

  it('refuses when no charter is installed', async () => {
    await resetDatabase();
    const result = await runInstruction(
      { text: 'תשלחי לדנה' },
      { businessId: BUSINESS, planner: async () => ({ status: 'planned', plan: mailPlan('dana@example.com') }) },
    );
    expect(result.status).toBe('refused');
  });

  it('refuses an instruction past the cap before calling the planner', async () => {
    let called = false;
    const result = await runInstruction(
      { text: 'א'.repeat(4001) },
      {
        businessId: BUSINESS,
        planner: async () => {
          called = true;
          return { status: 'planned', plan: mailPlan('dana@example.com') };
        },
      },
    );

    expect(result.status).toBe('refused');
    expect(called, 'the cap exists to stop a paste before it costs money').toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/orchestrator/instruct.test.ts`
Expected: FAIL — cannot find module `./instruct.js`.

- [ ] **Step 3: Implement**

Create `src/orchestrator/instruct.ts`:

```ts
/**
 * The instruction door's pipeline: text in, a bound plan out.
 *
 * `provenance: 'boss'` is set here and is not a field on the input. A caller
 * able to ask for a provenance would be a caller able to forge an instruction,
 * and the whole authority of this path rests on the session that reached it —
 * the same structural rule `conduct.ts` keeps in the opposite direction.
 *
 * The order is deliberate: the cap is checked before the planner is called, so
 * a pasted document costs nothing; the plan is validated before anything is
 * bound; and the authorisation is granted only after the plan is known good,
 * because a grant against a plan that will not run is a grant nobody audits.
 */
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { loadActiveCharter } from '../charter/store.js';
import type { ActionClass } from '../domain/action.js';
import { planProblems, type Plan } from '../domain/plan.js';
import { grantAuthorization } from '../governance/authorization.js';
import {
  MAX_INSTRUCTION_CHARS,
  saveInstruction,
  type InstructionRecord,
} from '../governance/instructions.js';
import { authorisedRecipients } from '../governance/typed-recipients.js';
import { readEmails, readPhones } from '../policy/facts.js';
import { makePlan, type PlanOutcome, type PlanRequest } from '../sdk/planner.js';
import { createJob, transition } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';
import { rampLevelForPlan } from './ramp.js';

export interface RunInstructionOptions {
  businessId?: string;
  /** The one step that costs money, injectable so the pipeline can be tested without an API key. */
  planner?: (request: PlanRequest) => Promise<PlanOutcome>;
}

export interface GrantedAuthorization {
  actionClass: ActionClass;
  recipients: string[];
}

export type InstructionOutcome =
  | {
      status: 'planned';
      jobId: string;
      instructionId: string;
      granted: GrantedAuthorization[];
    }
  | { status: 'needs_answer'; jobId: string; instructionId: string; question: string }
  | { status: 'refused'; reason: string };

export async function runInstruction(
  input: { text: string },
  options: RunInstructionOptions = {},
): Promise<InstructionOutcome> {
  const businessId = options.businessId ?? config.businessId;
  const planner = options.planner ?? makePlan;

  if (input.text.trim().length === 0) {
    return { status: 'refused', reason: 'ההוראה ריקה.' };
  }
  // Before the planner, on purpose: the cap exists to stop a pasted document,
  // and a cap enforced after the model call has already paid for the paste.
  if (input.text.length > MAX_INSTRUCTION_CHARS) {
    return {
      status: 'refused',
      reason: `ההוראה ארוכה מ-${MAX_INSTRUCTION_CHARS} תווים. להעברת מסמך יש תיקיית קליטה.`,
    };
  }

  const active = await loadActiveCharter(businessId);
  if (active === null) {
    return { status: 'refused', reason: 'אין תקנון פעיל — המתכנן נשען על הקטלוג והתקרות שבו.' };
  }

  const job = await createJob({
    charterVersion: active.charter.charterVersion,
    // Not a parameter. See this module's header.
    provenance: 'boss',
    businessId,
    title: input.text.slice(0, 80),
  });

  let instruction: InstructionRecord;
  try {
    instruction = await saveInstruction({ jobId: job.jobId, text: input.text }, { businessId });
  } catch (err) {
    await transition(job.jobId, {
      to: 'failed',
      actor: 'human',
      reason: 'instruction door: instruction could not be stored',
      businessId,
    });
    return { status: 'refused', reason: err instanceof Error ? err.message : String(err) };
  }

  await transition(job.jobId, {
    to: 'understand',
    actor: 'human',
    reason: `instruction door: ${instruction.instructionId}`,
    businessId,
  });

  const outcome = await planner({
    bundle: active.bundle,
    intents: [],
    instruction: input.text,
    provenance: 'boss',
    // The plan does not exist yet, so there is no per-class ramp to take a
    // minimum over. `draft_only` is what the catalogue is rendered against —
    // deliberately the floor, so the planner is never shown a capability the
    // gate would refuse. `rampLevelForPlan` is applied to the real plan by
    // `runDueJobs` when it runs.
    rampLevel: 'draft_only',
  });

  if (outcome.status !== 'planned') {
    await transition(job.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: `instruction door: ${outcome.reason}`,
      businessId,
    });
    return { status: 'refused', reason: 'לא הצלחתי להבין את ההוראה מספיק כדי לבנות תוכנית.' };
  }

  const plan = outcome.plan;

  // A question is not a plan. The job stops here and waits, and nothing is
  // bound or granted — see spec §8.
  if (plan.clarifyingQuestion !== null) {
    return {
      status: 'needs_answer',
      jobId: job.jobId,
      instructionId: instruction.instructionId,
      question: plan.clarifyingQuestion,
    };
  }

  const problems = planProblems(plan);
  if (problems.length > 0) {
    await transition(job.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: `instruction door: plan invalid (${problems.map((p) => p.kind).join(', ')})`,
      businessId,
    });
    return { status: 'refused', reason: 'התוכנית שנבנתה אינה תקינה ולכן לא רצה.' };
  }

  const granted = await grantForPlan(job.jobId, plan, input.text, active.bundle.knownCounterparties, businessId);

  await transition(job.jobId, {
    to: 'plan',
    actor: 'orchestrator',
    reason: 'instruction door: plan accepted',
    businessId,
  });
  await bindPlanToJob(job.jobId, plan, { businessId });
  await transition(job.jobId, {
    to: 'execute',
    actor: 'orchestrator',
    reason: 'instruction door: bound and ready',
    businessId,
  });

  return {
    status: 'planned',
    jobId: job.jobId,
    instructionId: instruction.instructionId,
    granted,
  };
}

/**
 * One grant per action class the plan declares, carrying only the recipients
 * that instruction actually authorises.
 *
 * A class whose covered set is empty gets no row at all rather than an empty
 * one: `coveredByAuthorization` already refuses an empty recipient list, and a
 * row that authorises nobody is a record of permission that was never given.
 */
async function grantForPlan(
  jobId: string,
  plan: Plan,
  instruction: string,
  known: Parameters<typeof authorisedRecipients>[0]['known'],
  businessId: string,
): Promise<GrantedAuthorization[]> {
  const byClass = new Map<ActionClass, Set<string>>();

  for (const step of plan.steps) {
    const actionClass = step.expectedActionClass;
    // The planner's declared class is advisory and the gate classifies for
    // itself, so a step that declares nothing grants nothing — "the planner
    // did not say" must read as "no permission was widened".
    if (actionClass === null) continue;

    const covered = authorisedRecipients({
      instruction,
      actionClass,
      // Emails and phones both. A WhatsApp step's recipient is a number, and
      // Task 3 widened `coveredByAuthorization` to see them for the same
      // reason — a grant the gate cannot match is a grant that does nothing.
      candidates: [...readEmails(step.input), ...readPhones(step.input)],
      known,
    });
    if (covered.length === 0) continue;

    const bucket = byClass.get(actionClass) ?? new Set<string>();
    for (const address of covered) bucket.add(address);
    byClass.set(actionClass, bucket);
  }

  const granted: GrantedAuthorization[] = [];
  for (const [actionClass, addresses] of byClass) {
    const recipients = [...addresses].sort();
    await grantAuthorization({ jobId, actionClass, recipients }, { businessId, db: getPool() });
    granted.push({ actionClass, recipients });
  }
  return granted;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/orchestrator/instruct.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Prove two controls bite**

Change `provenance: 'boss'` to `'unknown_external'`, confirm the first test fails, restore. Then move the cap check below the planner call, confirm `refuses an instruction past the cap before calling the planner` fails, restore. Redirect to `task-4-mut-provenance-*.txt` and `task-4-mut-cap-*.txt`.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add -A && git commit -m "Text in, a bound plan out, and a grant only for who the owner named"
```

---

### Task 5: The door on the dashboard

**Files:**
- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard/views.ts`
- Test: `src/dashboard/server.test.ts` (add cases)

**Interfaces:**
- Consumes: `runInstruction` (Task 4); `recordAnswer`, `loadInstructionForJob` (Task 1); the file's existing `page(title, body)`, `esc`, `logoutForm(csrf)`, session loading, `verifyCsrfToken`, `issueCsrfToken`, `sendHtml`.
- Produces: `GET /instruct` (the box), `POST /instruct` (submit), `POST /instruct/:jobId/answer` (reply to a clarifying question), and `renderInstruct(options)`.

- [ ] **Step 1: Write the failing tests**

Add to `src/dashboard/server.test.ts`, using the file's existing login and request helpers:

```ts
  it('serves the instruction box behind a session', async () => {
    const { cookie } = await aLoggedInOwner();
    const res = await get('/instruct', { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toContain('מה לעשות');
  });

  it('refuses the instruction box without a session', async () => {
    const res = await get('/instruct', {});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('refuses a submitted instruction without a CSRF token', async () => {
    const { cookie } = await aLoggedInOwner();
    const res = await post('/instruct', { cookie, body: new URLSearchParams({ text: 'תשלחי לדנה' }) });
    expect(res.status).toBe(403);
  });

  it('shows the refusal when the instruction is too long, and opens no job', async () => {
    const { cookie, csrf } = await aLoggedInOwner();
    const res = await post('/instruct', {
      cookie,
      body: new URLSearchParams({ csrf, text: 'א'.repeat(4001) }),
    });

    expect(res.status).toBe(400);
    expect(res.body).toContain('4,000');
    const { rows } = await getPool().query(`SELECT 1 FROM boss_instructions`);
    expect(rows).toHaveLength(0);
  });
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/dashboard/server.test.ts`
Expected: FAIL — `/instruct` returns 404.

- [ ] **Step 3: Render the box**

Add to `src/dashboard/views.ts`:

```ts
/**
 * The instruction box.
 *
 * One field and one button. The note under it is not decoration: an
 * instruction is its own approval, and the owner should know that before they
 * type, not discover it afterwards.
 */
export function renderInstruct(options: {
  csrf: string;
  error?: string;
  pending?: { jobId: string; question: string } | null;
}): string {
  const error =
    options.error === undefined ? '' : `<p class="error">${esc(options.error)}</p>`;

  const pending =
    options.pending == null
      ? ''
      : `<article class="card">
           <h3>שאלה לפני שאמשיך</h3>
           <p>${esc(options.pending.question)}</p>
           <form method="POST" action="/instruct/${esc(options.pending.jobId)}/answer">
             <input type="hidden" name="csrf" value="${esc(options.csrf)}">
             <textarea name="answer" rows="2" required></textarea>
             <button>לענות ולהמשיך</button>
           </form>
         </article>`;

  return page(
    'מה לעשות',
    `<h1>מה לעשות</h1>
     ${error}
     ${pending}
     <form method="POST" action="/instruct">
       <input type="hidden" name="csrf" value="${esc(options.csrf)}">
       <textarea name="text" rows="4" maxlength="4000" required
                 placeholder="למשל: תשלחי לדנה dana@example.com את ההצעה"></textarea>
       <button>שלח</button>
     </form>
     <p class="muted">
       מה שתכתוב כאן נחשב אישור בפני עצמו — לא אישאל אותך שוב על מה שביקשת.
       פעולה שנוגעת בכסף, חתימה על חוזה, או נמען שלא נקבת בכתובתו — עדיין תעצור ותשאל.
     </p>
     <p><a href="/">לכרטיסי האישור</a> · <a href="/readings">מה קראתי</a></p>
     ${logoutForm(options.csrf)}`,
  );
}
```

- [ ] **Step 4: Route it**

In `src/dashboard/server.ts`, beside the existing `GET /readings` route and **after** the session load and the must-change-password redirect:

```ts
  if (method === 'GET' && pathname === '/instruct') {
    return sendHtml(res, 200, renderInstruct({ csrf: issueCsrfToken(session.sessionId) }));
  }

  if (method === 'POST' && pathname === '/instruct') {
    const form = await readForm(req);
    if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return sendForbidden(res);

    const outcome = await runInstruction({ text: form.get('text') ?? '' }, { businessId });
    const csrf = issueCsrfToken(session.sessionId);

    if (outcome.status === 'refused') {
      return sendHtml(res, 400, renderInstruct({ csrf, error: outcome.reason }));
    }
    if (outcome.status === 'needs_answer') {
      return sendHtml(
        res,
        200,
        renderInstruct({ csrf, pending: { jobId: outcome.jobId, question: outcome.question } }),
      );
    }
    return sendRedirect(res, '/');
  }
```

Use the file's own helpers for reading the form, sending 403, and redirecting; do not introduce new ones. Add the `POST /instruct/:jobId/answer` route with a regex in the same style as `DECISION_PATH`: it verifies CSRF, loads the instruction for that job (refusing when the job does not belong to this business), calls `recordAnswer`, then calls `runInstruction` again with the instruction text and the answer joined by a blank line — and treats the result exactly as the submit route does.

Add a link to `/instruct` from the pending list.

- [ ] **Step 5: Run the dashboard suite**

Run: `npx vitest run src/dashboard/server.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the session guard bites**

Move the `/instruct` routes above the session load, re-run, confirm `refuses the instruction box without a session` fails, restore. Redirect to `task-5-mut-fail.txt` / `task-5-mut-pass.txt`.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add -A && git commit -m "A box that takes an instruction, and a question when one is needed"
```

---

### Task 6: Invariants, documentation, and the live run

**Files:**
- Create: `src/orchestrator/instruction-invariants.test.ts`
- Modify: `CLAUDE.md`, `docs/09-roadmap.md`

- [ ] **Step 1: Write the invariants**

Create `src/orchestrator/instruction-invariants.test.ts`:

```ts
/**
 * Structural, in the style of `conductor-invariants.test.ts`. Three properties
 * a future edit could remove while every behavioural test stayed green.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionClass } from '../domain/action.js';
import { TYPED_RECIPIENT_CLASSES } from '../governance/typed-recipients.js';

const SRC = join(process.cwd(), 'src');
const source = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** The text of one call, by paren depth, so two calls cannot cover for each other. */
function callBlock(text: string, callee: string): string {
  const start = text.indexOf(`${callee}(`);
  if (start === -1) throw new Error(`no call to ${callee}`);
  let depth = 0;
  for (let i = start + callee.length; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced call to ${callee}`);
}

describe('the instruction door cannot widen its own authority', () => {
  it('stamps its job as boss with a literal, not a value a caller supplies', () => {
    const block = callBlock(source('orchestrator/instruct.ts'), 'createJob');
    expect(block).toContain("provenance: 'boss'");
    // Only the literal is acceptable on the right of `provenance:` — an
    // allowlist, not a denylist of identifier names.
    const assignments = block.match(/provenance:\s*[^,\n]+/g) ?? [];
    expect(assignments).toEqual(["provenance: 'boss'"]);
  });

  it('admits only the named classes to a typed-recipient grant', () => {
    const admitted = ActionClass.options.filter((cls) => TYPED_RECIPIENT_CLASSES.includes(cls));
    expect(admitted).toEqual([...TYPED_RECIPIENT_CLASSES]);
    // The four the owner chose to keep asking about, named so a future edit
    // that adds one has to do it here in the open.
    for (const cls of ['purchase.place', 'commitment.make', 'quote.issue', 'discount.grant'] as const) {
      expect(TYPED_RECIPIENT_CLASSES).not.toContain(cls);
    }
  });

  it('never raises a ramp level or amends the charter from this path', () => {
    for (const file of ['orchestrator/instruct.ts', 'governance/typed-recipients.ts']) {
      expect(source(file)).not.toContain('setRampLevel');
      expect(source(file)).not.toContain('installCharter');
    }
  });
});
```

- [ ] **Step 2: Run them, then prove one bites**

Run: `npx vitest run src/orchestrator/instruction-invariants.test.ts` — expect PASS.
Then change `provenance: 'boss'` in `instruct.ts` to read from a variable, confirm the first invariant fails, restore. Redirect to `task-6-mut-*.txt`.

- [ ] **Step 3: Documentation**

In `CLAUDE.md`, add a silent-rule paragraph covering: the door sets `boss` provenance itself and no input can ask for another; an instruction authorises only recipients the owner typed verbatim or the charter already knows; the class allowlist gates the whole grant and names four classes that keep asking; `memory.write_longterm` joined the entailed internal classes and why `artifact.write` did not; the 4,000-character cap is checked before the planner so a paste costs nothing; and the planner now accepts an instruction, which is a deliberate exception to its "never the raw message" rule that does not extend to any other caller.

**Verify every claim against the code before writing it.** This project has repeatedly shipped documentation describing something that did not exist, and three such claims were found in it as recently as the last status report.

In `docs/09-roadmap.md`, record under stage 0 that the instruction door closed the one-way flow, and state plainly what it did not change: documents in the watched folder remain advisory, and money still stops.

Do not update the test count — the controller sets it from a full run.

- [ ] **Step 4: The live run**

With a real `ANTHROPIC_API_KEY`, the dashboard running, and the scheduler running: type one real instruction naming a real address. Record, in the report: the job's provenance and phase, the plan that was bound, the `job_authorizations` row and its recipients, whether the gate asked or did not, and what the audit trail shows. A test with an injected planner proves composition; only this proves connection.

- [ ] **Step 5: Full verification and commit**

```bash
npm run typecheck
npm test
git add -A && git commit -m "Invariants and documentation for the instruction door"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| §2 the chain | 4, 5 |
| §3 identity, boss stamped by the route | 4, and 6 locks it |
| §4 the planner reads the instruction directly | 2 |
| §5.1 two positive sources for recipients | 3 |
| §5.2 the class allowlist | 3, and 6 locks it |
| §5.3 four limits that do not move | inherited from `coveredByAuthorization`; Task 3's test asserts the class gate, the rest are already covered by `authorization.test.ts` |
| §6 what the rule does not protect against | documented in Task 3's docblock and Task 6's CLAUDE.md paragraph |
| §7 what she does on her own initiative | 3 (step 4) |
| §8 the clarifying question | 4, 5 |
| §8ב where the instruction is stored, the 4,000 cap | 1, and Task 4 enforces the order |
| §9 failures | 4 (every branch), 5 (the screen) |
| §10 what this is not | 6 (documentation) |
| §11 tests, invariants, live run | every task, plus 6 |

**2. Placeholder scan:** none. Task 5's answer route is described rather than written out — that is deliberate and bounded: it composes three functions this plan defines with helpers already in that file, and writing it against helper names I have not read would be a guess. The implementer is told exactly which pieces to compose and in what order.

**3. Type consistency:** `InstructionRecord` is produced in Task 1 and consumed in Tasks 4 and 5. `PlanRequest.instruction` is added in Task 2 and used in Task 4. `authorisedRecipients` and `TYPED_RECIPIENT_CLASSES` are produced in Task 3 and consumed in Tasks 4 and 6. `runInstruction`'s three-branch `InstructionOutcome` is produced in Task 4 and every branch is handled in Task 5.

**Ordering:** 1 → 2 → 3 → 4 (needs 1, 2, 3) → 5 (needs 4) → 6 last. Tasks 1, 2 and 3 are independent of one another.

**One thing the executor should know:** Task 3 changes a private constant in `authorization.ts` that `coveredByAuthorization` reads, so that file's existing tests are in scope for Task 3's test run.
