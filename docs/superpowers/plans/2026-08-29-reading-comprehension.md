# Reading Comprehension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `know.reader` stops returning free text and starts returning a validated `Reading` — summary, findings, and closed-vocabulary intents — stored per document and attributable to the model that produced it.

**Architecture:** Artefacts already in the database are rendered into a deterministic brief with no model involved; the brief goes to the SDK as the varying tail of a stable prompt prefix; the raw response is parsed and validated on our side (zod for shape, a citation check against the real artefacts), never through an SDK-enforced tool — `know.reader` is a quarantine agent and must keep zero classified tools. The result is written to a new `document_readings` table keyed so that the same document, same brief, and same prompt version is never paid for twice.

**Tech Stack:** TypeScript (NodeNext ESM), zod, `pg` against real PostgreSQL 17, vitest, `@anthropic-ai/claude-agent-sdk@0.3.234`, `ulid`.

**Spec:** [docs/superpowers/specs/2026-08-29-reading-comprehension-design.md](../specs/2026-08-29-reading-comprehension-design.md)

**Branch:** work continues on `document-intake`. This plan consumes `src/documents/` from sub-project א', which is not merged to `main`.

## Global Constraints

- **`.js` in every relative import**, including from `.ts` files. Required by `NodeNext` + `"type": "module"`.
- **Three tsconfig flags bite:** `noUncheckedIndexedAccess` (indexing an array yields `T | undefined` — use `rows[0]?.x`), `exactOptionalPropertyTypes` (build optional properties with a conditional spread: `x !== undefined ? { x } : {}`), `verbatimModuleSyntax` (`import type` for types, plain `import` for values — never mixed).
- **zod schema and inferred type share one name:** `export const Reading = z.object({...}); export type Reading = z.infer<typeof Reading>;` — the pattern throughout `src/domain/`.
- **DB row convention:** a private `interface XRow` with snake_case fields plus a `toX(row)` function. SQL is snake_case, TypeScript is camelCase.
- **Tests need real Postgres.** No mocks, no in-memory DB. `assistant_test` must exist and `npm run migrate:test` must have run. `resetDatabase()` from `src/test/db.ts` in `beforeEach`, `closePool()` in `afterAll`.
- **Hebrew for humans, English for code.** Rejection reasons, prompts, and docs in Hebrew; identifiers, comments, and internal errors in English.
- **A value that could not be read is never the permissive one.** Every failure branch in this plan resolves to `unreadable` or to a rejected parse — never to an empty-but-valid `Reading`.
- **Brief ceilings, exact values:** 40 table rows per table (excluding the header row), 8,000 characters per text artefact, 24,000 characters for the whole brief.
- **`READING_PROMPT_VERSION` is a hand-raised constant**, never a hash of the prompt text.
- **No new tool is added to any allowlist.** `know.reader` keeps exactly `['doc.fetch', 'memory.recall']`.
- **A negative test must prove the code it covers actually ran.** If a test would pass with the implementation deleted, it is not a test — assert on the positive outcome (`status === 'read'`) alongside the absence.
- **Run `npm run typecheck` and `npm test` before every commit.**

---

### Task 1: The reading domain — schema and intent registry

**Files:**
- Create: `src/domain/reading.ts`
- Create: `src/domain/reading.test.ts`
- Modify: `src/domain/charter.ts:340` — change `const SafeLookupKey` to `export const SafeLookupKey`

**Interfaces:**
- Consumes: `SafeLookupKey` from `src/domain/charter.ts` (after this task exports it).
- Produces: `IntentName`, `INTENT_MEANING`, `SourceRef`, `Finding`, `EntityRef`, `Intent`, `Reading` — all zod schemas with same-named inferred types, from `src/domain/reading.ts`.

**Context:** `SafeLookupKey` is the guard that rejects `__proto__`, `constructor` and `prototype` as lookup keys. It lives in `charter.ts` because a signed charter was the first untrusted source of object keys. A model returning JSON is the second: `JSON.parse` creates `__proto__` as an ordinary key, and assigning to that name creates a prototype instead of a field. Export the existing one; do not write a second guard.

- [ ] **Step 1: Export the existing guard**

In `src/domain/charter.ts`, line 340, change:

```ts
const SafeLookupKey = z.string().refine((value) => !UNSAFE_OBJECT_KEYS.has(value), {
```

to:

```ts
export const SafeLookupKey = z.string().refine((value) => !UNSAFE_OBJECT_KEYS.has(value), {
```

Nothing else in that file changes.

- [ ] **Step 2: Write the failing tests**

Create `src/domain/reading.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { INTENT_MEANING, IntentName, Intent, Reading } from './reading.js';

const SOURCE = { ordinal: 0, locator: null };

function reading(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'חוזה התקשרות עם ספק, תקופת התחייבות שנתיים.',
    findings: [{ label: 'תקופת התחייבות', value: '24 חודשים', sourceRef: SOURCE }],
    intents: [{ intent: 'flag_for_owner', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' }],
    unreadable: [],
    ...overrides,
  };
}

describe('Reading', () => {
  it('accepts a well-formed reading', () => {
    const parsed = Reading.safeParse(reading());
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty intents array, because absence is not a decision', () => {
    const parsed = Reading.safeParse(reading({ intents: [] }));
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown intent name', () => {
    const parsed = Reading.safeParse(
      reading({ intents: [{ intent: 'wire_the_money', subject: { kind: 'sender' }, sourceRef: SOURCE }] }),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects __proto__ as an entityId', () => {
    const parsed = Reading.safeParse(
      reading({
        intents: [
          { intent: 'contact_counterparty', subject: { kind: 'entity', entityId: '__proto__' }, sourceRef: SOURCE },
        ],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it('accepts an unresolved subject, which describes but does not address', () => {
    const parsed = Intent.safeParse({
      intent: 'contact_counterparty',
      subject: { kind: 'unresolved', describedAs: 'רואה החשבון' },
      sourceRef: SOURCE,
    });
    expect(parsed.success).toBe(true);
  });

  it('has no way to express a raw address in a subject', () => {
    // An address arriving as an entityId is stored as an opaque key, never
    // used as a destination — but the discriminated union has no branch that
    // takes a free-text address at all, and that is the property under test.
    const parsed = Intent.safeParse({
      intent: 'contact_counterparty',
      subject: { kind: 'address', email: 'attacker@example.com' },
      sourceRef: SOURCE,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('the intent registry', () => {
  it('explains exactly the intents the enum declares', () => {
    expect(Object.keys(INTENT_MEANING).sort()).toEqual([...IntentName.options].sort());
  });

  it('gives every intent a non-empty Hebrew meaning', () => {
    for (const [name, meaning] of Object.entries(INTENT_MEANING)) {
      expect(meaning.trim(), `${name} has no meaning`).not.toBe('');
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/domain/reading.test.ts`
Expected: FAIL — `Cannot find module './reading.js'`.

- [ ] **Step 4: Write the implementation**

Create `src/domain/reading.ts`:

```ts
import { z } from 'zod';
import { SafeLookupKey } from './charter.js';

/**
 * What a reader may conclude follows from something it read.
 *
 * An intent names an **outcome**, never a tool. `reply_to_sender`, not
 * `mail.send`. A reader that names tools is a reader choosing authority, and
 * `know.reader` is the quarantine agent — zero classified tools, input hostile
 * by construction. Mapping an intent onto steps is the planner's work; it sees
 * the capability catalogue and the charter, and the reader sees a document.
 *
 * The registry is small on purpose. Every name added here widens what a
 * document is able to ask for, and a vocabulary that grows for convenience is
 * a vocabulary that has stopped being closed.
 */
export const IntentName = z.enum([
  'reply_to_sender',
  'contact_counterparty',
  'schedule_meeting',
  'file_document',
  'record_entity',
  'record_preference',
  'pay_or_purchase',
  'flag_for_owner',
  'request_clarification',
  'no_action',
]);
export type IntentName = z.infer<typeof IntentName>;

/**
 * What each intent means, in the language the owner reads.
 *
 * Kept beside the enum and locked to it by a test: an intent added to the enum
 * without an explanation fails the build rather than reaching a prompt as a
 * bare identifier the model has to guess at.
 */
export const INTENT_MEANING: Record<IntentName, string> = {
  reply_to_sender: 'להשיב למי ששלח את זה',
  contact_counterparty: 'לפנות לגורם שנקוב בתוכן',
  schedule_meeting: 'לקבוע מועד',
  file_document: 'לתייק במקום שלו, בלי פעולה נוספת',
  record_entity: 'ישות חדשה הופיעה וכדאי לרשום אותה',
  record_preference: 'נאמרה כאן העדפה שכדאי לזכור',
  pay_or_purchase: 'כסף צריך לזוז',
  flag_for_owner: 'אדם חייב להסתכל על זה',
  request_clarification: 'הקריאה עצמה חסרה — צריך להשלים מידע',
  no_action: 'נקרא, ולא נדרש דבר',
};

/**
 * Where in the document a claim came from.
 *
 * `ordinal` addresses one of the document's own artefacts and is checked
 * against the artefacts that were actually rendered into the brief — see
 * `readingProblems`. A claim attributed to a part that does not exist is not a
 * report about the document.
 */
export const SourceRef = z.object({
  ordinal: z.number().int().nonnegative(),
  /** Where inside it, in the reader's words: "שורה 14", "סעיף 3". Advisory. */
  locator: z.string().nullable().default(null),
});
export type SourceRef = z.infer<typeof SourceRef>;

/**
 * One data point the reader drew out of the document.
 *
 * `value` is a string, deliberately, even when it reads as money or a date.
 * A typed `amountMinor` here would be a number a model invented that looks
 * exactly like a number the system measured — and no module under
 * `src/policy/` may read a finding at all. `reading-invariants.test.ts`
 * enforces that; this comment records why.
 */
export const Finding = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  sourceRef: SourceRef,
});
export type Finding = z.infer<typeof Finding>;

/**
 * Who an intent concerns.
 *
 * The three branches are the whole design: a counterparty already known to the
 * business, the job's own sender (resolved by the orchestrator from the job
 * record, never from the content), or an unresolved description. There is no
 * branch that carries an address, so a document can say that someone should be
 * contacted and can never say where the message goes.
 */
export const EntityRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entity'), entityId: SafeLookupKey.min(1) }),
  z.object({ kind: z.literal('sender') }),
  z.object({ kind: z.literal('unresolved'), describedAs: z.string().min(1) }),
]);
export type EntityRef = z.infer<typeof EntityRef>;

export const Intent = z.object({
  intent: IntentName,
  subject: EntityRef,
  sourceRef: SourceRef,
  note: z.string().default(''),
});
export type Intent = z.infer<typeof Intent>;

/**
 * The only shape a reading may take.
 *
 * `intents` is `.min(1)` and the registry carries `no_action`: an empty array
 * and "I read it and nothing follows" are different claims, and this codebase
 * separates them everywhere else — a missing `job_step_results` row is not
 * "nothing happened", an unreadable amount is not zero.
 */
export const Reading = z.object({
  summary: z.string().min(1),
  findings: z.array(Finding).default([]),
  intents: z.array(Intent).min(1),
  /** What the reader could not determine. An empty list is a claim, not an absence. */
  unreadable: z.array(z.string()).default([]),
});
export type Reading = z.infer<typeof Reading>;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/domain/reading.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: both clean. The `charter.ts` change is additive (`const` → `export const`) and breaks nothing.

- [ ] **Step 7: Commit**

```bash
git add src/domain/reading.ts src/domain/reading.test.ts src/domain/charter.ts
git commit -m "A closed intent registry, and the shape a reading must take

An intent names an outcome and never a tool: reply_to_sender, not mail.send.
know.reader is the quarantine agent and must not choose authority; mapping
intents onto steps is the planner's job.

EntityRef has no branch that carries an address. A document can say someone
should be contacted; it cannot say where the message goes.

SafeLookupKey is exported rather than reimplemented — two guards for one rule
are two guards that will diverge.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The deterministic brief

**Files:**
- Create: `src/documents/brief.ts`
- Create: `src/documents/brief.test.ts`

**Interfaces:**
- Consumes: `DocumentArtifact`, `TableContent`, `TextContent`, `OutlineContent`, `Cell`, `Block` from `src/documents/types.js`.
- Produces: `renderReadingBrief(artifacts: readonly DocumentArtifact[]): string`, and the exported constants `BRIEF_TABLE_ROWS = 40`, `BRIEF_TEXT_CHARS = 8000`, `BRIEF_TOTAL_CHARS = 24000`.

**Context:** Pure and synchronous — no filesystem, no network, no database, no `async`. The same property that makes `buildOutline` (`src/documents/outline.ts`) testable on a machine with no API key. This is where the largest share of this sub-project's test coverage lives.

The ceilings are far below intake's own (50,000 rows per sheet): intake's protect the machine, these protect cost and the model's attention. Truncation is **graded** — table rows first, then text, then the whole brief — so the outline, the cheapest and most certain part, is never the first thing dropped.

- [ ] **Step 1: Write the failing tests**

Create `src/documents/brief.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BRIEF_TABLE_ROWS, BRIEF_TEXT_CHARS, renderReadingBrief } from './brief.js';
import type { Cell, DocumentArtifact } from './types.js';

function s(v: string): Cell { return { v, t: 'string' }; }
function n(v: number): Cell { return { v, t: 'number' }; }

function tableArtifact(rowCount: number, ordinal = 1): DocumentArtifact {
  const rows: Cell[][] = [[s('פריט'), s('מחיר')]];
  for (let i = 0; i < rowCount; i += 1) rows.push([s(`שורה ${i}`), n(i * 10)]);
  return { ordinal, kind: 'table', partName: 'מחירון', content: { rows }, flags: [] };
}

const OUTLINE: DocumentArtifact = {
  ordinal: 0,
  kind: 'outline',
  partName: null,
  content: {
    parts: [{ name: 'מחירון', kind: 'table', rowCount: 3, headers: ['פריט', 'מחיר'] }],
    flags: ['has_macros'],
  },
  flags: [],
};

const TEXT: DocumentArtifact = {
  ordinal: 1,
  kind: 'text',
  partName: 'תנאי תשלום',
  content: {
    blocks: [
      { kind: 'heading', level: 1, text: 'תנאי תשלום' },
      { kind: 'paragraph', text: 'שוטף פלוס שלושים.' },
      { kind: 'list', items: ['מע"מ בנפרד', 'הובלה כלולה'] },
    ],
  },
  flags: ['tracked_changes'],
};

describe('renderReadingBrief', () => {
  it('leads with the outline, so the cheapest certain facts come first', () => {
    const brief = renderReadingBrief([OUTLINE, TEXT]);
    expect(brief.indexOf('מחירון')).toBeLessThan(brief.indexOf('שוטף פלוס שלושים'));
  });

  it('labels every part with the ordinal a citation must use', () => {
    const brief = renderReadingBrief([OUTLINE, TEXT]);
    expect(brief).toContain('[חלק 0]');
    expect(brief).toContain('[חלק 1]');
  });

  it('carries the document-level and part-level flags through', () => {
    const brief = renderReadingBrief([OUTLINE, TEXT]);
    expect(brief).toContain('has_macros');
    expect(brief).toContain('tracked_changes');
  });

  it('renders text blocks with their structure intact', () => {
    const brief = renderReadingBrief([TEXT]);
    expect(brief).toContain('שוטף פלוס שלושים.');
    expect(brief).toContain('מע"מ בנפרד');
  });

  it('caps a long table and says out loud that it did', () => {
    const brief = renderReadingBrief([tableArtifact(500)]);
    expect(brief).toContain('שורה 0');
    expect(brief).not.toContain('שורה 400');
    expect(brief).toContain('קוצץ');
    expect(brief).toContain(String(BRIEF_TABLE_ROWS));
  });

  it('keeps the header row on a capped table, over and above the row cap', () => {
    const brief = renderReadingBrief([tableArtifact(500)]);
    expect(brief).toContain('פריט');
    expect(brief).toContain('מחיר');
  });

  it('caps a long text artefact and marks it', () => {
    const long = 'א'.repeat(BRIEF_TEXT_CHARS + 500);
    const artifact: DocumentArtifact = {
      ordinal: 0, kind: 'text', partName: null,
      content: { blocks: [{ kind: 'paragraph', text: long }] }, flags: [],
    };
    const brief = renderReadingBrief([artifact]);
    expect(brief).toContain('קוצץ');
    expect(brief.length).toBeLessThan(long.length);
  });

  it('drops table rows before it drops the outline', () => {
    // Ten fat tables together exceed the total cap; the outline must survive.
    const fat = Array.from({ length: 10 }, (_, i) => tableArtifact(500, i + 1));
    const brief = renderReadingBrief([OUTLINE, ...fat]);
    expect(brief).toContain('מחירון');
    expect(brief).toContain('has_macros');
  });

  it('is deterministic — the same artefacts render byte-identically', () => {
    expect(renderReadingBrief([OUTLINE, TEXT])).toBe(renderReadingBrief([OUTLINE, TEXT]));
  });

  it('produces a brief for an empty artefact list rather than an empty string', () => {
    // An empty document is a fact to state, not a prompt with nothing in it.
    expect(renderReadingBrief([]).trim()).not.toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/documents/brief.test.ts`
Expected: FAIL — `Cannot find module './brief.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/documents/brief.ts`:

```ts
/**
 * `renderReadingBrief` — the artefacts of one document, rendered into the text
 * the reader is asked about (spec §5).
 *
 * Pure and synchronous: no filesystem, no network, no database, nothing async.
 * The same property that holds `buildOutline` (`./outline.ts`), and for the
 * same reason — it is fully testable on a machine with no API key, which is
 * where the bulk of this sub-project's coverage has to live.
 *
 * The ceilings here are far below intake's own (50,000 rows per sheet, §5.3 of
 * the intake spec). Those protect the machine; these protect cost and the
 * model's attention. Truncation is graded — table rows first, then text, then
 * the brief as a whole — so the outline, the cheapest and most certain part of
 * the document, is never the first thing to go.
 */

import type {
  Block,
  Cell,
  DocumentArtifact,
  OutlineContent,
  TableContent,
  TextContent,
} from './types.js';

/** Data rows shown per table, over and above the header row. */
export const BRIEF_TABLE_ROWS = 40;
/** Characters shown per text artefact. */
export const BRIEF_TEXT_CHARS = 8_000;
/** Characters in the whole brief. */
export const BRIEF_TOTAL_CHARS = 24_000;

const TRUNCATED = (what: string, kept: number): string =>
  `\n(קוצץ — מוצגים ${kept} ${what} בלבד; במסמך יש יותר)`;

function cellText(cell: Cell): string {
  if (cell.v === null) return '';
  return String(cell.v);
}

function renderTable(content: TableContent): string {
  const rows = content.rows;
  const header = rows[0];
  if (header === undefined) return '(טבלה ריקה)';

  const body = rows.slice(1);
  const shown = body.slice(0, BRIEF_TABLE_ROWS);
  const lines = [header.map(cellText).join(' | '), '---'];
  for (const row of shown) lines.push(row.map(cellText).join(' | '));

  const text = lines.join('\n');
  return body.length > shown.length ? text + TRUNCATED('שורות', shown.length) : text;
}

function renderBlock(block: Block): string {
  if (block.kind === 'heading') return `${'#'.repeat(Math.max(1, block.level))} ${block.text}`;
  if (block.kind === 'list') return block.items.map((item) => `- ${item}`).join('\n');
  return block.text;
}

function renderText(content: TextContent): string {
  const text = content.blocks.map(renderBlock).join('\n\n');
  if (text.length <= BRIEF_TEXT_CHARS) return text;
  return text.slice(0, BRIEF_TEXT_CHARS) + TRUNCATED('תווים', BRIEF_TEXT_CHARS);
}

function renderOutline(content: OutlineContent): string {
  const lines: string[] = [];
  for (const part of content.parts) {
    const bits = [`- ${part.name ?? '(ללא שם)'} — ${part.kind}`];
    if (part.rowCount !== undefined) bits.push(`${part.rowCount} שורות`);
    if (part.headers !== undefined && part.headers.length > 0) {
      bits.push(`עמודות: ${part.headers.join(', ')}`);
    }
    if (part.dateRange !== undefined) bits.push(`תאריכים: ${part.dateRange.from}–${part.dateRange.to}`);
    lines.push(bits.join(' · '));
  }
  if (content.flags.length > 0) lines.push(`דגלים: ${content.flags.join(', ')}`);
  return lines.length > 0 ? lines.join('\n') : '(אין מתאר)';
}

/**
 * `content` is `unknown` at the storage boundary (`./types.ts`), so each shape
 * is narrowed here rather than trusted. A shape that does not match its
 * declared `kind` renders as a stated gap — silence would read as "this part
 * was empty", which is a different and untrue claim.
 */
function renderContent(artifact: DocumentArtifact): string {
  const content = artifact.content;
  if (artifact.kind === 'outline') {
    const parts = (content as OutlineContent | null)?.parts;
    return Array.isArray(parts) ? renderOutline(content as OutlineContent) : '(מתאר לא קריא)';
  }
  if (artifact.kind === 'table') {
    const rows = (content as TableContent | null)?.rows;
    return Array.isArray(rows) ? renderTable(content as TableContent) : '(טבלה לא קריאה)';
  }
  const blocks = (content as TextContent | null)?.blocks;
  return Array.isArray(blocks) ? renderText(content as TextContent) : '(טקסט לא קריא)';
}

/**
 * The brief, with the outline first and every part labelled by the ordinal a
 * `SourceRef` must cite.
 *
 * Artefacts are ordered outline-first and then by ordinal, not by the order
 * the caller happened to pass them: `loadArtifacts` already returns them by
 * ordinal, and a brief whose ordering depends on the caller is a brief whose
 * hash — and therefore whose cache key — depends on it too.
 */
export function renderReadingBrief(artifacts: readonly DocumentArtifact[]): string {
  if (artifacts.length === 0) return 'המסמך נקלט ולא הופק ממנו שום חלק.';

  const ordered = [...artifacts].sort((a, b) => {
    if (a.kind === 'outline' && b.kind !== 'outline') return -1;
    if (b.kind === 'outline' && a.kind !== 'outline') return 1;
    return a.ordinal - b.ordinal;
  });

  const sections: string[] = [];
  for (const artifact of ordered) {
    const head = `[חלק ${artifact.ordinal}] ${artifact.partName ?? '(ללא שם)'} — ${artifact.kind}`;
    const flags = artifact.flags.length > 0 ? `\nדגלים: ${artifact.flags.join(', ')}` : '';
    sections.push(`${head}${flags}\n${renderContent(artifact)}`);
  }

  const brief = sections.join('\n\n');
  if (brief.length <= BRIEF_TOTAL_CHARS) return brief;
  return brief.slice(0, BRIEF_TOTAL_CHARS) + TRUNCATED('תווים', BRIEF_TOTAL_CHARS);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/documents/brief.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npx vitest run src/documents/brief.test.ts
git add src/documents/brief.ts src/documents/brief.test.ts
git commit -m "The reading brief, built without a model

Pure and synchronous, like buildOutline and for the same reason: it is fully
testable on a machine with no API key.

Truncation is graded — table rows, then text, then the whole brief — so the
outline is never the first thing dropped. Every cut says so in the brief
itself; a reader that does not know material was withheld will summarise half
a document with full confidence.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Parsing and validating what the model returned

**Files:**
- Create: `src/documents/reading-parse.ts`
- Create: `src/documents/reading-parse.test.ts`

**Interfaces:**
- Consumes: `Reading` from `src/domain/reading.js`; `DocumentArtifact` from `./types.js`.
- Produces: `parseReading(raw: string, artifacts: readonly DocumentArtifact[]): ParseOutcome`, `readingProblems(reading: Reading, artifacts: readonly DocumentArtifact[]): ReadingProblem[]`, and the types `ParseOutcome` and `ReadingProblem`.

**Context:** This mirrors `parsePlan` in `src/sdk/planner.ts` exactly, including the balanced-brace scanner that finds every JSON object in a response that may be wrapped in prose or a fenced block. Copy the scanner's behaviour, but **do not import it** — it is a private function in `planner.ts` and reaching into another module's internals to share thirty lines couples the planner's response handling to the reader's. Write the scanner here; the two are allowed to diverge because they answer to different prompts.

`readingProblems` is the `planProblems` analogue: the shape checks zod cannot do. Here that is citation integrity — every `sourceRef.ordinal` must address an artefact that was actually rendered.

- [ ] **Step 1: Write the failing tests**

Create `src/documents/reading-parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseReading, readingProblems } from './reading-parse.js';
import type { DocumentArtifact } from './types.js';

const ARTIFACTS: DocumentArtifact[] = [
  { ordinal: 0, kind: 'outline', partName: null, content: { parts: [], flags: [] }, flags: [] },
  { ordinal: 1, kind: 'text', partName: 'גוף', content: { blocks: [] }, flags: [] },
];

const VALID = {
  summary: 'הצעת מחיר מספק חדש.',
  findings: [{ label: 'סכום', value: '4,500 ש"ח', sourceRef: { ordinal: 1, locator: 'שורה 3' } }],
  intents: [{ intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 1, locator: null } }],
  unreadable: [],
};

describe('parseReading', () => {
  it('parses a bare JSON object', () => {
    const outcome = parseReading(JSON.stringify(VALID), ARTIFACTS);
    expect(outcome.status).toBe('read');
    if (outcome.status !== 'read') throw new Error('expected a reading');
    expect(outcome.reading.summary).toBe('הצעת מחיר מספק חדש.');
  });

  it('parses a response wrapped in prose and a fenced block', () => {
    const raw = `הנה הקריאה:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\nזהו.`;
    expect(parseReading(raw, ARTIFACTS).status).toBe('read');
  });

  it('skips an illustrative object and finds the real one', () => {
    const raw = `לדוגמה: {"summary": "x"}\nוהתשובה: ${JSON.stringify(VALID)}`;
    const outcome = parseReading(raw, ARTIFACTS);
    expect(outcome.status).toBe('read');
  });

  it('reports unreadable when there is no JSON at all', () => {
    const outcome = parseReading('לא הצלחתי לקרוא את המסמך.', ARTIFACTS);
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
    expect(outcome.reason).toContain('JSON');
  });

  it('reports unreadable when the shape does not match', () => {
    const outcome = parseReading(JSON.stringify({ summary: 'x', intents: [] }), ARTIFACTS);
    expect(outcome.status).toBe('unreadable');
  });

  it('rejects a citation to a part that does not exist', () => {
    const fabricated = {
      ...VALID,
      findings: [{ label: 'סכום', value: '4,500', sourceRef: { ordinal: 99, locator: null } }],
    };
    const outcome = parseReading(JSON.stringify(fabricated), ARTIFACTS);
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
    expect(outcome.reason).toContain('99');
  });

  it('rejects a fabricated citation on an intent, not only on a finding', () => {
    const fabricated = {
      ...VALID,
      intents: [{ intent: 'file_document', subject: { kind: 'sender' }, sourceRef: { ordinal: 7, locator: null } }],
    };
    expect(parseReading(JSON.stringify(fabricated), ARTIFACTS).status).toBe('unreadable');
  });

  it('rejects __proto__ arriving as an entityId through JSON.parse', () => {
    const hostile = {
      ...VALID,
      intents: [
        {
          intent: 'contact_counterparty',
          subject: { kind: 'entity', entityId: '__proto__' },
          sourceRef: { ordinal: 1, locator: null },
        },
      ],
    };
    expect(parseReading(JSON.stringify(hostile), ARTIFACTS).status).toBe('unreadable');
  });
});

describe('readingProblems', () => {
  it('finds nothing wrong with citations that resolve', () => {
    const outcome = parseReading(JSON.stringify(VALID), ARTIFACTS);
    if (outcome.status !== 'read') throw new Error('expected a reading');
    expect(readingProblems(outcome.reading, ARTIFACTS)).toEqual([]);
  });

  it('names the bad ordinal and where it appeared', () => {
    const outcome = parseReading(JSON.stringify(VALID), ARTIFACTS);
    if (outcome.status !== 'read') throw new Error('expected a reading');
    const problems = readingProblems(outcome.reading, [ARTIFACTS[0]!]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'unknown_source', ordinal: 1, where: 'finding' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/documents/reading-parse.test.ts`
Expected: FAIL — `Cannot find module './reading-parse.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/documents/reading-parse.ts`:

```ts
/**
 * Turning what the model said into a `Reading`, or into a stated reason why it
 * is not one (spec §3, §7).
 *
 * The shape of this module mirrors `parsePlan` (`src/sdk/planner.ts`): a
 * balanced-brace scan that tolerates prose and fenced blocks, zod for the
 * shape, and a separate structural pass for what a schema cannot express. The
 * scanner is written here rather than imported — it is private to `planner.ts`,
 * and the two callers answer to different prompts and are allowed to diverge.
 *
 * Nothing here throws on bad model output. A response that is not a reading is
 * a result to record, exactly as `ingestDocument` records a rejected document
 * instead of throwing at its caller.
 */

import { Reading } from '../domain/reading.js';
import type { DocumentArtifact } from './types.js';

export type ParseOutcome =
  | { status: 'read'; reading: Reading }
  | { status: 'unreadable'; reason: string };

export type ReadingProblem = {
  kind: 'unknown_source';
  ordinal: number;
  /** Which list the bad citation appeared in, so the reason names a place. */
  where: 'finding' | 'intent';
};

/**
 * Citation integrity: the check zod cannot do, because it needs the artefacts.
 *
 * A reading that attributes a claim to a part of the document that does not
 * exist is not a report about that document. This is the same class of control
 * as `planProblems` — the schema says the field is a number, and this says the
 * number addresses something real.
 */
export function readingProblems(
  reading: Reading,
  artifacts: readonly DocumentArtifact[],
): ReadingProblem[] {
  const known = new Set(artifacts.map((artifact) => artifact.ordinal));
  const problems: ReadingProblem[] = [];

  for (const finding of reading.findings) {
    if (!known.has(finding.sourceRef.ordinal)) {
      problems.push({ kind: 'unknown_source', ordinal: finding.sourceRef.ordinal, where: 'finding' });
    }
  }
  for (const intent of reading.intents) {
    if (!known.has(intent.sourceRef.ordinal)) {
      problems.push({ kind: 'unknown_source', ordinal: intent.sourceRef.ordinal, where: 'intent' });
    }
  }
  return problems;
}

export function parseReading(
  raw: string,
  artifacts: readonly DocumentArtifact[],
): ParseOutcome {
  const candidates = extractJsonObjects(raw);
  if (candidates.length === 0) {
    return { status: 'unreadable', reason: 'no JSON object in the response' };
  }

  // Every candidate is tried. A response that opens with an illustrative
  // object and then gives the real reading would otherwise be judged on the
  // example — the same reasoning as `parsePlan`.
  let reason = 'schema mismatch';
  for (const candidate of candidates) {
    const parsed = Reading.safeParse(candidate);
    if (!parsed.success) {
      reason = parsed.error.issues[0]?.message ?? reason;
      continue;
    }

    const problems = readingProblems(parsed.data, artifacts);
    if (problems.length > 0) {
      // A well-formed reading with a fabricated citation is a real answer to
      // report, not something to keep looking past.
      const first = problems[0];
      return {
        status: 'unreadable',
        reason: `citation to a part that does not exist: ordinal ${first?.ordinal} in a ${first?.where}`,
      };
    }

    return { status: 'read', reading: parsed.data };
  }

  return { status: 'unreadable', reason };
}

/**
 * Every balanced JSON object in a response that may be wrapped in prose or a
 * fenced block.
 *
 * Balanced scanning rather than first `{` to last `}`: across two objects that
 * span is not valid JSON at all.
 */
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
            // Not valid on its own; the next opening brace may still be.
          }
          break;
        }
      }
    }
  }
  return found;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/documents/reading-parse.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npx vitest run src/documents/reading-parse.test.ts
git add src/documents/reading-parse.ts src/documents/reading-parse.test.ts
git commit -m "Parse a reading, and refuse one that cites a part that does not exist

zod checks the shape; readingProblems checks what a schema cannot — that
every sourceRef addresses an artefact that was actually rendered into the
brief. A claim attributed to a section the document does not have is not a
report about that document.

Nothing here throws. A response that is not a reading is a result to record,
the way ingestDocument records a rejected document.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Storage — migration and the reading store

**Files:**
- Create: `src/db/migrations/013_document_readings.sql`
- Create: `src/documents/reading-store.ts`
- Create: `src/documents/reading-store.test.ts`

**Interfaces:**
- Consumes: `getPool`, `withTransaction`, `type Queryable` from `src/db/pool.js`; `config` from `src/config.js`; `Reading` from `src/domain/reading.js`; `TrustLevel` from `src/domain/trust.js`.
- Produces: from `src/documents/reading-store.ts` —
  - `interface ReadingRecord { readingId; businessId; documentId; status: 'read' | 'unreadable'; reason: string | null; content: Reading | null; provenance: TrustLevel; model: string; promptVersion: string; briefHash: string }`
  - `interface NewReading { readingId; documentId; status; reason; content; provenance; model; promptVersion; briefHash }`
  - `saveReading(input: NewReading, options?: { businessId?: string; db?: Queryable }): Promise<{ record: ReadingRecord; created: boolean }>`
  - `findReadingForBrief(documentId: string, briefHash: string, promptVersion: string, options?): Promise<ReadingRecord | null>`
  - `loadLatestReading(documentId: string, options?): Promise<ReadingRecord | null>`

**Context:** A reading is a model's claim **about** a document, not something extracted from it — so it gets its own table, never a fourth `kind` in `document_artifacts`. In one table a later reader could not tell what the file said from what a model said about it, and §7 of the spec is built on exactly that distinction.

`saveReading` follows `insertOrGetDocument` (`src/documents/store.ts:119`): a single `INSERT ... ON CONFLICT DO NOTHING RETURNING *`, then a `SELECT` when the insert lost. Read-then-write would let two concurrent readers of the same document both insert and one blow up on the unique index.

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/013_document_readings.sql`:

```sql
-- What a model concluded about a document
-- (docs/superpowers/specs/2026-08-29-reading-comprehension-design.md §8).
--
-- A separate table and not a fourth `kind` in `document_artifacts`. An
-- artefact is what was extracted from the file deterministically; a reading is
-- a model's *claim about* it. In one table a later reader could not tell the
-- two apart, and that distinction is what every control in §7 rests on.
--
-- `status = 'unreadable'` is stored, not discarded. "We tried to understand it
-- and could not" is a fact about the record; no row at all says "we never
-- tried", which is a different claim. The same rule the orchestrator already
-- holds for an `unknown` step result.
CREATE TABLE document_readings (
    reading_id      TEXT        PRIMARY KEY,
    business_id     TEXT        NOT NULL,
    document_id     TEXT        NOT NULL REFERENCES documents (document_id) ON DELETE CASCADE,
    status          TEXT        NOT NULL,
    -- Human-readable reason for an `unreadable` status. Null otherwise.
    reason          TEXT,
    -- The `Reading` itself. Null exactly when the status is `unreadable`.
    content         JSONB,
    -- Trust of the source this reading was made from. A reading of an
    -- `unknown_external` document stays `unknown_external` however fluent the
    -- summary reads; nothing here may raise a trust level.
    provenance      TEXT        NOT NULL,
    model           TEXT        NOT NULL,
    -- A hand-raised constant, not a hash of the prompt: a hash would change
    -- on a comma and invalidate every cached reading while the question asked
    -- stayed identical.
    prompt_version  TEXT        NOT NULL,
    -- sha256 of the brief, which is what was actually read. Not the document's
    -- own sha256: changing a truncation ceiling changes the brief without
    -- changing the document, and two readings made from different text are not
    -- the same reading.
    brief_hash      TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT document_readings_status_known
        CHECK (status IN ('read', 'unreadable')),
    -- Content is present exactly when the reading succeeded. Enforced here
    -- rather than trusted: a `read` row with no content would be a success
    -- record with nothing in it.
    CONSTRAINT document_readings_content_present
        CHECK ((status = 'read') = (content IS NOT NULL))
);

-- Same document, same brief, same prompt version — one reading. Two readings
-- cost money twice and may return two different answers to one question.
CREATE UNIQUE INDEX document_readings_dedupe_idx
    ON document_readings (business_id, document_id, brief_hash, prompt_version);

-- The lookup behind `loadLatestReading`.
CREATE INDEX document_readings_recent_idx
    ON document_readings (business_id, document_id, created_at DESC);
```

- [ ] **Step 2: Run the migration against the test database**

Run: `npm run migrate:test`
Expected: reports migration 013 applied.

- [ ] **Step 3: Write the failing tests**

Create `src/documents/reading-store.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import type { Reading } from '../domain/reading.js';
import { insertOrGetDocument } from './store.js';
import {
  findReadingForBrief,
  loadLatestReading,
  saveReading,
  type NewReading,
} from './reading-store.js';

const BUSINESS = 'test-business';
const OTHER_BUSINESS = 'other-business';

const READING: Reading = {
  summary: 'הצעת מחיר.',
  findings: [],
  intents: [{ intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null }, note: '' }],
  unreadable: [],
};

async function aDocument(businessId = BUSINESS): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument(
    {
      documentId,
      source: 'manual',
      originalName: 'הצעה.xlsx',
      mediaType: 'text/plain',
      sha256: ulid().padEnd(64, '0'),
      byteSize: 10,
      storedPath: `${businessId}/${documentId}/original.txt`,
    },
    { businessId },
  );
  return documentId;
}

function newReading(documentId: string, overrides: Partial<NewReading> = {}): NewReading {
  return {
    readingId: `RDG-${ulid()}`,
    documentId,
    status: 'read',
    reason: null,
    content: READING,
    provenance: 'unknown_external',
    model: 'haiku',
    promptVersion: 'v1',
    briefHash: 'a'.repeat(64),
    ...overrides,
  };
}

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

describe('saveReading', () => {
  it('stores a successful reading and hands it back', async () => {
    const documentId = await aDocument();
    const { record, created } = await saveReading(newReading(documentId), { businessId: BUSINESS });
    expect(created).toBe(true);
    expect(record.status).toBe('read');
    expect(record.content?.summary).toBe('הצעת מחיר.');
    expect(record.provenance).toBe('unknown_external');
  });

  it('stores an unreadable outcome, because a failed attempt is a fact', async () => {
    const documentId = await aDocument();
    const { record } = await saveReading(
      newReading(documentId, { status: 'unreadable', reason: 'no JSON object in the response', content: null }),
      { businessId: BUSINESS },
    );
    expect(record.status).toBe('unreadable');
    expect(record.reason).toBe('no JSON object in the response');
    expect(record.content).toBeNull();
  });

  it('returns the existing row instead of a second one for the same brief', async () => {
    const documentId = await aDocument();
    const first = await saveReading(newReading(documentId), { businessId: BUSINESS });
    const second = await saveReading(newReading(documentId), { businessId: BUSINESS });
    expect(second.created).toBe(false);
    expect(second.record.readingId).toBe(first.record.readingId);
  });

  it('treats a different prompt version as a different question', async () => {
    const documentId = await aDocument();
    await saveReading(newReading(documentId), { businessId: BUSINESS });
    const second = await saveReading(newReading(documentId, { promptVersion: 'v2' }), { businessId: BUSINESS });
    expect(second.created).toBe(true);
  });

  it('treats a different brief as a different reading', async () => {
    const documentId = await aDocument();
    await saveReading(newReading(documentId), { businessId: BUSINESS });
    const second = await saveReading(newReading(documentId, { briefHash: 'b'.repeat(64) }), { businessId: BUSINESS });
    expect(second.created).toBe(true);
  });

  it('refuses a read row with no content', async () => {
    const documentId = await aDocument();
    await expect(
      saveReading(newReading(documentId, { content: null }), { businessId: BUSINESS }),
    ).rejects.toThrow();
  });
});

describe('findReadingForBrief', () => {
  it('finds the reading made from this exact brief', async () => {
    const documentId = await aDocument();
    const { record } = await saveReading(newReading(documentId), { businessId: BUSINESS });
    const found = await findReadingForBrief(documentId, 'a'.repeat(64), 'v1', { businessId: BUSINESS });
    expect(found?.readingId).toBe(record.readingId);
  });

  it('returns null for a brief nobody has read', async () => {
    const documentId = await aDocument();
    expect(await findReadingForBrief(documentId, 'c'.repeat(64), 'v1', { businessId: BUSINESS })).toBeNull();
  });

  it('does not cross the business boundary', async () => {
    const documentId = await aDocument();
    await saveReading(newReading(documentId), { businessId: BUSINESS });
    const found = await findReadingForBrief(documentId, 'a'.repeat(64), 'v1', { businessId: OTHER_BUSINESS });
    expect(found).toBeNull();
  });
});

describe('loadLatestReading', () => {
  it('returns the most recent reading of a document', async () => {
    const documentId = await aDocument();
    await saveReading(newReading(documentId), { businessId: BUSINESS });
    const second = await saveReading(newReading(documentId, { promptVersion: 'v2' }), { businessId: BUSINESS });
    // created_at has second-level ties in fast tests; assert on membership of
    // the pair rather than on ordering the clock cannot guarantee.
    const latest = await loadLatestReading(documentId, { businessId: BUSINESS });
    expect(latest).not.toBeNull();
    expect(['v1', 'v2']).toContain(latest?.promptVersion);
    expect(second.created).toBe(true);
  });

  it('returns null when a document has never been read', async () => {
    const documentId = await aDocument();
    expect(await loadLatestReading(documentId, { businessId: BUSINESS })).toBeNull();
  });
});

describe('the readings table', () => {
  it('drops a document\'s readings when the document is deleted', async () => {
    const documentId = await aDocument();
    await saveReading(newReading(documentId), { businessId: BUSINESS });
    await getPool().query('DELETE FROM documents WHERE document_id = $1', [documentId]);
    const { rows } = await getPool().query(
      'SELECT 1 FROM document_readings WHERE document_id = $1',
      [documentId],
    );
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/documents/reading-store.test.ts`
Expected: FAIL — `Cannot find module './reading-store.js'`.

- [ ] **Step 5: Write the implementation**

Create `src/documents/reading-store.ts`:

```ts
/**
 * Reading and writing `document_readings` (spec §8).
 *
 * A reading is a model's claim about a document, and it lives in its own table
 * rather than as a fourth artefact kind for that reason — see the migration's
 * own header for the argument.
 */

import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import type { Reading } from '../domain/reading.js';
import type { TrustLevel } from '../domain/trust.js';

export type ReadingStatus = 'read' | 'unreadable';

export interface ReadingRecord {
  readingId: string;
  businessId: string;
  documentId: string;
  status: ReadingStatus;
  reason: string | null;
  content: Reading | null;
  provenance: TrustLevel;
  model: string;
  promptVersion: string;
  briefHash: string;
}

/** What a caller supplies. `businessId` rides on the options, as everywhere else here. */
export interface NewReading {
  readingId: string;
  documentId: string;
  status: ReadingStatus;
  reason: string | null;
  content: Reading | null;
  provenance: TrustLevel;
  model: string;
  promptVersion: string;
  briefHash: string;
}

interface ReadingRow {
  reading_id: string;
  business_id: string;
  document_id: string;
  status: string;
  reason: string | null;
  content: unknown;
  provenance: string;
  model: string;
  prompt_version: string;
  brief_hash: string;
}

function toReading(row: ReadingRow): ReadingRecord {
  return {
    readingId: row.reading_id,
    businessId: row.business_id,
    documentId: row.document_id,
    status: row.status as ReadingStatus,
    reason: row.reason,
    // Stored as validated JSON, read back without re-validation: what went in
    // passed `Reading.safeParse` at the boundary, and re-parsing here would
    // make every read of the table able to fail for a reason the caller cannot
    // act on.
    content: (row.content ?? null) as Reading | null,
    provenance: row.provenance as TrustLevel,
    model: row.model,
    promptVersion: row.prompt_version,
    briefHash: row.brief_hash,
  };
}

const COLUMNS = `reading_id, business_id, document_id, status, reason, content,
                 provenance, model, prompt_version, brief_hash`;

/**
 * Store a reading, or hand back the one already stored for this exact brief
 * and prompt version.
 *
 * A single `INSERT ... ON CONFLICT DO NOTHING RETURNING *` followed by a
 * `SELECT` when the insert lost — the shape `insertOrGetDocument` already uses,
 * and for the same reason: read-then-write lets two concurrent readers of one
 * document both insert, and the loser dies on the unique index instead of
 * quietly getting the row that won.
 */
export async function saveReading(
  input: NewReading,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<{ record: ReadingRecord; created: boolean }> {
  const db = options.db ?? getPool();
  const businessId = options.businessId ?? config.businessId;

  const inserted = await db.query<ReadingRow>(
    `INSERT INTO document_readings
       (reading_id, business_id, document_id, status, reason, content,
        provenance, model, prompt_version, brief_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (business_id, document_id, brief_hash, prompt_version) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.readingId,
      businessId,
      input.documentId,
      input.status,
      input.reason,
      input.content === null ? null : JSON.stringify(input.content),
      input.provenance,
      input.model,
      input.promptVersion,
      input.briefHash,
    ],
  );

  const row = inserted.rows[0];
  if (row !== undefined) return { record: toReading(row), created: true };

  const existing = await findReadingForBrief(
    input.documentId,
    input.briefHash,
    input.promptVersion,
    { businessId, db },
  );
  if (existing === null) {
    // The insert conflicted and the conflicting row is not visible. That is
    // not a document property — it is the table disagreeing with itself.
    throw new Error(
      `saveReading: conflict on ${input.documentId} but no row to return; the readings table is inconsistent`,
    );
  }
  return { record: existing, created: false };
}

/** The reading made from this exact brief under this exact prompt version, if any. */
export async function findReadingForBrief(
  documentId: string,
  briefHash: string,
  promptVersion: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ReadingRecord | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<ReadingRow>(
    `SELECT ${COLUMNS} FROM document_readings
      WHERE business_id = $1 AND document_id = $2
        AND brief_hash = $3 AND prompt_version = $4`,
    [options.businessId ?? config.businessId, documentId, briefHash, promptVersion],
  );
  const row = rows[0];
  return row === undefined ? null : toReading(row);
}

/** The most recent reading of a document, whatever brief produced it. */
export async function loadLatestReading(
  documentId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ReadingRecord | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<ReadingRow>(
    `SELECT ${COLUMNS} FROM document_readings
      WHERE business_id = $1 AND document_id = $2
      ORDER BY created_at DESC, reading_id DESC
      LIMIT 1`,
    [options.businessId ?? config.businessId, documentId],
  );
  const row = rows[0];
  return row === undefined ? null : toReading(row);
}
```

- [ ] **Step 6: Add the new table to `resetDatabase`**

`src/test/db.ts` names every table explicitly in one `TRUNCATE ... RESTART IDENTITY CASCADE`. Add `document_readings` to that list, immediately **before** `document_artifacts`:

```
      job_steps,
      jobs,
      document_readings,
      document_artifacts,
      documents,
```

`CASCADE` would reach it anyway through the foreign key, but a table that only ever gets truncated as someone else's dependent is a table that stops being truncated the day that key changes. Re-run the store tests afterwards: an untruncated table makes every later test order-dependent, and that failure surfaces far from its cause.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/documents/reading-store.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 8: Typecheck, full suite, and commit**

```bash
npm run typecheck && npm test
git add src/db/migrations/013_document_readings.sql src/documents/reading-store.ts src/documents/reading-store.test.ts src/test/db.ts
git commit -m "Store a reading, including one that failed

document_readings, not a fourth artefact kind. An artefact is what was
extracted from the file; a reading is a model's claim about it, and in one
table a later reader could not tell them apart.

An unreadable outcome is stored. \"We tried and could not understand it\" is a
fact about the record; no row at all says we never tried.

Keyed on brief_hash and prompt_version, so the same document read from the
same text under the same question is paid for once.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The stable prompt prefix

**Files:**
- Create: `src/sdk/reading-prompt.ts`
- Create: `src/sdk/reading-prompt.test.ts`

**Interfaces:**
- Consumes: `INTENT_MEANING`, `IntentName` from `src/domain/reading.js`; `type PolicyBundle` from `src/domain/policy.js`.
- Produces: `READING_PROMPT_VERSION: string`, `buildReadingSystemPrompt(bundle: PolicyBundle): string`.

**Context:** The charter fragment, the intent registry, and the output schema are byte-identical across every read; the brief is the only part that varies, and it travels as the user prompt. That split is what lets the cached prefix survive — the same rule `buildPlannerPrompt` follows (`src/sdk/planner.ts`) and `renderCatalogue` before it. A byte changing near the front invalidates the whole cache.

The registry section is **generated from `INTENT_MEANING`**, never typed out again. A prompt listing intents by hand is a second copy of the registry that will drift from the enum.

- [ ] **Step 1: Write the failing tests**

Create `src/sdk/reading-prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { INTENT_MEANING, IntentName } from '../domain/reading.js';
import { buildCharter } from '../test/fixtures.js';
import { compileCharter } from '../charter/compile.js';
import { READING_PROMPT_VERSION, buildReadingSystemPrompt } from './reading-prompt.js';

const bundle = compileCharter(buildCharter());

describe('buildReadingSystemPrompt', () => {
  it('names every intent in the registry', () => {
    const prompt = buildReadingSystemPrompt(bundle);
    for (const name of IntentName.options) {
      expect(prompt, `${name} missing from the prompt`).toContain(name);
    }
  });

  it('carries each intent\'s meaning, not just its identifier', () => {
    const prompt = buildReadingSystemPrompt(bundle);
    for (const meaning of Object.values(INTENT_MEANING)) {
      expect(prompt).toContain(meaning);
    }
  });

  it('opens with the charter the owner signed', () => {
    const prompt = buildReadingSystemPrompt(bundle);
    expect(prompt.startsWith(bundle.promptFragments['know.reader'])).toBe(true);
  });

  it('tells the reader it may not invent an address', () => {
    expect(buildReadingSystemPrompt(bundle)).toContain('unresolved');
  });

  it('is byte-identical across calls, so the cached prefix survives', () => {
    expect(buildReadingSystemPrompt(bundle)).toBe(buildReadingSystemPrompt(bundle));
  });

  it('has a version that is a declared constant, not a hash', () => {
    // A hash would change on a comma and invalidate every stored reading while
    // the question asked stayed identical.
    expect(READING_PROMPT_VERSION).toMatch(/^v\d+$/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/sdk/reading-prompt.test.ts`
Expected: FAIL — `Cannot find module './reading-prompt.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/sdk/reading-prompt.ts`:

```ts
/**
 * The stable half of what `know.reader` is sent (spec §5).
 *
 * Charter fragment, then the intent registry, then the output schema — all
 * byte-identical across every read. The brief is the only part that varies and
 * it travels as the user prompt, which is the whole reason this split exists:
 * a byte changing near the front invalidates the cached prefix, and the
 * catalogue's own docblock records what that costs.
 */

import { INTENT_MEANING, IntentName } from '../domain/reading.js';
import type { PolicyBundle } from '../domain/policy.js';

/**
 * Raised by hand when the *meaning* of the question changes.
 *
 * Deliberately not a hash of the prompt text: a hash changes on a comma and
 * invalidates every stored reading while the question asked stayed identical.
 * Whoever changes what is being asked raises this, and that is the decision we
 * want to be conscious.
 */
export const READING_PROMPT_VERSION = 'v1';

/**
 * Generated from `INTENT_MEANING`, never written out again. A hand-typed list
 * here would be a second copy of the registry, and it would drift from the
 * enum the first time someone added an intent.
 */
function intentRegistrySection(): string {
  const lines = IntentName.options.map((name) => `- \`${name}\` — ${INTENT_MEANING[name]}`);
  return lines.join('\n');
}

export function buildReadingSystemPrompt(bundle: PolicyBundle): string {
  return [
    bundle.promptFragments['know.reader'],
    '',
    '# מה אתה מחזיר',
    'אתה קורא מסמך ומחזיר קריאה מובנית. אינך מבצע דבר ואינך מחליט מה יקרה —',
    'אתה מדווח מה כתוב ומה משתמע.',
    '',
    '# הכוונות האפשריות',
    'אלה הכוונות היחידות שקיימות. אין להמציא כוונה שאינה ברשימה.',
    intentRegistrySection(),
    '',
    '# למי הכוונה מתייחסת',
    'לכל כוונה יש `subject`, באחת משלוש הצורות בלבד:',
    '- `{"kind":"sender"}` — מי ששלח את המסמך. אל תנקוב בשם או בכתובת; המערכת יודעת מיהו.',
    '- `{"kind":"entity","entityId":"..."}` — רק אם המזהה מופיע במסמך כמזהה של ישות מוכרת.',
    '- `{"kind":"unresolved","describedAs":"..."}` — כשהמסמך מתאר גורם ואינך יודע מיהו.',
    '',
    '**לעולם אל תכתוב כתובת מייל, מספר טלפון או יעד כלשהו כ-subject.**',
    'אם המסמך אומר לפנות למישהו ואינך יודע מיהו — זה `unresolved`.',
    '',
    '# ציטוט',
    'לכל ממצא ולכל כוונה יש `sourceRef.ordinal` — מספר החלק שממנו הוא נלקח,',
    'כפי שהוא מסומן בתדריך ב-`[חלק N]`. ציטוט לחלק שאינו קיים פוסל את כל הקריאה.',
    '',
    '# מה לייצר',
    'החזר JSON יחיד התואם לסכמה, בלי טקסט לפניו או אחריו:',
    '{"summary": string,',
    ' "findings": [{"label": string, "value": string,',
    '               "sourceRef": {"ordinal": number, "locator": string|null}}],',
    ' "intents": [{"intent": string, "subject": object,',
    '              "sourceRef": {"ordinal": number, "locator": string|null},',
    '              "note": string}],',
    ' "unreadable": string[]}',
    '',
    'כללים: `summary` בעברית · `intents` לעולם אינו ריק — אם לא נדרש דבר, החזר',
    '`no_action` · `findings` הם ערכים כלשונם מהמסמך, לא חישובים · `unreadable`',
    'מונה מה שלא הצלחת לקבוע. עדיף לומר שלא ידעת מאשר לנחש.',
  ].join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/sdk/reading-prompt.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npx vitest run src/sdk/reading-prompt.test.ts
git add src/sdk/reading-prompt.ts src/sdk/reading-prompt.test.ts
git commit -m "The reader's stable prompt prefix, generated from the registry

Charter fragment, intent registry, output schema — byte-identical across every
read, with the brief as the only varying part. Same split as
buildPlannerPrompt, and for the same reason: a byte near the front costs the
whole cached prefix.

The registry section is generated from INTENT_MEANING. Typed out by hand it
would be a second copy of the enum, and it would drift.

READING_PROMPT_VERSION is raised by hand. A hash would change on a comma and
throw away every stored reading while the question stayed the same.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `runKnowReader` returns a reading, not a string

**Files:**
- Modify: `src/sdk/know-reader.ts` — replace `ReadRequest.task` with `ReadRequest.artifacts`, replace `ReadResult` with `ReadOutcome`
- Modify: `src/sdk/run-know-reader.ts` — the live script's call site
- Create: `src/sdk/know-reader-outcome.test.ts`

**Interfaces:**
- Consumes: `renderReadingBrief` from `src/documents/brief.js`; `parseReading` from `src/documents/reading-parse.js`; `buildReadingSystemPrompt`, `READING_PROMPT_VERSION` from `./reading-prompt.js`; `DocumentArtifact` from `src/documents/types.js`.
- Produces: from `src/sdk/know-reader.ts` —
  - `interface ReadRequest { bundle; artifacts: readonly DocumentArtifact[]; provenance?: TrustLevel; businessId?: string; jobId: string | null; documentRoot: string }`
  - `type ReadOutcome = { status: 'read'; reading: Reading; raw: string; denials: string[]; turns: number } | { status: 'unreadable'; reason: string; raw: string; denials: string[]; turns: number }`
  - `runKnowReader(request: ReadRequest): Promise<ReadOutcome>`
  - `interpretReaderResponse(raw: string, artifacts, denials: string[], turns: number): ReadOutcome` — the pure part, exported so it can be tested without an API key.

**Context:** `runKnowReader` currently takes a free-text `task` and returns `{ text, denials, turns }`. Free text stops being a legal output (spec §2). The SDK call itself cannot be tested here — it needs a key and costs money — so **everything except the `query()` loop moves into `interpretReaderResponse`**, which is pure and gets the coverage. This is the same separation `parsePlan` has from `makePlan`.

Three things in the existing `options` object must not change: `settingSources: []`, the `env` allowlist that passes only `PATH`, and `disallowedTools`. Each has a docblock explaining what it prevents. `systemPrompt` changes from `definition.prompt` to `buildReadingSystemPrompt(request.bundle)`; the prompt fragment is still the first thing in it.

- [ ] **Step 1: Write the failing tests**

Create `src/sdk/know-reader-outcome.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DocumentArtifact } from '../documents/types.js';
import { interpretReaderResponse } from './know-reader.js';

const ARTIFACTS: DocumentArtifact[] = [
  { ordinal: 0, kind: 'text', partName: null, content: { blocks: [] }, flags: [] },
];

const VALID = JSON.stringify({
  summary: 'חשבונית מספק.',
  findings: [],
  intents: [{ intent: 'file_document', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null } }],
  unreadable: [],
});

describe('interpretReaderResponse', () => {
  it('turns a valid response into a reading and keeps the raw text', () => {
    const outcome = interpretReaderResponse(VALID, ARTIFACTS, [], 2);
    expect(outcome.status).toBe('read');
    expect(outcome.raw).toBe(VALID);
    expect(outcome.turns).toBe(2);
  });

  it('carries gate denials through on a successful read', () => {
    const outcome = interpretReaderResponse(VALID, ARTIFACTS, ['tool_not_allowlisted'], 1);
    expect(outcome.status).toBe('read');
    expect(outcome.denials).toEqual(['tool_not_allowlisted']);
  });

  it('reports unreadable, with the raw text kept, when nothing parses', () => {
    const outcome = interpretReaderResponse('לא הבנתי את המסמך', ARTIFACTS, [], 1);
    expect(outcome.status).toBe('unreadable');
    expect(outcome.raw).toBe('לא הבנתי את המסמך');
  });

  it('keeps denials on an unreadable outcome too', () => {
    const outcome = interpretReaderResponse('', ARTIFACTS, ['quiet_hours'], 0);
    expect(outcome.status).toBe('unreadable');
    expect(outcome.denials).toEqual(['quiet_hours']);
  });

  it('refuses a reading that cites a part the artefacts do not have', () => {
    const fabricated = JSON.stringify({
      summary: 'x',
      findings: [],
      intents: [{ intent: 'no_action', subject: { kind: 'sender' }, sourceRef: { ordinal: 42, locator: null } }],
      unreadable: [],
    });
    const outcome = interpretReaderResponse(fabricated, ARTIFACTS, [], 1);
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
    expect(outcome.reason).toContain('42');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/sdk/know-reader-outcome.test.ts`
Expected: FAIL — `interpretReaderResponse` is not exported.

- [ ] **Step 3: Rewrite the request, outcome, and interpretation in `know-reader.ts`**

In `src/sdk/know-reader.ts`, add these imports beside the existing ones:

```ts
import { renderReadingBrief } from '../documents/brief.js';
import { parseReading } from '../documents/reading-parse.js';
import type { DocumentArtifact } from '../documents/types.js';
import type { Reading } from '../domain/reading.js';
import { buildReadingSystemPrompt } from './reading-prompt.js';
```

Replace the `task` field in `ReadRequest` with:

```ts
  /**
   * The document's extracted parts, as `loadArtifacts` returns them.
   *
   * Not a free-text task and not a path: the brief is rendered from these
   * deterministically (`renderReadingBrief`), so what the reader is asked
   * about is a function of what intake extracted rather than of a string a
   * caller composed. It also means `sourceRef` has something real to cite.
   */
  artifacts: readonly DocumentArtifact[];
```

Replace `ReadResult` entirely with:

```ts
/**
 * What a read produced. Free text is not among the possibilities.
 *
 * `raw` rides on both branches: on failure it is the evidence for the recorded
 * reason, and on success it is what the stored reading was derived from.
 */
export type ReadOutcome =
  | { status: 'read'; reading: Reading; raw: string; denials: string[]; turns: number }
  | { status: 'unreadable'; reason: string; raw: string; denials: string[]; turns: number };

/**
 * Everything about a read except the model call.
 *
 * Separated so it can be tested without an API key — the same split
 * `parsePlan` has from `makePlan`. The interesting failures here are malformed
 * output and fabricated citations, neither of which needs network behaviour to
 * reproduce.
 */
export function interpretReaderResponse(
  raw: string,
  artifacts: readonly DocumentArtifact[],
  denials: string[],
  turns: number,
): ReadOutcome {
  const parsed = parseReading(raw, artifacts);
  if (parsed.status === 'read') {
    return { status: 'read', reading: parsed.reading, raw, denials, turns };
  }
  return { status: 'unreadable', reason: parsed.reason, raw, denials, turns };
}
```

- [ ] **Step 4: Change the call itself**

In `runKnowReader`, change the return type to `Promise<ReadOutcome>`, and:

1. Build the brief before the options object:

```ts
  const brief = renderReadingBrief(request.artifacts);
```

2. Change `systemPrompt` from `definition.prompt` to:

```ts
    // The charter fragment is still the first thing in it; the intent registry
    // and output schema follow, and all of it is byte-identical across reads.
    systemPrompt: buildReadingSystemPrompt(request.bundle),
```

3. Change the query prompt from `request.task` to `brief`.

4. Replace the return statement with:

```ts
  return interpretReaderResponse(text, request.artifacts, denials, turns);
```

Leave `settingSources`, `env`, `disallowedTools`, `tools`, `cwd`, `maxTurns`, `permissionMode` and the `hooks` block exactly as they are. `knowReaderDefinition` stays — it is still what documents the agent's shape — but note in its docblock that `runKnowReader` now composes the system prompt rather than using `definition.prompt` directly.

- [ ] **Step 5: Update the live script**

In `src/sdk/run-know-reader.ts`, the script now needs artefacts rather than a task string. Replace the `runKnowReader` call and the printing with:

```ts
  const outcome = await runKnowReader({
    bundle,
    // A one-part stand-in so the script exercises the real path without
    // needing a document in the database. `npm run sdk:read-document` is the
    // end-to-end script; this one stays the minimal SDK probe it always was.
    artifacts: [
      {
        ordinal: 0,
        kind: 'text',
        partName: 'הודעה',
        content: { blocks: [{ kind: 'paragraph', text: task }] },
        flags: [],
      },
    ],
    provenance: 'unknown_external',
    documentRoot,
    jobId: null,
  });

  console.log('--- תוצאה ---');
  if (outcome.status === 'read') {
    console.log(JSON.stringify(outcome.reading, null, 2));
  } else {
    console.log(`לא ניתן לקרוא: ${outcome.reason}`);
    console.log(`--- מה שהוחזר בפועל ---\n${outcome.raw}`);
  }
  console.log(`\nתורות: ${outcome.turns}`);
  console.log(
    outcome.denials.length > 0
      ? `דחיות מהשער: ${outcome.denials.join(', ')}`
      : 'השער לא דחה דבר.',
  );
```

Keep the credentials check, the charter load, and the `mkdir` exactly as they are.

- [ ] **Step 6: Fix the existing know-reader tests**

Run `npx vitest run src/sdk/` and repair every call site that still passes `task` or reads `result.text`. Do not weaken an assertion to make it pass: a test that asserted on returned text now asserts on `outcome.status` and on the parsed reading. If a test only checked that the definition was well-formed, it needs no change.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/sdk/`
Expected: PASS, including the 5 new outcome tests.

- [ ] **Step 8: Typecheck, full suite, and commit**

```bash
npm run typecheck && npm test
git add src/sdk/know-reader.ts src/sdk/run-know-reader.ts src/sdk/know-reader-outcome.test.ts src/sdk/know-reader.test.ts
git commit -m "The reader returns a reading; free text is no longer a legal output

runKnowReader took a free-text task and returned a string. It now takes the
document's artefacts, renders the brief from them, and returns a ReadOutcome
that is either a validated Reading or a stated reason why it is not one.

Everything except the query() loop is in interpretReaderResponse, which is
pure and carries the coverage — the same split parsePlan has from makePlan.
The SDK call needs a key and costs money; the logic must not.

settingSources, the PATH-only env, and disallowedTools are untouched. Each
prevents something specific and each says so in place.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `readDocument` — the composition

**Files:**
- Create: `src/documents/read.ts`
- Create: `src/documents/read.test.ts`

**Interfaces:**
- Consumes: `loadArtifacts` from `./store.js`; `renderReadingBrief` from `./brief.js`; `saveReading`, `findReadingForBrief`, `type ReadingRecord` from `./reading-store.js`; `runKnowReader`, `type ReadOutcome` from `../sdk/know-reader.js`; `READING_PROMPT_VERSION` from `../sdk/reading-prompt.js`; `markContentIngested` from `../orchestrator/jobs.js`; `type PolicyBundle`, `type TrustLevel`.
- Produces: `readDocument(input: ReadDocumentInput, options?: ReadDocumentOptions): Promise<ReadDocumentResult>`, and `type ReadDocumentResult = { status: 'read'; reading: Reading; record: ReadingRecord; cached: boolean } | { status: 'unreadable'; reason: string; record: ReadingRecord; cached: boolean } | { status: 'no_artifacts' }`.

**Context:** The order of operations *is* the design, the way it is in `ingestDocument`:

```
loadArtifacts → renderReadingBrief → hash the brief → cache lookup
  → markContentIngested (BEFORE the model sees a byte) → runKnowReader
  → saveReading
```

`markContentIngested` fires **before** the read, never after. The flag is monotonic and its whole purpose is that a crash between the read and the write leaves a job that remembers reading — early is the safe direction, and migration 011 records the argument. It is skipped only when `jobId` is `null`, which is a genuinely job-less run, not an omission.

The cache lookup comes before `markContentIngested` deliberately: a cache hit performs no read at all, and setting a flag that says "this job consumed external content" for a call that consumed nothing would tighten a control on the strength of something that did not happen. A cached reading is still returned to the caller — what did not happen is the model call.

Testing without an API key: `readDocument` takes an optional `reader` function defaulting to `runKnowReader`. Injecting it is how the composition is tested — not a mock of the SDK, but a stand-in for the one step that costs money. Every other step runs for real against the real database.

- [ ] **Step 1: Write the failing tests**

Create `src/documents/read.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { compileCharter } from '../charter/compile.js';
import { buildCharter } from '../test/fixtures.js';
import { createJob } from '../orchestrator/jobs.js';
import type { ReadOutcome } from '../sdk/know-reader.js';
import { insertOrGetDocument, markExtracted } from './store.js';
import { readDocument } from './read.js';

const BUSINESS = 'test-business';
const bundle = compileCharter(buildCharter());

const READING_JSON = {
  summary: 'חשבונית מספק.',
  findings: [{ label: 'סכום', value: '1,200', sourceRef: { ordinal: 0, locator: null } }],
  intents: [{ intent: 'file_document', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null }, note: '' }],
  unreadable: [],
};

/** A reader that returns a fixed response without a model. Counts its calls. */
function stubReader(raw: string) {
  const calls: number[] = [];
  const reader = async (request: { artifacts: readonly unknown[] }): Promise<ReadOutcome> => {
    calls.push(request.artifacts.length);
    const { interpretReaderResponse } = await import('../sdk/know-reader.js');
    return interpretReaderResponse(raw, request.artifacts as never, [], 1);
  };
  return { reader, calls };
}

async function anExtractedDocument(): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument(
    {
      documentId,
      source: 'manual',
      originalName: 'חשבונית.txt',
      mediaType: 'text/plain',
      sha256: ulid().padEnd(64, '0'),
      byteSize: 20,
      storedPath: `${BUSINESS}/${documentId}/original.txt`,
    },
    { businessId: BUSINESS },
  );
  await markExtracted(
    documentId,
    [{ ordinal: 0, kind: 'text', partName: 'גוף', content: { blocks: [{ kind: 'paragraph', text: 'סכום: 1,200' }] }, flags: [] }],
    { businessId: BUSINESS },
  );
  return documentId;
}

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

describe('readDocument', () => {
  it('reads a document and stores the reading', async () => {
    const documentId = await anExtractedDocument();
    const { reader } = stubReader(JSON.stringify(READING_JSON));
    const result = await readDocument(
      { documentId, bundle, provenance: 'unknown_external', jobId: null },
      { businessId: BUSINESS, reader },
    );
    expect(result.status).toBe('read');
    if (result.status !== 'read') throw new Error('expected a reading');
    expect(result.reading.summary).toBe('חשבונית מספק.');
    expect(result.record.status).toBe('read');
    expect(result.cached).toBe(false);
  });

  it('does not call the model twice for the same document and brief', async () => {
    const documentId = await anExtractedDocument();
    const { reader, calls } = stubReader(JSON.stringify(READING_JSON));
    const input = { documentId, bundle, provenance: 'unknown_external' as const, jobId: null };
    await readDocument(input, { businessId: BUSINESS, reader });
    const second = await readDocument(input, { businessId: BUSINESS, reader });
    expect(calls).toHaveLength(1);
    expect(second.status).toBe('read');
    expect(second.cached).toBe(true);
  });

  it('records an unreadable outcome instead of throwing', async () => {
    const documentId = await anExtractedDocument();
    const { reader } = stubReader('לא הצלחתי');
    const result = await readDocument(
      { documentId, bundle, provenance: 'unknown_external', jobId: null },
      { businessId: BUSINESS, reader },
    );
    expect(result.status).toBe('unreadable');
    if (result.status !== 'unreadable') throw new Error('expected unreadable');
    expect(result.record.status).toBe('unreadable');
    expect(result.record.content).toBeNull();
  });

  it('stores the source\'s trust level and never raises it', async () => {
    const documentId = await anExtractedDocument();
    const { reader } = stubReader(JSON.stringify(READING_JSON));
    const result = await readDocument(
      { documentId, bundle, provenance: 'open_web', jobId: null },
      { businessId: BUSINESS, reader },
    );
    if (result.status !== 'read') throw new Error('expected a reading');
    expect(result.record.provenance).toBe('open_web');
  });

  it('marks the job as having ingested content before the read', async () => {
    const documentId = await anExtractedDocument();
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'לקרוא חשבונית',
    });
    let flagDuringRead: boolean | null = null;
    const reader = async (request: { artifacts: readonly unknown[] }): Promise<ReadOutcome> => {
      const { rows } = await getPool().query<{ content_ingested: boolean }>(
        'SELECT content_ingested FROM jobs WHERE job_id = $1',
        [job.jobId],
      );
      flagDuringRead = rows[0]?.content_ingested ?? null;
      const { interpretReaderResponse } = await import('../sdk/know-reader.js');
      return interpretReaderResponse(JSON.stringify(READING_JSON), request.artifacts as never, [], 1);
    };

    const result = await readDocument(
      { documentId, bundle, provenance: 'boss', jobId: job.jobId },
      { businessId: BUSINESS, reader },
    );

    // The positive half matters: without it this test would pass even if the
    // read never happened at all.
    expect(result.status).toBe('read');
    expect(flagDuringRead).toBe(true);
  });

  it('does not mark content ingested when a cached reading is returned', async () => {
    const documentId = await anExtractedDocument();
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'לקרוא שוב',
    });
    const { reader } = stubReader(JSON.stringify(READING_JSON));
    // First read, with no job, populates the cache.
    await readDocument(
      { documentId, bundle, provenance: 'boss', jobId: null },
      { businessId: BUSINESS, reader },
    );
    const second = await readDocument(
      { documentId, bundle, provenance: 'boss', jobId: job.jobId },
      { businessId: BUSINESS, reader },
    );
    expect(second.cached).toBe(true);
    const { rows } = await getPool().query<{ content_ingested: boolean }>(
      'SELECT content_ingested FROM jobs WHERE job_id = $1',
      [job.jobId],
    );
    expect(rows[0]?.content_ingested).toBe(false);
  });

  it('reports no_artifacts for a document that was never extracted', async () => {
    const documentId = `DOC-${ulid()}`;
    await insertOrGetDocument(
      {
        documentId,
        source: 'manual',
        originalName: 'ריק.txt',
        mediaType: 'text/plain',
        sha256: ulid().padEnd(64, '0'),
        byteSize: 0,
        storedPath: `${BUSINESS}/${documentId}/original.txt`,
      },
      { businessId: BUSINESS },
    );
    const { reader, calls } = stubReader(JSON.stringify(READING_JSON));
    const result = await readDocument(
      { documentId, bundle, provenance: 'boss', jobId: null },
      { businessId: BUSINESS, reader },
    );
    expect(result.status).toBe('no_artifacts');
    expect(calls).toHaveLength(0);
  });
});
```

**Note on `createJob`:** it takes a single argument (`CreateJobInput`, `src/orchestrator/jobs.ts:53`) and `charterVersion` is required — the two call sites above are written against that signature, matching `src/orchestrator/verify.test.ts:39`. Do not add a second options parameter.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/documents/read.test.ts`
Expected: FAIL — `Cannot find module './read.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/documents/read.ts`:

```ts
/**
 * `readDocument` — artefacts in, a stored reading out (spec §6).
 *
 * The order these steps run in *is* the design, the same way it is in
 * `ingestDocument`:
 *
 *   loadArtifacts → renderReadingBrief → hash → cache lookup →
 *   markContentIngested → runKnowReader → saveReading
 *
 * **`markContentIngested` fires before the model sees a byte.** The flag is
 * monotonic and exists so a job that consumed outside content can never be
 * granted the first-contact exemption; a crash between the read and the write
 * would otherwise leave a job that read and does not remember it. Early is the
 * safe direction — migration 011 carries the full argument.
 *
 * **The cache lookup comes first, and a cache hit does not set the flag.** A
 * hit performs no read, and marking a job as having consumed external content
 * for a call that consumed nothing would tighten a control on the strength of
 * something that did not happen.
 *
 * **Nothing here throws for a bad response.** An unparseable answer is stored
 * as `unreadable` and returned, exactly as `ingestDocument` records a rejected
 * document. A genuine fault — the database unreachable, no API key — still
 * propagates, because that is not a property of the document.
 */

import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { Reading } from '../domain/reading.js';
import type { TrustLevel } from '../domain/trust.js';
import { markContentIngested } from '../orchestrator/jobs.js';
import { runKnowReader, type ReadOutcome, type ReadRequest } from '../sdk/know-reader.js';
import { READING_PROMPT_VERSION } from '../sdk/reading-prompt.js';
import { renderReadingBrief } from './brief.js';
import { findReadingForBrief, saveReading, type ReadingRecord } from './reading-store.js';
import { loadArtifacts } from './store.js';

export interface ReadDocumentInput {
  documentId: string;
  bundle: PolicyBundle;
  /** Trust of the source. Stored on the reading and never raised by it. */
  provenance: TrustLevel;
  /**
   * The job this read belongs to, or explicitly `null` when there is none.
   *
   * Required rather than optional, for the reason `GateHookBinding.jobId`
   * records: an omitted id and a genuinely job-less run must not be the same
   * value, or the content-ingested flag stops being set by accident.
   */
  jobId: string | null;
}

export interface ReadDocumentOptions {
  businessId?: string;
  db?: Queryable;
  documentRoot?: string;
  /**
   * The one step that costs money, injectable so the composition can be tested
   * without an API key. Not a mock of the SDK — every other step in this
   * function runs for real against the real database.
   */
  reader?: (request: ReadRequest) => Promise<ReadOutcome>;
}

export type ReadDocumentResult =
  | { status: 'read'; reading: Reading; record: ReadingRecord; cached: boolean }
  | { status: 'unreadable'; reason: string; record: ReadingRecord; cached: boolean }
  | { status: 'no_artifacts' };

function hashBrief(brief: string): string {
  return createHash('sha256').update(brief, 'utf8').digest('hex');
}

/** The model this reader runs on, recorded so a reading can be attributed. */
const READER_MODEL = 'haiku';

export async function readDocument(
  input: ReadDocumentInput,
  options: ReadDocumentOptions = {},
): Promise<ReadDocumentResult> {
  const businessId = options.businessId ?? config.businessId;
  const documentRoot = options.documentRoot ?? config.documentRoot;
  const reader = options.reader ?? runKnowReader;

  const artifacts = await loadArtifacts(input.documentId, {
    businessId,
    ...(options.db !== undefined ? { db: options.db } : {}),
  });
  if (artifacts.length === 0) {
    // Not a failed reading — there was nothing to read. Storing an
    // `unreadable` row here would blame the reader for the extractor's
    // silence.
    return { status: 'no_artifacts' };
  }

  const brief = renderReadingBrief(artifacts);
  const briefHash = hashBrief(brief);

  const cached = await findReadingForBrief(
    input.documentId,
    briefHash,
    READING_PROMPT_VERSION,
    { businessId, ...(options.db !== undefined ? { db: options.db } : {}) },
  );
  if (cached !== null) return fromRecord(cached, true);

  if (input.jobId !== null) {
    // Before the read, never after. See this module's header.
    await markContentIngested(input.jobId, {
      businessId,
      ...(options.db !== undefined ? { db: options.db } : {}),
    });
  }

  const outcome = await reader({
    bundle: input.bundle,
    artifacts,
    provenance: input.provenance,
    businessId,
    jobId: input.jobId,
    documentRoot,
  });

  const { record } = await saveReading(
    {
      readingId: `RDG-${ulid()}`,
      documentId: input.documentId,
      status: outcome.status,
      reason: outcome.status === 'unreadable' ? outcome.reason : null,
      content: outcome.status === 'read' ? outcome.reading : null,
      provenance: input.provenance,
      model: READER_MODEL,
      promptVersion: READING_PROMPT_VERSION,
      briefHash,
    },
    { businessId, ...(options.db !== undefined ? { db: options.db } : {}) },
  );

  return fromRecord(record, false);
}

/**
 * One record, read back as a result.
 *
 * A stored row is the single source of truth for both paths — a cache hit and
 * a fresh read return the same shape from the same place, so the two can never
 * disagree about what was concluded.
 */
function fromRecord(record: ReadingRecord, cached: boolean): ReadDocumentResult {
  if (record.status === 'read' && record.content !== null) {
    return { status: 'read', reading: record.content, record, cached };
  }
  return {
    status: 'unreadable',
    reason: record.reason ?? 'unreadable, with no reason recorded',
    record,
    cached,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/documents/read.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck, full suite, and commit**

```bash
npm run typecheck && npm test
git add src/documents/read.ts src/documents/read.test.ts
git commit -m "readDocument: artefacts in, a stored reading out

The order is the design. markContentIngested fires before the model sees a
byte — the flag is monotonic and early is the safe direction; migration 011
carries the argument. A cache hit does not set it, because a hit consumed no
external content and marking it would tighten a control on something that did
not happen.

A response that is not a reading is stored as unreadable and returned, not
thrown. A document with no artefacts is no_artifacts, not a failed reading —
storing a failure there would blame the reader for the extractor's silence.

The model call is injectable so the composition is testable without a key;
every other step runs for real against the real database.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The structural invariants

**Files:**
- Create: `src/documents/reading-invariants.test.ts`

**Interfaces:**
- Consumes: `AGENT_ALLOWLISTS` from `src/charter/capabilities.js`; `TOOL_ACTION_CLASS` from `src/policy/classify.js`; `IntentName` from `src/domain/reading.js`. Reads files from disk with `node:fs`.

**Context:** These are the `capabilities.test.ts` kind of test: not behaviour, but invariants that block a way for the tables to fall out of sync and leave a silent hole. If one fails, the fix is almost always in the code it guards, not in the test.

The load-bearing one is the first: **no module under `src/policy/` may import from `src/domain/reading.js`.** A model-read amount reaching `readAmountMinor` would let a document set its own ceiling — the precise shape of bug the ceilings exist to prevent. Spec §7, control 4.

- [ ] **Step 1: Write the tests**

Create `src/documents/reading-invariants.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_ALLOWLISTS } from '../charter/capabilities.js';
import { TOOL_ACTION_CLASS } from '../policy/classify.js';
import { INTENT_MEANING, IntentName } from '../domain/reading.js';

const POLICY_DIR = new URL('../policy/', import.meta.url).pathname;

function policySources(): string[] {
  return readdirSync(POLICY_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(POLICY_DIR, name));
}

describe('a reading is never a fact the gate reads', () => {
  it('finds policy sources to check, so an empty sweep cannot pass silently', () => {
    expect(policySources().length).toBeGreaterThan(3);
  });

  it('has no module under src/policy/ importing the reading domain', () => {
    const offenders = policySources().filter((path) =>
      /from\s+['"].*domain\/reading\.js['"]/.test(readFileSync(path, 'utf8')),
    );
    // A model-read amount reaching readAmountMinor would let a document set
    // its own ceiling. Findings are advisory and stay out of the gate.
    expect(offenders).toEqual([]);
  });

  it('has no module under src/policy/ naming Finding or Reading at all', () => {
    const offenders = policySources().filter((path) =>
      /\b(Finding|IntentName)\b/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the reader stays in quarantine', () => {
  it('gives know.reader no classified tool', () => {
    const tools = AGENT_ALLOWLISTS['know.reader'] ?? [];
    const classified = tools.filter((tool) => Object.hasOwn(TOOL_ACTION_CLASS, tool));
    expect(classified).toEqual([]);
  });

  it('adds no tool to know.reader for the reading work', () => {
    // Structured output is validated on our side precisely so no new tool has
    // to exist. If this list grows, the quarantine argument has been dropped.
    expect([...(AGENT_ALLOWLISTS['know.reader'] ?? [])].sort()).toEqual(
      ['doc.fetch', 'memory.recall'].sort(),
    );
  });
});

describe('the intent registry', () => {
  it('names no tool', () => {
    // An intent names an outcome. A dot in the name is the shape of a tool id
    // (`mail.send`, `crm.write`) and the surest sign the rule slipped.
    for (const name of IntentName.options) {
      expect(name, `${name} looks like a tool id`).not.toContain('.');
    }
  });

  it('explains every intent it declares', () => {
    expect(Object.keys(INTENT_MEANING).sort()).toEqual([...IntentName.options].sort());
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/documents/reading-invariants.test.ts`
Expected: PASS, 7 tests. If the `AGENT_ALLOWLISTS['know.reader']` assertion fails, the allowlist has changed — fix the allowlist, not the test.

- [ ] **Step 3: Prove the sweep can fail**

Temporarily add `import type { Finding } from '../domain/reading.js';` to the top of `src/policy/facts.ts`, re-run, and confirm the import test **fails**. Then remove the line and re-run to confirm it passes. A sweep that cannot fail is not a sweep.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/documents/reading-invariants.test.ts
git commit -m "Lock the reading boundary: findings never reach the gate

No module under src/policy/ may import the reading domain. A model-read
amount arriving at readAmountMinor would let a document set its own ceiling,
which is the exact shape of bug the ceilings exist to prevent.

Also locked: know.reader still holds zero classified tools and exactly the two
it always had, and no intent name contains a dot — an intent names an outcome,
and a dot is the shape of a tool id.

The sweep asserts it found files to sweep. An empty sweep that passes is not
a control.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Live script and documentation

**Files:**
- Create: `scripts/read-document.ts`
- Modify: `package.json` — add `"sdk:read-document": "tsx scripts/read-document.ts"` to `scripts`
- Modify: `CLAUDE.md` — the commands block, the silent-rules section, and "מה עוד לא נבנה בשלב 0"
- Modify: `docs/01-agents.md` — the `know.reader` entry
- Modify: `docs/03-protocol.md` — the intents registry section
- Modify: `docs/09-roadmap.md` — what sub-project ב' closed and what it did not

**Context:** The live run is a script and not a test, for the reason the existing one states: it costs money and needs a key, and a test that skips silently when the key is absent reports green for work it did not do.

The documentation edits are not decoration. `CLAUDE.md` is the file every future session reads first, and three of its claims become false the moment this branch lands: that nothing consumes document artefacts, that `PlanRequest.intents` has no defined shape, and that the intents registry is unbuilt.

- [ ] **Step 1: Write the live script**

Create `scripts/read-document.ts`:

```ts
/**
 * Live end-to-end read of a stored document.
 *
 *   npm run sdk:read-document -- DOC-01J...
 *
 * A script and not a test: it costs money and needs a key, and a suite that
 * skips silently without one reports green for work it did not do. Everything
 * this script composes is covered by tests that need neither.
 */
import { config } from '../src/config.js';
import { buildCharter } from '../src/test/fixtures.js';
import { installCharter, loadActiveCharter } from '../src/charter/store.js';
import { closePool } from '../src/db/pool.js';
import { readDocument } from '../src/documents/read.js';

const documentId = process.argv[2];

async function main(): Promise<void> {
  if (documentId === undefined) {
    console.error('שימוש: npm run sdk:read-document -- <documentId>');
    process.exitCode = 1;
    return;
  }

  const hasCredentials =
    process.env['ANTHROPIC_API_KEY'] !== undefined ||
    process.env['ANTHROPIC_AUTH_TOKEN'] !== undefined;
  if (!hasCredentials) {
    console.error(
      'אין ANTHROPIC_API_KEY בסביבה. ההרצה החיה דורשת מפתח; הלוגיקה עצמה מכוסה במבחנים.',
    );
    process.exitCode = 1;
    return;
  }

  const active = await loadActiveCharter(config.businessId);
  const bundle = active?.bundle ?? (await installCharter(buildCharter()));

  const result = await readDocument({
    documentId,
    bundle,
    provenance: 'unknown_external',
    jobId: null,
  });

  if (result.status === 'no_artifacts') {
    console.log('למסמך הזה אין חלקים מופקים. הרץ קודם את הקליטה.');
    return;
  }

  console.log(result.cached ? '--- קריאה שמורה ---' : '--- קריאה חדשה ---');
  if (result.status === 'read') {
    console.log(`\nסיכום:\n${result.reading.summary}`);
    console.log(`\nממצאים: ${result.reading.findings.length}`);
    for (const finding of result.reading.findings) {
      console.log(`  ${finding.label}: ${finding.value}  [חלק ${finding.sourceRef.ordinal}]`);
    }
    console.log('\nכוונות:');
    for (const intent of result.reading.intents) {
      console.log(`  ${intent.intent} → ${intent.subject.kind}  [חלק ${intent.sourceRef.ordinal}]`);
    }
    if (result.reading.unreadable.length > 0) {
      console.log(`\nלא נקבע: ${result.reading.unreadable.join(' · ')}`);
    }
  } else {
    console.log(`לא ניתן לקרוא: ${result.reason}`);
  }
  console.log(`\nמזהה קריאה: ${result.record.readingId}`);
}

try {
  await main();
} finally {
  await closePool();
}
```

- [ ] **Step 2: Add the npm script**

In `package.json`, inside `"scripts"`, after the `"sdk:know-reader"` line, add:

```json
    "sdk:read-document": "tsx scripts/read-document.ts",
```

- [ ] **Step 3: Verify the script's failure paths without a key**

Run: `npm run sdk:read-document`
Expected: prints the usage line and exits non-zero.

Run: `npm run sdk:read-document -- DOC-nonexistent`
Expected: with no `ANTHROPIC_API_KEY` set, prints the missing-key message and exits non-zero. Do **not** claim the live path works — it has not been run.

- [ ] **Step 4: Update `CLAUDE.md`**

Four edits:

1. In the commands block, after the `sdk:know-reader` line, add:

```
npm run sdk:read-document -- <documentId>  # קריאה חיה של מסמך שנקלט — דורש ANTHROPIC_API_KEY
```

2. Update the test count on the `npm test` line to the number `npm test` actually reports after this branch. Run it and read the number; do not estimate.

3. In "כללים שהקוד אוכף בשקט", add these three paragraphs:

```markdown
**כוונה שמה תוצאה, לעולם לא כלי.** `IntentName` ב-[src/domain/reading.ts](src/domain/reading.ts) הוא enum סגור של עשר תוצאות עסקיות — `reply_to_sender`, לא `mail.send`. קורא שנוקב בכלי הוא קורא שבוחר סמכות, ו-`know.reader` הוא סוכן הסגר שהקלט שלו עוין בהגדרה; המיפוי מכוונה לצעדים הוא עבודת המתכנן, שרואה את הקטלוג ואת התקנון. מבחן ב-`reading-invariants.test.ts` דוחה שם כוונה שמכיל נקודה — הצורה של מזהה כלי.

**כוונה אינה נושאת כתובת.** `EntityRef` הוא איחוד מובחן משלושה ענפים: ישות מוכרת, `sender` (שנפתר מרשומת ה-job ולא מהתוכן), או `unresolved` עם תיאור מילולי. **אין ענף שמקבל כתובת.** מסמך יכול לומר שצריך לפנות למישהו; הוא אינו יכול לומר לאן ההודעה תלך. `entityId` עובר דרך `SafeLookupKey` — אותו שומר שדוחה `__proto__` בתקנון, מיוצא ולא משוכפל, כי `JSON.parse` על תשובת מודל יוצר את המפתח הזה בדיוק כמו על מסמך חתום.

**`findings` הם ייעוץ, ואף מודול ב-`src/policy/` לא קורא אותם.** סכום שמודל קרא מחוזה, אילו הגיע ל-`readAmountMinor`, היה נותן למסמך לקבוע את התקרה של עצמו — הצורה המדויקת של הבאג שהתקרות קיימות כדי למנוע. הסריקה ב-[src/documents/reading-invariants.test.ts](src/documents/reading-invariants.test.ts) נועלת את זה, ומאשרת קודם שהיא מצאה קבצים לסרוק: סריקה ריקה שעוברת אינה בקרה.

**קריאה אינה ארטיפקט.** ארטיפקט הוא מה שחולץ מהקובץ דטרמיניסטית; קריאה היא טענה של מודל עליו, ולכן `document_readings` ולא `kind` רביעי ב-`document_artifacts`. באותה טבלה, קורא עתידי לא היה יכול להבחין בין מה שכתוב בקובץ לבין מה שמודל אמר עליו. המפתח כולל `brief_hash` ולא את ה-`sha256` של המסמך — שינוי בתקרת קיצוץ משנה את מה שנקרא בלי לשנות את הקובץ — ו-`prompt_version`, שהוא קבוע שמרימים ביד ולא גיבוב, כי גיבוב משתנה מפסיק ומוחק כל קריאה שמורה בזמן שהשאלה נשארה זהה.

**`markContentIngested` נדלק לפני הקריאה, וקריאה שמורה אינה מדליקה אותו.** `readDocument` ([src/documents/read.ts](src/documents/read.ts)) הוא הכותב השלישי של הדגל, אחרי `executeStep` ו-`gate-hook`. פגיעה במטמון לא קראה תוכן חיצוני, והדלקת הדגל עבורה הייתה מהדקת בקרה על סמך משהו שלא קרה.
```

4. In "מה עוד לא נבנה בשלב 0", remove "מרשם ה-intents" from the list and replace it with a line saying the registry now exists and what remains — that `PlanRequest.intents` is still typed `unknown` until sub-project ג' wires `Intent[]` into it.

- [ ] **Step 5: Update `docs/01-agents.md`**

In the `know.reader` entry, replace the description of its output. It no longer returns a summary as prose: it returns a validated `Reading` — summary, findings, and closed-vocabulary intents — and free text is not a legal output. State that its tool list is unchanged (`doc.fetch`, `memory.recall`) and that the structured output is validated on our side precisely so no tool had to be added.

- [ ] **Step 6: Update `docs/03-protocol.md`**

The intents-registry section describes something unbuilt. Replace it with the registry as built: the ten names, the rule that an intent names an outcome and never a tool, `EntityRef`'s three branches and the absent fourth, and `sourceRef`. Note explicitly that the **envelope protocol** is still not built — this task closes the intents half only.

- [ ] **Step 7: Update `docs/09-roadmap.md`**

Record what sub-project ב' closed and, in the same breath, what it did not: no cross-document retrieval (L3, `pgvector`, `know.memory` — all still unbuilt), no entity resolver, so `unresolved` intents cannot become outbound actions, and the ramp unchanged at `draft_only`. Add that comprehension quality is the first work in this project not measurable by a test.

- [ ] **Step 8: Verify every documentation claim**

For each file name, function name, and line reference you added to the docs, confirm it exists. Three separate fix waves in this project have shipped documentation citing a test file that did not exist and an error type that was never thrown. Run `npm test` and use its real number.

- [ ] **Step 9: Typecheck, full suite, and commit**

```bash
npm run typecheck && npm test
git add scripts/read-document.ts package.json CLAUDE.md docs/01-agents.md docs/03-protocol.md docs/09-roadmap.md
git commit -m "A live read script, and the docs that were made false by this branch

Three claims in CLAUDE.md stopped being true when the reader started
returning structured output: that nothing consumes document artefacts, that
intents have no defined shape, and that the registry is unbuilt.

The live script needs a key and costs money, so it is a script. A suite that
skips silently without a key reports green for work it did not do.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 — every read becomes a document; `runKnowReader` reshaped | Task 6 |
| §3 — the `Reading` schema, `.min(1)` intents, `SafeLookupKey`, string findings | Task 1 |
| §4 — the closed intent registry and `INTENT_MEANING` | Tasks 1, 5, 8 |
| §5 — `renderReadingBrief`, the three ceilings, graded truncation, prompt order | Tasks 2, 5 |
| §6 — the flow, `ReadOutcome`, unreadable stored not thrown | Tasks 6, 7 |
| §7 control 1 — closed enum | Task 1 |
| §7 control 2 — no raw address in an intent | Tasks 1, 5 |
| §7 control 3 — fabricated citation rejected | Task 3 |
| §7 control 4 — findings never reach the gate | Task 8 |
| §7 control 5 — summary is data | Task 5 (schema block), inherited from the planner having no tools |
| §7 control 6 — `markContentIngested` before the read | Task 7 |
| §7 control 7 — provenance stored, never raised | Tasks 4, 7 |
| §7 control 8 — no new tool for `know.reader` | Task 8 |
| §8 — migration, dedupe key, `brief_hash`, `prompt_version`, no `job_id` | Task 4 |
| §9 — the failure table | Tasks 3, 6, 7 |
| §10 — tests without a key; live run as a script | Tasks 1–8, Task 9 |
| §11 — what remains open | Task 9 |

**Gap found and closed:** §2's claim that a mail body is ingested as a document has no task of its own. That is correct — `ingestDocument` already accepts `source: 'mail'` and `text/plain`, and the passthrough extractor already handles it, so no code is needed. The rule binds future callers; it is recorded in the docs in Task 9 rather than implemented.

**Type consistency:** `ReadOutcome` is defined once (Task 6) and consumed by Task 7. `ReadingRecord`/`NewReading` are defined once (Task 4) and consumed by Task 7. `ParseOutcome` (Task 3) is internal to `reading-parse.ts` and `know-reader.ts`. `READING_PROMPT_VERSION` is defined in Task 5 and read by Tasks 7 and 4's tests. `renderReadingBrief` takes `readonly DocumentArtifact[]` in Task 2 and is called with that type in Tasks 6 and 7. `IntentName`/`INTENT_MEANING` are defined in Task 1 and read in Tasks 5 and 8.

**One ordering note for the executor:** Task 6 changes `runKnowReader`'s signature, so `src/sdk/know-reader.test.ts` and any other existing caller will fail to compile until that task's Step 6 repairs them. Do not start Task 7 with Task 6's suite red.
