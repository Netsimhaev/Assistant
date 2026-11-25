# WhatsApp Contacts — Phase 2, Package 2 (Learning) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the owner's own decisions on contact reply cards, suggest three things — a new topic, auto-reply on an existing topic, a document to mark public — each entering only on the owner's "כן", on WhatsApp or on the settings screen.

**Architecture:** A scheduler pass computes candidates from `contact_reply_decisions` (columns added in package 1) with SQL and fixed thresholds; only the new-topic case calls a quarantined model, to group unthemed summaries, and code counts and decides. Suggestions live in one table, `contact_suggestions`; one is delivered on WhatsApp at a time; one executor (`applySuggestion`) serves both the WhatsApp reader and the dashboard. Nothing changes in the gate: accepting a suggestion only calls the existing stores (`createTopic`, `setTopicAutoReply`, `setPublicFor`).

**Tech Stack:** TypeScript (ESM, NodeNext), Postgres 17 with RLS FORCE, vitest against a real DB, `@anthropic-ai/claude-agent-sdk`, zod.

**Spec:** `docs/superpowers/specs/2026-11-23-whatsapp-contacts-phase2-design.md` §6 (and §8 data/erasure, §9 tests). Package 1 as built: CLAUDE.md "וואטסאפ ללקוחות ולספקים — שלב 2, חבילה 1".

## Global Constraints

- Owner rulings P1–P3, H7 ("topics start empty and enter only on 'yes'"), H8 (cost, margin, another writer's data, money commitment — never a topic).
- `src/policy/engine.ts` is not touched. No charter schema change; `CURRENT_SCHEMA_VERSION` stays `'1.4'`.
- No automatic promotion: nothing turns `auto_reply` on, creates a topic, or sets `public_for` except `applySuggestion` on an explicit owner "yes" (or the existing manual screens).
- New table: `business_id`, RLS ENABLE + FORCE, policy `business_id = app_business_id()` in the same migration `src/db/migrations/086_contact_suggestions.sql`; add it to `resetDatabase`'s TRUNCATE list in `src/test/db.ts`. Never edit 083–085.
- Thresholds (spec §6.2, exact): new topic ≥ `5` grouped unthemed decisions; auto-reply ≥ `MIN_SAMPLES` (5) decisions and `isLearned` (> 0.8, `src/governance/agreement.ts`); public document ≥ `3` approved drafts that leaned on the same tier-3 document.
- "Approved decision" = `verdict = 'right'` OR (`verdict = 'wrong'` AND `wrong_reason IS DISTINCT FROM 'denied'`). "Counted" for agreement = `verdict IN ('right','wrong')`.
- Only owner-origin documents are ever suggested public: `documents.source = 'instruction'` (package-1 Task 10 ruling); foreign documents never.
- Model call (clusterer) quarantined: `tools: []`, `env: { PATH }`, `maxTurns: 1`, `refuseUnderTest`, every summary fenced with a per-call nonce (`util/fence.ts`); it sees summaries only, never conversations.
- WhatsApp answer: typed only, after delivery (`delivered_at < inboundAt`), inside `WHATSAPP_QUESTION_WINDOW_MINUTES`, counted in `openOnWhatsApp`; "כן" with anything else open → `SEVERAL_OPEN_REFUSAL`.
- Owner-facing text from model/sender passes `stripBidiControls` + `toOneLine` (WhatsApp) or `escLabel` (HTML). Hebrew for people, English for code. Positive controls only.
- Tests: dedicated DB only —
  ```
  SDD=$(node -e "require('dotenv').config({quiet:true});const u=new URL(process.env.TEST_DATABASE_URL);u.pathname='/assistant_test_sdd';console.log(u.toString())")
  TEST_DATABASE_URL="$SDD" npm run migrate:test
  TEST_DATABASE_URL="$SDD" npx vitest run <files> --no-file-parallelism
  ```
  Never print the URL. A negative test proves the checked code ran.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Owner rejects a suggestion, the same signal persists next pass → it is never offered again in the same shape (Task 1 test "rejected shape is not re-inserted", Task 4 test "rejected auto-reply topic is not re-suggested until the topic changes").
2. Owner says "כן" on WhatsApp after the topic was retired / the document was removed or re-sourced → no change, reply "ההצעה כבר אינה רלוונטית" (Task 5 test "stale accept").
3. A clarifying question or command confirmation is open when the owner types "כן" → refused, nothing applied (Task 5 test "כן with a confirmation open").
4. A model-proposed topic name that carries a cost/margin word or another contact's name → H8: never suggested (Task 3 test "H8 words and contact names dropped").
5. Two scheduler passes in parallel → the same suggestion inserted once (unique shape hash; Task 1 test).

---

### Task 1: Migration 086 and the suggestions store

**Files:**
- Create: `src/db/migrations/086_contact_suggestions.sql`, `src/whatsapp/contact-suggestions.ts`
- Modify: `src/test/db.ts` (TRUNCATE list), `src/whatsapp/contact-topics.ts` (expose `updatedAt` on `ContactTopic`)
- Test: `src/whatsapp/contact-suggestions.test.ts`

**Interfaces:**
- Produces (SQL): `contact_suggestions (business_id text, suggestion_id text, kind text CHECK IN ('new_topic','auto_reply','public_document'), payload jsonb NOT NULL, shape_hash text NOT NULL CHECK (shape_hash ~ '^[0-9a-f]{64}$'), state text NOT NULL DEFAULT 'open' CHECK IN ('open','accepted','rejected','expired'), created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, decided_at timestamptz, decided_by text, PK (business_id, suggestion_id), UNIQUE (business_id, shape_hash))`.
- Produces (TS), in `contact-suggestions.ts`:
  - `SuggestionKind = 'new_topic'|'auto_reply'|'public_document'`.
  - `NewTopicPayload { name: string; description: string; appliesTo: 'client'|'supplier'|'both'; sources: Tier2SourceName[]; decisionIds: string[] }`, `AutoReplyPayload { topicId: string; right: number; counted: number }`, `PublicDocumentPayload { documentId: string; appliesTo: 'client'|'supplier'|'both'; approvals: number }`.
  - `Suggestion { suggestionId; kind; payload; state; createdAt: Date; deliveredAt: Date|null }` (discriminated on `kind`).
  - `shapeHashFor(kind, payload): string` — `canonicalHash` of: new_topic → `{kind, name: normalised (stripBidi, trim, collapse spaces, lowercase)}`; auto_reply → `{kind, topicId, topicUpdatedAt ISO}` (passed in); public_document → `{kind, documentId}`. Signature: `shapeHashFor(s: { kind: 'new_topic'; name: string } | { kind: 'auto_reply'; topicId: string; topicUpdatedAt: Date } | { kind: 'public_document'; documentId: string }): string`.
  - `insertSuggestion(db, kind, payload, shapeHash): Promise<Suggestion | null>` — `ON CONFLICT (business_id, shape_hash) DO NOTHING RETURNING`; null when the shape already exists in any state.
  - `listOpenSuggestions(db): Promise<Suggestion[]>` (oldest first), `loadSuggestion(db, id)`.
  - `markSuggestionDelivered(db, id, at): Promise<void>`.
  - `decideSuggestion(db, id, state: 'accepted'|'rejected'|'expired', by): Promise<boolean>` — `UPDATE … WHERE state = 'open'`; true only for the row it changed.
  - `deliveredOpenSuggestions(db, { inboundAt: Date|null; windowMinutes?: number }): Promise<Suggestion[]>` — open, `delivered_at IS NOT NULL AND delivered_at < inboundAt AND delivered_at > now() - window`; `inboundAt === null` → `[]`.
  - `ContactTopic` gains `updatedAt: Date`.

- [ ] **Step 1: Failing tests:** round trip of each kind; second `insertSuggestion` with the same shape hash → `null` (also after the first was `rejected`); `decideSuggestion` twice → `true` then `false`; `deliveredOpenSuggestions` excludes undelivered, delivered-after-inbound, outside the window, decided, and `inboundAt: null`; another business never sees a row; `shapeHashFor({kind:'new_topic',name:' משלוחים  '})` equals that of `'משלוחים'`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** migration (RLS FORCE + policy), store, TRUNCATE list, `updatedAt`.
- [ ] **Step 4: Run** `migrate:test`, the test, `src/tenancy/rls.test.ts`, `src/tenancy/business-deletion.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): contact_suggestions table and store`.

---

### Task 2: Learning signals (SQL, no model)

**Files:**
- Create: `src/whatsapp/learning-signals.ts`
- Test: `src/whatsapp/learning-signals.test.ts`

**Interfaces:**
- Consumes: `isLearned`, `MIN_SAMPLES`, `AGREEMENT_WINDOW_DAYS` (`src/governance/agreement.ts`), `listTopics` (Task 1 `updatedAt`).
- Produces:
  - `PUBLIC_DOC_MIN_APPROVALS = 3`.
  - `autoReplyCandidates(db, now: Date): Promise<{ topic: ContactTopic; right: number; counted: number }[]>` — live topics with `autoReply === false`; decisions with that `topic_id`, `decided_at > max(now − AGREEMENT_WINDOW_DAYS, topic.updatedAt)`, counted = `verdict IN ('right','wrong')`, right = `verdict = 'right'`; returned only when `isLearned({ right, counted, topWrongReason: null })`.
  - `publicDocumentCandidates(db): Promise<{ documentId: string; approvals: number; appliesTo: 'client'|'supplier'|'both' }[]>` — `unnest(internal_document_ids)` over approved decisions (Global Constraints definition), grouped by document; `approvals >= 3`; joined to `documents` with `source = 'instruction'`, `status = 'extracted'`, `public_for IS NULL`; `appliesTo` from the distinct `contact_conversations.contact_kind` of those decisions (all client → 'client', all supplier → 'supplier', else 'both'; 'unknown' kinds ignored, none left → skip).
  - `unthemedDecisions(db, now: Date, limit = 200): Promise<{ decisionId: string; summary: string; sourceNames: string[]; approved: boolean; contactKind: 'client'|'supplier'|'unknown' }[]>` — `topic_id IS NULL AND summary IS NOT NULL AND decided_at > now − 30 days`, newest first.

- [ ] **Step 1: Failing tests:** topic with 5 right / 0 wrong in window → candidate; 4 decisions → not; 5 right + 1 wrong (83%) → candidate; 4 right + 1 wrong (80%) → not (strict `>`); decisions older than the topic's `updatedAt` don't count; an `auto_reply` topic → never; retired topic → never. Public: doc on 3 approved decisions, source `instruction` → candidate with correct `appliesTo`; same doc with source `mail` → not; 2 approvals → not; a `denied` decision does not count; already `public_for` set → not. Unthemed: phase-1 rows (summary null) excluded; another business excluded.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): learning signals from reply decisions`.

---

### Task 3: Topic clusterer (quarantined) and its parser

**Files:**
- Create: `src/sdk/contact-clusterer.ts`, `src/whatsapp/topic-clusters.ts`
- Test: `src/sdk/contact-clusterer.test.ts`, `src/whatsapp/topic-clusters.test.ts`

**Interfaces:**
- Consumes: `unthemedDecisions` rows (Task 2), `TIER2_SOURCE_NAMES`, `listManagedContacts` (`src/memory/managed-contacts.ts`), `util/fence.ts`.
- Produces:
  - `NEW_TOPIC_MIN_DECISIONS = 5`, `H8_WORDS: readonly string[]` = `['עלות','רווח','מרווח','הנחה','מחיר קנייה','עמלה','שכר']` (exported; a proposed name or description containing any as a whole word is dropped).
  - `ContactClusterer = (req: { summaries: { index: number; text: string }[]; existingTopicNames: string[]; signal?: AbortSignal }) => Promise<{ status: 'ok'; raw: unknown } | { status: 'failed'; reason: string }>`; `runContactClusterer` (model `'haiku'`, quarantine per Global Constraints); `buildClustererCall(req, nonce?)` exported for the test. Prompt: group summaries that ask about the same kind of thing; propose a short Hebrew name and one-line description per group; never cost/margin/other people; return `{ groups: [{ name, description, indexes: number[] }] }`.
  - `parseClusters(raw: unknown, ctx: { rows: { decisionId; sourceNames: string[]; approved: boolean; contactKind }[]; existingTopicNames: string[]; contactNames: string[] }): NewTopicPayload[]` — pure: zod `.strict()`; garbage → `[]`; indexes out of range or repeated across groups → that index dropped; a group kept only with ≥ `NEW_TOPIC_MIN_DECISIONS` distinct indexes; name `toOneLine(stripBidiControls())`, 2–40 chars, description ≤ 200; dropped if name/description hits `H8_WORDS` or any `contactNames` entry (whole word, case-insensitive), or the normalised name equals an existing topic name; `sources` = union of `sourceNames` of the group's **approved** rows filtered to `TIER2_SOURCE_NAMES`; `appliesTo` from contact kinds as in Task 2; `decisionIds` from the rows.

- [ ] **Step 1: Failing tests** (parser): a valid group of 5 → one payload with the union of approved rows' sources only; group of 4 → none; index 99 dropped (group then 4 → none); name "עלות משלוח" → dropped; name containing a managed contact's name → dropped; name equal to an existing topic (spaces/case differ) → dropped; source `'bogus'` filtered out; garbage → `[]`. Classifier-style call test: `refuseUnderTest`; `tools: []`; `env` keys exactly `['PATH']`; `maxTurns: 1`; each summary between two identical nonce fences; a summary containing a forged fence marker is stripped.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (mirror `src/sdk/contact-classifier.ts`). **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): quarantined topic clusterer and parser`.

---

### Task 4: The suggestion pass and scheduler wiring

**Files:**
- Create: `src/whatsapp/suggestion-pass.ts`
- Modify: `src/orchestrator/scheduler.ts` (call after `contactHousekeeping`, only when the contact flow is wired), `src/config.ts` + `.env.example` (`CONTACT_CLUSTER_RUNS_PER_DAY`, default `2`)
- Test: `src/whatsapp/suggestion-pass.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `buildSuggestions(db, deps: { clusterer: ContactClusterer; now: Date; clusterRunsPerDay: number }): Promise<{ inserted: number; clusterCalled: boolean }>`:
    1. For each `autoReplyCandidates` → `insertSuggestion('auto_reply', …, shapeHashFor({kind:'auto_reply', topicId, topicUpdatedAt}))`.
    2. For each `publicDocumentCandidates` → `insertSuggestion('public_document', …)`.
    3. New topic: only when `unthemedDecisions` has ≥ `NEW_TOPIC_MIN_DECISIONS` rows decided after the last `contact_cluster` audit row (or none exists), and today's `contact_cluster` audit rows < `clusterRunsPerDay` (`0` = off). Write the audit row (`contact_cluster`, counts only) **before** the call (a billed call counts even if it fails); call with a 60 s deadline; `parseClusters`; insert each.
  - Scheduler passes `options.contactClusterer ?? runContactClusterer` and `config.contactClusterRunsPerDay`; errors caught and logged per pass, never thrown.

- [ ] **Step 1: Failing tests** (stub clusterer): learned topic → one `auto_reply` suggestion; second pass → still one; after owner rejects it → none inserted again; after the topic is updated (`updateTopic`) and learns again → a new suggestion (new shape). Public doc candidate → one suggestion. Five unthemed decisions → clusterer called once, its group inserted; a second pass with no new decisions → clusterer not called; cap `0` → never called; cap reached → not called; a throwing clusterer still leaves the `contact_cluster` audit row.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** + `src/orchestrator/scheduler*.test.ts` + typecheck — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): suggestion pass from owner decisions`.

---

### Task 5: Applying a suggestion — executor, WhatsApp delivery and reader

**Files:**
- Create: `src/whatsapp/suggestion-apply.ts`, `src/whatsapp/suggestion-whatsapp.ts`
- Modify: `src/orchestrator/whatsapp-open.ts` (sixth kind `suggestions`), `src/orchestrator/whatsapp-door.ts` (reader after `handleConfirmationMessage`; the confirmation reader's collision sum includes `open.suggestions.length`), `src/orchestrator/scheduler.ts` (deliver after `buildSuggestions`)
- Test: `src/whatsapp/suggestion-apply.test.ts`, `src/whatsapp/suggestion-whatsapp.test.ts`, extend `src/orchestrator/whatsapp-door*.test.ts`

**Interfaces:**
- Consumes: Task 1 store; `createTopic`, `setTopicAutoReply`, `loadTopic`, `listTopics`; `setPublicFor`; `appendAudit`; `SEVERAL_OPEN_REFUSAL`; `claimMessage`/`settleMessage`; `BossMessenger`.
- Produces:
  - `applySuggestion(db, suggestionId, decision: 'accept'|'reject', by: string): Promise<'applied'|'rejected'|'stale'|'already'>` — the **only** executor. Re-checks at decision time: new_topic — no live topic with the same normalised name; auto_reply — topic live, `autoReply === false`; public_document — document exists, `source = 'instruction'`, `status = 'extracted'`, `public_for IS NULL`. Stale → `decideSuggestion('expired')`, `'stale'`. Accept: claim with `decideSuggestion('accepted')` first, then `createTopic({ …payload, autoReply: false, by })` / `setTopicAutoReply(topicId, true, by)` / `setPublicFor(documentId, appliesTo, by)`, all in one transaction (`transaction(db, …)`). Audit `contact_suggestion:<kind>:<accepted|rejected|expired>` with hash of the id.
  - `SUGGESTION_TEXT` (Hebrew, per kind, built from payload, every field via `toOneLine(stripBidiControls())`), ending "לאשר? השיבי כן או לא". Replies: `SUGGESTION_APPLIED`, `SUGGESTION_REJECTED`, `SUGGESTION_STALE` = "ההצעה כבר אינה רלוונטית".
  - `deliverNextSuggestion(db, deps: { messenger: BossMessenger; now: Date; windowMinutes?: number }): Promise<boolean>` — only when no open suggestion is delivered and still inside the window; sends the oldest undelivered open one; `markSuggestionDelivered` only after `ok`.
  - `isSuggestionAnswer(text): 'yes'|'no'|null` — exactly "כן" / "לא" after `stripBidiControls`, trim, trailing punctuation removed; anything else `null`.
  - `OpenOnWhatsApp.suggestions: Suggestion[]` (from `deliveredOpenSuggestions`).
  - Door: typed text only; `isSuggestionAnswer` non-null; `open.suggestions.length > 0`; claim the message; more than one suggestion or anything else open → `SEVERAL_OPEN_REFUSAL`, nothing applied; else `applySuggestion` and reply.

- [ ] **Step 1: Failing tests:** accept each kind → effect + suggestion `accepted` + audit row; reject → no effect, `rejected`; second accept → `'already'`; **stale accept** (topic retired; document re-sourced to `mail`; topic already `auto_reply`) → no change, `'stale'`; new topic created with `autoReply === false` always. Delivery: one delivered at a time; a failed send leaves `delivered_at` null; next delivered only after the first is decided or its window passed. Door: "כן" typed after delivery inside window → applied; voice note "כן" → passthrough; "כן" before delivery → passthrough; **"כן" with a command confirmation open** → `SEVERAL_OPEN_REFUSAL`, neither applied; "כן" with a contact card open → refused; "כן תודה" → passthrough.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** + `src/orchestrator/whatsapp-door*.test.ts`, `src/orchestrator/command-confirm.test.ts`, `src/whatsapp/contact-card.test.ts` + typecheck — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): apply suggestions on WhatsApp and one executor`.

---

### Task 6: Suggestions on the settings screen

**Files:**
- Modify: `src/dashboard/contact-whatsapp-settings.ts` (section "הצעות"), its test
- Test: extend `src/dashboard/contact-whatsapp-settings.test.ts`

**Interfaces:**
- Consumes: `listOpenSuggestions`, `applySuggestion` (Task 5), `loadTopic`, document name lookup.
- Produces: section listing open suggestions (kind in Hebrew, text via `escLabel`, for auto_reply the counts "<right> מתוך <counted>", for public_document the document name and approvals) with two buttons; `POST` action `suggestion` with `suggestionId` and `decision=accept|reject`, CSRF first, then `applySuggestion(…, 'dashboard:<username>')`; result line per outcome (`SUGGESTION_APPLIED`/`REJECTED`/`STALE`).

- [ ] **Step 1: Failing tests:** page lists an open suggestion; accept via POST creates the topic; reject leaves no topic; no CSRF → 403 and unchanged; another business's suggestion id → 404.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): suggestions on the settings screen`.

---

### Task 7: Erasure, invariants, docs

**Files:**
- Modify: `src/governance/erasure-plan.ts`, `src/governance/erasure.ts`, `src/governance/erasure-invariants.test.ts`, `CLAUDE.md`, `docs/10-user-settings.md`, `docs/11-pre-launch-checks.md`
- Create: `src/whatsapp/suggestion-invariants.test.ts`

**Interfaces:**
- Produces:
  - Erasure: `contact_suggestions.payload` is a discovery source (`jsonbContentMatches`) and a delete target by `suggestion_id` (exported predicate shared by `countItems` and the executor); a new-topic suggestion whose `decisionIds` intersect decisions of erased jobs is deleted too. PROBE seeded in a new-topic payload's `name`. CLAUDE.md erasure count 44 → 45.
  - Invariant test: `setTopicAutoReply(…, true…)`, `createTopic` and `setPublicFor` are called in production only from the dashboard screens and `src/whatsapp/suggestion-apply.ts` (scan `src/`, tests excluded, > 100 files scanned, planted-call self-test).
  - CLAUDE.md: subsection "וואטסאפ ללקוחות ולספקים — שלב 2, חבילה 2" (signals, thresholds, clusterer quarantine and cap, one executor, delivery one at a time, the sixth open kind, no automatic promotion, known issues); "מה עוד לא נבנה" updated. docs/10: suggestions section and its boundary. docs/11: live clusterer run; suggestion answered on real WhatsApp — both under the "first real company" note.

- [ ] **Step 1: Failing tests:** erasure sweep finds PROBE in `contact_suggestions` before wiring; invariant scan.
- [ ] **Step 2: Run** `src/governance/erasure-invariants.test.ts src/governance/erasure-plan.test.ts src/whatsapp/suggestion-invariants.test.ts` — FAIL.
- [ ] **Step 3: Implement + docs.**
- [ ] **Step 4: Run** the three + typecheck + full suite on `$SDD` — PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): erasure and docs for suggestions`.
