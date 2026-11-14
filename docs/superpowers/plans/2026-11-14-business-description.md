# Business Description (Stage C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner writes a free-text description of his business. It is saved without a signature, fed to the drafting and planning model calls as background, and mined for rule proposals that enter the charter only through the existing sign path.

**Architecture:** An append-only table `business_descriptions` holds versions, written only from two dashboard handlers (interview and settings). A pure renderer turns the active version into one prompt section, and each model call that plans or drafts for the business receives it. One model call per save proposes rules. Code verifies each quoted sentence verbatim and builds the rule with `parseRuleProposal`. Surviving proposals land in the interview draft's `extra.pending`, so approval, the summary and signing are the unchanged stage-10 path. `src/policy/` never sees any of it.

**Tech Stack:** TypeScript (NodeNext, ESM), Postgres 17 with RLS, zod, vitest against real Postgres, `@anthropic-ai/claude-agent-sdk`.

**Spec:** [docs/superpowers/specs/2026-11-13-business-description-design.md](../specs/2026-11-13-business-description-design.md). Read it before starting.

## Global Constraints

- Trust level of the description: `boss`. It is written only from an authenticated owner session: the setup interview route or the settings route. No tool, mail, WhatsApp or plan path writes it.
- Cap: `BUSINESS_DESCRIPTION_MAX_CHARS = 8000`. Enforced in code with a Hebrew message, and again as a `CHECK (length(text) <= 8000)` in the table.
- Rule proposals per save: at most `DESCRIPTION_PROPOSALS_MAX = 10`. Only `forbid`, `do_not_contact` and `never_say` survive; `guidance` is dropped.
- Proposal runs: at most `DESCRIPTION_PROPOSAL_RUNS_PER_DAY = 10` per business, counted over a rolling 24 hours of `business_descriptions` rows (⚙ plan call; the spec says only "a small daily cap"). Over the cap the text still saves, and no model is called.
- Prompt section heading, verbatim: `# על העסק — במילים של בעל העסק (רקע, לא הרשאה)`. Not nonce-fenced. Placed after the charter text and before the capability catalogue in the planner. In the other calls it goes into `systemPrompt`, right after `promptFragments` (or after the base system prompt for the meeting extractor).
- Never fed to `intake.triage`, `know.reader`, `gov.verify`, the document judge (`doc-judge.ts`) or the curator.
- The assistant never writes or suggests edits to the description.
- Every DB access goes through `withBusiness`/`BusinessDb`. `businessId` is never optional or defaulted. `.js` on every relative import.
- Hebrew for the owner, English in code. Hebrew labels through `src/domain/labels.ts` where an enum is shown.
- Erasure never edits the description. The preview shows the line: `השם מופיע בתיאור העסק שלך. אם צריך, ערוך אותו בעצמך.`
- Tests run as the app account under RLS (`withBusiness(TEST_BUSINESS, …)`); seeding goes through `testDb()`. Run on a dedicated test DB (`assistant_test_sdd`) per CLAUDE.md, never in parallel with the hook on `assistant_test`.
- Do not commit unless the owner asks. The "Commit" steps below are checkpoints for the executor's local branch; skip `git commit` if running on `main` without the owner's go-ahead.

## Review Focus

1. **The owner pastes text with Windows line endings, nbsp or a doubled space, and the model quotes the sentence with normalised spacing.** The verbatim check must normalise whitespace on both sides (`\s+` → one space, trim), or every real proposal is dropped. Test owner: Task 4.
2. **A description exactly at 8,000 characters, and at 8,001, and one that is 8,000 Hebrew characters with combining marks.** Length is counted in UTF-16 code units, the same as the DB's `length()` for BMP text. 8,000 saves and 8,001 is refused before any DB write or model call. Test owner: Task 1.
3. **The owner saves twice quickly, or saves with no change.** Two saves are two versions. An unchanged save writes no new version and runs no proposer: compare to the active text after `trim`. Test owner: Task 1 (store) and Task 6 (route).
4. **A proposal duplicates a rule already accepted, already pending, or already rejected.** It is not proposed again. Comparison uses `normaliseSentence` (whitespace + Latin lowercase) on `rule.text`. Test owner: Task 4.
5. **The active charter does not parse when the owner saves on the settings screen.** The description still saves. Proposals are not added (there is no draft to prefill), and the page says so in Hebrew. Nothing throws. Test owner: Task 6.

---

### Task 1: Table, store and audit

**Files:**
- Create: `src/db/migrations/069_business_descriptions.sql`
- Create: `src/business/description-store.ts`
- Modify: `src/domain/audit.ts` (add `AuditKind` member `'description_change'`, with a doc comment: hash and length only, never the text)
- Test: `src/business/description-store.test.ts`

**Interfaces:**
- Produces:
  - `BUSINESS_DESCRIPTION_MAX_CHARS = 8000`
  - `DESCRIPTION_PROPOSAL_RUNS_PER_DAY = 10`
  - `interface BusinessDescription { version: number; text: string; createdAt: Date; createdBy: string }`
  - `loadActiveDescription(db: BusinessDb): Promise<BusinessDescription | null>`
  - `saveDescription(db: BusinessDb, input: { text: string; createdBy: string }): Promise<{ saved: true; description: BusinessDescription } | { saved: false; reason: 'unchanged' } | { saved: false; reason: 'too_long'; messageHe: string }>`. It trims the text. Empty text is a valid save: the owner may clear the description. It writes the row and the audit row in one `transaction(db, …)`.
  - `proposalRunsInLastDay(db: BusinessDb): Promise<number>`
  - `recordRejectedSentence(db: BusinessDb, sentence: string): Promise<void>` and `rejectedSentenceHashes(db: BusinessDb): Promise<ReadonlySet<string>>`
  - `normaliseSentence(s: string): string` (whitespace collapsed to one space, trimmed, Latin letters lower-cased) and `sentenceHash(s: string): string` (sha256 hex of `normaliseSentence(s)`)

- [ ] **Step 1: Write migration 069**
  - `business_descriptions (business_id text NOT NULL, version integer NOT NULL, text text NOT NULL CHECK (length(text) <= 8000), created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL, PRIMARY KEY (business_id, version))`.
  - `description_rule_rejections (business_id text NOT NULL, sentence_hash text NOT NULL CHECK (sentence_hash ~ '^[0-9a-f]{64}$'), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (business_id, sentence_hash))`.
  - For both tables: `ENABLE` + `FORCE ROW LEVEL SECURITY` and `CREATE POLICY tenant_isolation … USING/WITH CHECK (business_id = app_business_id())`. Migration 068 does not cover tables added after it.
  - `REVOKE UPDATE, DELETE ON business_descriptions FROM assistant_app`, so the table is append-only for the runtime account (TRUNCATE in tests runs as the migrator).
  - A header comment on why there is no erasure wiring: the owner's own text; erasure shows a notice instead (Task 7).

- [ ] **Step 2: Write the failing tests** in `description-store.test.ts`:
  - `saves a first version as 1 and the next as 2, and loads the latest`
  - `refuses 8001 characters with a Hebrew message and writes nothing`: assert `reason === 'too_long'`, `messageHe` contains `8,000`, and the row count is unchanged.
  - `accepts exactly 8000 characters`
  - `an unchanged save (after trim) writes no version and no audit row`
  - `writes one description_change audit row whose inputHash is the text hash and whose reason carries the length, never the text`: assert the audit `reason` does not contain a distinctive word from the text.
  - `the runtime account cannot UPDATE or DELETE a description row`: the query through `withBusiness` rejects with a permission error.
  - `a second business does not see the first business's description`
  - `proposalRunsInLastDay counts rows of the last 24 hours only`: seed one row via `testDb()` with `created_at = now() - interval '25 hours'`.
  - `rejected sentences are found by normalised hash`: `'Do  NOT\n call rival'` and `'do not call rival'` give the same hash.

- [ ] **Step 3: Run them to verify they fail**

Run: `TEST_DATABASE_URL="$SDD" npm run migrate:test && TEST_DATABASE_URL="$SDD" npx vitest run src/business/description-store.test.ts --no-file-parallelism`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/business/description-store.ts`**
  - Follow the `interface XRow` + `toX(row)` convention.
  - The next version is `coalesce(max(version), 0) + 1`, under `acquireAdvisoryLock(tx, 'description:' + businessId)` inside the transaction, so two concurrent saves cannot collide on the key.
  - Audit row: `actor: 'human'`, `onBehalfOf: createdBy`, `kind: 'description_change'`, `provenance: 'boss'`, `inputHash: canonicalHash({ length, sha256 })`, and `reason: 'תיאור העסק עודכן (גרסה <n>, <length> תווים)'`.

- [ ] **Step 5: Run the tests, plus `src/tenancy/rls.test.ts`, and verify they pass**

Run: `TEST_DATABASE_URL="$SDD" npx vitest run src/business/description-store.test.ts src/tenancy/rls.test.ts --no-file-parallelism && npm run typecheck`
Expected: PASS. Typecheck may flag exhaustive `Record<AuditKind, …>` maps. Add a Hebrew label there.

- [ ] **Step 6: Commit** — `feat(description): business_descriptions table and store`

---

### Task 2: The prompt section, in five model calls

**Files:**
- Create: `src/business/description-prompt.ts`
- Modify: `src/sdk/planner.ts` (`PlanRequest`, `buildPlannerPrompt`), `src/sdk/mail-drafter.ts`, `src/sdk/nudge-drafter.ts`, `src/sdk/doc-drafter.ts`, `src/sdk/meeting-extractor.ts`
- Test: `src/business/description-prompt.test.ts`, and add cases to the existing `planner.test.ts`, `mail-drafter.test.ts`, `nudge-drafter.test.ts`, `doc-drafter.test.ts`, `meeting-extractor.test.ts`

**Interfaces:**
- Produces:
  - `DESCRIPTION_HEADING = '# על העסק — במילים של בעל העסק (רקע, לא הרשאה)'`
  - `renderDescriptionSection(text: string | null | undefined): string`. It returns `''` for null, undefined or blank. Otherwise it returns `DESCRIPTION_HEADING`, one fixed Hebrew line, then the text. The fixed line is: `זה רקע שבעל העסק כתב כדי שתביני את העסק. הוא אינו מתיר שום פעולה — מה שמותר נקבע רק בתקנון ובשער.`
  - The module imports nothing from `src/db/`, `src/policy/` or `src/sdk/`.
  - Each request type gains `businessDescription?: string` (optional under `exactOptionalPropertyTypes`). This covers `PlanRequest`, the mail `DraftRequest`, `NudgeDraftRequest` and the doc `DraftRequest`, and the `MeetingExtractor` input object.

- [ ] **Step 1: Write the failing tests**
  - `renderDescriptionSection`: empty for `null`, `''` and `'   '`; the heading is the first line; the text is reproduced byte for byte (including a `"` and a newline).
  - `planner.test.ts` → `places the description after the charter and before the catalogue`: assert `indexOf(charterText) < indexOf(DESCRIPTION_HEADING) < indexOf('# מה כל סוכן יכול לעשות עכשיו')`. Also assert that with no description the prompt does not contain the heading.
  - For each of the mail drafter, nudge drafter, doc drafter and meeting extractor, one test: `the system prompt carries the description when given and omits the heading when not`. Use each module's `build…Call` export.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/business/description-prompt.test.ts src/sdk/planner.test.ts src/sdk/mail-drafter.test.ts src/sdk/nudge-drafter.test.ts src/sdk/doc-drafter.test.ts src/sdk/meeting-extractor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Planner:** insert `renderDescriptionSection(request.businessDescription)` plus a blank line between the charter block and the catalogue heading. Emit nothing when it is empty, so a prompt without a description is byte-identical to today's.
  - **Other calls:** add it to the `systemPrompt` array after the fragment line, with no blank pair when it is empty.

- [ ] **Step 4: Run the tests and verify they pass.** Run the same command. Expected: PASS, with every other existing test in those files still green.

- [ ] **Step 5: Commit** — `feat(description): render the description into planning and drafting prompts`

---

### Task 3: Production callers load and pass it

**Files:**
- Modify: `src/orchestrator/instruct.ts` (where `door.planner({...})` is built, ~line 696), `src/orchestrator/mail-reply.ts` (~line 124), `src/ledger/nudge.ts` (~line 267), `src/production/loop.ts` (the drafting call, ~line 461), `src/meetings/door.ts` (~line 225)
- Test: add one case to each module's existing test file

**Interfaces:**
- Consumes: `loadActiveDescription(db)` (Task 1) and `businessDescription?: string` on each request (Task 2).
- Each caller passes `{ businessDescription: d.text }` only when `d !== null && d.text.trim() !== ''`, using a conditional spread.

- [ ] **Step 1: Write the failing tests.** In each module's test, save a description through `saveDescription` and inject the module's existing test seam (planner / drafter / extractor stub). Assert that the stub received `businessDescription` equal to the saved text, and that it received no such key when no description exists. Test names: `passes the owner's business description to the planner` (and likewise: drafter, nudge drafter, document drafter, meeting extractor).
- [ ] **Step 2: Run them to verify they fail**

Run: `TEST_DATABASE_URL="$SDD" npx vitest run src/orchestrator/instruct.test.ts src/orchestrator/mail-reply.test.ts src/ledger/nudge.test.ts src/production/loop.test.ts src/meetings/door.test.ts --no-file-parallelism` (if any of these names differs, use the test file that already injects that seam). Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** Load once per job or attempt, on the `BusinessDb` the caller already holds. Never take a second connection while one is held (CLAUDE.md R15).
- [ ] **Step 4: Run the tests and verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(description): pass the description to the planner and drafters`

---

### Task 4: Proposals from a description

**Files:**
- Create: `src/business/description-proposals.ts` (pure)
- Create: `src/sdk/description-rules.ts` (the live call)
- Test: `src/business/description-proposals.test.ts`, `src/sdk/description-rules.test.ts`

**Interfaces:**
- Consumes:
  - `parseRuleProposal(raw: string, text: string): AcceptedRule` and `AcceptedRule` from `src/charter/interview/`
  - `normaliseSentence` from Task 1
- Produces:
  - `DESCRIPTION_PROPOSALS_MAX = 10`
  - `type DescriptionProposer = (description: string) => Promise<string>`. It returns the model's raw text, so parsing stays testable without the SDK.
  - `parseDescriptionProposals(raw: string, description: string, exclude: { rejectedHashes: ReadonlySet<string>; existingTexts: readonly string[] }): AcceptedRule[]`
  - `proposeFromDescriptionWithModel: DescriptionProposer`, plus `buildDescriptionRulesCall(description: string, nonce: string): { prompt: string; options: Options }`

- [ ] **Step 1: Write the failing tests** for `parseDescriptionProposals`. The model output is a JSON array of objects `{ "sentence": string, "kind": …, …same fields as stage 10… }`.
  - `keeps a forbid whose sentence appears verbatim, with the owner's sentence as rule text`
  - `matches a sentence across CRLF, nbsp and doubled spaces`. Test this both ways: the description has `"לא\r\n  לתת  הנחות"` and the model quotes `"לא לתת הנחות"`, and the reverse. In both cases the rule `text` is the substring as it appears in the description (original bytes, trimmed).
  - `drops an item whose sentence is not in the description`: the model paraphrased it.
  - `drops guidance and any item that parseRuleProposal falls back to guidance`
  - `drops a sentence over 500 characters`, because of the `AcceptedRule.text` cap.
  - `drops a rejected sentence and one already pending or accepted` (Review Focus 4)
  - `returns at most 10, in the model's order`
  - `returns [] on unparseable output`
- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement `parseDescriptionProposals`.**
  - To locate the substring, normalise the description while keeping an index map from normalised positions back to original positions. Find the normalised quote in it, then slice the original. Feed each item without `sentence` to `parseRuleProposal(JSON.stringify(rest), originalSentence)`.
  - Use `extractJsonObjects` from `util/json-extract.ts` for an object stream, or `JSON.parse` for an array. Accept either.
- [ ] **Step 4: Write `src/sdk/description-rules.ts`.**
  - Same hardening as `src/sdk/interview-rule.ts`: `tools: []`, `env: { PATH }`, `maxTurns: 1`, `settingSources: []`, `refuseUnderTest()`, and the description fenced with `buildFence`/`stripFenceMarkers` and a per-call nonce. The description is trusted, but it is fenced here because this prompt asks the model to treat it as data to classify.
  - Model: `'haiku'`, like stage 10.
  - The system prompt lists the reachable forbid rows exactly as `buildRuleCall` does. Extract that list into a shared exported helper in `interview-rule.ts` rather than copying it.
  - It instructs: return a JSON array; each item quotes one sentence of the owner word for word; at most 10 items; only sentences that state a prohibition, a do-not-contact, or a phrase never to write.
  - Tests: `buildDescriptionRulesCall has no tools and a PATH-only env`; `strips a forged fence marker from the description`; `refuses under NODE_ENV=test`.
- [ ] **Step 5: Run the tests and verify they pass.** Run: `npx vitest run src/business/description-proposals.test.ts src/sdk/description-rules.test.ts src/sdk/interview-rule.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** — `feat(description): rule proposals from the description`

---

### Task 5: The description in the setup interview

**Files:**
- Modify:
  - `src/dashboard/setup-routes.ts`: new `handleAboutPost`; `handleRuleChoice` records a rejection on `delete`.
  - `src/dashboard/setup-step-views.ts`: the step-10 view gains the description box.
  - `src/dashboard/server.ts`: route `POST /setup/about`; `SetupOptions`/server options gain `descriptionProposer?: DescriptionProposer`.
- Test: `src/dashboard/setup-routes.test.ts`

**Decision (⚙, left to the builder by the spec):** the box sits on the existing step-10 page, above "עוד משהו אסור?", headed `ספר לי על העסק (רשות)`, with the spec's hint list under it. It is not a new `INTERVIEW_SECTIONS` entry: the description is not charter input, and adding a section would change `STEP_COUNT`, the summary and the charter hash. The hint list reads: תחום העיסוק, איך נראה יום עבודה, איך מקבלים תשלומים, מי המתחרים, אילו שירותים נותנים, מה מפריע לך ובמה אפשר לעזור. The box is prefilled with the active description.

**Interfaces:**
- Consumes:
  - From Task 1: `saveDescription`, `loadActiveDescription`, `proposalRunsInLastDay`, `rejectedSentenceHashes`, `recordRejectedSentence`
  - From Task 4: `parseDescriptionProposals`, `DescriptionProposer`
  - Existing: `loadDraft`, `saveSection`, `editMustStartFromPrefill`
- Produces:
  - `handleAboutPost(res, db, session, form: URLSearchParams, options: SetupOptions): Promise<void>`
  - `addDescriptionProposals(db: BusinessDb, description: string, proposer: DescriptionProposer): Promise<{ added: number } | { added: 0; reason: 'cap' | 'no_draft' }>`. Task 6 reuses it.

- [ ] **Step 1: Write the failing tests** in `setup-routes.test.ts`, with an injected `descriptionProposer` stub:
  - `POST /setup/about saves the description and appends verified proposals to extra.pending`
  - `refuses a bad CSRF token and writes nothing`
  - `refuses 8001 characters with the Hebrew message, keeps the text in the box, calls no proposer`
  - `over the daily cap: saves, does not call the proposer, says so in Hebrew`
  - `an unchanged description calls no proposer`
  - `deleting a proposal on step 10 records its sentence as rejected, and the next save does not propose it again`
  - `the description is saved before any charter exists`: first-time interview, no `charter_active` row.
- [ ] **Step 2: Run them to verify they fail.** Run: `TEST_DATABASE_URL="$SDD" npx vitest run src/dashboard/setup-routes.test.ts --no-file-parallelism`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `handleAboutPost`, in order: CSRF check → `saveDescription` (`createdBy` = session username) → on `saved` and under the cap → `addDescriptionProposals` → `seeOther('/setup/step/10')`.
  - `addDescriptionProposals` in the interview reads the draft (creating it the way `handleRulePost` does, with `baseCharterVersion`) and appends to `extra.pending` via `saveSection(db, 'extra', …)`. `existingTexts` = texts of `pending` + `accepted`.
  - On `delete` in `handleRuleChoice`, call `recordRejectedSentence(db, rule.text)` before saving.
- [ ] **Step 4: Run the tests and verify they pass.** Expected: PASS, including the existing setup-routes tests.
- [ ] **Step 5: Commit** — `feat(description): description box and proposals in the setup interview`

---

### Task 6: Settings screen after setup

**Files:**
- Create: `src/dashboard/description-routes.ts` (GET/POST `/settings/description`)
- Modify:
  - `src/dashboard/setup-routes.ts`: extract the readable-charter branch of `handleSetupEdit` into an exported `ensureEditDraft(db: BusinessDb): Promise<InterviewDraft | null>`. It returns `null` when there is no readable active charter. `handleSetupEdit` keeps its behaviour by calling it.
  - `src/dashboard/server.ts`: routes, plus a link `תיאור העסק` in the settings navigation next to the existing settings links.
- Test: `src/dashboard/description-routes.test.ts`

**Decision (⚙):** "approving a proposal" after setup means moving it from `extra.pending` to `extra.accepted` on the existing step-10 page. Saving the description puts proposals into the draft's `pending`, prefilled from the active charter by `ensureEditDraft`. The settings page then lists them with one link: `עבור על ההצעות וחתום` → `/setup/step/10`. Signing is the unchanged summary/sign path. This is spec decision 3 implemented with zero new approval code.

**Interfaces:**
- Consumes:
  - Task 1: the store
  - Task 5: `addDescriptionProposals`
  - Here: `ensureEditDraft`
- Produces: `handleDescriptionGet(res, db, session)` and `handleDescriptionPost(res, db, session, form, options)`

- [ ] **Step 1: Write the failing tests**
  - `GET shows the active description and a CSRF token; escapes HTML and strips bidi controls in the shown text` (via `escLabel`)
  - `POST saves a new version and lists the new proposals with the link to step 10`
  - `with no open draft, POST prefills one from the active charter and its base version is the active version`
  - `with an open draft started from the active charter, proposals are appended to it, not replacing other edits`
  - `the active charter is unchanged after POST until the owner signs`: the `charter_active` pointer is identical.
  - `an unreadable active charter: the description saves, no proposals, Hebrew notice, status 200` (Review Focus 5)
  - `over the daily cap: saves, no proposer call, Hebrew notice`
  - `an unauthenticated request is redirected to login and writes nothing`
- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** In `addDescriptionProposals`, when called from the settings page, get the draft via `ensureEditDraft`. When it returns `null`, return `{ added: 0, reason: 'no_draft' }`. Give the function a parameter `draftSource: 'interview' | 'edit'` so the two callers stay explicit. Notices in Hebrew:
  - `no_draft`: `התיאור נשמר. לא הצעתי כללים, כי לא הצלחתי לקרוא את הכללים הנוכחיים — אפשר לעדכן אותם ב"ערוך את הכללים".`
  - `cap`: `התיאור נשמר. להיום כבר הצעתי כללים מספיק פעמים — אציע שוב בשמירה של מחר.`
- [ ] **Step 4: Run the tests and verify they pass**, together with `setup-routes.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(description): settings screen and post-setup proposals`

---

### Task 7: Erasure notice

**Files:**
- Modify:
  - `src/governance/erasure-plan.ts`: add `ErasurePlan.descriptionMentionsContact: boolean`
  - `src/dashboard/server.ts`: `planFingerprint` includes it
  - `src/dashboard/views.ts`: a new section in `renderErasure`
  - `src/governance/erasure-invariants.test.ts`
- Test: `src/governance/erasure-plan.test.ts`, `src/governance/erasure-invariants.test.ts`

**Interfaces:**
- `descriptionMentionsContact` is `true` only for a `contact` anchor whose identifier appears, through `ILIKE` with `likeLiteral(identifier)` and `LIKE_ESCAPE`, in the active (latest) description text of this business. It is `false` for window and document anchors.

- [ ] **Step 1: Write the failing tests**
  - `erasure-plan.test.ts` → `flags a contact named in the active description`, and `does not flag a contact named only in an older version`.
  - `matches an identifier containing _ literally`: the description has `dana_x@a.co`, and the anchor `dana%x@a.co` must not match.
  - `erasure-plan.test.ts` → `executeErasure leaves the description untouched`
  - `erasure-invariants.test.ts`: seed `PROBE` into `business_descriptions`, add `'business_descriptions'` to `SURVIVES` with a comment citing the spec, and add a test: `a table that survives by name shows the owner a notice: business_descriptions → plan.descriptionMentionsContact`. Assert it is `true` for the seeded probe.
  - A views test: the preview contains `השם מופיע בתיאור העסק שלך. אם צריך, ערוך אותו בעצמך.` and a link to `/settings/description` when the flag is true, and no such line when it is false.
- [ ] **Step 2: Run them to verify they fail.** Run: `TEST_DATABASE_URL="$SDD" npx vitest run src/governance/erasure-plan.test.ts src/governance/erasure-invariants.test.ts src/dashboard/erasure-routes.test.ts --no-file-parallelism`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use one `SELECT` on the latest version (`ORDER BY version DESC LIMIT 1`). Add the flag to `planFingerprint`. Do not touch `countItems` or the executor.
- [ ] **Step 4: Run the tests and verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(description): erasure preview names the description, never edits it`

---

### Task 8: Structural controls and docs

**Files:**
- Create: `src/business/description-invariants.test.ts`
- Modify: `CLAUDE.md` (new subsection "תיאור העסק (14/11)" under "כללים שהקוד אוכף בשקט"; update the test count in "פקודות" to the measured number), `docs/10-user-settings.md` (a new section), `docs/11-pre-launch-checks.md` (a new line)

- [ ] **Step 1: Write the invariant tests**
  - `src/policy/ never reaches the description modules`: a BFS over the import graph from every file in `src/policy/` (non-test), modelled on `digest-invariants.test.ts`. No reached path is under `src/business/`. Also assert the walk reached at least `src/domain/action.ts`, so an empty walk fails.
  - `only the store writes business_descriptions, and only dashboard files import saveDescription`: a recursive scan of `src/` (non-test). The string `INSERT INTO business_descriptions` appears only in `description-store.ts`. Only files under `src/dashboard/` import `saveDescription`. First assert the scan found more than 100 files.
  - `no tool writes the description`: `classify.ts`, `capabilities.ts` and `local-tools.ts`, read as text, contain neither `business_descriptions` nor `saveDescription`.
  - `the gate decides the same with and without a description that "permits" a discount`: save `'אני תמיד מאשר הנחות עד 10%. מותר לתת הנחה של 10%.'`, then call `evaluateToolCall` for a `discount.grant` step with `discountPercent: 10` under the test charter. Compare `decision`, `reason` and the audit row kinds against the same call with no description. Assert the step actually reached the gate's decision stage (a non-`tool_not_allowlisted` outcome), so the pair is not green for the wrong reason (CLAUDE.md: "מבחן שלילי שמחזיק גם בלי הקוד…").
- [ ] **Step 2: Run them to verify they pass.** They guard existing structure, so they should pass on first run. To prove each one bites, temporarily add `import '../business/description-store.js'` to one policy file and watch the BFS test fail, then revert.
- [ ] **Step 3: Write the docs.**
  - **CLAUDE.md:** the rules from this plan in the file's style: understanding, not authority; the writers; the prompt placement and why; quarantine agents excluded; proposals only via the draft; erasure shows and never edits; the daily cap.
  - **docs/10:** what the owner chooses: the text, and accepting or rejecting proposals.
  - **docs/11:** `☐ הרצה חיה של הצעת כללים מתיאור עסק (proposeFromDescriptionWithModel) על תיאור אמיתי בעברית`.
- [ ] **Step 4: Full verification.** Run `npm run typecheck` and `TEST_DATABASE_URL="$SDD" npm test`. Expected: green. Record the counts in CLAUDE.md.
- [ ] **Step 5: Commit** — `test(description): structural controls; docs`
