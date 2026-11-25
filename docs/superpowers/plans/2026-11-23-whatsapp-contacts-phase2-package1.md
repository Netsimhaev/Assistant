# WhatsApp Contacts — Phase 2, Package 1 (Auto-Reply) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the assistant answer a known client or supplier on WhatsApp by itself — only on an owner-approved topic, only from public documents or that sender's own records, only for a *question* (never a request), and only after six code checks — and record every decision with the data package 2's learning will need.

**Architecture:** A quarantined classifier runs before the existing drafter; its topic picks which tier-2 sources run (four new: calendar, ledger, meetings, generic external). On the auto path the researcher does not run, six pure exit checks run on the draft, a clearance row is written for the exact payload hash, and the card job moves straight to `execute` without an approval. A new narrow gate exemption, `contactReplyCovers`, reads that clearance and re-checks topic, contact, charter switch and settings switch at send time. The charter switch is the existing `whatsapp.reply` base row; a fixed amendment raises it.

**Tech Stack:** TypeScript (ESM, NodeNext), Postgres 17 with RLS FORCE, vitest against a real DB, `@anthropic-ai/claude-agent-sdk`, zod.

**Spec:** `docs/superpowers/specs/2026-11-23-whatsapp-contacts-phase2-design.md` (§5, §6.1, §7, §8, §9, §11). It continues `docs/superpowers/specs/2026-11-21-whatsapp-contacts-design.md` (H1–H16). Read both. CLAUDE.md ("וואטסאפ ללקוחות ולספקים — שלב 1") describes phase 1 as built.

## Global Constraints

- Owner rulings: P1 (five tier-2 kinds: invoices, calendar, ledger, meetings, external), P2 (this is package 1 of 2), **P3 (reports, never commits: only `kind = 'question'` may go out alone; `request`/`commitment`/`courtesy` never)**, H1, H5, H7, H8, H13.
- `src/policy/engine.ts` changes in exactly one place: computing `contactReply` next to `learnedReply` and feeding it into `effectiveAutonomy`, risk, and the `intent_to_act` reason. No other gate change.
- No charter schema change. `CURRENT_SCHEMA_VERSION` stays `'1.4'`.
- Every new table: `business_id`, RLS ENABLE + FORCE, policy `business_id = app_business_id()` in the same migration (`src/tenancy/rls.test.ts` fails otherwise). Migration file: `src/db/migrations/085_whatsapp_contacts_phase2.sql`. Never edit 083/084.
- Every model call (classifier) is quarantined: `tools: []`, `env: { PATH }`, `maxTurns: 1`, `refuseUnderTest`, all sender text fenced with `util/fence.ts` nonce.
- `businessId` is never defaulted; every DB call goes through `withBusiness`/`BusinessDb`.
- Hebrew for people, English for code. Owner-facing text from sender/model passes `stripBidiControls` + `toOneLine` (or `escLabel` in HTML).
- Positive controls only: every check is "allowed when X", never "allowed unless Y". A value that cannot be read is never the permissive one.
- Tests: dedicated DB only —
  ```
  SDD=$(node -e "require('dotenv').config({quiet:true});const u=new URL(process.env.TEST_DATABASE_URL);u.pathname='/assistant_test_sdd';console.log(u.toString())")
  TEST_DATABASE_URL="$SDD" npm run migrate:test   # after the migration task
  TEST_DATABASE_URL="$SDD" npx vitest run <files> --no-file-parallelism
  ```
  Never print the URL. A negative test must prove the checked code ran (assert the stage/reason), not only that the bad outcome is absent.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A classifier that returns `question` for "אפשר להביא סחורה מחר?" — the code cannot detect the misclassification; the drafter instruction plus the six checks are what remain. Expect: a draft that says "כן, תבוא" on a `question` still goes out only if every number is grounded — accepted residual, stated in CLAUDE.md (Task 11).
2. Owner edits topic or contact between clearance and send (quiet hours delay) → send must fall back to a card, not go out (Task 6 test "topic retired after clearance").
3. Same sender writes again while the auto job waits in `followup` → no card replacement, no second auto reply (Task 8 test "auto job waiting is not replaced").
4. External source returns one foreign row among many → whole result `ownershipViolation`, card without draft, for the generic source exactly like accounting (Task 4 test).
5. Calendar question with an unreadable or 3-week window → calendar source does not run; never "free" by default (Task 3 test "window too long").

---

### Task 1: Migration 085 and stores (topics, public documents, settings, card context, clearances)

**Files:**
- Create: `src/db/migrations/085_whatsapp_contacts_phase2.sql`
- Create: `src/whatsapp/contact-topics.ts`, `src/whatsapp/public-documents.ts`, `src/whatsapp/card-context.ts`, `src/whatsapp/auto-clearance.ts`
- Modify: `src/whatsapp/sources/invoice-settings.ts` (load/save the two new settings columns)
- Test: `src/whatsapp/contact-topics.test.ts`, `src/whatsapp/public-documents.test.ts`, `src/whatsapp/card-context.test.ts`, `src/whatsapp/auto-clearance.test.ts`

**Interfaces:**
- Produces (SQL):
  - `contact_topics (business_id, topic_id text, name text NOT NULL, description text NOT NULL DEFAULT '', applies_to text CHECK IN ('client','supplier','both'), sources text[] NOT NULL, auto_reply boolean NOT NULL DEFAULT false, created_by text NOT NULL, created_at, updated_at, retired_at timestamptz, PK (business_id, topic_id))`.
  - `contact_card_context (business_id, job_id text, kind text CHECK IN ('question','request','commitment','courtesy','unclassified'), topic_id text, summary text CHECK (length(summary) <= 200), source_names text[] NOT NULL, internal_document_ids text[] NOT NULL, auto boolean NOT NULL, created_at, PK (business_id, job_id))`.
  - `contact_auto_clearances (business_id, job_id text, step_id text, input_hash text CHECK (input_hash ~ '^[0-9a-f]{64}$'), conversation_id text NOT NULL, topic_id text NOT NULL, created_at, PK (business_id, job_id, step_id))`.
  - `ALTER TABLE documents ADD COLUMN public_for text CHECK (public_for IN ('client','supplier','both'))`.
  - `ALTER TABLE contact_reply_decisions ADD COLUMN topic_id text, ADD COLUMN summary text, ADD COLUMN source_names text[], ADD COLUMN internal_document_ids text[]`.
  - `ALTER TABLE contact_whatsapp_settings ADD COLUMN auto_reply_enabled boolean NOT NULL DEFAULT false, ADD COLUMN external_sources jsonb NOT NULL DEFAULT '[]'`.
- Produces (TS):
  - `TIER2_SOURCE_NAMES = ['uploaded_invoices','sent_invoices','accounting_invoices','calendar_busy','ledger_of_sender','meetings_of_sender','external_of_sender','public'] as const`; `type Tier2SourceName`. (Lives in `contact-topics.ts`; `sources/types.ts` imports it in Task 3.)
  - `ContactTopic { topicId; name; description; appliesTo: 'client'|'supplier'|'both'; sources: Tier2SourceName[]; autoReply: boolean; retiredAt: Date|null }`.
  - `listTopics(db, opts?: { includeRetired?: boolean }): Promise<ContactTopic[]>`, `loadTopic(db, topicId): Promise<ContactTopic|null>`, `createTopic(db, input: { name; description; appliesTo; sources; autoReply; by }): Promise<ContactTopic>`, `updateTopic(db, topicId, patch, by): Promise<ContactTopic>`, `retireTopic(db, topicId, by): Promise<boolean>`, `setTopicAutoReply(db, topicId, on: boolean, by): Promise<boolean>`. Writes audit `contact_topic:<created|updated|retired|auto_on|auto_off>` (hash of topic id only).
  - `topicApplies(topic, kind: 'client'|'supplier'): boolean`.
  - `setPublicFor(db, documentId, value: 'client'|'supplier'|'both'|null, by): Promise<boolean>`; `publicDocumentsFor(db, kind: 'client'|'supplier', budgetChars: number): Promise<{ documentId; name; text }[]>` (extracted artifacts' text, `status='extracted'`, truncated to the budget across documents, oldest-first deterministic order by `document_id`).
  - `saveCardContext(db, ctx: CardContext): Promise<void>`, `loadCardContext(db, jobId): Promise<CardContext|null>`; `CardContext { jobId; kind; topicId: string|null; summary: string; sourceNames: string[]; internalDocumentIds: string[]; auto: boolean }`.
  - `writeClearance(db, c: { jobId; stepId; inputHash; conversationId; topicId }): Promise<void>`, `loadClearance(db, jobId, stepId): Promise<{ inputHash; conversationId; topicId }|null>`.
  - `InvoiceSettings` loader gains `loadContactWaSettings(db): Promise<{ autoReplyEnabled: boolean; externalSources: ExternalSenderSource[] }>` and `saveAutoReplyEnabled(db, on, by)`; `ExternalSenderSource { systemId; operation; param; field }` (validated against the active charter on save with the same rules as invoice settings; Task 4 uses it).

- [ ] **Step 1: Write failing tests.** `contact-topics.test.ts`: `createTopic` rejects a source not in `TIER2_SOURCE_NAMES` (Hebrew error, no row); rejects an empty name; `retireTopic` sets `retired_at` and `listTopics()` omits it; `topicApplies({appliesTo:'both'},'supplier') === true`, `topicApplies({appliesTo:'client'},'supplier') === false`. `public-documents.test.ts`: `setPublicFor` then `publicDocumentsFor(db,'client',10_000)` returns it for `client`/`both` and not for `supplier`; a second business never sees it; budget truncation keeps total text ≤ budget. `card-context.test.ts`: round trip; summary over 200 chars is cut to 200 by `saveCardContext`, never rejected. `auto-clearance.test.ts`: round trip; a malformed hash throws.
- [ ] **Step 2: Run** `TEST_DATABASE_URL="$SDD" npx vitest run src/whatsapp/contact-topics.test.ts src/whatsapp/public-documents.test.ts src/whatsapp/card-context.test.ts src/whatsapp/auto-clearance.test.ts --no-file-parallelism` — FAIL (modules missing).
- [ ] **Step 3: Write the migration** with RLS FORCE and the policy for the three new tables, then the four modules. `public-documents.ts` is the **only** writer of `documents.public_for` (Task 11 locks it).
- [ ] **Step 4: Run** `TEST_DATABASE_URL="$SDD" npm run migrate:test`, then the four tests plus `src/tenancy/rls.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): phase 2 schema — topics, public documents, card context, clearances`.

---

### Task 2: Classifier (quarantined) and its parser

**Files:**
- Create: `src/sdk/contact-classifier.ts`, `src/whatsapp/contact-classification.ts`
- Test: `src/whatsapp/contact-classification.test.ts`, `src/sdk/contact-classifier.test.ts`

**Interfaces:**
- Consumes: `ContactTopic` (Task 1), `util/fence.ts`, `util/send-at.ts` (`parseSendAt`-style strict ISO-with-offset reader — reuse its reader, do not duplicate).
- Produces:
  - `ContactKind = 'question'|'request'|'commitment'|'courtesy'`.
  - `Classification { kind: ContactKind | 'unclassified'; topicId: string|null; summary: string; window: { from: Date; to: Date } | null }`.
  - `parseClassification(raw: unknown, ctx: { topicIds: ReadonlySet<string>; texts: readonly string[]; now: Date }): Classification` — pure:
    - zod `.strict()` object `{ kind, topicId: string|null, summary: string, window: {from,to}|null }`; parse failure → `{ kind: 'unclassified', topicId: null, summary: '', window: null }`.
    - `topicId` not in `topicIds` → `null`.
    - `kind === 'courtesy'` is kept **only** if every text has `length <= COURTESY_MAX_CHARS` (`= 40`); otherwise → `'unclassified'`.
    - `summary` → `toOneLine(stripBidiControls(s)).slice(0, 200)`.
    - `window`: both ends parse with an explicit offset, `from < to`, `to > now`, `to - from <= 7 days` → kept; anything else → `null`.
  - `ContactClassifier = (req: { bundle: PolicyBundle; topics: ContactTopic[]; conversation: { direction; body }[]; texts: string[]; signal?: AbortSignal }) => Promise<{ status: 'classified'; raw: unknown } | { status: 'failed'; reason: string }>`; `runContactClassifier: ContactClassifier` (model `'haiku'`, quarantine per Global Constraints). Prompt defines `question` as asking about a state ("נשלחה?", "יש מקום מחר?") and `request` as asking someone to do or agree to something ("אפשר להביא מחר?", "תשלחו שוב") — verbatim examples from spec §5.1/P3.

- [ ] **Step 1: Failing tests** in `contact-classification.test.ts`: `courtesy` with texts `['תודה']` → `courtesy`; `courtesy` with a 41-char text → `unclassified`; unknown topic id → `topicId: null`; garbage → `unclassified`; window of 8 days → `null`; window without offset → `null`; window in the past → `null`; summary with `‮` and newline → stripped, one line, ≤ 200. In `contact-classifier.test.ts`: `runContactClassifier` throws/refuses under test (`refuseUnderTest`); the built call has `tools: []`, `env` keys exactly `['PATH']`, `maxTurns: 1`, and each text appears between two identical nonce fences.
- [ ] **Step 2: Run** both — FAIL.
- [ ] **Step 3: Implement.** Export a `buildClassifierCall(req, nonce?)` for the test.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): quarantined classifier for contact messages`.

---

### Task 3: Calendar, ledger and meetings sources

**Files:**
- Modify: `src/whatsapp/sources/types.ts`
- Create: `src/whatsapp/sources/calendar-busy.ts`, `src/whatsapp/sources/ledger-of-sender.ts`, `src/whatsapp/sources/meetings-of-sender.ts`
- Test: one `.test.ts` beside each

**Interfaces:**
- Consumes: `Tier2SourceName` (Task 1), `resolveCalendarAccess`, `loadCalendarRange`, `isCalendarFailure`, `busyIntervals`, meeting settings loader from `src/meetings/settings.ts`, `charter.identity.timezone`.
- Produces:
  - `types.ts`: `SourceItem.source: Tier2SourceName`; `SourceContext { window: { from: Date; to: Date } | null; timeZone: string }`; `Tier2Source = (db, ids, signal, ctx: SourceContext) => Promise<Tier2Result>` (existing three sources keep working — they ignore `ctx`); `Tier2Result` gains `failed?: boolean` (source ran and could not answer — counts as a failed source, not a violation).
  - `createCalendarBusySource(deps: { runtime: Pick<Runtime,'credentials'>; client?: CalendarClient }): Tier2Source` — `ctx.window === null` → `{ items: [], ownershipViolation: false }` without any calendar call. Else loads the range; failure or `truncated` → `{ items: [], ownershipViolation: false, failed: true }`. One item: label `'יומן'`, text `"<from–to local>: פנוי"` or `"…: תפוס"`; when busy and an overlapping event is linked to the sender (a `meetings` row with that `event_id` whose `client_phone` digits equal `ids.key` or `lower(client_email) = lower(ids.email)`), append `" — " + toOneLine(stripBidiControls(title))`. Unlinked titles never appear.
  - `ledgerOfSender: Tier2Source` — `ids.email === null` → empty. Rows with `counterparty_email_verified = true AND lower(counterparty_email) = lower($email)` and `status IN ('open','stuck')`, ≤ 10, label `'פנקס'`, text: description, status (`ledgerStatusLabel`), due date local, `formatMinor(amount)` when present. No domain, no phone.
  - `meetingsOfSender: Tier2Source` — rows with `state IN ('proposed','active')`, `start_at >= now() - 1 day`, and `regexp_replace(client_phone,'\D','','g') = ids.key` or `lower(client_email) = lower(ids.email)`, ≤ 10, label `'פגישות'`, text: local start, location if any, response in Hebrew.

- [ ] **Step 1: Failing tests.** Calendar: window null → no client call (spy count 0); window of a busy slot with an unlinked event titled "דנה כהן" → text contains `תפוס` and not `דנה`; linked event → title appears; `truncated: true` → `failed: true`; calendar not connected → `failed: true`. Ledger: verified email row returned; same email unverified → not; same domain different email → not; other business → not. Meetings: phone match with `+972 54-…` stored and `ids.key='97254…'` → returned; past meeting (2 days ago) → not.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Update the `Tier2Source` call site in `contact-flow.ts` minimally to pass `{ window: null, timeZone }` so typecheck passes (Task 8 passes the real window).
- [ ] **Step 4: Run** the three tests plus existing `src/whatsapp/sources/*.test.ts` and `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): calendar, ledger and meetings tier-2 sources`.

---

### Task 4: Generic external source and public tier-1 items

**Files:**
- Create: `src/whatsapp/sources/external-of-sender.ts`, `src/whatsapp/sources/public-source.ts`
- Modify: `src/whatsapp/sources/accounting-invoices.ts` (extract the shared read-and-own-check into an exported helper used by both)
- Modify: `src/dashboard/contact-whatsapp-settings.ts` (list/add/remove external sender sources; auto-reply toggle is Task 7)
- Test: `src/whatsapp/sources/external-of-sender.test.ts`, `src/whatsapp/sources/public-source.test.ts`, extend `src/dashboard/contact-whatsapp-settings.test.ts`

**Interfaces:**
- Consumes: `loadContactWaSettings` / `ExternalSenderSource` (Task 1).
- Produces:
  - `readOwnedRows(db, deps, ids, signal, s: ExternalSenderSource): Promise<Tier2Result & { rows: Record<string,string>[] }>` — the exact semantics accounting has today (active-charter re-check, live binding `ext:<id>`, credential, daily cap, guarded HTTPS, kill switch `ops.systems`; exact `===` on the declared field; non-list or nested value → violation).
  - `createExternalOfSenderSource(deps: { http; credentials; now? }): Tier2Source` — runs every configured `ExternalSenderSource` whose system has `ids.externalIds[systemId]`; any violation → whole result `{ items: [], ownershipViolation: true }`; label = the signed operation's Hebrew label; ≤ 10 rows per source.
  - `publicSourceItems(db, kind: 'client'|'supplier', budgetChars = PUBLIC_BUDGET_CHARS /* 12_000 */): Promise<SourceItem[]>` — `source: 'public'`, label `'מסמך ציבורי: ' + escLabel-free name`, `documentId` set (so it is an allowed attachment).

- [ ] **Step 1: Failing tests.** External: two configured sources, second returns one foreign row → `ownershipViolation: true` and `items` empty; contact without the system's id → no HTTP call; settings for an operation that is not `read` or not signed → refused on save (Hebrew), and skipped at run time if the charter changed after save. Public: kind `supplier` gets `both`+`supplier` docs only. Settings page: POST add/remove with CSRF; without CSRF → 403, no row change.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; accounting keeps passing its existing tests unchanged.
- [ ] **Step 4: Run** new tests + `src/whatsapp/sources/accounting-invoices.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): generic external sender source and public documents as tier 1`.

---

### Task 5: Exit checks (pure)

**Files:**
- Create: `src/whatsapp/exit-checks.ts`
- Test: `src/whatsapp/exit-checks.test.ts`

**Interfaces:**
- Consumes: `ungroundedNumbers`, `Classification` (Task 2), `ContactTopic`, `topicApplies` (Task 1), `SourceItem`.
- Produces:
  - `ExitCheckInput { draft: string; attachDocumentId: string|null; classification: Classification; topic: ContactTopic|null; sender: { kind: 'client'|'supplier'|null; managed: boolean; colleague: boolean; name: string }; tier12: SourceItem[]; tier3Used: boolean; sourceFailed: boolean; ownershipViolation: boolean; otherPeople: { names: string[]; emails: string[]; phoneKeys: string[] } }`.
  - `exitChecks(i: ExitCheckInput): { ok: true } | { ok: false; reason: string /* Hebrew, one of EXIT_REASONS */ }` — in this order, first failure wins:
    1. `ungroundedNumbers(draft, tier12.map(t => t.text))` non-empty → `EXIT_REASONS.ungrounded`. **Empty `tier12` with any digit in the draft → fail** (`ungroundedNumbers` returns `[]` on empty sources; do not rely on it there).
    2. Any other person's name (whole word, after `stripBidiControls` and lowercase; skip names equal to `sender.name` and names shorter than 2 chars), email, or phone key (digits of the draft) → `EXIT_REASONS.otherPerson`.
    3. `attachDocumentId` not null and not a `documentId` of some `tier12` item → `EXIT_REASONS.attachment`.
    4. `tier3Used` → `EXIT_REASONS.internal`.
    5. not (`sender.managed && !sender.colleague && sender.kind !== null && topic !== null && topic.retiredAt === null && topic.autoReply && topicApplies(topic, sender.kind)`) → `EXIT_REASONS.topic`.
    6. `classification.kind !== 'question'` → `EXIT_REASONS.notQuestion` ("זו בקשה — אישור עובר דרכך").
    - Also: `sourceFailed || ownershipViolation` → `EXIT_REASONS.sources` (checked first).
  - `EXIT_REASONS` — Hebrew strings, exported.

- [ ] **Step 1: Failing tests** — one passing baseline, then one test per check that flips exactly one field and asserts the exact reason (paired: same input, check satisfied → ok). Include: draft "החשבונית נשלחה ב-12/11" with tier12 text containing "12/11" → ok; same with "13/11" → ungrounded; empty tier12 + "3" in draft → ungrounded; draft containing another contact's phone written `054-1234567` against key `972541234567` → otherPerson (normalise local `0` prefix to `972` before comparing); `kind: 'request'` → notQuestion; `kind: 'unclassified'` → notQuestion.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): six exit checks for auto replies`.

---

### Task 6: Gate exemption `contactReplyCovers` (security-sensitive)

**Files:**
- Create: `src/policy/contact-reply.ts`
- Modify: `src/policy/engine.ts` (stage 8 lines ~347-358, the `assessRisk` call at ~388, the `intent_to_act` reason at ~395-399), `src/policy/risk.ts` (`assessRisk` option)
- Test: `src/policy/contact-reply.test.ts`

**Interfaces:**
- Consumes: `loadClearance` (Task 1), `loadTopic`, `topicApplies` (Task 1), `listManagedContacts`, `loadContactWaSettings` (Task 1), `authorityNumberKey`, `readConversationId`-equivalent own-key read, `WHATSAPP_CONTACTS_SYSTEM`.
- Produces:
  - `CONTACT_REPLY_EXEMPTION_MARKER = 'contact_reply_exemption'`.
  - `contactReplyCovers(facts: ActionFacts, toolInput: Record<string, unknown>, ctx: GateContext): Promise<{ covered: false } | { covered: true; knownPhone: string }>` — true only when **all** hold (each a positive check, in SQL or JS):
    1. `ctx.approval === undefined`; `typeof ctx.jobId === 'string'`; `typeof ctx.stepId === 'string'`.
    2. `facts.actionClass === 'whatsapp.reply'`; `facts.amountDeclared === false`.
    3. Own-key `conversationId` non-empty string; own-key `to` parses with `authorityNumberKey` to exactly one key.
    4. `contact_conversations` row in this business with `card_job_id = ctx.jobId`, `conversation_id = conversationId`, `state = 'carded'`, `contact_key = toKey`.
    5. `loadClearance(db, jobId, stepId)` exists, `inputHash === facts.inputHash`, `conversationId` equal.
    6. No `job_step_results` row with `status = 'unknown'` for the job.
    7. Charter switch: `ctx.bundle.connections.some(c => c.system === WHATSAPP_CONTACTS_SYSTEM)` **and** `ctx.bundle.autonomyBase['whatsapp.reply']` is `'auto_notify'` or `'auto'`.
    8. Settings switch: `loadContactWaSettings(db).autoReplyEnabled === true`.
    9. Send-time re-check: `loadTopic(clearance.topicId)` not null, `retiredAt === null`, `autoReply`, and `topicApplies(topic, kind)` where `kind` is the managed contact's kind; the managed contact with `subjectKey === '+' + toKey` exists, is not a colleague, and its `kind` equals the conversation's `contact_kind`.
    `knownPhone = toKey`.
  - `assessRisk(facts, bundle, options: { norms?; charterFit?; extraKnownPhones?: readonly string[] })` — `scoreVisibility` treats a phone in `extraKnownPhones` exactly like one in `known.phones`. No other change.
  - `engine.ts`: `const contactReply = !approvedReply && !learnedReply ? await contactReplyCovers(facts, isRecord(toolInput) ? toolInput : {}, ctx) : { covered: false };` → `effectiveAutonomy(..., { skipRampAndProvenance: approvedReply || contactReply.covered, skipProvenanceOnly: learnedReply })`; `assessRisk(..., { ...norms, ...(contactReply.covered ? { extraKnownPhones: [contactReply.knownPhone] } : {}) })`; intent reason appends `' ' + CONTACT_REPLY_EXEMPTION_MARKER` when covered.

- [ ] **Step 1: Failing tests** in `contact-reply.test.ts`, through a real `evaluateToolCall` with a signed charter (fixture `whatsapp.reply: 'auto_notify'`, ramp `draft_only`, provenance `unknown_external`), a seeded card job, conversation `carded`, managed contact, topic `auto_reply`, settings on, clearance with the payload's hash:
  - Baseline: `outcome === 'allow'`, and an `intent_to_act` audit row whose reason ends with `contact_reply_exemption`.
  - One test per condition 1–9 that breaks only that condition (e.g. clearance hash of a different body; conversation `answered`; `to` another number; settings off; base `approve_required`; topic retired after the clearance; contact kind changed to `supplier`; a `job_step_results` `unknown` row; `ctx.approval` set) — each asserts the denial happened **at stage 8**: `code` starts with `draft_only` **and** no `intent_to_act` row exists. (Pattern: `src/policy/learned-reply.test.ts`.)
  - Risk: covered send to a phone **not** in charter `knownCounterparties` has `band === 'routine'`; the same phone without the exemption is `one_unknown` in `assessRisk` (direct call).
  - A `forbidden` rule on `whatsapp.reply` still denies with code starting `forbidden:` even when covered.
- [ ] **Step 2: Run** `src/policy/contact-reply.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Engine change limited to the three lines described.
- [ ] **Step 4: Run** `src/policy/contact-reply.test.ts src/policy/approved-reply.test.ts src/policy/learned-reply.test.ts src/policy/positive-controls.test.ts src/policy/engine.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): contactReplyCovers — the auto-reply gate exemption`. Then run `/security-review` on the commit (CLAUDE.md requires it for `policy/engine.ts`); fix Critical/High findings before Task 7.

---

### Task 7: The signed switch and the settings switch

**Files:**
- Create: `src/charter/amend-whatsapp-auto-reply.ts`
- Modify: `src/dashboard/whatsapp-contacts-connect.ts` (two new POST routes and the status block), `src/dashboard/server.ts` (route wiring), `src/dashboard/contact-whatsapp-settings.ts` (auto-reply toggle)
- Test: `src/charter/amend-whatsapp-auto-reply.test.ts`, extend `src/dashboard/whatsapp-contacts-connect.test.ts`, `src/dashboard/contact-whatsapp-settings.test.ts`

**Interfaces:**
- Consumes: `declaresWhatsAppContacts`, `installSigned`, `INTERVIEW_NEVER_PREFIX` (`'interview_never_'`, build.ts:63), `saveAutoReplyEnabled` (Task 1).
- Produces:
  - `autoReplySigned(charter: BusinessCharter): boolean` — `declaresWhatsAppContacts(charter) && ['auto_notify','auto'].includes(charter.autonomy.base['whatsapp.reply'])`.
  - `autoReplyBlockedByNever(charter): boolean` — `charter.forbidden.some(r => r.id === INTERVIEW_NEVER_PREFIX + 'whatsapp.reply')`.
  - `buildWhatsAppAutoReplyAmendment(active, now): UnsignedCharter` — throws unless the connection is declared, not already signed, and not blocked by never; sets only `autonomy.base['whatsapp.reply'] = 'auto_notify'`, new `charterVersion` `<v>.war-<ulid>`, `effectiveFrom`, `supersedes`; everything else copied.
  - `buildWhatsAppAutoReplyRevert(active, now): UnsignedCharter` — throws unless signed; sets `whatsapp.reply` base to `'approve_required'`.
  - Routes: `POST /connections/whatsapp-contacts/auto-reply/sign`, `POST /connections/whatsapp-contacts/auto-reply/revert` — same ceremony as the existing sign (CSRF, `base` hidden field must equal active version, `installSigned` in one transaction, `'stale'` → 409). Never block → 409 with `AUTO_REPLY_NEVER_REFUSAL` (Hebrew, points to "ערוך את הכללים").
  - `AUTO_REPLY_AUTHORISATION_TEXT` = the sentence of the original spec §9.3 verbatim: "העוזרת תענה לבד ללקוחות ולספקים שהכנסת, רק בנושאים שאישרת, ורק עם מידע ציבורי או מידע של אותו כותב. היא תענה גם כשרמת החופש הכללית כבויה."
  - Settings page: checkbox "מענה אוטומטי" (POST with CSRF → `saveAutoReplyEnabled`); the page states which of the two switches is missing (`AUTO_REPLY_MISSING_SIGNATURE`, `AUTO_REPLY_MISSING_TOGGLE`).

- [ ] **Step 1: Failing tests.** Amendment: copies every field but the base (deep-equal after deleting the four changed fields); throws without connection; throws when never-rule present; revert sets `approve_required`. Routes: sign happy path installs a charter with base `auto_notify` and `autoReplySigned === true`; stale base → 409, no install; never rule → 409 with the refusal text, no install; no CSRF → 403. Settings: toggle persists; page shows the missing-signature line when unsigned.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): auto-reply signature and settings switch`.

---

### Task 8: Flow integration — classify, route, auto path

**Files:**
- Modify: `src/whatsapp/contact-flow.ts`, `src/whatsapp/contact-card.ts`, `src/orchestrator/scheduler.ts` (deps wiring at lines ~1088-1114)
- Test: `src/whatsapp/contact-flow-auto.test.ts` (new), keep `src/whatsapp/contact-flow.test.ts` green

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces:
  - `ContactFlowDeps` gains `classifier: ContactClassifier`, `calendarSource: Tier2Source` (built in scheduler from `createCalendarBusySource({ runtime })`), and the external source joins `sources`. Scheduler passes `options.contactClassifier ?? runContactClassifier`.
  - `RaiseContactCardInput` gains `mode: 'card' | 'auto'` (default `'card'` at every existing call) and `context: CardContext` (without `jobId`; filled inside). In `'auto'` mode `raiseContactCard` does everything it does today **except** `enqueueApproval`, `notifyOwner` and `await_approval`: after `bindPlanToJob` and the conversation swap it writes the clearance (`writeClearance` with `canonicalHash(payload)`, step `'reply'`) and transitions `plan → execute` with reason `CONTACT_AUTO_REASON = 'contact reply: auto, no card'`. Returns `{ jobId, approvalId: null }`. `saveCardContext` runs in both modes.
  - `CONTACT_AUTO_REASON` exported from `contact-card.ts`.
- Flow (`processGroup` / `draftFor`), in order:
  1. Busy check unchanged (`cardTakeoverBlocked` — an auto job sitting in `execute`/`followup` already counts as busy because its phase is neither `await_approval`, `failed` nor `closed`; add a test that proves it).
  2. Cap check unchanged; the classifier counts as part of the same draft run (no separate cap).
  3. Classifier (contacts and unknown senders alike, deadline `CLASSIFY_TIMEOUT_MS = 30_000`, own connection) → `Classification`; failure → `unclassified`.
  4. `courtesy` → if the conversation has no live card: settle the messages `handled`, no holding reply, no draft, no card, outcome `'recordedOnly'`; if it has a live card: treated like any message (card path).
  5. Sources: contacts only (unknown senders unchanged). Topic present → only `topic.sources` (plus `public` when listed) **and always the three invoice sources** (spec §5.2); no topic → all sources, auto impossible. Calendar gets `ctx.window`.
  6. Auto-eligible = sender managed (not colleague, kind set) ∧ topic present, not retired, `autoReply`, applies ∧ `kind === 'question'` ∧ `autoReplySigned(deps.charter)` ∧ `autoReplyEnabled`. If eligible: drafter **without** researcher (`tier3: []`), then `exitChecks`. Pass → `raiseContactCard({ mode: 'auto', … })`, **no holding reply**. Fail (or not eligible) → card path: holding reply as today, researcher runs, drafter runs **again** with tier 3 when the first draft was the auto attempt, reasons include the exit-check reason.
  7. Card context saved for every card/auto job: kind, topic, summary, `sourceNames` (distinct `SourceItem.source` that returned items), `internalDocumentIds` (researcher findings' non-null `documentId`s — stop discarding them), `auto`.
  - Drafter request gains `instruction: 'report_state'` on the auto attempt (prompt line: "מסרי מצב בלבד; אל תסכימי, אל תתחייבי ואל תבטיחי פעולה") — guidance, not the control.

- [ ] **Step 1: Failing tests** (`contact-flow-auto.test.ts`, stub classifier/drafter/researcher/sources, real DB, signed auto charter, settings on, topic `auto_reply` on `ledger_of_sender`):
  - Question + grounded draft → no approval row, job in `execute` with `job_steps.reason = CONTACT_AUTO_REASON`, clearance hash equals `canonicalHash(plan step input)`, no holding reply sent, researcher call count 0, card context `auto: true`.
  - Same with `kind: 'request'` → approval row exists, holding reply sent, researcher called, reasons contain `EXIT_REASONS.notQuestion`. (P3 pair, spec §9.)
  - Draft with an ungrounded number → card; drafter called twice (second with tier 3).
  - Settings off → card; charter base `approve_required` → card.
  - `courtesy` "תודה" with no live card → no card, no holding reply, drafter not called; with a live card → card path.
  - Auto job waiting in `followup` + new message → `ContactCardBusyError` path (busy note to owner), no second job.
  - Card context of a card job records `internalDocumentIds` from researcher findings.
  - Unknown sender with a matching topic → card, sources not called.
- [ ] **Step 2: Run** new test + `contact-flow.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `src/whatsapp/contact-flow-auto.test.ts src/whatsapp/contact-flow.test.ts src/whatsapp/contact-card.test.ts src/orchestrator/scheduler*.test.ts` and `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): classify contact messages and reply alone when every check passes`.

---

### Task 9: Failed auto replies, housekeeping, decisions, and marks

**Files:**
- Create: `src/whatsapp/contact-auto-reraise.ts`
- Modify: `src/whatsapp/contact-housekeeping.ts`, `src/orchestrator/scheduler.ts` (call re-raise before housekeeping), `src/dashboard/server.ts` (`handleAutonomousActionMark`)
- Test: `src/whatsapp/contact-auto-reraise.test.ts`, extend `src/whatsapp/contact-housekeeping.test.ts`, extend the autonomous-actions mark test

**Interfaces:**
- Consumes: `CONTACT_AUTO_REASON`, `raiseContactCard` (`mode: 'card'`), `MAY_HAVE_SENT_CODES` (`src/domain/may-have-sent.ts`), `loadCardContext`, `setTopicAutoReply`.
- Produces:
  - `reraiseFailedAutoReplies(db, deps: { bundle; charter; messenger; notify?; now }): Promise<{ reraised: number; skipped: number }>` — jobs whose `job_steps` include `CONTACT_AUTO_REASON`, now `failed`, no `completed` step, no `approval_requests` row, conversation still `carded` with `card_job_id` = the job. Claims by swapping the conversation to a new card job (`raiseContactCard` mode `'card'`, same payload, reasons `[AUTO_FAILED_REASON]` + `"ייתכן שההודעה כבר יצאה"` when an `unknown` row or a `MAY_HAVE_SENT_CODES` code exists), sends the holding reply per existing rules, presents the card. At most once per job (the swap is the claim).
  - Housekeeping: `settleCarded` treats a `carded` conversation whose card job is an auto job as follows — `closed` + performed → `answered` (existing branch); `failed` → **left alone** (re-raise owns it). `recordDecisions` copies `topic_id`, `summary`, `source_names`, `internal_document_ids` from `contact_card_context` into the decision row (NULLs when no context).
  - Mark: when `handleAutonomousActionMark` marks a step whose job has an `intent_to_act` audit row ending with `contact_reply_exemption`, it also calls `setTopicAutoReply(ctx.topicId, false, username)` using `loadCardContext(jobId).topicId`, and the redirect page shows `AUTO_REPLY_TOPIC_TURNED_OFF` (Hebrew, names the topic via `escLabel`).

- [ ] **Step 1: Failing tests.** Re-raise: failed auto job → one card, approval row, conversation points at the new job; second pass → nothing; a failed auto job with `adapter_timeout` unknown row → card detail contains "ייתכן שההודעה כבר יצאה"; a failed *card* job (has approval) → untouched. Housekeeping: failed auto job conversation stays `carded` after `settleCarded`; decision row carries the four new columns. Mark: marking an auto reply turns the topic off; marking a non-exempt step leaves topics unchanged.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): failed auto replies become a card; marks turn the topic off`.

---

### Task 10: Dashboard — topics and public documents

**Files:**
- Create: `src/dashboard/contact-topics-routes.ts`, `src/dashboard/public-documents-routes.ts`
- Modify: `src/dashboard/server.ts` (wiring), `src/dashboard/contact-whatsapp-settings.ts` (link to topics)
- Test: `src/dashboard/contact-topics-routes.test.ts`, `src/dashboard/public-documents-routes.test.ts`

**Interfaces:**
- Consumes: topic store and `setPublicFor` (Task 1).
- Produces:
  - `GET/POST /settings/whatsapp-contacts/topics` — list (name, applies-to, sources in Hebrew via a `TIER2_SOURCE_LABEL_HE: Record<Tier2SourceName,string>` map, auto-reply on/off), create form, per-topic edit/retire/toggle. Every POST behind CSRF and session; text through `escLabel`.
  - `GET/POST /documents/public` — list extracted documents (name, source, date), set `public_for`. A document whose `source` is `mail` or whose origin is a stranger shows `PUBLIC_FOREIGN_WARNING` and requires a second confirm checkbox (`confirmForeign=1`) checked on the POST, re-checked server-side.

- [ ] **Step 1: Failing tests:** create topic via POST appears in list; POST without CSRF → 403; retire hides it; toggle flips `auto_reply`; marking a `mail` document public without `confirmForeign` → 400, unchanged; with it → set; another business's document id → 404.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): topics and public documents screens`.

---

### Task 11: Erasure, action-update text, invariants, docs

**Files:**
- Modify: `src/governance/erasure-plan.ts`, `src/governance/erasure.ts`, `src/governance/erasure-invariants.test.ts`, `src/orchestrator/action-updates.ts`
- Create: `src/whatsapp/public-documents-invariants.test.ts`
- Modify: `CLAUDE.md`, `docs/11-pre-launch-checks.md`, `docs/10-user-settings.md`

**Interfaces:**
- Produces:
  - Erasure: `contact_card_context.summary` and `contact_reply_decisions.summary` are discovery sources (text `ILIKE` with the existing escaping) and delete targets by `job_id`; `contact_auto_clearances` deleted by `job_id`, not a discovery source; `contact_topics` is **not** deleted — when the anchor name appears in any topic name/description the preview shows `plan.topicMentionsContact` (Hebrew note, like `descriptionMentionsContact`) and `contact_topics` joins the survivors list in `erasure-invariants.test.ts`. `PROBE` seeded in both `summary` columns.
  - `renderActionUpdate` for a step whose intent carries `contact_reply_exemption`: "ענתה לבד ל<name/number>: <first 200 chars of body>" plus the topic name.
  - Invariant test: only `src/whatsapp/public-documents.ts` contains `public_for` writes (`UPDATE documents SET public_for` / `public_for =` in SQL), scanning `src/` excluding tests; the scan must find > 100 files.
  - CLAUDE.md: a new subsection "וואטסאפ ללקוחות ולספקים — שלב 2, חבילה 1" describing the classifier, five sources, exit checks, `contactReplyCovers` (what it skips, what stays), the signed switch = `whatsapp.reply` base row, P3 and its residual (Review Focus 1), known issues; update "מה עוד לא נבנה". docs/11: live classifier run, live calendar/external sources, live auto send. docs/10: topics, auto-reply toggle, external sender sources, public documents.

- [ ] **Step 1: Failing tests:** erasure sweep finds `PROBE` before wiring (prove red), invariant scan.
- [ ] **Step 2: Run** `src/governance/erasure-invariants.test.ts src/governance/erasure-plan.test.ts src/whatsapp/public-documents-invariants.test.ts` — FAIL.
- [ ] **Step 3: Implement + docs.**
- [ ] **Step 4: Run** the three + `npm run typecheck` + full suite on `$SDD` — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): erasure, update text and docs for auto replies`.
