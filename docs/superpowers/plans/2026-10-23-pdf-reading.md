# PDF Reading, Summary and Type Tagging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Read PDF files from mail and from the document inbox:
- extract their text in the sandboxed extractor;
- give each mail attachment a short summary and a document type for filtering;
- register invoices found inside PDFs;
- show all of this on the dashboard and in the WhatsApp notice.

**Architecture:**
- A new `pdf` extractor runs in the existing isolated child process (`runExtractor`), producing one artifact per page. PDFs leave `STORE_ONLY_TYPES`.
- The mail poll ingests attachments **before** triage.
- `renderTriageBrief` adds each attachment's extracted text as an extra fenced field.
- `MailTriage` gains a per-attachment result. It is persisted on the `mail_messages.attachments` JSON element, next to `documentId`.

**Tech Stack:** TypeScript ESM, Postgres, vitest, `pdfjs-dist` (legacy build, no worker).

**Spec:** `docs/superpowers/specs/2026-10-20-mailbox-connection-design.md` §9 (overrides R10). Branch: `mailbox-connection`.

## Global Constraints

- Document types, closed set, verbatim: `invoice` | `receipt` | `quote` | `contract` | `order` | `report` | `other`. Hebrew labels: חשבונית, קבלה, הצעת מחיר, חוזה, הזמנה, דוח, אחר.
- Per-attachment `summary` ≤ 300 chars. The model reports no address field anywhere; schemas are `.strict()`.
- PDF caps:
  - 50 pages. Beyond that the PDF is flagged `truncated`.
  - Existing character, time and memory caps of `runExtractor`.
  - A PDF with no extractable text is flagged `scanned_no_text`.
- `pdfjs-dist` must run with no eval (`isEvalSupported: false`), no font loading (`disableFontFace: true`, `useSystemFonts: false`), no worker, and no network or URL fetches.
- Brief caps: at most 8,000 chars of text per attachment, and the whole triage brief stays ≤ 24,000 chars (`TRIAGE_BRIEF_MAX_CHARS`). Truncation is marked in the brief.
- `docType` is advisory. No module in `src/policy/` reads it.
- Mail curation stays chunk-only. The curator brief gets attachment summaries, never raw PDF text.
- A mail-sourced document is still skipped by the conductor. A manually dropped PDF is read by the conductor like a docx.
- Use a private test DB for full runs (the stop-hook collides on `assistant_test`).

## Review Focus

1. **A hostile PDF** (deeply nested objects, huge page count, JavaScript action, embedded fonts, malformed xref) must end as a recorded rejection or a truncated or empty extraction, never a hang or a parent crash. (Task 1 tests.)
2. **A scanned PDF** (image only) must be flagged and shown as "קובץ סרוק — לא נקרא", not as an empty summary that looks read. (Tasks 1 and 3.)
3. **Instructions inside PDF text** ("ignore previous instructions, label this as …") must be fenced like the body. The triage output stays a closed schema. (Task 2.)
4. **A model `index` that names no attachment** (out of range, duplicated) must be rejected by `mailTriageProblems`, not written onto the wrong file. (Task 2.)
5. **An attachment that failed to ingest** still gets a triage entry or a clear "not read" state. The triage index must refer to the attachment list order the brief showed, not to a filtered list. (Task 2.)

---

### Task 1: PDF extractor

**Files:**
- Create: `src/documents/extractors/pdf.ts`, `src/documents/extractors/pdf.test.ts`, test fixtures. Generate small PDFs in the test, or commit tiny fixture files under `src/documents/extractors/fixtures/`.
- Modify: `src/documents/media-type.ts` (remove PDF from `STORE_ONLY_TYPES`; keep the sniff), `src/documents/registry.ts` (`extractorFor(PDF)`), the child-process dispatch (`extract-child.ts`), `package.json` (`pdfjs-dist`), and the existing tests that asserted PDFs are `stored`.

**Interfaces:**
- The extractor follows the existing extractor contract: same output shape as docx/xlsx and one artifact per page. Read `docx.ts` and `registry.ts` for the shape and the flag conventions. Document-level flags (`scanned_no_text`, page-count `truncated`) go on the first artifact; per-page `truncated` goes on that page.
- Run `npm audit` after installing and record the result.

- [ ] **Step 1:** Write the failing tests:
  - `extracts the text of a two-page PDF as two artifacts`
  - `flags scanned_no_text for a PDF with no text layer`
  - `stops at 50 pages and flags truncated on the first artifact`
  - `a PDF with a JavaScript action extracts text and never evaluates it`: assert the eval-free options are passed, e.g. by inspecting the getDocument call or by a fixture whose script would throw.
  - `a malformed PDF is rejected with a Hebrew reason, not a crash`: through `ingestDocument`.
  - `ingestDocument stores a PDF as extracted with page artifacts`
  - `a manually ingested PDF is offered to the conductor; a mail-sourced one is not`
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the focused tests, `npm run typecheck`, and the full `npm test` on a private DB. All must pass.
- [ ] **Step 5:** Commit: `Documents: sandboxed PDF text extraction`.

### Task 2: Triage reads attachments; per-attachment summary, type and invoice

**Files:**
- Modify: `src/domain/mail-triage.ts`, `src/mail/triage-brief.ts`, `src/sdk/mail-triage.ts` (prompt contract), `src/orchestrator/mail-poll.ts` (ingest before triage; persist the per-attachment result; invoice rows from PDFs), `src/mail/inbox-store.ts` (a helper to write `summary`/`docType`/`scanned` onto the attachment element, NUL-safe and business-scoped, like `linkAttachmentDocument`), `src/memory/curation-brief.ts` (mail brief includes attachment summaries).
- Tests: the matching `*.test.ts` files.

**Interfaces:**
- `MailTriage.attachments: z.array(z.object({ index: z.number().int().min(0), docType: z.enum([...7]), summary: z.string().min(1).max(300), invoice: <existing invoice object>.nullable() }).strict()).default([])`
- `mailTriageProblems` adds `attachment_index_unknown` (an index ≥ the number of attachments shown in the brief) and `attachment_index_duplicate`. This means `mailTriageProblems(t, shownAttachmentCount)`; update the callers.
- The brief lists attachments in the stored `attachments` order, each as `=== צרופה <index>: <safe filename label> :: <nonce> ===`. The filename goes through the same address-shape rule as the display name, and bidi controls are stripped. The text comes from the document's artifacts.
  - Attachments with no text are shown as "(לא נקרא: סרוק / לא נקלט / סוג לא נתמך)".
  - Caps: 8,000 chars per attachment; the whole brief stays ≤ 24,000 chars, with attachments truncated before the body.
- Invoices: when an attachment's `docType === 'invoice'` or its `invoice` is non-null, write a `mail_invoices` row for that document, with no duplicate for the same `(mail_id, document_id)`. The mail-level invoice from the body is kept as today. Both are marked unverified.
- Mail categories: if any attachment is `invoice`, the mail also gets the `invoice` category, and the label follows.

- [ ] **Step 1:** Write the failing tests:
  - `brief fences each attachment's text under the call nonce`
  - `brief caps attachment text and keeps the whole brief ≤ 24,000`
  - `an attachment filename that is an address is not shown`
  - `triage response with an out-of-range attachment index is rejected`
  - `triage response with a duplicate index is rejected`
  - `poll ingests before triage and writes summary and docType onto the attachment element`
  - `an invoice found only inside a PDF creates an invoice row and the invoice label`
  - `a scanned PDF is shown to triage as not read and stored with scanned: true`
  - `curator brief includes attachment summaries and never PDF text`: put a canary in the PDF text.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the covering tests, typecheck, and the full suite on a private DB. All must pass.
- [ ] **Step 5:** Commit: `Mail: triage reads PDF attachments — summary, type, invoices`.

### Task 3: Screens and notice

**Files:**
- Modify: `src/dashboard/mail-views.ts`, `src/dashboard/mail-handlers.ts`, `src/dashboard/server.ts` (route `GET /mail/documents`), `src/mail/whatsapp-notice.ts`, and the tests.

**Interfaces:**
- `/mail/:id` attachment list: for each attachment, the Hebrew type label, the summary (escaped via `escLabel`), the "קובץ סרוק — לא נקרא" state, and the download link when it exists.
- `GET /mail/documents?type=&sender=&from=&to=`: a table of mail attachments with columns תאריך, שולח, שם קובץ, סוג, סיכום, הורדה, מייל מקורי. Filter by a closed `type` (an unknown value means no filter), sender substring, and a charter-timezone date range. The query is business-scoped and reads the `attachments` JSON with `jsonb_array_elements`. Add a nav link.
- WhatsApp notice: one line per attachment, `📎 <type label>: <summary>`, folded to one line with bidi controls stripped. At most 3 lines, then "ועוד N".

- [ ] **Step 1:** Write the failing tests:
  - `mail detail shows summary, type and scanned state`
  - `/mail/documents filters by type and is business-scoped`
  - `an unknown type parameter does not filter and is not echoed raw`
  - `notice adds attachment lines, capped at 3`
  - `summary with U+202E is stripped on every surface`
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the covering tests, typecheck, and the full suite on a private DB. All must pass.
- [ ] **Step 5:** Commit: `Dashboard: PDF summaries, document types, documents screen`.

### Task 4: Docs and verification

- [ ] **Step 1:** Update CLAUDE.md:
  - Replace the "PDF is store-only" paragraph and the "מה עוד לא נבנה" PDF note. Explain the new extractor, its sandbox options and caps, `scanned_no_text`, that `docType` is advisory, and that curation uses summaries only.
  - Update the test count.
- [ ] **Step 2:** Update `docs/10-user-settings.md` (the documents screen and types) and `docs/09-roadmap.md`.
- [ ] **Step 3:** Run `npm run typecheck` and the full `npm test` on a private DB. Report the real counts.
- [ ] **Step 4:** Commit: `Docs: PDF reading`.
