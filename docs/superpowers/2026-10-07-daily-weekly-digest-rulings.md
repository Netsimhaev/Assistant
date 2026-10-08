# SDD ledger — plan: docs/superpowers/plans/2026-10-07-daily-weekly-digest.md

Spec: docs/superpowers/specs/2026-10-07-daily-weekly-digest-design.md (read)
Branch: daily-weekly-digest (forked from main at 0112fb1; plan committed e217879)

## Pre-flight scan

### Pairs sharing a file or an interface

| From | To | Produced → consumed | Found |
|---|---|---|---|
| T1 | T2 | `DigestSettings`, `DigestSchedule` | agree |
| T1 | T6 | `loadDigestSettings` | agree |
| T1 | T7 | `loadDigestSettings`, `DIGEST_DEFAULTS` | agree |
| T1 | T5 | migration 040 creates `digests` | agree — T1 also adds both tables to the TRUNCATE list, so T5 needs no db.ts edit |
| T2 | T3 | `DigestWindow` | agree |
| T2 | T5 | `DigestKind`, `DigestWindow` | agree — one definition, in digest-window.ts |
| T2 | T6 | `dueWindow`, `DigestKind` | agree |
| T3 | T4 | `DigestFacts`, `DigestException`, `MAX_NAMED_EXCEPTIONS` | agree — cap exported so renderer and reader cannot disagree |
| T3 | T6 | `collectDigestFacts` | agree |
| T3 | T7 | `collectDigestFacts` | agree |
| T4 | T5 | `RenderedDigest` | agree |
| T4 | T6 | `renderDigest`; **T4's invariant file walks from `digest-run.ts`, which T6 creates** | CONFLICT — see R6 |
| T5 | T6 | `storeDigest`, `recordChannel`, `lastWindowEnd` | agree |
| T5 | T7 | `recentDigests`, `StoredDigest`, `ChannelState` | agree |
| T1 | T8 | `digests` table is T8's deletion target | agree |
| T5 | T8 | T8's tests need real stored rows | agree — `storeDigest` is exported |
| T3 | (whatsapp-report.ts) | T3 exports `isGateDenialCode`; no other task touches that file | agree |

### Each task against itself

| Task | Self-consistency | Found |
|---|---|---|
| T1 | tests ↔ code ↔ migration | agree |
| T2 | pure, no DB; tests ↔ code | agree |
| T3 | **eight column/config names asserted and not verified when the plan was written** | FIVE DEFECTS — R1–R5 |
| T4 | pure; tests ↔ code | agree, except the entry-file ordering (R6) |
| T5 | tests ↔ code ↔ 040 constraints | agree |
| T6 | prose steps, no full code block | acceptable — see R7 |
| T7 | `escLabel` exported (views.ts:78) ✓, `verifyCsrfToken` in csrf.ts ✓, `readFormBody` is private to server.ts and T7's route lives there ✓ | agree |
| T8 | both roles named; two separate mutations required | agree |

## Rulings, before Task 1

**R1 — `documents.rejected_reason` does not exist; the column is `documents.reason`.**
Verified in `012_documents.sql:41`. A query naming a column that is not there
throws rather than returning zero, so this would have failed loudly — but it
would have failed inside the one block whose whole purpose is to not be
silently empty. Plan corrected. Cost if wrong: none, the name is read from the
migration.

**R2 — `config.monthlyCeilingMinor` does not exist.** There is no money ceiling
in `src/config.ts` at all. The ceiling lives in the **signed charter**:
`CompiledCeilings.monthlyMinor` with `CompiledCeilings.currency`
(`domain/policy.ts:107-116`), which is what `policy/budget.ts:150` actually
enforces. Ruling: `collectDigestFacts` takes `ceilings: { monthlyMinor, currency }`
on its input and does **not** load the charter itself. Both callers already hold
the bundle (T6 and T7 each need the charter for the time zone), so this adds one
field and no new failure mode to a module that must stay read-only and
throw-free. Cost if wrong: the facts reader would have to load the charter,
which would make T7's live view 500 on a stale charter.

**R3 — the gate's "monthly" is a ROLLING 30 DAYS, not a calendar month.**
`spentInWindows` (`policy/budget.ts:26-33`) sums
`at >= now() - interval '30 days'`. The plan's SQL used `date_trunc('month', now())`.
This is the defect worth the most: the digest would print a spend figure
against a ceiling that is enforced over a different window, so the two numbers
on one line would not be comparable — and nothing on the screen would say so.
The owner cannot reconcile that and cannot see why. Ruling: use the gate's
window verbatim, and the Hebrew says "ב-30 הימים האחרונים", never "החודש".
Cost if wrong: a figure the owner trusts and that does not mean what it says.

**R4 — the `spend_ledger` test INSERT is wrong.** Real columns: `action_class`
(NOT NULL) and `currency` (NOT NULL); there is no `kind`, and `id` is BIGSERIAL.
Plan corrected.

**R5 — the `autonomy_events` test INSERT omits `event_id`** (TEXT PRIMARY KEY,
no default). Plan corrected. Production ids here are `` `AE-${ulid()}` ``
(`promote.ts:244`); the project-wide pattern is `` `XX-${ulid()}` `` and `ulid`
is a real dependency (`package.json:46`), so T5's `` `DG-${ulid()}` `` stands.

**R6 — T4's no-model invariant walks from a file T6 creates.** Ruling: T4 writes
the invariant pointed at `digest-render.ts` and T6 **moves it to `digest-run.ts`**;
T6's dispatch will carry this explicitly rather than relying on its own step
text. The invariant's second test (the walk really traverses more than the entry
file) is what keeps the intermediate state honest — a graph of one file would
pass the first test for the wrong reason. Cost if wrong: the strongest control
in the plan silently covers nothing.

**R7 — T6 is specified in prose, not as one code block, unlike T1-T5.** Kept
deliberately: its body is six ordered calls over interfaces every earlier task
defines exactly, and the decisions that matter (store before deliver, the
`hadContent` gate, per-channel recording, charter errors caught not thrown) are
each stated as a requirement with its reason. Writing it out would be
transcription of names already fixed elsewhere. Its four mutations are what
hold it, and two of them require writing a new test first.

**Exact interface T6 needs, which the plan states loosely:**
- `sendAlert(subject: string, body: string): Promise<{ ok: boolean; error?: string }>` (`runtime.ts:61`)
- `BossMessenger.send({ text: string; jobId: string | null }): Promise<{ ok: boolean; error?: string }>` (`whatsapp/messenger.ts:68-72`) — never takes a recipient, never throws.

**Verified and needing no change:** `jobs.phase` literals (`'understand'`,
`'await_approval'`, `'closed'`, `'failed'` all in `JobPhase`, `domain/job.ts:16-29`),
`jobs.closed_at`, `boss_instructions.answer`/`created_at`,
`approval_requests.decided_at` and the `'expired'` state,
`memories.created_at`, `document_readings.created_at`,
`job_step_results.performed` (migration 037), `util/money.ts#formatMinor`,
`util/bidi.ts#stripBidiControls`.

---

## Task 1: complete

Commit: f15939d — `src/db/migrations/040_digest.sql`, `src/governance/digest-settings.ts`,
`src/governance/digest-settings.test.ts`, `src/test/db.ts` (+249 lines, 4 files).
Tests: 4/4 green, re-run three times by the reviewer independently; typecheck clean.

Review: spec compliance ✅, quality ✅. Both verdicts given. No correctness or
compliance defects. The reviewer verified from the files on disk, not the diff —
including that the hour refusal is a real `CHECK` constraint and that
`digest-settings.ts` carries **no** application-side range check, so the
database is genuinely the enforcement layer rather than a TS guard in a DB
costume (spec §9's requirement).

**Step-order deviation, accepted.** The implementer wrote the three files in one
batch and never watched the literal `Cannot find module` red. What it got
instead was better evidence for this task's two real risks: the first run passed
4/4 **by luck** on a freshly-migrated empty table, and re-running the same file
reproduced the exact row-leak the brief warns about (`expected 'daily' to be
'off'`, a row surviving from the prior run) because `digest_settings`/`digests`
were missing from the TRUNCATE list. Both tables added; green twice after.
Ruling: sufficient. A missing module is the most self-evident failure mode in an
ESM project and is not the kind of thing that passes for the wrong reason,
whereas the row leak is — and it was caught by measurement, not assumption.

Step 7 mutation: `DIGEST_DEFAULTS.schedule` `'off'` → `'daily'` failed on the
named assertion (`digest-settings.test.ts:19`, `expect(settings.schedule).toBe('off')`),
plus collaterally on the isolation test from the same root cause. Restored, green.

Carried forward (not a defect, noted for the final review): the test named
"...without writing a row" asserts only the returned defaults and never queries
the table to prove no row was written. The claim is true by inspection
(`loadDigestSettings` is SELECT-only) and the name is verbatim from the brief,
but the name promises more than the assertions check.

Auto mode flagged the reviewer's hand-back as irreversible local destruction.
Verified by hand afterwards: working tree clean, one commit, exactly the four
expected files, nothing else touched. The flag was `resetDatabase()`'s TRUNCATE
against the **test** database — this project's documented test setup, which has
no in-memory alternative.

---

## Task 2: review round 1 — rulings

Commit 29d19db. Tests 8/8 (confirmed by me and independently by the reviewer,
who also reproduced mutation 1 and restored it). Both verdicts pass.

**Ruling: the implementer's deviation from the brief was correct, and the plan
was wrong.** The brief's `lastScheduledMoment` probed back 48 hours for a
matching hour, so at 07:30 with an 08:00 schedule it found *yesterday's* 08:00
and reported a window as due — contradicting two of the brief's own tests. I
hand-traced it and the reviewer traced it independently; both agree. The
replacement gates positively (`nowParts.hour < wantedHour`, plus weekday for
weekly) and bounds the probe to `now`'s own calendar day.

**R8 — the weekly-weekday narrowing is accepted, and must be written down.**
The reviewer found something the implementer did not report: the fix narrows
behaviour beyond the minimum. The brief's loop checked each *candidate's*
weekday across up to 8 days, so a weekly poll on a Wednesday could still find
last Sunday's missed window; the new same-day bound means a weekly can only
ever be found due **on its scheduled weekday**. Traced through: when it finally
fires, `start` is still the stale `lastSentEnd` and `covered` comes out 2, so
the gap is absorbed and nothing is lost — only delayed up to 7 days past
recovery. That is genuinely what the merge design is for, so the behaviour
stands. But it is a deliberate narrowing that nobody chose out loud, it is
absent from the docblock, and **none of the eight tests exercise it** — exactly
the shape this project insists be stated rather than inferred from a gate.
Fix round 1 documents it and tests both directions.

**R9 — the two DST resolutions are real ambiguities resolved implicitly.** The
reviewer measured both against `America/New_York`, not by reasoning: on
fall-back the backward probe finds the **later** occurrence of the repeated hour
(the right one — most recently elapsed), and on spring-forward through the
scheduled hour it returns `null` for that day and resolves normally the next,
with the skip absorbed into a later `windowsCovered`. Both outcomes are correct.
Neither is said anywhere. Same remedy as R8.

**R10 — Finding 4 is a real latent bug and I am fixing it now, though it is out
of the brief's scope.** The "truncate to the top of the hour" line does
`candidate.getTime() - candidate.getTime() % 3600_000` — arithmetic on raw epoch
milliseconds, which coincides with local-hour truncation **only in whole-hour
offset zones**. In `Asia/Kolkata` (UTC+5:30) it lands half an hour off the hour
it just matched. This line is byte-identical to the brief's reference code, so it
is my defect and not the implementer's. Fixing rather than recording it, for
three reasons: it is three lines; the time zone comes from the **charter**, which
validates any resolvable IANA zone, so a half-hour zone is reachable by
configuration rather than hypothetical; and the failure is the same class as R3 —
a window boundary that silently disagrees with the hour the owner chose. The
product being Israel-only today is why it is inert, not why it is acceptable.

**Finding 5, no action:** the `back <= 25` bound and the per-iteration `ymd`
check are not redundant. The `ymd` check is what makes the spring-forward skip
terminate at `null` instead of drifting into the previous day; the 25 is the
backstop for a fall-back day spanning 25 wall-clock hours. Neither is dead code.

---

## Task 2: complete

Commits: 29d19db (implementation) + bd46372 (fix round 1).
Tests: 12/12 green. Typecheck clean.

Fix round 1 — all three items ADDRESSED, each confirmed by a mutation the
re-reviewer ran itself and restored:
- weekday gate removed → only the non-scheduled-weekday test failed, on its own
  assertion, with a real value (`windowsCovered: 3` where `null` was expected).
- `ymd` guard removed → only the spring-forward test failed, with a window
  ending `2026-03-07T07:00:00.000Z` where `null` was expected.
- old epoch-modulo truncation restored → only the Kolkata test failed, exactly
  30 minutes off (`02:00:00.000Z` vs `02:30:00.000Z`).
All three were value mismatches, not type errors. `git status`/`git diff` clean
afterwards; no scope creep; the module's only import is still `import type`, so
it still has no database access and no I/O.

**The implementer caught its own vacuous test, and this is the part worth
keeping.** Its first spring-forward test used `now = 2026-03-08T12:00:00Z` and
passed — but passed for the wrong reason: with `ymd` removed the loop's 25-hour
bound still could not reach the previous day's 2am from that `now`, so the test
held with and without the code it claimed to cover. It found this by actually
running the mutation instead of trusting the green, moved `now` to
`2026-03-08T07:30:00Z` so the previous day sits inside the bound, and
re-confirmed. This is precisely the failure the plan's "a mutation that fails
for a mechanical reason is not evidence" rule exists to catch, and it was caught
by measurement rather than by review.

---

## Environment conflict: the full-suite baseline is blocked, per-task verification is not

Three full-suite runs produced three different reds, and none of them is a
regression in this branch's work:

1. `deadlock detected` on `resetDatabase`'s `TRUNCATE` — two concurrent suites.
2. `expected 40, got 36` in `whatsapp/transcribe.test.ts` — a concurrent
   `resetDatabase()` truncated `audit_log` partway through that test's seeding
   loop, so it counted its own rows after some had been wiped.
3. `relation "memories" does not exist`, 187 failures across 49 files — tables
   vanishing **mid-run**, i.e. concurrent DDL.

The third is the one that is not the documented TRUNCATE collision. I inspected
the database afterwards: **38 tables present, `memories` among them, migrations
applied through `040_digest.sql`** — intact. So the tables were dropped and
recreated while the suite was running. `src/db/migrate.ts` contains no `DROP`
and `package.json` has no reset script, so that DDL did not come from this
project's own tooling. `ListAgents` shows one peer: `claude-d5`, interactive,
busy, running for an hour — the only other actor with access to
`assistant_test`.

**Ruling: do not re-run the full suite while that session is busy.** A fourth
run would most likely collide again and cost seven minutes to produce another
untrustworthy red, and a red that is caused by something other than the code is
worse than no red — it trains the reader to discount the signal. What the SDD
loop actually gates on is per-task verification, and that is green and
independently reproduced: Task 1 4/4, Task 2 12/12, both re-run by a second
agent, with every mutation traced to its named assertion. Total test count moved
2268 → 2284, which is exactly +4 +12 and confirms nothing was lost.

Subscribed to that session's idle notice (`notify_when_idle`, no message — it
costs that session nothing) and will take the full-suite baseline then. The
baseline is genuinely required before the branch merges, not before each task.

---

## Task 3: review round 1 — rulings

Commit e53c9bc. Tests 9/9; whatsapp-report 24/24 unchanged; typecheck clean.
Verdict A compliant. Verdict B found **two real defects, both inherited from my
plan rather than introduced by the implementer**, and I confirmed both from
source before ruling.

**R11 — [HIGH] the expired-approval branch matched zero rows forever.** It
windowed on `decided_at`, but `expireOverdue`
(`src/governance/approvals.ts:403-415`) sets `state = 'expired'` and **nothing
else** — I read it. And this is permanent by design, not an oversight to patch
around: migration 001's `approval_decision_is_complete` CHECK explicitly carves
`'expired'`/`'cancelled'` out of the clause that requires
`decided_by`/`decided_at`/`input_hash_at_decision`. So the owner would never
once have seen a named expired approval, while `expireOverdue` runs every
scheduler pass. This is exactly the "a query that silently matches nothing"
outcome the brief named as the worst possible one here — and it survived nine
passing tests, because no test seeded an expired row.
**Fix: window on `expires_at`.** Not `created_at`, which is when the card was
raised rather than when the fuse ran out. **And the choice has a dependency
worth stating:** an approval whose fuse runs out just before a window closes is
only `'expired'` after a sweep, so windowing on `expires_at` is reliable only
because `expireOverdue` runs in `tick()` and the digest runs **last in the same
pass**, after it. That is a second, independent reason for the ordering Task 6
already requires, and Task 6's dispatch will carry it.

**R12 — [MEDIUM-HIGH] gate denials were being reported as plain failures.**
`reasonInHebrew` called `isGateDenialCode(rawReason)` on the whole
`` `${code} — ${message}` `` string. The production pattern is to extract the
code first (`leadingCode`, then `isGateDenialCode` on the bare code), because
`execute.ts` always writes the reason with the dash. The three prefix-matched
codes still worked by accident; every **exact-match** member of
`GATE_DENY_CODES` did not — including `draft_only:persist_as_draft`, which
CLAUDE.md calls the commonest reason of all while every action class sits at
`draft_only`. So the dominant real case rendered as "the attempt failed"
instead of "this needs permission I do not have yet". The spec is explicit that
this distinction "אינו מוכרע כאן מחדש" — decided once in `whatsapp-report.ts`,
never re-decided here — and the code silently re-decided it and got it wrong.
`leadingCode` is not currently exported (`whatsapp-report.ts:327`); the fix
exports it and uses it. My plan's Step 4 draft contained this bug verbatim.

**R13 — [LOW] a stray comment in the test file states the opposite of the
truth** — it claims `jobs.charter_version` has a single-column FK, contradicting
both migration 002 and a correct comment a few lines below it. The test code is
right; only the comment is wrong. Fixed rather than left, because a comment that
claims a property the code does not have is a defect class this project has
documented four times, and three of the four were caught by reading rather than
running.

**R14 — the `messagesSent` observation is being fixed, not just noted.** It
windowed on the **job's** `closed_at`, so a message was attributed to whichever
window its job later closed in, and was not counted at all until the job reached
a terminal phase. `job_step_results.completed_at` exists
(`004_plan_resumption.sql:50`, NOT NULL DEFAULT now()) — I checked — so the step
can be windowed on its own timestamp, which is both more truthful and simpler.
The double-report the reviewer noted (a step that really sent, inside a job that
later failed, appears in the count *and* its job is named in exceptions) stands
deliberately: that is one true fact reported twice, not a failure disguised as a
success.

**R15 — the four untested branches get seed tests, all four.** The reviewer read
each against production and judged `openQuestions` correct (byte-equivalent to
`pendingQuestions` in `governance/instructions.ts`), `deferred` correct and a
genuinely producible state (same predicate as `pendingApprovalForJob`, the one
`whatsapp-report.ts` uses to decide `'defer'`), the rejected-document branch
correct against migration 012, and the expired branch wrong (R11). Tests are
still required for all four: three were correct by inspection only, and
inspection is what missed R11 in the first place.

---

## Full-suite baseline, taken serially on a quiet machine

`npm test` → **171 files, 2297 passed, 1 skipped (2298)**, 333s. Zero failures.

Arithmetic confirms nothing was lost or double-counted: CLAUDE.md recorded 2268
before this branch (2267 passing, 1 skipped); 4 + 12 + 14 new tests = +30, and
2268 + 30 = 2298 exactly.

This is the run that counts. The three earlier reds — a `TRUNCATE` deadlock, a
`expected 40, got 36` row count, and 187 failures from tables vanishing mid-run —
were all concurrency against the shared test database, two of them from the
end-of-turn hook racing a subagent's own single-file run and one from DDL by the
peer session. I took this one with the peer session idle and no subagents live.

**Structural note for anyone running this loop again here:** the end-of-turn
hook runs the *full* suite, and every implementer and reviewer runs tests of its
own, so the two collide at essentially every turn boundary. Those reds carry no
information about the code. The informative signals are the per-task runs and a
serial baseline like this one.

---

## Task 3: complete

Commits: e53c9bc (implementation) + df8078d (fix round 1) + 82c1dd1 (fix round 2).
Tests: 15/15 in `digest-facts.test.ts`; `whatsapp-report.test.ts` 24/24 unmodified;
typecheck clean. Scoped re-review: all six items ADDRESSED, no defects, no scope
creep (`digest-facts.ts` byte-identical between the two fix commits — round 2
touched only the test file, as claimed).

Three reproductions run by the re-reviewer and restored:
- expired-approval query reverted to `decided_at` → `expected [] to have a length
  of 1 but got +0`, the "matches nothing" failure itself.
- `reasonInHebrew` reverted to testing the raw string → the generic failure
  sentence came back where `NOT_PERMITTED_TEXT` was expected.
- `messagesSent` reverted to the `jobs`/`closed_at` join → `expected +0 to be 1`.

**The check that mattered most, and it was not about the query.** R11's fix is
only real if its test seeds the state `expireOverdue` actually produces. A test
that set `decided_at` to make itself pass would have left the branch untested
against reality while looking covered — the same shape as the original defect,
one layer up. The re-reviewer confirmed the seed INSERT omits `decided_at` from
its column list entirely, so it is genuinely NULL. Asked for specifically
because a fix verified by a fictional fixture is not a fix.

One test-seed correction found during the round: `boss_instructions.text_origin`
is NOT NULL with no default (migration 039), so the `openQuestions` seed threw
until it was supplied. That is the fourth such correction on this task — the
plan's hand-written INSERTs were consistently short of NOT NULL columns, and
`jobs.charter_version`'s composite FK to `charter_versions` means every future
test in this area must seed a charter per business rather than insert a job
directly.

---

## Task 4: review round 1 — rulings

Commit f955e8e. 11 tests, typecheck clean. Verdict A pass, no scope creep.
Verdict B found **two surviving decorative assertions**, each proven by breaking
the covered code and showing the test still passed — not argued, demonstrated.

**R16 — [HIGH] `toContain('7')` was satisfied by the date header.** The "counts
successes and names each exception" test used the default window ending
`2026-10-07`, whose header renders `07.10`, so the digit `'7'` is present
whether `done.jobsCompleted` renders or not. Proven by replacing the
jobsCompleted branch with `if (false)`: still green. A regression dropping the
completed-count line from "what was done" would ship in silence. Fix: assert
`'7 משימות'`.

**R17 — [MEDIUM] the Latin-prose test erased the thing it was looking for.**
It did `body.replace(/[a-z_.]+/g, '')` and then checked `/[A-Za-z]/`. The strip
removes **lowercase** ASCII; the check looks for **both** cases. So any genuine
lowercase English leak is deleted before the assertion sees it. Proven by
injecting `'debug trace leaked here'` into the rendered body: still green. And
the fixture carries no `permissionChanges`, so the test never exercised the half
of its own premise that identifiers like `email.reply` are *allowed* to appear.
**Ruling: fix both halves, not one.** Strip only tokens shaped like an
identifier — requiring an internal `.` or `_` separator — so `email.reply` is
exempt while a bare English word is not, and put a real `permissionChanges`
entry in the fixture so the exemption is actually exercised. Tightening the
regex alone would leave a test that still never sees an identifier; adding the
entry alone would leave prose being swallowed.

**The pattern, recorded because it is now four and not one.** Every decorative
test on this branch came from my plan, and all four were substring assertions on
short strings: Task 2's spring-forward test (passed with the `ymd` guard
removed), Task 4's cap test (`toContain('3')`, satisfied by the shown item
`משימה 3`), and R16/R17 above. Three were caught only because someone ran the
mutation and noticed it did not land; one was caught by a reviewer injecting a
string. **Writing `toContain('<short string>')` in a plan is how a decorative
test gets shipped here** — the assertion must name something that only the
feature under test can produce (`'ועוד 3'`, `'7 משימות'`), and the mutation is
the only thing that proves it.

Checked and sound, so not touched: the ordering test's `indexOf('7')` (the
reviewer dumped the real body — `'ממתין'` at 26, the done-section `'7'` at 103,
no collision with `'שממתינות'`, which uses a non-final nun); the period test's
`'06'`/`'07'` (the cost line is suppressed at zero, so the header is the only
source); and the gap test's `'3'` (dates format as `04.10`/`07.10`, no competing
digit).

**The no-model invariant is genuine, and its safety net was itself tested.** The
reviewer re-implemented the walk standalone: 29 files reached, zero under
`src/sdk/`, with real multi-hop paths. Then it broke `resolveFrom` to return
`null` always — the primary test passed **vacuously** (reached set of one, so no
offenders) while the "really traverses more than the entry file" test failed
`expected 1 to be greater than 5`. That is exactly why the second test exists.

---

## Task 4: complete

Commits: f955e8e (implementation) + b57aaab (fix round 1). 11 tests; typecheck clean.

Fix round verified by me rather than by a dispatched re-reviewer: the diff is
two assertions and one fixture line in a test file, `digest-render.ts` came out
**byte-identical** (`git diff` zero lines), and the implementer proved item 2 in
**both** directions as required — a leak must fail, and the allowed identifier
case must still pass. Strictness that rejects legitimate output is not a fix,
and only the second direction shows it does not. Confirmed myself:
`toContain('7')` → `toContain('7 משימות')`, the regex now
`/[a-z]+(?:[._][a-z]+)+/g` so only `.`/`_`-separated identifier-shaped tokens
are stripped, `permissionChanges: [{ subject: 'email.reply', … }]` present in
the fixture, 11/11 green.

A review seat was not spent here deliberately. The gate exists to catch what I
cannot see from a diff; a test-only change with bidirectional proof and an
unchanged implementation is not that.

---

## Task 5: implemented; one ruling

Commit b058d32. 5/5 tests; typecheck clean. Both mutations landed on their named
assertions (`body: ''` → the verbatim test failed on the body comparison;
`rowCount !== 1` → `rowCount < 0` → the throw test failed with "promise resolved
undefined instead of rejecting"). No test INSERT needed correcting — this file
never hand-writes a row, it only calls the module's own functions, so the
NOT NULL trap that bit the other tasks four times did not arise. All nine
assertions are exact matchers (`toBe`/`toEqual`/`toHaveLength`/`toBeNull`), no
`toContain` anywhere, so none of this task's tests can pass for the wrong reason
the way four of my plan's did.

**R18 — `digests.screen_at` is removed, and the implementer is the one who
spotted it.** I verified the claim: the column appears in exactly two places in
the repository — migration 040 that creates it, and the INSERT that writes
`now()` into it. Never selected, absent from `StoredDigest`, and the design spec
does not mention it at all. Since it is written unconditionally at insert it
also just duplicates `created_at`.

That is a column with no reader — the most-repeated defect class in this
codebase, with five prior instances enumerated in CLAUDE.md and invariant tests
written specifically to catch the shape. My plan invented a sixth. And it is
worse than dead weight: a nullable timestamp called `screen_at` invites the next
reader to believe it records **when the owner saw the digest**, which nothing
here knows.

Removed via a **new migration 041**, never an edit to 040: the runner tracks by
filename, so editing in place would leave both my dev and test databases
silently disagreeing with the file — the project already carries migration 020
solely because 019 could not be edited to turn a `CASCADE` into a `RESTRICT`.
The plan file is annotated rather than silently cleaned, so it stays an honest
record of what was planned while warning the next reader off re-adding it.

---

## Task 5: review round 1 — ruling

Commits b058d32 + 1baa435. 5/5; typecheck clean. Verdict A exact match, no
scope creep; the 041 migration confirmed to drop only `screen_at`, with 040
untouched and no constraint or index referencing it. The reviewer verified the
decisive claim — that all five tests passed **unmodified** after the drop, which
is what actually proves the column was unread.

The reviewer also went past its brief in a useful direction: it checked whether
the per-kind test proves isolation in **both** directions, by dropping
`AND kind = $2` from `lastWindowEnd`. It does — `lastWindowEnd('weekly')` then
returned the daily row's timestamp where `null` was expected. Good, because a
leak between kinds would make Task 6 send or suppress the wrong digest.

**R19 — the business-id filters on `recordChannel` and `lastWindowEnd` have no
test, and I am not accepting the reviewer's "approve as-is".** It dropped
`AND business_id = $2` from `recordChannel`'s `UPDATE` and **all five tests
still passed**, because no test ever calls `recordChannel` with a business other
than the one that stored the row. The code is correct today; what is missing is
the guard against it ceasing to be.

The reviewer rated this low and recommended deferring. I am overruling that, for
a reason this repo has already written down: CLAUDE.md's credential-store
section records that the business filter's real failure mode is a **miss, not a
leak**, that omitting it there failed **no** test, and that the fix was a test
writing two businesses under the same key — "two mutations that fail two
separate tests are the proof of independence; two that fail the same test prove
the opposite." That is this situation precisely, one table over. The cost is two
small tests, and Task 6 is the caller that will exercise `recordChannel` in
production — a refactor there is exactly when an unguarded filter gets dropped.

---

## Task 5: complete

Commits: b058d32 + 1baa435 (drop `screen_at`) + 5e6e78c (isolation guards).
7/7 tests; typecheck clean; `digest-store.ts` byte-identical across the last
round — verified by me, not only reported.

The two new mutations failed **two different tests**, which is the whole point:
`recordChannel`'s dropped `business_id` failed only the recordChannel guard, and
`lastWindowEnd`'s failed only its own, while the four pre-existing tests that
never leave `BUSINESS` stayed green under both. Independent guards, not two
tests tripping on one bug.

And for the third time on this branch an agent caught its own mutation failing
**mechanically** rather than behaviourally — here a dropped `AND business_id = $2`
left `$2` unreferenced, so Postgres raised "could not determine data type of
parameter $2" instead of exercising the assertion. It renumbered the parameters
to make the mutation behavioural before accepting it as evidence. That reflex is
what has made the mutation checks on this branch worth anything.

---

## Task 6: review round 1 — rulings

Commit 936f0bd. 23/23 across four files; typecheck clean; invariant walk
independently re-measured at **37 files, zero `src/sdk` offenders**. Verdict A
pass. Verdict B found five items, three of them by the reviewer's own mutation
testing beyond the four the implementer ran.

**R20 — deviation (a) accepted.** `DigestRunResult.sent` must mean "every window
stored this pass", not "every window delivered somewhere": the brief's own test 6
enables neither channel, seeds no content, and still expects both kinds in
`sent`. Only that reading satisfies it. The implementer reasoned this out and the
reviewer reached the same conclusion independently from the test text.

**R21 — [HIGH] `SchedulerPassResult.digest` — the literal deliverable of the
scheduler step — has no test.** The reviewer hard-coded `digest: null` in the
return object, left the `runDigests` call and the database write untouched, and
**all 23 tests still passed**. Nothing anywhere reads `pass.digest`; the one
integration test checks the row via `recentDigests` instead. So a regression
dropping the field would ship green — against a field whose entire purpose is the
distinction its own docblock insists on, that `null` is not an empty-looking
result. Fixing.

**R22 — [HIGH, and the worst thing found on this branch] `logErrored` has no
branch for `digest`.** `scheduler-log.ts` prints a line for every other error
bucket — `scanError`, `whatsappError`, `autonomyError`, `due.errored`,
`verified.errored`, `delegated.errored` — and `run-scheduler.ts` wires
`logErrored` as the **only** reporting path in production. So an installation
with the digest switched on and a charter that cannot be parsed fails on every
pass, forever, and prints **nothing**. That is precisely the silent-failure shape
this project is built to refuse, and it is the same class as the two the
WhatsApp branch closed (an alert keyed so a duplicate was swallowed; a bridge
warning that looked identical to "nothing to send"). My plan never mentioned
`scheduler-log.ts`, so the task could not have closed it. Fixing, and the file is
in scope for the written reason that Task 6 is what created the gap.

**R23 — [MEDIUM] nothing exercises a successful send.** Every test with a channel
enabled either has `hadContent: false` or supplies a failing or throwing
`sendAlert`, so `'sent'` is never written and a mutation that always recorded
`'failed'` would pass. That is the happy path of the entire delivery half.
Fixing.

**R24 — [MEDIUM] `sent` is renamed to `produced`.** Under R20's semantics an
empty window sits in `sent` *and* in `screenOnly`, so a field called `sent`
reports a digest that went nowhere but the screen. Nothing consumes it yet
(grep-confirmed across `src/`), which makes now the only free moment to rename
it. This project has been bitten by exactly this — a field whose name promises
more than it holds — often enough to pay a rename.

**R25 — my own stated reasoning was imprecise, and the record is corrected.**
I told the implementer that the expired-approval branch windowing on
`expires_at` was a "second independent reason the digest must run last". The
reviewer is right that it only requires running **after `tick()`**, not dead
last. What the dead-last position actually buys is **point-in-time correctness**:
`waiting.*` reflects end-of-pass state, so an approval raised earlier in the same
pass is visible immediately instead of a full scheduler interval later. The
implementer had already reached this and pivoted its mutation test to
`waiting.approvals` for it. Also confirmed: same-pass **window-scoped** counting
is structurally impossible, because `dueWindow`'s `end` is always ≤ `now`, so
anything stamped with live `now()` during the pass falls after the window closed.
Any comment asserting my looser version must be corrected to this.

**Checked and sound:** (c) the time zone comes from `charter.identity.timezone`,
a required validated field, not from the nullable `bundle.quietHours` — the
implementer's choice was right, and a charter with no quiet hours still
schedules. Scope is exactly six files. The duplicate `loadDigestSettings` per
pass is one extra single-row `SELECT` and consistent with the existing
`config.documentInbox` switch check — not worth restructuring. The stale-charter
catch was verified **live** by the reviewer seeding a charter with
`schemaVersion: '0'` and confirming `errored` came back rather than a throw.

---

## Task 6: complete

Commits: 936f0bd (implementation) + e91a48d (fix round 1). 33 tests across five
files; typecheck clean; invariant walk 37 files from `digest-run.ts`, zero
`src/sdk` offenders. Scoped re-review: all five items ADDRESSED, no findings, no
scope creep, tree clean.

Two things the re-reviewer did beyond its brief, both worth keeping:

It **mutated the WhatsApp send branch the implementer had explicitly declined to
mutate** (on the reasonable-sounding grounds that it is structurally identical to
the email branch and reachable only through its own test) — and confirmed it
fails correctly. "Structurally identical to something I did test" is an argument,
not evidence, and this branch has now produced four tests that asserted nothing
despite similar-sounding arguments.

And it checked item 5's corrected comment for **truth, not just for change**. It
opened `digest-window.ts` and traced `lastScheduledMoment` to confirm
`end <= candidate <= now` holds structurally, which is what the whole claim
rests on. That mattered: a comment I had already got wrong once, rewritten and
still wrong, would have been the fifth instance of the defect class CLAUDE.md
documents four times. It is true.

R22's fix verified the way it needed to be: the new `logErrored` branch guards
`digest !== null` **before** touching `.errored`, so an installation with the
schedule off cannot crash the only production reporting path — which would have
been strictly worse than the silence it replaced. The message string
`digest failed: ` was grepped across `src/` and appears only in that line and its
test, so no other bucket's output could satisfy the assertion.

---

## Task 7: review round 1 — rulings

Commit 86e5308. 121/121 across the two touched files; typecheck clean. Verdict A
pass, no scope creep. **No decorative assertions found** — the first task in this
plan where that audit came back clean, and the reviewer earned the result: it
read the whole rendered template looking for phrase overlap, and it checked that
mutation 1's *second* assertion is not masked by the first one short-circuiting
(it is not — the bidi override genuinely survives the mutation too). The
implementer had also anticipated one real overlap itself, asserting the nav test
on `href="/digest"` rather than on the label text, because "מה קרה" also appears
unlinked in the live-view heading.

**R26 — [HIGH] `GET /digest` 500s on a fresh installation, and the house pattern
for this is three hundred lines up the same file.** `handleDigestGet` calls
`loadActiveCharter` and converts `active === null` into a synthetic throw — but
`null` is not the stale-schema case, it is **"no charter signed yet"**, the
ordinary state of a brand-new install. `handleConnections` already handles
exactly this and says why in its own docblock: *showing the owner a 500 when the
real problem is an unreadable charter is strictly worse than the truth.* So an
owner on a fresh install clicks the nav link **this task just added** and gets an
opaque 500 instead of a usable screen.

The implementer's refusal to widen `probeActiveCharter` was right — its docblock
names three permitted callers and says nothing else may — but that was never the
only option, and the brief said so: catch locally, which widens nothing. Neither
`recentDigests` nor `loadDigestSettings` needs the charter; **only the live
preview does.** So the history and the settings form must still render, with one
Hebrew line explaining the preview is unavailable.

**R27 — [MEDIUM] the live preview shows a weekly-only owner a daily digest.**
The window kind is hard-coded `'daily'` and the renderer labels it
`'תדריך יומי'`, so someone who chose weekly is previewing a period and a title he
will never receive. Harmless to data — nothing is stored or sent — but this
screen's entire reason for existing is that the owner can tell what he was told
from what he merely might be, and a mislabelled preview spends that credibility.
Ruling: preview the kind his schedule actually includes (daily when it includes
daily, weekly when weekly-only), and under `off` keep the daily shape but say in
Hebrew that it is an example of what he would receive.

**R28 — [MEDIUM] `lastHourBoundary` is a second owner of the DST rule, and I am
not deferring it.** To the implementer's credit the helper is **not** the naive
mistake: the reviewer compared it line by line against `lastScheduledMoment` and
confirmed it probes via `Intl` rather than doing UTC-offset arithmetic, and
truncates using the zone's own reported minute and second rather than
`% 3_600_000` — both of the hard-won fixes, carried over correctly. But it is a
duplicate of a rule this codebase keeps in one place, with **zero DST tests of
its own**, and the reviewer's own verdict was "should not be left as-is
indefinitely" — which in practice means never. Ruling: export the Intl
probe-and-truncate primitive from `digest-window.ts` and reuse it. That file has
12 tests covering the fall-back, spring-forward and half-hour-zone cases; the
screen should inherit them rather than re-derive them.

**R29 — [LOW, but it is this project's own named bug class] a missing numeric
form field coerces to `0`.** `z.coerce.number().int()` parses `null` as a
successful `0`, so a POST missing `dailyHour` is accepted as midnight instead of
refused. Only reachable by a hand-built request, since the form is
`<select>`-driven — but "a value we could not read is not a permitting value" is
a rule this codebase states in those words and enforces in five other places
(`amount_unreadable`, unknown data class, unknown calendar action, unresolved
time zone, unparseable redaction pattern). Silent "missing → valid midnight" is
that bug, small. Fixing.

Noted, no action: the implementer's report said `views.ts` has "exactly two
multi-link nav strings"; the reviewer found three other single-link `<p><a>`
lines elsewhere in the file. Loose prose, not a code defect — the two navigation
bars that matter both got the link, with a test.

---

## Task 7: fix round 1 landed — verified by me, and one report error caught

Commit ae8fedd. I ran the three affected files **serially myself**: 139 passed,
clean, zero failures (`server.test.ts` + `digest-view.test.ts` +
`digest-window.test.ts`), 25s.

**That run was necessary rather than ceremonial.** The implementer reported
honestly that it could never capture a clean combined `server.test.ts` run —
roughly fifteen attempts, each hitting one of the three documented collision
signatures — and had verified only isolated `-t` filtered runs of the ten digest
cases. It was right not to claim more than it had. Nothing of mine was running,
so I closed the gap it could not.

**And the run caught an error in its report.** It stated
`digest-view.test.ts: 20/20 (8 prior + 12 new)`. The file contains **8** tests;
I counted the `it(` declarations and listed them. The work is all present —
item 1's two new cases are there by name ("says plainly that no charter has been
signed yet, and still renders the form" and "...that the charter cannot be read,
with text distinct from 'none yet'") — and items 2 and 4's tests went into
`server.test.ts`, which moved 115 → 121. So this is a counting error, not
missing coverage. Recorded anyway: an inflated test count in a report is exactly
the kind of claim that, once trusted, makes a later reader believe coverage
exists that does not, and it was only visible because I ran the file instead of
reading the number.

---

## Task 7: complete

Commits: 86e5308 (implementation) + ae8fedd (fix round 1). Verified serially by
me: 139 passed across the three affected files. Scoped re-review: all four items
correctly addressed, no findings, no scope creep, tree clean.

Item 3 got the scrutiny it needed, because it refactored DST logic that was
already correct. Confirmed: `lastHourInstant` still probes via `Intl` rather
than UTC-offset arithmetic, still truncates using the zone's own reported
minute/second/sub-second rather than `% 3_600_000`, keeps the 25-hour bound, and
contains **no** `ymd` or weekday logic — the day-gates stayed in
`lastScheduledMoment`, which is the deliberate difference. And the re-reviewer
proved the refactor additive the right way: it checked the diff's file list and
`git log` to confirm `digest-window.test.ts` was **not touched**, because an
"additive" refactor that quietly adjusts a test is not additive. 12/12 unchanged.

Item 1 confirmed `probeActiveCharter` was not used, by reading its docblock and
grepping its callers — the three permitted ones are the install path, the
readiness report and `/connections`, and the digest route is not among them. The
fix catches locally instead, and "no charter yet" and "cannot be read" render as
two different Hebrew messages, because they are two different facts.

Item 2's test turned out to need the care it got: the settings `<select>` renders
**all four** option labels regardless of selection, including the bare word
`'יומי'`, so asserting on the bare word would have been decorative. The test
targets the two-word `'תדריך שבועי'`, which only the preview heading produces.

**Two reported test counts were wrong, and both were caught by running rather
than reading.** The report claimed `digest-view.test.ts` at 20/20; it has 8. It
implied 14 in `server.test.ts`'s digest block; there are 10. I found the first
myself and the re-reviewer independently found both. No coverage is missing —
every item's test exists and was located by name — but a count nobody checks is
how a later reader comes to believe in coverage that was never there.

---

## Task 8: complete

Commits: a555867 + 82d06f1. 83/83 across the four erasure files (counts verified
by `it(` declaration, not estimated); typecheck clean. Verdict A pass, Verdict B
strong pass, nothing blocking.

**Both roles are independently covered, and this was reproduced rather than
accepted.** The reviewer ran both mutations itself: removing the discovery query
failed the two `erasure-plan.test.ts` digest tests while all 20
`erasure.test.ts` tests kept passing; removing `digests` from the executor
failed the invariants sweep on a surviving `digests.body` probe while the
discovery tests were unaffected. Two mutations, two different failures — which is
the only thing that tells genuine independence apart from two tests tripping over
one bug, and the reason this task existed: `job_plans` and `job_authorizations`
were each wired to one half only.

**The implementer caught a fifth decorative test in my plan, unprompted.** The
brief's stubs seeded a single digest row, so they would have passed under an
unselective "match every digest" predicate. It added decoy rows; the reviewer
then broke the predicate to match everything and confirmed both tests fail on the
exact-array assertion. Presence proven, and selectivity too.

**Three errors of the same kind in this one exchange, two of them mine.** Worth
recording together, because it is the defect class CLAUDE.md already enumerates
four times — citing an artifact without opening the right one:

1. **Mine.** I told the reviewer the implementer had extracted `LIKE_ESCAPE` and
   applied it to the pre-existing `approval_requests` and `whatsapp_messages`
   predicates, and asked it to verify that refactor was behaviour-preserving. It
   is not in this diff at all. I had grepped `ESCAPE` on the **current file** and
   inferred authorship from the result; commits `f50013b` and `25491f1` both
   predate Task 8's base. The implementer correctly *reused* a constant that was
   already there.
2. **Mine.** I claimed `docs/10-user-settings.md` has a convention of no paths,
   identifiers or commands. It does not — that rule belongs to
   `docs/חיבור יומן -לקוח.md`, the one document written for the end client, and
   CLAUDE.md's doc map says so. Sections 1-2 of the settings file already carry
   identifiers and commands. Section 3 happens to contain none anyway.
3. **The reviewer's.** Its one new finding was that `erasure-plan.ts`'s docblock
   enumerates ten `digests` columns and says "nothing else", while migration 040
   defines an eleventh, `screen_at`. I checked: **migration 041 drops it**, and
   the live schema has exactly those ten columns. It read 040 and stopped instead
   of following the chain. The docblock is accurate; no fix needed.

Three readers, one failure mode, caught only because each was checked against the
source rather than taken at its word. Nothing was broken by any of them — but my
first error sent a reviewer to audit a refactor that did not exist, and the
third nearly produced a "fix" to a correct comment.

---

## Final whole-branch review — rulings

Full suite reproduced independently by the reviewer: **176 files, 2350 passed,
1 skipped, zero failures**, identical to mine. It counted 83 new tests and
reconciled them exactly against 2351 − 2268.

**Correction to this ledger, which the reviewer caught:** I recorded Task 4 as
"11 tests / 11/11 green". `digest-render.test.ts` has **9** — I counted the `it(`
declarations myself to confirm. That is the third overstated count on this
branch and the second one that was mine. No coverage is missing; every named
test exists.

Verdict: merge-ready on correctness, safety and structure — the money figure
genuinely matches the gate, the no-model boundary is transitively real, erasure
is wired in both roles, degradation is honest. **But eleven findings, clustered
in the text the owner reads**, which is the one place this feature cannot afford
to be approximately right: its whole premise is that every number is measured
rather than written. Findings 1-3 are each a seam defect — correct on both sides
of a task boundary, wrong where they meet, which is exactly what per-task review
cannot see.

All eleven accepted for one fix round. The three I verified from source myself
before ruling:

**R30 — [MEDIUM] the digest states its period in the PROCESS's time zone.**
`day()` in `digest-render.ts:17` calls `Intl.DateTimeFormat('he-IL', …)` with
**no `timeZone`**, while every boundary it formats was computed in the charter's
zone. `DigestFacts` carries no zone for it to use. Spec §4 legislates precisely
this and says why: two separate notions of time will drift, and the owner finds
out the day the clock moves. Measured, not reasoned: the same instant renders
`07.10` under `Asia/Jerusalem` and `06.10` under `UTC`. Reachable on any
container or VPS defaulting to UTC with an early `dailyHour`. No test catches it
because every fixture uses 08:00, where the two zones agree on the date, and
this machine's process zone happens to be Jerusalem. **Second site, same class:**
`digest-view.ts`'s `shortDate` slices `timestamptz::text`, which Postgres renders
in the **database session's** zone — its docblock claims it needs no zone; in
fact it silently inherits the server's. Three zone sources for one set of
instants, two of them implicit.

**R31 — [MEDIUM] every stored card claims it was sent.** `digest-view.ts:122`
prints `· נשלח ב-` unconditionally from `created_at`, the write moment. **Both
channels are off by default**, so in the default configuration every row reads
"sent at…" while nothing left the machine — and an empty window reads the same.
Directly against spec §6, the rule that "not sent" and "nothing to send" must
not look alike. Worse, the empty state two lines above says "no digest has been
sent yet", so the owner has already been taught that this wording means
delivery. The honest word is "נוצר".

**R32 — [MEDIUM] the gap sentence overstates by exactly one, always.**
`digest-render.ts:47` prints `windowsCovered` as the number of digests that
failed to go out, but that field counts the windows this digest **absorbs**,
including the one now going out. A one-day outage is reported as two missed
digests. Spec §5 requires the merged digest to declare its gap; the declaration's
only number is wrong. The tests assert the field and the digit, never the
sentence's claim.

Also accepted, in the same round: the "+N not listed" undercount and the
crowding-out of two exception sources by a third (4); refused jobs counted as
completed (5); the weekly preview spanning hours under a weekly title (6); the
three unimplemented §3.3 sources being undocumented (7); `hadContent` ignoring
cost (8); the money-window test being calendar-dependent so **R3's lock lapses
for a third of every month** (9); `documentsRead`/`memoriesWritten` having no
seeded test — the same shape R11 occupied (10); and the window-anchor arm of
digest discovery being untested (11).

And CLAUDE.md, which this branch has not touched: its erasure sections still say
"twelve tables" and name three survivors, `digests` makes thirteen, the test
count is stale, and the new screen and tables are undescribed.

---

## Final fix round: all twelve ADDRESSED; three residuals, one more small round

Commits 06fabaa, 2e49654, 4bdda52, 4191db1, 2a403b6, 2d733c1, plus my count
correction 4d85715. Full suite reproduced by the re-reviewer: **176 files, 2363
passed, 1 skipped, zero failures** — identical to mine and to the line CLAUDE.md
now carries. Nine of the twelve are locked by mutations it ran and watched fail;
it ran thirteen in total.

**R33 — item 1's regression guard is inert on the machine this project is
developed on.** The structural half is right and was verified mechanically:
every `timeZone` in the chain is non-optional, grep finds no `timeZone?` and no
`?? '…'` fallback, so omission is a compile error — which is what I asked for.
But the **test** does not hold: dropping `timeZone` from `day()`'s `Intl` options
leaves `digest-render.test.ts` at **13/13 passing**, and fails only under
`TZ=UTC`. `vitest.config.ts` sets no `TZ`, so on any developer machine in the
charter's own zone — the normal case here — the guard for the defect we just
fixed is silent. That is the same "passes for the wrong reason" class as the five
decorative tests this branch already found. The reviewer located a fixture that
holds regardless of process zone and verified it: `Pacific/Kiritimati` with an
end instant of `2026-10-06T12:00:00Z` renders `07.10` through the supplied zone
while **both** `Asia/Jerusalem` and `UTC` render `06.10`.

**R34 — item 7's docblock miscounts the spec it exists to explain.** It says
"**Two** sources outside this block exist in spec §3.3 but are not built" and
names the untranscribed recording and the downed bridge. §3.3 names **six**;
three are built; so three are missing, and the unnamed one is `הוראה שסורבה` —
the single one of the three with a real decision behind it, because item 5
deliberately chose not to surface a refusal at all. A reader trusting that
comment comes away believing §3.3 has five sources and that nothing was decided
about refusals. Exactly the class CLAUDE.md names: a comment is a claim about
what the code does.

**R35 — the erasure count now contradicts itself across three files.** I asked
for twelve → thirteen and the implementer executed it faithfully, but the
re-reviewer grepped wider than I did: `docs/09-roadmap.md:81` still says twelve
**four times in the present tense**, and `erasure-invariants.test.ts`'s own
header still says "all twelve content stores" **and** calls `autonomy_marks` a
thirteenth — under which accounting `digests` is the fourteenth, not the
thirteenth, in a file that does seed `digests`. So CLAUDE.md and the invariant
test now disagree about the number.
It also found that CLAUDE.md:119's "thirteen tables" reconciles with neither:
`countItems` and the executor each name **17** distinct tables. The twelve/
thirteen tracks spec §5.1's content-store enumeration, not the table count — so
the old "twelve" was equally wrong against 16, and my instruction inherited the
error rather than creating it. **Ruling: say what is being counted.** A number
that reconciles with neither the code nor its sibling test is the precise thing
that register exists to prevent, and "thirteen" is not worth keeping if nobody
can check it.

Also fixing, cheap and in the same register: the empty-history line still reads
"לא נשלח עדיין שום תדריך" — the verb item 2 removed from the cards, for the
reason that both channels are off by default.

Recorded, not fixed: `liveWindowStart` ignores `weeklyDay`, so the weekly
preview spans at least seven days anchored to the hour rather than to the
configured weekday. Nothing is misstated — the label shows the real range — but
it is not quite the window a real weekly digest uses.

---

## Branch complete

Final serial full run, on a quiet machine: **176 files, 2363 passed, 1 skipped
(2364), zero failures**, 336s. CLAUDE.md line 11 states exactly that, and it was
corrected from a figure derived by arithmetic rather than measured.

The last round's residuals all closed, and item 3 was settled by **counting
instead of inheriting my number**: `countItems` and the executor each name 17
distinct tables; spec §5.1's content-store enumeration is 14 (the original
twelve, plus `autonomy_marks`, plus `digests`). CLAUDE.md,
`docs/09-roadmap.md:81` and `erasure-invariants.test.ts`'s header now each say
**which** of the two they mean and agree with one another. My "twelve →
thirteen" instruction had inherited an error that was already in the file; the
implementer was right not to propagate it.

Item 1's replacement guard is now process-zone-independent by construction: it
renders one instant through two **supplied** zones (`Pacific/Kiritimati` and
`Asia/Jerusalem`) and asserts they disagree, so it cannot pass without the
`timeZone` option being read. Confirmed failing under the mutation with no `TZ`
set — which the previous fixture did not do on this machine.

And the twice-repeated `whatsapp-wiring.test.ts` failure, which I declined to
wave off because it recurred identically: **15/15 clean run alone.** A collision,
established by measurement.

## One thing I should have done at the start, and did not

The previous sub-project's ledger
(`docs/superpowers/2026-09-29-connector-spine-rulings.md`) opens with a section
headed **RESTORE BEFORE FINISHING**: it parked the end-of-turn Stop hook to a
backup file, because that hook runs typecheck and the **full** suite at every
turn boundary and collides with subagents against the same Postgres — "this
project has already paid for that three times in one session."

I did not park it. The cost was roughly a dozen meaningless red reports across
this session — a `TRUNCATE` deadlock, two wrong row counts, a mid-run "relation
does not exist", several charter-install failures, an FK violation, and one
failure that repeated identically twice and still turned out to be a collision.
Every one had to be diagnosed and set aside, and each one spent attention that a
genuine red would have deserved. I read that file only at the end, to match the
rulings-document convention; the warning was in the first screen of it.

The lesson is not "park the hook" so much as **read the previous sub-project's
ledger before starting, not after** — it is where this project keeps the things
that only bite the person running this loop.

