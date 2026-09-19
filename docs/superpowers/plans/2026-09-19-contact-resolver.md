# פותר אנשי הקשר — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An instruction that names a contact by name — "תשיבי לרונית" — brings back what the assistant knows about them, and when the name fits more than one person the instruction stops and asks before anything happens.

**Architecture:** A deterministic matcher asks, for every known contact, whether any part of their name appears as a whole token in the instruction. One match resolves to every identity key that person has; several matches narrow by company or address, and if that still leaves more than one the instruction returns the existing `needs_answer` outcome with the candidates listed. No model call anywhere in the path.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` on every relative import), Postgres 17 via `pg`, vitest against a real database.

**Spec:** `docs/superpowers/specs/2026-09-19-contact-resolver-design.md` — binding. Where this plan and the spec disagree, the spec wins.

## Global Constraints

- `.js` extension on every relative import, including from `.ts` files.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` are all on.
- Hebrew for anything a human reads; English for identifiers, comments and internal errors.
- **No model call in this feature.** The matching is deterministic (spec §3). If a task seems to need a model, stop and report.
- **The resolver never decides who may be written to** (spec §9). It must not touch `authorisedRecipients`, `typedInInstruction` or anything the gate reads.
- Every control is written as a **positive list**; "everything that is not X" has silently swept in unintended cases three times in this codebase.
- A negative test that would still pass with the code it covers deleted is not a test.
- A comment must describe what the code does, and any precedent it cites must actually say what is claimed — open the file before citing it.
- Tests run against a real Postgres, and the suite must be run **solo and in the foreground**: a concurrent run collides and looks exactly like a mass regression.

---

### Task 1: The contact list

**Files:**
- Create: `src/memory/contacts.ts`
- Test: `src/memory/contacts.test.ts`

**Interfaces:**
- Consumes: the `memories` table directly (`kind = 'entity'`, `retired_at IS NULL`).
- Produces:
  - `export interface Contact { subjectKeys: string[]; name: string; company: string | null; email: string | null }`
  - `export async function listContacts(options?: { businessId?: string; db?: Queryable }): Promise<Contact[]>`

- [ ] **Step 1: Write the failing test**

Create `src/memory/contacts.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob } from '../orchestrator/jobs.js';
import { retireMemories, writeMemory } from './store.js';
import { listContacts } from './contacts.js';

const BUSINESS = 'test-business';

async function bossJob(version: string): Promise<string> {
  const bundle = await installCharter(buildCharter({ version }), { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    title: 'seed',
    businessId: BUSINESS,
  });
  return job.jobId;
}

describe('the contacts the resolver may match against', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('returns a live entity with its name, company and address', async () => {
    await writeMemory(
      {
        jobId: await bossJob('c1'),
        kind: 'entity',
        subjectKey: 'ronit-cohen-beta-log',
        body: { name: 'רונית כהן', company: 'בטא לוגיסטיקה', email: 'ronit@beta-log.example' },
      },
      { businessId: BUSINESS },
    );

    const contacts = await listContacts({ businessId: BUSINESS });

    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.name).toBe('רונית כהן');
    expect(contacts[0]?.company).toBe('בטא לוגיסטיקה');
    // Both keys: the entity id it is stored under, and the address the curator
    // writes under. Spec §8 — the same person is split across the two today.
    expect(contacts[0]?.subjectKeys).toEqual(
      expect.arrayContaining(['ronit-cohen-beta-log', 'ronit@beta-log.example']),
    );
  });

  /**
   * A record with no name cannot be matched by name, so it must not appear —
   * otherwise the resolver would carry candidates it can never select, and an
   * ambiguity count would include people the owner was never shown.
   */
  it('skips an entity with no name', async () => {
    await writeMemory(
      {
        jobId: await bossJob('c2'),
        kind: 'entity',
        subjectKey: 'no-name-entity',
        body: { company: 'חברה בלי איש קשר' },
      },
      { businessId: BUSINESS },
    );

    expect(await listContacts({ businessId: BUSINESS })).toEqual([]);
  });

  it('skips a retired entity', async () => {
    const jobId = await bossJob('c3');
    await writeMemory(
      {
        jobId,
        kind: 'entity',
        subjectKey: 'gone-entity',
        body: { name: 'מישהו שהיה' },
      },
      { businessId: BUSINESS },
    );
    // `kind` is required — self-review caught it missing here.
    await retireMemories(
      { kind: 'entity', subjectKey: 'gone-entity', reason: 'בדיקה' },
      { businessId: BUSINESS },
    );

    expect(await listContacts({ businessId: BUSINESS })).toEqual([]);
  });

  it('does not return another business’s contacts', async () => {
    await writeMemory(
      {
        jobId: await bossJob('c4'),
        kind: 'entity',
        subjectKey: 'ours',
        body: { name: 'שלנו' },
      },
      { businessId: BUSINESS },
    );

    expect(await listContacts({ businessId: 'someone-else' })).toEqual([]);
  });

  /**
   * `recallMemories` caps at MAX_RECALL because it feeds a prompt with a token
   * budget. This read feeds a matcher, and a business with more contacts than
   * that cap would silently stop being recognised past it.
   */
  it('is not capped at the recall ceiling', async () => {
    const jobId = await bossJob('c5');
    for (let i = 0; i < 25; i += 1) {
      await writeMemory(
        { jobId, kind: 'entity', subjectKey: `contact-${i}`, body: { name: `איש ${i}` } },
        { businessId: BUSINESS },
      );
    }

    expect(await listContacts({ businessId: BUSINESS })).toHaveLength(25);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/memory/contacts.test.ts`
Expected: FAIL — `Cannot find module './contacts.js'`.

- [ ] **Step 3: Implement**

Create `src/memory/contacts.ts`:

```ts
/**
 * The contacts a name can be resolved against.
 *
 * A separate read from `recallMemories` on purpose, and the difference is the
 * ceiling: recall is capped at `MAX_RECALL` because it feeds a prompt with a
 * token budget, while this feeds a matcher. Reusing recall here would mean a
 * business quietly stopped recognising its contacts past the cap — the sort of
 * limit that produces "she used to know him" with nothing in any log.
 *
 * Only live entity rows carrying a name take part. A record with no name
 * cannot be matched by name, and including it would let an ambiguity count
 * contain a candidate the owner could never be shown (spec §4).
 */
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';
import { config } from '../config.js';

export interface Contact {
  /**
   * Every key this person's memories are stored under: the entity id, and the
   * address on the record when there is one. Spec §8 — the curator writes
   * under the address it wrote to, while older rows sit under the entity id,
   * so one person is split across both and recall by either returns half.
   */
  subjectKeys: string[];
  name: string;
  company: string | null;
  email: string | null;
}

interface ContactRow {
  subject_key: string;
  body: Record<string, unknown>;
}

function readString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export async function listContacts(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<Contact[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<ContactRow>(
    `SELECT subject_key, body FROM memories
      WHERE business_id = $1 AND kind = 'entity' AND retired_at IS NULL
      ORDER BY created_at DESC`,
    [businessId],
  );

  const contacts: Contact[] = [];
  for (const row of rows) {
    const name = readString(row.body, 'name');
    if (name === null) continue;

    const email = readString(row.body, 'email');
    const keys = [row.subject_key];
    if (email !== null && email.toLowerCase() !== row.subject_key.toLowerCase()) {
      keys.push(email.toLowerCase());
    }

    contacts.push({
      subjectKeys: keys,
      name,
      company: readString(row.body, 'company'),
      email: email === null ? null : email.toLowerCase(),
    });
  }

  return contacts;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/memory/contacts.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/memory/contacts.ts src/memory/contacts.test.ts
git commit -m "The contacts a name can be matched against, uncapped on purpose"
```

---

### Task 2: The matcher

**Files:**
- Create: `src/memory/contact-resolver.ts`
- Modify: `src/governance/typed-recipients.ts` — export `LEADING_HEBREW_PARTICLE`
- Test: `src/memory/contact-resolver.test.ts`

**Interfaces:**
- Consumes: `Contact` from `src/memory/contacts.ts`; `LEADING_HEBREW_PARTICLE` from `src/governance/typed-recipients.ts`.
- Produces:
  - `export interface Ambiguity { token: string; candidates: Contact[] }`
  - `export interface Resolution { subjects: string[]; ambiguities: Ambiguity[] }`
  - `export function resolveContacts(text: string, contacts: readonly Contact[]): Resolution`

- [ ] **Step 1: Export the shared particle**

In `src/governance/typed-recipients.ts`, change `const LEADING_HEBREW_PARTICLE` to `export const LEADING_HEBREW_PARTICLE`, and add to its comment that the contact resolver reads it too — one definition of "a Hebrew particle glued to a word", never two.

- [ ] **Step 2: Write the failing test**

Create `src/memory/contact-resolver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Contact } from './contacts.js';
import { resolveContacts } from './contact-resolver.js';

const RONIT: Contact = {
  subjectKeys: ['ronit-cohen-beta-log', 'ronit@beta-log.example'],
  name: 'רונית כהן',
  company: 'בטא לוגיסטיקה',
  email: 'ronit@beta-log.example',
};

const RONIT_TWO: Contact = {
  subjectKeys: ['ronit-levi-gamma'],
  name: 'רונית לוי',
  company: 'גמא הרמה',
  email: 'ronit@gamma-lift.example',
};

const DANI: Contact = {
  subjectKeys: ['dani-cohen-delta'],
  name: 'דני כהן',
  company: 'דלתא',
  email: 'dani@delta.example',
};

describe('resolving a name to an identity', () => {
  it('resolves a first name to every key that person has', () => {
    const result = resolveContacts('תשיבי לרונית על ההצעה', [RONIT]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toEqual(
      expect.arrayContaining(['ronit-cohen-beta-log', 'ronit@beta-log.example']),
    );
  });

  /**
   * The owner's correction: a surname is a name like any other. One Cohen
   * resolves; several Cohens ask. There is no separate rule.
   */
  it('resolves a surname when it fits exactly one person', () => {
    const result = resolveContacts('תשיבי לכהן', [RONIT]);

    expect(result.subjects).toContain('ronit-cohen-beta-log');
    expect(result.ambiguities).toEqual([]);
  });

  /**
   * Both spellings. Preflight found the shared expression handles only the
   * hyphenated form, so the glued form — the one people actually write — is
   * the case that must be proven.
   */
  it('strips a leading Hebrew particle, glued or hyphenated', () => {
    expect(resolveContacts('תשיבי לרונית', [RONIT]).subjects).toContain('ronit-cohen-beta-log');
    expect(resolveContacts('תשיבי ל-רונית', [RONIT]).subjects).toContain('ronit-cohen-beta-log');
    expect(resolveContacts('מרונית הגיע עדכון', [RONIT]).subjects).toContain(
      'ronit-cohen-beta-log',
    );
  });

  /**
   * THE control. A looser comparison is how the resolver starts naming the
   * wrong person, and this codebase has watched exactly that happen when a
   * match was relaxed elsewhere.
   */
  it('matches a whole token and never a substring', () => {
    expect(resolveContacts('תשיבי לרוניתה', [RONIT]).subjects).toEqual([]);
    expect(resolveContacts('תשיבי לדן', [DANI]).subjects).toEqual([]);
  });

  it('asks when a name fits more than one person', () => {
    const result = resolveContacts('תשיבי לרונית', [RONIT, RONIT_TWO]);

    expect(result.subjects).toEqual([]);
    expect(result.ambiguities).toHaveLength(1);
    expect(result.ambiguities[0]?.token).toBe('רונית');
    expect(result.ambiguities[0]?.candidates).toHaveLength(2);
  });

  it('asks when a surname fits more than one person', () => {
    const result = resolveContacts('תשיבי לכהן', [RONIT, DANI]);

    expect(result.subjects).toEqual([]);
    expect(result.ambiguities).toHaveLength(1);
  });

  /**
   * The answer arrives as more text on the same instruction, so narrowing is
   * the same matcher run again — no second mechanism, no stored state.
   */
  it('narrows to one when the text also names the company', () => {
    const result = resolveContacts('תשיבי לרונית\n\nבטא לוגיסטיקה', [RONIT, RONIT_TWO]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toContain('ronit-cohen-beta-log');
  });

  it('narrows to one when the text also names the address', () => {
    const result = resolveContacts('תשיבי לרונית\n\nronit@gamma-lift.example', [RONIT, RONIT_TWO]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toContain('ronit-levi-gamma');
  });

  /**
   * "We could not narrow it down" must never become "take the first one".
   */
  it('still asks when the answer narrows to nobody', () => {
    const result = resolveContacts('תשיבי לרונית\n\nאני לא זוכר', [RONIT, RONIT_TWO]);

    expect(result.subjects).toEqual([]);
    expect(result.ambiguities).toHaveLength(1);
  });

  it('resolves two different people named in one instruction', () => {
    const result = resolveContacts('תשיבי לרונית ולדני', [RONIT, DANI]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toEqual(
      expect.arrayContaining(['ronit-cohen-beta-log', 'dani-cohen-delta']),
    );
  });

  it('returns nothing for a name nobody carries', () => {
    expect(resolveContacts('תשיבי למוטי', [RONIT, DANI])).toEqual({
      subjects: [],
      ambiguities: [],
    });
  });

  it('returns nothing when there are no contacts at all', () => {
    expect(resolveContacts('תשיבי לרונית', [])).toEqual({ subjects: [], ambiguities: [] });
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run src/memory/contact-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `src/memory/contact-resolver.ts`:

```ts
/**
 * From a name in an instruction to the keys that person's memories sit under.
 *
 * Deterministic, and that is the load-bearing choice rather than a preference
 * (spec §3). Whoever lets a model decide who "רונית" is has let it decide who
 * receives an email, eventually — and this codebase refuses that everywhere
 * else: the forget-command reader carries a fixed verb list, the standing
 * authorisation matches the instruction's own bytes, and `EntityRef` was built
 * with no branch that can carry an address.
 *
 * **This does not decide who may be written to** (spec §9). Finding who was
 * meant and being allowed to contact them are different questions, and merging
 * them is how a convenience becomes a bypass.
 */
import { LEADING_HEBREW_PARTICLE } from '../governance/typed-recipients.js';
import type { Contact } from './contacts.js';

export interface Ambiguity {
  /** The name part that fitted more than one person — what the owner wrote. */
  token: string;
  candidates: Contact[];
}

export interface Resolution {
  /** Keys to recall by. Empty when nothing was recognised. */
  subjects: string[];
  /** Non-empty only when the instruction must stop and ask (spec §6). */
  ambiguities: Ambiguity[];
}

/** The particle letters that glue onto a Hebrew word: ל, ב, מ, ה, ו, כ, ש. */
const GLUED_PARTICLE = /^[לבמהוכש]/u;

/**
 * Split on anything that is not a letter or a digit, so punctuation cannot
 * hide a token, and emit BOTH spellings of a Hebrew word that may carry a
 * prefix particle.
 *
 * The shared `LEADING_HEBREW_PARTICLE` handles the hyphenated form only
 * (`ל-רונית`) — preflight checked it against the glued form and found
 * `לרונית` passes through untouched, which is the way every owner actually
 * writes it. So the raw token is kept AND, when it begins with a particle
 * letter and at least two characters remain, the remainder is added beside it.
 *
 * Adding a candidate token can only ever create a match against a contact
 * whose name part equals it exactly, so the residual risk is narrow: a contact
 * named `רמה` would match the word `הרמה`. That feeds memory scope only and
 * never authorisation (spec §9), so the cost of the rare false match is
 * recalling the wrong person's preferences, not writing to the wrong person.
 */
function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^\p{L}\p{N}@._-]+/u)) {
    const token = raw.replace(LEADING_HEBREW_PARTICLE, '').trim().toLowerCase();
    if (token === '') continue;
    out.add(token);
    if (GLUED_PARTICLE.test(token) && token.length >= 3) out.add(token.slice(1));
  }
  return out;
}

/** Every way this contact's name may be written: the whole name and each part. */
function namePartsOf(contact: Contact): string[] {
  const full = contact.name.trim().toLowerCase();
  const parts = full.split(/\s+/).filter((part) => part !== '');
  return [full, ...parts];
}

/**
 * Does the text carry something that distinguishes this contact from someone
 * who shares a name part — the company, or the address?
 */
function distinguished(contact: Contact, tokens: Set<string>, text: string): boolean {
  if (contact.email !== null && tokens.has(contact.email)) return true;
  if (contact.company === null) return false;
  // A company is often several words, so it is matched against the text rather
  // than against single tokens — "בטא לוגיסטיקה" is never one token.
  return text.toLowerCase().includes(contact.company.trim().toLowerCase());
}

export function resolveContacts(text: string, contacts: readonly Contact[]): Resolution {
  const tokens = tokensOf(text);

  // Group by the name part that matched, so "רונית ודני" resolves both while
  // two people called רונית raise one question about one word.
  const byToken = new Map<string, Contact[]>();
  for (const contact of contacts) {
    for (const part of namePartsOf(contact)) {
      if (!tokens.has(part)) continue;
      const bucket = byToken.get(part) ?? [];
      bucket.push(contact);
      byToken.set(part, bucket);
    }
  }

  const subjects = new Set<string>();
  const ambiguities: Ambiguity[] = [];

  for (const [token, matched] of byToken) {
    const chosen =
      matched.length === 1
        ? matched
        : matched.filter((contact) => distinguished(contact, tokens, text));

    if (chosen.length === 1) {
      for (const key of chosen[0]?.subjectKeys ?? []) subjects.add(key);
      continue;
    }

    // Either nothing narrowed it, or the narrowing left several. Both ask.
    // "We could not narrow it down" is never "take the first one".
    ambiguities.push({ token, candidates: matched });
  }

  return { subjects: [...subjects], ambiguities };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/memory/contact-resolver.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Prove the whole-token control bites**

Change the token test in `tokensOf` from set membership to a substring scan (`[...tokens].some((t) => t.includes(part))`), re-run, and confirm **"matches a whole token and never a substring"** fails. Restore, confirm `git diff` on the file is empty, re-run green.

- [ ] **Step 7: Commit**

```bash
git add src/memory/contact-resolver.ts src/memory/contact-resolver.test.ts src/governance/typed-recipients.ts
git commit -m "From a name to an identity, deterministically"
```

---

### Task 3: Wiring, and the question

**Files:**
- Modify: `src/orchestrator/instruct.ts` — resolve before recall; return `needs_answer` on ambiguity
- Modify: `src/dashboard/server.ts` — the answer route passes `identityAsked: true`
- Test: `src/orchestrator/instruct.test.ts`

**Interfaces:**
- Consumes: `listContacts` (Task 1), `resolveContacts`, `Ambiguity` (Task 2).
- Produces: `RunInstructionOptions` gains `identityAsked?: boolean`.

- [ ] **Step 1: Write the failing test**

Add to `src/orchestrator/instruct.test.ts` — follow the file's existing helpers for seeding a charter and injecting a planner:

```ts
it('stops and asks when a name fits two contacts, and plans nothing', async () => {
  // …seed two entity memories both named רונית, with different companies…
  const outcome = await runInstruction(
    { text: 'תשיבי לרונית' },
    {
      businessId: BUSINESS,
      planner: async () => {
        throw new Error('the planner must not be called when the identity is unresolved');
      },
    },
  );

  expect(outcome.status).toBe('needs_answer');
  if (outcome.status !== 'needs_answer') return;
  expect(outcome.question).toContain('רונית');
  // Both distinguishing details are offered, so the owner can answer in a word.
  expect(outcome.question).toContain('בטא לוגיסטיקה');
  expect(outcome.question).toContain('גמא הרמה');
});

it('resolves a name to memory and hands it to the planner', async () => {
  // …seed one רונית entity plus a preference stored under her address…
  let seen: PlanRequest | undefined;
  await runInstruction(
    { text: 'תשיבי לרונית' },
    {
      businessId: BUSINESS,
      planner: async (request) => {
        seen = request;
        return { status: 'ok', plan: /* the file's existing minimal plan fixture */ } as never;
      },
    },
  );

  expect(seen?.memoryBlock ?? '').toContain('טלפון');
});

it('does not ask a second time once an answer has come back', async () => {
  // …two contacts named רונית, so the identity stays ambiguous…
  const outcome = await runInstruction(
    { text: 'תשיבי לרונית\n\nאני לא זוכר' },
    { businessId: BUSINESS, identityAsked: true, planner: minimalPlanner },
  );

  // Spec §7.2: asked once per chain. It proceeds with no memory instead.
  expect(outcome.status).not.toBe('needs_answer');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/orchestrator/instruct.test.ts`
Expected: FAIL — no question is raised and `identityAsked` is not a valid option.

- [ ] **Step 3: Implement the wiring**

In `src/orchestrator/instruct.ts`, replace the `const subjects = emailAddressesIn(input.text);` line and its comment with:

```ts
  // Two positive sources, never a guess: addresses the owner typed, and
  // contacts whose name appears in the instruction. `emailAddressesIn` is the
  // same extractor the standing-authorisation path uses — resolving a NAME is
  // new, and deliberately feeds memory only (spec §9): it does not widen who
  // may be written to.
  const typed = emailAddressesIn(input.text);
  let resolution: Resolution = { subjects: [], ambiguities: [] };
  try {
    resolution = resolveContacts(input.text, await listContacts({ businessId }));
  } catch {
    // A failed contact read degrades to no memory, never to a failed
    // instruction — the same trade the recall below already makes.
  }

  // Spec §6: more than one person fits the name, so nothing is planned and
  // nothing is sent until the owner says which. Asked once per chain (§7.2):
  // after an answer has come back, an unresolved name proceeds without memory
  // rather than asking again.
  if (resolution.ambiguities.length > 0 && options.identityAsked !== true) {
    const question = renderIdentityQuestion(resolution.ambiguities);
    try {
      await recordQuestion(instruction.instructionId, question, { businessId });
    } catch {
      // Swallowed by design, exactly as the planner's own question is.
    }
    return {
      status: 'needs_answer',
      jobId: job.jobId,
      instructionId: instruction.instructionId,
      question,
      instructionText: instruction.text,
    };
  }

  const subjects = [...typed, ...resolution.subjects];
```

Add the question renderer at the bottom of the file:

```ts
/**
 * The question the owner is asked, carrying what distinguishes the candidates.
 *
 * It offers the distinguishing details rather than asking the owner to guess
 * which detail would help — that is what the owner's decision calls "another
 * identifying detail", and the answer comes back as more text on the same
 * instruction, which the same matcher then narrows on.
 */
function renderIdentityQuestion(ambiguities: readonly Ambiguity[]): string {
  const lines = ambiguities.map((ambiguity) => {
    const options = ambiguity.candidates
      .map((candidate) => {
        const details = [candidate.company, candidate.email].filter(
          (detail): detail is string => detail !== null,
        );
        return details.length === 0
          ? candidate.name
          : `${candidate.name} (${details.join(' · ')})`;
      })
      .join(' · ');
    return `למי התכוונת ב"${ambiguity.token}"? ${options}`;
  });
  return lines.join('\n');
}
```

Add `identityAsked?: boolean` to `RunInstructionOptions` with a comment saying the dashboard's answer route sets it, that it is deliberately coarse — any second pass suppresses the identity question — and that this is what bounds §7.2's loop.

- [ ] **Step 4: Pass the flag from the answer route**

In `src/dashboard/server.ts`, in the handler that re-runs an answered instruction, add `identityAsked: true` to the `runInstruction` options beside `businessId`, with a one-line comment naming spec §7.2.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/orchestrator/instruct.test.ts src/dashboard/server.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the stop bites**

Remove the `if (resolution.ambiguities.length > 0 …)` block, re-run, and confirm **"stops and asks when a name fits two contacts"** fails — the injected planner throws instead. Restore and confirm green.

- [ ] **Step 7: Full suite and commit**

```bash
npm run typecheck && npm test
git add src/orchestrator/instruct.ts src/dashboard/server.ts src/orchestrator/instruct.test.ts
git commit -m "A name in an instruction reaches memory, and ambiguity stops the job"
```

---

### Task 4: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/06-memory.md`
- Modify: `docs/09-roadmap.md`

- [ ] **Step 1: Add the rules to CLAUDE.md**

In "כללים שהקוד אוכף בשקט", before the paragraph beginning `**הערוץ נפתר פעמיים, בכוונה.**`, add paragraphs covering:

- Name resolution is **deterministic and never a model call**, and why that is a safety property rather than a cost one: whoever lets a model decide who "רונית" is has eventually let it decide who receives an email.
- The resolver **does not widen who may be written to** — it feeds memory scope only, and authorisation still requires a typed address or a charter-known domain.
- Matching is **whole-token**, on the full name and on every part of it, with the shared Hebrew-particle expression read rather than duplicated. A surname is a name like any other; one Cohen resolves, several ask.
- Ambiguity **stops the instruction before anything is planned or sent**, and the question carries the distinguishing details.
- The answer needs **no new storage**: the dashboard re-runs the instruction as text plus answer, so the same matcher narrows on more words.
- `listContacts` is **not** `recallMemories`: the recall cap exists for a prompt budget, and reusing it here would silently stop recognising contacts past the cap.
- The loop bound is **coarse on purpose** — any second pass suppresses the identity question.

- [ ] **Step 2: Update the memory doc**

In `docs/06-memory.md`, record that a name in an instruction now reaches L1/L4, that the same person may still be stored under two keys and that the resolver returns both, and that no merging of those rows is performed.

- [ ] **Step 3: Update the roadmap**

Record that the address-only recall scope noted after the curator's live run is now closed for names that appear in the instruction, and that what remains unresolved is a reference by pronoun or description ("תשיבי לה", "לספק של בטא").

- [ ] **Step 4: Update the test count**

Run `npm test` solo in the foreground, read the final count, and update the `npm test` line at the top of `CLAUDE.md`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/06-memory.md docs/09-roadmap.md
git commit -m "Document the contact resolver: what it decides, and what it must not"
```

---

## Self-Review

**Spec coverage.** §1 → Tasks 1-3. §2 decisions 1 and 6 → Task 3; 2 → Task 2's "returns nothing for a name nobody carries" plus Task 3's fall-through; 3 → Task 2's whole module; 4 → Task 2's `namePartsOf` and both surname tests; 5 → Task 1's `subjectKeys`. §3 → Task 4's CLAUDE.md paragraph. §4 → Task 1. §5 → Task 2. §6 → Task 3. §7 and §7.1 → Task 3's question plus Task 2's narrowing tests. §7.2 → Task 3's `identityAsked`. §8 → Task 1's two-key test. §9 → Task 3's comment and Task 4's paragraph. §10 → Task 3's two catches. §11 → the tests throughout. §12 → Task 4's roadmap note.

**Placeholders.** Task 3's test bodies reference the file's existing charter-seeding and planner-injection helpers rather than repeating them, because `instruct.test.ts` already has them and duplicating a fixture is how two fixtures drift apart. Every other step carries its code. Called out here so the reviewer checks it deliberately.

**Type consistency.** `Contact` is defined once in Task 1 and consumed unchanged in Tasks 2 and 3. `Resolution` and `Ambiguity` are defined in Task 2 and consumed in Task 3. `listContacts` and `resolveContacts` keep the same names and signatures everywhere.

**A second defect, caught by the preflight scan before Task 1 was dispatched.** The plan claimed the shared `LEADING_HEBREW_PARTICLE` strips the particle from `לרונית`. It does not — it requires a hyphen or maqaf after the letter, so the glued form every owner actually writes passed through untouched and the central test would have failed. `tokensOf` now emits both spellings, and the reuse of the shared expression stands for the hyphenated form it really does cover.

**One defect the self-review caught in my own text.** Task 1's test called `retireMemories` without its required `kind` field and would not have compiled. Corrected in place.

**Two things I checked rather than assumed.** The answer route really does re-run the instruction as `${instruction.text}\n\n${answer}` — read in `src/dashboard/server.ts`, which is what makes Task 2's narrowing tests meaningful rather than hypothetical. And `LEADING_HEBREW_PARTICLE` really is a private `const` in `typed-recipients.ts:243` covering ל/ב/מ/ה/ו/כ/ש, so Task 2's export is the reuse it claims and not a second copy. `RunInstructionOptions` really does carry an injectable `planner`, which is what lets Task 3's tests assert that the planner is never reached on an unresolved identity.

**One risk named for the executor.** `distinguished` matches a company by substring against the whole text, not by token — a company name is usually several words and cannot be one token. That is a deliberate asymmetry with the whole-token rule for names, and it is safe in the direction it leans: a company substring can only ever *narrow* a set that a name already matched, never introduce a candidate. Task 2's reviewer should confirm that reasoning still holds against the code as written.
