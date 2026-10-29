# Boss Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner instruction whose plan has a classified step is held, echoed back as ONE Hebrew confirmation question (with contact choices folded in), and on a typed "כן"/choice it executes under any autonomy dial, exactly once, then reports "בוצע לפי אישורך".

**Architecture:** `runInstruction` parks such jobs in phase `plan` with an `instruction_confirmations` row instead of moving to `execute`. A confirm reader (WhatsApp first in the door; a dashboard POST) flips the row to `confirmed`, binds the chosen plan and moves to `execute`. The gate gets a narrow, positively-written exemption, `confirmedCommandCovers`, that skips stages 5–9 and `needsApproval` for the confirmed bytes, and claims each step atomically before `allow`.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` imports), Postgres (real DB in tests), vitest, zod.

**Spec:** [docs/superpowers/specs/2026-10-28-boss-command-design.md](../specs/2026-10-28-boss-command-design.md). **§10 overrides every earlier section** — read it first.

## Global Constraints

- Confirmation is required iff the bound plan has ≥ 1 step whose tool is classified (`classifyAction(tool) !== null`). Read-only plans run as today (§10.4).
- Park phase is `plan` (never `await_approval`). Legal moves used: `plan→execute`, `plan→closed`, `plan→failed` (§10.1).
- Confirm words, whole message only, after `stripBidiControls` + `trim`: `כן`, `אשר`, `אשרי`, `מאשר`, `מאשרת`, `בצע`, `בצעי`, `תבצעי`. Cancel words: `לא` + existing `CLOSURE_VERBS`. Disjoint from `FORGET_VERBS` and from mail-card `שלח`/`שלחי` (§4.3, §10.11).
- Confirmation is typed only (`mediaKind === null`); provider timestamp strictly after presentation; window `config.whatsappQuestionWindowMinutes` (30) from `presented_at`.
- Exemption validity: `decided_at > now() - interval '24 hours'` (§10.7).
- Up to 3 candidates are planned on identity ambiguity; > 3 keeps today's identity question (§4.2). One instruction counts once against the daily cap.
- Echo shows every input field of every classified step, no truncation; > 4,000 rendered chars per step → refuse with a Hebrew reason (§10.5).
- Exemption keeps: kill switch (stage 1), stale charter (2), capability/`UNOWNED_TOOLS` (3), `amount_unreadable`. Skips: stages 5 (forbidden), 6 (doNotContact), 7 (quiet hours), 8 (all autonomy ceilings), 9 (budget), `needsApproval`. Audit marker `confirmed_command_exemption` on `intent_to_act` (§4.5, §10.12).
- Owner-facing text Hebrew via `src/domain/labels.ts`; untrusted text through `stripBidiControls`; every query scoped by `business_id`; controls positive; next migration `048`.
- Implementers never run `npm test` or anything in the background; focused files with `--no-file-parallelism` only. The controller runs the full suite.

## Review Focus

1. **Two "כן" in a row, or WhatsApp + dashboard at once** → confirmed once, executed once. Pin in Task 4 (`a second confirm is a no-op`).
2. **Crash after send, before completion recorded** → the re-run is refused by the claim and the owner is re-asked, never a silent second send. Pin in Task 6 (`a claimed step never runs twice`).
3. **"כן" sent before the question was shown / older than the window** → not a confirmation. Pin in Task 4.
4. **Contact address learned from a document** → shown as "לא אומת" in the option. Pin in Task 2.
5. **Dial `off`** → a confirmed command still executes. Pin in Task 6 (`executes under dial off`).

---

### Task 1: Confirmation storage + erasure wiring

**Files:**
- Create: `src/db/migrations/048_instruction_confirmations.sql`
- Create: `src/governance/instruction-confirmations.ts` (+ `.test.ts`)
- Modify: `src/governance/erasure-plan.ts`, `src/governance/erasure.ts`, `src/governance/erasure-invariants.test.ts`, `src/dashboard/views.ts` (`TABLE_LABELS`), `src/test/db.ts` (TRUNCATE)

**Interfaces — Produces:**
```ts
export interface ConfirmationOption { label: string; planHash: string; plan: Plan; contactSource: 'boss' | 'unverified' | null }
export type ConfirmationState = 'pending' | 'confirmed' | 'cancelled' | 'expired';
export interface InstructionConfirmation {
  jobId: string; options: ConfirmationOption[]; presentedText: string; presentedAt: Date;
  channel: 'whatsapp' | 'dashboard'; state: ConfirmationState;
  chosenPlanHash: string | null; decidedAt: Date | null; decidedBy: string | null; reaskOf: string | null;
}
export async function createConfirmation(i: { jobId: string; options: ConfirmationOption[]; presentedText: string; channel: 'whatsapp'|'dashboard'; reaskOf?: string }, o: { businessId: string; db?: Queryable }): Promise<void>;
export async function loadConfirmation(jobId: string, o: { businessId: string; db?: Queryable }): Promise<InstructionConfirmation | null>;
/** UPDATE ... WHERE state='pending' — true only for the call that flipped it. */
export async function confirmChoice(jobId: string, planHash: string, decidedBy: string, o: { businessId: string; db?: Queryable }): Promise<boolean>;
export async function cancelConfirmation(jobId: string, decidedBy: string, o: {...}): Promise<boolean>;
export async function expireConfirmations(o: { businessId: string; now?: Date; db?: Queryable }): Promise<string[]>; // job ids
/** INSERT ... ON CONFLICT DO NOTHING RETURNING — true only for the first claimant. */
export async function claimConfirmedStep(i: { jobId: string; stepId: string; planHash: string }, o: {...}): Promise<boolean>;
```
Tables: `instruction_confirmations(business_id, job_id UNIQUE, options JSONB, presented_text TEXT, presented_at, channel CHECK, state CHECK, chosen_plan_hash NULL, decided_at NULL, decided_by NULL, reask_of NULL, created_at)` with a CHECK that `chosen_plan_hash` is set iff `state='confirmed'`; `confirmed_step_claims(business_id, job_id, step_id, plan_hash, claimed_at, UNIQUE(business_id, job_id, step_id))`.

- [ ] **Step 1: Failing tests:** create → load round-trip; `confirmChoice` twice → `true` then `false`; `confirmChoice` with a hash not among options → `false`; cancel after confirm → `false`; `expireConfirmations` expires only `pending` rows whose `presented_at` is older than the window and returns their job ids; `claimConfirmedStep` twice → `true` then `false`; every function scoped by business (a same-job-id row in another business is untouched). Erasure: a contact anchor finds a job whose name appears only in `presented_text`, and one whose name appears only JSON-escaped in `options` (`jsonbContentMatches`); both tables deleted by `job_id`; invariant test seeds the probe into `instruction_confirmations.presented_text` and `options`.
- [ ] **Step 2: Run** the test files — FAIL.
- [ ] **Step 3: Implement** (house `XRow` + `toX` style; `confirmChoice` checks `planHash` against `options` in SQL: `options @> jsonb_build_array(jsonb_build_object('planHash', $3))`).
- [ ] **Step 4: Run** `npm run migrate:test` then the files — PASS. Prove by mutation: drop the `state='pending'` guard; drop the business scope in `confirmChoice`; drop the discovery arm.
- [ ] **Step 5: Commit** `feat(command): instruction confirmations + step claims, wired to erasure`.

---

### Task 2: The Hebrew echo

**Files:** Create `src/orchestrator/command-echo.ts` (+ `.test.ts`)

**Interfaces — Produces:**
```ts
export const MAX_ECHO_CHARS_PER_STEP = 4000;
export const CONFIRM_HINT = 'השיבי "כן" לאישור, או "לא" לביטול.';
export const CHOICE_HINT = 'השיבי במספר או בשם — וזה גם האישור. "לא" לביטול.';
export const REASK_PREFIX = 'ייתכן שזה כבר בוצע — לבצע שוב?';
export function renderStepEcho(step: PlanStep): string;
export function renderConfirmationQuestion(options: ConfirmationOption[], opts?: { reask?: boolean }): { text: string } | { refused: string };
```
- [ ] **Step 1: Failing tests:** a `mail.send` step renders the class label from `labels.ts` (not the raw id), "אל: …", "נושא: …", the FULL body (a 3,000-char body appears whole), "בתשובה ל: …" when present; `amountMinor: 300000` renders via `formatMinor`; an unknown field renders as `שדה נוסף: <key> = <value>`; arrays render every element; bidi controls are stripped from values; a step > 4,000 rendered chars → `{ refused }` in Hebrew; read-only steps are not rendered; one option → text ends with `CONFIRM_HINT`; two options → numbered `1.`/`2.` and ends with `CHOICE_HINT`; option with `contactSource: 'unverified'` carries "נלמד ממסמך/מייל — לא אומת", `'boss'` carries "נאמר על ידך"; `reask: true` → text starts with `REASK_PREFIX`.
- [ ] **Step 2–4:** RED, implement (pure, no DB), GREEN. Mutation: drop bidi strip; truncate body; drop the unverified label.
- [ ] **Step 5: Commit** `feat(command): render the confirmation question from the plan`.

---

### Task 3: `runInstruction` holds and asks

**Files:** Modify `src/orchestrator/instruct.ts`, `src/sdk/planner.ts` (`PlanRequest.resolvedContact?: string`, rendered in the final, uncached section only), `src/orchestrator/instruct.test.ts`, `src/orchestrator/instruction-invariants.test.ts`

**Interfaces:**
- Consumes: Task 1 `createConfirmation`; Task 2 `renderConfirmationQuestion`.
- Produces: new outcome `{ status: 'needs_confirmation'; jobId: string; question: string; optionCount: number }` on `InstructionOutcome`. `RunInstructionOptions` gains `channel: 'whatsapp' | 'dashboard'` (required, no default).

- [ ] **Step 1: Failing tests:**
  - a plan with a classified step → `needs_confirmation`; job in phase `plan`; one `pending` confirmation with one option whose `planHash === planHashOf(plan)`; plan **already bound** (single option); no `approval_requests` row; job never reached `execute`.
  - a read-only plan → `planned` as today, no confirmation row.
  - identity ambiguity with 2 candidates → planner called twice, each request carries `resolvedContact` with the candidate's name + address and **`instruction` byte-identical to the stored text** (never appended); 2 options; nothing bound yet.
  - one candidate's plan fails `planProblems` → dropped, the other becomes a single-option question; all fail → today's refusal.
  - > 3 candidates → today's identity question (`needs_answer`).
  - the catalogue passed to the planner is rendered with `rampLevel: 'auto'` on this path.
  - contact from a non-`boss` memory row → its option has `contactSource: 'unverified'`.
  - one instruction counts once against `INSTRUCTIONS_PER_DAY`.
- [ ] **Step 2–4:** RED; implement (the per-candidate loop reuses the same validation chain; on a single option bind then park; on multiple park without binding); GREEN. Mutation: append identity to `instruction` (invariant test must catch it); drop the classified-step condition; bind before choice in the multi case.
- [ ] **Step 5: Commit** `feat(command): instructions with side effects wait for one confirmation`.

---

### Task 4: The confirm reader

**Files:** Create `src/orchestrator/command-confirm.ts` (+ `.test.ts`); modify `src/orchestrator/scheduler.ts` (expiry in the pass: expired → `plan→closed`, reason `command: confirmation expired`)

**Interfaces — Produces:**
```ts
export const CONFIRM_WORDS: readonly string[];
export const CANCEL_WORDS: readonly string[]; // ['לא', ...CLOSURE_VERBS words]
export type ConfirmReading = { kind: 'confirm'; planHash: string } | { kind: 'cancel' } | { kind: 'unclear' } | { kind: 'none' };
export function readConfirmation(text: string, options: ConfirmationOption[]): ConfirmReading; // number, full label, or a token matching exactly one option's contact name
export async function openConfirmations(o: { businessId: string; channel: 'whatsapp'; inboundAt: Date | null; db?: Queryable }): Promise<InstructionConfirmation[]>;
export async function applyConfirmation(jobId: string, reading: ConfirmReading, by: string, o: { businessId: string }): Promise<'executing' | 'cancelled' | 'already_decided' | 'unclear'>;
```
`applyConfirmation`: `confirmChoice` → (multi) `bindPlanToJob(chosen plan)` asserting the bound hash equals the chosen → `plan→execute`. Cancel → `plan→closed`.

- [ ] **Step 1: Failing tests:** the word lists are disjoint from `FORGET_VERBS` and `שלח`/`שלחי` (intersect the exported lists); "כן" → confirm the only option; "2" / "דנה חיוט" / "חיוט" → that option; "דנה" matching two → `unclear`; "כן" with two options → `unclear`; "לא" → cancel; `a second confirm is a no-op` (`already_decided`, one transition); `openConfirmations` excludes rows presented after `inboundAt`, `inboundAt === null`, rows outside the window, other businesses, non-pending; expiry closes the job.
- [ ] **Step 2–4:** RED, implement, GREEN. Mutation: drop the strict-after check; drop `state='pending'`; let "כן" pick the first of two.
- [ ] **Step 5: Commit** `feat(command): read the owner's confirmation`.

---

### Task 5: Wire WhatsApp and the dashboard

**Files:** Modify `src/orchestrator/whatsapp-door.ts` (confirm reader FIRST, before the mail card and routing; typed only), `src/orchestrator/whatsapp-door.test.ts`, `src/dashboard/server.ts` (`renderInstructionOutcome` for `needs_confirmation`; `POST /instruct/:jobId/confirm` with CSRF, session, must-change-password gate; body `planHash`), `src/dashboard/views.ts`, `src/dashboard/server.test.ts`

- [ ] **Step 1: Failing tests:** WhatsApp: an instruction → the question is sent as the ack (instead of `PLANNED_ACK`); a typed "כן" after it → job `execute`; a voice "כן" → not a confirmation (goes to the door as a new instruction; the confirmation stays pending); with a confirmation AND an open mail card (or an open clarifying question) → "כן"/"לא"/closure word → refusal text "יש כמה שאלות פתוחות — עני בדשבורד", nothing changes; "שלח" with only a confirmation open → not consumed by the confirm reader. Dashboard: `/instruct` renders the question with one button per option (each POSTs its `planHash`); POST without CSRF → 403; a `planHash` not among options → 400, nothing changes; valid → redirect, job `execute`; second POST → no second transition.
- [ ] **Step 2–4:** RED, implement, GREEN. Mutation: move the reader after the mail card; drop the typed-only check; drop CSRF.
- [ ] **Step 5: Commit** `feat(command): confirm on WhatsApp and the dashboard`.

---

### Task 6: The gate exemption

**Files:** Create `src/policy/confirmed-command.ts` (+ `.test.ts`); modify `src/policy/engine.ts`; `src/orchestrator/run-plan.ts`/`execute.ts` only if the gate needs `stepId` in context (pass it as `ctx.stepId`)

**Interfaces — Produces:**
```ts
export const CONFIRMED_COMMAND_EXEMPTION_MARKER = 'confirmed_command_exemption';
export async function confirmedCommandCovers(facts: ActionFacts, ctx: GateContext): Promise<{ stepId: string; planHash: string } | null>;
```
Positive conditions (all, in SQL where possible): `ctx.jobId` and `ctx.stepId` set; job same business, `provenance='boss'`; a `boss_instructions` row for the job; confirmation `state='confirmed'`, `decided_at > now() - interval '24 hours'`; `chosen_plan_hash = job_plans.plan_hash`; the step with `ctx.stepId` exists in that plan, same `toolName`, and `canonicalHash(step.input) === facts.inputHash`; no `job_step_results` row with status `unknown` for the job.
Gate: compute right after stage 3 (before stage 5); when non-null → skip stages 5–9 and `needsApproval`; keep `amount_unreadable`; record `intent_to_act` with reason ending in the marker; then `claimConfirmedStep`; claim lost → deny `confirmed_step_already_claimed`; else `allow` with `redactedInput` computed exactly as the normal allow does.

- [ ] **Step 1: Failing tests** — one pair per condition (same payload, condition flipped), each negative proven to fall to the normal path (assert the normal-path deny/queue code, not just "not allowed"); `executes under dial off`; skips a `forbidden` charter rule, a `doNotContact` recipient, quiet hours and a budget ceiling (one test each, each also asserting the same call is refused without the confirmation); kill switch still denies; `amount_unreadable` still denies; `a claimed step never runs twice` (second evaluation → `confirmed_step_already_claimed`, no allow); confirmation older than 24h → normal path; marker present on the intent row.
- [ ] **Step 2–4:** RED, implement, GREEN. Mutation: each condition removed (each must turn a test red); claim removed; marker removed.
- [ ] **Step 5: Commit** `feat(policy): a confirmed boss command runs under any dial, once`.

---

### Task 7: Re-ask and the report

**Files:** Create `src/orchestrator/command-reask.ts` (+ `.test.ts`); modify `src/orchestrator/scheduler.ts`, `src/orchestrator/whatsapp-report.ts` (+ test)

**Interfaces — Produces:** `reaskFailedCommands(o: { businessId: string; notify?: ... }): Promise<{ reasked: number }>` — for a `failed`/`followup` command job (confirmation `confirmed`) whose step has an `unknown` row, a claim without a `completed` row, a `confirmed_step_already_claimed` denial, or a confirmation older than 24h with steps still to run: once per job, a NEW job with the same plan bound, phase `plan`, a new confirmation with `reask_of = old job`, question with `REASK_PREFIX` when a claim/unknown exists (plain question when only expired); old job → `failed` (if not already). WhatsApp: the question is sent through the boss messenger. Report: new outcome `performed_on_confirmation` with text "בוצע לפי אישורך." for command jobs closed with every step `completed` + `performed`.

- [ ] **Step 1: Failing tests:** timeout after confirm → exactly one new job + question with `REASK_PREFIX`, no second send; running twice → still one; a completed command job → not re-asked; expired-only → plain question; report text for a performed command job.
- [ ] **Step 2–4:** RED, implement, GREEN. Mutation: drop the once-per-job guard; drop the `REASK_PREFIX` condition.
- [ ] **Step 5: Commit** `feat(command): re-ask after an uncertain send; report on confirmation`.

---

### Task 8: Documentation

**Files:** `CLAUDE.md` (new paragraphs: the confirmation flow, the exemption and exactly what it keeps/skips, the claim, re-ask, 24h, `plan` parking, the word lists' disjointness, kill-switch release deferred; known issues; test-count line from the controller), `docs/08-risks.md` (owner ruling: a confirmed command overrides forbidden/doNotContact/quiet hours/budget; a hijacked WhatsApp number can confirm), `docs/10-user-settings.md`, `docs/09-roadmap.md`.

- [ ] **Step 1:** Edit; verify every claim against the file it cites.
- [ ] **Step 2: Commit** `docs: boss command`.
