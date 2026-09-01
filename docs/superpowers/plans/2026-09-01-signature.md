# Signature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner a third decision on an approval card — **חתום ואשר** — that records a signature against the document, after re-hashing the file from disk and refusing if it changed since intake.

**Architecture:** Signing is an approval outcome, not a tool. `contract.sign` stays in `UNOWNED_TOOLS`, so nothing the model emits can propose it. The dashboard resolves an approval back to its document through the job, re-hashes the stored file, compares against what intake recorded, and on a match writes a `signatures` row, an audit entry, and approves the request — all in one transaction.

**Tech Stack:** TypeScript (NodeNext ESM), zod, `pg` against real PostgreSQL 17, vitest, `node:crypto`.

**Spec:** [docs/superpowers/specs/2026-09-01-signature-design.md](../specs/2026-09-01-signature-design.md)

**Branch:** `proposal-planner`, at `6be1bee`. Do not implement on `main`.

## Global Constraints

- **`.js` in every relative import**, including from `.ts` files (NodeNext ESM).
- **`noUncheckedIndexedAccess`** (`rows[0]?.x`, never a non-null assertion in production code), **`exactOptionalPropertyTypes`** (conditional spread), **`verbatimModuleSyntax`** (`import type` for types).
- **DB row convention:** private `interface XRow` with snake_case fields plus a `toX(row)` function. SQL snake_case, TypeScript camelCase.
- **Tests need real Postgres.** `resetDatabase()` in `beforeEach`, `closePool()` in `afterAll`. Add every new table to the explicit TRUNCATE list in `src/test/db.ts`.
- **Hebrew for humans, English for code.** Refusal reasons and button text in Hebrew; identifiers, comments and internal errors in English.
- **A value that could not be read is never the permissive one.** A file that cannot be hashed refuses; it does not sign.
- **A test that passes with the code it covers deleted is not a test.** Several tasks in the previous two plans were sent back for exactly this.
- **`contract.sign` must remain in `UNOWNED_TOOLS`.** No task here gives it an owner. If an implementer finds themselves editing an allowlist, they have misread the plan — stop and report.
- **Run `npm run typecheck` and `npm test` before every commit.** Redirect test output to files; never hand-write a transcript.

**Migration numbering:** `017_proposal_raw.sql` is the highest existing. This plan adds `018_proposal_job.sql` (Task 1) and `019_signatures.sql` (Task 2), in task order. The spec's §5/§6 name them the other way round; the numbers here are authoritative because they match the order the migrations are written in.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations/018_proposal_job.sql` | `proposals.job_id` — closes the gap that makes an approval unresolvable to its document |
| `src/db/migrations/019_signatures.sql` | the signatures table |
| `src/governance/signatures.ts` | `recordSignature`, `loadSignature` — the store, beside `approvals.ts` where it belongs |
| `src/documents/verify.ts` | `verifyDocumentUnchanged` — re-hash from disk and compare. The control that gives a signature meaning |
| `src/dashboard/document-for-approval.ts` | resolve an approval back to its document through the job |
| `src/dashboard/server.ts` | the `/a/:id/sign` route |
| `src/dashboard/views.ts` | the button, shown only when a document backs the request |
| `src/documents/store.ts` | gains `loadDocument` — no single-document reader exists today |
| `src/domain/audit.ts` | `AuditKind` gains `signature` |

---

### Task 1: `proposals.job_id`

**Files:**
- Create: `src/db/migrations/018_proposal_job.sql`
- Modify: `src/orchestrator/proposal-store.ts`, `src/orchestrator/propose.ts`, `src/orchestrator/proposal-store.test.ts`

**Interfaces:**
- Produces: `NewProposal` and `ProposalRecord` both gain `jobId: string`.

**Context:** `proposeForReading` receives a `jobId`, uses it to load the job and derive provenance, and then **throws it away**. Nothing records which job a proposal was made for, so an approval cannot be resolved back to the document it concerns. That is the gap this task closes, and every later task depends on it.

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/018_proposal_job.sql`:

```sql
-- Which job a proposal was made for
-- (docs/superpowers/specs/2026-09-01-signature-design.md §6).
--
-- `proposeForReading` has always received a jobId — it loads the job to derive
-- provenance from the stamped column — and then discarded it. A proposal that
-- does not remember which job it served cannot be traced back from anything
-- downstream, and the dashboard needs exactly that trace to know which document
-- an approval concerns.
--
-- Nullable, because rows written before this column existed have no job to
-- name and inventing one would be worse than admitting the gap. Every row
-- written from now on carries it.
ALTER TABLE proposals
    ADD COLUMN job_id TEXT REFERENCES jobs (job_id) ON DELETE SET NULL;

CREATE INDEX proposals_by_job_idx ON proposals (business_id, job_id);
```

- [ ] **Step 2: Run the migration**

Run: `npm run migrate:test`
Expected: reports `018_proposal_job.sql` applied.

- [ ] **Step 3: Write the failing test**

Add to `src/orchestrator/proposal-store.test.ts`:

```ts
it('records which job the proposal was made for', async () => {
  const readingId = await aReading();
  const job = await createJob({
    charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS,
  });
  const record = await saveProposal(
    newProposal(readingId, { jobId: job.jobId }), { businessId: BUSINESS },
  );
  expect(record.jobId).toBe(job.jobId);
  const all = await loadProposalsForReading(readingId, { businessId: BUSINESS });
  expect(all[0]?.jobId).toBe(job.jobId);
});
```

The file will need `createJob` and a charter — import `createJob` from `./jobs.js`, `compileCharter` from `../charter/compile.js`, `installCharter` from `../charter/store.js`, `buildCharter` from `../test/fixtures.js`, and install a charter in `beforeEach` so the job's foreign key on `charter_version` resolves. `src/orchestrator/propose.test.ts` already does this — copy its setup rather than inventing one.

- [ ] **Step 4: Run it, watch it fail, implement**

Run: `npx vitest run src/orchestrator/proposal-store.test.ts` — expect a type error on `jobId`.

Add `jobId: string` to both `NewProposal` and `ProposalRecord`, `job_id` to `ProposalRow` and to `COLUMNS`, the value to the INSERT, and `jobId: row.job_id` to `toProposal`. Note `job_id` is nullable in SQL but every write supplies it — read it back as `row.job_id ?? ''` would hide a real gap, so type the row field as `string | null` and let `toProposal` surface it honestly: `jobId: row.job_id`, with `ProposalRecord.jobId` typed `string | null`.

Then in `src/orchestrator/propose.ts`, pass `jobId: input.jobId` into the `saveProposal` call.

- [ ] **Step 5: Run, typecheck, full suite, commit**

```bash
npx vitest run src/orchestrator/proposal-store.test.ts src/orchestrator/propose.test.ts
npm run typecheck && npm test
git add src/db/migrations/018_proposal_job.sql src/orchestrator/proposal-store.ts src/orchestrator/proposal-store.test.ts src/orchestrator/propose.ts
git commit -m "A proposal records which job it was made for

proposeForReading has always received a jobId, used it to derive provenance
from the stamped column, and then thrown it away. Nothing could trace a
proposal back to its job, and so nothing could resolve an approval forward to
the document it concerns.

Nullable, because rows written before the column existed have no job to name
and inventing one is worse than admitting the gap.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The signatures table and its store

**Files:**
- Create: `src/db/migrations/019_signatures.sql`, `src/governance/signatures.ts`, `src/governance/signatures.test.ts`
- Modify: `src/domain/audit.ts` (add `'signature'` to `AuditKind`), `src/documents/store.ts` (add `loadDocument`), `src/test/db.ts`

**Interfaces:**
- Produces:
  - `interface SignatureRecord { signatureId; businessId; documentId; signedSha256; approvalId; signedBy; }`
  - `recordSignature(input: { signatureId; documentId; signedSha256; approvalId; signedBy }, options?): Promise<SignatureRecord>`
  - `loadSignature(documentId: string, options?): Promise<SignatureRecord | null>`
  - from `src/documents/store.ts`: `loadDocument(documentId: string, options?): Promise<DocumentRecord | null>`

**Context:** The store lives in `src/governance/`, beside `approvals.ts`, `consume.ts` and `killswitch.ts` — a signature is a governance act, not a document-processing one. Read `src/documents/reading-store.ts` for the row-convention shape.

`signed_by` is a **dashboard username**, never an agent id and never `'system'`. A person signed.

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/019_signatures.sql`:

```sql
-- The owner's signature on a document
-- (docs/superpowers/specs/2026-09-01-signature-design.md §5).
--
-- This is a record in the system, not a cryptographic signature and not an
-- edit to the file. It says: this person, at this time, through this approval,
-- accepted the document whose bytes hashed to exactly this.
--
-- `signed_sha256` is measured AT SIGNING TIME by re-reading the stored file,
-- not copied from `documents.sha256`. The two agreeing is what the signing
-- path checks; recording the intake hash instead would make the row attest to
-- a file nobody re-examined.
--
-- One signature per document. A second is not an update — it is a sign that
-- something in the flow is unclear, and it fails loudly.
CREATE TABLE signatures (
    signature_id  TEXT        PRIMARY KEY,
    business_id   TEXT        NOT NULL,
    document_id   TEXT        NOT NULL REFERENCES documents (document_id) ON DELETE CASCADE,
    signed_sha256 TEXT        NOT NULL,
    approval_id   TEXT        NOT NULL,
    -- A dashboard username. Never an agent id, never 'system'.
    signed_by     TEXT        NOT NULL,
    signed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX signatures_one_per_document_idx
    ON signatures (business_id, document_id);
```

- [ ] **Step 2: Run it and register the table**

Run `npm run migrate:test`. Then add `signatures,` to the TRUNCATE list in `src/test/db.ts`, immediately **before** `documents,`. `CASCADE` would reach it through the foreign key, but a table truncated only as someone else's dependent stops being truncated the day that key changes.

- [ ] **Step 3: Add the audit kind and the document loader**

In `src/domain/audit.ts`, add `'signature'` to the `AuditKind` enum, after `'approval'`, with a comment:

```ts
  /**
   * The owner signed a document. Distinct from `approval` on purpose: someone
   * reading the trail must be able to tell "the owner permitted an action"
   * from "the owner accepted a document as binding".
   */
  'signature',
```

In `src/documents/store.ts`, add — no single-document reader exists today:

```ts
/** One document by id, scoped to its business. `null` when this business does not own it. */
export async function loadDocument(
  documentId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<DocumentRecord | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<DocumentRow>(
    `SELECT document_id, business_id, source, original_name, media_type, sha256,
            byte_size, stored_path, status, reason
       FROM documents WHERE business_id = $1 AND document_id = $2`,
    [options.businessId ?? config.businessId, documentId],
  );
  const row = rows[0];
  return row === undefined ? null : toDocument(row);
}
```

- [ ] **Step 4: Write the failing test**

Create `src/governance/signatures.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { insertOrGetDocument, loadDocument } from '../documents/store.js';
import { loadSignature, recordSignature } from './signatures.js';

const BUSINESS = 'test-business';

async function aDocument(): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument({
    documentId, source: 'manual', originalName: 'חוזה.docx', mediaType: 'text/plain',
    sha256: 'a'.repeat(64), byteSize: 10,
    storedPath: `${BUSINESS}/${documentId}/original.txt`,
  }, { businessId: BUSINESS });
  return documentId;
}

function newSignature(documentId: string) {
  return {
    signatureId: `SIG-${ulid()}`, documentId, signedSha256: 'b'.repeat(64),
    approvalId: `AP-${ulid()}`, signedBy: 'owner',
  };
}

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

describe('recordSignature', () => {
  it('stores a signature and hands it back', async () => {
    const documentId = await aDocument();
    const record = await recordSignature(newSignature(documentId), { businessId: BUSINESS });
    expect(record.documentId).toBe(documentId);
    expect(record.signedBy).toBe('owner');
    expect(record.signedSha256).toBe('b'.repeat(64));
  });

  it('refuses a second signature on the same document', async () => {
    const documentId = await aDocument();
    await recordSignature(newSignature(documentId), { businessId: BUSINESS });
    await expect(
      recordSignature(newSignature(documentId), { businessId: BUSINESS }),
    ).rejects.toThrow();
  });

  it('leaves the first signature untouched when a second is refused', async () => {
    const documentId = await aDocument();
    const first = await recordSignature(newSignature(documentId), { businessId: BUSINESS });
    await expect(
      recordSignature(newSignature(documentId), { businessId: BUSINESS }),
    ).rejects.toThrow();
    const loaded = await loadSignature(documentId, { businessId: BUSINESS });
    expect(loaded?.signatureId).toBe(first.signatureId);
  });
});

describe('loadSignature', () => {
  it('returns null for an unsigned document', async () => {
    const documentId = await aDocument();
    expect(await loadSignature(documentId, { businessId: BUSINESS })).toBeNull();
  });

  it('does not cross the business boundary', async () => {
    const documentId = await aDocument();
    await recordSignature(newSignature(documentId), { businessId: BUSINESS });
    expect(await loadSignature(documentId, { businessId: 'other' })).toBeNull();
  });
});

describe('loadDocument', () => {
  it('returns the document, and null across the business boundary', async () => {
    const documentId = await aDocument();
    expect((await loadDocument(documentId, { businessId: BUSINESS }))?.documentId).toBe(documentId);
    expect(await loadDocument(documentId, { businessId: 'other' })).toBeNull();
  });
});
```

- [ ] **Step 5: Run it, watch it fail, implement**

Run `npx vitest run src/governance/signatures.test.ts` — expect module-not-found.

Write `src/governance/signatures.ts` following `src/documents/reading-store.ts`'s shape exactly: a private `SignatureRow`, a `toSignature(row)`, a shared `COLUMNS` constant, parameterised statements, and `rows[0]?` access. `recordSignature` is a plain `INSERT ... RETURNING`; the unique index is what refuses a second signature, and the error it raises should be caught and rethrown as a named error explaining that a document carries one signature and a second would be a silent overwrite.

- [ ] **Step 6: Run, typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/db/migrations/019_signatures.sql src/governance/signatures.ts src/governance/signatures.test.ts src/domain/audit.ts src/documents/store.ts src/test/db.ts
git commit -m "A signature is a record: who accepted which bytes, and when

Stored in governance/ beside approvals and the kill switch, because signing is
a governance act rather than document processing.

signed_sha256 is measured at signing time, not copied from the intake row —
recording the intake hash would make the row attest to a file nobody
re-examined. AuditKind gains 'signature' so the trail distinguishes \"the owner
permitted an action\" from \"the owner accepted a document as binding\".

One signature per document, enforced by a unique index. A second is not an
update; it is a sign the flow is unclear, and it fails loudly.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `verifyDocumentUnchanged` — the control

**Files:**
- Create: `src/documents/verify.ts`, `src/documents/verify.test.ts`

**Interfaces:**
- Consumes: `loadDocument` from `./store.js`; `config.documentRoot`.
- Produces:
  - `type VerifyOutcome = { status: 'unchanged'; sha256: string } | { status: 'changed'; expected: string; actual: string } | { status: 'missing' } | { status: 'unknown_document' }`
  - `verifyDocumentUnchanged(documentId: string, options?: { businessId?: string; db?: Queryable; documentRoot?: string }): Promise<VerifyOutcome>`

**Context — this is the task the whole feature rests on.** A signature that attests to a hash nobody re-measured is worth nothing. This function reads the stored file **from disk**, hashes it, and compares against `documents.sha256` as recorded at intake.

It returns an outcome and does not throw for any of the four cases. A missing file and a changed file are both facts about the document, not faults — and the caller must be able to tell them apart to write a useful refusal.

`stored_path` is relative to the document root; join, never interpolate.

- [ ] **Step 1: Write the failing test**

Create `src/documents/verify.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { insertOrGetDocument } from './store.js';
import { verifyDocumentUnchanged } from './verify.js';

const BUSINESS = 'test-business';
const BYTES = Buffer.from('הסכם שיווק — גרסה ראשונה', 'utf8');
const HASH = createHash('sha256').update(BYTES).digest('hex');

let root: string;

/** A document row plus its file on disk, exactly as ingestDocument leaves them. */
async function aStoredDocument(bytes: Buffer, sha256: string): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  const rel = `${BUSINESS}/${documentId}/original.txt`;
  await mkdir(join(root, BUSINESS, documentId), { recursive: true });
  await writeFile(join(root, rel), bytes);
  await insertOrGetDocument({
    documentId, source: 'manual', originalName: 'הסכם.docx', mediaType: 'text/plain',
    sha256, byteSize: bytes.length, storedPath: rel,
  }, { businessId: BUSINESS });
  return documentId;
}

beforeEach(async () => {
  await resetDatabase();
  root = await mkdtemp(join(tmpdir(), 'verify-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await closePool();
});

describe('verifyDocumentUnchanged', () => {
  it('reports unchanged when the file still hashes to what intake recorded', async () => {
    const documentId = await aStoredDocument(BYTES, HASH);
    const outcome = await verifyDocumentUnchanged(documentId, { businessId: BUSINESS, documentRoot: root });
    expect(outcome.status).toBe('unchanged');
    if (outcome.status !== 'unchanged') throw new Error('expected unchanged');
    expect(outcome.sha256).toBe(HASH);
  });

  it('reports changed when the file on disk was edited after intake', async () => {
    // The row keeps intake's hash; the bytes are someone else's.
    const documentId = await aStoredDocument(Buffer.from('הסכם שיווק — נוסח אחר', 'utf8'), HASH);
    const outcome = await verifyDocumentUnchanged(documentId, { businessId: BUSINESS, documentRoot: root });
    expect(outcome.status).toBe('changed');
    if (outcome.status !== 'changed') throw new Error('expected changed');
    expect(outcome.expected).toBe(HASH);
    expect(outcome.actual).not.toBe(HASH);
  });

  it('reports missing when the file is gone', async () => {
    const documentId = await aStoredDocument(BYTES, HASH);
    await rm(join(root, BUSINESS, documentId), { recursive: true, force: true });
    expect((await verifyDocumentUnchanged(documentId, { businessId: BUSINESS, documentRoot: root })).status)
      .toBe('missing');
  });

  it('reports unknown_document for an id this business does not own', async () => {
    const documentId = await aStoredDocument(BYTES, HASH);
    expect((await verifyDocumentUnchanged(documentId, { businessId: 'other', documentRoot: root })).status)
      .toBe('unknown_document');
  });

  it('never throws for any of the four outcomes', async () => {
    const documentId = await aStoredDocument(BYTES, HASH);
    await rm(join(root, BUSINESS, documentId), { recursive: true, force: true });
    await expect(
      verifyDocumentUnchanged(documentId, { businessId: BUSINESS, documentRoot: root }),
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

Run `npx vitest run src/documents/verify.test.ts` — expect module-not-found.

Create `src/documents/verify.ts`. Read the file with `readFile`, hash with `createHash('sha256').update(bytes).digest('hex')`, compare. Catch the read error and return `{ status: 'missing' }` rather than letting it propagate — the caller needs to write a refusal, not a stack trace. Put the reasoning in a docblock: a signature attesting to a hash nobody re-measured is worth nothing, and the four outcomes exist so a refusal can say which one happened.

- [ ] **Step 3: Prove the comparison bites**

Change the comparison to always return `unchanged`, run the file, confirm the `changed` test fails. Restore, confirm green. Redirect both with `2>&1` to `.superpowers/sdd/2026-09-01-signature/task-3-mut-fail.txt` and `-pass.txt`.

- [ ] **Step 4: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/documents/verify.ts src/documents/verify.test.ts
git commit -m "Re-hash the file from disk, and say which way it failed

A signature attesting to a hash nobody re-measured is worth nothing. This reads
the stored bytes at signing time and compares against what intake recorded.

Four outcomes, none of them thrown: unchanged, changed, missing, and unknown.
A missing file and an edited file are both facts about the document rather than
faults, and the caller has to tell them apart to write a refusal a person can
act on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Resolving an approval to its document

**Files:**
- Create: `src/dashboard/document-for-approval.ts`, `src/dashboard/document-for-approval.test.ts`

**Interfaces:**
- Consumes: `getApproval` from `../governance/approvals.js`; `loadDocument` from `../documents/store.js`; the `proposals` and `document_readings` tables.
- Produces: `documentForApproval(approvalId: string, options?: { businessId?: string; db?: Queryable }): Promise<DocumentRecord | null>`

**Context:** The chain is `approval.jobId → proposals.job_id → proposals.reading_id → document_readings.document_id → documents`. Task 1 added the middle link. Write it as one SQL query joining the three tables rather than four round trips — but scope **every** table in the join by `business_id`, not only the first.

`null` means "no document backs this approval", which is the ordinary case for a mail send. It is not an error.

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/document-for-approval.test.ts` covering: an approval whose job has a proposal for a reading of a document returns that document; an approval whose job has no proposal returns `null`; an approval with no job returns `null`; and the business boundary holds. Build the fixtures with `insertOrGetDocument`, `saveReading`, `saveProposal` and `enqueueApproval` — all real, no stubs.

- [ ] **Step 2: Run it, watch it fail, implement**

Write the query as a single `SELECT ... FROM approval_requests a JOIN proposals p ON p.job_id = a.job_id AND p.business_id = a.business_id JOIN document_readings r ON ...`, ordered by the proposal's `created_at DESC` with `LIMIT 1` — a job may have several proposals, and the most recent is the one the card is showing.

- [ ] **Step 3: Prove the business scoping bites**

Drop `AND p.business_id = a.business_id` from the join, run the file, confirm the business-boundary test fails. Restore, confirm green. Redirect both to `task-4-mut-*.txt`.

- [ ] **Step 4: Typecheck, full suite, commit**

---

### Task 5: The route and the button

**Files:**
- Modify: `src/dashboard/server.ts`, `src/dashboard/views.ts`, `src/dashboard/server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–4.

**Context — the shape of the change.** `DECISION_PATH` is `/^\/a\/([^/]+)\/(approve|deny)$/`. It becomes `(approve|deny|sign)`. `handleDecision`'s `outcome` parameter widens to `'approved' | 'denied' | 'signed'`.

A `signed` outcome does everything `approved` does, and first:

1. `documentForApproval` — `null` means no document backs this request, so **refuse**. The button would not have been shown; a direct POST is either a stale page or someone probing.
2. `verifyDocumentUnchanged` — anything but `unchanged` refuses, with a Hebrew reason naming which outcome occurred.
3. `recordSignature` with the hash the verification measured, the approval id, and `session.username`.
4. `appendAudit` with `kind: 'signature'`.
5. Then the ordinary approve path.

**Refusals re-render the card with the reason**, exactly as the edited-payload error path already does — they do not throw and do not approve. The approval stays `pending`, so the owner can fix the file and try again.

**CSRF and session are enforced by the existing route plumbing**; the new outcome adds no bypass. If an implementer finds themselves writing a session check, they are in the wrong place — the check already happened.

In `views.ts`, `renderApprovalCard` takes a new optional `document?: DocumentRecord` and renders a third form posting to `/a/:id/sign` with the label **חתום ואשר**, **only when it is supplied**. Escape the document's `originalName` with the existing `esc` — it is a name a sender chose.

- [ ] **Step 1: Write the failing tests**

In `src/dashboard/server.test.ts`, covering: signing a request whose file is unchanged writes a signature row, an audit row of kind `signature`, and leaves the approval `approved`; signing when the file changed leaves **no** signature row and the approval still `pending`; signing an approval with no document refuses; a second signature on the same document refuses and the first survives; and a POST without a CSRF token is rejected exactly as the approve path rejects it.

- [ ] **Step 2: Run, watch fail, implement, run**

- [ ] **Step 3: Prove the hash check bites in the route**

Make the route ignore the verification outcome and always proceed. Confirm the changed-file test fails. Restore, confirm green. Redirect to `task-5-mut-*.txt`. This is the mutation that matters: the control exists in Task 3, and this proves the route actually consults it.

- [ ] **Step 4: Typecheck, full suite, commit**

---

### Task 6: Invariants and documentation

**Files:**
- Create: `src/charter/unowned-tools.test.ts`
- Modify: `CLAUDE.md`, `docs/05-approvals.md`

**Context:** `capabilities.test.ts` today asserts only that a classified tool is *either* owned *or* in `UNOWNED_TOOLS` — which stays green if `contract.sign` gains an owner. The spec's whole argument rests on it not gaining one, so the invariant becomes explicit.

- [ ] **Step 1: Write the invariant**

Create `src/charter/unowned-tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AGENT_ALLOWLISTS, UNOWNED_TOOLS } from './capabilities.js';
import { AgentId } from '../domain/audit.js';

/**
 * The three tools nobody owns, named rather than counted.
 *
 * `capabilities.test.ts` asserts that every classified tool is either owned or
 * deliberately unowned — which stays green the day one of these gains an owner.
 * The signing design (2026-09-01) rests on `contract.sign` being unreachable by
 * construction, so the claim is made checkable here: whoever gives one of these
 * an owner does it against a red test, in the open.
 */
describe('the deliberately unowned tools', () => {
  it('names exactly the three the capability layer documents', () => {
    expect([...UNOWNED_TOOLS].sort()).toEqual(
      ['charter.apply_amendment', 'contract.sign', 'payment.charge'].sort(),
    );
  });

  it('gives none of them to any agent', () => {
    const agents = Object.keys(AGENT_ALLOWLISTS) as AgentId[];
    const owned = agents.flatMap((agent) =>
      AGENT_ALLOWLISTS[agent]
        .filter((tool) => UNOWNED_TOOLS.includes(tool))
        .map((tool) => `${agent} → ${tool}`),
    );
    expect(owned).toEqual([]);
  });
});
```

- [ ] **Step 2: Prove it bites**

Temporarily add `'contract.sign'` to any agent's allowlist, confirm the second test fails, remove it, confirm green. Redirect to `task-6-mut-*.txt`.

- [ ] **Step 3: Documentation**

`CLAUDE.md` — the commands block needs nothing new, but add a silent rule: signing is an approval outcome and not a tool; `contract.sign` stays unowned and a named test holds it there; the file is re-hashed from disk at signing time and a mismatch refuses; one signature per document. Update the test count from an actual run.

`docs/05-approvals.md` — the card now offers a third decision when a document backs the request, what it records, and what refuses it.

**Verify every factual claim before writing it.** Three fix waves in this project have shipped documentation citing a test file that did not exist.

- [ ] **Step 4: Typecheck, full suite, commit**

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 — `contract.sign` stays unowned, invariant made explicit | 6 |
| §3 — signing is a third approval outcome | 5 |
| §4 — re-hash from disk, refuse on mismatch | 3 (the control), 5 (the route consulting it) |
| §5 — the signature record, one per document, audit kind | 2 |
| §6 — resolving approval → document, `proposals.job_id` | 1, 4 |
| §7 — what it opens | 6 (documented, deliberately not built) |
| §8 — the failure table | 3, 5 |
| §9 — the tests, including the unowned-tools invariant | 3, 5, 6 |
| §10 — what this is not | 6 (documented) |

**Gap found and closed:** §5 requires `signed_by` to be a dashboard username. Nothing in Tasks 1–4 has access to a session. It is Task 5 that supplies it, from `session.username`, and Task 5's Context now says so explicitly rather than leaving the implementer to find a value.

**Type consistency:** `SignatureRecord`/`recordSignature`/`loadSignature` defined in Task 2, consumed in Task 5. `loadDocument` defined in Task 2, consumed in Tasks 3 and 4. `VerifyOutcome`/`verifyDocumentUnchanged` defined in Task 3, consumed in Task 5. `documentForApproval` defined in Task 4, consumed in Task 5. `NewProposal.jobId` defined in Task 1, relied on by Task 4's join.

**Ordering note:** Task 4's join needs Task 1's column and Task 2's `loadDocument`. Task 5 needs Tasks 2, 3 and 4. Tasks 1–3 are independent of one another and may be done in any order.
