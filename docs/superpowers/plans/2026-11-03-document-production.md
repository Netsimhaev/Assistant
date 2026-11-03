# Document Production (Word, PDF, Excel, Presentations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner asks for a document. The assistant drafts a structured description of it, builds a native `.xlsx`/`.docx`/`.pptx`/`.pdf` from that description in code, and runs two checks: a mechanical one, and a second-eye judge that looks at page images. The owner then gets the exact file for review. On approval the file is mailed with the exact bytes attached, or saved inside a configured base folder.

**Architecture:**
- The model never writes a file and never runs code. `prod.docs` returns a `DocumentSpec` (zod `.strict()`), and deterministic renderers build the file from it: `exceljs`, `docx`, `pptxgenjs`, and HTML→PDF in headless Chromium.
- Production runs in its own resumable scheduler loop. Every stage's state is stored, so a crash resumes instead of paying again.
- Approval reuses the boss-command machinery unchanged: a delivery job carries a pre-`confirmed` `instruction_confirmations` row, and `confirmedCommandCovers` passes it. `src/policy/engine.ts` is not touched.

**Tech Stack:** TypeScript (NodeNext ESM), Postgres 17, vitest on a real DB.
- Existing libraries: `exceljs`, `mammoth`, `pdfjs-dist`.
- New libraries: `docx` (MIT), `pptxgenjs` (MIT), `playwright-core` (Apache-2.0; uses a Chromium installed on the server).
- LibreOffice headless, used only to render page images for check 2.

**Spec:** `docs/superpowers/specs/2026-11-03-document-production-design.md`. Its §2 decisions D1–D19 and §12 rulings C1–C19 are binding. Where this plan and the spec disagree, the spec wins.

## Global Constraints

- `src/policy/engine.ts` is NOT modified. Nothing gets a new gate exemption.
- The model never writes a file, emits XML, or runs code. `code_execution` stays in `UNOWNED_TOOLS`.
- Direction and language are derived in code from `spec.language`, as follows. The spec has no direction field.
  - `he` → RTL: sheet `rightToLeft`, paragraph `bidi` and right alignment, pptx `rtlMode`, HTML `dir="rtl" lang="he"`.
  - `en` → LTR.
- The default language is `he`. It is `en` only when the owner's instruction asks for English (D2).
- Every document is born from a boss instruction. The writer check reads the DB: `jobs.provenance = 'boss'` AND a `boss_instructions` row exists in the same business (pattern: `assertLedgerWriter`).
- The file the owner reviews is byte-identical to the file sent or saved (D18). The sha256 is checked from disk at send/save time.
- Everything runs locally: no cloud converter, no network from renderers (D16).
  - Chromium loads with JavaScript disabled, and every non-local request is blocked.
  - Images and fonts reach the page only as data URLs or local files that the renderer chose.
- No overwrites: saved files are opened with flag `wx`, adding ` (2)`, ` (3)` and so on as needed.
- Owner-facing strings are in Hebrew; identifiers, comments and errors are in English. Kinds and statuses reach the owner only through `src/domain/labels.ts` (exhaustive `Record`s).
- Money goes through `formatMinor` in the active charter's currency. Times are in charter `identity.timezone`.
- `.js` on every relative import. Compile under `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`. Every DB module uses a private `interface XRow` + `toX(row)`. Each zod schema and its inferred type share one name.
- Migration: `src/db/migrations/053_produced_documents.sql`. Never edit earlier migrations.
- Every live billed call refuses under `config.isTest` (`refuseUnderTest`).
- Every negative test also asserts that the code under test RAN (CLAUDE.md "מבחן שלילי שמחזיק גם בלי הקוד שהוא בודק אינו מבחן").
- Tests never require LibreOffice or Chromium. Both sit behind injected seams (`PdfPrinter`, `PageRenderer`). The real binaries run only in `npm run doc:render-check`.
- Caps (§10): `DOCUMENTS_PER_DAY` = 20. Per document: 20 sheets, 5,000 rows per sheet, 60 pages, 40 slides. Exceeding a cap is a refusal with a Hebrew reason, never truncation.
- Attachments: at most 20MB in total on every provider, and at most 3MB on Microsoft Graph (C8).
- Fix loop: at most 2 automatic fix attempts (C6).

## Review Focus

1. **A Hebrew document with mixed English words, numbers, percentages, ₪ and parentheses.** Expected: every run reads in the right order, and no digit sequence is reversed. Task 9 pins this with a `profit_table` and a `contract` spec containing `"שולחן 160 ס\"מ"`, `"39%"`, `"₪1,890"`, `"(ראה סעיף 4.2)"` and `"Office Pro"`. The test asserts the extracted text order of each against the spec.
2. **A formula that references an empty cell, divides by zero, or references itself.** Expected: check 1 fails with a named finding, and nothing is shown as "ready". Task 2 and Task 9 test each case.
3. **An instruction folder like `../../Windows`, `C:\x`, `חוזים/../..`, `CON`, a symlink pointing out of the base folder, or a 6-segment path.** Expected: a refusal in Hebrew, and nothing is written. Task 13 tests each one.
4. **The owner presses "שלחי" on a card whose version was superseded by a fix, or whose file changed on disk.** Expected: a refusal, and nothing leaves. Task 14 (superseded) and Task 12 (hash mismatch) test this.
5. **"שלחי" in WhatsApp while a mail-reply card is also open.** Expected: `SEVERAL_OPEN_REFUSAL`, and neither card is approved. Task 15 tests this.

---

### Task 1: Migration, domain types, labels

**Files:**
- Create: `src/db/migrations/053_produced_documents.sql`, `src/domain/document-spec.ts`, `src/domain/document-spec.test.ts`
- Modify: `src/domain/labels.ts`, `src/test/db.ts` (TRUNCATE list)

**Interfaces — Produces:**
- `DocumentFormat = z.enum(['xlsx','docx','pptx','pdf'])`
- `DocumentLanguage = z.enum(['he','en'])`
- `DocumentKind = z.enum(['contract','protocol','price_list','profit_table','report','letter','presentation','other'])`
- `StyleTheme = z.enum(['clean','formal','bold','minimal'])`
- `AccentColor = z.enum(['navy','teal','green','burgundy','gray','orange'])`
- `SourceRef` = discriminated union `{kind:'instruction'} | {kind:'document', documentId, ordinal} | {kind:'memory', memoryId}`. Ids go through `SafeLookupKey`.
- `Cell` = `{v: number, src: SourceRef} | {t: string} | {d: 'YYYY-MM-DD'} | {f: string}`. A formula string has no leading `=`.
- `XlsxSpec`: sheets → tables. Each table has `{title?, header: string[], rows: Cell[][], totals?: Cell[], numberFormat?: per-column 'int'|'money'|'percent'|'decimal2'}`, plus optional `conditional?: {column, rule:'negative_red'|'top3_bold'}[]` and `chart?: {type:'bar'|'line'|'pie', column, labelColumn}`.
- `Block` (docx/pdf) = heading(level 1–3) | paragraph | list(ordered|bullet, items) | table(header, rows of Cell) | pageBreak | image(documentId) | clause(number auto, title, text).
  - Text in a paragraph/clause is a string. Every number in it must appear among the spec's grounded values (Task 3).
- `Slide` = title | titleBullets | table | chart | imageText | collage(2–6 documentIds) | paragraph.
- `DocumentSpec` = discriminated union on `format`, `.strict()` at every level. Common fields: `language`, `kind`, `title` (≤200), `filename` (≤120), `style: {theme, accent}`, `sources: SourceRef[]`.
  - The contract kind requires `legalBasis: {law: string, note?: string}[]` with at least 1 entry.
- `ProductionStage = z.enum(['queued','drafting','building','check1','check2','fixing','ready','failed_checks','failed'])`
- In `labels.ts`: `documentKindLabel: Record<DocumentKind,string>`, `documentFormatLabel: Record<DocumentFormat,string>`, `productionStageLabel: Record<ProductionStage,string>`.

**Migration 053 tables** (all keyed by `business_id`):
- `document_productions` (one per request):
  - identity and links: `production_id` PK, `business_id`, `origin_job_id`, `instruction_text`, `text_origin`
  - what was asked: `format`, `language`, `kind`, `destination jsonb` (`{mode:'send', to, subject, body} | {mode:'save', folder}`), `source_document_ids text[]`
  - progress: `stage`, `attempt int default 0`, `findings jsonb`
  - lease and timing: `lease_until`, `leased_by`, `created_at`, `updated_at`
  - `CHECK stage IN (...)`
- `document_versions`:
  - `version_id` PK, `production_id` FK, `version_no`
  - `spec jsonb`, `stored_path` (relative), `sha256 CHECK '^[0-9a-f]{64}$'`, `size_bytes`
  - `check1 jsonb`, `check2 jsonb`, `superseded_at`, `created_at`
  - `UNIQUE(production_id, version_no)`
- `document_cards`:
  - `card_id` PK, `business_id`, `version_id` FK UNIQUE
  - `state CHECK IN ('open','approved','saved','fix_requested','superseded','failed_send')`
  - `delivery_plans jsonb` (one per destination option, with `planHash`)
  - delivery state per channel: `whatsapp_state`, `email_state`, `whatsapp_delivered_at`
  - `seen_at`, `created_at`, `decided_at`, `delivery_job_id`
- `document_settings`:
  - `business_id` PK, `to_whatsapp`, `to_email`, `to_screen`, `base_folder text NULL`, `updated_at`
  - `CHECK (to_whatsapp OR to_email OR to_screen)` named `document_settings_at_least_one_channel`.

- [ ] **Step 1: Write failing tests** in `document-spec.test.ts`:
  - `rejects an unknown key at every level` (top, sheet, cell, block)
  - `contract without legalBasis fails`
  - `cell number without src fails`
  - `formula cell is a string without leading =`
  - `language defaults are not inferred — language is required`
  - `a SourceRef documentId of "__proto__" fails`
  - `labels are exhaustive` (compile-level by Record; runtime asserts every enum option has a non-empty Hebrew label)
  - a migration test in `src/db/migrations.test.ts` style: `document_settings refuses a row with all three channels false`
- [ ] **Step 2: Run** `TEST_DATABASE_URL="$SDD" npx vitest run src/domain/document-spec.test.ts --no-file-parallelism`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the schemas, migration and labels. Add the four tables to `resetDatabase` TRUNCATE.
- [ ] **Step 4: Run** `npm run migrate:test` on the dedicated DB, then the tests. Expected: PASS. `npm run typecheck` is clean.
- [ ] **Step 5: Commit** — skipped while the owner holds git, report "uncommitted".

### Task 2: Formula language — parser, whitelist, evaluator

**Files:** Create `src/production/formula.ts`, `src/production/formula.test.ts`.

**Decision:** We write our own small evaluator and take no dependency. It removes the licence question (HyperFormula is GPL), it is a supply-chain surface we control, and the grammar is small.

**Interfaces — Produces:**
- `FORMULA_FUNCTIONS: readonly string[]` = `SUM, AVERAGE, MIN, MAX, ROUND, ROUNDUP, ROUNDDOWN, IF, IFERROR, AND, OR, COUNT, COUNTA, COUNTIF, SUMIF, SUMIFS, SUMPRODUCT, ABS, INDEX, MATCH, VLOOKUP`
- `parseFormula(src: string): {ok: true, ast: FormulaAst} | {ok: false, problem: FormulaProblem}`
  - The grammar is numbers, strings, booleans, operators `+ - * / ^ & = <> < <= > >=` and unary `-`, `%` postfix, cell refs `A1`/`$A$1`, ranges `A1:B9`, sheet refs `'גיליון 1'!A1`, and function calls.
  - Anything else is a problem: an unknown function, an external workbook ref `[x]`, a defined name, `INDIRECT`/`OFFSET`/`HYPERLINK`/`WEBSERVICE`/`CALL`.
- `FormulaProblem` = `'unknown_function' | 'external_reference' | 'defined_name' | 'syntax'` + `detail`.
- `evaluateWorkbook(sheets: EvalSheet[]): Map<string /* 'Sheet!A1' */, EvalValue>`.
  - `EvalValue` = `number | string | boolean | {error: '#DIV/0!'|'#REF!'|'#VALUE!'|'#N/A'|'#CIRC!'|'#NUM!'}`.
  - A cycle yields `#CIRC!` on every member.
  - Excel semantics for empty cells: 0 in arithmetic, ignored by SUM/AVERAGE/COUNT.
- `referencedCells(ast): string[]`

- [ ] **Step 1: Failing tests:**
  - `SUM over a range with an empty cell = sum of the rest`
  - `A1/B1 with B1=0 → #DIV/0!`
  - `A1 = A1+1 → #CIRC!`
  - `IFERROR(1/0, 7) = 7`
  - `ROUND(2.345, 2) = 2.35`, `ROUND(-2.5,0) = -3` (Excel rounds half away from zero)
  - `VLOOKUP exact match and #N/A`
  - `SUMIFS with two criteria`
  - `cross-sheet ref with a Hebrew sheet name in quotes`
  - `INDIRECT("A1") → unknown_function`
  - `[Book2]Sheet1!A1 → external_reference`
  - `Total (defined name) → defined_name`
  - `every name in FORMULA_FUNCTIONS has at least one evaluating test` (iterate the exported list; this is an invariant)
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** `formula.ts`, pure TS, with no I/O.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** (uncommitted).

### Task 3: Spec validation and number grounding

**Files:** Create `src/production/validate-spec.ts`, `src/production/validate-spec.test.ts`.

**Interfaces — Consumes:** Task 1 schemas; Task 2 `parseFormula`/`evaluateWorkbook`; `numeric-grounding.ts` (existing — read its exports and reuse them; do not copy).

**Produces:**
- `validateSpec(spec: DocumentSpec, sources: GroundingSources): SpecProblem[]`
  - `GroundingSources` = `{instructionText: string, documents: {documentId, artifacts: {ordinal, text}[]}[], memories: {memoryId, body: string}[]}`
  - `SpecProblem` = `{code: SpecProblemCode, where: string /* e.g. 'sheet 1 row 3 col 2' */, detail: string}`.
  - `SpecProblemCode` = `'formula_problem' | 'ungrounded_number' | 'source_not_found' | 'cap_exceeded' | 'missing_structure' | 'unknown_image' | 'filename_invalid'`.
- `REQUIRED_STRUCTURE: Record<DocumentKind, (spec) => string[] /* missing parts, Hebrew */>`:
  - contract: parties, definitions, ≥1 clause, signatures, `legalBasis`
  - protocol: date, participants, decisions, tasks with owner and due date
  - other kinds: title only
- `CONTRACT_DISCLAIMER_HE = 'טיוטה — מומלץ שעורך דין יעבור עליה'` and `CONTRACT_DISCLAIMER_EN = 'Draft — we recommend a lawyer review it'`. Renderers append these; the model does not write them.
- `CAPS = {sheets: 20, rowsPerSheet: 5000, pages: 60, slides: 40}` (pages are checked after rendering in Task 9).

**Rules:**
- **Cell numbers:** a `{v, src}` cell must be found in its source. Instruction: the digit string appears in `instructionText`. Document: in that artifact's text. Memory: in its body. Matching normalises thousands separators and treats `1890` ≡ `1,890` ≡ `1890.00`.
- **Free text:** numbers in paragraph or clause text must appear in some source or in a formula result. Structural numbers (clause numbering, today's date) are exempt.
- **Image blocks:** must name a `documentId` in `sources`.

- [ ] **Step 1: Failing tests:**
  - `a price taken from the attached price list artifact passes`
  - `a price present nowhere fails with ungrounded_number`
  - `1,890 in text grounds against 1890 in the source`
  - `contract missing signatures lists 'חתימות' in missing_structure`
  - `21 sheets → cap_exceeded`
  - `a formula with INDIRECT → formula_problem`
  - `an image of a document not in sources → unknown_image`
  - `structural clause numbers are not flagged`
- [ ] **Steps 2–5:** run (FAIL) → implement → run (PASS) → commit (uncommitted).

### Task 4: XLSX renderer

**Files:** Create `src/production/render-xlsx.ts`, `src/production/render-xlsx.test.ts`.

**Produces:** `renderXlsx(spec: XlsxSpec & {language, title, style}): Promise<Buffer>`.

**Rules:**
- Each worksheet gets `views: [{rightToLeft: language === 'he'}]`.
- Each formula cell is written as `{formula, result}`, with the result from `evaluateWorkbook`. A cell whose evaluation is an error is not rendered: `renderXlsx` throws `SpecRenderError('formula_error', where)`, because validation should have caught it.
- Header row: bold, filled with the accent colour from a fixed hex map per `AccentColor`, and frozen pane below the header.
- Column widths come from content length (capped).
- Number formats: `money` → `'"₪"#,##0'` when the charter currency is ILS. Otherwise use a currency format string from a fixed map; `formatMinor`'s currency is passed in.
- Font: `Arial` (present on every client).
- No VBA, no external links, no defined names. Workbook properties: `creator = 'העוזרת'`.

- [ ] **Step 1: Failing tests** (read the buffer back with exceljs):
  - `he sheet is rightToLeft, en sheet is not`
  - `formula cells carry formula and cached result equal to evaluateWorkbook`
  - `money column has the currency format`
  - `no definedNames, no vba part in the zip (inspect zip entries via archive-guard's reader or a zip listing)`
- [ ] **Steps 2–5:** as before. Add no new dependency.

### Task 5: DOCX renderer

**Files:** Create `src/production/render-docx.ts`, `src/production/render-docx.test.ts`. Modify `package.json` (add `docx`).

**Produces:** `renderDocx(spec: DocxSpec & common): Promise<Buffer>`.

**Rules:**
- In Hebrew, every paragraph gets `bidirectional: true` and right alignment, and every run gets `rightToLeft: true`.
- Tables get `visuallyRightToLeft: true`.
- Numbers inside Hebrew runs are wrapped in their own LTR run. The renderer splits runs on digit sequences, so `39%` and `₪1,890` stay intact.
- Clauses are numbered by the renderer (`1.`, `1.1`). Contract: the renderer appends a signature table, then "הבסיס החוקי" listing `legalBasis`, then `CONTRACT_DISCLAIMER_*` in the footer of every page.
- Images: bytes from the stored document (`documents.stored_path` under `config.documentRoot`), scaled to the page width. Only `image/png`/`image/jpeg` media types from `documents.media_type` are accepted; anything else throws `SpecRenderError('unsupported_image')`.
- Font `Arial`.

- [ ] **Step 1: Failing tests** (unzip `word/document.xml` and assert XML):
  - `he paragraphs carry w:bidi and w:jc right`
  - `digit sequence is its own run without w:rtl`
  - `contract footer contains the Hebrew disclaimer`
  - `clause numbering is generated (1., 2., 2.1)`
  - `a gif image is refused`
  - `mammoth extracts the paragraph text in spec order`
- [ ] **Steps 2–5:** as before.

### Task 6: PPTX renderer

**Files:** Create `src/production/render-pptx.ts`, `src/production/render-pptx.test.ts`. Modify `package.json` (add `pptxgenjs`).

**Produces:** `renderPptx(spec: PptxSpec & common): Promise<Buffer>`.

**Rules:**
- In Hebrew, use `rtlMode: true` on every text object, right alignment, and `lang: 'he-IL'`.
- One fixed layout function per `Slide` variant, each with fixed positions. The collage uses a grid chosen by image count (2: 1×2, 3: 1+2, 4: 2×2, 5–6: 2×3).
- Charts come from the slide's table data through pptxgenjs native charts.
- A missing image renders a grey box with "כאן תמונה" / "Image here" and is recorded in the render result: `{buffer, placeholders: number}`.

- [ ] **Step 1: Failing tests** (unzip `ppt/slides/slideN.xml`):
  - `he text bodies carry rtl="1" and algn="r"`
  - `collage of 5 lays out 5 pictures`
  - `missing image yields a placeholder and placeholders=1`
  - `41 slides refused by validateSpec (cap)` (covered in Task 3; here assert 40 renders)
- [ ] **Steps 2–5:** as before.

### Task 7: PDF renderer (HTML + Chromium seam)

**Files:** Create `src/production/render-html.ts`, `src/production/render-pdf.ts`, `src/production/chromium.ts`, plus tests for the first two. Modify `package.json` (add `playwright-core`).

**Interfaces — Produces:**
- `renderHtml(spec: DocxSpec-shaped PdfSpec & common, assets: AssetResolver): string`
  - Deterministic.
  - Every text goes through `escapeHtml` and then `stripBidiControls`.
  - Fixed CSS per theme.
  - Numbers are wrapped in `<bdi dir="ltr">`.
  - `@page` size A4, with page numbers in the footer via CSS.
  - The contract disclaimer is in a fixed footer.
- `type PdfPrinter = (html: string, signal: AbortSignal) => Promise<Buffer>`
- `createChromiumPrinter(options: {executablePath: string, fontDir: string}): PdfPrinter` in `chromium.ts`:
  - `chromium.launch({executablePath, args: ['--no-sandbox' only if CHROMIUM_NO_SANDBOX=1]})`
  - `newContext({javaScriptEnabled: false, offline: true})`
  - `route('**', r => r.request().url().startsWith('data:') ? r.continue() : r.abort())`
  - `setContent(html, {waitUntil:'load'})`, then `page.pdf({format:'A4', printBackground:true, preferCSSPageSize:true})`
  - A deadline of 60s via `withDeadline`. The browser is always closed in `finally`.
- `renderPdf(spec, deps: {printer: PdfPrinter, assets}): Promise<Buffer>`
- Fonts: the font file is embedded as a base64 `@font-face` data URL from `config.productionFontPath`.
  - Env `DOCUMENT_FONT_PATH`.
  - Default font: Noto Sans Hebrew (OFL), which the builder vendors under `assets/fonts/` with its licence file.
  - With no font file present, `renderHtml` throws a clear internal error. It never silently falls back.

- [ ] **Step 1: Failing tests** (no Chromium; a stub printer records the html):
  - `he html has dir=rtl lang=he on <html>`
  - `no <script> anywhere, and an injected "<script>" in a paragraph appears escaped`
  - `a bidi control in source text is stripped`
  - `numbers are inside <bdi dir="ltr">`
  - `every asset url in the html is a data: url`
  - `the printer receives exactly renderHtml's output`
- [ ] **Steps 2–5:** as before. `chromium.ts` has no unit test. It is exercised by `npm run doc:render-check` (Task 8).

### Task 8: Page renderer for check 2 (LibreOffice + Chromium) and the live check script

**Files:** Create `src/production/page-images.ts`, `src/production/page-images.test.ts`, `src/production/run-render-check.ts`. Modify `package.json` (script `doc:render-check`), `.env.example`, `src/config.ts`.

**Interfaces — Produces:**
- `type PageRenderer = (file: {format, bytes: Buffer}, signal: AbortSignal) => Promise<{pages: Buffer[] /* PNG */, text: string, pageCount: number}>`
- `createLocalPageRenderer(options: {sofficePath: string, chromiumPath: string}): PageRenderer`:
  - docx/xlsx/pptx: write the bytes to a fresh temp dir.
  - Run `soffice --headless --norestore -env:UserInstallation=file:///<tmp>/profile --convert-to pdf --outdir <tmp> <file>` as a child process, with a 90s deadline (`SIGKILL` on expiry) and env `{PATH, HOME:<tmp>}` only.
  - Then rasterise the PDF pages in Chromium: open the PDF bytes through the bundled pdf viewer disabled, i.e. render each page with `pdfjs-dist` inside the Chromium page as a data URL. Keep JS enabled **only** for this internal viewer page, which loads no external content.
  - Builder's choice: pdfjs+canvas in a worker child is equally acceptable if it stays in a child process with the memory cap pattern of `run-extractor.ts`.
  - pdf: rasterise directly.
  - The text comes from `pdfjs-dist` text extraction, using the existing `linesOf` heuristic.
  - At most 10 images: first, last, then pages flagged by check 1, in order.
  - The temp dir is always removed.
- Config:
  - `config.sofficePath` (`DOCUMENT_SOFFICE_PATH`), `config.chromiumPath` (`DOCUMENT_CHROMIUM_PATH`), `config.productionFontPath`.
  - When either binary path is absent, `buildRuntime` returns a **warning**, not a throw, and productions fail with stage `failed` and reason `'כלי ההפקה אינו מותקן בשרת'`. Same pattern as SMTP vars.
- `npm run doc:render-check`: builds one Hebrew docx, xlsx, pptx and pdf from fixed specs, through the real printer and renderer. It writes the PNGs to the scratch dir and prints the paths and the extracted text. It also asserts the Hebrew text order of the Review Focus 1 strings.

- [ ] **Step 1: Failing tests** (stub child via an injected `spawn`):
  - `soffice is called with headless, norestore and a private profile dir`
  - `env passed to the child is only PATH and HOME`
  - `child exceeding the deadline is SIGKILLed and the renderer rejects with 'render_timeout'`
  - `temp dir is removed on success and on failure`
  - `more than 10 pages → 10 images chosen first, last, flagged`
- [ ] **Steps 2–5:** as before. Add a ☐ line to `docs/11-pre-launch-checks.md`: "`npm run doc:render-check` passes on the server with LibreOffice, Chromium and the Hebrew font installed".

### Task 9: Check 1 — mechanical verification of the built file

**Files:** Create `src/production/check1.ts`, `src/production/check1.test.ts`.

**Interfaces — Consumes:** Tasks 2–8.

**Produces:**
- `runCheck1(input: {spec, bytes: Buffer, sources: GroundingSources, rendered: {text, pageCount}}): Promise<Check1Result>`
  - `Check1Result = {passed: boolean, findings: Check1Finding[]}`
  - `Check1Finding = {code, where, he: string}`. The Hebrew text is fixed per code.

**What it checks** (it reads the **built bytes**, never the spec alone):
- **xlsx:** load with exceljs. Recompute every formula with `evaluateWorkbook` and compare it to the cached result (`formula_mismatch`). Any error value (`formula_error`). `rightToLeft` per language (`direction_wrong`). No defined names or VBA (`unsafe_part`).
- **docx:** parse `word/document.xml`. `w:bidi` on every paragraph for `he` (`direction_wrong`). Disclaimer and legal basis present for a contract (`missing_structure`). mammoth text in spec order.
- **pptx:** `rtl="1"` on text bodies for `he`.
- **pdf:** `pdfjs` text in spec order.
- **all formats:**
  - Grounding re-run on the text extracted from the file (`ungrounded_number`).
  - Order check: for each spec text run of ≥2 words, the extracted text contains it in order. A Hebrew run reversed word-by-word → `order_reversed`. A digit sequence reversed → `digits_reversed`.
  - `rendered.pageCount ≤ 60` (`cap_exceeded`).
  - Zip part allowlist per format: any part outside it → `unsafe_part`.
  - `stripBidiControls(text) === text` except for controls the renderer inserts (`bidi_control`).

- [ ] **Step 1: Failing tests** (build real files with Tasks 4–7, using a stub printer whose PDF is made with a tiny fixture):
  - `a workbook whose cached result was tampered → formula_mismatch`
  - `a reversed Hebrew line in the extracted text → order_reversed`
  - `"1,890" extracted as "098,1" → digits_reversed`
  - `contract without disclaimer (render bypassed) → missing_structure`
  - `docx with an extra word/vbaProject.bin part → unsafe_part`
  - **Review Focus 1 test:** the mixed-run strings all pass on a correctly built docx, xlsx, pptx and pdf
  - `a passing file has findings = []`
- [ ] **Steps 2–5:** as before.

### Task 10: The drafter and the image judge (SDK, quarantine)

**Files:** Create `src/sdk/doc-drafter.ts`, `src/sdk/doc-drafter.test.ts`, `src/sdk/doc-judge.ts`, `src/sdk/doc-judge.test.ts`.

**Interfaces — Produces:**
- `draftDocumentSpec(request: DraftRequest): Promise<DraftOutcome>`:
  - `DraftRequest` = `{bundle, instruction: string, format, language, kind, sources: FencedSource[], memories: {memoryId, body, provenance}[], previous?: {spec, findings: {he: string}[]}, fixInstruction?: string}`
  - `DraftOutcome` = `{status:'drafted', spec: DocumentSpec} | {status:'undrafted', reason}`
  - It calls the SDK with `tools: []`, `env: {PATH}`, `refuseUnderTest`, and the model chosen in code: `claude-opus-5-5` when `kind === 'contract'` or the xlsx has >1 sheet with cross-sheet refs in `previous`/the request; otherwise `claude-sonnet-5-5`.
  - The prompt opens with the format catalogue (the stable prefix: rendered from the zod schemas plus `FORMULA_FUNCTIONS`), then the instruction, then the fenced sources (`util/fence.ts`, a per-call nonce; each source carries its provenance label), then the memories, then the previous findings and the fix instruction.
  - The response is parsed with `extractJsonObjects` (`util/json-extract.ts`) and then `DocumentSpec.safeParse`. The drafter sets `language` itself from the request; a mismatching value from the model is a parse failure, not an override.
  - Exported seam type: `Drafter = typeof draftDocumentSpec`.
- `judgeDocument(request: DocJudgeRequest): Promise<JudgeOutcome>` in `doc-judge.ts`:
  - `DocJudgeRequest` = `{bundle, instruction: string, kind, language, text: string, pages: Buffer[]}`
  - It reuses `buildJudgeSystemPrompt` and `interpretJudgeResponse` from `gov-verify.ts` and adds criteria for language correctness, word/number order as seen, structure fit for the kind, and professional legibility.
  - It sends the images as image content blocks through the SDK's message input (use the Agent SDK's streaming-input form that accepts image blocks).
  - The instruction and text are fenced with a per-call nonce. `tools: []`, `env: {PATH}`, `refuseUnderTest`.
  - Exported seam `DocJudge`.
  - **Import invariant:** `doc-judge.ts` must not import any module that reads document content. Extend the BFS invariant in `src/sdk/gov-verify.test.ts` to also start from `doc-judge.ts`.

- [ ] **Step 1: Failing tests** (no API: test prompt building and parsing):
  - `the catalogue prefix is byte-identical across two calls with different instructions` (cache)
  - `sources are fenced with a nonce absent from their text`
  - `a model reply with language 'en' for a he request is undrafted`
  - `contract picks claude-opus-5-5, price_list picks claude-sonnet-5-5`
  - `judge prompt fences instruction and text; images passed as image blocks (inspect built call)`
  - `both refuse under test when called live`
  - `doc-judge transitive imports reach no document reader` (extended invariant)
- [ ] **Steps 2–5:** as before. Add `npm run sdk:doc-draft -- <fixture>` as a live script, and a ☐ line in `docs/11-pre-launch-checks.md`.

### Task 11: Production store and the production loop

**Files:** Create `src/production/store.ts`, `src/production/store.test.ts`, `src/production/loop.ts`, `src/production/loop.test.ts`. Modify `src/orchestrator/scheduler.ts`, `src/orchestrator/scheduler-log.ts`, `src/config.ts` (`DOCUMENTS_PER_DAY`, `positiveInt`, default 20), `.env.example`.

**Interfaces — Produces:**
- `createProduction(input: {businessId, originJobId, instructionText, textOrigin, format, language, kind, destination, sourceDocumentIds}, db): Promise<string>`
- `claimProduction(businessId, holder, leaseMs, db): Promise<Production | null>`
  - It is one conditional `UPDATE ... WHERE stage NOT IN ('ready','failed_checks','failed') AND (lease_until IS NULL OR lease_until < now()) ... RETURNING`.
- `advanceStage(productionId, from: ProductionStage, to, patch, db): Promise<boolean>` — conditional; `false` means the race was lost, which is a skip.
- `saveVersion(...)`, `latestVersion(productionId)`, `productionsToday(businessId, timeZone)` (counts productions created since local midnight in the charter zone, plus fix attempts).
- `runDocumentProductions(options: {businessId, now?, budgetMs: 120_000, drafter?, judge?, printer?, renderer?, notifyCard?}): Promise<{advanced, ready, failedChecks, failed, skipped}>`.

**Stage machine:**
- `queued` → `drafting` (draft spec; `validateSpec`; problems → back to the drafter as `previous.findings`, counted as an attempt)
- → `building` (render; store under `config.documentRoot/produced/<businessId>/<productionId>/<versionId>.<ext>`; sha256)
- → `check1` → `check2` (page renderer + judge)
- → `ready`, or on failure → `fixing` → `drafting`, with `attempt + 1`.
- When `attempt` reaches 3, i.e. after 2 fixes → `failed_checks`.
- A drafter outcome of `undrafted`, a render throw or a timeout → `failed`, with a Hebrew reason.
- Each stage persists its output before moving on, so a crash resumes at the stored stage.
- Every external call goes through `withDeadline`: draft 180s, render 60s, page render 90s, judge 120s.

**On `ready` / `failed_checks`:**
- Create the card (Task 14's `createDocumentCard`).
- Transition the origin job `followup → closed` (`expectFrom: 'followup'`; `PhaseMovedError` → skip).
- On `failed`: the origin job goes `followup → failed`, and the owner is told through the card channels with the reason.
- Audit row `document_production`, carrying a hash of the production id, the format, the kind and the stage — no content.

**Scheduler:** `runDocumentProductions` runs in `schedulerPass` right after `runDueJobs`, behind the same runtime warning gate as Task 8. It returns `null` when tools are missing. The log line goes into `scheduler-log.ts`.

- [ ] **Step 1: Failing tests** (stubs for drafter, printer, renderer and judge):
  - `happy path reaches ready, writes one version, closes the origin job`
  - `check1 failure twice then pass → ready with attempt 2`
  - `three failures → failed_checks; card created with the findings`
  - `a crash after building (simulate by throwing after saveVersion) resumes at check1 and does not call the drafter again` (assert drafter call count)
  - `two concurrent claims → one wins` (two pools)
  - `the 21st production of the local day is refused with the Hebrew cap reason and the drafter never runs`
  - `budget exhausted stops the pass and leaves the rest queued`
  - `drafter timeout → failed with reason, origin job failed`
- [ ] **Steps 2–5:** as before.

### Task 12: Attachments on `mail.send`

**Files:** Create `src/production/attachments.ts`, `src/production/attachments.test.ts`. Modify `src/orchestrator/adapters/types.ts` (`AdapterCall.attachments`), `src/orchestrator/run-plan.ts` (`performStep`), `src/orchestrator/adapters/mail.ts`, `src/mail/transport.ts`, `src/orchestrator/adapters/mailbox-send.ts`, `src/mail/providers/types.ts`, `gmail.ts`, `graph.ts`, `src/orchestrator/command-echo.ts`, `src/orchestrator/whatsapp-report.ts` (`FAILURE_REASON_HE`).

**Interfaces — Produces:**
- `AttachmentRef = z.object({producedVersionId: SafeLookupKey, sha256: hex64, filename: z.string().max(120)}).strict()`
- `resolveAttachments(refs: AttachmentRef[], businessId, db): Promise<{ok: true, files: {filename, mediaType, bytes: Buffer}[]} | {ok: false, code: 'attachment_not_found'|'attachment_hash_mismatch'|'attachment_too_large', he: string}>`
  - It reads `document_versions` in **this business**, takes the bytes from disk, re-hashes them and compares.
  - The total must be ≤ 20MB.
  - `mediaType` is derived from the version's format, never from `filename`.
- `AdapterCall.attachments: readonly {filename, mediaType, bytes}[]` — required, with `[]` meaning none.
  - `performStep` resolves it from the **effective** input (ruling C16; a routing field, the same rule as target selection) and fails the step with `StepChannelError(code, he, false)` on a non-ok result, **before** any adapter call.

**Adapter changes:**
- SMTP: nodemailer `attachments`.
- Gmail: multipart/mixed raw MIME (base64 parts, RFC 2231 filename encoding for Hebrew names).
- Graph: `fileAttachment` in `sendMail`, and in `/reply` via create-reply-then-send or `message.attachments` — the builder checks the Graph docs. Any single file over 3MB → `attachment_too_large_microsoft`, final, Hebrew.
- The existing `learnedReplyCovers` refusal of any `attachments` key stays.

**`renderStepEcho`:** an `attachments` field renders as `"קובץ מצורף: <filename> · <size> · <sha12>"`. The field is never shown as a raw "שדה נוסף".

- [ ] **Step 1: Failing tests:**
  - `resolveAttachments re-hashes from disk: a file modified after hashing → attachment_hash_mismatch`
  - `a version id from another business → attachment_not_found`
  - `25MB total → attachment_too_large`
  - `performStep fails before adapter.execute on mismatch (adapter spy not called)`
  - `redaction pattern matching the sha does not break the send` (charter redaction fixture + effective-input resolution)
  - `SMTP message carries the attachment bytes (fake SMTP server like transport.test.ts)`
  - `Gmail raw MIME has a filename*=UTF-8'' part for a Hebrew name`
  - `Graph 4MB file → attachment_too_large_microsoft`
  - `echo renders the attachment line, not a raw field`
- [ ] **Steps 2–5:** as before. Run the existing mail adapter tests and `inherited-fields.test.ts`.

### Task 13: `doc.save` and the base folder

**Files:** Create `src/production/save.ts`, `src/production/save.test.ts`, `src/governance/document-settings.ts`, `src/governance/document-settings.test.ts`. Modify `src/policy/classify.ts` (`'doc.save': 'artifact.write'`, `ingestsExternalContent['doc.save'] = false`), `src/charter/capabilities.ts` (prod.docs gets `doc.save`), `src/orchestrator/local-tools.ts` (handler + contract).

**Interfaces — Produces:**
- `DocumentSettings = {toWhatsApp, toEmail, toScreen, baseFolder: string | null}`; defaults `{false, true, true, null}`.
- `loadDocumentSettings`, `saveDocumentSettings`:
  - refuse in Hebrew when no channel is selected;
  - refuse a `baseFolder` that is not absolute, does not exist or is not writable (checked with `fs.access W_OK`).
- `resolveSaveTarget(baseFolder: string, folder: string | null, kind: DocumentKind, filename: string): Promise<{ok: true, dir: string, name: string} | {ok: false, he: string}>`
  - **Segment allowlist:** `/^[\p{L}\p{N} _.-]+$/u`, with no leading `.`.
  - Separators: `/` or `\` between segments.
  - Rejected: `..`, an absolute path, a drive letter, the Windows reserved names (`CON PRN AUX NUL COM1-9 LPT1-9`, case-insensitive, with or without extension), more than 5 segments, more than 200 chars.
  - Bidi controls are stripped first.
  - A `null` folder maps to `documentKindLabel[kind]`.
  - The final `realpath` of the created dir must start with `realpath(baseFolder) + sep`.
- `saveVersionToFolder(...)`: opens with `wx`; on `EEXIST` it tries ` (2)` up to ` (99)`; re-hashes the written bytes and compares them to the version sha.
- `doc.save` handler:
  - input `{producedVersionId, sha256, folder: string|null, filename}`;
  - it is a gated classified tool, so it only runs through a confirmed delivery job (Task 14);
  - it returns `{performed: true, path}`.

- [ ] **Step 1: Failing tests:** Review Focus 3 cases one by one, plus:
  - `symlink inside base pointing out → refused`
  - `existing file → "name (2).xlsx"`
  - `written bytes hash equals the version sha`
  - `settings refuse all-false`
  - `settings refuse a relative base folder`
  - `classify: doc.save is artifact.write and not in READ_ONLY_TOOLS` (extend `positive-controls.test.ts` disjointness)
- [ ] **Steps 2–5:** as before.

### Task 14: `doc.produce`, the document card, approval → delivery job, request-fix

**Files:** Create `src/production/card.ts`, `src/production/card.test.ts`, `src/production/source-resolver.ts`, `src/production/source-resolver.test.ts`. Modify `src/policy/classify.ts` (`doc.produce` in `READ_ONLY_TOOLS` and `KNOWN_TOOL_NAMES`, `ingestsExternalContent['doc.produce'] = true`), `src/charter/capabilities.ts` (prod.docs: `doc.produce`, `doc.save`, `memory.recall`, `agent.request_help`), `src/orchestrator/local-tools.ts`, `src/sdk/planner.ts` (via `LOCAL_TOOL_CONTRACTS`), `src/orchestrator/instruct.ts`, `src/policy/positive-controls.test.ts`.

**`doc.produce` handler:**
- Input: `{format, language?: 'he'|'en' /* default he */, kind, request: string ≤4000, destination: {mode:'send', to: string[], subject?, body?} | {mode:'save', folder: string|null}, sources?: {documentId}[], sourceHints?: string[]}`.
- `assertProductionWriter`: the same SQL as `assertLedgerWriter`, with code `production_not_boss_instruction`.
- It calls `createProduction` and then moves its own job `execute → followup` with `wake_at NULL` (never woken by `wakeDueJobs`), returning `{performed: true, parked: true, productionId}`.
- `destination.to` must pass `authorisedRecipients` against the instruction text and `textOrigin` (existing rule). Unauthorised addresses are dropped and noted on the card as "כתובת לא מוסמכת — הקלידי אותה בכרטיס".
- `language` is `'en'` only if the planner set it **and** the instruction text contains an explicit English request. The check is code: a fixed list (`באנגלית`, `in English`, `english`). Otherwise `'he'`.

**`resolveSourceDocuments`** (`source-resolver.ts`, C19, deterministic, no model):
- Inputs: `(businessId, hints: string[], explicitIds: string[], db) → {resolved: string[], ambiguous: {hint, candidates: {documentId, name, sender, date}[]}[], missing: string[]}`.
- Matching is on `documents.original_name`, the mail `from_address` domain or display name via `mail_messages.attachments[].documentId`, the attachment `docType` label, and the date, all within this business.
- At most 3 candidates are shown.
- In `instruct.ts`, ambiguity becomes a clarifying question through the existing `pendingQuestions`/identity-question route, **before** planning ends. It uses the same `identityAsked`-style second-round flag, `sourceAsked`, so the loop is bounded.

**`createDocumentCard(versionId)`:**
- It builds one delivery plan per shown destination:
  - send: one step `comms.email` / `mail.send` with `{to, subject, body, attachments:[ref]}` and `expectedActionClass: 'email.initiate'`;
  - save: one step `prod.docs` / `doc.save`, `artifact.write`.
- It stores the plans with `planHashOf` and sends the card on the chosen channels (`document_settings`):
  - screen: no send;
  - email to the owner: the existing alert seam plus an attachment (add `sendAlertWithAttachment` to the runtime alerts type);
  - WhatsApp: `BossMessenger.sendFile`, a new member that takes no recipient; when unconnected → `skipped_not_connected`.
- Channel states follow 040/047.

**`approveDocumentCard(cardId, planHash, actor: 'dashboard'|'whatsapp', db)`:**
- Locks the card `FOR UPDATE`. It requires `state = 'open'`, a version not superseded, and `planHash` ∈ stored plans (otherwise `card_stale`, and the card is re-rendered).
- In one transaction it creates the delivery job:
  - `createJob({provenance: 'boss'})` as a literal;
  - a `boss_instructions` row with the production's `instruction_text`/`text_origin`;
  - `bindPlanToJob`;
  - `createConfirmation` + `confirmChoice` → `confirmed` with `chosen_plan_hash`;
  - transition `plan → execute`.
- Card `state = 'approved'|'saved'`, `delivery_job_id`.
- `runDueJobs` then runs it under `confirmedCommandCovers` (unchanged).
- The marker column linking job→card is `document_cards.delivery_job_id`.

**`requestFix(cardId, text, actor, textOrigin)`:**
- Supersedes the card and opens a new production: the instruction is the original plus `\n\nתיקון: ` plus the text, and `textOrigin` is `typed` only if both parts are typed. Recipients are re-checked.
- It counts toward `DOCUMENTS_PER_DAY`.

**Exclusions** (positive markers):
- `whatsapp-report.ts` skips jobs whose plan's only step is `doc.produce` — the card is the report.
- `jobQualifiesForCuration` returns `false` for a plan containing `doc.produce` (C18).
- `reaskFailedCommands` skips jobs that have a `document_cards.delivery_job_id` (C17).

- [ ] **Step 1: Failing tests:**
  - `a non-boss job's doc.produce throws production_not_boss_instruction before creating a production` (assert no row and that the check ran)
  - `doc.produce parks the job in followup with wake_at NULL; wakeDueJobs does not wake it`
  - `language is he unless the instruction asks for English`
  - `an address not typed and not known to the charter is dropped and noted`
  - resolver: `one match resolves`, `two matches → ambiguous with 2 candidates`, `none → missing`, `another business's document never matches`
  - `approve creates a boss delivery job with a confirmed confirmation whose hash equals the shown plan; runDueJobs sends via confirmedCommandCovers under off` (stub adapter receives the attachment bytes)
  - `approve with a stale planHash → card_stale, no job`
  - `approve after requestFix superseded the card → refused` (Review Focus 4)
  - `double approve → one delivery job`
  - `requestFix with a voice-origin original → text_origin transcribed`
  - `curation excludes doc.produce plans`
  - `reask skips a failed delivery job; the card returns once with "השליחה הקודמת לא הושלמה"` (and "ייתכן שהמייל כבר יצא" after an `unknown` row)
  - `positive-controls: doc.produce in READ_ONLY_TOOLS and KNOWN_TOOL_NAMES, not in TOOL_ACTION_CLASS`
- [ ] **Steps 2–5:** as before. Run `instruct.test.ts`, `command-reask.test.ts`, `whatsapp-report.test.ts`, `capabilities.test.ts`, `positive-controls.test.ts`.

### Task 15: Dashboard — upload, card screen, settings; WhatsApp — "שלחי" / "תיקון:"

**Files:** Create `src/dashboard/document-routes.ts`, `src/dashboard/document-views.ts`, `src/dashboard/document-routes.test.ts`, `src/dashboard/multipart.ts`, `src/dashboard/multipart.test.ts`. Modify `src/dashboard/server.ts`, `src/dashboard/views.ts` (`/instruct` file input), `src/orchestrator/whatsapp-door.ts`, `src/orchestrator/whatsapp-door.test.ts`, `src/orchestrator/digest-facts.ts`/`digest-render.ts` (one line).

**Upload on `POST /instruct`:**
- Our own minimal `multipart/form-data` parser (`multipart.ts`); no dependency.
- Max 1 file, at most the inbox size cap, filename stored verbatim and never used as a path.
- It goes through CSRF and the session check exactly like today.
- The file is written to a temp path and passed to `ingestDocument({path, source: 'manual', originalName})`. The resulting `documentId` is added to the instruction's sources: passed to `runInstruction` as `attachedDocumentIds`, and from there into the planner as `PlanRequest.attachedDocuments` (ids + names, not text).
- A rejected ingest shows its Hebrew reason, and the instruction is not run.

**Routes:**
- `GET /documents` — the list of cards, open first, marks `seen_at`.
- `GET /documents/:cardId` — the card exactly per mockup D13: both checks with findings, sources with provenance labels, a first-page preview image (from check 2's first PNG, served from the stored version's render cache), and the buttons.
- `GET /documents/:cardId/download` — `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, the bytes re-hashed before serving.
- `POST /documents/:cardId/approve` (planHash, or `to` typed for a card with no authorised recipient — C12).
- `POST /documents/:cardId/fix` (text).
- `GET|POST /documents/settings`.
- A `failed_checks` card shows "לא עבר בדיקה", no send button, and save with a warning.
- File names and summaries go through `escLabel`.

**WhatsApp door — `handleDocumentCardMessage`:**
- Placed with the mail-card reader, using the same rules: typed only, after `whatsapp_delivered_at`, within the window.
- "שלחי"/"שלח" approves only when exactly one open card counts. **Document cards and mail-reply cards count together** (C9).
- "תיקון: <text>" → `requestFix`.
- Anything else passes through.

**Digest:** "הופקו N מסמכים, M נשלחו, K מחכים לבדיקתך".

- [ ] **Step 1: Failing tests:**
  - multipart: `parses one file and fields`, `rejects two files`, `rejects over cap`, `a filename with ../ is stored verbatim and never used`
  - routes: `upload ingests and the instruction receives the document id`, `download re-hashes and refuses a mismatching file`, `approve without CSRF is refused`, `failed_checks card has no send button and the approve route refuses send`, `settings refuse all channels off`
  - door: `"שלחי" with one document card approves it`, **Review Focus 5:** `"שלחי" with a document card and a mail card open → SEVERAL_OPEN_REFUSAL, neither approved`, `voice "שלחי" passes through`, `"שלחי" before delivered_at does not approve`, `"תיקון: …" requests a fix`
- [ ] **Steps 2–5:** as before. Run `server.test.ts`, `whatsapp-door.test.ts`, `whatsapp-mail-card.test.ts`.

### Task 16: Erasure wiring and docs

**Files:** Modify `src/governance/erasure-plan.ts`, `src/governance/erasure.ts`, `src/governance/erasure-invariants.test.ts`, `src/governance/erasure-plan.test.ts`, `CLAUDE.md`, `docs/10-user-settings.md`, `docs/11-pre-launch-checks.md`, `docs/09-roadmap.md`, `docs/01-agents.md`.

**Erasure:**
- **Erase targets and discovery sources:**
  - `document_productions.instruction_text`, `destination`
  - `document_versions.spec`
  - `document_cards.delivery_plans`
- **Delete with their rows:** files under `produced/` (absolute paths built in `erasure-plan.ts`, as for `documents`).
- **Not deleted:** copies saved in the base folder (C7). The preview lists them under "נשארים בתיקייה שלך", found through `job_step_results` of `doc.save` steps (`output.path`).
- `document_settings` is not wired: it holds no content about a person.
- The table count in CLAUDE.md goes up accordingly.
- Seed the probe in all new content columns in `erasure-invariants.test.ts`.
- Use `jsonbContentMatches` for the jsonb columns.

**Docs:**
- `CLAUDE.md`: a new subsection "הפקת מסמכים (03/11)" stating the rules this plan enforces — model describes / code builds, the READ_ONLY rationale for `doc.produce`, approval = confirmed command (D15), byte identity, base-folder containment, the two checks, the seams — and known issues.
- `docs/10-user-settings.md`: a §9 "מסמכים" section (channels, base folder).
- `docs/11-pre-launch-checks.md`: render-check, live drafter, live judge, attachment sends on all three providers, and font install.
- `docs/09-roadmap.md` and `docs/01-agents.md`: the `prod.docs` tool list.

- [ ] **Step 1: Failing tests:**
  - `erasing a contact named only in a production instruction removes the production, versions, card and produced files`
  - `the preview lists a saved base-folder copy and erasure leaves it`
  - `invariant scan finds no probe after erasure`
- [ ] **Steps 2–5:** as before. Then run the full suite on the dedicated DB and `npm run typecheck`.
