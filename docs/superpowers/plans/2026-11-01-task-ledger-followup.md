# Task Ledger and Follow-up Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One business ledger of everything the owner told the assistant to keep track of (money, meetings, warm leads, awaiting replies, long projects). It reminds the owner on his channels, optionally acts through the existing gate, closes items on mail evidence, and never lets an item leave silently.

**Architecture:**
- **New tables** (migration 052) hold the items, their history, per-business settings, critical rules, reminder claims and the numbered WhatsApp batches.
- **Two boss-only local tools write items:** `ledger.add` and `ledger.update`. Both are read-only to the gate, and the provenance check lives in the handler.
- **The scheduler stage is deterministic code.** One stage closes items on mail evidence. A second stage, `runLedgerPass`, computes due reminder slots, claims them, sends them, and opens nudge jobs. Nudge jobs are ordinary `boss` jobs that pass the unchanged gate.
- **No change** to `policy/engine.ts`.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` imports), Postgres 17, zod, vitest on a real database, Agent SDK for the nudge drafter only.

**Spec:** `docs/superpowers/specs/2026-11-01-task-ledger-followup-design.md`. §11 of the spec overrides everything earlier in it.

**Owner instruction: no git commits during this work.** The commit step of each task is replaced by "leave uncommitted". The owner reviews and approves before anything is committed.

## Global Constraints

- **Gate:** No exemption is added to the gate and `src/policy/engine.ts` is not touched. Everything outbound passes `evaluateToolCall`.
- **Language:** Hebrew in every string the owner reads; English in identifiers, comments and internal errors.
- **Labels:** Families and statuses reach the owner only through `src/domain/labels.ts`, as exhaustive `Record`s.
- **Money and time:** Money goes through `formatMinor` (`src/util/money.ts`) in the active charter's currency. Times are shown and computed in the charter's `identity.timezone`, never the process's zone or the database session's zone.
- **Imports and TypeScript flags:** `.js` on every relative import. Code must compile under `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`.
- **DB modules:** Every module that reads rows uses a private `interface XRow` with a `toX(row)` mapper. SQL is snake_case, TS is camelCase.
- **Zod:** A schema and its inferred type share one name.
- **Migration:** New file `src/db/migrations/052_task_ledger.sql`. Never edit an earlier migration.
- **Ledger writes:** Only from a job whose stored `provenance = 'boss'` **and** that has a `boss_instructions` row in the same business. Both are read from the database inside the handler, never from input.
- **Nudge recipient:** Fixed at item creation. It is `verified` only when it was **typed** in the instruction (`appearsVerbatimIn` and `textOrigin === 'typed'`) or is known to the charter. A recording, or a memory contact, gives an unverified address. Only a verified address enables "תוצאה". The recipient is never taken from an inbound mail.
- **Nudges:** Every nudge is `mail.send` with no threading fields, so its class is `email.initiate`. Agent `comms.email`, provenance `'boss'` as a literal, and no `boss_instructions` row on the nudge job.
- **Nudge cap:** `charter.autonomy.maxNudgesPerThread` from `loadActiveCharter(businessId).charter`. At the cap the item becomes `stuck` and the owner hears about it.
- **Money-out family:** `money_out` is locked to `remind`; saving `act` for it is refused.
- **Settings:** At least one reminder channel, enforced twice — a Hebrew refusal in the save function **and** a DB `CHECK`. The default is email + screen.
- **Reminder text:** Deterministic, with no model. Every reminder text that is sent carries `מזהה תזכורת: <reminder_id>`.
- **Claim before send:** `INSERT ... ON CONFLICT DO NOTHING RETURNING` on `(business_id, item_id, slot)`. Only a row inserted by this pass is sent.
- **Status transitions:** Every transition of `ledger_items.status` is conditional on the expected prior status, in the same `UPDATE ... WHERE status = $expected`. A lost race is counted as `skipped`, never as an error.
- **Word lists:** The ledger's WhatsApp words are disjoint from `CONFIRM_WORDS`, `CANCEL_WORDS`, `CLOSURE_VERB_WORDS`, `FORGET_VERBS` and the mail-card words (`שלח`/`שלחי`). The test intersects the exported lists.
- **Erasure:** Every new table that holds content is wired into `erasure-plan.ts` and `erasure.ts`, and is seeded in `erasure-invariants.test.ts`.
- **Tests:** Real Postgres. Run on a dedicated database (see CLAUDE.md "הרצת מבחנים במקביל ל-hook"). Every negative test also asserts that the code under test **ran**.
- **Live calls:** Live, billed calls refuse under `config.isTest`, using the `refuseUnderTest` pattern.

## Review Focus

1. **Instruction says "remind me Sunday" late on a Saturday night, or across a DST change.** The due date must be the next Sunday in the charter's zone, never UTC-shifted by a day. Pinned in Task 2 (`localToInstant` across 2026-10-25 DST) and in Task 6 (the ledger block carries today's local date and weekday).
2. **A mail from the counterparty arrives the same minute the item was created, or the owner reopens an item and the same mail is still in the inbox.** The old mail must not close the item again. Pinned in Task 9 (`evidence_after` is moved forward on reopen).
3. **Two scheduler passes, or a pass that crashes after sending.** There must be no second reminder and no second nudge for the same slot. Pinned in Task 8 (claim race test) and in Task 10 (nudge slot claim).
4. **The owner answers "2 בוצע" after a newer morning batch has replaced the one he is looking at.** The number must resolve against the batch delivered before his message, never a newer one. Pinned in Task 11.
5. **A ledger item whose counterparty name contains `"` or `_`.** It must still be found by erasure. Pinned in Task 14 (the probe uses the existing `PROBE` with `_`, and a name with `"`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations/052_task_ledger.sql` | Six tables + constraints |
| `src/domain/ledger.ts` | zod enums and types: `LedgerFamily`, `LedgerStatus`, `LedgerMode`, `LedgerItem`, `LedgerStage`, `LedgerEventKind` |
| `src/domain/labels.ts` (modify) | `ledgerFamilyLabel`, `ledgerStatusLabel` |
| `src/util/local-time.ts` | `localToInstant`, `localParts`, `addBusinessDays` |
| `src/ledger/store.ts` | Item CRUD, events, conditional status moves |
| `src/ledger/settings.ts` | Settings + critical rules load/save, `isCritical` |
| `src/ledger/schedule.ts` | Pure: which reminder slots are due for an item |
| `src/ledger/render.ts` | Pure Hebrew text: reminders, WhatsApp batch, echo, evidence notice |
| `src/ledger/evidence.ts` | `closeLedgerByEvidence` |
| `src/ledger/nudge.ts` | Open nudge jobs, observe their outcome, fall back |
| `src/ledger/pass.ts` | `runLedgerPass`: schedule → claim → send; stuck transitions |
| `src/ledger/whatsapp-command.ts` | `readLedgerCommand` (pure) + `applyLedgerCommand` |
| `src/sdk/nudge-drafter.ts` | Billed drafter for a nudge body (fenced, `tools: []`) |
| `src/orchestrator/local-tools.ts` (modify) | `ledger.add`, `ledger.update` handlers + contracts |
| `src/policy/classify.ts`, `src/charter/capabilities.ts`, `src/domain/charter.ts` (modify) | Tool registration |
| `src/orchestrator/instruct.ts`, `src/sdk/planner.ts`, `src/orchestrator/whatsapp-door.ts` (modify) | Ledger block, echo, WhatsApp command routing |
| `src/orchestrator/scheduler.ts` (modify) | Two new stages |
| `src/dashboard/ledger-views.ts`, `src/dashboard/ledger-routes.ts`, `src/dashboard/server.ts` (modify) | `/ledger`, `/ledger/settings` |
| `src/orchestrator/digest-facts.ts`, `digest-render.ts` (modify) | Ledger section |
| `src/governance/erasure-plan.ts`, `erasure.ts`, `erasure-invariants.test.ts` (modify) | Erasure wiring |
| `CLAUDE.md`, `docs/10-user-settings.md`, `docs/11-pre-launch-checks.md`, `docs/09-roadmap.md` | Documentation |

---

### Task 1: Migration, domain types, labels

**Files:**
- Create: `src/db/migrations/052_task_ledger.sql`, `src/domain/ledger.ts`, `src/domain/ledger.test.ts`
- Modify: `src/domain/labels.ts`, `src/domain/labels.test.ts` (if present; otherwise add assertions to `ledger.test.ts`)

**Interfaces — Produces:**
```ts
export const LedgerFamily = z.enum(['money_in','money_out','meetings','warm_leads','awaiting_reply','projects']);
export const LedgerStatus = z.enum(['open','stuck','closed_by_evidence','done','cancelled']);
export const LedgerMode = z.enum(['remind','act']);
export const Importance = z.enum(['normal','critical']);
export const LedgerStage = z.object({ title: z.string().min(1).max(200), done: z.boolean() });
export const LedgerEventKind = z.enum(['created','updated','reminded','nudged','nudge_fallback','closed_by_evidence','reopened','done','cancelled','snoozed','stuck','held','not_held','stages_saved','address_confirmed','pace_alert']);
export interface LedgerItem {
  itemId: string; businessId: string; family: LedgerFamily; description: string;
  dueAt: Date | null; dueIsDateOnly: boolean; importance: Importance; importanceManual: boolean;
  counterpartyName: string | null; counterpartyEmail: string | null; counterpartyEmailVerified: boolean;
  counterpartyDomain: string | null; reference: string | null; amountMinor: number | null;
  stages: LedgerStage[]; proposedStages: LedgerStage[] | null;
  status: LedgerStatus; nudgeCount: number; evidenceAfter: Date;
  originJobId: string; createdAt: Date; updatedAt: Date; closedAt: Date | null;
}
export const ledgerFamilyLabel: Record<LedgerFamily, string>; // in labels.ts
export const ledgerStatusLabel: Record<LedgerStatus, string>; // in labels.ts
```

The Hebrew labels in `labels.ts`:
- **Families:** כסף נכנס · כסף יוצא · פגישות ושיחות · לקוחות חמים · ממתינים לצד שני · עבודות פתוחות
- **Statuses:** פתוח · תקוע · נסגר לפי ראיה · בוצע · בוטל

**Migration 052 tables** (all with `business_id TEXT NOT NULL`; ids are TEXT ulids with prefixes `LI-`/`LE-`/`LR-`/`LW-`/`LC-`):

| Table | Columns / constraints |
|---|---|
| `ledger_items` | Every `LedgerItem` field in snake_case. `stages JSONB NOT NULL DEFAULT '[]'`, `proposed_stages JSONB`. Plus `nudge_job_id TEXT` (the nudge in flight, NULL when none). CHECKs: family ∈ enum, status ∈ enum, importance ∈ enum, `amount_minor IS NULL OR amount_minor >= 0`, `counterparty_email_verified = false OR counterparty_email IS NOT NULL`. Index `(business_id, status)`. |
| `ledger_events` | `event_id`, `item_id REFERENCES ledger_items ON DELETE CASCADE`, `kind` (CHECK enum), `job_id TEXT` (nullable — the job that caused it), `mail_id TEXT`, `note TEXT`, `by_whom TEXT NOT NULL`, `at TIMESTAMPTZ DEFAULT now()`. |
| `ledger_settings` | `business_id` PK. `modes JSONB NOT NULL` (family → mode). `to_whatsapp`, `to_email`, `to_screen` BOOLEAN. `meeting_lead_minutes INT NOT NULL`, `meeting_lead_minutes_critical INT[] NOT NULL`, `due_lead_days_critical INT NOT NULL`, `nudge_after_business_days INT NOT NULL`, `checkin_every_days INT NOT NULL`, `checkin_every_days_critical INT NOT NULL`, `daily_hour INT NOT NULL CHECK (0..23)`, `updated_at`, `updated_by`. `CONSTRAINT ledger_settings_at_least_one_channel CHECK (to_whatsapp OR to_email OR to_screen)`. CHECK `modes->>'money_out' = 'remind'`. |
| `ledger_critical_rules` | `rule_id`, `kind` CHECK ∈ (`family`, `amount_over`, `counterparty`), `family TEXT`, `amount_minor BIGINT`, `match TEXT` (name/email/domain, lower-case), `created_by`, `created_at`. CHECK: exactly the field of the kind is non-null. |
| `ledger_reminders` | `reminder_id`, `item_id REFERENCES ledger_items ON DELETE CASCADE`, `slot TEXT NOT NULL`, `kind TEXT NOT NULL`, `body TEXT NOT NULL`, `email_state`, `whatsapp_state` (047 meaning + CHECK), `seen_at`, `created_at`. `UNIQUE (business_id, item_id, slot)`. |
| `ledger_whatsapp_batches` | `batch_id`, `items TEXT[] NOT NULL` (item ids in display order, 1-based numbering), `sent_at TIMESTAMPTZ` (NULL until the send returned ok), `created_at`. |

Docblocks follow the style of migration 047: say *why* for each constraint.

- [ ] **Step 1: Write `src/domain/ledger.test.ts`.** Tests:
  - `LedgerFamily.options` equals the six names above, in order.
  - `ledgerFamilyLabel` and `ledgerStatusLabel` have a non-empty Hebrew value for every option.
  - The migration applies: after `ensureSchema()`, inserting `ledger_settings` with all three channels false throws, with a message matching `/ledger_settings_at_least_one_channel/`.
  - Inserting `modes = {"money_out":"act",...}` throws.
- [ ] **Step 2:** Create the test DB per CLAUDE.md and run `TEST_DATABASE_URL="$SDD" npx vitest run src/domain/ledger.test.ts --no-file-parallelism`. Expected: FAIL (module missing).
- [ ] **Step 3:** Write the migration and `src/domain/ledger.ts`, and add the two label records. Run `TEST_DATABASE_URL="$SDD" npm run migrate:test`.
- [ ] **Step 4:** Re-run the test. Expected: PASS. Run `npm run typecheck`.
- [ ] **Step 5:** Leave uncommitted (owner instruction).

---

### Task 2: Local-time utilities

**Files:** Create `src/util/local-time.ts`, `src/util/local-time.test.ts`

**Interfaces — Produces:**
```ts
/** The instant at which the wall clock in `timeZone` reads `date` `time`. Throws on a nonexistent local time? No — a DST-gap time resolves to the first valid minute after it. */
export function localToInstant(date: string /* YYYY-MM-DD */, time: string /* HH:mm */, timeZone: string): Date;
export function localParts(instant: Date, timeZone: string): { date: string; time: string; weekday: Weekday };
/** `n` business days after `from`'s local date, skipping days not in `workweek` and dates in `holidays`; returns the instant at `hour`:00 local. */
export function addBusinessDays(from: Date, n: number, opts: { timeZone: string; workweek: Weekday[]; holidays: string[]; hour: number }): Date;
```
Use `Intl.DateTimeFormat` probing, the same rule `lastHourInstant` in `digest-window.ts` uses. Do not use offset arithmetic.

- [ ] **Step 1: Tests**
  - `localToInstant('2026-11-01','09:00','Asia/Jerusalem').toISOString() === '2026-11-01T07:00:00.000Z'` (winter, UTC+2).
  - `localToInstant('2026-10-20','09:00','Asia/Jerusalem').toISOString() === '2026-10-20T06:00:00.000Z'` (summer, UTC+3).
  - A night time on DST-end day: `localToInstant('2026-10-25','01:30','Asia/Jerusalem')` round-trips via `localParts` to date `2026-10-25`.
  - `localParts(new Date('2026-10-31T22:30:00Z'),'Asia/Jerusalem')` → `{date:'2026-11-01', time:'00:30', weekday:'sun'}`.
  - `addBusinessDays` from Thu 2026-10-29 by 1 with workweek sun–thu → Sun 2026-11-01 08:00 local.
  - A holiday on the target date is skipped.
- [ ] **Step 2:** Run; expected FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expected PASS.
- [ ] **Step 5:** Leave uncommitted.

---

### Task 3: Ledger store

**Files:** Create `src/ledger/store.ts`, `src/ledger/store.test.ts`

**Interfaces — Produces:**
```ts
export interface NewLedgerItem { family; description; dueAt: Date|null; dueIsDateOnly; importance; importanceManual;
  counterpartyName; counterpartyEmail; counterpartyEmailVerified; counterpartyDomain; reference; amountMinor;
  stages: LedgerStage[]; proposedStages: LedgerStage[]|null; originJobId: string; }
export async function createLedgerItem(item: NewLedgerItem, opts: { businessId: string; by: string; db?: Queryable }): Promise<LedgerItem>; // also writes 'created' event
export async function loadLedgerItem(itemId: string, opts: { businessId: string; db?: Queryable }): Promise<LedgerItem|null>;
export async function listLedgerItems(opts: { businessId: string; statuses?: LedgerStatus[]; db?: Queryable }): Promise<LedgerItem[]>; // ORDER BY importance critical first, due_at NULLS LAST, created_at
export type LedgerPatch = Partial<Pick<LedgerItem,'description'|'dueAt'|'dueIsDateOnly'|'importance'|'importanceManual'|'reference'|'amountMinor'|'stages'|'proposedStages'|'counterpartyEmailVerified'>>;
export async function updateLedgerItem(itemId: string, patch: LedgerPatch, event: { kind: LedgerEventKind; by: string; jobId?: string; note?: string }, opts): Promise<LedgerItem>; // throws LedgerItemNotFoundError
export async function moveLedgerStatus(itemId: string, from: LedgerStatus[], to: LedgerStatus, event: { kind; by; jobId?; mailId?; note? }, opts): Promise<boolean>; // false = lost race / not in `from`
export async function listLedgerEvents(itemId: string, opts): Promise<LedgerEvent[]>;
export class LedgerItemNotFoundError extends Error {}
```

Status rules inside `moveLedgerStatus`:
- **Into `closed_by_evidence`, `done`, `cancelled`:** sets `closed_at = now()`.
- **Into `open` (reopen):** sets `closed_at = NULL` and `evidence_after = now()`. When the event carries a new `dueAt` (via a preceding `updateLedgerItem`), the caller resets `nudge_count` with a patch. The store never infers it.
- **One transaction:** the event row and the status update are a single transaction.

- [ ] **Step 1: Tests**
  - `creates an item with a created event`.
  - `moveLedgerStatus refuses a status not in from` (returns false and writes no event row).
  - `reopen moves evidence_after forward` (`evidenceAfter` > the previous value).
  - `scoped by business`: loading with another `businessId` returns null.
  - `updateLedgerItem on a missing id throws LedgerItemNotFoundError`.
- [ ] **Steps 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5:** Leave uncommitted.

---

### Task 4: Settings and critical rules

**Files:** Create `src/ledger/settings.ts`, `src/ledger/settings.test.ts`

**Interfaces — Produces:**
```ts
export interface LedgerSettings { modes: Record<LedgerFamily, LedgerMode>; toWhatsApp: boolean; toEmail: boolean; toScreen: boolean;
  meetingLeadMinutes: number; meetingLeadMinutesCritical: number[]; dueLeadDaysCritical: number;
  nudgeAfterBusinessDays: number; checkinEveryDays: number; checkinEveryDaysCritical: number; dailyHour: number; }
export const LEDGER_DEFAULTS: Readonly<LedgerSettings>;
export async function loadLedgerSettings(o: { businessId: string; db?: Queryable }): Promise<LedgerSettings>; // absent row → defaults; never writes
export async function saveLedgerSettings(s: LedgerSettings, o: { businessId: string; updatedBy: string; db?: Queryable }): Promise<void>;
export type CriticalRule = { ruleId: string } & ({ kind:'family'; family: LedgerFamily } | { kind:'amount_over'; amountMinor: number } | { kind:'counterparty'; match: string });
export async function listCriticalRules(o): Promise<CriticalRule[]>;
export async function addCriticalRule(rule: Omit<CriticalRule,'ruleId'>, o: { businessId; by; db? }): Promise<CriticalRule>;
export async function removeCriticalRule(ruleId: string, o): Promise<void>;
export function matchesCriticalRule(item: Pick<LedgerItem,'family'|'amountMinor'|'counterpartyName'|'counterpartyEmail'|'counterpartyDomain'>, rules: CriticalRule[]): boolean;
```

**Default values** (from spec §6.4 and §10):

| Setting | Default |
|---|---|
| `modes` | all `remind` |
| Channels | email + screen |
| `meetingLeadMinutes` | 60 |
| `meetingLeadMinutesCritical` | [1440, 60] |
| `dueLeadDaysCritical` | 3 |
| `nudgeAfterBusinessDays` | 3 |
| `checkinEveryDays` | 2 |
| `checkinEveryDaysCritical` | 1 |
| `dailyHour` | 8 |

**`saveLedgerSettings` refusals, in Hebrew, before any write:**

| Condition | Message |
|---|---|
| No channel chosen | `'חובה לבחור לפחות דרך תזכורת אחת'` |
| `modes.money_out === 'act'` | `'כסף יוצא — רק תזכורת, עד שיהיה כלי תשלום'` |
| Any numeric field out of range | `'יש לבחור ערכים תקינים'` |

Valid ranges: minutes 1–10080, days 1–30, hour 0–23.

**Critical-rule matching:**
- **`counterparty` rules:** the match is case-insensitive equality against the email, or against the domain (domain-label anchored via `domainMatches` from `src/util/address.ts`), or the name.
- **`amount_over`:** strictly greater than the amount.

- [ ] **Step 1: Tests**
  - Defaults are returned when the row is absent, and no row is written.
  - The all-false save throws the Hebrew message.
  - The money_out `act` save throws.
  - Round-trip.
  - `matchesCriticalRule`: family hit; amount 5000_00 vs rule 5000_00 → false, 5000_01 → true; counterparty `DANA@X.co` matches rule `dana@x.co`; domain rule `x.co` matches `a@sub.x.co`.
- [ ] **Steps 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5:** Leave uncommitted.

---

### Task 5: The two ledger tools (boss-only writes)

**Files:**
- Modify: `src/orchestrator/local-tools.ts`, `src/policy/classify.ts`, `src/charter/capabilities.ts`, `src/domain/charter.ts` (`KNOWN_TOOL_NAMES`)
- Test: `src/orchestrator/ledger-tools.test.ts`

**Interfaces — Consumes:** Task 3 store and Task 4 `matchesCriticalRule`.

**Interfaces — Produces:**
- Tools `ledger.add` and `ledger.update`.
- `export async function assertLedgerWriter(jobId: string, businessId: string, db: Queryable): Promise<void>`. It throws `StepChannelError('ledger_not_boss_instruction', …, false)` unless `jobs.provenance = 'boss'` **and** a `boss_instructions` row exists for `(business_id, job_id)`.

**Tool input schemas** (zod, in `local-tools.ts`):
```ts
const LedgerAddInput = z.object({
  family: LedgerFamily, description: z.string().min(1).max(500),
  dueDate: IsoDate.optional(), dueTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  critical: z.boolean().optional(),
  counterpartyName: z.string().max(200).optional(), counterpartyEmail: z.string().max(320).optional(),
  counterpartyDomain: z.string().max(253).optional(), reference: z.string().max(100).optional(),
  amountMinor: z.number().int().nonnegative().optional(),
  stages: z.array(z.string().min(1).max(200)).max(20).optional(),
  proposedStages: z.array(z.string().min(1).max(200)).max(20).optional(),
}).strict();
const LedgerUpdateInput = z.object({ itemId: SafeLookupKey, description?, dueDate?, dueTime?, critical?, reference?, amountMinor?,
  stagesDone: z.array(z.number().int().min(1)).optional() /* 1-based stage numbers now done */,
  stages: z.array(z.string()).max(20).optional(), note: z.string().max(500).optional() }).strict();
```

**`ledger.add` handler**, in order:
1. Call `assertLedgerWriter`.
2. Load the active charter.
3. Resolve `dueAt` with `localToInstant(dueDate, dueTime ?? String(settings.dailyHour).padStart(2,'0')+':00', tz)`. Set `dueIsDateOnly` = `dueTime` absent.
4. Decide whether the email is verified. It is verified iff `authorisedRecipients`-style typed-or-known holds, using the job's stored instruction `text_origin`:
   - verified if the email `appearsVerbatimIn(instruction.text)` and `text_origin === 'typed'`;
   - **or** if `knownToCharter`.
   - Read the instruction row by job. Never take this from input.
5. Set importance = `critical` if `critical === true` (then `importanceManual = true`), else from `matchesCriticalRule`.
6. Validate the domain with `normaliseDomainString` + the same shape check used for charter domains.
7. Return `{ performed: true, itemId, family, dueAt, importance, counterpartyEmailVerified }`.
8. **Refusals:**
   - `family: 'money_in'` with `amountMinor` but no `reference` is allowed.
   - `projects` without `dueDate` → `local_tool_bad_input`. The spec requires a deadline.

**`ledger.update` handler:**
- Calls the same `assertLedgerWriter`, then `loadLedgerItem` in the same business. A missing item → `StepChannelError('ledger_item_not_found', …, false)`.
- Applies the patch.
- A `dueDate` change on a `stuck` or closed item does not reopen it. Reopening is a command (Task 11), not a planner action.

**Registration:**
- Add both tools to `READ_ONLY_TOOLS` and to `INGESTS_EXTERNAL_CONTENT` as `false`.
- Add both to `KNOWN_TOOL_NAMES`, and to the `ops.tasks` allowlist in `AGENT_ALLOWLISTS`.
- `LOCAL_TOOL_CONTRACTS` gets two entries describing the payload in Hebrew. They must include the rule from spec §7.1: "רק כשיש מועד או התחייבות — אחרת זה זיכרון (`memory.*`)".
- Add a third entry for `tasks.read`/`tasks.update_state`/`followup.schedule`: `'לא ממומשים — לפנקס השתמשי ב-ledger.add / ledger.update'`.

Add to CLAUDE.md's list of read-only tools with side effects (in Task 15).

- [ ] **Step 1: Tests**, each driving `runLocalTool` with a real job row:
  - `adds an item from a boss instruction job`: create a job with `provenance 'boss'` + `saveInstruction` → item exists with family and dueAt.
  - `refuses a boss job with no instruction row`: throws `ledger_not_boss_instruction`, and `SELECT count(*) FROM ledger_items` = 0 (proves the handler ran to the check: also assert the thrown code, not just any throw).
  - `refuses an unknown_external job`: same assertions.
  - `email typed in a typed instruction is verified`.
  - `email from a transcribed instruction is not verified` (`text_origin 'transcribed'`).
  - `email absent from the instruction text is not verified`.
  - `projects without dueDate is refused`.
  - `critical rule marks importance`.
  - `update refuses an item of another business`.
  - **Invariant test, extending `positive-controls.test.ts`'s existing check rather than a new one:** `ledger.add` and `ledger.update` are in `READ_ONLY_TOOLS`, not in `TOOL_ACTION_CLASS`, and are in `KNOWN_TOOL_NAMES`. Run `src/charter/capabilities.test.ts` and `src/policy/positive-controls.test.ts`.
- [ ] **Steps 2–4:** Run → FAIL, implement, run the five files → PASS.
- [ ] **Step 5:** Leave uncommitted.

---

### Task 6: Planner context and the "רשמתי" echo

**Files:**
- Modify: `src/sdk/planner.ts` (`PlanRequest.ledgerBlock?: string`, rendered in the final uncached section **after** `memoryBlock`), `src/orchestrator/instruct.ts`, `src/orchestrator/whatsapp-door.ts` (`composeAck`), `src/dashboard/views.ts` (`renderInstruct` result)
- Create: `src/ledger/render.ts` (`renderLedgerBlock`, `renderLedgerEcho`)
- Test: `src/ledger/render.test.ts`, extend `src/orchestrator/instruct.test.ts`

**Interfaces — Produces:**
```ts
export function renderLedgerBlock(o: { now: Date; timeZone: string; items: LedgerItem[] }): string;
// "# הפנקס\nהיום: יום ראשון 01/11/2026, 21:40 (Asia/Jerusalem)\n" + one line per open/stuck item: "- [itemId] <family label> · <description one-line> · מועד <dd/MM HH:mm|dd/MM> · <importance>"
export function renderLedgerEcho(steps: PlanStep[], o: { timeZone: string; currency: string }): string | null;
// null when no ledger.add/ledger.update step. Lines: "רשמתי: <family label> · <description> · מועד <...> · קריטי" ; "עדכנתי: ..." ; address unverified → "(כתובת לא מאומתת — לא אפנה אליה לפני שתאשר)" ; proposedStages → "הצעה לשלבים: 1. … 2. … — לשמירה: בדשבורד, או 'שמרי שלבים' בהודעת הפנקס הבאה" (the item has no batch number yet when the echo is rendered)
```

**Where these are wired:**
- **`InstructionOutcome` `planned`:** gains `ledgerEcho: string | null`. `composeAck` appends it after `PLANNED_ACK`, and the dashboard instruct result shows it.
- **The ledger block in `runInstruction`:**
  - It is built from `listLedgerItems({statuses:['open','stuck']})`, capped at 50 items (most critical / soonest first).
  - It is passed to every planner call on this path, including per-candidate plans.
  - **Each `description` goes through `toOneLine`** — owner text, but one line, so it cannot forge a heading.
- **The echo is rendered from the plan's step inputs before they run.** It states what was understood. A step that later fails is reported by the existing WhatsApp report.

- [ ] **Step 1: Tests**
  - `renderLedgerBlock shows the local date and weekday`: `now = 2026-10-31T22:30Z`, Jerusalem → contains `יום ראשון 01/11/2026`.
  - `renderLedgerBlock folds a newline in a description`.
  - `renderLedgerEcho returns null for a plan with no ledger step`.
  - The echo for an add with critical + unverified email contains `קריטי` and `כתובת לא מאומתת`.
  - The instruct test: the planner stub receives `ledgerBlock` containing an existing open item id, and `memoryBlock` precedes `ledgerBlock` in the rendered prompt (`buildPlannerPrompt` index check).
  - A planned outcome with a `ledger.add` step carries a non-null `ledgerEcho`.
- [ ] **Steps 2–4:** Run → FAIL, implement, run (`render.test.ts`, `instruct.test.ts`, `planner.test.ts`, `whatsapp-door.test.ts`) → PASS.
- [ ] **Step 5:** Leave uncommitted.

---

### Task 7: The schedule (pure)

**Files:** Create `src/ledger/schedule.ts`, `src/ledger/schedule.test.ts`

**Interfaces — Produces:**
```ts
export type SlotKind = 'before' | 'due' | 'nudge' | 'checkin' | 'held_check' | 'pace' | 'overdue';
export interface DueSlot { slot: string /* `${kind}:${ISO instant}` */; kind: SlotKind; at: Date; }
export function dueSlots(item: LedgerItem, s: LedgerSettings, o: { now: Date; timeZone: string; workweek: Weekday[]; holidays: string[]; lastNudgeAt: Date | null }): DueSlot[];
```
`dueSlots` returns only slots with `at <= now`, and only for `status ∈ {open}`. A `stuck` item gets nothing; it was already escalated. Slots older than 24h are dropped (no backfill, like `ACTION_UPDATE_BACKFILL_MS`).

**Rules per family:**

| Family | Slots |
|---|---|
| `meetings` | `before` at `dueAt − meetingLeadMinutes` (critical: each of `meetingLeadMinutesCritical`). `held_check` at `dueAt + 60 min`. |
| `money_in`, `money_out`, `warm_leads`, `awaiting_reply` with `dueAt` | `due` at `dailyHour` on the due date. Critical adds `before` at `dailyHour`, `dueLeadDaysCritical` days earlier. `overdue` at `dailyHour` on each later local day while open (one per day). |
| `warm_leads`, `awaiting_reply` | `nudge` at `addBusinessDays(lastNudgeAt ?? createdAt, nudgeAfterBusinessDays, …)`. |
| `money_in` | `nudge` on the first `overdue` day. |
| `projects` | `checkin` every `checkinEveryDays` (critical: `checkinEveryDaysCritical`) at `dailyHour`, from creation. `pace` once per local day when behind (see below). `due` and `overdue` as above. |

**The `pace` rule:**
- With stages: `doneFraction + 0.25 < elapsedFraction`, where `elapsedFraction = (now − createdAt)/(dueAt − createdAt)`.
- Without stages: one `pace` slot each at 50% and 80% elapsed.

**Slot keys and modes:**
- The slot key uses the scheduled instant, so the same slot always has the same key across passes.
- `nudge` slots are produced regardless of mode. Task 10 decides by mode (in `remind` mode a nudge slot becomes a "time to follow up with X" reminder to the owner).

- [ ] **Step 1: Tests**, one per rule above, with fixed `now` and the Jerusalem zone:
  - A meeting at 10:00 local yields `before` at 09:00 and nothing at 08:59.
  - A critical meeting yields two `before` slots.
  - `held_check` appears at 11:00.
  - A money_in item due today yields `due` at 08:00 local.
  - Overdue the next day yields `overdue` + `nudge`.
  - An awaiting_reply item created Thu yields `nudge` on Tue (3 business days, sun–thu).
  - Project pace with 1/5 stages done at 60% elapsed yields `pace`; at 40% it does not.
  - A stuck item yields `[]`.
  - A slot 25h old is dropped.
  - Slot keys are stable across two calls with different `now`.
- [ ] **Steps 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5:** Leave uncommitted.

---

### Task 8: Reminder pass (owner reminders, WhatsApp batch, screen)

**Files:**
- Create: `src/ledger/pass.ts`, `src/ledger/pass.test.ts`
- Extend: `src/ledger/render.ts`

**Interfaces — Produces:**
```ts
export interface LedgerPassResult { reminded: number; nudgesOpened: number; nudgeFallbacks: number; stuck: number; emailFailed: number; whatsappFailed: number; skippedNotConnected: number; skipped: number; errored: { itemId: string; error: string }[]; }
export async function runLedgerPass(o: { businessId: string; now?: Date; sendAlert?: (subject: string, body: string) => Promise<{ ok: boolean; error?: string }>; messenger?: BossMessenger; dashboardBaseUrl?: string; drafter?: NudgeDrafter; db?: Queryable; timeoutMs?: number }): Promise<LedgerPassResult>;
export function renderReminder(item: LedgerItem, kind: SlotKind, o: { timeZone: string; currency: string; draft?: string }): { subject: string; body: string };
export function renderWhatsAppBatch(entries: { n: number; text: string }[]): string;
```

**Steps of `runLedgerPass`:**
1. Load the active charter. If there is none, return an empty result.
2. Load the settings, then the items `open`. For each item, `dueSlots(...)` (with `lastNudgeAt` from the latest `nudged` event).
3. **`nudge` slots are handed to Task 10.** This task only claims and sends the owner reminders for every other kind, and for `nudge` when the family mode is `remind`.
4. **Per slot, claim:** `INSERT INTO ledger_reminders … ON CONFLICT (business_id,item_id,slot) DO NOTHING RETURNING reminder_id`. Only claimed rows proceed. Write a `reminded` event.
5. **Email:** one email per reminder (`sendAlert`), with the subject prefixed `⚠️ ` for critical. The body carries `מזהה תזכורת: <id>` and a link to `/ledger`.
6. **WhatsApp:** all reminders claimed in this pass are collected into **one** numbered message:
   - Insert the `ledger_whatsapp_batches` row with item ids in order.
   - Send through `messenger.send({ text, jobId: null })`.
   - On `ok`, set `sent_at = now()`.
   - On a failure, `sent_at` stays NULL, so commands cannot address it, and the reminder rows get `whatsapp_state = 'failed'`.
   - The message ends with `"השיבי במספר ומילה: בוצע · בטלי · דחי מחר · דחי ל-DD/MM · פתחי · התקיימה · לא התקיימה · שמרי שלבים · אשרי כתובת"`.
7. **Screen:** `seen_at` stays NULL until `/ledger` is opened.
8. **Channel states:** each channel races `withDeadline` and is caught on its own. States follow 047.

**`renderReminder` texts by kind:**

| Kind | Text |
|---|---|
| `before`/`due` | `"תזכורת: <description> — <family label> · <מועד>"` |
| `overdue` | `"עבר המועד: …"` |
| `held_check` | `"הפגישה <description> ב-<HH:mm> — התקיימה?"` |
| `checkin` | `"איפה עומד <description>? הושלם: … · חסר: … · נעצרת ב: <first undone stage>"` |
| `pace` | `"<description>: נשארו <n> ימים לתאריך היעד, הושלמו <d> מתוך <t> שלבים"` |
| `nudge` in remind mode | `"הגיע הזמן לחזור ל<counterpartyName ?? description>"` |
| Any kind with a `draft` (Task 10 fallback) | Appends `"\n\nהכנתי טיוטה, אבל לא שלחתי (<reason>):\n<draft>"` |

**Text hygiene:** every value from the item goes through `toOneLine` + `stripBidiControls`. A critical item gets the prefix `"⚠️ קריטי — "`.

- [ ] **Step 1: Tests** (stub `sendAlert` and messenger, counting calls):
  - `sends one reminder per due slot and records the states`.
  - `a second pass sends nothing` — the counts stay the same.
  - `two concurrent passes send once` — `Promise.all` of two passes on the same db, total sends = 1.
  - `WhatsApp batches all reminders into one numbered message and stamps sent_at only on ok`.
  - `failed WhatsApp send leaves sent_at NULL`.
  - `a chosen channel with no seam is skipped_not_connected`.
  - `critical reminder is marked`.
  - `the sent text carries the reminder id`.
  - `nothing is sent for a cancelled item` — a negative test: assert that `dueSlots` would have produced slots for the same item when `open` (call it directly) and that the send count is 0.
- [ ] **Steps 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5:** Leave uncommitted.

---

### Task 9: Evidence closure

**Files:** Create `src/ledger/evidence.ts`, `src/ledger/evidence.test.ts`

**Interfaces — Produces:**
```ts
export interface EvidenceResult { closed: { itemId: string; mailId: string }[]; skipped: number; }
export async function closeLedgerByEvidence(o: { businessId: string; sendAlert?; messenger?; dashboardBaseUrl?; db?: Queryable; timeoutMs?: number }): Promise<EvidenceResult>;
```

**Matching (deterministic SQL + JS), for items with `status = 'open'` and family ∈ (`money_in`, `warm_leads`, `awaiting_reply`):**
- **Candidate mails:** the same `business_id` and `created_at > item.evidence_after`.
- **Sender:**
  - If the item has `counterparty_email`: `lower(from_address) = lower(counterparty_email)`.
  - If it has only `counterparty_domain`: the domain of `from_address` satisfies `domainMatches(domain, counterparty_domain)`.
  - With neither, the item is never matched.
- **Reference:** when the item has a `reference`, it must appear (case-insensitive, `position`) in `subject || ' ' || coalesce(body_text,'')`.
- **`money_in` requires a `reference`.** Without one, the item is never closed by evidence.
- **Choice:** the earliest matching mail.

On a match:
- `moveLedgerStatus(item, ['open'], 'closed_by_evidence', { kind:'closed_by_evidence', mailId, by:'evidence' })`. A lost race counts as `skipped`.
- Send the notice: `"סגרתי '<description>' — הגיע מייל מ-<from_address>: <subject>. אם זה לא נכון, השיבי 'N פתחי' או פתחי מחדש בדשבורד."`.
  - The notice always names the sender address.
  - Email is sent via `sendAlert`. WhatsApp goes out as a one-item batch (Task 8's batch insert, so "1 פתחי" works).
  - Screen: the item shows in the "נסגר לפי ראיה" filter.
- The notice is also written as a `ledger_reminders` row with `slot = 'evidence:<mailId>'` (claim first, same idempotency).

- [ ] **Step 1: Tests:**
  - `closes an awaiting_reply item on a mail from the counterparty`.
  - `does not close on a mail older than evidence_after`.
  - `money_in without reference never closes` (assert the matching mail exists and was considered: the function's `skipped`/debug count, or a sibling item with a reference closed in the same run).
  - `money_in closes only when the reference appears`.
  - `domain match accepts a subdomain`.
  - `the notice names the sender`.
  - `reopen then rerun does not close again on the same mail`.
  - `another business's mail never matches`.
- [ ] **Steps 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5:** Leave uncommitted.

---

### Task 10: "תוצאה" — nudge jobs through the gate

**Files:**
- Create: `src/sdk/nudge-drafter.ts`, `src/ledger/nudge.ts`, `src/ledger/nudge.test.ts`
- Modify: `src/config.ts` (`ledgerNudgesPerDay: positiveInt('LEDGER_NUDGES_PER_DAY', 20)`), `.env.example`

**Interfaces — Produces:**
```ts
// nudge-drafter.ts — same shape and hardening as mail-drafter.ts: fenced fields, tools: [], env {PATH}, maxTurns 1, refuseUnderTest, interpretDraft reused
export interface NudgeDraftRequest { bundle: PolicyBundle; family: LedgerFamily; description: string; reference: string | null; dueText: string | null; counterpartyName: string | null; nudgeNumber: number; }
export type NudgeDrafter = (r: NudgeDraftRequest) => Promise<DraftOutcome>;
export const runNudgeDrafter: NudgeDrafter;
// nudge.ts
export async function openNudge(item: LedgerItem, slot: DueSlot, o: { businessId; active: ActiveCharter; drafter: NudgeDrafter; db? }): Promise<'opened' | 'capped' | 'no_address' | 'claimed_elsewhere' | 'draft_failed'>;
export async function observeNudges(o: { businessId; db? }): Promise<{ sent: string[]; fallback: { itemId: string; draft: string; reason: string }[] }>;
```

**`openNudge`** runs only when `settings.modes[family] === 'act'`. Otherwise Task 8 sends a remind-mode reminder instead. Order:
1. **Claim the slot** in `ledger_reminders` first (`kind 'nudge'`, body `''` until drafted).
2. **No verified address:** fall back to an owner reminder (`'no_address'`).
3. **At the cap** (`nudge_count >= charter.autonomy.maxNudgesPerThread`): `moveLedgerStatus(['open'],'stuck', {kind:'stuck'})` and the owner gets `"<description> — נדנדתי <n> פעמים ואין תשובה. עובר אליך."`.
4. **Daily cap:** the count of `nudged` events today ≥ `config.ledgerNudgesPerDay` → leave the slot unclaimed and report `'capped'` (retried next pass; the day boundary is in the charter zone).
5. **Draft** via `drafter`. On failure, fall back with the reason `'הניסוח נכשל'`.
6. **Create the nudge job:**
   - `createJob({ provenance: 'boss', title: 'פולואפ: ' + toOneLine(description).slice(0,80), charterVersion })`.
   - Bind the plan `{ goal, steps:[{ id:'nudge', agent:'comms.email', intent:'follow_up', toolName:'mail.send', input:{ to: counterpartyEmail, subject: <family-specific Hebrew subject + reference>, body: draft }, dependsOn:[], expectedActionClass:'email.initiate' }] }`.
   - `transition` → `execute`.
   - Set `ledger_items.nudge_job_id`. Write a `nudged` event (with `jobId`) **only after the job is closed with the step performed**, from `observeNudges`.
7. Store the draft in the reminder row body.

**`observeNudges`** scans items with `nudge_job_id IS NOT NULL`:

| Job phase | Action |
|---|---|
| `closed` and its step result `performed = true` | `nudge_count += 1`, `nudged` event, clear `nudge_job_id` |
| `failed` | `nudge_fallback` event, owner reminder with the draft and the reason (the job's last `job_steps.reason`; `isGateDenialCode` → `"העוזרת לא מורשית לשלוח את זה עדיין"`), clear `nudge_job_id` |
| `await_approval` | Nothing (the card is the owner's) |

Two invariants:
- **The nudge job must not get a `boss_instructions` row.** Assert this in a test, so `confirmedCommandCovers` can never apply.
- **No standing authorization is granted.**

- [ ] **Step 1: Tests** (stub drafter; `mailboxRuntime`/`fakeMailboxClient` from `src/test/mailbox.ts` for the run):
  - `act mode under ask raises an approval card and sends nothing` — run `schedulerPass`, then assert an `approval_requests` row for the nudge job and 0 client sends; also assert the job reached the gate (an `audit_log` `intent_to_act` row exists).
  - `act mode under off falls back to an owner reminder with the draft` — assert the `draft_only` denial in `audit_log`, then the fallback reminder body contains the draft.
  - `remind mode never opens a job` — `jobs` count unchanged, an owner reminder was sent.
  - `unverified address never opens a job`.
  - `cap moves the item to stuck and tells the owner`.
  - `daily cap leaves the slot unclaimed`.
  - `nudge job has no boss_instructions row`.
  - `nudge payload has no threading fields` (classified `email.initiate` via `refineActionClass`).
  - `runNudgeDrafter refuses under test`.
- [ ] **Steps 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5:** Leave uncommitted.

---

### Task 11: WhatsApp commands and dashboard actions share one applier

**Files:**
- Create: `src/ledger/whatsapp-command.ts`, `src/ledger/whatsapp-command.test.ts`
- Modify: `src/orchestrator/whatsapp-door.ts` (route after the mail card, before transcription — typed text only)

**Interfaces — Produces:**
```ts
export const LEDGER_COMMAND_WORDS: readonly string[]; // ['בוצע','בטלי','דחי','פתחי','התקיימה','לא התקיימה','שמרי שלבים','אשרי כתובת']
export type LedgerCommand =
  | { kind: 'done' | 'cancel' | 'reopen' | 'held' | 'not_held' | 'save_stages' | 'confirm_address'; n: number | null }
  | { kind: 'snooze'; n: number | null; to: 'tomorrow' | { date: string /* YYYY-MM-DD */ } };
export function readLedgerCommand(text: string, o: { now: Date; timeZone: string }): LedgerCommand | null;
export async function applyLedgerCommand(itemId: string, cmd: LedgerCommand, o: { businessId: string; by: string; now: Date; timeZone: string; db?: Queryable }): Promise<'applied' | 'not_applicable' | 'lost_race'>;
export async function handleLedgerWhatsApp(input: { text: string; inboundAt: Date; businessId: string; by: string; now: Date; timeZone: string; messenger: BossMessenger; db?: Queryable }): Promise<'passthrough' | 'applied' | 'refused'>;
```

**Grammar** (after `stripBidiControls`, `trim`, trailing punctuation stripped):
- An optional leading number (`/^[1-9]\d*/`), then one command phrase.
- `דחי מחר`, `דחי ל-DD/MM` and `דחי לDD/MM`. The year is the next occurrence in the charter zone.
- Anything else is `null`.
- Single-word `לא` is **not** a command; `לא התקיימה` is.

**Command → effect:**

| Command | Effect |
|---|---|
| `done` | `moveLedgerStatus(['open','stuck','closed_by_evidence'],'done')` |
| `cancel` | → `cancelled` |
| `reopen` | from `closed_by_evidence`/`done`/`cancelled`/`stuck` → `open` |
| `held` | (meetings) → `done` with a `held` event |
| `not_held` | Event + stays `open`; the owner is asked "לקבוע מועד חדש? השיבי 'N דחי ל-DD/MM'" |
| `snooze` | `updateLedgerItem({dueAt})` + reset `nudge_count = 0`; reopens if stuck/closed |
| `save_stages` | `stages = proposedStages`, `proposedStages = null` |
| `confirm_address` | `counterpartyEmailVerified = true` |

**`handleLedgerWhatsApp` resolution:**
- Find the latest batch with `sent_at IS NOT NULL AND sent_at < inboundAt`.
- With `n`, resolve `items[n-1]`. Without `n`, act only if the batch has exactly one item.
- `n` out of range, or no batch → reply `"לא מצאתי את מספר <n> בהודעה האחרונה של הפנקס"` and return `refused`.
- A non-command → `passthrough`.
- The message is claimed (`claimMessage`) before applying.
- Reply `"<עודכן: description — new status label>"`.

**Door wiring:** in `processOne`, after the mail-card block, run this for `mediaKind === null && body !== null`. It does **not** participate in the several-open collision rule: its grammar is disjoint and number-addressed (spec §11.1 is narrowed here — record this in the spec as §11.7 in Task 15).

- [ ] **Step 1: Tests:**
  - `readLedgerCommand` table: `'2 בוצע'` → `{done,2}`; `'בוצע'` → `{done,null}`; `'3 דחי ל-05/11'` → snooze date `2026-11-05`; `'דחי מחר'` → tomorrow; `'כן'`, `'לא'`, `'שלח'` → `null`; `'2 בוצע!'` → done.
  - **Disjointness:** `LEDGER_COMMAND_WORDS` ∩ (`CONFIRM_WORDS` ∪ `CANCEL_WORDS` ∪ `CLOSURE_VERB_WORDS` ∪ `FORGET_VERBS` ∪ `MAIL_CARD_APPROVE_WORDS`) is empty. Also: none of those exported words, read by `readLedgerCommand`, is non-null.
  - `resolves n against the batch delivered before the message, not a newer one`.
  - `an unsent batch (sent_at NULL) cannot be addressed`.
  - `reopen moves an evidence-closed item to open and evidence_after forward`.
  - `snooze resets nudge_count and reopens a stuck item`.
  - Door: `a voice note saying '2 בוצע' does not apply` (falls through to transcription; the item status is unchanged).
  - Door: `a boss-command 'כן' still confirms while a ledger batch is open`.
- [ ] **Steps 2–4:** Run → FAIL, implement, run (`whatsapp-command.test.ts`, `whatsapp-door.test.ts`) → PASS.
- [ ] **Step 5:** Leave uncommitted.

---

### Task 12: Scheduler wiring

**Files:** Modify `src/orchestrator/scheduler.ts`. Test: `src/ledger/scheduler-ledger.test.ts`

**`SchedulerPassResult` gains:**
```ts
ledgerEvidence: EvidenceResult | null; ledgerEvidenceError: string | null;
ledger: LedgerPassResult | null;       ledgerError: string | null;
```
Both are `null` when no charter is active. Each is wrapped in its own try/catch, like `actionUpdates`.

**Order:**
- `closeLedgerByEvidence` runs **right after `pollMailbox`**, so a reply that arrived this pass closes the item before any reminder about it.
- `observeNudges` + `runLedgerPass` run **after `closeVerifiedJobs`** and before the WhatsApp report, so a nudge job closed this pass is observed this pass. The nudge jobs opened here run on the **next** pass's `runDueJobs`; state this in the docblock.

The seams are the same as `dispatchActionUpdates`: `runtime.notify?.sendAlert`, this pass's `whatsappMessenger`, `runtime.notify?.dashboardBaseUrl`, and `drafter` defaulting to `runNudgeDrafter`. `schedulerPass` options gain `ledgerDrafter?: NudgeDrafter` as a test seam.

- [ ] **Step 1: Tests:**
  - `one pass closes by evidence before it reminds` — an awaiting_reply item due now plus a matching mail in the same pass yields one evidence notice and zero `due` reminders.
  - `a throwing ledger stage does not stop the rest of the pass` — an `act`-mode item with a `ledgerDrafter` that throws; assert the item appears in `ledger.errored` and that `actionUpdates` still ran (its result is non-null and `actionUpdatesError` is null).
  - `null when no charter`.
- [ ] **Steps 2–4:** Run → FAIL, implement, run the new test + `scheduler.test.ts` → PASS.
- [ ] **Step 5:** Leave uncommitted.

---

### Task 13: Dashboard — `/ledger` and `/ledger/settings`

**Files:**
- Create: `src/dashboard/ledger-views.ts`, `src/dashboard/ledger-routes.ts`, `src/dashboard/ledger-routes.test.ts`
- Modify: `src/dashboard/server.ts` (route table + nav link "הפנקס")

**Routes** (all behind the session; every POST has CSRF):

| Route | Behaviour |
|---|---|
| `GET /ledger?filter=open\|overdue\|stuck\|evidence\|critical\|all` | **Top: "רשימת התקוע"** — stuck + overdue, critical first, then by due. Then per family. Each row: description (`escLabel`), counterparty, due (charter zone), importance, status label, unverified-address badge, stages, last 5 events. Unknown filter → `open`. Marks every `ledger_reminders.seen_at` NULL → now (same as `/autonomy/actions`; record the GET-mutates note already in CLAUDE.md known issues). |
| `POST /ledger/:itemId/action` | Form `action ∈ done\|cancel\|reopen\|held\|not_held\|save_stages\|confirm_address\|critical\|snooze`, `date` for snooze. Calls `applyLedgerCommand`; `critical` sets importance `critical`, `importanceManual = true`. Redirect `/ledger`. |
| `GET /ledger/settings` + `POST /ledger/settings` | Six family mode radios (money_out disabled with the sentence "רק תזכורת — אין עדיין כלי תשלום"), three channel checkboxes, numeric fields, daily hour. A refusal re-renders with the Hebrew message and the owner's values. |
| `POST /ledger/rules`, `POST /ledger/rules/:ruleId/delete` | Add/remove critical rules. Amount is entered in major units and converted with ×100 integer parsing; a non-integer agora is refused. |

**Settings-page text** (copy fixed by spec §6, Hebrew) explains that "תוצאה" goes through רמת החופש and the charter, and that under "כבוי" a draft comes to the owner instead.

- [ ] **Step 1: Tests:**
  - `GET /ledger lists open items with the stuck list first`.
  - `POST action done moves status` + CSRF missing → 403 and the status is unchanged.
  - `settings all-unchecked re-renders with the Hebrew refusal`.
  - `money_out act cannot be saved`.
  - `a description with a bidi override is rendered stripped`.
  - `another business's item id → 404`.
- [ ] **Steps 2–4:** Run → FAIL, implement, run (`ledger-routes.test.ts`, `server.test.ts`) → PASS.
- [ ] **Step 5:** Leave uncommitted.

---

### Task 14: Digest section and erasure

**Files:**
- Modify: `src/orchestrator/digest-facts.ts`, `src/orchestrator/digest-render.ts` (+ tests)
- Modify: `src/governance/erasure-plan.ts`, `src/governance/erasure.ts`, `src/governance/erasure-invariants.test.ts`, `src/governance/erasure-plan.test.ts`

**Digest:**
- `DigestFacts` gains `ledger: { open: number; overdue: number; stuck: number; closedByEvidence: number; topStuck: string[] /* ≤5 one-line descriptions */ }`. The window counts `closed_by_evidence` events inside the digest window.
- The render adds a section `"הפנקס"`, omitted when everything is 0.
- Rendering stays deterministic. The `digest-invariants.test.ts` BFS must still find no `src/sdk/` import, so the ledger modules imported by digest-facts must not import `src/sdk/nudge-drafter.ts`. Keep `ledger/store.ts` free of it.

**Erasure:**
- `ErasurePlan` gains `ledgerItemIds: string[]`, sorted in `planFingerprint`.
- `LEDGER_ITEMS_ERASED_PREDICATE = 'business_id = $1 AND item_id = ANY ($2)'`. `ledger_events` and `ledger_reminders` are counted in `countItems` by `item_id = ANY ($2)` and deleted explicitly **before** `ledger_items` (cascade-ordering lesson: the explicit delete must run first so `rowCount` is true).
- **Discovery (contact anchor):** items where any of `description`, `counterparty_name`, `counterparty_email`, `counterparty_domain`, `reference`, `stages::text`/`proposed_stages` (via `jsonbContentMatches`) matches; plus items with a `ledger_events.note` or a `ledger_reminders.body` match. Each matched item adds its `origin_job_id` and every `ledger_events.job_id` to `jobIds`.
- **Window anchor:** `ledger_items.created_at` in the window.
- **Job membership:** items whose `origin_job_id = ANY(jobIds)`.
- `ledger_whatsapp_batches` holds only ids: drop the erased ids from `items` (UPDATE `array_remove`), and delete batches left empty. Document why it is not a discovery source. `ledger_settings`/`ledger_critical_rules`: `counterparty` rules hold a match string about a person → a discovery + delete target by `match ILIKE`.
- Update the CLAUDE.md table count in Task 15.

**Tests:**
- Seed `PROBE` into `ledger_items.description`, `counterparty_name`, `ledger_events.note`, `ledger_reminders.body` and `ledger_critical_rules.match`. After erasure the schema-wide scan finds zero.
- A name with `"` in `stages` is found.
- The preview counts equal the executed `rowCount`s.

- [ ] **Steps 1–4:** Tests → FAIL → implement → PASS (`erasure-invariants.test.ts`, `erasure-plan.test.ts`, `erasure.test.ts`, the digest tests).
- [ ] **Step 5:** Leave uncommitted.

---

### Task 15: Documentation, full verification, security and code review

**Files:** `CLAUDE.md`, `docs/10-user-settings.md` (new §: "הפנקס"), `docs/11-pre-launch-checks.md`, `docs/09-roadmap.md`, `docs/superpowers/specs/2026-11-01-task-ledger-followup-design.md` (§11.7)

- [ ] **Step 1: CLAUDE.md.**
  - A new subsection "### פנקס המשימות והפולואפ (01/11)" stating the non-obvious rules: boss-only writes checked in the handler; `ledger.*` in `READ_ONLY_TOOLS` and why; nudge = `boss` without `boss_instructions` → no exemption; claim-before-send; `evidence_after`; numbered WhatsApp batch and why it is outside the collision rule; `maxNudgesPerThread` now enforced here; money_out locked.
  - Add `ledger.add`/`ledger.update` to the read-only-with-side-effects list.
  - Update the erasure table count and the command list (`LEDGER_NUDGES_PER_DAY`).
- [ ] **Step 2:** `docs/10-user-settings.md`: the families, modes, channels, critical rules and lead times, and the line "אף הגדרה כאן אינה מרחיבה סמכות".
- [ ] **Step 3:** `docs/11-pre-launch-checks.md`: ☐ a live run of `runNudgeDrafter`; ☐ a real morning WhatsApp batch and a numbered reply; ☐ evidence closure on a real mailbox; ☐ a full day of ledger use by the owner.
- [ ] **Step 4:** Run `npm run typecheck` → no errors. Run the full suite on the dedicated DB: `TEST_DATABASE_URL="$SDD" npx vitest run --no-file-parallelism`. Expected: all pass except the known skip. Report the exact counts.
- [ ] **Step 5:** `/security-review`. Required, because `classify.ts`, `capabilities.ts` and a migration changed.
- [ ] **Step 6:** A strict code review of the whole change (`/code-review` at high) — fix confirmed findings, re-run Step 4.
- [ ] **Step 7:** Leave everything uncommitted and report to the owner for approval.
