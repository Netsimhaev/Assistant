# The Conductor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive a document from a watched folder to a proposal card in front of the owner, with no human typing a command in between.

**Architecture:** Two loops inside the existing `schedulerPass`. Loop A scans a folder and ingests files — cheap, deterministic, no model calls. Loop B picks up ingested-but-unread documents, opens a job stamped `unknown_external`, reads, proposes, and raises an approval **itself** rather than routing through the gate — because stage 8 of the gate denies every outbound class at the ramp floor and would produce zero cards. A read-only screen shows readings whose proposal carried no action.

**Tech Stack:** TypeScript (NodeNext ESM), Postgres 17 via `pg`, zod, vitest against a real database.

**Spec:** [docs/superpowers/specs/2026-09-07-document-conductor-design.md](../specs/2026-09-07-document-conductor-design.md)

## Global Constraints

- `.js` extension on every relative import, including from `.ts` files (NodeNext + `"type": "module"`).
- `import type` for type-only imports (`verbatimModuleSyntax`).
- Conditional spread for optional properties: `opts.db !== undefined ? { db: opts.db } : {}` (`exactOptionalPropertyTypes`).
- `rows[0]?.x` — never `rows[0].x` (`noUncheckedIndexedAccess`).
- Hebrew for anything the owner reads; English for identifiers, comments, and audit reasons.
- Every module reading DB rows: a private `interface XRow` plus a `toX(row)` function. SQL `snake_case`, TS `camelCase`.
- A test that still passes when the code it covers is deleted is not a test. Every negative assertion must also prove the covered code actually ran.
- Tests need a real Postgres. Never run the full `npm test` while another run is active — a `tx.query` failure inside `withTransaction`, a row that comes back `undefined` right after being written, or a duplicate-key violation you did not cause is a collision: re-run and say you did.
- Job provenance for anything the conductor opens is `unknown_external`, always, and must not be expressible as a caller-supplied value.

---

### Task 1: Migration, config, and the two document queries

**Files:**
- Create: `src/db/migrations/021_document_read_attempts.sql`
- Modify: `src/config.ts`
- Modify: `src/documents/store.ts`
- Modify: `.env.example`
- Test: `src/documents/conductor-queries.test.ts`

**Interfaces:**
- Consumes: `documents` table (migration 012), `document_readings` (013).
- Produces:
  - `documentsAwaitingRead(limit: number, options?: { businessId?: string; db?: Queryable }): Promise<DocumentRecord[]>`
  - `recordReadFailure(documentId: string, message: string, options?: { businessId?: string; db?: Queryable }): Promise<void>`
  - `readingsToday(options?: { businessId?: string; db?: Queryable }): Promise<number>`
  - `config.documentInbox: string | null`, `config.documentReadsPerDay: number`

- [ ] **Step 1: Write the migration**

```sql
-- 021_document_read_attempts.sql
--
-- The conductor needs somewhere to count failed understanding attempts.
--
-- These two columns belong to the conductor and deliberately do NOT touch
-- `status`, whose CHECK constraint names exactly three values (pending,
-- extracted, rejected) and describes what happened during *ingest*. A failed
-- model read is not an ingest outcome, and widening that constraint to say so
-- would blur the one column that answers "did we get bytes out of this file".

ALTER TABLE documents
    ADD COLUMN read_attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN read_error    TEXT;

COMMENT ON COLUMN documents.read_attempts IS
    'Conductor understanding attempts. At 3 the document stops being selected.';
COMMENT ON COLUMN documents.read_error IS
    'Last failure message from the conductor. Null when none.';
```

- [ ] **Step 2: Run the migration on both databases**

```bash
npm run migrate
npm run migrate:test
```

- [ ] **Step 3: Add the two config values**

In `src/config.ts`, beside the existing `required()` helper, add:

```ts
/**
 * Absent means off, never a permissive default.
 *
 * `DOCUMENT_INBOX` unset is how an installation says "do not watch a folder".
 * The scheduler reports it once and carries on, exactly as `buildRuntime`
 * treats absent SMTP settings — a missing setting is a switch, not a fault.
 */
function optional(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer (got: ${raw})`);
  }
  return parsed;
}
```

and in the exported config object:

```ts
  documentInbox: optional('DOCUMENT_INBOX'),
  documentReadsPerDay: positiveInt('DOCUMENT_READS_PER_DAY', 20),
```

Add to `.env.example`:

```
# תיקייה שהמערכת סורקת. ריק או חסר = הסריקה כבויה.
DOCUMENT_INBOX=
# כמה מסמכים מותר להבין ביום. קריאה מהמטמון אינה נספרת.
DOCUMENT_READS_PER_DAY=20
```

- [ ] **Step 4: Write the failing tests**

Create `src/documents/conductor-queries.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  documentsAwaitingRead,
  readingsToday,
  recordReadFailure,
} from './store.js';
import { ingestDocument } from './ingest.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUSINESS = 'biz-conductor';

async function anExtractedDocument(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cond-'));
  const path = join(dir, 'note.txt');
  await writeFile(path, text, 'utf8');
  const doc = await ingestDocument(
    { path, source: 'manual' },
    { businessId: BUSINESS, documentRoot: dir },
  );
  expect(doc.status, 'fixture must produce an extracted document').toBe('extracted');
  return doc.documentId;
}

describe('the conductor queries', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('offers an extracted document that has never been read', async () => {
    const documentId = await anExtractedDocument('שלום');
    const waiting = await documentsAwaitingRead(10, { businessId: BUSINESS });
    expect(waiting.map((d) => d.documentId)).toEqual([documentId]);
  });

  it('stops offering a document once it has a reading', async () => {
    const documentId = await anExtractedDocument('שלום');
    await getPool().query(
      `INSERT INTO document_readings
         (reading_id, business_id, document_id, brief_hash, prompt_version, provenance, reading, raw)
       VALUES ('RD-1', $1, $2, 'h', 'v1', 'unknown_external', '{}'::jsonb, '')`,
      [BUSINESS, documentId],
    );
    const waiting = await documentsAwaitingRead(10, { businessId: BUSINESS });
    expect(waiting).toEqual([]);
  });

  it('stops offering a document after three failures', async () => {
    const documentId = await anExtractedDocument('שלום');
    for (let i = 0; i < 3; i += 1) {
      await recordReadFailure(documentId, `boom ${i}`, { businessId: BUSINESS });
    }
    expect(await documentsAwaitingRead(10, { businessId: BUSINESS })).toEqual([]);

    const { rows } = await getPool().query<{ read_attempts: number; read_error: string }>(
      `SELECT read_attempts, read_error FROM documents WHERE document_id = $1`,
      [documentId],
    );
    expect(rows[0]?.read_attempts).toBe(3);
    expect(rows[0]?.read_error).toBe('boom 2');
  });

  it('still offers a document after two failures', async () => {
    const documentId = await anExtractedDocument('שלום');
    await recordReadFailure(documentId, 'once', { businessId: BUSINESS });
    await recordReadFailure(documentId, 'twice', { businessId: BUSINESS });
    const waiting = await documentsAwaitingRead(10, { businessId: BUSINESS });
    expect(waiting.map((d) => d.documentId)).toEqual([documentId]);
  });

  it('never offers another business\'s document', async () => {
    await anExtractedDocument('שלום');
    expect(await documentsAwaitingRead(10, { businessId: 'someone-else' })).toEqual([]);
  });

  it('counts only readings created today, for this business', async () => {
    const documentId = await anExtractedDocument('שלום');
    await getPool().query(
      `INSERT INTO document_readings
         (reading_id, business_id, document_id, brief_hash, prompt_version, provenance, reading, raw, created_at)
       VALUES
         ('RD-today', $1, $2, 'h1', 'v1', 'unknown_external', '{}'::jsonb, '', now()),
         ('RD-old',   $1, $2, 'h2', 'v1', 'unknown_external', '{}'::jsonb, '', now() - interval '2 days'),
         ('RD-other', 'other-biz', $2, 'h3', 'v1', 'unknown_external', '{}'::jsonb, '', now())`,
      [BUSINESS, documentId],
    );
    expect(await readingsToday({ businessId: BUSINESS })).toBe(1);
  });
});
```

- [ ] **Step 5: Run the tests and watch them fail**

Run: `npx vitest run src/documents/conductor-queries.test.ts`
Expected: FAIL — `documentsAwaitingRead is not a function`.

- [ ] **Step 6: Implement the three queries**

Append to `src/documents/store.ts` (it already exports `loadDocument` and a `toDocument(row)`; reuse them):

```ts
/** Understanding attempts before a document stops being selected. */
export const MAX_READ_ATTEMPTS = 3;

/**
 * Documents that have bytes and no reading yet.
 *
 * "Has a reading" is the completion marker rather than a column of our own:
 * a reading row is the thing the conductor exists to produce, so its presence
 * is the fact, not a flag that could disagree with it.
 *
 * Provenance is deliberately NOT in the NOT EXISTS. A document read once under
 * any trust level has been through the pipeline; re-reading it under a second
 * provenance is a different question than this loop asks, and would spend money
 * on a document the owner has already been told about.
 */
export async function documentsAwaitingRead(
  limit: number,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<DocumentRecord[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<DocumentRow>(
    `SELECT d.* FROM documents d
      WHERE d.business_id = $1
        AND d.status = 'extracted'
        AND d.read_attempts < $2
        AND NOT EXISTS (
              SELECT 1 FROM document_readings r
               WHERE r.document_id = d.document_id
                 AND r.business_id = d.business_id
            )
      ORDER BY d.created_at ASC, d.document_id ASC
      LIMIT $3`,
    [businessId, MAX_READ_ATTEMPTS, limit],
  );
  return rows.map(toDocument);
}

/**
 * Record one failed understanding attempt.
 *
 * A no-op when the id does not resolve for this business, rather than a throw:
 * the caller is a scheduler loop recording why something did not work, and a
 * failure to record a failure must not become a second, louder failure.
 */
export async function recordReadFailure(
  documentId: string,
  message: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  await db.query(
    `UPDATE documents
        SET read_attempts = read_attempts + 1,
            read_error = $3
      WHERE document_id = $1 AND business_id = $2`,
    [documentId, businessId, message.slice(0, 2000)],
  );
}

/**
 * Readings written today, which is what the daily ceiling measures.
 *
 * Counting rows rather than keeping a counter means there is nothing to reset
 * and nothing that can drift. And because a cache hit writes no row, a read
 * that cost no money is not counted — the measure matches the thing the
 * ceiling is meant to bound.
 */
export async function readingsToday(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<number> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM document_readings
      WHERE business_id = $1 AND created_at >= date_trunc('day', now())`,
    [businessId],
  );
  return Number(rows[0]?.n ?? '0');
}
```

Add `read_attempts: number` and `read_error: string | null` to the private `DocumentRow` interface and to `DocumentRecord` (as `readAttempts` / `readError`), and map them in `toDocument`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/documents/conductor-queries.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Prove the business scoping bites**

Delete `AND d.business_id = $1` from `documentsAwaitingRead`, re-run, confirm `never offers another business's document` fails, restore it. Redirect both runs to `task-1-mut-fail.txt` and `task-1-mut-pass.txt` with `2>&1`.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add -A && git commit -m "The conductor's three questions of the documents table"
```

---

### Task 2: The folder scan

**Files:**
- Create: `src/orchestrator/inbox-scan.ts`
- Test: `src/orchestrator/inbox-scan.test.ts`

**Interfaces:**
- Consumes: `ingestDocument(input: IngestInput, options: IngestOptions): Promise<DocumentRecord>` from `src/documents/ingest.js`. `IngestInput` is `{ path: string; source: DocumentSource; originalName?: string }`. `DocumentRecord.status` is `'pending' | 'extracted' | 'rejected'`.
- Produces: `scanInbox(options: ScanInboxOptions): Promise<ScanResult>` where
  `ScanInboxOptions = { inbox: string; businessId?: string; documentRoot?: string }` and
  `ScanResult = { ingested: number; rejected: number; skipped: number }`.

- [ ] **Step 1: Write the failing tests**

Create `src/orchestrator/inbox-scan.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { scanInbox } from './inbox-scan.js';

const BUSINESS = 'biz-scan';

async function anInbox(): Promise<{ inbox: string; documentRoot: string }> {
  const inbox = await mkdtemp(join(tmpdir(), 'inbox-'));
  const documentRoot = await mkdtemp(join(tmpdir(), 'docroot-'));
  return { inbox, documentRoot };
}

describe('scanInbox', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('ingests a file and moves it to processed', async () => {
    const { inbox, documentRoot } = await anInbox();
    await writeFile(join(inbox, 'hello.txt'), 'שלום עולם', 'utf8');

    const result = await scanInbox({ inbox, businessId: BUSINESS, documentRoot });

    expect(result.ingested).toBe(1);
    expect(await readdir(join(inbox, 'processed'))).toEqual(['hello.txt']);
    expect(await readdir(inbox)).not.toContain('hello.txt');

    const { rows } = await getPool().query<{ original_name: string }>(
      `SELECT original_name FROM documents WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows.map((r) => r.original_name)).toEqual(['hello.txt']);
  });

  it('moves a rejected file to rejected and still counts it', async () => {
    const { inbox, documentRoot } = await anInbox();
    // A .xlsx name over bytes that are not a zip: sniffed as text, never sent
    // to the Excel decoder, and rejected by ingest as a mismatch it will not
    // guess about.
    await writeFile(join(inbox, 'bad.xlsx'), 'not a spreadsheet', 'utf8');

    const result = await scanInbox({ inbox, businessId: BUSINESS, documentRoot });

    expect(result.ingested + result.rejected).toBe(1);
    const processed = await readdir(join(inbox, 'processed'));
    const rejected = await readdir(join(inbox, 'rejected'));
    expect(processed.length + rejected.length).toBe(1);
  });

  it('leaves the subdirectories themselves alone', async () => {
    const { inbox, documentRoot } = await anInbox();
    await writeFile(join(inbox, 'a.txt'), 'א', 'utf8');
    await scanInbox({ inbox, businessId: BUSINESS, documentRoot });
    await writeFile(join(inbox, 'b.txt'), 'ב', 'utf8');

    const result = await scanInbox({ inbox, businessId: BUSINESS, documentRoot });

    expect(result.ingested, 'the second pass must not re-ingest a.txt').toBe(1);
    expect((await readdir(join(inbox, 'processed'))).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('does not collide when the same name arrives twice', async () => {
    const { inbox, documentRoot } = await anInbox();
    await writeFile(join(inbox, 'same.txt'), 'ראשון', 'utf8');
    await scanInbox({ inbox, businessId: BUSINESS, documentRoot });
    await writeFile(join(inbox, 'same.txt'), 'שני', 'utf8');

    await scanInbox({ inbox, businessId: BUSINESS, documentRoot });

    const processed = await readdir(join(inbox, 'processed'));
    expect(processed).toHaveLength(2);
    expect(processed).toContain('same.txt');
  });

  it('creates its subdirectories on a bare folder', async () => {
    const { inbox, documentRoot } = await anInbox();
    const result = await scanInbox({ inbox, businessId: BUSINESS, documentRoot });
    expect(result).toEqual({ ingested: 0, rejected: 0, skipped: 0 });
    expect((await readdir(inbox)).sort()).toEqual(['processed', 'rejected', 'working']);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/orchestrator/inbox-scan.test.ts`
Expected: FAIL — cannot find module `./inbox-scan.js`.

- [ ] **Step 3: Implement `scanInbox`**

Create `src/orchestrator/inbox-scan.ts`:

```ts
/**
 * Loop A — the folder scan. No model calls, no money, no judgement.
 *
 * Deliberately separate from the understanding loop (`conduct.ts`). This half
 * is cheap and deterministic; that half is expensive and not. Keeping them
 * apart means the daily ceiling applies only to what actually costs, and a
 * model outage still lets files enter the system.
 */
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ingestDocument } from '../documents/ingest.js';

export interface ScanInboxOptions {
  inbox: string;
  businessId?: string;
  documentRoot?: string;
}

export interface ScanResult {
  ingested: number;
  rejected: number;
  /** Files that could not be claimed this pass — almost always still being written. */
  skipped: number;
}

const WORKING = 'working';
const PROCESSED = 'processed';
const REJECTED = 'rejected';
const SUBDIRS = [WORKING, PROCESSED, REJECTED];

/**
 * Move `from` to `dir`, without ever overwriting what is already there.
 *
 * Two different files may legitimately share a name — the owner saves
 * "חוזה.docx" twice a month — and the folder is the owner's own record of what
 * happened. Silently replacing one with the other destroys that record.
 */
async function moveWithoutClobber(from: string, dir: string, name: string): Promise<void> {
  const ext = extname(name);
  const stem = ext === '' ? name : name.slice(0, -ext.length);
  for (let n = 0; ; n += 1) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    const target = join(dir, candidate);
    try {
      await stat(target);
      continue; // taken; try the next suffix
    } catch {
      await rename(from, target);
      return;
    }
  }
}

/**
 * Ingest every file sitting in the inbox root.
 *
 * **Claiming is the write-in-progress check.** A file still open for writing
 * cannot be renamed, so the attempt to move it into `working/` doubles as the
 * test for whether it is finished. A separate "is it still being written"
 * check would be a check with a gap after it: the file could be complete when
 * asked and half-written when read.
 */
export async function scanInbox(options: ScanInboxOptions): Promise<ScanResult> {
  const { inbox } = options;
  const scope = {
    ...(options.businessId !== undefined ? { businessId: options.businessId } : {}),
    ...(options.documentRoot !== undefined ? { documentRoot: options.documentRoot } : {}),
  };

  for (const sub of SUBDIRS) {
    await mkdir(join(inbox, sub), { recursive: true });
  }

  const entries = await readdir(inbox, { withFileTypes: true });
  const result: ScanResult = { ingested: 0, rejected: 0, skipped: 0 };

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const name = basename(entry.name);
    const claimed = join(inbox, WORKING, name);

    try {
      await rename(join(inbox, name), claimed);
    } catch {
      result.skipped += 1;
      continue;
    }

    // One bad document must not stop the batch — the same rule `ingestDocument`
    // already keeps internally for a hostile file.
    try {
      const document = await ingestDocument(
        { path: claimed, source: 'manual', originalName: name },
        scope,
      );
      if (document.status === 'rejected') {
        await moveWithoutClobber(claimed, join(inbox, REJECTED), name);
        result.rejected += 1;
      } else {
        await moveWithoutClobber(claimed, join(inbox, PROCESSED), name);
        result.ingested += 1;
      }
    } catch {
      await moveWithoutClobber(claimed, join(inbox, REJECTED), name);
      result.rejected += 1;
    }
  }

  return result;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/orchestrator/inbox-scan.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Prove the claim step bites**

Replace the `rename` into `working/` with a plain `stat` (so nothing is claimed) and confirm `leaves the subdirectories themselves alone` fails — the second pass re-ingests `a.txt`. Restore. Redirect to `task-2-mut-fail.txt` / `task-2-mut-pass.txt`.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add -A && git commit -m "Loop A: claim a file by moving it, then ingest"
```

---

### Task 3: Raising the proposal's own approval

**Files:**
- Create: `src/orchestrator/proposal-approval.ts`
- Test: `src/orchestrator/proposal-approval.test.ts`

**Interfaces:**
- Consumes:
  - `buildFacts(toolName: string, toolInput: unknown, ctx: FactsContext): ActionFacts` from `src/policy/facts.js`; `FactsContext = { provenance: TrustLevel; chainDepth: number; counterpartyTags: string[]; provenanceChainDerived?: boolean }`.
  - `assessRisk(facts: ActionFacts, bundle: PolicyBundle, options?): Promise<RiskAssessment>` from `src/policy/risk.js`.
  - `enqueueApproval(input: EnqueueInput, options?): Promise<string>` from `src/governance/approvals.js`; `EnqueueInput = { jobId?: string | null; facts: ActionFacts; risk: RiskAssessment; proposedInput: unknown; summary: string; detail?: string; ... }`.
  - `proposalToApprovalText(proposal: Proposal): { headline: string; detail: string } | null` from `src/orchestrator/proposal-to-plan.js`.
- Produces: `raiseProposalApproval(input: RaiseInput, options?: { businessId?: string; db?: Queryable }): Promise<string | null>` — the approval id, or `null` when the proposal carries no action.

- [ ] **Step 1: Write the failing tests**

Create `src/orchestrator/proposal-approval.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { raiseProposalApproval, RAMP_HONESTY } from './proposal-approval.js';
import type { Proposal } from '../domain/proposal.js';

const BUSINESS = 'biz-raise';

function aProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    headline: 'קראתי את החוזה',
    stance: 'act',
    reasons: [{ text: 'המחיר תואם למה שסוכם', findingLabel: 'מחיר' }],
    action: {
      headline: 'אשלח מייל לדנה לאשר את המועד',
      purpose: 'לאשר את מועד ההתקנה',
      agent: 'comms.email',
      intent: 'reply_to_sender',
      toolName: 'mail.send',
      expectedActionClass: 'email.initiate',
      input: { to: 'dana@example.com', subject: 'אישור מועד', body: 'מאשר' },
    },
    ...over,
  } as Proposal;
}

describe('raiseProposalApproval', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('raises a pending approval carrying the action headline', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const approvalId = await raiseProposalApproval(
      { jobId: null, proposal: aProposal(), bundle },
      { businessId: BUSINESS },
    );

    expect(approvalId).not.toBeNull();
    const { rows } = await getPool().query<{ state: string; summary: string; detail: string }>(
      `SELECT state, summary, detail FROM approval_requests WHERE approval_id = $1`,
      [approvalId],
    );
    expect(rows[0]?.state).toBe('pending');
    expect(rows[0]?.summary).toBe('אשלח מייל לדנה לאשר את המועד');
  });

  it('says plainly that approving will not make it happen', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const approvalId = await raiseProposalApproval(
      { jobId: null, proposal: aProposal(), bundle },
      { businessId: BUSINESS },
    );
    const { rows } = await getPool().query<{ detail: string }>(
      `SELECT detail FROM approval_requests WHERE approval_id = $1`,
      [approvalId],
    );
    expect(rows[0]?.detail).toContain(RAMP_HONESTY);
  });

  it('returns null and writes nothing when the proposal carries no action', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const approvalId = await raiseProposalApproval(
      {
        jobId: null,
        proposal: aProposal({ stance: 'no_action', action: null }),
        bundle,
      },
      { businessId: BUSINESS },
    );

    expect(approvalId).toBeNull();
    const { rows } = await getPool().query(`SELECT 1 FROM approval_requests`);
    expect(rows).toHaveLength(0);
  });

  it('returns null for a read-only action rather than throwing', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const proposal = aProposal();
    const readOnly = {
      ...proposal,
      action: { ...proposal.action!, toolName: 'crm.read', expectedActionClass: null },
    } as Proposal;

    const approvalId = await raiseProposalApproval(
      { jobId: null, proposal: readOnly, bundle },
      { businessId: BUSINESS },
    );

    expect(approvalId).toBeNull();
    const { rows } = await getPool().query(`SELECT 1 FROM approval_requests`);
    expect(rows).toHaveLength(0);
  });

  it('stamps the facts as external and not chain-derived', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const approvalId = await raiseProposalApproval(
      { jobId: null, proposal: aProposal(), bundle },
      { businessId: BUSINESS },
    );
    const { rows } = await getPool().query<{ risk: { band: string } }>(
      `SELECT risk FROM approval_requests WHERE approval_id = $1`,
      [approvalId],
    );
    // An external first contact never scores `routine`; if it did, the
    // provenance stamp did not reach the risk engine.
    expect(rows[0]?.risk.band).not.toBe('routine');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/orchestrator/proposal-approval.test.ts`
Expected: FAIL — cannot find module `./proposal-approval.js`.

- [ ] **Step 3: Implement it**

Create `src/orchestrator/proposal-approval.ts`:

```ts
/**
 * Turn a proposal into the question the owner actually answers.
 *
 * **Why this exists rather than routing through the gate.** An approval is
 * created only when `evaluateToolCall` reaches stage 10. Stage 8 sits in front
 * of it and refuses every outbound class while its ramp level is `draft_only`
 * — which is every class, since `RAMP_FLOOR` is the floor and no production
 * caller raises it. Routing the conductor's proposals through the gate would
 * therefore produce exactly zero cards. See §3 of the spec.
 *
 * The separation is not a workaround. "Do you want this to happen?" is a
 * question for a person and "may this tool run right now?" is a question for
 * the gate, and the system had merged them. This module asks only the first.
 * The gate still answers the second, unchanged, if the plan ever runs.
 *
 * **What this must never do:** grant authority. The approval it writes carries
 * the proposal's words and the proposed payload. It does not set a ramp level,
 * does not write a `job_authorizations` row, and does not mark anything as
 * boss-provenance. `conductor-invariants.test.ts` holds all three.
 */
import type { Queryable } from '../db/pool.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { Proposal } from '../domain/proposal.js';
import { enqueueApproval } from '../governance/approvals.js';
import { buildFacts } from '../policy/facts.js';
import { assessRisk } from '../policy/risk.js';
import { proposalToApprovalText } from './proposal-to-plan.js';

/**
 * Said on every card the conductor raises.
 *
 * Approving does not execute: the ramp holds every outbound class in draft.
 * "I approved it and nothing happened" is indistinguishable from a broken
 * system unless it was said in advance, so it is said in advance.
 */
export const RAMP_HONESTY =
  'אישור כאן מתעד את החלטתך ואינו מבצע את הפעולה — כל פעולה יוצאת מוחזקת כרגע במצב טיוטה.';

export interface RaiseInput {
  jobId: string | null;
  proposal: Proposal;
  bundle: PolicyBundle;
}

export async function raiseProposalApproval(
  input: RaiseInput,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<string | null> {
  const { proposal } = input;
  const text = proposalToApprovalText(proposal);
  // No action means no approval: there is nothing to title and nothing to
  // approve. The reading still reaches the owner through the readings screen.
  if (text === null || proposal.action === null) return null;

  const facts = buildFacts(proposal.action.toolName, proposal.action.input, {
    // The conductor only ever handles documents that arrived from outside.
    // Not a parameter: a caller able to ask for `boss` here would be a caller
    // able to buy the standing-authorisation and first-contact exemptions for
    // a document a stranger wrote.
    provenance: 'unknown_external',
    chainDepth: 1,
    // No resolver exists. Written on purpose rather than omitted — see
    // `FactsContext.counterpartyTags`.
    counterpartyTags: [],
    // Never true here: the chain read a document from outside, which is the
    // exact condition that disqualifies the exemption.
    provenanceChainDerived: false,
  });

  // A read-only tool has no action class, and both `assessRisk` and
  // `enqueueApproval` refuse one. That is a proposal to look something up, not
  // to do something — it belongs on the readings screen, not on a card.
  if (facts.actionClass === null) return null;

  const risk = await assessRisk(facts, input.bundle);

  return enqueueApproval(
    {
      jobId: input.jobId,
      facts,
      risk,
      proposedInput: proposal.action.input,
      summary: text.headline,
      detail: `${text.detail}\n\n${RAMP_HONESTY}`,
    },
    options,
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/orchestrator/proposal-approval.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Prove the provenance stamp bites**

Change `provenance: 'unknown_external'` to `'boss'`, re-run, confirm `stamps the facts as external and not chain-derived` fails. Restore. Redirect to `task-3-mut-fail.txt` / `task-3-mut-pass.txt`.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add -A && git commit -m "A proposal raises its own approval, because the gate never would"
```

---

### Task 4: The understanding loop

**Files:**
- Create: `src/orchestrator/conduct.ts`
- Test: `src/orchestrator/conduct.test.ts`

**Interfaces:**
- Consumes:
  - `documentsAwaitingRead`, `recordReadFailure`, `readingsToday` (Task 1)
  - `raiseProposalApproval` (Task 3)
  - `createJob(input: CreateJobInput): Promise<Job>` — `{ charterVersion, provenance, title?, businessId? }`
  - `transition(jobId, { to, actor, reason, businessId })` from `src/orchestrator/jobs.js`
  - `readDocument(input: ReadDocumentInput, options?: ReadDocumentOptions): Promise<ReadDocumentResult>` — result status is `'read' | 'unreadable' | 'no_artifacts'`; options carry the injectable `reader`
  - `proposeForReading(input, options?): Promise<ProposeResult>` — status `'proposed' | 'unproposable' | 'no_reading'`; options carry the injectable `proposer`
  - `loadActiveCharter(businessId): Promise<ActiveCharter | null>` — `{ charter, bundle }`
- Produces: `conductPendingDocuments(options: ConductOptions): Promise<ConductResult>` where
  `ConductResult = { considered: number; carded: number; readOnly: number; failed: number; ceilingReached: boolean }`.

- [ ] **Step 1: Write the failing tests**

Create `src/orchestrator/conduct.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
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

const READING: Reading = {
  summary: 'חוזה שיווק עם ספק',
  findings: [{ label: 'מחיר', text: 'המחיר 4,000 ש"ח', sourceRef: { ordinal: 0 } }],
  intents: [{ name: 'reply_to_sender', entity: { kind: 'sender' }, note: 'לאשר קבלה' }],
} as Reading;

const ACTING: Proposal = {
  headline: 'קראתי את החוזה',
  stance: 'act',
  reasons: [{ text: 'המחיר תואם', findingLabel: 'מחיר' }],
  action: {
    headline: 'אשלח מייל לדנה',
    purpose: 'לאשר קבלה',
    agent: 'comms.email',
    intent: 'reply_to_sender',
    toolName: 'mail.send',
    expectedActionClass: 'email.initiate',
    input: { to: 'dana@example.com', subject: 'התקבל', body: 'תודה' },
  },
} as Proposal;

const PASSIVE: Proposal = {
  headline: 'אני נגד חתימה',
  stance: 'advise_against',
  reasons: [{ text: 'המחיר שונה ממה שסוכם', findingLabel: 'מחיר' }],
  action: null,
} as Proposal;

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

function deps(proposal: Proposal = ACTING) {
  const calls = { reads: 0, proposals: 0 };
  return {
    calls,
    reader: async () => {
      calls.reads += 1;
      return { status: 'read' as const, reading: READING, raw: '{}' };
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
    });

    expect(result.ceilingReached).toBe(true);
    expect(d.calls.reads, 'the second document must not be read').toBe(1);
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM document_readings WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows[0]?.n).toBe('1');
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
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/orchestrator/conduct.test.ts`
Expected: FAIL — cannot find module `./conduct.js`.

- [ ] **Step 3: Implement it**

Create `src/orchestrator/conduct.ts`:

```ts
/**
 * Loop B — understanding. This is the half that costs money.
 *
 * One job per document, walked through the phases for real
 * (`intake → understand → plan → await_approval`) so the audit trail describes
 * a history that happened. A job left in `intake` with a reading and a proposal
 * hanging off it would describe one that did not.
 *
 * Failure is per document, never per batch: one document that cannot be read
 * must not stop the ones behind it, which is the rule `ingestDocument` already
 * keeps for a hostile file.
 */
import { config } from '../config.js';
import { loadActiveCharter } from '../charter/store.js';
import { readDocument, type ReadDocumentOptions } from '../documents/read.js';
import {
  documentsAwaitingRead,
  readingsToday,
  recordReadFailure,
} from '../documents/store.js';
import { createJob, transition } from './jobs.js';
import { proposeForReading, type ProposeForReadingOptions } from './propose.js';
import { raiseProposalApproval } from './proposal-approval.js';

export interface ConductOptions {
  businessId?: string;
  /** Defaults to `config.documentReadsPerDay`. */
  readsPerDay?: number;
  /** Most documents to consider in one pass, regardless of the daily ceiling. */
  limit?: number;
  reader?: ReadDocumentOptions['reader'];
  proposer?: ProposeForReadingOptions['proposer'];
}

export interface ConductResult {
  considered: number;
  /** Proposals that carried an action and produced a pending card. */
  carded: number;
  /** Proposals with no action — stored, and visible only on the readings screen. */
  readOnly: number;
  failed: number;
  ceilingReached: boolean;
}

export async function conductPendingDocuments(
  options: ConductOptions = {},
): Promise<ConductResult> {
  const businessId = options.businessId ?? config.businessId;
  const readsPerDay = options.readsPerDay ?? config.documentReadsPerDay;
  const limit = options.limit ?? 10;

  const result: ConductResult = {
    considered: 0,
    carded: 0,
    readOnly: 0,
    failed: 0,
    ceilingReached: false,
  };

  // No charter, no reasoning: the bundle is what the proposer's catalogue and
  // the risk engine's ceilings are both derived from. `evaluateToolCall`
  // treats an absent charter as fatal for the same reason.
  const active = await loadActiveCharter(businessId);
  if (active === null) return result;

  const alreadyToday = await readingsToday({ businessId });
  let remaining = readsPerDay - alreadyToday;
  if (remaining <= 0) {
    result.ceilingReached = true;
    return result;
  }

  const waiting = await documentsAwaitingRead(limit, { businessId });

  for (const document of waiting) {
    if (remaining <= 0) {
      result.ceilingReached = true;
      break;
    }
    result.considered += 1;
    remaining -= 1;

    try {
      const job = await createJob({
        charterVersion: active.charter.charterVersion,
        // Not a parameter, and not derived from anything a document says.
        provenance: 'unknown_external',
        businessId,
        title: `מסמך: ${document.originalName}`,
      });

      await transition(job.jobId, {
        to: 'understand',
        actor: 'orchestrator',
        reason: 'conductor: reading an ingested document',
        businessId,
      });

      const read = await readDocument(
        {
          documentId: document.documentId,
          jobId: job.jobId,
          provenance: 'unknown_external',
          bundle: active.bundle,
        },
        {
          businessId,
          ...(options.reader !== undefined ? { reader: options.reader } : {}),
        },
      );

      if (read.status !== 'read') {
        await recordReadFailure(document.documentId, `read: ${read.status}`, { businessId });
        await transition(job.jobId, {
          to: 'failed',
          actor: 'orchestrator',
          reason: `conductor: ${read.status}`,
          businessId,
        });
        result.failed += 1;
        continue;
      }

      await transition(job.jobId, {
        to: 'plan',
        actor: 'orchestrator',
        reason: 'conductor: proposing from the reading',
        businessId,
      });

      const proposed = await proposeForReading(
        { documentId: document.documentId, jobId: job.jobId, bundle: active.bundle },
        {
          businessId,
          ...(options.proposer !== undefined ? { proposer: options.proposer } : {}),
        },
      );

      if (proposed.status !== 'proposed') {
        await recordReadFailure(document.documentId, `propose: ${proposed.status}`, {
          businessId,
        });
        await transition(job.jobId, {
          to: 'failed',
          actor: 'orchestrator',
          reason: `conductor: ${proposed.status}`,
          businessId,
        });
        result.failed += 1;
        continue;
      }

      const approvalId = await raiseProposalApproval(
        { jobId: job.jobId, proposal: proposed.proposal, bundle: active.bundle },
        { businessId },
      );

      if (approvalId === null) {
        // A stance with nothing to approve. The proposal is stored and the
        // owner sees it on the readings screen; the job has nowhere further
        // to go, so it closes rather than sitting in `plan` forever.
        await transition(job.jobId, {
          to: 'closed',
          actor: 'orchestrator',
          reason: 'conductor: proposal carries no action',
          businessId,
        });
        result.readOnly += 1;
        continue;
      }

      await transition(job.jobId, {
        to: 'await_approval',
        actor: 'orchestrator',
        reason: `conductor: ${approvalId}`,
        businessId,
      });
      result.carded += 1;
    } catch (err) {
      // Per document, never per batch.
      const message = err instanceof Error ? err.message : String(err);
      await recordReadFailure(document.documentId, message, { businessId });
      result.failed += 1;
    }
  }

  return result;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/orchestrator/conduct.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Prove the ceiling bites**

Remove the `if (remaining <= 0)` check inside the loop, re-run, confirm `stops at the daily ceiling` fails on the read count. Restore. Redirect to `task-4-mut-fail.txt` / `task-4-mut-pass.txt`.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add -A && git commit -m "Loop B: a document becomes a job, a reading, a proposal and a card"
```

---

### Task 5: Wire both loops into the scheduler

**Files:**
- Modify: `src/orchestrator/scheduler.ts`
- Test: `src/orchestrator/scheduler-conducts.test.ts`

**Interfaces:**
- Consumes: `scanInbox` (Task 2), `conductPendingDocuments` (Task 4).
- Produces: `SchedulerPassResult` gains `scan: ScanResult | null` and `conduct: ConductResult`.

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/scheduler-conducts.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { schedulerPass } from './scheduler.js';

const BUSINESS = 'biz-sched-conduct';

describe('schedulerPass and the conductor', () => {
  beforeEach(async () => {
    await resetDatabase();
    await installCharter(buildCharter(), { businessId: BUSINESS });
  });

  it('scans the inbox when one is configured', async () => {
    const inbox = await mkdtemp(join(tmpdir(), 'sched-inbox-'));
    const documentRoot = await mkdtemp(join(tmpdir(), 'sched-root-'));
    await writeFile(join(inbox, 'note.txt'), 'שלום', 'utf8');

    const result = await schedulerPass({
      businessId: BUSINESS,
      inbox,
      documentRoot,
      // No reader injected: the pass must not call a model in this test, so
      // the ceiling is set to zero and only the scan runs.
      readsPerDay: 0,
    });

    expect(result.scan?.ingested).toBe(1);
    const { rows } = await getPool().query(`SELECT 1 FROM documents WHERE business_id = $1`, [
      BUSINESS,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('does not scan and does not fail when no inbox is configured', async () => {
    const result = await schedulerPass({ businessId: BUSINESS, readsPerDay: 0 });
    expect(result.scan).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/orchestrator/scheduler-conducts.test.ts`
Expected: FAIL — `result.scan` is undefined.

- [ ] **Step 3: Wire it in**

In `src/orchestrator/scheduler.ts`, extend the options and result types and place the two loops **between** the tick and `runDueJobs`:

```ts
export interface SchedulerPassResult {
  tick: TickResult;
  /** Null when no inbox is configured — the scan is off, not broken. */
  scan: ScanResult | null;
  conduct: ConductResult;
  due: RunDueResult;
  verified: VerifyResult;
}

export async function schedulerPass(
  options: {
    businessId?: string;
    now?: Date;
    limit?: number;
    runtime?: Runtime;
    /** Defaults to `config.documentInbox`. */
    inbox?: string | null;
    documentRoot?: string;
    readsPerDay?: number;
    reader?: ReadDocumentOptions['reader'];
    proposer?: ProposeForReadingOptions['proposer'];
  } = {},
): Promise<SchedulerPassResult> {
  const tickResult = await tick(options);

  // Both conductor loops run after the tick's transaction has committed, not
  // inside it — the same reason `runDueJobs` does: neither a file read nor a
  // model call should happen while a pooled connection is held behind the
  // business-wide advisory lock.
  const inbox = options.inbox !== undefined ? options.inbox : config.documentInbox;
  const scan =
    inbox === null
      ? null
      : await scanInbox({
          inbox,
          ...(options.businessId !== undefined ? { businessId: options.businessId } : {}),
          ...(options.documentRoot !== undefined ? { documentRoot: options.documentRoot } : {}),
        });

  const conduct = await conductPendingDocuments(options);

  const due = await runDueJobs(options);
  const verified = await closeVerifiedJobs(options);
  return { tick: tickResult, scan, conduct, due, verified };
}
```

Keep the existing comment above `closeVerifiedJobs` — its reasoning about ordering is unchanged.

- [ ] **Step 4: Run the test, then the neighbouring scheduler suites**

```bash
npx vitest run src/orchestrator/scheduler-conducts.test.ts
npx vitest run src/orchestrator/scheduler.test.ts src/orchestrator/scheduler-runs-plans.test.ts
```
Expected: PASS. Existing scheduler tests must still pass — they construct `SchedulerPassResult` expectations, so update any that assert on the whole object shape.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add -A && git commit -m "The scheduler scans and conducts, after the tick commits"
```

---

### Task 6: The "מה קראתי" screen

**Files:**
- Create: `src/dashboard/readings-list.ts`
- Modify: `src/dashboard/views.ts`
- Modify: `src/dashboard/server.ts`
- Test: `src/dashboard/readings-list.test.ts`
- Test: `src/dashboard/server.test.ts` (add two cases)

**Interfaces:**
- Consumes: `document_readings`, `proposals`, `documents`; `esc` and `escLabel` from `views.ts`.
- Produces:
  - `recentReadings(limit: number, options?: { businessId?: string; db?: Queryable }): Promise<ReadingSummary[]>` where
    `ReadingSummary = { documentId: string; originalName: string; sha256: string; readAt: string; summary: string; stance: string | null; headline: string | null; reasons: string[]; approvalId: string | null }`
  - `renderReadings(rows: ReadingSummary[], csrf: string): string`
  - `GET /readings` on the dashboard.

- [ ] **Step 1: Write the failing query test**

Create `src/dashboard/readings-list.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { recentReadings } from './readings-list.js';

const BUSINESS = 'biz-readings';

async function seed(businessId: string, documentId: string, stance: string): Promise<void> {
  await getPool().query(
    `INSERT INTO documents
       (document_id, business_id, source, original_name, media_type, byte_size,
        sha256, stored_path, status)
     VALUES ($1, $2, 'manual', 'חוזה.txt', 'text/plain', 10,
             repeat('a', 64), 'p/1.txt', 'extracted')`,
    [documentId, businessId],
  );
  await getPool().query(
    `INSERT INTO document_readings
       (reading_id, business_id, document_id, brief_hash, prompt_version, provenance, reading, raw)
     VALUES ($1, $2, $3, 'h', 'v1', 'unknown_external', $4::jsonb, '')`,
    [`RD-${documentId}`, businessId, documentId, JSON.stringify({ summary: 'סיכום', findings: [], intents: [] })],
  );
  await getPool().query(
    `INSERT INTO proposals
       (proposal_id, business_id, reading_id, job_id, status, proposal, raw)
     VALUES ($1, $2, $3, NULL, 'proposed', $4::jsonb, '')`,
    [
      `PR-${documentId}`,
      businessId,
      `RD-${documentId}`,
      JSON.stringify({
        headline: 'אני נגד חתימה',
        stance,
        reasons: [{ text: 'המחיר השתנה', findingLabel: 'מחיר' }],
        action: null,
      }),
    ],
  );
}

describe('recentReadings', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('returns the reading with its proposal stance and reasons', async () => {
    await seed(BUSINESS, 'DOC-1', 'advise_against');
    const rows = await recentReadings(10, { businessId: BUSINESS });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stance).toBe('advise_against');
    expect(rows[0]?.headline).toBe('אני נגד חתימה');
    expect(rows[0]?.reasons).toEqual(['המחיר השתנה']);
  });

  it('never returns another business\'s reading', async () => {
    await seed(BUSINESS, 'DOC-1', 'advise_against');
    expect(await recentReadings(10, { businessId: 'other' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/dashboard/readings-list.test.ts`
Expected: FAIL — cannot find module `./readings-list.js`.

- [ ] **Step 3: Implement the query**

Create `src/dashboard/readings-list.ts`:

```ts
/**
 * What the assistant read, and what it concluded.
 *
 * The approval card answers "shall I do this?" and needs an action to ask
 * about. Three of the four proposal stances may carry none — `ask`,
 * `no_action`, and an `advise_against` with no alternative — so without this
 * screen, "I am against signing this contract" would reach the owner nowhere.
 *
 * Read-only by construction: no form, no decision, no action. Deciding lives
 * on the approval card, which carries expiry, decision, signing and audit. A
 * second screen that decided would be a second path to the same table.
 */
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';

export interface ReadingSummary {
  documentId: string;
  originalName: string;
  sha256: string;
  readAt: string;
  summary: string;
  stance: string | null;
  headline: string | null;
  reasons: string[];
  approvalId: string | null;
}

interface ReadingRow {
  document_id: string;
  original_name: string;
  sha256: string;
  read_at: string;
  reading: { summary?: unknown };
  proposal: { stance?: unknown; headline?: unknown; reasons?: unknown } | null;
  approval_id: string | null;
}

function toSummary(row: ReadingRow): ReadingSummary {
  const proposal = row.proposal;
  const reasons = Array.isArray(proposal?.reasons)
    ? proposal.reasons
        .map((r) => (typeof r === 'object' && r !== null && 'text' in r ? String(r.text) : ''))
        .filter((t) => t !== '')
    : [];

  return {
    documentId: row.document_id,
    originalName: row.original_name,
    sha256: row.sha256,
    readAt: row.read_at,
    summary: typeof row.reading.summary === 'string' ? row.reading.summary : '',
    stance: typeof proposal?.stance === 'string' ? proposal.stance : null,
    headline: typeof proposal?.headline === 'string' ? proposal.headline : null,
    reasons,
    approvalId: row.approval_id,
  };
}

export async function recentReadings(
  limit: number,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ReadingSummary[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  // Every joined table is scoped by business_id in its own right, not only the
  // entry point — the same rule `documentForApproval` follows.
  const { rows } = await db.query<ReadingRow>(
    `SELECT d.document_id,
            d.original_name,
            d.sha256,
            r.created_at::text AS read_at,
            r.reading,
            p.proposal,
            a.approval_id
       FROM document_readings r
       JOIN documents d
         ON d.document_id = r.document_id
        AND d.business_id = r.business_id
       LEFT JOIN LATERAL (
            SELECT pr.proposal, pr.job_id
              FROM proposals pr
             WHERE pr.reading_id = r.reading_id
               AND pr.business_id = r.business_id
             ORDER BY pr.created_at DESC, pr.proposal_id DESC
             LIMIT 1
       ) p ON true
       LEFT JOIN approval_requests a
         ON a.job_id = p.job_id
        AND a.business_id = r.business_id
      WHERE r.business_id = $1
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [businessId, limit],
  );

  return rows.map(toSummary);
}
```

- [ ] **Step 4: Run the query test**

Run: `npx vitest run src/dashboard/readings-list.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Render it**

Add to `src/dashboard/views.ts`:

```ts
const STANCE_LABEL: Record<string, string> = {
  act: 'מציעה לפעול',
  advise_against: 'ממליצה שלא',
  ask: 'יש לי שאלה',
  no_action: 'אין מה לעשות',
};

/**
 * Read-only. No form, no button that decides anything.
 *
 * `escLabel` on the filename for the same reason the approval card uses it:
 * `original_name` is stored verbatim from whoever sent the file, and bidi
 * control characters make a name render as something other than what it is.
 */
export function renderReadings(rows: ReadingSummary[], csrf: string): string {
  const items = rows
    .map((r) => {
      const stance = r.stance === null ? '' : (STANCE_LABEL[r.stance] ?? r.stance);
      const reasons = r.reasons.map((t) => `<li>${esc(t)}</li>`).join('');
      const link =
        r.approvalId === null
          ? '<span class="muted">אין כרטיס — אין פעולה לאשר</span>'
          : `<a href="/a/${esc(r.approvalId)}">לכרטיס האישור</a>`;
      return `
        <article class="card">
          <h3>${escLabel(r.originalName)} <span class="hash">${esc(r.sha256.slice(0, 12))}</span></h3>
          <p class="when">${esc(r.readAt)}</p>
          <p>${esc(r.summary)}</p>
          ${stance === '' ? '' : `<p class="stance"><strong>${esc(stance)}</strong>${r.headline === null ? '' : ` — ${esc(r.headline)}`}</p>`}
          ${reasons === '' ? '' : `<ul>${reasons}</ul>`}
          <p>${link}</p>
        </article>`;
    })
    .join('');

  return page(
    'מה קראתי',
    `<h1>מה קראתי</h1>
     <p class="muted">כל מסמך שנקלט ונקרא, ומה שהוסק ממנו. המסך הזה מציג בלבד — הכרעה נעשית בכרטיס האישור.</p>
     ${rows.length === 0 ? '<p>עדיין לא נקרא אף מסמך.</p>' : items}
     <form method="POST" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>יציאה</button></form>`,
  );
}
```

Use whatever the file's existing `page(title, body)` helper is called; if it has none, follow the shape `renderApprovalCard` already uses.

- [ ] **Step 6: Route it**

In `src/dashboard/server.ts`, beside the existing `if (method === 'GET' && pathname === '/')` line:

```ts
  if (method === 'GET' && pathname === '/readings') {
    const rows = await recentReadings(50, { businessId });
    return sendHtml(res, 200, renderReadings(rows, issueCsrfToken(session.sessionId)));
  }
```

Add a link to it from the pending list (`renderPendingList`): `<p><a href="/readings">מה קראתי</a></p>`.

- [ ] **Step 7: Add the two route tests**

In `src/dashboard/server.test.ts`:

```ts
  it('serves the readings screen behind a session', async () => {
    const { cookie } = await aLoggedInOwner();
    const res = await get('/readings', { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toContain('מה קראתי');
  });

  it('refuses the readings screen without a session', async () => {
    const res = await get('/readings', {});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
```

Use the file's existing login and request helpers; do not invent new ones.

- [ ] **Step 8: Run the dashboard suite**

Run: `npx vitest run src/dashboard/readings-list.test.ts src/dashboard/server.test.ts`
Expected: PASS.

- [ ] **Step 9: Prove the session guard bites**

Move the `/readings` route above the session check, re-run, confirm `refuses the readings screen without a session` fails. Restore. Redirect to `task-6-mut-fail.txt` / `task-6-mut-pass.txt`.

- [ ] **Step 10: Typecheck and commit**

```bash
npm run typecheck
git add -A && git commit -m "A screen for what the assistant read and concluded"
```

---

### Task 7: Structural invariants, documentation, and the live run

**Files:**
- Create: `src/orchestrator/conductor-invariants.test.ts`
- Modify: `CLAUDE.md`
- Modify: `docs/09-roadmap.md`
- Modify: `.env.example` (verify Task 1's entries are present and accurate)

**Interfaces:**
- Consumes: everything above.
- Produces: no new runtime code.

- [ ] **Step 1: Write the invariants**

Create `src/orchestrator/conductor-invariants.test.ts`:

```ts
/**
 * Structural, in the style of `positive-controls.test.ts`. These do not test
 * behaviour — they hold three properties that a future edit could quietly
 * remove while every behavioural test stayed green.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function source(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

describe('the conductor cannot grant authority', () => {
  it('stamps every job it opens as external, and offers no way to ask otherwise', () => {
    const conduct = source('orchestrator/conduct.ts');
    expect(conduct).toContain("provenance: 'unknown_external'");
    expect(conduct, 'a provenance the caller can choose is a provenance an attacker can choose')
      .not.toMatch(/provenance:\s*(options|input|document|proposal)\./);
    expect(conduct).not.toContain("provenance: 'boss'");
  });

  it('never turns on standing authorisation', () => {
    for (const file of ['orchestrator/conduct.ts', 'orchestrator/proposal-approval.ts']) {
      expect(source(file), `${file} must not reach for standing authorisation`).not.toContain(
        'useStandingAuthorization',
      );
      expect(source(file)).not.toContain('grantAuthorization');
    }
  });

  it('never raises a ramp level', () => {
    for (const file of ['orchestrator/conduct.ts', 'orchestrator/proposal-approval.ts', 'orchestrator/inbox-scan.ts']) {
      expect(source(file), `${file} must not move the ramp`).not.toContain('setRampLevel');
    }
  });

  it('says on every card that approving does not execute', () => {
    const raise = source('orchestrator/proposal-approval.ts');
    expect(raise).toContain('RAMP_HONESTY');
    expect(raise).toMatch(/detail:\s*`\$\{text\.detail\}\\n\\n\$\{RAMP_HONESTY\}`/);
  });
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run src/orchestrator/conductor-invariants.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Prove they bite**

Change `provenance: 'unknown_external'` in `conduct.ts` to `'boss'`, confirm the first invariant fails, restore. Redirect to `task-7-mut-fail.txt` / `task-7-mut-pass.txt`.

- [ ] **Step 4: Documentation**

In `CLAUDE.md`:
- Add `DOCUMENT_INBOX` and `DOCUMENT_READS_PER_DAY` beside the other environment notes.
- Add a silent-rule paragraph: the conductor raises its own approval because the gate's stage 8 denies at the ramp floor and would produce no card; job provenance is `unknown_external` and is not a parameter; a proposal with no action produces no card and is seen only on `/readings`; the daily ceiling counts reading rows, so a cache hit is free and uncounted.
- Update the "מה עוד לא נבנה" list: the three previously dormant paths (`proposeForReading`, `proposalToApprovalText`, the sign button) now have a production caller. **Verify each claim against the code before writing it** — this project has three times shipped documentation citing something that did not exist.
- Update the test count from a full run the controller performs.

In `docs/09-roadmap.md`, add a note under stage 0 recording that the conductor closed the gap between the four built capabilities and a running installation, and stating plainly what it did **not** change: the ramp is still at the floor, so approving a card still does not execute.

- [ ] **Step 5: The live run**

With a real `ANTHROPIC_API_KEY` in `.env` and `DOCUMENT_INBOX` set to a real folder:

```bash
npm run scheduler
```

Drop one real document into the folder. Confirm, and record in the report: the file moved to `processed/`; a `documents` row exists; a `document_readings` row exists; a `proposals` row exists; either an `approval_requests` row in `pending` **or** a visible entry on `/readings`; and the job's phase.

A test with an injected seam proves composition. Only this proves connection.

- [ ] **Step 6: Full verification and commit**

```bash
npm run typecheck
npm test
git add -A && git commit -m "Invariants and documentation for the conductor"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| §2 the chain | 2, 4, 5 |
| §3 the conductor raises its own approval | 3 |
| §4 two loops, placed after the tick | 2, 4, 5 |
| §5 the write-in-progress guard and the folder layout | 2 |
| §6 external provenance, real phase walk | 4, and 7 locks it |
| §7 what the card says, including the honesty sentence | 3, and 7 locks it |
| §7ב the readings screen | 6 |
| §8 the daily ceiling, measured by reading rows | 1, 4 |
| §9 failures | 1 (attempts), 2 (rejected files), 4 (per-document isolation) |
| §10 the two settings and the migration | 1 |
| §11 tests, invariants, live run | every task, plus 7 |
| §12 what this is not | 7 (documentation) |

**2. Placeholder scan:** none. Every step carries the code or the exact command.

**3. Type consistency:** `ScanResult` is produced in Task 2 and consumed in Task 5. `ConductResult` is produced in Task 4 and consumed in Task 5. `raiseProposalApproval` returns `string | null` in Task 3 and Task 4 branches on exactly that. `ReadingSummary` is produced in Task 6's query and consumed by its own renderer. `documentsAwaitingRead` / `recordReadFailure` / `readingsToday` are defined in Task 1 and used in Task 4 with the same signatures.

**Two things the executor should know:**

- **Task 5 will touch existing scheduler tests.** `SchedulerPassResult` gains two fields; any test asserting on the whole object needs updating. That is expected, not a regression.
- **`DocumentRecord` gains two fields in Task 1.** Anything constructing one in a test fixture may need them.

**Ordering:** 1 → 2 and 3 in either order → 4 (needs 1 and 3) → 5 (needs 2 and 4) → 6 (independent of 2–5, needs only the schema) → 7 last.
