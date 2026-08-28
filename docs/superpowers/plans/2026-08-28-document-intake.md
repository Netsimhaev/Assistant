# Document Intake and Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A file arrives, is stored as it came, is parsed in an isolated child process under caps, and its artefacts are written beside a record that says what happened — with a CLI that actually calls it.

**Architecture:** One entry point, `ingestDocument`, orchestrates: sniff the media type from content, deduplicate by hash, store under the reader's own document root, hand the file to a short-lived child process chosen from a positive registry, and write `document_artifacts` rows. Rejection is a recorded status, never a thrown exception. The child is capped on memory, wall time and output size by the parent, which does not trust it to stop itself.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` in every relative import), Postgres 17 via `pg`, zod, vitest against a real `assistant_test` database, `node:child_process`, plus two new parsing dependencies admitted in Task 1.

**Spec:** [docs/superpowers/specs/2026-08-28-document-intake-design.md](../specs/2026-08-28-document-intake-design.md) — read it alongside this plan; every task argues from it.

## Global Constraints

Copied from `CLAUDE.md`; every task's requirements implicitly include these.

- **`.js` in every relative import**, including from `.ts` files. Required by `NodeNext` + `"type": "module"`.
- **`noUncheckedIndexedAccess`** — index access is `T | undefined`; DB code must write `rows[0]?.x`.
- **`exactOptionalPropertyTypes`** — never assign `undefined` to an optional property. Use conditional spread.
- **`verbatimModuleSyntax`** — types with `import type`, values with `import`. Never mixed.
- **DB row convention:** a private `interface XRow` plus a `toX(row)` function per module. SQL `snake_case`, TypeScript `camelCase`.
- **Hebrew for humans, English for code.** Rejection reasons that a person reads are Hebrew; identifiers, comments and internal error codes are English.
- **Positive controls only.** Never "everything that is not X". A value that could not be read is never a permissive value.
- **Tests need real Postgres.** `npm test` runs against `TEST_DATABASE_URL`. `resetDatabase()` truncates between tests.
- **A new table must be added to `resetDatabase()`** in `src/test/db.ts`, or every test that writes it leaks into the next.
- **`npm run typecheck` and `npm test` must both pass before any task is reported done.**
- **Caps are the spec's, verbatim:** original 25MB · child memory 256MB · child wall time 30s · child output 32MB · inflated archive 200MB · archive entries 2,000 · per-entry ratio 120:1 · sheets 50 · rows per sheet 50,000 · characters per cell 32,768.

---

### Task 1: Admit the two parsing dependencies

The project holds six dependencies. Parsing untrusted input is a security decision, so the libraries are admitted against hard criteria before any code depends on them: **no network, no code evaluation, permissive licence, works under a memory cap.**

**Files:**
- Modify: `package.json`
- Test: `src/documents/dependencies.test.ts`
- Fixtures: `src/documents/fixtures/tiny.xlsx`, `src/documents/fixtures/tiny.docx`

**Interfaces:**
- Produces: two admitted packages. `exceljs` and `mammoth` are the candidates; **substitute if either fails a criterion** and record the substitution in the commit message.

- [ ] **Step 1: Create the two fixtures**

Generate them with the libraries themselves in a throwaway script, or commit two minimal files created by hand in Excel/Word. `tiny.xlsx` must contain: two sheets (one hidden), a formula cell with a cached value, a date cell, and a merged pair. `tiny.docx` must contain: a heading, a bullet list, a two-column table, and one tracked change.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('the admitted parsing libraries', () => {
  it('reads a workbook without evaluating its formulas', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fixture('tiny.xlsx'));
    expect(wb.worksheets.length).toBe(2);
  });

  it('reads a document and keeps its structure', async () => {
    const { value } = await mammoth.convertToHtml({ path: fixture('tiny.docx') });
    expect(value).toContain('<table');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run src/documents/dependencies.test.ts`
Expected: FAIL — `Cannot find package 'exceljs'`.

- [ ] **Step 4: Install and re-run**

```bash
npm install exceljs mammoth
npx vitest run src/documents/dependencies.test.ts
```
Expected: PASS.

- [ ] **Step 5: Record the admission decision**

Append to the spec's §9 the resolved versions and one line per criterion confirming it holds. If a candidate was replaced, say which and why.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/documents/
git commit -m "Admit two parsing dependencies, against stated criteria"
```

---

### Task 2: The schema

**Files:**
- Create: `src/db/migrations/012_documents.sql`
- Modify: `src/test/db.ts` (truncate list)
- Create: `src/documents/store.ts`
- Test: `src/documents/store.test.ts`

**Interfaces:**
- Produces:
  - `type DocumentStatus = 'pending' | 'extracted' | 'rejected'`
  - `type ArtifactKind = 'text' | 'table' | 'outline'`
  - `interface DocumentRecord { documentId, businessId, source, originalName, mediaType, sha256, byteSize, storedPath, status, reason: string | null }`
  - `interface DocumentArtifact { ordinal: number; kind: ArtifactKind; partName: string | null; content: unknown; flags: string[] }`
  - `insertDocument(input, options?): Promise<DocumentRecord>`
  - `findBySha(sha256, options?): Promise<DocumentRecord | null>`
  - `markExtracted(documentId, artifacts, options?): Promise<void>` — writes artefacts and flips status **in one transaction**
  - `markRejected(documentId, reason, options?): Promise<void>`
  - `loadArtifacts(documentId, options?): Promise<DocumentArtifact[]>`

- [ ] **Step 1: Write the failing test**

```ts
it('writes the artefacts and the status together, or neither', async () => {
  const doc = await insertDocument(
    { source: 'manual', originalName: 'מחירון.xlsx', mediaType: XLSX, sha256: 'a'.repeat(64),
      byteSize: 120, storedPath: 'test-business/DOC-1/original.xlsx' },
    { businessId: BUSINESS },
  );
  expect(doc.status).toBe('pending');

  await markExtracted(doc.documentId, [
    { ordinal: 0, kind: 'table', partName: 'מחירים', content: { rows: [] }, flags: ['hidden_sheet'] },
  ], { businessId: BUSINESS });

  const artifacts = await loadArtifacts(doc.documentId, { businessId: BUSINESS });
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0]?.flags).toEqual(['hidden_sheet']);
});

it('returns the existing document rather than storing the same bytes twice', async () => {
  const first = await insertDocument({ ...INPUT, sha256: 'b'.repeat(64) }, { businessId: BUSINESS });
  const again = await findBySha('b'.repeat(64), { businessId: BUSINESS });
  expect(again?.documentId).toBe(first.documentId);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/documents/store.test.ts`
Expected: FAIL — `Cannot find module './store.js'`.

- [ ] **Step 3: Write the migration**

Two tables exactly as spec §3.1 and §3.2. A unique index on `(business_id, sha256)`. Primary key on `document_artifacts` is `(business_id, document_id, ordinal)`. Open the file with a comment block explaining why the hash is unique per business and why artefacts are `jsonb` — the migrations in this repo all carry that reasoning.

- [ ] **Step 4: Add both tables to `resetDatabase()`**

In `src/test/db.ts`, add `document_artifacts` and `documents` to the `TRUNCATE TABLE` list — artefacts first, since it references documents.

- [ ] **Step 5: Write `store.ts`**

Follow the repo convention: private `DocumentRow` / `ArtifactRow` interfaces plus `toDocument(row)` / `toArtifact(row)`. Every query takes `businessId` as a bound parameter. `markExtracted` uses `withTransaction` so the artefact rows and the status flip land together.

- [ ] **Step 6: Run migration and tests**

```bash
npm run migrate:test
npx vitest run src/documents/store.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations/012_documents.sql src/test/db.ts src/documents/
git commit -m "A document and its extracted parts get a place to live"
```

---

### Task 3: Media type from content, and the extractor registry

**Files:**
- Create: `src/documents/media-type.ts`
- Create: `src/documents/registry.ts`
- Test: `src/documents/media-type.test.ts`, `src/documents/registry.test.ts`

**Interfaces:**
- Produces:
  - `sniffMediaType(head: Buffer, originalName: string): string | null` — null means unknown
  - `const SUPPORTED: Record<string, ExtractorId>` where `type ExtractorId = 'xlsx' | 'docx' | 'csv' | 'passthrough'`
  - `extractorFor(mediaType: string): ExtractorId | null`

- [ ] **Step 1: Write the failing tests**

```ts
it('reads the type from the bytes, not the extension', () => {
  const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  expect(sniffMediaType(zipHeader, 'prices.xlsx')).toBe(XLSX);
  // A text file wearing a spreadsheet's name is not a spreadsheet.
  expect(sniffMediaType(Buffer.from('שלום'), 'prices.xlsx')).toBe('text/plain');
});

it('returns null for a type nobody named', () => {
  expect(sniffMediaType(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'x.bin')).toBeNull();
});

it('has an extractor for every supported type, and no orphan extractors', () => {
  for (const mediaType of Object.keys(SUPPORTED)) {
    expect(extractorFor(mediaType), mediaType).not.toBeNull();
  }
  const used = new Set(Object.values(SUPPORTED));
  expect([...used].sort()).toEqual(['csv', 'docx', 'passthrough', 'xlsx']);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/documents/media-type.test.ts src/documents/registry.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`sniffMediaType` checks magic bytes first: `PK\x03\x04` means a ZIP container, and the extension then decides xlsx vs docx **only among ZIP containers** — an extension never promotes a non-ZIP file to a ZIP format. Valid UTF-8 with no control bytes is `text/plain`, refined to `text/csv` or `application/json` by extension. Anything else is `null`.

`extractorFor` uses `Object.hasOwn`, not a bare index — the same rule the SDK tool map now follows, and for the same reason: a lookup whose contract is "absent means unsupported" must not answer for inherited names.

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/documents/
git commit -m "A file's type comes from its bytes, and only named types are parsed"
```

---

### Task 4: The archive safety pre-check

**Files:**
- Create: `src/documents/archive-guard.ts`
- Test: `src/documents/archive-guard.test.ts`
- Fixture: `src/documents/fixtures/bomb.xlsx` — a ZIP whose central directory declares a >200MB inflated size

**Interfaces:**
- Produces:
  - `type ArchiveVerdict = { ok: true } | { ok: false; code: 'archive_too_large' | 'archive_too_many_entries' | 'archive_ratio' ; detail: string }`
  - `inspectArchive(path: string): Promise<ArchiveVerdict>`

- [ ] **Step 1: Write the failing test**

```ts
it('refuses an archive that would inflate past the ceiling, without unpacking it', async () => {
  const verdict = await inspectArchive(fixture('bomb.xlsx'));
  expect(verdict.ok).toBe(false);
  if (!verdict.ok) expect(verdict.code).toBe('archive_too_large');
});

it('admits an ordinary workbook', async () => {
  expect((await inspectArchive(fixture('tiny.xlsx'))).ok).toBe(true);
});
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Read the ZIP central directory only — declared uncompressed size and compressed size per entry — and sum. Never inflate. Three checks in this order: total inflated size > 200MB, entry count > 2,000, any entry's ratio > 120:1. The declared sizes are attacker-controlled, which is exactly why crossing them is a refusal rather than a budget: a liar gets rejected either way, since the child's own output cap catches an under-declared entry later.

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/documents/
git commit -m "An archive states how far it unpacks before anything unpacks it"
```

---

### Task 5: The isolated runner

**Files:**
- Create: `src/documents/run-extractor.ts`
- Create: `src/documents/extract-child.ts` — the child entry point
- Test: `src/documents/run-extractor.test.ts`

**Interfaces:**
- Consumes: `ExtractorId` (Task 3)
- Produces:
  - `type ExtractOutcome = { ok: true; artifacts: DocumentArtifact[] } | { ok: false; code: 'extractor_timeout' | 'extractor_crashed' | 'extractor_output_too_large' | 'extractor_failed'; detail: string }`
  - `runExtractor(extractor: ExtractorId, sourcePath: string, options?: { timeoutMs?: number; memoryMb?: number; maxOutputBytes?: number }): Promise<ExtractOutcome>`

- [ ] **Step 1: Write the failing tests**

```ts
it('kills a child that will not stop, and says so', async () => {
  const outcome = await runExtractor('passthrough', fixture('hang.txt'), { timeoutMs: 200 });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.code).toBe('extractor_timeout');
});

it('records a crash rather than throwing it', async () => {
  const outcome = await runExtractor('passthrough', '/no/such/file');
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.code).toBe('extractor_failed');
});

it('stops reading a child that floods stdout', async () => {
  const outcome = await runExtractor('passthrough', fixture('huge.txt'), { maxOutputBytes: 1024 });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.code).toBe('extractor_output_too_large');
});
```

For the hang fixture, have `extract-child.ts` recognise the literal filename `hang.txt` under a test-only environment flag, or spawn a stub child in the test — whichever the implementer finds cleaner, but the timeout must be proven against a child that really does not exit.

- [ ] **Step 2: Run and watch them fail** — Expected: FAIL, module not found.

- [ ] **Step 3: Implement the parent**

`spawn(process.execPath, ['--max-old-space-size=256', childPath, extractor, sourcePath], { env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] })`.

The parent owns all three limits: a `setTimeout` that sends `SIGKILL` (not `SIGTERM` — a wedged parser does not handle signals), a byte counter on the stdout stream that kills once `maxOutputBytes` is crossed, and the memory flag. Clear the timer in a `finally`. The child's stderr is captured into `detail`, truncated to 2KB.

The child's environment carries `PATH` and nothing else — the same rule `know-reader.ts` already applies, so the database URL and any API key never reach a process parsing an untrusted file.

- [ ] **Step 4: Implement the child**

Reads `argv[2]` (extractor id) and `argv[3]` (path), dispatches to the extractor module, writes one JSON object to stdout, exits 0. Any throw → message to stderr, exit 1. The child never touches the database and never opens a socket.

- [ ] **Step 5: Run tests** — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/documents/
git commit -m "Parsing runs somewhere it can be killed, and the parent does the killing"
```

---

### Task 6: The spreadsheet extractor

**Files:**
- Create: `src/documents/extractors/xlsx.ts`
- Test: `src/documents/extractors/xlsx.test.ts`

**Interfaces:**
- Produces: `extractXlsx(path: string): Promise<DocumentArtifact[]>` — one `table` artefact per sheet, `partName` is the sheet name.
- Cell shape: `{ v: string | number | boolean | null; t: 'string' | 'number' | 'date' | 'bool' | 'empty' }`. A date's `v` is an ISO 8601 string.

- [ ] **Step 1: Write the failing test**

```ts
it('keeps the cached value of a formula and never recomputes it', async () => {
  const [sheet] = await extractXlsx(fixture('tiny.xlsx'));
  const rows = (sheet?.content as { rows: Cell[][] }).rows;
  expect(rows[1]?.[2]).toEqual({ v: 30, t: 'number' });
});

it('includes a hidden sheet and flags it', async () => {
  const artifacts = await extractXlsx(fixture('tiny.xlsx'));
  const hidden = artifacts.find((a) => a.flags.includes('hidden_sheet'));
  expect(hidden?.partName).toBe('פנימי');
});

it('spreads a merged cell across every cell it covered', async () => {
  const [sheet] = await extractXlsx(fixture('tiny.xlsx'));
  const rows = (sheet?.content as { rows: Cell[][] }).rows;
  expect(rows[0]?.[0]?.v).toBe(rows[0]?.[1]?.v);
});

it('normalises a date to ISO rather than leaving a serial number', async () => {
  const [sheet] = await extractXlsx(fixture('tiny.xlsx'));
  const rows = (sheet?.content as { rows: Cell[][] }).rows;
  expect(rows[1]?.[3]).toEqual({ v: '2026-01-15', t: 'date' });
});
```

- [ ] **Step 2: Run and watch them fail** — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Read with the admitted library. For each cell take the **cached result**, never evaluate. Map the library's cell types to the four above; a cell with a formula and no cached value is `{ v: null, t: 'empty' }`. Expand merges by copying the anchor's value into every covered coordinate. Trim wholly-empty leading and trailing rows and columns; keep interior blanks. Set `hidden_sheet` on a sheet whose state is not visible, and `has_macros` on the workbook's first artefact when a macro part exists. Apply the sheet, row and cell caps from Global Constraints, setting `truncated` when any bites.

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/documents/extractors/
git commit -m "A spreadsheet becomes a table that answers questions about its cells"
```

---

### Task 7: The document extractor

**Files:**
- Create: `src/documents/extractors/docx.ts`
- Test: `src/documents/extractors/docx.test.ts`

**Interfaces:**
- Produces: `extractDocx(path: string): Promise<DocumentArtifact[]>` — one `text` artefact whose `content` is `{ blocks: Block[] }` with `type Block = { kind: 'heading'; level: number; text: string } | { kind: 'paragraph'; text: string } | { kind: 'list'; items: string[] }`, plus one `table` artefact per table, shaped exactly as Task 6's.

- [ ] **Step 1: Write the failing test**

```ts
it('keeps a heading a heading', async () => {
  const [body] = await extractDocx(fixture('tiny.docx'));
  const blocks = (body?.content as { blocks: Block[] }).blocks;
  expect(blocks[0]).toEqual({ kind: 'heading', level: 1, text: 'הסכם התקשרות' });
});

it('keeps a table a table rather than smearing it into a line', async () => {
  const artifacts = await extractDocx(fixture('tiny.docx'));
  expect(artifacts.filter((a) => a.kind === 'table')).toHaveLength(1);
});

it('includes tracked changes and flags them', async () => {
  const artifacts = await extractDocx(fixture('tiny.docx'));
  expect(artifacts.some((a) => a.flags.includes('tracked_changes'))).toBe(true);
});
```

- [ ] **Step 2: Run and watch them fail** — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Convert with the admitted library, then walk the result into blocks. Headings keep their level. Lists collapse into one `list` block per contiguous run. Tables become `table` artefacts with the same cell shape as the spreadsheet extractor, so a consumer reads both the same way. Detect tracked-change and comment parts in the package and set `tracked_changes`; the inserted and deleted text is kept in the block text. Linked fields and external references are not resolved.

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/documents/extractors/
git commit -m "A document keeps the structure that carries half its meaning"
```

---

### Task 8: CSV and plain passthrough

**Files:**
- Create: `src/documents/extractors/csv.ts`, `src/documents/extractors/passthrough.ts`
- Test: `src/documents/extractors/simple.test.ts`

**Interfaces:**
- Produces: `extractCsv(path)` → one `table` artefact, same cell shape. `extractPassthrough(path)` → one `text` artefact with `{ blocks: [{ kind: 'paragraph', text }] }`.

- [ ] **Step 1: Write the failing test**

```ts
it('keeps a ragged row and flags it rather than dropping it', async () => {
  const [table] = await extractCsv(fixture('ragged.csv'));
  const rows = (table?.content as { rows: Cell[][] }).rows;
  expect(rows).toHaveLength(3);
  expect(table?.flags).toContain('ragged_rows');
});

it('detects a semicolon separator from the content', async () => {
  const [table] = await extractCsv(fixture('semicolons.csv'));
  const rows = (table?.content as { rows: Cell[][] }).rows;
  expect(rows[0]).toHaveLength(3);
});
```

- [ ] **Step 2: Run and watch them fail** — Expected: FAIL.

- [ ] **Step 3: Implement**

Separator chosen by counting candidates in the first five lines and taking the one with the most consistent field count. Encoding UTF-8, with a BOM stripped if present. A row whose field count differs from the modal count is kept as-is and sets `ragged_rows` — dropping it would silently lose data, which is the failure this project keeps refusing.

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/documents/extractors/
git commit -m "A ragged row is kept and marked, never quietly dropped"
```

---

### Task 9: The structural outline

**Files:**
- Create: `src/documents/outline.ts`
- Test: `src/documents/outline.test.ts`

**Interfaces:**
- Consumes: `DocumentArtifact[]` from any extractor
- Produces: `buildOutline(artifacts: DocumentArtifact[]): DocumentArtifact` — a single `outline` artefact, `partName: null`

- [ ] **Step 1: Write the failing test**

```ts
it('says what the file is without calling any model', async () => {
  const artifacts = await extractXlsx(fixture('tiny.xlsx'));
  const outline = buildOutline(artifacts);

  expect(outline.kind).toBe('outline');
  const content = outline.content as OutlineContent;
  expect(content.parts.map((p) => p.name)).toEqual(['מחירים', 'פנימי']);
  expect(content.parts[0]?.rowCount).toBe(4);
  expect(content.parts[0]?.headers).toEqual(['פריט', 'כמות', 'מחיר', 'תאריך']);
  expect(content.parts[0]?.numericRanges?.['מחיר']).toEqual({ min: 10, max: 30 });
  expect(content.flags).toContain('hidden_sheet');
});
```

- [ ] **Step 2: Run and watch it fail** — Expected: FAIL.

- [ ] **Step 3: Implement**

`OutlineContent = { parts: Array<{ name: string | null; kind: ArtifactKind; rowCount?: number; headers?: string[]; numericRanges?: Record<string, { min: number; max: number }>; dateRange?: { from: string; to: string } }>; flags: string[] }`.

Headers are the first row when every cell in it is a non-empty string and the row below has at least one non-string — otherwise there are no headers, stated rather than guessed. Numeric and date ranges are computed per column that is wholly of that type. `flags` is the union of every artefact's flags.

Not a model call anywhere in this file. That is the property that makes it testable and makes it work on a machine with no key.

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/documents/
git commit -m "What is this file, answered without a model"
```

---

### Task 10: `ingestDocument`

**Files:**
- Create: `src/documents/ingest.ts`
- Test: `src/documents/ingest.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `ingestDocument(input: { path: string; source: 'manual' | 'mail' | 'api'; originalName?: string }, options?: { businessId?: string; documentRoot?: string }): Promise<DocumentRecord>`

- [ ] **Step 1: Write the failing tests**

```ts
it('stores, extracts and records in one pass', async () => {
  const doc = await ingestDocument({ path: fixture('tiny.xlsx'), source: 'manual' }, OPTS);
  expect(doc.status).toBe('extracted');
  const artifacts = await loadArtifacts(doc.documentId, OPTS);
  expect(artifacts.some((a) => a.kind === 'outline')).toBe(true);
});

it('rejects an unsupported type and keeps the file anyway', async () => {
  const doc = await ingestDocument({ path: fixture('mystery.bin'), source: 'manual' }, OPTS);
  expect(doc.status).toBe('rejected');
  expect(doc.reason).toContain('סוג');
  expect(existsSync(join(ROOT, doc.storedPath))).toBe(true);
});

it('never lets the original name become a path', async () => {
  const doc = await ingestDocument(
    { path: fixture('tiny.xlsx'), source: 'manual', originalName: '../../escape.xlsx' },
    OPTS,
  );
  expect(doc.storedPath).not.toContain('..');
  expect(doc.originalName).toBe('../../escape.xlsx');
});

it('returns the same document for the same bytes', async () => {
  const first = await ingestDocument({ path: fixture('tiny.xlsx'), source: 'manual' }, OPTS);
  const second = await ingestDocument({ path: fixture('tiny.xlsx'), source: 'mail' }, OPTS);
  expect(second.documentId).toBe(first.documentId);
});
```

- [ ] **Step 2: Run and watch them fail** — Expected: FAIL.

- [ ] **Step 3: Implement**

Order matters and is the whole design: hash the bytes → return early if that hash already exists for this business → check the 25MB size cap → sniff the media type from the first bytes → store under `<documentRoot>/<businessId>/<documentId>/original.<ext>` where the extension comes from the *sniffed* type → for a ZIP-container type run `inspectArchive` **before** spawning anything → `runExtractor` → `buildOutline` over the artefacts → `markExtracted`.

Every failure path calls `markRejected` with a Hebrew reason and returns the record. Nothing throws for a bad document: the caller of a batch must not lose the rest of the batch to one poisoned file. A genuine fault — the database being down — still throws, because that is not a property of the document.

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/documents/
git commit -m "One entry point: stored, sniffed, guarded, parsed, recorded"
```

---

### Task 11: The caller, and the documentation

Four components in this project were built with nothing calling them. This task is what keeps this from being the fifth.

**Files:**
- Create: `src/cli/ingest-doc.ts`
- Modify: `package.json` (script `doc:ingest`)
- Modify: `docs/01-agents.md` (the know.reader entry), `CLAUDE.md`
- Test: `src/cli/ingest-doc.test.ts`

**Interfaces:**
- Consumes: `ingestDocument`
- Produces: `npm run doc:ingest -- <path> [--source mail|manual|api]`

- [ ] **Step 1: Write the failing test**

```ts
it('prints the document id and its status', async () => {
  const lines: string[] = [];
  await runIngestCli([fixture('tiny.xlsx')], { log: (l) => lines.push(l), businessId: BUSINESS });
  expect(lines.join('\n')).toMatch(/DOC-[0-9A-Z]+/);
  expect(lines.join('\n')).toContain('extracted');
});

it('exits with a message when the file does not exist', async () => {
  const lines: string[] = [];
  await expect(runIngestCli(['/no/such/file'], { log: (l) => lines.push(l) })).rejects.toThrow();
});
```

- [ ] **Step 2: Run and watch them fail** — Expected: FAIL.

- [ ] **Step 3: Implement**

Export `runIngestCli(argv, deps)` so the test drives it without spawning a process — the pattern `seed-job.ts` already uses. The module-level entry point calls it only when run directly, using the same `import.meta.url` guard `seed-job.ts` has.

Print: the document id, the status, the media type, and one line per artefact (`kind` and `partName`). On rejection print the Hebrew reason.

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Update the documentation**

In `docs/01-agents.md`, replace the know.reader coverage table's "Excel · Word ❌" row: they are read now, through intake, and the entry should say the conversion happens on arrival rather than as a tool the agent calls. In `CLAUDE.md`, add the intake invariants: type from bytes not extension, archive inspected before unpacking, parsing in a capped child, rejection as a recorded status, and the original name never becoming a path.

- [ ] **Step 6: Full verification**

```bash
npm run typecheck
npm test
```
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/cli/ingest-doc.ts package.json docs/ CLAUDE.md
git commit -m "A command that ingests a file, so the pipeline has a caller"
```

---

## Self-review notes

**Spec coverage.** §3.1 → Task 2 · §3.2 → Task 2 · §3.3 → Task 3 · §3.4 → Task 5 · §3.5 → Task 10 (storage layout) · §4.1 → Task 6 · §4.2 → Task 7 · §4.3 → Task 8 · §5.1 → Task 3 · §5.2 → Task 4 · §5.3 → Tasks 6–8 (caps) · §5.4 → Task 5 (the child parses; entity resolution is disabled in the extractors) · §5.5 → Task 10 · §6 → Task 9 · §7 → Task 11 · §8 → Task 10 · §9 → Task 1 · §10 → every task.

**One gap found and closed:** §5.4 (XML external entities) had no task of its own. It is not a separate component — it is a configuration of whichever parser the admitted libraries use — so it belongs to Task 1's criteria and to the extractors. **Task 1 must verify that neither library resolves external entities by default, and record the finding.** If either does, disabling it is part of Task 6 or 7.

**Type consistency.** The cell shape `{ v, t }` is defined in Task 6 and reused verbatim in Tasks 7 and 8. `DocumentArtifact` is defined in Task 2 and consumed everywhere after. `ExtractorId` is defined in Task 3 and consumed by Task 5.
