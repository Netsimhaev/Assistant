# Proposal Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a stored `Reading` into a `Proposal` — a stance, a headline in the owner's language, cited reasons, and at most one action — validated, stored, and carried into the existing approval card so the owner reads a sentence instead of a tool name.

**Architecture:** A new readable layer above the existing plan machinery. The model produces a `Proposal`; pure code validates it against the reading it came from and the capability catalogue, then compiles its single action into a one-step `Plan` the untouched engine runs. Separately, a standing-authorisation record — written only from a boss-initiated job creation path, never from anything a model produced — lets the gate accept an instruction already given instead of asking a second time.

**Tech Stack:** TypeScript (NodeNext ESM), zod, `pg` against real PostgreSQL 17, vitest, `@anthropic-ai/claude-agent-sdk@0.3.234`, `ulid`.

**Spec:** [docs/superpowers/specs/2026-08-31-proposal-planner-design.md](../specs/2026-08-31-proposal-planner-design.md)

**Branch:** `main` is at the merge of sub-projects א' and ב'. Create a branch for this work; do not implement on `main`.

## Global Constraints

- **`.js` in every relative import**, including from `.ts` files (NodeNext ESM).
- **Three tsconfig flags bite:** `noUncheckedIndexedAccess` (`rows[0]?.x`, never a non-null assertion in production code), `exactOptionalPropertyTypes` (conditional spread: `x !== undefined ? { x } : {}`), `verbatimModuleSyntax` (`import type` for types).
- **zod schema and inferred type share one name**, the pattern throughout `src/domain/`.
- **DB row convention:** private `interface XRow` with snake_case fields plus a `toX(row)` function. SQL snake_case, TypeScript camelCase.
- **Tests need real Postgres.** `resetDatabase()` in `beforeEach`, `closePool()` in `afterAll`. Add every new table to the explicit TRUNCATE list in `src/test/db.ts`.
- **Hebrew for humans, English for code.** Headlines, reasons, rejection text and docs in Hebrew; identifiers, comments and internal errors in English.
- **A value that could not be read is never the permissive one.** Every failure resolves to `unproposable` or to "ask the human", never to "proceed".
- **Nothing throws on bad model output.** A response that is not a proposal is a recorded result, exactly as `parseReading` and `ingestDocument` do.
- **Standing authorisation is derived from the job's stamped provenance and an explicitly-recorded authorisation row — never from a `Reading`, a `Proposal`, or any model output.** This is the security core of the whole sub-project.
- **Money always asks.** No threshold, no exception.
- **A negative test must prove the code it covers actually ran.** A test that passes with its implementation deleted is not a test. Two tasks in the previous plan were sent back for exactly this.
- **Run `npm run typecheck` and `npm test` before every commit.** Redirect test output to files; never hand-write a transcript.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `src/domain/proposal.ts` | `Stance`, `Reason`, `ProposedAction`, `Proposal` — the shape and nothing else |
| `src/orchestrator/proposal-parse.ts` | `parseProposal`, `proposalProblems` — turn a response into a proposal or a stated reason it is not one |
| `src/orchestrator/proposal-to-plan.ts` | `proposalToPlan` — pure, one action → a one-step `Plan` |
| `src/orchestrator/authorization.ts` | `StandingAuthorization`, `grantAuthorization`, `loadAuthorization`, `coveredByAuthorization` |
| `src/orchestrator/proposal-store.ts` | `saveProposal`, `loadProposalsForReading` |
| `src/sdk/proposal-prompt.ts` | `PROPOSAL_PROMPT_VERSION`, `buildProposalSystemPrompt`, `renderReadingForProposal` |
| `src/sdk/proposer.ts` | `makeProposal` (the SDK call), `interpretProposalResponse` (the pure part) |
| `src/orchestrator/propose.ts` | `proposeForReading` — the composition |
| `src/sdk/run-propose.ts` | live script |
| `src/db/migrations/016_proposals.sql` | the proposals table |
| `src/db/migrations/015_job_authorizations.sql` | the standing-authorisation table |
| `src/orchestrator/proposal-invariants.test.ts` | structural invariants |

**Modified:** `src/policy/engine.ts` (gate wiring), `src/test/db.ts`, `package.json`, `CLAUDE.md`, `docs/02-orchestrator.md`, `docs/05-approvals.md`, `docs/09-roadmap.md`.

---

### Task 1: The proposal domain

**Files:**
- Create: `src/domain/proposal.ts`, `src/domain/proposal.test.ts`

**Interfaces:**
- Consumes: `SourceRef`, `IntentName` from `src/domain/reading.js`; `AgentId` from `src/domain/audit.js`; `ActionClass` from `src/domain/action.js`.
- Produces: `Stance`, `Reason`, `ProposedAction`, `Proposal` — zod schemas with same-named inferred types.

**Context:** Read `src/domain/reading.ts` first — this file is its sibling and must read in the same voice. The stance constraints (`act` requires an action, `ask` forbids one) are **not** expressed in the schema; they live in `proposalProblems` in Task 2, because a zod refinement produces an error nobody can act on while a named problem can explain itself.

- [ ] **Step 1: Write the failing test**

Create `src/domain/proposal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Proposal, ProposedAction, Stance } from './proposal.js';

const SOURCE = { ordinal: 0, locator: null };
const REASON = { text: 'תנאי התשלום הורעו', findingLabel: 'תנאי תשלום', sourceRef: SOURCE };

const ACTION = {
  headline: 'אשלח מייל לדנה',
  purpose: 'כדי לאשר את מועד ההתקנה',
  intent: 'reply_to_sender',
  agent: 'comms.email',
  toolName: 'mail.send',
  input: { to: 'dana@example.com', subject: 'תיאום', body: 'שלום' },
  expectedActionClass: 'email.reply',
};

function proposal(overrides: Record<string, unknown> = {}) {
  return { stance: 'act', headline: 'אשיב לדנה', reasons: [REASON], action: ACTION, ...overrides };
}

describe('Proposal', () => {
  it('accepts a well-formed act proposal', () => {
    expect(Proposal.safeParse(proposal()).success).toBe(true);
  });

  it('accepts a proposal with no action', () => {
    expect(Proposal.safeParse(proposal({ stance: 'no_action', action: null })).success).toBe(true);
  });

  it('rejects an empty reasons array, because a position without a reason cannot be argued with', () => {
    expect(Proposal.safeParse(proposal({ reasons: [] })).success).toBe(false);
  });

  it('rejects an unknown stance', () => {
    expect(Proposal.safeParse(proposal({ stance: 'maybe' })).success).toBe(false);
  });

  it('rejects a reason that cites no finding', () => {
    const bare = { text: 'לא כדאי', findingLabel: '', sourceRef: SOURCE };
    expect(Proposal.safeParse(proposal({ reasons: [bare] })).success).toBe(false);
  });

  it('rejects an action naming an agent that does not exist', () => {
    expect(ProposedAction.safeParse({ ...ACTION, agent: 'comms.telepathy' }).success).toBe(false);
  });

  it('rejects an action whose intent is not in the registry', () => {
    expect(ProposedAction.safeParse({ ...ACTION, intent: 'sign_contract' }).success).toBe(false);
  });

  it('requires an action to say what it is for, not only what it does', () => {
    const { purpose: _dropped, ...noPurpose } = ACTION;
    expect(ProposedAction.safeParse(noPurpose).success).toBe(false);
  });

  it('declares exactly four stances', () => {
    expect([...Stance.options].sort()).toEqual(['act', 'advise_against', 'ask', 'no_action']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/proposal.test.ts`
Expected: FAIL — `Cannot find module './proposal.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/proposal.ts`:

```ts
import { z } from 'zod';
import { ActionClass } from './action.js';
import { AgentId } from './audit.js';
import { IntentName, SourceRef } from './reading.js';

/**
 * Where the assistant stands on what it read.
 *
 * `advise_against` is the member that did not exist in any form before: the
 * system could plan or not plan, and had no way to say "I think you should
 * not, and here is why". It may carry an *alternative* action — and that
 * alternative, never the objection, is what an approval authorises
 * (spec §4).
 */
export const Stance = z.enum(['act', 'advise_against', 'ask', 'no_action']);
export type Stance = z.infer<typeof Stance>;

/**
 * One reason, tied to the finding it rests on.
 *
 * The citation is not decoration. A reason that points at nothing is an
 * opinion, and the reading layer already refuses claims that cite nothing —
 * there is no argument for relaxing the rule one layer up.
 */
export const Reason = z.object({
  text: z.string().min(1),
  /** The `Finding.label` in the reading this reason rests on. */
  findingLabel: z.string().min(1),
  sourceRef: SourceRef,
});
export type Reason = z.infer<typeof Reason>;

/**
 * The single thing that would happen.
 *
 * `agent`, `intent` and `expectedActionClass` are closed enums, so a proposal
 * naming an agent or an intent that does not exist fails to parse rather than
 * failing when something tries to run it. `toolName` is checked against the
 * capability catalogue in `proposalProblems` — a closed enum here would have
 * to be written by hand beside the allowlists and would drift from them.
 *
 * `purpose` is required. "I will send Dana an email" is an act; "to confirm
 * the installation date" is why anyone would approve it, and an approval
 * screen without it asks the owner to guess.
 */
export const ProposedAction = z.object({
  headline: z.string().min(1),
  purpose: z.string().min(1),
  intent: IntentName,
  agent: AgentId,
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  expectedActionClass: ActionClass.nullable().default(null),
});
export type ProposedAction = z.infer<typeof ProposedAction>;

/**
 * What the assistant proposes, in the form the owner decides on.
 *
 * `reasons` is `.min(1)` for every stance including `no_action`: "I read it
 * and nothing follows" without a reason is exactly the claim nobody can
 * disagree with, and therefore the one worth least.
 *
 * The reading's own summary is deliberately absent. It is already stored in
 * `document_readings`; asking the model for it again would produce a second
 * version that drifts from the first. What is saved once is not asked twice.
 */
export const Proposal = z.object({
  stance: Stance,
  /** One line the owner reads first: "אני נגד חתימה על החוזה". */
  headline: z.string().min(1),
  reasons: z.array(Reason).min(1),
  action: ProposedAction.nullable(),
  /** At most one. Two questions are an interrogation, not a clarification. */
  clarifyingQuestion: z.string().nullable().default(null),
});
export type Proposal = z.infer<typeof Proposal>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/domain/proposal.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/domain/proposal.ts src/domain/proposal.test.ts
git commit -m "A proposal has a stance, and every reason cites a finding

advise_against is the member that did not exist: the system could plan or not
plan, and had no way to say it thinks you should not.

reasons is min(1) for every stance including no_action. \"I read it and nothing
follows\" without a reason is the claim nobody can disagree with.

The reading's summary is not in the schema. It is stored already; asking for it
again produces a second version that drifts from the first.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Parsing and validating a proposal

**Files:**
- Create: `src/orchestrator/proposal-parse.ts`, `src/orchestrator/proposal-parse.test.ts`

**Interfaces:**
- Consumes: `Proposal` from `src/domain/proposal.js`; `Reading` from `src/domain/reading.js`; `CatalogueEntry` from `src/orchestrator/catalogue.js`; `classifyAction` from `src/policy/classify.js`.
- Produces:
  - `type ProposalProblem = { kind: 'act_without_action' | 'action_on_passive_stance' | 'ask_without_question' | 'reason_cites_unknown_finding' | 'tool_not_in_catalogue' | 'action_class_mismatch'; detail: string }`
  - `proposalProblems(proposal: Proposal, reading: Reading, catalogue: readonly CatalogueEntry[]): ProposalProblem[]`
  - `type ParseOutcome = { status: 'proposed'; proposal: Proposal } | { status: 'unproposable'; reason: string }`
  - `parseProposal(raw: string, reading: Reading, catalogue: readonly CatalogueEntry[]): ParseOutcome`

**Context:** This mirrors `src/documents/reading-parse.ts`, including a local balanced-brace scanner. **Write the scanner here; do not import it** — it is private in both `planner.ts` and `reading-parse.ts`, and the three callers answer to different prompts and are allowed to diverge. Read `src/documents/reading-parse.ts` first for the shape.

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/proposal-parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Reading } from '../domain/reading.js';
import type { CatalogueEntry } from './catalogue.js';
import { parseProposal, proposalProblems } from './proposal-parse.js';

const SOURCE = { ordinal: 0, locator: null };

const READING: Reading = {
  summary: 'הצעת מחיר.',
  findings: [{ label: 'תנאי תשלום', value: 'שוטף + 60', sourceRef: SOURCE }],
  intents: [{ intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' }],
  unreadable: [],
};

const CATALOGUE: CatalogueEntry[] = [
  { agent: 'comms.email', tools: [{ toolName: 'mail.send', actionClass: 'email.reply', effectiveAutonomy: 'approve_required' }] },
];

const ACTION = {
  headline: 'אשלח מייל לדנה',
  purpose: 'כדי לאשר את התנאים',
  intent: 'reply_to_sender',
  agent: 'comms.email',
  toolName: 'mail.send',
  input: { to: 'dana@example.com', inReplyTo: 'msg-1' },
  expectedActionClass: 'email.reply',
};

const VALID = {
  stance: 'act',
  headline: 'אשיב לדנה על ההצעה',
  reasons: [{ text: 'התנאים הורעו', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: ACTION,
};

describe('parseProposal', () => {
  it('parses a bare JSON object', () => {
    const outcome = parseProposal(JSON.stringify(VALID), READING, CATALOGUE);
    expect(outcome.status).toBe('proposed');
    if (outcome.status !== 'proposed') throw new Error('expected a proposal');
    expect(outcome.proposal.headline).toBe('אשיב לדנה על ההצעה');
  });

  it('parses a response wrapped in prose and a fence', () => {
    const raw = `הנה ההצעה:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``;
    expect(parseProposal(raw, READING, CATALOGUE).status).toBe('proposed');
  });

  it('reports unproposable when there is no JSON', () => {
    const outcome = parseProposal('לא הצלחתי להחליט.', READING, CATALOGUE);
    expect(outcome.status).toBe('unproposable');
    if (outcome.status !== 'unproposable') throw new Error('expected unproposable');
    expect(outcome.reason).toContain('JSON');
  });

  it('refuses act with no action', () => {
    const outcome = parseProposal(JSON.stringify({ ...VALID, action: null }), READING, CATALOGUE);
    expect(outcome.status).toBe('unproposable');
  });

  it('refuses no_action that carries an action', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, stance: 'no_action' }), READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  it('refuses ask without a question', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, stance: 'ask', action: null, clarifyingQuestion: null }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  it('accepts advise_against with an alternative action', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, stance: 'advise_against', headline: 'אני נגד' }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('proposed');
  });

  it('accepts advise_against with no alternative', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, stance: 'advise_against', headline: 'אני נגד', action: null }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('proposed');
  });

  it('refuses a reason citing a finding the reading does not have', () => {
    const invented = { text: 'x', findingLabel: 'סעיף שלא קיים', sourceRef: SOURCE };
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, reasons: [invented] }), READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
    if (outcome.status !== 'unproposable') throw new Error('expected unproposable');
    expect(outcome.reason).toContain('סעיף שלא קיים');
  });

  it('refuses a tool the catalogue does not offer this agent', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, action: { ...ACTION, toolName: 'wa.send_message' } }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  it('refuses an expectedActionClass that contradicts the real classification', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, action: { ...ACTION, expectedActionClass: 'payment.execute' } }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });
});

describe('proposalProblems', () => {
  it('finds nothing wrong with a well-formed proposal', () => {
    const outcome = parseProposal(JSON.stringify(VALID), READING, CATALOGUE);
    if (outcome.status !== 'proposed') throw new Error('expected a proposal');
    expect(proposalProblems(outcome.proposal, READING, CATALOGUE)).toEqual([]);
  });

  it('names the stance problem it found', () => {
    const outcome = parseProposal(JSON.stringify({ ...VALID, stance: 'advise_against', headline: 'x' }), READING, CATALOGUE);
    if (outcome.status !== 'proposed') throw new Error('expected a proposal');
    const problems = proposalProblems({ ...outcome.proposal, action: null, stance: 'act' }, READING, CATALOGUE);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe('act_without_action');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/orchestrator/proposal-parse.test.ts`
Expected: FAIL — `Cannot find module './proposal-parse.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/orchestrator/proposal-parse.ts`:

```ts
/**
 * Turning what the model said into a `Proposal`, or into a stated reason why
 * it is not one (spec §8).
 *
 * Same shape as `src/documents/reading-parse.ts`: a balanced-brace scan that
 * tolerates prose and fences, zod for the shape, and a separate structural
 * pass for what a schema cannot express. The scanner is written here rather
 * than imported — it is private in `planner.ts` and in `reading-parse.ts`,
 * and the three callers answer to different prompts and may diverge.
 *
 * Nothing here throws on model output. A response that is not a proposal is a
 * result to record.
 */

import { Proposal } from '../domain/proposal.js';
import type { Reading } from '../domain/reading.js';
import { classifyAction } from '../policy/classify.js';
import type { CatalogueEntry } from './catalogue.js';

export type ProposalProblem = {
  kind:
    | 'act_without_action'
    | 'action_on_passive_stance'
    | 'ask_without_question'
    | 'reason_cites_unknown_finding'
    | 'tool_not_in_catalogue'
    | 'action_class_mismatch';
  detail: string;
};

export type ParseOutcome =
  | { status: 'proposed'; proposal: Proposal }
  | { status: 'unproposable'; reason: string };

/**
 * The checks a schema cannot make: stance constraints, citation integrity, and
 * feasibility against the catalogue.
 *
 * Stance constraints live here rather than as zod refinements because a
 * refinement produces an error message nobody can act on, while a named
 * problem can say which rule it broke and why the rule exists.
 */
export function proposalProblems(
  proposal: Proposal,
  reading: Reading,
  catalogue: readonly CatalogueEntry[],
): ProposalProblem[] {
  const problems: ProposalProblem[] = [];
  const { stance, action } = proposal;

  if (stance === 'act' && action === null) {
    problems.push({
      kind: 'act_without_action',
      detail: 'המלצה לפעול שאינה אומרת מה לעשות',
    });
  }
  if ((stance === 'ask' || stance === 'no_action') && action !== null) {
    problems.push({
      kind: 'action_on_passive_stance',
      detail: `עמדה ${stance} אינה יכולה לשאת פעולה`,
    });
  }
  if (stance === 'ask' && proposal.clarifyingQuestion === null) {
    problems.push({ kind: 'ask_without_question', detail: 'עמדת ask בלי שאלה' });
  }

  const known = new Set(reading.findings.map((finding) => finding.label));
  for (const reason of proposal.reasons) {
    if (!known.has(reason.findingLabel)) {
      problems.push({
        kind: 'reason_cites_unknown_finding',
        detail: `נימוק מצטט ממצא שאינו בקריאה: ${reason.findingLabel}`,
      });
    }
  }

  if (action !== null) {
    const entry = catalogue.find((candidate) => candidate.agent === action.agent);
    const offered = entry?.tools.some((tool) => tool.toolName === action.toolName) ?? false;
    if (!offered) {
      problems.push({
        kind: 'tool_not_in_catalogue',
        detail: `${action.agent} אינו מחזיק את ${action.toolName} כרגע`,
      });
    }

    // Advisory, but a mismatch means the planner intended something other than
    // what will happen — the same rule `Plan` already holds for its steps.
    const actual = classifyAction(action.toolName);
    if (action.expectedActionClass !== null && actual !== null && action.expectedActionClass !== actual) {
      problems.push({
        kind: 'action_class_mismatch',
        detail: `תוכנן ${action.expectedActionClass}, יסווג ${actual}`,
      });
    }
  }

  return problems;
}

export function parseProposal(
  raw: string,
  reading: Reading,
  catalogue: readonly CatalogueEntry[],
): ParseOutcome {
  const candidates = extractJsonObjects(raw);
  if (candidates.length === 0) {
    return { status: 'unproposable', reason: 'no JSON object in the response' };
  }

  let reason = 'schema mismatch';
  for (const candidate of candidates) {
    const parsed = Proposal.safeParse(candidate);
    if (!parsed.success) {
      reason = parsed.error.issues[0]?.message ?? reason;
      continue;
    }

    const problems = proposalProblems(parsed.data, reading, catalogue);
    if (problems.length > 0) {
      const first = problems[0];
      return { status: 'unproposable', reason: `${first?.kind}: ${first?.detail}` };
    }

    return { status: 'proposed', proposal: parsed.data };
  }

  return { status: 'unproposable', reason };
}

/** Every balanced JSON object in a response that may be wrapped in prose or a fence. */
function extractJsonObjects(raw: string): unknown[] {
  const text = raw.replace(/```(?:json)?/g, '');
  const found: unknown[] = [];

  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            found.push(JSON.parse(text.slice(start, i + 1)));
          } catch {
            // Not valid alone; a later brace may still open a valid object.
          }
          break;
        }
      }
    }
  }
  return found;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/orchestrator/proposal-parse.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Prove the citation check bites**

Stub `proposalProblems` to `return [];`, run the file, and confirm the citation and stance tests **fail**. Restore and confirm green. Redirect both:

```
npx vitest run src/orchestrator/proposal-parse.test.ts > .superpowers/sdd/2026-08-31-proposal-planner/task-2-mut-fail.txt 2>&1
npx vitest run src/orchestrator/proposal-parse.test.ts > .superpowers/sdd/2026-08-31-proposal-planner/task-2-mut-pass.txt 2>&1
```

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/orchestrator/proposal-parse.ts src/orchestrator/proposal-parse.test.ts
git commit -m "Parse a proposal, and refuse one whose reasons cite nothing real

Stance constraints live in proposalProblems rather than as zod refinements: a
refinement produces a message nobody can act on, and a named problem can say
which rule it broke.

A reason citing a finding the reading does not have is an opinion wearing a
citation's clothes. The reading layer already refuses that; there is no
argument for relaxing it one layer up.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Compiling a proposal into a plan

**Files:**
- Create: `src/orchestrator/proposal-to-plan.ts`, `src/orchestrator/proposal-to-plan.test.ts`

**Interfaces:**
- Consumes: `Proposal` from `src/domain/proposal.js`; `Plan`, `planProblems` from `src/domain/plan.js`.
- Produces: `proposalToPlan(proposal: Proposal, options: { goal: string }): Plan | null` — `null` when the proposal carries no action.

**Context:** Pure and synchronous, no model, no database. The judgement already happened in the proposal; this is a mapping. The one-step plan must satisfy `Plan.safeParse` **and** `planProblems`, because the engine will run it and rejecting a malformed plan here is far cheaper than failing mid-execution.

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/proposal-to-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Plan, planProblems } from '../domain/plan.js';
import type { Proposal } from '../domain/proposal.js';
import { proposalToPlan } from './proposal-to-plan.js';

const SOURCE = { ordinal: 0, locator: null };

const PROPOSAL: Proposal = {
  stance: 'act',
  headline: 'אשיב לדנה',
  reasons: [{ text: 'התנאים הורעו', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: {
    headline: 'אשלח מייל לדנה',
    purpose: 'כדי לאשר את התנאים',
    intent: 'reply_to_sender',
    agent: 'comms.email',
    toolName: 'mail.send',
    input: { to: 'dana@example.com', inReplyTo: 'msg-1' },
    expectedActionClass: 'email.reply',
  },
  clarifyingQuestion: null,
};

describe('proposalToPlan', () => {
  it('produces a plan the schema and the DAG check both accept', () => {
    const plan = proposalToPlan(PROPOSAL, { goal: 'לטפל בהצעת המחיר' });
    expect(plan).not.toBeNull();
    expect(Plan.safeParse(plan).success).toBe(true);
    expect(planProblems(plan!)).toEqual([]);
  });

  it('produces exactly one step, carrying the proposal\'s own values', () => {
    const plan = proposalToPlan(PROPOSAL, { goal: 'לטפל בהצעת המחיר' });
    expect(plan?.steps).toHaveLength(1);
    const step = plan?.steps[0];
    expect(step?.agent).toBe('comms.email');
    expect(step?.toolName).toBe('mail.send');
    expect(step?.input).toEqual({ to: 'dana@example.com', inReplyTo: 'msg-1' });
    expect(step?.expectedActionClass).toBe('email.reply');
    expect(step?.dependsOn).toEqual([]);
  });

  it('carries the action\'s purpose as the step intent, so the audit row says why', () => {
    const plan = proposalToPlan(PROPOSAL, { goal: 'x' });
    expect(plan?.steps[0]?.intent).toContain('כדי לאשר את התנאים');
  });

  it('returns null when the proposal carries no action', () => {
    expect(proposalToPlan({ ...PROPOSAL, stance: 'no_action', action: null }, { goal: 'x' })).toBeNull();
  });

  it('compiles the alternative action of an advise_against proposal', () => {
    const plan = proposalToPlan({ ...PROPOSAL, stance: 'advise_against' }, { goal: 'x' });
    expect(plan?.steps).toHaveLength(1);
  });

  it('is deterministic — the same proposal compiles identically', () => {
    const a = proposalToPlan(PROPOSAL, { goal: 'x' });
    const b = proposalToPlan(PROPOSAL, { goal: 'x' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/orchestrator/proposal-to-plan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/orchestrator/proposal-to-plan.ts`:

```ts
/**
 * A proposal's single action, compiled into the one-step plan the engine runs
 * (spec §7).
 *
 * Pure and synchronous — no model, no database, no clock. The judgement
 * already happened when the proposal was made; nothing here decides anything.
 * That separation is what lets the whole compilation be tested on a machine
 * with no API key.
 *
 * The step id is a constant rather than a generated one. A one-step plan has
 * nothing to disambiguate, and a random id would make `plan_hash` differ
 * between two compilations of the same proposal — which would defeat the
 * resumption machinery that keys on it.
 */

import type { Plan } from '../domain/plan.js';
import type { Proposal } from '../domain/proposal.js';

const ONLY_STEP_ID = 'step-1';

export function proposalToPlan(
  proposal: Proposal,
  options: { goal: string },
): Plan | null {
  const action = proposal.action;
  if (action === null) return null;

  return {
    goal: options.goal,
    // The reasons are the assumptions: each is a claim the proposal rests on,
    // and each already carries the finding it came from.
    assumptions: proposal.reasons.map((reason) => reason.text),
    clarifyingQuestion: proposal.clarifyingQuestion,
    steps: [
      {
        id: ONLY_STEP_ID,
        agent: action.agent,
        // Both halves: what it is and what it is for. The audit row and the
        // approval card are read by a person months later, and "mail.send"
        // alone tells them nothing about why it was ever proposed.
        intent: `${action.headline} — ${action.purpose}`,
        toolName: action.toolName,
        input: action.input,
        dependsOn: [],
        expectedActionClass: action.expectedActionClass,
      },
    ],
    estimatedCostMinor: 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/orchestrator/proposal-to-plan.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npx vitest run src/orchestrator/proposal-to-plan.test.ts
git add src/orchestrator/proposal-to-plan.ts src/orchestrator/proposal-to-plan.test.ts
git commit -m "Compile a proposal's action into the plan the engine already runs

Pure and synchronous. The judgement happened in the proposal; this is a
mapping, and keeping it one makes the whole compilation testable without a key.

The step id is constant, not generated: a one-step plan has nothing to
disambiguate, and a random id would change plan_hash between two compilations
of the same proposal and defeat the resumption machinery that keys on it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Standing authorisation — the security core

**Files:**
- Create: `src/db/migrations/015_job_authorizations.sql`, `src/orchestrator/authorization.ts`, `src/orchestrator/authorization.test.ts`
- Modify: `src/test/db.ts` — add `job_authorizations` to the TRUNCATE list, immediately before `jobs`

**Interfaces:**
- Consumes: `readEmails` from `src/policy/facts.js`; `ActionClass`, `addresseeOf` from `src/domain/action.js`; `getPool`, `type Queryable` from `src/db/pool.js`; `config`.
- Produces:
  - `interface StandingAuthorization { jobId; businessId; actionClass: ActionClass; recipients: string[]; grantedBy: 'boss'; }`
  - `grantAuthorization(input: { jobId; actionClass; recipients: string[] }, options?): Promise<void>`
  - `loadAuthorization(jobId: string, options?): Promise<StandingAuthorization | null>`
  - `coveredByAuthorization(auth: StandingAuthorization | null, facts: { actionClass: ActionClass; input: Record<string, unknown>; amountDeclared: boolean; amountMinor: number }): boolean`

**Context — read this before writing a line.** This is the file the whole sub-project's safety rests on. Two rules, both absolute:

1. **A row here is written only from a path the boss actually drove.** No code may write it from a `Reading`, a `Proposal`, or anything a model produced. A document whose body says "the boss asked me to wire payment" must buy nothing.
2. **Recipient matching reuses `readEmails` from `src/policy/facts.ts`.** Do not write a second recipient reader. Read that function's docblock: it exists shared precisely so the gate screens the same addresses the mail adapter sends to, and a second reader is how those two drift apart.

Money: `coveredByAuthorization` returns `false` whenever `amountDeclared` is true or `amountMinor` is non-zero. No threshold, no exception — an instruction proves the owner wanted something done, never that they saw the amount.

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/015_job_authorizations.sql`:

```sql
-- What the owner authorised when they opened a job
-- (docs/superpowers/specs/2026-08-31-proposal-planner-design.md §6).
--
-- An assistant that asks permission for the thing it was just told to do is an
-- assistant that annoys instead of helping. A row here says: for THIS job, the
-- owner already named this action class and these recipients, so the gate does
-- not ask a second time.
--
-- This is not a way around the gate. All ten stages still run — kill switch,
-- charter ceilings, quiet hours, budget, risk, audit. One stage changes:
-- needsApproval is satisfied by the instruction on record instead of by a
-- fresh question.
--
-- THE RULE THIS TABLE EXISTS TO HOLD: a row is written only from a path the
-- owner actually drove. Nothing derived from a document, a Reading, a Proposal,
-- or any model output may write here. A document whose body claims the owner
-- asked for something is content, not a stamp — and the difference between
-- those two is the whole prompt-injection defence.
CREATE TABLE job_authorizations (
    business_id  TEXT        NOT NULL,
    job_id       TEXT        NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
    -- The action class the owner named. A different class asks.
    action_class TEXT        NOT NULL,
    -- The addresses the owner named, lower-cased. An action whose recipients
    -- are not a subset of these asks. Empty means the owner named no
    -- recipient, which covers only internal actions.
    recipients   TEXT[]      NOT NULL DEFAULT '{}',
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One authorisation per job. An owner who wants a second action authorised
    -- opens a second job; widening an existing grant in place would leave no
    -- record of what was originally asked for.
    PRIMARY KEY (business_id, job_id)
);
```

- [ ] **Step 2: Run the migration**

Run: `npm run migrate:test`
Expected: reports migration 015 applied.

- [ ] **Step 3: Add the table to `resetDatabase`**

In `src/test/db.ts`, add `job_authorizations,` to the TRUNCATE list immediately **before** `jobs,`. `CASCADE` would reach it through the foreign key, but a table truncated only as someone else's dependent stops being truncated the day that key changes.

- [ ] **Step 4: Write the failing test**

Create `src/orchestrator/authorization.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { compileCharter } from '../charter/compile.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { createJob } from './jobs.js';
import {
  coveredByAuthorization,
  grantAuthorization,
  loadAuthorization,
  type StandingAuthorization,
} from './authorization.js';

const BUSINESS = 'test-business';
const bundle = compileCharter(buildCharter());

const AUTH: StandingAuthorization = {
  jobId: 'J-x',
  businessId: BUSINESS,
  actionClass: 'email.reply',
  recipients: ['dana@example.com'],
  grantedBy: 'boss',
};

const NO_MONEY = { amountDeclared: false, amountMinor: 0 };

beforeEach(async () => {
  await resetDatabase();
  await installCharter(buildCharter(), { businessId: BUSINESS });
});
afterAll(async () => { await closePool(); });

describe('coveredByAuthorization', () => {
  it('covers the action class and recipient the owner named', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.reply', input: { to: 'dana@example.com' }, ...NO_MONEY,
    })).toBe(true);
  });

  it('covers a recipient written with a display name, because the gate unwraps it', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.reply', input: { to: 'Dana Cohen <dana@example.com>' }, ...NO_MONEY,
    })).toBe(true);
  });

  it('does not cover a different recipient', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.reply', input: { to: 'someone@else.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover a payload that adds a recipient alongside the named one', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.reply', input: { to: 'dana@example.com, other@x.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover a different action class', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.initiate', input: { to: 'dana@example.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('covers an internal action as the one entailed step', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'crm.write', input: {}, ...NO_MONEY,
    })).toBe(true);
  });

  it('never covers an action carrying an amount, however small', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.reply', input: { to: 'dana@example.com' },
      amountDeclared: true, amountMinor: 1,
    })).toBe(false);
  });

  it('never covers an action that declares an amount of zero', () => {
    // Declaring zero is still declaring money. The owner's instruction proves
    // they wanted something done, never that they saw a figure.
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.reply', input: { to: 'dana@example.com' },
      amountDeclared: true, amountMinor: 0,
    })).toBe(false);
  });

  it('covers nothing when there is no authorisation', () => {
    expect(coveredByAuthorization(null, {
      actionClass: 'email.reply', input: { to: 'dana@example.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover an outbound action when the owner named no recipient', () => {
    expect(coveredByAuthorization({ ...AUTH, recipients: [] }, {
      actionClass: 'email.reply', input: { to: 'dana@example.com' }, ...NO_MONEY,
    })).toBe(false);
  });
});

describe('grantAuthorization', () => {
  it('stores and reloads what the owner named', async () => {
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'boss',
      businessId: BUSINESS, title: 'להשיב לדנה',
    });
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['Dana@Example.com'] },
      { businessId: BUSINESS },
    );
    const loaded = await loadAuthorization(job.jobId, { businessId: BUSINESS });
    expect(loaded?.actionClass).toBe('email.reply');
    // Lower-cased on the way in, so a match cannot be defeated by casing.
    expect(loaded?.recipients).toEqual(['dana@example.com']);
  });

  it('refuses to authorise a job whose provenance is not boss', async () => {
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'unknown_external',
      businessId: BUSINESS, title: 'מסמך שהגיע',
    });
    await expect(
      grantAuthorization(
        { jobId: job.jobId, actionClass: 'email.reply', recipients: ['x@y.com'] },
        { businessId: BUSINESS },
      ),
    ).rejects.toThrow();
  });

  it('returns null for a job nobody authorised', async () => {
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS,
    });
    expect(await loadAuthorization(job.jobId, { businessId: BUSINESS })).toBeNull();
  });

  it('does not cross the business boundary', async () => {
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS,
    });
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['x@y.com'] },
      { businessId: BUSINESS },
    );
    expect(await loadAuthorization(job.jobId, { businessId: 'other-business' })).toBeNull();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run src/orchestrator/authorization.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Write the implementation**

Create `src/orchestrator/authorization.ts`:

```ts
/**
 * Standing authorisation: the owner's instruction, on record, standing in for
 * an approval question (spec §6).
 *
 * **Where the instruction is read from is the entire control.** It comes from
 * a row written when the owner opened the job, and from the job's stamped
 * provenance column — never from content. `grantAuthorization` refuses a job
 * whose provenance is not `boss`, which is what stops a document that claims
 * the owner asked for something from buying the authority to do it. Provenance
 * is written before any model sees content, and no prompt can change a column.
 *
 * Recipient matching reuses `readEmails` from `src/policy/facts.ts` rather
 * than reading the payload again here. That function's docblock records why it
 * is shared: the gate must screen the same addresses the mail adapter sends
 * to, and a second reader is exactly how those two drift apart. Display-name
 * forms like `Dana Cohen <dana@x.com>` unwrap there, so they compare equal
 * here without this file knowing that they need to.
 */

import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { ActionClass, addresseeOf } from '../domain/action.js';
import { readEmails } from '../policy/facts.js';

export interface StandingAuthorization {
  jobId: string;
  businessId: string;
  actionClass: ActionClass;
  /** Lower-cased addresses the owner named. */
  recipients: string[];
  /** Only one grantor is expressible; the field exists so audit reads plainly. */
  grantedBy: 'boss';
}

interface AuthorizationRow {
  business_id: string;
  job_id: string;
  action_class: string;
  recipients: string[];
}

function toAuthorization(row: AuthorizationRow): StandingAuthorization {
  return {
    jobId: row.job_id,
    businessId: row.business_id,
    actionClass: row.action_class as ActionClass,
    recipients: row.recipients,
    grantedBy: 'boss',
  };
}

/**
 * Record what the owner authorised when they opened a job.
 *
 * Refuses any job whose provenance is not `boss`. The check reads the jobs
 * table rather than trusting the caller: a caller that could assert its own
 * provenance would be a caller that could forge an instruction, and this
 * function exists to make that impossible from inside the process.
 */
export async function grantAuthorization(
  input: { jobId: string; actionClass: ActionClass; recipients: string[] },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const db = options.db ?? getPool();
  const businessId = options.businessId ?? config.businessId;

  const { rows } = await db.query<{ provenance: string }>(
    'SELECT provenance FROM jobs WHERE job_id = $1 AND business_id = $2',
    [input.jobId, businessId],
  );
  const provenance = rows[0]?.provenance;
  if (provenance === undefined) {
    throw new Error(`grantAuthorization: no job ${input.jobId} for business ${businessId}`);
  }
  if (provenance !== 'boss') {
    throw new Error(
      `grantAuthorization: job ${input.jobId} has provenance ${provenance}; only a boss-initiated job carries a standing instruction`,
    );
  }

  await db.query(
    `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
     VALUES ($1, $2, $3, $4)`,
    [businessId, input.jobId, input.actionClass, input.recipients.map((r) => r.toLowerCase())],
  );
}

export async function loadAuthorization(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<StandingAuthorization | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<AuthorizationRow>(
    `SELECT business_id, job_id, action_class, recipients FROM job_authorizations
      WHERE business_id = $1 AND job_id = $2`,
    [options.businessId ?? config.businessId, jobId],
  );
  const row = rows[0];
  return row === undefined ? null : toAuthorization(row);
}

/**
 * Does the instruction already on record cover this call?
 *
 * Positive throughout: every condition must hold for the answer to be `true`,
 * and anything unrecognised falls to `false`. The three the owner set:
 * the same action class, no recipient beyond the ones named, and no money at
 * all.
 */
export function coveredByAuthorization(
  auth: StandingAuthorization | null,
  facts: {
    actionClass: ActionClass;
    input: Record<string, unknown>;
    amountDeclared: boolean;
    amountMinor: number;
  },
): boolean {
  if (auth === null) return false;

  // Money always asks. An instruction proves the owner wanted something done;
  // it never proves they saw a figure. A declared zero is still a declaration.
  if (facts.amountDeclared || facts.amountMinor !== 0) return false;

  // The one entailed step: an action that reaches nobody — filing the
  // correspondence, recording the contact. It carries no destination, so the
  // recipient question does not arise.
  if (addresseeOf(facts.actionClass) === 'internal') return true;

  if (facts.actionClass !== auth.actionClass) return false;

  const named = new Set(auth.recipients);
  if (named.size === 0) return false;

  const going = readEmails(facts.input);
  if (going.length === 0) return false;

  // `every`, not `some`: one authorised recipient does not vouch for the
  // strangers standing beside them. The same reasoning `scoreVisibility`
  // already applies in the risk engine.
  return going.every((address) => named.has(address));
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run src/orchestrator/authorization.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 8: Prove the recipient check bites**

Change `going.every(...)` to `going.some(...)`, run the file, and confirm the test `does not cover a payload that adds a recipient alongside the named one` **fails**. Restore and confirm green. Redirect both to `.superpowers/sdd/2026-08-31-proposal-planner/task-4-mut-fail.txt` and `-pass.txt` with `2>&1`.

- [ ] **Step 9: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/db/migrations/015_job_authorizations.sql src/orchestrator/authorization.ts src/orchestrator/authorization.test.ts src/test/db.ts
git commit -m "Standing authorisation, and where it is allowed to come from

A row here says the owner already named this action class and these recipients
for this job, so the gate does not ask twice. grantAuthorization refuses any
job whose provenance is not boss, reading the column rather than trusting the
caller — a caller that could assert its own provenance could forge an
instruction.

Recipient matching reuses readEmails rather than reading the payload again.
The gate must screen the addresses the mail adapter sends to, and a second
reader is how those two drift apart.

every, not some: one authorised recipient does not vouch for the strangers
beside them. And money always asks — a declared zero is still a declaration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wiring the gate

**Files:**
- Modify: `src/policy/engine.ts` — `GateContext` gains two optional fields; `needsApproval` consults the authorisation; the approval's `summary`/`detail` come from the proposal
- Create: `src/policy/standing-approval.test.ts`

**Interfaces:**
- Consumes: `coveredByAuthorization`, `type StandingAuthorization` from `src/orchestrator/authorization.js`.
- Produces: `GateContext.standingAuthorization?: StandingAuthorization | null` and `GateContext.proposalText?: { headline: string; detail: string }`.

**Context — the two changes, and the line between them.**

**Change A — the approval card's words.** Today `enqueueApproval` is called with `summary: risk.explanation` and a detail built from the tool name. When `ctx.proposalText` is supplied, `summary` becomes its headline and `detail` its detail. **The risk explanation is not deleted** — it stays in the risk row of the card, where it belongs. A person needs to know both what is proposed and why the system is uneasy; those are two facts.

**Change B — standing authorisation.** `needsApproval` today is:

```ts
const needsApproval =
  effective === 'approve_required' ||
  risk.band !== 'routine' ||
  NEVER_FULLY_AUTONOMOUS.has(facts.actionClass);
```

It becomes:

```ts
const standing = coveredByAuthorization(ctx.standingAuthorization ?? null, {
  actionClass: facts.actionClass,
  input: toolInput,
  amountDeclared: facts.amountDeclared,
  amountMinor: facts.amountMinor,
});

const needsApproval =
  // Absolute, and standing authorisation cannot reach it. A class that is
  // never fully autonomous is never fully autonomous.
  NEVER_FULLY_AUTONOMOUS.has(facts.actionClass) ||
  (!standing && (effective === 'approve_required' || risk.band !== 'routine'));
```

**Read this before writing the test, or the test will pass for the wrong reason.** Stage 8 (autonomy) runs *before* this line and denies anything whose effective autonomy is `draft_only`. The ramp floor is `draft_only` for every action class and no production caller raises it, so **in production this code is unreachable today**. A test that does not raise the ramp will be denied at stage 8 and never reach `needsApproval` — it would assert the right outcome for entirely the wrong reason, which is the exact defect the previous plan sent two tasks back for.

Every test here must therefore pass a `rampLevel` above `draft_only` **and** assert that the decision is `allow`, not merely that no approval was queued.

- [ ] **Step 1: Write the failing test**

Create `src/policy/standing-approval.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { compileCharter } from '../charter/compile.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { createJob } from '../orchestrator/jobs.js';
import { grantAuthorization, loadAuthorization } from '../orchestrator/authorization.js';
import { evaluateToolCall } from './engine.js';

const BUSINESS = 'test-business';
const bundle = compileCharter(buildCharter());

async function bossJob(title: string) {
  return createJob({
    charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS, title,
  });
}

/** A reply to Dana. Classified `email.reply` because it carries `inReplyTo`. */
const REPLY = { to: 'dana@example.com', inReplyTo: 'msg-1', subject: 'תיאום', body: 'שלום' };

beforeEach(async () => {
  await resetDatabase();
  await installCharter(buildCharter(), { businessId: BUSINESS });
});
afterAll(async () => { await closePool(); });

describe('standing authorisation at the gate', () => {
  it('lets an authorised reply through without queueing an approval', async () => {
    const job = await bossJob('להשיב לדנה');
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['dana@example.com'] },
      { businessId: BUSINESS },
    );
    const auth = await loadAuthorization(job.jobId, { businessId: BUSINESS });

    const decision = await evaluateToolCall('mail.send', REPLY, {
      agent: 'comms.email',
      bundle,
      provenance: 'boss',
      counterpartyTags: [],
      // Above the floor on purpose: at draft_only stage 8 denies first and
      // this code is never reached.
      rampLevel: 'auto',
      businessId: BUSINESS,
      jobId: job.jobId,
      standingAuthorization: auth,
    });

    // The positive half matters. Without it this test would pass if the call
    // were denied for any reason at all.
    expect(decision.decision).toBe('allow');
    const { rows } = await getPool().query('SELECT 1 FROM approval_requests WHERE job_id = $1', [job.jobId]);
    expect(rows).toHaveLength(0);
  });

  it('still asks when the recipient is not the one authorised', async () => {
    const job = await bossJob('להשיב לדנה');
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['dana@example.com'] },
      { businessId: BUSINESS },
    );
    const auth = await loadAuthorization(job.jobId, { businessId: BUSINESS });

    const decision = await evaluateToolCall('mail.send', { ...REPLY, to: 'stranger@x.com' }, {
      agent: 'comms.email', bundle, provenance: 'boss', counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId, standingAuthorization: auth,
    });

    expect(decision.decision).toBe('queue_approval');
  });

  it('still asks when there is no authorisation at all', async () => {
    const job = await bossJob('משימה בלי הרשאה');
    const decision = await evaluateToolCall('mail.send', REPLY, {
      agent: 'comms.email', bundle, provenance: 'boss', counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId, standingAuthorization: null,
    });
    expect(decision.decision).toBe('queue_approval');
  });

  it('puts the proposal\'s words on the approval instead of the risk sentence', async () => {
    const job = await bossJob('הצעה');
    const decision = await evaluateToolCall('mail.send', { ...REPLY, to: 'stranger@x.com' }, {
      agent: 'comms.email', bundle, provenance: 'boss', counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId,
      proposalText: { headline: 'אשלח מייל לדנה', detail: 'כדי לאשר את מועד ההתקנה' },
    });

    expect(decision.decision).toBe('queue_approval');
    const { rows } = await getPool().query<{ summary: string; detail: string }>(
      'SELECT summary, detail FROM approval_requests WHERE job_id = $1', [job.jobId],
    );
    expect(rows[0]?.summary).toBe('אשלח מייל לדנה');
    expect(rows[0]?.detail).toBe('כדי לאשר את מועד ההתקנה');
  });

  it('falls back to the risk sentence when no proposal text is supplied', async () => {
    const job = await bossJob('בלי הצעה');
    await evaluateToolCall('mail.send', { ...REPLY, to: 'stranger@x.com' }, {
      agent: 'comms.email', bundle, provenance: 'boss', counterpartyTags: [],
      rampLevel: 'auto', businessId: BUSINESS, jobId: job.jobId,
    });
    const { rows } = await getPool().query<{ summary: string }>(
      'SELECT summary FROM approval_requests WHERE job_id = $1', [job.jobId],
    );
    expect(rows[0]?.summary).not.toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/policy/standing-approval.test.ts`
Expected: FAIL — `standingAuthorization` is not a known property of `GateContext`.

- [ ] **Step 3: Add the two fields to `GateContext`**

In `src/policy/engine.ts`, inside `GateContext`, after the existing `approval` field:

```ts
  /**
   * The instruction the owner already gave for this job, if any.
   *
   * Loaded by the caller from `job_authorizations` — never constructed here
   * and never derived from a payload. When it covers the call, `needsApproval`
   * is satisfied by it instead of by a fresh question (spec §6). It cannot
   * reach `NEVER_FULLY_AUTONOMOUS`, and `coveredByAuthorization` refuses
   * anything carrying money.
   */
  standingAuthorization?: StandingAuthorization | null;
  /**
   * What the proposal said, in the owner's language.
   *
   * Fills the approval card's title and description, which today carry the
   * risk engine's own prose. The risk explanation is not replaced — it stays
   * in the card's risk row. A person needs both what is proposed and why the
   * system is uneasy; they are two facts, not one.
   */
  proposalText?: { headline: string; detail: string };
```

Add the import: `import { coveredByAuthorization, type StandingAuthorization } from '../orchestrator/authorization.js';`

- [ ] **Step 4: Change `needsApproval` and the approval text**

Replace the `needsApproval` computation with the form given in the Context block above. Then, in the `enqueueApproval` call, replace the two fields:

```ts
        summary: ctx.proposalText?.headline ?? risk.explanation,
        detail:
          ctx.proposalText?.detail ??
          `${facts.toolName} · ${facts.actionClass} · רצועה ${risk.band}`,
```

Leave every other argument to `enqueueApproval` exactly as it is.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/policy/standing-approval.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Prove the authorisation check bites, twice**

Two mutations, both required, both redirected to files with `2>&1` under `.superpowers/sdd/2026-08-31-proposal-planner/`:

**Mutation A** — force `standing` to `false`. The test `lets an authorised reply through` must fail. Restore.
**Mutation B** — remove the `NEVER_FULLY_AUTONOMOUS` term from `needsApproval` so standing authorisation could reach it. Confirm the existing suite goes red — `src/policy/positive-controls.test.ts` and `src/policy/engine.test.ts` both cover that guarantee. Restore and confirm green. If neither goes red, **stop and report it**: that would mean the guarantee has no test behind it, which is a finding about the existing suite, not about your change.

- [ ] **Step 7: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/policy/engine.ts src/policy/standing-approval.test.ts
git commit -m "The gate accepts an instruction already given, and speaks the owner's words

needsApproval is satisfied by a standing authorisation instead of a fresh
question — but NEVER_FULLY_AUTONOMOUS stays outside its reach, and
coveredByAuthorization refuses anything carrying money.

The approval card's title and description now come from the proposal when one
is supplied. The risk explanation is not replaced; it stays in the risk row. A
person needs both what is proposed and why the system is uneasy.

Every test here raises the ramp above draft_only and asserts allow, not merely
the absence of an approval: at the floor, stage 8 denies first and this code is
never reached, so a test without both halves would pass for the wrong reason.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Storage for proposals

**Files:**
- Create: `src/db/migrations/016_proposals.sql`, `src/orchestrator/proposal-store.ts`, `src/orchestrator/proposal-store.test.ts`
- Modify: `src/test/db.ts` — add `proposals,` immediately before `document_readings,`

**Interfaces:**
- Produces:
  - `interface ProposalRecord { proposalId; businessId; readingId; status: 'proposed' | 'unproposable'; reason: string | null; content: Proposal | null; model; promptVersion; decidedAt: string | null; decidedNote: string | null }`
  - `saveProposal(input: NewProposal, options?): Promise<ProposalRecord>`
  - `loadProposalsForReading(readingId: string, options?): Promise<ProposalRecord[]>`

**Context:** **No deduplication here**, deliberately — unlike readings. A reading is a claim about fixed text, so reading the same brief twice should return one answer. A proposal is a claim about *what is worth doing now*, and the same document deserves a different proposal next week when the charter has changed or the owner rejected the first one. Every call stores a new row.

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/016_proposals.sql`:

```sql
-- What the assistant proposed doing about a reading
-- (docs/superpowers/specs/2026-08-31-proposal-planner-design.md §10).
--
-- No unique index and no dedupe, unlike document_readings. A reading is a
-- claim about fixed text: the same brief under the same question deserves one
-- answer, and paying twice for it is waste. A proposal is a claim about what
-- is worth doing *now* — and the same document legitimately deserves a
-- different proposal next week, after the charter changed, after the ramp
-- rose, or after the owner rejected the first one and asked for another.
--
-- A rejected proposal is kept with the note the owner wrote. That note is the
-- only material from which an agreement rate could ever be measured, and a
-- measured agreement rate is the whole justification for raising the ramp
-- later. Discarding rejections would discard the evidence.
CREATE TABLE proposals (
    proposal_id    TEXT        PRIMARY KEY,
    business_id    TEXT        NOT NULL,
    reading_id     TEXT        NOT NULL REFERENCES document_readings (reading_id) ON DELETE CASCADE,
    status         TEXT        NOT NULL,
    reason         TEXT,
    -- The Proposal itself. Null exactly when the status is `unproposable`.
    content        JSONB,
    model          TEXT        NOT NULL,
    prompt_version TEXT        NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set when the owner acts on it. `decided_note` is what they typed.
    decided_at     TIMESTAMPTZ,
    decided_note   TEXT,

    CONSTRAINT proposals_status_known
        CHECK (status IN ('proposed', 'unproposable')),
    CONSTRAINT proposals_content_present
        CHECK ((status = 'proposed') = (content IS NOT NULL))
);

CREATE INDEX proposals_by_reading_idx
    ON proposals (business_id, reading_id, created_at DESC);
```

- [ ] **Step 2: Run the migration and add the table to `resetDatabase`**

Run: `npm run migrate:test`. Then add `proposals,` to the TRUNCATE list in `src/test/db.ts`, immediately before `document_readings,`.

- [ ] **Step 3: Write the failing test**

Create `src/orchestrator/proposal-store.test.ts`. Build a document and a reading first — `insertOrGetDocument` then `saveReading` — then:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import type { Proposal } from '../domain/proposal.js';
import { insertOrGetDocument } from '../documents/store.js';
import { saveReading } from '../documents/reading-store.js';
import { loadProposalsForReading, saveProposal, type NewProposal } from './proposal-store.js';

const BUSINESS = 'test-business';
const SOURCE = { ordinal: 0, locator: null };

const PROPOSAL: Proposal = {
  stance: 'act',
  headline: 'אשיב לדנה',
  reasons: [{ text: 'התנאים הורעו', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: null,
  clarifyingQuestion: null,
};

async function aReading(): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument({
    documentId, source: 'manual', originalName: 'x.txt', mediaType: 'text/plain',
    sha256: ulid().padEnd(64, '0'), byteSize: 10,
    storedPath: `${BUSINESS}/${documentId}/original.txt`,
  }, { businessId: BUSINESS });
  const { record } = await saveReading({
    readingId: `RDG-${ulid()}`, documentId, status: 'read', reason: null,
    content: { summary: 's', findings: [], intents: [{ intent: 'no_action', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' }], unreadable: [] },
    provenance: 'unknown_external', model: 'haiku', promptVersion: 'v1',
    briefHash: 'a'.repeat(64),
  }, { businessId: BUSINESS });
  return record.readingId;
}

function newProposal(readingId: string, overrides: Partial<NewProposal> = {}): NewProposal {
  return {
    proposalId: `PRP-${ulid()}`, readingId, status: 'proposed', reason: null,
    content: PROPOSAL, model: 'sonnet', promptVersion: 'v1', ...overrides,
  };
}

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

describe('saveProposal', () => {
  it('stores a proposal and hands it back', async () => {
    const readingId = await aReading();
    const record = await saveProposal(newProposal(readingId), { businessId: BUSINESS });
    expect(record.status).toBe('proposed');
    expect(record.content?.headline).toBe('אשיב לדנה');
  });

  it('stores an unproposable outcome, because a failed attempt is a fact', async () => {
    const readingId = await aReading();
    const record = await saveProposal(
      newProposal(readingId, { status: 'unproposable', reason: 'no JSON object', content: null }),
      { businessId: BUSINESS },
    );
    expect(record.reason).toBe('no JSON object');
    expect(record.content).toBeNull();
  });

  it('stores a second proposal for the same reading rather than replacing the first', async () => {
    const readingId = await aReading();
    const first = await saveProposal(newProposal(readingId), { businessId: BUSINESS });
    const second = await saveProposal(newProposal(readingId), { businessId: BUSINESS });
    expect(second.proposalId).not.toBe(first.proposalId);
    const all = await loadProposalsForReading(readingId, { businessId: BUSINESS });
    expect(all).toHaveLength(2);
  });

  it('refuses a proposed row with no content', async () => {
    const readingId = await aReading();
    await expect(
      saveProposal(newProposal(readingId, { content: null }), { businessId: BUSINESS }),
    ).rejects.toThrow();
  });

  it('does not cross the business boundary', async () => {
    const readingId = await aReading();
    await saveProposal(newProposal(readingId), { businessId: BUSINESS });
    expect(await loadProposalsForReading(readingId, { businessId: 'other' })).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails, then implement**

Run: `npx vitest run src/orchestrator/proposal-store.test.ts` — expect module-not-found.

Create `src/orchestrator/proposal-store.ts` following `src/documents/reading-store.ts` exactly: a private `ProposalRow` interface, a `toProposal(row)` function, a shared `COLUMNS` constant, parameterised statements throughout, `rows[0]?.x` access, and the conditional-spread pattern for the optional `db`. A plain `INSERT ... RETURNING` — there is no conflict clause here, because there is no dedupe.

- [ ] **Step 5: Run the test, typecheck, full suite, commit**

```bash
npx vitest run src/orchestrator/proposal-store.test.ts
npm run typecheck && npm test
git add src/db/migrations/016_proposals.sql src/orchestrator/proposal-store.ts src/orchestrator/proposal-store.test.ts src/test/db.ts
git commit -m "Store proposals, without deduplicating them

No unique index, unlike document_readings, and the difference is the point. A
reading is a claim about fixed text and deserves one answer. A proposal is a
claim about what is worth doing now — the same document legitimately deserves
a different proposal next week.

A rejected proposal is kept with the owner's note. That note is the only
material an agreement rate could ever be measured from, and a measured
agreement rate is the whole justification for raising the ramp later.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The proposal prompt

**Files:**
- Create: `src/sdk/proposal-prompt.ts`, `src/sdk/proposal-prompt.test.ts`

**Interfaces:**
- Consumes: `Stance` from `src/domain/proposal.js`; `INTENT_MEANING`, `IntentName` from `src/domain/reading.js`; `renderCatalogue`, `capabilityCatalogue` from `src/orchestrator/catalogue.js`; `type PolicyBundle`, `type Reading`.
- Produces: `PROPOSAL_PROMPT_VERSION: string`, `buildProposalSystemPrompt(bundle: PolicyBundle, catalogue: string): string`, `renderReadingForProposal(reading: Reading): string`.

**Context:** Same caching discipline as everywhere else in this codebase: the charter, the stance vocabulary, the catalogue and the output schema are byte-identical between calls and go first; the reading is the only varying part and goes last. `buildPlannerPrompt` in `src/sdk/planner.ts` already follows this — read it.

The stance list is generated from `Stance.options`, never typed out. `PROPOSAL_PROMPT_VERSION` is a hand-raised constant, not a hash.

**The prompt must state, in Hebrew, the four rules the validator will enforce**, so a well-behaved model does not have to discover them by rejection: every reason names a finding label from the reading verbatim; `act` requires an action and `ask`/`no_action` forbid one; the tool must come from the catalogue shown; and a headline describes what happens, in the owner's language, not a tool name.

- [ ] **Step 1: Write the failing test**

Create `src/sdk/proposal-prompt.test.ts` asserting: every `Stance.options` member appears; the charter fragment leads (`startsWith`); the rendered catalogue appears; the reading render carries every finding label; output is byte-identical across calls; and `PROPOSAL_PROMPT_VERSION` matches `/^v\d+$/`.

- [ ] **Step 2–4: Fail, implement, pass**

Run the file, watch it fail on the missing module, implement, and confirm green.

- [ ] **Step 5: Prove the finding labels reach the prompt**

Mutate `renderReadingForProposal` to emit finding *values* without their labels; confirm the label test fails; restore. Redirect both outputs.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck && npx vitest run src/sdk/proposal-prompt.test.ts
git add src/sdk/proposal-prompt.ts src/sdk/proposal-prompt.test.ts
git commit -m "The proposer's stable prompt prefix

Charter, stances, catalogue and schema first and byte-identical; the reading
last as the only varying part. Same rule buildPlannerPrompt follows, and for
the same reason: a byte near the front costs the whole cached prefix.

The prompt states the four rules the validator enforces, so a well-behaved
model learns them by being told rather than by being rejected.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The model call

**Files:**
- Create: `src/sdk/proposer.ts`, `src/sdk/proposer.test.ts`

**Interfaces:**
- Consumes: `buildProposalSystemPrompt`, `renderReadingForProposal`, `PROPOSAL_PROMPT_VERSION`; `parseProposal` from `src/orchestrator/proposal-parse.js`; `capabilityCatalogue`, `renderCatalogue`.
- Produces:
  - `PROPOSER_MODEL: string`
  - `type ProposeOutcome = { status: 'proposed'; proposal: Proposal; raw: string } | { status: 'unproposable'; reason: string; raw: string }`
  - `interpretProposerResponse(raw, reading, catalogue): ProposeOutcome` — pure, exported, carries the coverage
  - `makeProposal(request): Promise<ProposeOutcome>`

**Context:** Mirror `src/sdk/know-reader.ts` after its reshape. **The planner has no tools at all** — `tools: []` — and that is not an oversight: a planner that could act would be a second, ungated path to every capability. `src/sdk/planner.ts` already sets this; copy it and keep the reasoning in a comment.

`settingSources: []` and the `PATH`-only `env` allowlist come across unchanged, for the reasons their docblocks in `know-reader.ts` give.

`PROPOSER_MODEL` is exported and used both in `Options.model` and by the composition when it records attribution — one constant, two consumers, so they cannot drift. That defect was found and fixed in sub-project ב'; do not reintroduce it.

- [ ] **Steps 1–5:** Write `src/sdk/proposer.test.ts` covering `interpretProposerResponse` — a valid response, a response wrapped in prose, no JSON at all, a stance violation, and a tool outside the catalogue. Watch it fail, implement, confirm green. Mutate `interpretProposerResponse` to trust any parseable JSON and confirm the stance-violation test fails; restore.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/sdk/proposer.ts src/sdk/proposer.test.ts
git commit -m "The proposer: one model call, no tools at all

tools: [] is the design, not an omission — a planner that could act would be a
second ungated path to every capability.

Everything except the query loop is in interpretProposerResponse, which is pure
and carries the coverage. PROPOSER_MODEL is one exported constant used by both
Options.model and the stored attribution: ב' shipped those as two values and
the database recorded a model the reader never ran on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `proposeForReading` — the composition

**Files:**
- Create: `src/orchestrator/propose.ts`, `src/orchestrator/propose.test.ts`

**Interfaces:**
- Consumes: `loadLatestReading` from `src/documents/reading-store.js`; `capabilityCatalogue` from `./catalogue.js`; `makeProposal`, `PROPOSER_MODEL` from `../sdk/proposer.js`; `PROPOSAL_PROMPT_VERSION`; `saveProposal`; `proposalToPlan`; `loadAuthorization`.
- Produces: `proposeForReading(input, options?): Promise<ProposeResult>` where
  `type ProposeResult = { status: 'proposed'; proposal: Proposal; record: ProposalRecord; plan: Plan | null } | { status: 'unproposable'; reason: string; record: ProposalRecord } | { status: 'no_reading' }`

**Context — the order is the design**, as in `ingestDocument` and `readDocument`:

```
loadLatestReading (with provenance) → no reading? return no_reading
  → capabilityCatalogue(bundle, provenance, { rampLevel })
  → makeProposal
  → saveProposal (both outcomes)
  → proposalToPlan (null when the proposal carries no action)
```

**The `provenance` contract from sub-project ב' comes due here.** `loadLatestReading` requires a `provenance` argument. `proposeForReading` **must derive it from the job row**, never accept it as a free parameter. `CLAUDE.md` records this as an obligation on the first production caller, and this is that caller. Load the job, read its `provenance` column, and pass that.

The model call is injectable (`options.proposer`) so the composition is testable without a key — a stand-in for the one step that costs money, not a mock of the SDK. Every other step runs for real against the real database.

- [ ] **Steps 1–5:** Write `src/orchestrator/propose.test.ts` covering: a reading yields a stored proposal and a compiled plan; `no_action` yields a stored proposal and a `null` plan; an unproposable response is stored, not thrown; a reading that does not exist yields `no_reading` and calls the proposer zero times; and **the provenance used is the job's own, not one the caller supplied** — create a job with `provenance: 'unknown_external'`, and assert the reading lookup used that value.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/orchestrator/propose.ts src/orchestrator/propose.test.ts
git commit -m "proposeForReading: a reading in, a stored proposal and a plan out

Provenance is derived from the job row, never accepted as a parameter. CLAUDE.md
records that obligation on the first production caller of the reading store,
and this is that caller: a free parameter would let a caller ask for a boss-read
of a stranger's document and the cache would honour it precisely.

An unproposable response is stored and returned, not thrown. A reading that does
not exist is no_reading, not a failed proposal.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Invariants, live script, documentation

**Files:**
- Create: `src/orchestrator/proposal-invariants.test.ts`, `src/sdk/run-propose.ts`
- Modify: `package.json`, `CLAUDE.md`, `docs/02-orchestrator.md`, `docs/05-approvals.md`, `docs/09-roadmap.md`

**Interfaces:** Consumes `Stance` and the parse/authorisation modules; reads files from disk with `node:fs` and `fileURLToPath` from `node:url`.

**Context:** The invariants are the `capabilities.test.ts` genre — not behaviour, but blocks against the tables falling out of sync. Use `fileURLToPath(new URL(...))`, never `.pathname`: on Windows the latter yields a leading-slash drive path that `readdirSync` rejects.

- [ ] **Step 1: Write the invariants**

Create `src/orchestrator/proposal-invariants.test.ts` asserting:

1. **Only `authorization.ts` writes `job_authorizations`.** Sweep `src/**/*.ts` (excluding tests) for `INSERT INTO job_authorizations`; exactly one file may match. This is the security core — a second writer is how an instruction gets forged.
2. **No module under `src/documents/` imports the authorisation module.** The reading layer must not be able to grant authority to itself.
3. **`Stance.options` and the prompt agree** — every stance the enum declares appears in the built system prompt.
4. **The sweep found files to sweep** — assert a non-trivial file count before concluding the sweeps are clean. An empty sweep that passes is not a control.

- [ ] **Step 2: Prove the writer sweep bites**

Add `// INSERT INTO job_authorizations` as a comment to any other file under `src/`, confirm invariant 1 fails, and remove it. Redirect both outputs.

- [ ] **Step 3: Write the live script**

Create `src/sdk/run-propose.ts` — under `src/`, not `scripts/`, because `tsconfig.json` includes only `src/**/*.ts` and a script outside it is never typechecked. That was a finding in sub-project ב'; do not repeat it. Add `"sdk:propose": "tsx src/sdk/run-propose.ts"` to `package.json`.

Verify both failure paths without a key: no argument prints usage and exits non-zero; a nonexistent reading id prints the missing-key message and exits non-zero. **Do not claim the live path works** — it has not been run.

- [ ] **Step 4: Update the documentation**

`CLAUDE.md` — the commands block; the test count, read from an actual run and not estimated; and four new rules in the silent-rules section: a proposal's stance constrains its action; a reason cites a finding or the proposal is void; standing authorisation comes only from a boss-stamped job and never covers money; and proposals are not deduplicated, unlike readings, with the reason.

`docs/05-approvals.md` — the approval card now carries the proposal's words, and the risk explanation moved to the risk row rather than being deleted.

`docs/02-orchestrator.md` — §2 describes planning; add that the planner now produces a proposal with a stance, and that a single action compiles to a one-step plan.

`docs/09-roadmap.md` — what ג' closed and, in the same breath, what it did not: the ramp is unchanged, so the two-tier approval is not yet felt; one action per proposal; no cross-document comparison; no entity resolver.

**Verify every factual claim before committing it.** Confirm each file path, function name and constant exists. Three fix waves in this project have shipped documentation citing a test file that did not exist.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/orchestrator/proposal-invariants.test.ts src/sdk/run-propose.ts package.json CLAUDE.md docs/02-orchestrator.md docs/05-approvals.md docs/09-roadmap.md
git commit -m "Lock the authorisation boundary, and the docs this branch made false

Exactly one file may write job_authorizations. A second writer is how an
instruction gets forged, and the sweep asserts it found files to sweep before
concluding they are clean.

The live script lives under src/ so tsconfig actually covers it — ב' shipped
one under scripts/ where npm run typecheck never saw it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 — the approval card's existing fields carry the proposal | 5 |
| §3 — the `Proposal` schema; no `readingSummary` | 1 |
| §4 — four stances and their constraints | 1, 2 |
| §4 — what approval means per stance (button carries the action's headline) | 5 |
| §5 — signing cannot be proposed (tool must be in the catalogue) | 2, 10 |
| §6 — standing authorisation, its provenance source, scope, and money | 4, 5, 10 |
| §7 — the flow; `proposalToPlan` pure | 3, 9 |
| §8 — `proposalProblems`, all six rows | 2 |
| §9 — the failure table | 2, 8, 9 |
| §10 — storage without dedupe; rejections kept | 6 |
| §11 — tests without a key; live run as a script | 1–9, 10 |
| §12 — what remains open | 10 |

**Gap found and closed:** §4's rule that the approval button carries `action.headline` rather than `proposal.headline` had no task. It belongs to Task 5, where `proposalText` is assembled — the composition must pass the *action's* headline for an `advise_against` proposal, not the proposal's. Task 5's Context block and Task 9's assembly both state it.

**Type consistency:** `Proposal`/`ProposedAction`/`Stance` defined in Task 1, consumed in 2, 3, 6, 7, 8, 9. `ParseOutcome` internal to Task 2 and consumed by Task 8. `StandingAuthorization` defined in Task 4 and consumed by Task 5's `GateContext`. `ProposalRecord`/`NewProposal` defined in Task 6, consumed in Task 9. `PROPOSAL_PROMPT_VERSION` in Task 7, read by Tasks 8 and 9. `PROPOSER_MODEL` in Task 8, read by Task 9.

**Ordering note for the executor:** Task 5 modifies `src/policy/engine.ts`, which every gate test depends on. Do not start Task 6 with Task 5's suite red. Task 4 must precede Task 5 — the gate imports the authorisation module.

**Migration numbering:** Task 4 writes **015**, Task 6 writes **016**, matching the order the tasks run in. An earlier draft of this plan had them the other way around and argued the runner tolerates it — which is true (`src/db/migrate.ts` sorts by filename and skips whatever `schema_migrations` already names, so a lower number added later is simply picked up on the next run) but is a defence of an oddity rather than a reason to have one. Neither migration depends on the other: `015` references `jobs` and `016` references `document_readings`, both of which exist. If the executor swaps the task order, swap the numbers with it.
