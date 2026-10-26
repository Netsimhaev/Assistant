# Shadow Mode & Learning Level — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "10 clean approvals in a row" promotion rule under the `learn` dial with a per-class agreement rate (owner edits ≤ 3 words, no number/date/recipient change), show it on a learning-level screen, notify the owner on every autonomous action through channels he picks, and let a learned `email.reply` answer inbound mail without a card.

**Architecture:** A pure verdict function (`agreementVerdict`) feeds one derived metric (`agreementFor`) that both the promotion pass and the screen read — never a stored counter. A new scheduler stage dispatches one update per autonomous step into a new `action_updates` table. A narrow, positively-written gate exemption (`learnedReplyCovers`) drops only the provenance ceiling for a learned inbound-mail reply to its own sender.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` imports), Postgres (real DB in tests), vitest, zod.

**Spec:** [docs/superpowers/specs/2026-10-26-shadow-mode-design.md](../specs/2026-10-26-shadow-mode-design.md) — H1–H12 and §8 Q4 are owner rulings; read it before any task.

## Global Constraints

- Every number on the screen and in promotion is derived per call from `approval_requests` / `job_step_results`; no counter column. `autonomy_ramp.samples`/`approved_without_edit` stay empty.
- "Learned" = `counted >= 5` AND `right / counted > 0.8` (strict). Window = last **14 days**, and not before the class's last `autonomy_events` row.
- Verdict states: `approved` → right; `approved_with_edit` → compared; `denied` → wrong; `expired`, `cancelled` → not counted (H11).
- Evidence cards: only cards on a **mailbox reply job** (`mail_messages.reply_job_id`), first decided card per job, header without `RETRY_PREFIX`/`EXPIRED_PREFIX`. Conductor cards and instruction jobs are therefore never evidence (positive rule — a new origin is added by name). A re-raise relinks `mail_messages.reply_job_id` to the new job (`linkReplyJob` overwrites), so a re-raised mail drops out of measurement entirely — accepted: undercounting, never double-counting.
- Updates go to every autonomous **performed** step, internal and outbound, except jobs that have a `boss_instructions` row (H12). Never batched (H3).
- Channel settings: `to_whatsapp`, `to_email`, `to_screen`; at least one true, enforced by DB `CHECK` and by a Hebrew form error. Default when no row: email + screen.
- Owner-facing text in Hebrew; class/level names only through `src/domain/labels.ts`. Identifiers, comments and internal errors in English.
- `src/policy/engine.ts` changes in Task 7 only; that task ends with `/security-review`.
- Run `npm run typecheck` and the task's tests before each commit; full `npm test` at Tasks 3, 5, 7 and 8. Use the next free migration number (`047`, `048`).

## Review Focus

1. **Number formatting vs number change** — "5,000" → "5000" is not a changed amount; "500" → "5,000" is. Pin in Task 1 (`normalises thousands separators before comparing numbers`).
2. **Bidi/punctuation noise** — an edit that only adds a comma or a U+200F must count 0 words. Pin in Task 1 (`ignores punctuation and bidi controls`).
3. **Dial turned to `off` after a class was promoted** — no learned reply may go out (the clamp makes ramp `draft_only`). Pin in Task 7 (`no learned reply when the dial is off`).
4. **Owner picked only WhatsApp and it is not connected** — the update row is written with `whatsapp_state = 'skipped_not_connected'`, never silently dropped. Pin in Task 5.
5. **Exactly-80% sample** — 4/5 and 8/10 do not promote; 5/6 does. Pin in Task 3.

---

### Task 1: `agreementVerdict` — the pure comparison

**Files:**
- Create: `src/governance/agreement-verdict.ts`
- Test: `src/governance/agreement-verdict.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AgreementVerdict = 'right' | 'wrong' | 'not_counted';
  export type WrongReason = 'recipient' | 'number' | 'date' | 'too_many_words' | 'denied';
  export const MAX_EDITED_WORDS = 3;
  export function agreementVerdict(input: {
    state: string;                         // approval_requests.state
    proposed: Record<string, unknown>;     // proposed_input
    edited: Record<string, unknown> | null; // edited_input
  }): { verdict: AgreementVerdict; reason: WrongReason | null };
  ```

- [ ] **Step 1: Write the failing tests** — one `it` per rule, asserting `{verdict, reason}`:
  - `approved` → `{right, null}`; `denied` → `{wrong, 'denied'}`; `expired`/`cancelled`/unknown state → `{not_counted, null}` (unknown is never permissive and never counted).
  - `approved_with_edit`, body differs by 3 words → right; by 4 → `{wrong,'too_many_words'}`. Words counted over `subject` + `body` together.
  - `to` changed (any change, case-insensitive compare of the `readEmails` set) → `{wrong,'recipient'}` even with zero body change.
  - `"עלות 500 ש\"ח"` → `"עלות 5,000 ש\"ח"` → `{wrong,'number'}`; `"5,000"` → `"5000"` → right (`normalises thousands separators before comparing numbers`).
  - `"ביום ג' ב-10:00"` → `"ביום ג' ב-14:00"` → number; `"נדבר מחר"` → `"נדבר מחרתיים"` → `{wrong,'date'}`; `"ביום שלישי"` → `"ביום חמישי"` → date.
  - `ignores punctuation and bidi controls`: adding `,`, `!`, U+200F → right with 0 words.
  - `approved_with_edit` with `edited === null` → treated as `approved` (right).
- [ ] **Step 2: Run** `npx vitest run src/governance/agreement-verdict.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Order of checks: state → recipient → numbers → dates → word distance. Tokenise with `stripBidiControls` (`src/util/bidi.ts`), split on whitespace, trim leading/trailing punctuation per token, drop empties. Numbers = multiset of digit runs after removing `,` between digits. Date words = fixed set: `ראשון שני שלישי רביעי חמישי שישי שבת היום מחר מחרתיים אתמול` + Hebrew month names + `יום א'`…`יום ו'` letter forms; compare the multiset of tokens in that set (after `LEADING_HEBREW_PARTICLE` strip from `governance/typed-recipients.ts`). Word distance = Levenshtein over token arrays.
- [ ] **Step 4: Run** the test file — Expected: PASS.
- [ ] **Step 5: Commit** `feat(agreement): pure verdict for owner edits (≤3 words, number/date/recipient)`.

---

### Task 2: `agreementFor` — the derived metric

**Files:**
- Modify: `src/governance/agreement.ts` (replace `approvalStreak`/`STREAK_REQUIRED`)
- Modify: `src/policy/engine.test.ts:288-323` (the one test that imports `approvalStreak` — rewrite its assertion onto `agreementFor`)
- Test: `src/governance/agreement.test.ts` (rewrite)

**Interfaces:**
- Consumes: `agreementVerdict` (Task 1).
- Produces:
  ```ts
  export const AGREEMENT_WINDOW_DAYS = 14;
  export const MIN_SAMPLES = 5;
  export const LEARNED_THRESHOLD = 0.8; // strictly greater
  export interface Agreement { right: number; counted: number; topWrongReason: WrongReason | null }
  export async function agreementFor(actionClass: ActionClass, options: {
    businessId: string; since: Date | null; now?: Date; db?: Queryable;
  }): Promise<Agreement>;
  export function isLearned(a: Agreement): boolean; // counted >= MIN_SAMPLES && right / counted > LEARNED_THRESHOLD
  ```

- [ ] **Step 1: Write failing tests** (real DB, `resetDatabase()`): seed mail reply jobs (a `mail_messages` row with `reply_job_id`) and cards:
  - 5 approved → `{right:5, counted:5}`, `isLearned` true; 4 approved + 1 denied → false.
  - a card on a job with **no** `mail_messages` link (instruction job, conductor job) is not counted.
  - two decided cards on the same job → only the earlier (`created_at`) counts.
  - a card whose `detail` header contains `RETRY_PREFIX` or `EXPIRED_PREFIX` (use `composeReplyDetail` from `src/mail/reply-card.ts`) is not counted.
  - `expired`/`cancelled` not counted; a card decided 15 days ago not counted; a card decided before `since` not counted.
  - `topWrongReason` is the most frequent reason among wrong verdicts (tie → first in `WrongReason` order).
- [ ] **Step 2: Run** `npx vitest run src/governance/agreement.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** One SQL `SELECT DISTINCT ON (a.job_id) … ORDER BY a.job_id, a.created_at` over `approval_requests a JOIN mail_messages m ON m.business_id = a.business_id AND m.reply_job_id = a.job_id`, `a.state IN ('approved','approved_with_edit','denied')`, `a.decided_at > greatest(now() - 14 days, $since)`; filter re-raise headers with `splitReplyDetail`; fold through `agreementVerdict`. Keep the module docblock's "derived, never accumulated" paragraph and add why the evidence origin is positive (spec §5.1, "אילו כרטיסים הם ראיה").
- [ ] **Step 4: Run** test file + `src/policy/engine.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(agreement): windowed agreement rate replaces the 10-streak`.

---

### Task 3: Promotion pass uses the new rule

**Files:**
- Modify: `src/orchestrator/promote.ts:273-379` (and delete `cleanApprovalsSince`, `:112-140`)
- Test: `src/orchestrator/promote.test.ts`

**Interfaces:**
- Consumes: `agreementFor`, `isLearned` (Task 2). `lastEventAt` stays and is passed as `since`.
- Produces: unchanged `evaluateAutonomy` signature; promotion reason string `"${right} מתוך ${counted} הכרעות אחרונות (${pct}%)"` with `pct = Math.round(100*right/counted)`.

- [ ] **Step 1: Update/add failing tests:** 5/5 promotes; 4/5 and 8/10 do not (`exactly 80% does not promote`); 5/6 promotes; after a demotion the cards decided before the demotion do not re-promote (existing test — keep it, now against the new rule); `ask` and `off` never promote; the reason text on the `autonomy_events` row matches the string above.
- [ ] **Step 2: Run** `npx vitest run src/orchestrator/promote.test.ts` — Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** — replace the two streak checks with `isLearned(await agreementFor(actionClass, { businessId, since, db }))`; update the comments that cite "ten" (§5.1.4 block stays true — rewrite its first line to name the new rule). Demotion branch untouched.
- [ ] **Step 4: Run** `npm run typecheck && npm test` — Expected: all pass (grep for any remaining `STREAK_REQUIRED`/`approvalStreak` reference, including `whatsapp-routing.ts:19` and `governance/approvals.ts:340` comments, and update the wording).
- [ ] **Step 5: Commit** `feat(promote): promote on >80% of ≥5 owner verdicts`.

---

### Task 4: Update storage, channel settings, erasure wiring

**Files:**
- Create: `src/db/migrations/047_action_updates.sql`
- Create: `src/governance/action-update-settings.ts` (+ `.test.ts`)
- Modify: `src/dashboard/autonomous-actions.ts` (filter + field)
- Modify: `src/governance/erasure-plan.ts`, `src/governance/erasure.ts`, `src/governance/erasure-invariants.test.ts`
- Test: `src/dashboard/autonomous-actions.test.ts`

**Interfaces:**
- Produces:
  - Table `action_update_settings(business_id PK, to_whatsapp bool, to_email bool, to_screen bool, updated_at, updated_by, CHECK (to_whatsapp OR to_email OR to_screen))`.
  - Table `action_updates(update_id PK, business_id, job_id, step_id, action_class, recipient TEXT NULL, subject TEXT NULL, body TEXT NOT NULL, email_state TEXT NULL, whatsapp_state TEXT NULL, seen_at timestamptz NULL, created_at, UNIQUE(business_id, job_id, step_id))`; state values `sent|failed|skipped_not_connected` (CHECK), `NULL` = channel not chosen.
  - ```ts
    export interface ActionUpdateSettings { toWhatsApp: boolean; toEmail: boolean; toScreen: boolean }
    export const ACTION_UPDATE_DEFAULTS: Readonly<ActionUpdateSettings>; // { false, true, true }
    export async function loadActionUpdateSettings(o: { businessId: string; db?: Queryable }): Promise<ActionUpdateSettings>;
    export async function saveActionUpdateSettings(s: ActionUpdateSettings, o: { businessId: string; updatedBy: string; db?: Queryable }): Promise<void>; // throws Error('חובה לבחור לפחות דרך עדכון אחת') when all false
    ```
  - `AutonomousAction` gains `fromInstruction: boolean`; `listAutonomousActions` adds `AND r.performed = true`.

- [ ] **Step 1: Failing tests:** settings default when no row; all-false save throws the Hebrew message and the DB CHECK also rejects a raw insert; `listAutonomousActions` omits a `performed = false` step and sets `fromInstruction` true for a job with a `boss_instructions` row; erasure-invariants seeds the probe into `action_updates.recipient`/`subject`/`body` and expects zero survivors.
- [ ] **Step 2: Run** the three test files — Expected: FAIL.
- [ ] **Step 3: Implement** migration, module (`interface SettingsRow` + `toSettings`, same shape as `governance/digest-settings.ts`), the query change, and erasure: `action_updates` deleted by `job_id` in both `countItems` and the executor, using the existing job-anchored pattern.
- [ ] **Step 4: Run** `npm run migrate:test` then the tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(updates): action_updates + owner channel settings (≥1 required)`.

---

### Task 5: Dispatch one update per autonomous action

**Files:**
- Create: `src/orchestrator/action-updates.ts` (+ `.test.ts`)
- Modify: `src/governance/notify.ts:136` (export `withDeadline`)
- Modify: `src/orchestrator/scheduler.ts` (call after `evaluateAutonomy`, add `actionUpdates` to the pass result)

**Interfaces:**
- Consumes: `listAutonomousActions` (+`fromInstruction`), `loadActionUpdateSettings` (Task 4), `BossMessenger` (`whatsapp/messenger.ts`), `sendAlert` (`runtime.notify?.sendAlert`), `actionClassLabel` from `domain/labels.ts`.
- Produces:
  ```ts
  export interface ActionUpdatesResult { written: number; emailFailed: number; whatsappFailed: number; skippedNotConnected: number }
  export async function dispatchActionUpdates(options: {
    businessId: string; now?: Date;
    sendAlert?: (subject: string, body: string) => Promise<{ ok: boolean; error?: string }>;
    messenger?: BossMessenger; dashboardBaseUrl?: string; db?: Queryable;
  }): Promise<ActionUpdatesResult>;
  export function renderActionUpdate(a: AutonomousAction, link: string | null): string;
  ```

- [ ] **Step 1: Failing tests:**
  - an autonomous step with no `action_updates` row → one row written, email sent once; a second pass writes nothing (UNIQUE + `ON CONFLICT DO NOTHING`, sends only for newly inserted rows).
  - ten steps → ten rows, ten sends (H3, never batched).
  - an instruction job's step → no row.
  - settings `{whatsapp only}`, no messenger → row with `whatsapp_state='skipped_not_connected'`, `email_state NULL`.
  - `sendAlert` returns `{ok:false}` / throws / hangs past the deadline → `email_state='failed'`, pass does not throw.
  - `backfills nothing older than a day`: a step whose `completed_at` is more than 24 hours before `now` gets no row — the first pass after deploy must not flood the owner with history.
  - `renderActionUpdate`: Hebrew, contains the label (not the raw class id), recipient, subject after `stripBidiControls`, and the link to `/autonomy/actions`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Insert first, then send, then update states — the row is the record whether or not delivery works (spec §5.4). Wrap each send in `withDeadline`. Wire into `schedulerPass` as the last stage, isolated in try/catch with an `actionUpdatesError` field like `autonomyError`.
- [ ] **Step 4: Run** `npm run typecheck && npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(updates): notify the owner on every autonomous action`.

---

### Task 6: Learning-level screen and channel form

**Files:**
- Create: `src/dashboard/learning-view.ts` (+ `.test.ts`)
- Modify: `src/dashboard/views.ts:415` (`renderAutonomy` takes the snapshot + settings), `src/dashboard/server.ts:2372` (`handleAutonomyGet`), add `POST /autonomy/updates`
- Modify: `docs/10-user-settings.md`

**Interfaces:**
- Consumes: `agreementFor`, `isLearned`, `MIN_SAMPLES` (Task 2); `loadRampLevel`; bundle `autonomyBase`, `NEVER_FULLY_AUTONOMOUS`; settings (Task 4).
- Produces:
  ```ts
  export type ClassStatus = 'shadow' | 'acting_alone' | 'charter_requires_approval' | 'always_approval' | 'ready_but_dial_not_learn' | 'stopped_after_demotions';
  export interface ClassCard { actionClass: ActionClass; agreement: Agreement; status: ClassStatus; since: Date | null }
  export interface LearningSnapshot { overall: { right: number; counted: number } | null; cards: ClassCard[] }
  export async function learningSnapshot(o: { businessId: string; db?: Queryable }): Promise<LearningSnapshot>;
  export function renderLearning(s: LearningSnapshot): string;
  ```

- [ ] **Step 1: Failing tests:** overall = Σright/Σcounted over eligible cards only (`always_approval` and `charter_requires_approval` excluded); `null` overall renders "עוד אין מספיק נתונים" (not "0%"); `counted < 5` renders "עוד מוקדם לדעת (n מתוך 5)" without a percentage; `acting_alone` is derived from the **clamped** ramp level, so a promoted class under dial `off` is not shown acting alone; a class learned under `ask` shows `ready_but_dial_not_learn`; `stopped_after_demotions` at two demotions; labels come from `labels.ts` (no raw `email.reply` in HTML); with `to_screen` on, `/autonomy/actions` marks rows whose `action_updates.seen_at` is null as "חדש" and the GET sets `seen_at`; POST with all three unchecked re-renders with "חובה לבחור לפחות דרך עדכון אחת" and does not save; CSRF required (same pattern as `/autonomy/mode`).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** following the layout the owner chose (`.superpowers/brainstorm/874-1793037626/content/learning-layout-v2.html`): big overall score, then cards ordered by `counted` desc, ineligible last. Escape everything with `esc`; recipient/subject with `escLabel`. Add the three checkboxes under the dial; WhatsApp checkbox carries "עוד לא מחובר — העדכון יירשם כלא נשלח" when no gateway. Document the setting in `docs/10-user-settings.md`.
- [ ] **Step 4: Run** test files + `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): learning-level screen and update-channel settings`.

---

### Task 7: Learned inbound-mail reply goes out without a card (H10)

**Files:**
- Create: `src/policy/learned-reply.ts` (+ `.test.ts`)
- Modify: `src/policy/engine.ts:277-285, 642-660` (stage 8 + `effectiveAutonomy`), the `intent_to_act` audit reason
- Modify: `src/orchestrator/mail-reply.ts:160-275` (`raiseReplyCard` fork)
- Test: `src/orchestrator/mail-reply.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const LEARNED_REPLY_EXEMPTION_MARKER = 'learned_reply_exemption';
  export async function learnedReplyCovers(facts: ActionFacts, toolInput: Record<string, unknown>, ctx: GateContext): Promise<boolean>;
  ```
  `effectiveAutonomy(facts, ctx, { skipRampAndProvenance?, skipProvenanceOnly? })` — the new option drops **only** `provenanceCeiling`.

- [ ] **Step 1: Failing tests — `learned-reply.test.ts`**, each as a pair (same payload, condition on/off) and each negative proven at **stage 8** (no `intent_to_act` row, deny code `draft_only:…`), the way `approved-reply.test.ts` does:
  - true only when: `ctx.approval === undefined`; `ctx.jobId` is a mailbox reply job; `facts.actionClass === 'email.reply'`; `ctx.rampLevel === 'auto_notify'`; `readEmails(toolInput)` is exactly one address equal (case-insensitive) to that mail's `from_address`; `facts.amountDeclared === false`; no `attachments` key in the input.
  - `no learned reply when the dial is off` (ramp clamped to `draft_only` → false).
  - the allowed send's `intent_to_act` audit reason ends with `learned_reply_exemption`.
- [ ] **Step 2: Failing tests — `mail-reply.test.ts`:** with dial `learn`, `email.reply` ramp at `auto_notify`, and a sender whose domain the charter knows → `raiseMailReply` creates **no** `approval_requests` row, the job goes to `execute`, and one `schedulerPass` sends the mail and writes an `action_updates` row; same setup with an unknown sender domain → a card is raised as today; a retry (`input.retry` set) always raises a card.
- [ ] **Step 3: Run** both files — Expected: FAIL.
- [ ] **Step 4: Implement.** In `raiseReplyCard`, after `assessRisk`: if `input.retry === undefined` AND `loadAutonomyMode === 'learn'` AND `loadRampLevel('email.reply') === 'auto_notify'` AND `risk.band === 'routine'` → transition `plan → execute` with reason `mail reply: learned, no card` and skip `enqueueApproval`/`notifyOwner`. In the gate, compute `learnedReply` next to `approvedReply`; pass `{ skipProvenanceOnly: learnedReply && !approvedReply }`. Docblock on `learnedReplyCovers` names each condition and what it does **not** bypass (charter base, overrides, envelope, ramp, kill switch, forbidden, doNotContact, quiet hours, budget, risk band) — positive, never "everything except".
- [ ] **Step 5: Run** `npm run typecheck && npm test` — Expected: PASS.
- [ ] **Step 6: Run `/security-review`** on the branch diff; fix findings before commit.
- [ ] **Step 7: Commit** `feat(policy): learned inbound-mail reply runs without a card`.

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md` (paragraphs on `approvalStreak`/"מדרגה מורווחת", "כל מספר … נגזר", `auto_notify` "חצי המדווחת מעולם לא נבנה", the autonomous-actions "אין הודעה", and add a paragraph for `learnedReplyCovers` next to the approved-reply one), `src/dashboard/autonomous-actions.ts` docblock (owner now IS notified per step — owner ruling H3), `docs/08-risks.md` (shadow mode as built; the §5.6 price), `docs/09-roadmap.md` (Shadow mode bullet), `docs/05-approvals.md` (promotion rule).

- [ ] **Step 1:** Edit each paragraph; every claim about the code checked by opening the file it cites (CLAUDE.md: "לפתוח את הקובץ לפני שמצטטים אותו").
- [ ] **Step 2:** Update the test count line in CLAUDE.md from a fresh `npm test`.
- [ ] **Step 3: Commit** `docs: shadow mode, learning level, learned replies`.
