# Charter Interview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new business's owner goes through a 10-step Hebrew interview in the dashboard. It ends on a summary derived from the charter it will sign, and one click signs and installs the business's first real charter (or a superseding one when editing). Before that, nothing runs.

**Architecture:** A draft row holds the answers. Each step saves one whole section. One pure function, `buildCharterFromInterview`, is the only source of the charter JSON. The summary renders *its* output, and the sign POST rebuilds it and compares hashes before signing. Signing, installing, the audit row and the draft deletion are one transaction. The autonomy dial is applied after commit. A dashboard gate redirects to `/setup` while the business has no active charter.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` imports), Postgres (real DB in tests), vitest, zod 4, `@anthropic-ai/claude-agent-sdk` (stage 10 only).

**Spec:** [docs/superpowers/specs/2026-10-31-charter-interview-design.md](../specs/2026-10-31-charter-interview-design.md). Read §3 first: the owner's 31/10 rulings put stage-1 guidance in `identity`, not the memory table, and default `email.reply` to "לבד".

## Global Constraints

- No change to `policy/engine.ts`, `ActionClass`, `TrustLevel`, or `CURRENT_SCHEMA_VERSION` (spec §8.1).
- Nothing the interview does writes the `memories` table (spec §3, §6.5 cancelled).
- Owner-facing text is Hebrew; action classes and levels are shown only through `src/domain/labels.ts`; money through `formatMinor`; every echoed typed value goes through `escLabel`; every POST checks `verifyCsrfToken` (spec §8.2–3).
- No model call in steps 1–9. Step-1 follow-ups are fixed strings (spec §8.4).
- Controls are written positively: `ALONE_ALLOWED` is a named set, never "not in NEVER_FULLY_AUTONOMOUS" (spec §8.5).
- A charter the interview builds must parse, verify, compile, and pass `capabilities.test.ts` invariants (spec §8.6).
- Mandatory Hebrew copy, verbatim from the spec:
  - `CEILING_NOTE` = `הטבלה קובעת את המקסימום. כמה מזה אני משתמשת בפועל תבחר בשלב 9 — ואפשר להעלות ולהוריד בכל רגע.`
  - `REPLY_ALONE_NOTE` = `זה המקסימום; בפועל אני עונה לבד רק אם תבחר 'לומדת' ואוכיח את עצמי.`
  - `BOSS_COMMAND_NOTE` = `הוראה שאתה נותן לי בעצמך ומאשר בשאלה שאני מציגה — מתבצעת גם אם היא סותרת את הכללים כאן, כולל שעות שקט ואנשים שאסור לפנות אליהם. רק מתג העצירה עוצר אותה.`
  - `AUTHORITY_NOTE` = `בלחיצה אתה מצהיר שאתה מוסמך לחייב את העסק בכללים האלה. החתימה על אחריותך.`
  - `ONLY_YOU_APPROVE_NOTE` = `היום רק אתה מאשר את הפעולות שלי — בדשבורד ובוואטסאפ שלך.`
  - `WHATSAPP_NOTE` = `בוואטסאפ אני מדברת רק איתך. הודעות מלקוחות בוואטסאפ אינן חלק ממה שאני עושה היום.`
  - `DOCUMENTS_NOTE` = `את זה מפעיל מי שמתקין את המערכת.`
  - `NEVER_ALONE_NOTE` = `לעולם לא לבד — זה גבול של המערכת, לא שלך.`
  - `GUIDANCE_TAG` = `הנחיה — לא חסימה`
- Next migration number: `051`.
- Implementers run only focused files with `--no-file-parallelism`, on a dedicated DB (CLAUDE.md, "הרצת מבחנים במקביל ל-hook"). The controller runs the full suite.

## Review Focus

1. **The owner leaves mid-interview and returns days later.** The draft persists and `/setup` resumes at the first step with no saved section. Pinned in Task 8 (`resumes at the first unanswered step`).
2. **The owner edits a step after viewing the summary, then signs from the old tab.** Refused. Saving a section clears `frozen_at`, and the shown hash no longer matches. Pinned in Task 7 (`refuses a sign whose shown hash is stale`).
3. **Two tabs sign the first install at once.** One installs, the other gets `stale`. Pinned in Task 7 (`two concurrent first installs: exactly one wins`).
4. **Typed names carrying bidi controls or HTML.** Rendered escaped and bidi-stripped on the summary. Pinned in Task 8 (`escapes typed names on the summary`).
5. **A wildcard domain, a local-form phone, or a principal WhatsApp number without `+972`.** These produce a Hebrew error on the same step, never a 500 or a sign-time throw. Pinned in Task 2 (schema) and Task 8 (`re-renders step 8 with the domain error`).

---

### Task 1: Draft table, draft store, erasure wiring

**Files:**
- Create: `src/db/migrations/051_charter_interview_drafts.sql`
- Create: `src/charter/interview/draft-store.ts`
- Test: `src/charter/interview/draft-store.test.ts`
- Modify: `src/governance/erasure-plan.ts`, `src/governance/erasure.ts`, `src/governance/erasure-invariants.test.ts`, `src/governance/erasure-plan.test.ts`

**Interfaces:**
- Consumes: `InterviewAnswersDraft` from Task 2. Store `answers` as `unknown` jsonb here, and parse with Task 2's schema in `loadDraft`. If Task 2 lands first, import it. Otherwise type it `Record<string, unknown>` and tighten in Task 2.
- Produces:
  - `interface InterviewDraft { draftId: string; businessId: string; answers: InterviewAnswersDraft; frozenAt: Date | null; baseCharterVersion: string | null; updatedAt: Date }`
  - `loadDraft(businessId: string, db?: Queryable): Promise<InterviewDraft | null>`
  - `saveSection(businessId: string, section: keyof InterviewAnswers, value: unknown, options?: { baseCharterVersion?: string | null }): Promise<InterviewDraft>`: upsert; a new row gets `draft_id = ulid()`; **always sets `frozen_at = NULL`**; `baseCharterVersion` is written only on insert.
  - `replaceDraft(businessId: string, answers: InterviewAnswersDraft, baseCharterVersion: string | null): Promise<InterviewDraft>` (edit-mode prefill; also clears `frozen_at`)
  - `freezeDraft(businessId: string, at: Date): Promise<Date>`: sets `frozen_at` only if NULL and returns the effective value
  - `deleteDraft(businessId: string, tx: Queryable): Promise<void>`
  - `CHARTER_INTERVIEW_DRAFTS_ERASED_PREDICATE = 'business_id = $1 AND draft_id = ANY ($2)'`, and `ErasurePlan.draftIds: string[]` (sorted before the fingerprint)

Migration columns: `draft_id text PRIMARY KEY`, `business_id text NOT NULL UNIQUE`, `answers jsonb NOT NULL DEFAULT '{}'`, `frozen_at timestamptz`, `base_charter_version text`, `updated_at timestamptz NOT NULL DEFAULT now()`. No foreign keys.

- [ ] **Step 1: Write failing store tests** in `draft-store.test.ts`:
  - `saveSection creates one draft per business and merges sections`: save `business`, then `hours`. `loadDraft` returns both, and there is exactly one row.
  - `saveSection clears frozen_at`: `freezeDraft(t)`, then `saveSection(...)`, then `loadDraft(...).frozenAt` is `null`.
  - `freezeDraft keeps the first freeze`: freeze at `t1`, then at `t2`; the result equals `t1`.
  - `drafts are business-scoped`: business A's draft is invisible to `loadDraft('B')`.
- [ ] **Step 2: Run them, expect FAIL** (`no such table`/module). Run: `TEST_DATABASE_URL="$SDD" npm run migrate:test`, then `TEST_DATABASE_URL="$SDD" npx vitest run src/charter/interview/draft-store.test.ts --no-file-parallelism`
- [ ] **Step 3: Write the migration and the store** (`interface DraftRow` + `toDraft(row)` convention). The section merge is `answers || jsonb_build_object($2::text, $3::jsonb)`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Wire erasure** following the `digests` pattern exactly (`DIGESTS_ERASED_PREDICATE`/`digestIds`):
  - Discovery: for a contact anchor, `SELECT draft_id FROM charter_interview_drafts WHERE business_id = $1 AND (${jsonbContentMatches('answers', '$2')})`.
  - Delete in `countItems` and the executor with the shared predicate.
  - The table count in CLAUDE.md goes from 22 to 23 in Task 9.
  - In `erasure-invariants.test.ts`, seed `PROBE` inside `answers.counterparties.doNotContact[0].label`, and assert the scan stays clean and the row is gone.
- [ ] **Step 6: Run** `erasure-invariants.test.ts erasure-plan.test.ts erasure.test.ts` with `--no-file-parallelism`. Expect PASS.
- [ ] **Step 7: Commit** `feat(interview): draft table and store, wired to erasure`

---

### Task 2: The answers schema

**Files:**
- Create: `src/charter/interview/answers.ts`
- Test: `src/charter/interview/answers.test.ts`
- Modify: `src/domain/charter.ts` (export `emailDomainProblem`; no behaviour change)

**Interfaces:**
- Produces (each a zod schema plus a same-named type):
  - `InterviewLevel = z.enum(['never', 'approve', 'alone'])`
  - `CounterpartyEntry = { label: string(min 1); emailDomain?: string; phone?: string }`, refined: at least one of the two; `emailDomain` checked with `emailDomainProblem` (its message is the issue message); `phone` must be non-null under `authorityNumberKey`.
  - `AcceptedRule` = discriminated union on `kind`:
    - `{ kind: 'forbid'; text: string; actionClasses: ActionClass[] (min 1) }`
    - `{ kind: 'do_not_contact'; text; entry: CounterpartyEntry }`
    - `{ kind: 'never_say'; text; phrase: string }`
    - `{ kind: 'guidance'; text }`
    - `text` is at most 500 characters.
  - `InterviewAnswers = z.object({...})` with sections:
    - `business`: `{ description: string; legalName: string; tradeName: string; vertical: string; employees: int ≥ 1; expectations: string; notDone: string[]; keyFacts: {q,a}[] }`
    - `principal`: `{ displayName: string; role: string; whatsapp: string | null (authorityNumberKey non-null when present, Hebrew message from signCharter's wording); email: string | null }`
    - `voice`: `{ register: CharterVoice.shape.register; signOff: string; emojiPolicy; mustNeverSay: string[] }`
    - `hours`: `{ workweek: Weekday[] (min 1); open: TimeOfDay; close: TimeOfDay; quietHours: {from,to} | null; timezone: string (isResolvableTimeZone) }`
    - `reading`: `{ mailbox: 'none' | 'google' | 'microsoft'; documents: boolean }`
    - `actions`: `z.partialRecord(ActionClass, InterviewLevel)`. Missing rows take `ROW_DEFAULTS` (Task 3).
    - `money`: `{ singleMinor: int ≥ 0; dailyMinor: int ≥ 0; monthlyMinor: int ≥ 0; maxDiscountPercent: 0..100 }`
    - `counterparties`: `{ known: CounterpartyEntry[]; doNotContact: CounterpartyEntry[] }`
    - `autonomy`: `{ mode: AutonomyMode }`
    - `extra`: `{ accepted: AcceptedRule[]; pending: AcceptedRule[] }`
  - `InterviewAnswersDraft = InterviewAnswers.partial()` (a section is always saved whole)
  - `INTERVIEW_SECTIONS: readonly (keyof InterviewAnswers)[]` in step order: `business, principal, voice, hours, reading, actions, money, counterparties, autonomy, extra` (step n = index n−1)

- [ ] **Step 1: Write failing tests:**
  - `rejects a wildcard domain with the charter's own message`: the issue message equals `emailDomainProblem('*.rival.co.il')`.
  - `rejects a principal WhatsApp number in local form`: `'0541234567'` fails; `'+972541234567'` passes.
  - `a counterparty needs a domain or a phone`.
  - `InterviewAnswersDraft accepts a draft holding only business`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** and export `emailDomainProblem`.
- [ ] **Step 4: Run, expect PASS.** Also run `src/domain/charter.test.ts` (unchanged behaviour).
- [ ] **Step 5: Commit** `feat(interview): answers schema`

---

### Task 3: Rows, defaults per row, availability

**Files:**
- Create: `src/charter/interview/rows.ts`
- Test: `src/charter/interview/rows.test.ts`

**Interfaces:**
- Produces:
  - `INTERVIEW_ROWS = ['email.reply','email.initiate','whatsapp.reply','whatsapp.initiate','calendar.create','calendar.move','calendar.cancel','quote.issue','discount.grant','commitment.make','purchase.place','refund.issue','crm.write','accounting.write','doc.deliver','media.publish'] as const`; `type InterviewRow = typeof INTERVIEW_ROWS[number]`
  - `MONEY_ROWS: ReadonlySet<InterviewRow>` = `quote.issue, discount.grant, commitment.make, purchase.place, refund.issue`
  - `ALONE_ALLOWED: ReadonlySet<InterviewRow>` = `email.reply, whatsapp.reply, calendar.create, calendar.move, crm.write`
  - `ROW_DEFAULTS: Record<InterviewRow, InterviewLevel>`: `email.reply: 'alone'`; every `MONEY_ROWS` member and `accounting.write`, `media.publish`: `'never'`; everything else `'approve'`
  - `ROW_EXAMPLES: Record<InterviewRow, string>`: one Hebrew "מה זה אומר בפועל" sentence each (wording is the builder's)
  - `REFINES_FROM: Record<'email.initiate' | 'whatsapp.initiate' | 'calendar.move' | 'calendar.cancel', ActionClass>` = `email.initiate → email.reply`, `whatsapp.initiate → whatsapp.reply`, `calendar.move → calendar.create`, `calendar.cancel → calendar.create`. A test asserts its keys equal `REFINEMENT_ONLY_CLASSES`.
  - `isReachable(cls: ActionClass): boolean`: some classified tool `t` (`classifiedToolNames()`) with `classifyAction(t) === (REFINES_FROM[cls] ?? cls)` that some agent permits (`isToolPermitted(agent, t)` over the keys of `AGENT_ALLOWLISTS`)
  - `cannotAtAll(): ActionClass[]`: `ActionClass.options` filtered `!isReachable`, sorted
  - `type Availability = 'works' | 'not_connected' | 'not_built'`
  - `ADAPTER_TOOLS: ReadonlySet<string> = new Set(['mail.send'])`: tools a real adapter performs
  - `availabilityOf(cls: ActionClass, connections: readonly CharterConnection[]): Availability`: `works` if a reachable tool for `cls` is in `implementedLocalTools()`, or is in `ADAPTER_TOOLS` and some connection's `serves` includes it; `not_connected` if such a tool is in `ADAPTER_TOOLS` but nothing serves it; else `not_built`

- [ ] **Step 1: Write failing tests:**
  - `every interview row is reachable`: `INTERVIEW_ROWS.every(isReachable)`. If one fails, move it out of the rows and say so in the commit. Do not weaken the test.
  - `ALONE_ALLOWED never meets NEVER_FULLY_AUTONOMOUS or an initiate class`.
  - `email.reply defaults to alone; money rows default to never`.
  - `mail is works with a mailbox connection and not_connected without one`.
  - `calendar.create and quote.issue are not_built today`.
  - `cannotAtAll includes contract.sign`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(interview): action rows, defaults and availability`

---

### Task 4: Building the charter from answers (and back)

**Files:**
- Create: `src/charter/interview/defaults.ts`, `src/charter/interview/build.ts`
- Modify: `src/charter/amend-mailbox.ts`: export `mailboxConnection(provider: MailProvider): CharterConnection` and `splitConnections` (extracted from `buildMailboxAmendment`, which then uses them; behaviour unchanged)
- Test: `src/charter/interview/build.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - `defaults.ts`:
    - `FIXED_BASE: Record<Exclude<ActionClass, InterviewRow>, AutonomyLevel>`, values copied from `src/test/fixtures.ts` `BASE_AUTONOMY`. The compiler makes it exhaustive.
    - `INTERVIEW_PROVENANCE_CEILING` (same as the fixture's)
    - `FIXED_FORBIDDEN: ForbiddenRule[]` (the fixture's three rules, same ids)
    - `DATA_DEFAULTS` (the fixture's `retentionDays`, `redactBeforeSending`, `mayShareExternally`; `subprocessorsAllowed: ['anthropic']`)
    - `MEETING_DEFAULTS` (schema defaults)
    - `DEFAULTS_CHOSEN_HE: string[]`: one Hebrew line per default, for the summary
  - `buildCharterFromInterview(answers: InterviewAnswers, ctx: { businessId: string; frozenAt: Date; previous: BusinessCharter | null }): UnsignedCharter`
  - `prefillFromCharter(charter: BusinessCharter): InterviewAnswersDraft`
  - `INTERVIEW_RULE_PREFIX = 'interview_'`

Decisions the implementer cannot make alone:
- `charterVersion` = `` `${frozenAt.toISOString()}.iv-${canonicalHash({ businessId, answers, previous: previous?.charterVersion ?? null }).slice(0, 12)}` ``. It is deterministic so the sign POST reproduces it; `effectiveFrom = frozenAt.toISOString()`; `supersedes = previous?.charterVersion` (omitted when null).
- `whatWeDo` = `` `${description} בעסק ${employees} עובדים. מה מצופה ממני: ${expectations}` ``. `prefillFromCharter` splits it back with the inverse regex; a non-matching `whatWeDo` goes whole into `description`, and `employees`/`expectations` stay unset.
- Per row level (answer or `ROW_DEFAULTS`): `never` → `base: 'draft_only'` plus `ForbiddenRule { id: 'interview_never_' + cls, description: 'לעולם לא: ' + ACTION_CLASS_HE[cls], actionClasses: [cls] }`; `approve` → `approve_required`; `alone` → `auto_notify`. Throw if `cls ∉ ALONE_ALLOWED`.
- If every `MONEY_ROWS` level is `never`: all three ceilings are 0 and `maxDiscountPercent` is 0, whatever `answers.money` says.
- `people[0]`: `{ id: 'p_principal', isPrincipal: true, displayName, role, channels: {whatsapp?, email?}, approvalRights: [], canAmendCharter: true, canTripKillSwitch: true }`.
- Counterparties: `known` → `trust: 'known_counterparty'`; `doNotContact` and accepted `do_not_contact` rules → `trust: 'unknown_external', doNotContact: true`. The match is `emailDomain` or `phone`.
- Mailbox: `reading.mailbox !== 'none'` and no mailbox in `previous` → apply `splitConnections` and add `mailboxConnection(provider)`, plus the provider subprocessor. A mailbox in `previous` is kept whatever the answer.
- Extra rules: `forbid` → `ForbiddenRule` id `interview_extra_<i>`; `never_say` → `mustNeverSay`; `guidance` → `whatWeDoNotDo`.
- `previous !== null`: keep everything the interview does not ask. That is: `identity.languages/locations`, `operations.holidays/slaHours/meetingDefaults`, every non-principal person and the principal's `approvalRights/notify/escalationOrder`, counterparties whose match is `entityId`/`tag` or that carry `autonomyOverrides`/`notes`/`priceListId`/`paymentTermsDays`, connections other than the mailbox, `money.perActionClassCeilingMinor/paymentInstruments/approvedSuppliers`, `autonomy.provenanceCeiling/maxNudgesPerThread/preferenceConfidenceThreshold`, `data` except a union on `subprocessorsAllowed`, `voice.persona/mustSay/exemplars/responseLength`, and every forbidden rule whose id does not start with `INTERVIEW_RULE_PREFIX`. `FIXED_FORBIDDEN` is deduped by id. With no `previous`, `persona` = `` `את העוזרת של ${tradeName}.` `` and `languages: ['he']`.

- [ ] **Step 1: Write failing tests** (one fixture `completeAnswers()` in the test file):
  - `builds a charter that parses, verifies and compiles`: `compileCharter(BusinessCharter.parse(signCharter(build(...), { signedByPersonId: 'u', method: 'dashboard_click' })))` does not throw.
  - `is deterministic for the same frozenAt`: two builds have equal `canonicalHash`.
  - `a never row becomes a forbidden rule that the gate enforces`: install the built charter; `evaluateToolCall('quote.issue', { amountMinor: 100 }, ctx)` returns deny with a reason starting `forbidden:` (not `tool_not_allowlisted`). Build the `ctx` the way `src/policy/engine.test.ts` does.
  - `email.reply defaults to auto_notify`.
  - `all money rows never zeroes the ceilings`.
  - `mailbox google adds the connection and moves mail.send to it`.
  - `editing keeps fields the interview never asks`: take `buildCharter()` from fixtures as `previous`, rebuild from `prefillFromCharter(previous)` completed with the missing sections; `approvedSuppliers`, `paymentInstruments`, `slaHours` and the `c_812` counterparty survive; `supersedes === previous.charterVersion`.
  - `prefill round-trips an interview-built charter`: `prefillFromCharter(build(a))` deep-equals `a` (minus `extra.pending`, and `autonomy`, which is not in the charter. Prefill leaves those two unset).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**, including the `amend-mailbox.ts` extraction.
- [ ] **Step 4: Run** `build.test.ts amend-mailbox.test.ts capabilities.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `feat(interview): build the charter from the answers`

---

### Task 5: The summary, derived from the charter

**Files:**
- Create: `src/charter/interview/summary.ts`
- Test: `src/charter/interview/summary.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces:
  - `interface SummaryLine { actionClass: ActionClass; label: string; levelHe: string }`
  - `interface CharterSummary { can: SummaryLine[]; notYetWorking: SummaryLine[]; cannot: SummaryLine[]; cannotAtAll: string[]; limits: string[]; guidance: string[]; defaultsChosen: string[]; preserved: string[]; changes: string[] | null }`
  - `summarizeCharter(charter: UnsignedCharter, ctx: { previous: BusinessCharter | null; documentsWanted: boolean }): CharterSummary`
  - The copy constants from Global Constraints, exported from this file.

Rules:
- For each `INTERVIEW_ROWS` member: forbidden by a rule, or `base` of `draft_only`/`forbidden` → `cannot`. Otherwise `availabilityOf(cls, charter.connections) === 'works'` → `can`, else `notYetWorking` (the label notes `עוד לא זמין` / `לא מחובר`). `levelHe` comes from `AUTONOMY_LEVEL_HE[charter.autonomy.base[cls]]`, **never from the answers**.
- Also in `cannot`: the fixed forbidden rules' descriptions.
- `limits`: money ceilings via `formatMinor`, quiet hours, each do-not-contact label, each `mustNeverSay`.
- `guidance`: `whatWeDo`, each `whatWeDoNotDo`, each keyFact. The view tags each with `GUIDANCE_TAG`.
- `preserved`/`changes` only when `previous` is set. `changes` lists rows whose base changed, plus added and removed counterparties and forbidden rules.

- [ ] **Step 1: Write failing tests:**
  - `every row appears in exactly one column`.
  - `levels come from the charter, not the answers`: build, then mutate `charter.autonomy.base['crm.write']`, then summarize. The line shows the mutated level.
  - `a forbidden row is in cannot even though mail works`.
  - `changes is null on a first install and lists a changed row on an edit`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(interview): summary derived from the charter`

---

### Task 6: Stage 10, a proposed rule from free text

**Files:**
- Create: `src/charter/interview/rule-proposal.ts` (pure), `src/sdk/interview-rule.ts` (the call)
- Test: `src/charter/interview/rule-proposal.test.ts`
- Modify: `docs/11-pre-launch-checks.md` (one unchecked line: a live run of `proposeRuleWithModel` against three sample sentences)

**Interfaces:**
- Produces:
  - `parseRuleProposal(raw: string, text: string): AcceptedRule`: extracts the first JSON object (`extractJsonObjects` from `src/util/json-extract.ts`) and validates the model shape `{ kind: 'forbid'|'do_not_contact'|'never_say'|'guidance', actionClasses?: string[], label?: string, emailDomain?: string, phone?: string, phrase?: string }`. `actionClasses` are filtered to `INTERVIEW_ROWS` ∩ `isReachable`. Anything that does not validate, or a `forbid` left empty after filtering, becomes `{ kind: 'guidance', text }`. The rule is **built in code** from the validated fields; model text is never copied into a rule except `phrase`/`label`.
  - `describeRule(rule: AcceptedRule): string`: Hebrew, for example `לעולם לא: הוצאת הצעת מחיר`. Used by the step-10 view and the summary.
  - `proposeRuleWithModel(text: string): Promise<AcceptedRule>` in `src/sdk/interview-rule.ts`. It calls `refuseUnderTest` (copy the planner's guard, renamed in its message), `tools: []`, `env: { PATH }`, `settingSources: []`, `maxTurns: 1`. The owner's text is fenced with `buildFence` and a per-call nonce, and the prompt lists the rows with `ACTION_CLASS_HE` labels.
  - `type RuleProposer = (text: string) => Promise<AcceptedRule>`

- [ ] **Step 1: Write failing tests:**
  - `maps a forbid onto known rows only`: `actionClasses: ['quote.issue', 'payment.charge', 'nonsense']` → `['quote.issue']`.
  - `falls back to guidance on garbage`.
  - `an all-unknown forbid becomes guidance`.
  - `do_not_contact with a wildcard domain becomes guidance`.
  - `proposeRuleWithModel refuses under test`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(interview): stage-10 rule proposal`

---

### Task 7: Sign and install

**Files:**
- Create: `src/charter/interview/install.ts`
- Test: `src/charter/interview/install.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4.
- Produces:
  - `shownHashFor(draft: InterviewDraft, businessId: string, previous: BusinessCharter | null): string`: `canonicalHash(buildCharterFromInterview(...))`. Requires `frozenAt`.
  - `signAndInstallInterview(input: { businessId: string; username: string; shownHash: string }): Promise<InstallOutcome>`
  - `type InstallOutcome = { outcome: 'installed'; charterVersion: string; modeApplied: boolean } | { outcome: 'incomplete' | 'not_frozen' | 'hash_mismatch' | 'stale' }`

Order:
1. Load the draft. Missing or failing `InterviewAnswers.safeParse` → `incomplete`. Null `frozenAt` → `not_frozen`.
2. `previous` = `baseCharterVersion ? loadCharterVersion(...) : null`.
3. Build, hash, compare → `hash_mismatch`.
4. `signCharter(unsigned, { signedByPersonId: username, method: 'dashboard_click' })`.
5. `withTransaction`:
   - `pg_advisory_xact_lock(hashtext('charter-install:' || $1))`
   - read `charter_active`; it must equal `baseCharterVersion` (both null on a first install) → else `stale`
   - `installCharter(signed, { businessId, tx })`
   - `appendAudit({ actor: 'human', onBehalfOf: username, kind: 'charter_change', charterVersion, provenance: 'boss', inputHash: canonicalHash({ businessId, contentHash }), reason: 'charter signed through the setup interview by <username>' + (previous ? ', superseding <v>' : '') }, { businessId, tx })`. The reason carries no answer content.
   - `deleteDraft(businessId, tx)`
6. After commit: `setAutonomyMode(answers.autonomy.mode, username, { businessId })` in try/catch → `modeApplied`.

- [ ] **Step 1: Write failing tests:**
  - `first install activates the charter, writes one charter_change row, deletes the draft`.
  - `applies the chosen mode only after install`: with mode `learn`, `loadAutonomyMode` is `off` before and `learn` after.
  - `refuses a sign whose shown hash is stale`: freeze, compute hash, `saveSection(...)` (which unfreezes), freeze again → `hash_mismatch`, and nothing is installed.
  - `refuses when the active charter moved since the draft was based`: `stale`.
  - `two concurrent first installs: exactly one wins`: two drafts can't share a business, so call `signAndInstallInterview` twice in parallel on one draft. One `installed`; the other `stale` or `incomplete` (draft gone). Exactly one `charter_versions` row.
  - `an edit supersedes the previous charter`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(interview): sign and install in one transaction`

---

### Task 8: Dashboard screens, routes and the gate

**Files:**
- Create: `src/dashboard/setup-views.ts`, `src/dashboard/setup-routes.ts`
- Modify: `src/dashboard/server.ts` (gate and routes), `src/dashboard/views.ts` (`page()` nav gets `ערוך את הכללים` → `/setup/edit`; the connections screen shows a banner linking there when its existing `probeActiveCharter` reports an unreadable charter)
- Test: `src/dashboard/setup-routes.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: routes, behind session and `mustChangePassword`. Every POST verifies CSRF first.
  - `GET /setup` → redirect to `/setup/step/<first n whose section is unsaved>`, or `/setup/summary` when all ten are saved
  - `GET /setup/step/:n` (1–10) and `POST /setup/step/:n`. The POST parses the form into the section, validates it with that section's schema, and on failure re-renders 400 with the zod issue messages (Hebrew). On success it calls `saveSection` and redirects to the next step. Step 7 when all money rows are `never` renders the skip sentence and saves zeros. Step 1 shows a fixed follow-up line under any open answer under 8 words. A fixed array of three Hebrew follow-ups; wording is the builder's.
  - `POST /setup/rule` (`text`) → `options.ruleProposer ?? proposeRuleWithModel` → appended to `extra.pending` → redirect to step 10
  - `POST /setup/rule/:i` with `choice ∈ accept | guidance | delete`: moves `extra.pending[i]` (server-side, never from the form) into `accepted` as-is, or as `{kind:'guidance', text}`, or drops it. "תקן" = delete and re-submit text.
  - `GET /setup/summary`: needs a complete draft (else redirect `/setup`). Calls `freezeDraft(now)`, then `buildCharterFromInterview`, then `summarizeCharter`, then renders the columns, notes, `AUTHORITY_NOTE`, and a form with hidden `shownHash` and button `חתום והתחל`.
  - `POST /setup/sign`: `signAndInstallInterview`. `installed` → redirect `/`, with a `?mode=failed` banner when `!modeApplied`. Each refusal renders a Hebrew page with a link back to the summary.
  - `GET /setup/edit`: this is an install path, so it may call `probeActiveCharter`.
    - Probe ok and no draft → `replaceDraft(prefillFromCharter(probe.charter), version)`, then redirect `/setup/step/1`.
    - Probe reports an unreadable charter → `replaceDraft({}, activeVersion)`, then render step 1 with the notice `התקנון הקיים אינו קריא — יש למלא את הראיון מחדש. החתימה תחליף אותו.`
    - No active charter → redirect `/setup`.
  - Step 4 pre-fills `timezone: 'Asia/Jerusalem'` and workweek Sun–Thu when the section is unsaved.
  - Gate in `route()`, right after the `mustChangePassword` line: `if (!pathname.startsWith('/setup') && (await activeCharterVersion(businessId)) === null) return redirect(res, '/setup');`
  - `route()` options gain `ruleProposer?: RuleProposer` (tests inject; production leaves it unset).

The views follow the approved sketch: a step list on the side, the step's content in the main area, and a destination tag per step (`אזכור את זה כהנחיה` / `ייכנס לכללים שתחתום עליהם`). Step 6 is a table with radios per row: `alone` is disabled with `NEVER_ALONE_NOTE` for rows not in `ALONE_ALLOWED`; `ROW_EXAMPLES` and an availability label per row; `CEILING_NOTE` under it, and `REPLY_ALONE_NOTE` beside `email.reply`. Step 2 shows `ONLY_YOU_APPROVE_NOTE`. Step 5 shows `WHATSAPP_NOTE` and `DOCUMENTS_NOTE`, and shows the provider read-only when the previous charter has a mailbox. Every typed value is rendered through `escLabel`.

- [ ] **Step 1: Write failing tests** (pattern: `server.test.ts`; no live planner or proposer):
  - `redirects every page to /setup while there is no charter`: `GET /` → 303 `/setup`.
  - `does not redirect once a charter is active`.
  - `resumes at the first unanswered step`: sections 1–3 saved → `GET /setup` → `/setup/step/4`.
  - `re-renders step 8 with the domain error`: post `*.rival.co.il` → 400, the body contains the `emailDomainProblem` message, nothing saved.
  - `step 6 cannot post alone for quote.issue`: 400.
  - `escapes typed names on the summary`: `tradeName` `<b>‮x` → no `<b>`, no U+202E in the body.
  - `sign end-to-end`: complete the draft via POSTs, then GET summary, read `shownHash`, POST sign → 303 `/`, and `activeCharterVersion` is non-null.
  - `rejects a POST without CSRF`: 403.
  - `rule proposal goes through the injected proposer and is accepted by index`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run** `setup-routes.test.ts server.test.ts mailbox-connect.test.ts`. Expect PASS. Existing server tests install a charter first; any that don't now see a redirect. Fix them by installing `buildCharter()` in their setup, not by weakening the gate.
- [ ] **Step 5: Commit** `feat(interview): dashboard setup screens and the no-charter gate`

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/10-user-settings.md`, `docs/11-pre-launch-checks.md`, `docs/04-charter.md`

- [ ] **Step 1: Update `CLAUDE.md`:**
  - A paragraph under "כללים שהקוד אוכף בשקט": the interview is the only production author of a first charter; `buildCharterFromInterview` is the single source; summary = charter; the no-charter gate uses `activeCharterVersion`, not `probeActiveCharter`; nothing writes memory.
  - The erasure table count goes from 22 to 23 everywhere it appears.
  - Under "בעיות ידועות": **names typed into the charter (do-not-contact labels, principal name) live in `charter_versions` and are not erased by contact erasure**, because a signed document cannot be edited. This existed before but is now reachable from a real screen.
- [ ] **Step 2: Update `docs/10-user-settings.md`** with a section "ראיון ההקמה" (what it sets, what only re-signing changes, what it cannot do); add a pre-launch line for a full interview run on a fresh business.
- [ ] **Step 3: Commit** `docs: charter interview`
