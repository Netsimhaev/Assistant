# SDD ledger — plan: docs/superpowers/plans/2026-09-12-erasure.md

Spec: docs/superpowers/specs/2026-09-12-erasure-design.md (read — binding authority)
Branch: `erasure`, from `main` at f558f2d-descendant (see `git merge-base main HEAD`)

## RESTORE BEFORE FINISHING

`.claude/settings.json` — the Stop hook that runs `npm run typecheck && npm test`
every turn was removed for the duration of this plan and backed up to
`.claude/settings.json.sdd-backup`. It collides with subagents running the suite
against the same Postgres; in the instruction-door plan this cost one implementer
~160k tokens sitting in a lock wait. **Restore it before the branch is finished.**

## Preflight scan

### Pairs that share a file or an interface

| A → B | produced | consumed | finding |
|---|---|---|---|
| T1 → T3 | `keptIds`, `KeptItemKind` | same names | clean |
| T1 → T6 | `keepItem`, `revokeKeep` | same names | clean |
| T3 → T4 | `ErasurePlan{anchor,jobIds,documentIds,memoryIds,filePaths,items,excluded,refusals}` | T4 reads all eight | clean |
| T3 → T5 | `buildErasurePlan`, `ErasurePlan` | same | clean |
| T3 → T6 | `ErasurePlan` type | T6 test builds one as a literal | clean — literal carries all eight fields |
| T2 → T6 | `readForgetCommand` | same | clean |
| T4 → T5 | `executeErasure`, `ErasureRefusedError` | same | clean |
| T1 → `src/test/db.ts` | TRUNCATE entry | only T1 touches it | clean |
| T4 → `src/domain/audit.ts` | `'erasure'` kind | only T4 touches it | clean |
| T6 → `views.ts`, `server.ts` | only T6 touches them | — | clean |

### Each task against itself

| Task | check | finding |
|---|---|---|
| T1 | test imports vs exports | clean — four functions, all implemented |
| T1 | migration vs `src/test/db.ts` edit | clean; brief warns against backticks in that template literal |
| T2 | test cases vs the regexes | clean — prefix strip, email shape, date shape all traced by hand |
| T3 | test INSERT columns vs live schema | **`job_plans` needs exactly (business_id, job_id, plan_hash, plan)** — matches |
| T3 | `jobs.created_at` used by the window query | verified present |
| T4 | test INSERT into `documents` vs live schema | **DEFECT — `byte_size` is NOT NULL with no default and was omitted** |
| T4 | `canonicalHash` import | verified exported from `src/util/canonical.ts:70` |
| T5 | `boss_instructions` INSERT columns | clean — all four required columns supplied |
| T6 | `page`/`esc`/`escLabel` | present in `views.ts` but module-private — fine, `renderErasure` lives in that file |

Ruling: T4's `documents` INSERT was missing `byte_size` — added to the plan text before dispatch, with `12` as the value and a comment saying preflight found it. Cost if wrong: none; the column is a bigint and the test never reads it.

Ruling: the plan's Task 6 describes the four route handlers by shape rather than in full, because four sibling handlers in the same file already show the pattern. Cost if wrong: the implementer writes a handler that skips CSRF verification, which the task review must catch — the brief names the rule explicitly.

## Tasks

Task 1: complete (commits 48557a2..4128baa, review clean)
  - spec ✅, quality Approved, no Critical/Important
  - ⚠️ resolved by controller: the reviewer could not see whether `npm run migrate`
    hit the dev database. Verified directly — `to_regclass('public.kept_items')`
    is non-null on DATABASE_URL.
  - minor (deferred): `row.item_kind as KeptItemKind` is an unchecked cast held up
    by the DB CHECK alone. Brief specified this code; flagged for the final review.

Task 2: review ❌ — 3 Important. Rulings before fix round 1:

  Ruling: phone extraction from free text is NOT required, and the plan's
  "Produces" line over-promised. The spec (§4.1) names exactly what is read out
  of the text — "כתובת מייל, תאריך, שם בגרשיים" — and phones are not in it; §4.2
  allows a phone only as an ANCHOR, which the owner picks from a list. The spec
  is the binding authority over the plan. Fix the contract wording, not the code.
  Cost if wrong: an owner who types a phone number gets no pre-filled screen and
  picks the contact from the list instead — one extra click, never a wrong delete.

  Ruling: findings 2 and 3 are real defects and enter the fix loop.
  - readDate accepts 31/02/2026 — independent day/month bounds, no calendar check.
  - bareToken strips a leading quote BEFORE the verb test, so text opening
    `"תשכחי מזה" - כך אמר הספק` is recognised. That is precisely the paste-shape
    this function exists to refuse; the existing test only covers the verb
    appearing mid-sentence.
  Cost if wrong: the second one routes somebody else's quoted words to the
  erasure screen. It cannot delete anything on its own — the preview still
  requires the owner to choose and confirm — but it is the wrong default.

Task 2: fix round 1/5 (3 addressed, 0 open; commits 7738ad0..1c02536)
Task 2: complete (commits 4128baa..1c02536, review clean)
  - re-review traced both fixes by hand and confirmed each bites: reverting the
    calendar round-trip or the stripQuotes=false argument fails the new tests.
  - minor (deferred): the fix is broader than asked — bareToken(token, false)
    now skips ALL punctuation stripping on the first token, not only quotes, so
    `"תשכחי,"` with a trailing comma and no space would no longer be recognised.
    Untested either way, low risk. Flagged for the final whole-branch review.

Task 3: review ❌ (quality) — 3 Important, all test coverage, implementation sound.
  All four properties verified by the reviewer against the code: read-only (every
  statement a SELECT), anchor escaped at every ILIKE site with a matching ESCAPE,
  kept items symmetric across all three kinds, and counts computed from the same
  post-exclusion lists the plan returns.
  The gap is mine, not the implementer's: the plan's test file under-specified.
  A test named "finds a contact through every place the anchor can appear" exercises
  only two of the five match branches, and deleting boss_instructions,
  approval_requests and jobs.title matching entirely would fail nothing. Kept-document,
  kept-job and the signed-document refusal are likewise unexercised.
  This is load-bearing for Task 4: the executor deletes what this resolver returns,
  so an untested match branch is an untested deletion.

Task 3: fix round 1/5 (5 addressed, 0 open; commits 63a9986..59c173e)
Task 3: complete (commits 1c02536..59c173e, review clean)
  - implementer verified each new branch test by deleting the branch and watching
    the test fail, then restoring. Re-reviewer re-derived the same for each.
  - production diff confirmed limited to the two Minor items; read-only property
    re-verified — every statement still a SELECT.
  - erasure-plan.test.ts now 14 tests, one per anchor-discovery branch.

Task 4: implementer reported DONE_WITH_CONCERNS (commit ce1576e).
  It changed a pre-existing SECURITY invariant outside its brief:
  proposal-invariants.test.ts asserted exactly one writer of job_authorizations
  matching (INSERT INTO|UPDATE|DELETE FROM); the executor's DELETE became a second
  match, and the implementer split the invariant into granting writers
  (INSERT/UPDATE -> authorization.ts) and deleting writers (DELETE -> erasure.ts).
  Controller has NOT ruled yet — flagged to the task reviewer for an independent
  judgement, deliberately without my opinion attached. An implementer relaxing a
  security control so its own code passes is a pattern that must never clear on
  the implementer's own reasoning, however sound that reasoning looks.

Task 4: review ❌ — 1 Critical, 4 Important, 4 Minor. Rulings:

  Ruling: the invariant split is ACCEPTED, with the reviewer's condition attached.
  The forging property the original test named is held exactly as strongly — still
  one INSERT/UPDATE writer, still pinned to authorization.ts — and the reader side
  is fail-closed at every point, so a vanished row makes the gate ask where it
  previously allowed. But the reviewer found what both the implementer and I missed:
  the one-grant-per-job primary key was also the control against SILENT WIDENING,
  and an in-process DELETE makes delete-then-regrant a two-step widening the key no
  longer forbids. The condition — assert no production source holds both
  `DELETE FROM job_authorizations` and `grantAuthorization(` — closes it in one line.
  Cost if wrong: a future caller could widen a standing grant while erasing the
  record of what was originally asked for. Still boss-provenance only, so content
  cannot reach it.

  Ruling: C1 is a defect in MY plan text, not in the implementer's work.
  proposals.reading_id and document_readings.document_id both carry ON DELETE
  CASCADE, so deleting documents destroys proposals the plan never counted — and for
  a document anchor jobIds is empty by construction, so the preview reads
  "proposals: 0" while every proposal on that document goes. That breaks the one
  promise the whole design rests on (spec §4.4: the executor deletes exactly what the
  plan lists, which is what makes the preview the truth). The resolver must close a
  document anchor over to the proposals and jobs that reference its readings.
  Cost if wrong: the owner approves a preview that understates what is destroyed.

  Ruling: I4 (no liveness re-check inside the transaction) enters this round rather
  than being deferred. The race is real — a job the scheduler wakes between preview
  and confirm has its plan deleted mid-run — and SELECT ... FOR UPDATE also
  serialises two concurrent erasures, which nothing else does.

Task 4: fix round 1/5 dispatched and returned (commit ce1576e..6533795).
  Implementer reports all 9 findings + the invariant condition addressed; 106 files
  / 1349 tests green, typecheck clean, C1 and I1 watched failing first. Two residuals
  it raised itself, which the controller must adjudicate rather than let pass:
  (a) I3 has no forced-failure test; (b) a legacy `proposals` row with `job_id IS NULL`
  on an erased document's reading is still cascade-deleted but appears in neither the
  preview nor the counts — a narrower instance of C1's shape. It also reordered the
  transaction's deletes (proposals before document_readings/document_artifacts, both
  before documents) so an explicit DELETE is not pre-empted by a cascade and made to
  report 0 rows for a row that really was destroyed.
  Scoped re-review dispatched on opus against review-ce1576e..6533795.diff, with the
  three residuals named explicitly and an instruction to revert-and-watch I4's test,
  which the implementer verified only by inspection.

Task 4: re-review of fix round 1 — 9 of 9 findings ADDRESSED, but NOT clean.
  One new Critical (N1) and one rejected residual. Rulings:

  Ruling: N1 enters fix round 2 as a Critical. It is C1's exact shape with the
  anchor swapped: the C1 fix was scoped to `anchor.kind === 'document'`, but a
  CONTACT anchor closes forward to a document and then `DELETE FROM
  document_readings` cascades away every OTHER job's proposal on that shared
  reading — counted nowhere, because `countItems` filters by `job_id` and the
  explicit `DELETE FROM proposals` runs first so its rowCount cannot see them.
  The reviewer proved it: two proposals destroyed, one counted. Readings dedupe
  and proposals deliberately do not, and each conduct pass opens a fresh job, so
  two jobs on one reading is the DOCUMENTED expected state, not a corner case.
  The window anchor has the same shape. Cost if wrong: the owner approves a
  preview that understates what is destroyed — the one promise spec §4.4 makes.

  Ruling: the I3 "no way to force an appendAudit failure" residual is REJECTED,
  and the test enters fix round 2. The reviewer found the harness already in the
  tree — `src/governance/killswitch.test.ts:26-57` carries a self-cleaning
  forced-audit-failure trigger, used at :64-82 to prove the very error class
  (`KillSwitchAuditUnrecordedError`) the implementer modelled `ErasureAuditUnrecordedError`
  on. Adapting it is one predicate change, and CLAUDE.md explicitly sanctions
  tests that disable and restore `audit_log` triggers. An error class nothing
  constructs is a claim, not a control. Cost if wrong: one test of a rare path.

  Ruling: the legacy `job_id IS NULL` proposal residual is REAL, not structurally
  impossible — migration 018 is nullable by design, no later NOT NULL, and
  `ON DELETE SET NULL` still produces one. It is the same defect as N1 seen from
  a different side, and the reviewer's single fix closes both: scope `proposals`
  by `reading_id IN (SELECT ... WHERE document_id = ANY(...))` AS WELL AS by
  `job_id`, in `countItems` and in the executor alike.

  Ruling: the delete reordering is CORRECT and needs no change — verified against
  every foreign key; no statement now runs after something that cascades it away.

Task 4: fix round 2/5 dispatched to the resumed implementer.
Task 4: fix round 2/5 returned (commit 6533795..68c6641). 106 files / 1352 tests
  green, typecheck clean. N1 and residual 2 closed by one anchor-agnostic
  predicate — `proposals` scoped by `job_id = ANY(jobIds) OR reading_id IN
  (readings of documentIds)`, identical SQL in `countItems` and in the executor's
  DELETE, so the preview and the deletion agree by construction rather than by
  coincidence. Both new anchor tests watched failing first. I3 closed by adapting
  killswitch.test.ts's forced-audit-failure trigger harness, keyed on
  `kind='erasure'`. No open concerns reported.
  Scoped re-review dispatched to the same reviewer against 6533795..68c6641.
Task 4: fix round 2/5 (3 addressed, 0 open; commits 6533795..68c6641)
Task 4: complete (commits 59c173e..68c6641, review clean)
  - re-reviewer ran nine mutation experiments across the two rounds, each failing
    exactly the test that claims to cover it. The two `proposals` predicates are
    identical in text, parameters AND values — buildErasurePlan hands countItems the
    very lists it later returns as plan.jobIds/documentIds. Neutering either side
    fails the two new anchor tests on its own side.
  - no widening: jobB's proposal on a shared reading was ALREADY destroyed by the
    document_readings cascade; only the accounting moved, and jobB stays out of
    jobIds, so its plans, authorizations, instructions, memories and title are
    untouched. Blast radius unchanged row for row.
  - the statement ordering is now protected by tests rather than by a docblock: the
    proposals subquery reads document_readings, deleted on the next line, so a swap
    makes the whole fix a silent no-op — and swapping them fails four tests.
  - I3's harness verified not to leak: afterEach drops trigger and function, install
    does DROP TRIGGER IF EXISTS first, and the live test DB after a full run holds
    only audit_log_no_update.
  - minor (deferred): the migration-018 `job_id IS NULL` shape is correct in
    behaviour but no test names it (verified by the reviewer's throwaway probe:
    previewed=1 reported=1 rowsLeft=0, where pre-fix gave 0/0/0).
  - minor (deferred): unlike the killswitch original, which keys on a sentinel only
    its own test emits, the erasure trigger keys on `kind='erasure'`, which every
    erasure test emits. A leak would break siblings loudly and self-clears on the
    next install.
  - carried forward, out of scope here and owned by Task 5: spec §3's import
    invariant and spec §9's information_schema sweep still do not exist as tests.

Task 5: dispatched (BASE 68c6641, sonnet — the brief carries the complete test file,
  so this is transcription plus mutation testing, not design).

  Ruling: if Task 5's information_schema scan flags a table that is NOT in the
  brief's SURVIVES list (audit_log, spend_ledger, signatures), that is a FINDING
  the implementer reports — never a list it extends. The entire value of the test
  is that it names the survivors positively and demands everything else come back
  clean, including a table added next year. An implementer who adds the offending
  table to SURVIVES to get green has deleted the control and kept the test. Told
  to stop and report BLOCKED with the table and column instead.
  Cost if wrong: one blocked dispatch I have to adjudicate, against the chance of
  a green scan that proves nothing.
Task 5: implementer reported DONE (commit c6a1f92). 4/4 in the new file, full suite
  107 files / 1356 tests, typecheck clean. Scan-bites proof: disabling the job_plans
  delete made the scan fail naming exactly `job_plans.plan`, then erasure.ts restored
  byte-identically. No SURVIVES extension needed, no BLOCKED finding, test file only —
  no production code touched. Task review dispatched on sonnet, told to verify the
  byte-identical claim with `git diff -- src/governance/erasure.ts` rather than trust it.
Task 5: review — spec ✅, quality Approved, with 1 Important and 1 Minor. Rulings:

  Ruling: the Important enters a fix round rather than being parked, despite the
  approval. The import scan's `roots` list is hand-maintained and partial —
  orchestrator, sdk, policy, documents, charter — and misses src/cli, src/mail,
  src/memory, src/util, src/db, src/audit and src/config.ts, while spec §3 demands
  no production file outside erasure.ts/dashboard/ imports it, i.e. EVERYWHERE else.
  This is the exact failure mode CLAUDE.md names as the most expensive in the
  project: a control that covers part of its class. It is also a defect in MY plan
  text, transcribed faithfully — the same shape as Task 4's C1. No live offender
  exists today, so the cost of the gap is zero now and unbounded later; the cost of
  fixing it is one derived directory walk in a test file.

  Ruling: the Minor is fixed in the same round, because it is two lines and the
  precedent already exists in the tree. The information_schema scan never asserts
  it found columns before trusting an empty result — and this codebase already
  locks that pattern in reading-invariants.test.ts:25, for the identical reason:
  a scan that finds nothing and passes is not a control. Verified non-vacuous
  today (171 matching columns), which is precisely why nothing would catch a
  regression to zero.

  Verified by the reviewer by hand, not taken on trust: erasure.ts diff empty
  across the commit; an INDEPENDENT mutation (disabling the boss_instructions
  delete, not the implementer's job_plans one) made the scan fail naming exactly
  `boss_instructions.text`; capabilities.ts and classify.ts mutated separately to
  confirm tests 3 and 4 bite; 154/154 in src/governance; information_schema queried
  directly against the live test DB.
Task 5: fix round 1/5 dispatched to the resumed implementer.
Task 5: fix round 1 returned (commit c6a1f92..1afe20a). Import scan now derived from
  a recursive walk of src/ with a positive exclusion rule; proved by planting an
  import in src/memory/store.ts — a directory the old five-entry list never covered —
  and watching the scan name it, then restoring byte-identically (empty git diff).
  Schema scan now asserts >100 columns before trusting absence (171 live). 4/4 in the
  file, 107 files / 1356 tests, typecheck clean, test file only.
  Scoped re-review dispatched to the same reviewer, told to plant its own import in a
  DIFFERENT unscanned directory and to check the exclusion is not a longer hand list
  wearing a walk.
Task 5: fix round 1/5 (2 addressed, 0 open; commits c6a1f92..1afe20a)
Task 5: complete (commits 68c6641..1afe20a, review clean)
  - the import scan is a real recursive walk of src/ with a positive exclusion rule
    (erasure.ts/erasure-plan.ts by exact path, any `dashboard` path segment) — not a
    longer allowlist wearing a walk. Reviewer planted its own import in
    src/util/money.ts, a different unscanned directory from the implementer's proof,
    and the scan caught it exactly.
  - the >100 floor against 171 live columns matches the precedent style in
    reading-invariants.test.ts:25 (>3 against 6 real files): a sanity floor, neither
    brittle nor unfailable.
  - only the test file changed (33+/4-); tests 2 and 4 byte-identical.

  Ruling: the reviewer's new finding — the import-scan regex requires the `from`
  keyword, so a dynamic `await import('../governance/erasure.js')` slips past — is
  PARKED for the final whole-branch review's single fix dispatch, and named here so
  it cannot be lost. It is the same class as the finding just fixed (a control that
  covers part of its class), and erasure is precisely the module someone would reach
  for dynamically, so it is not dismissed. But no such import exists anywhere in the
  tree today, the change is one regex alternation, and the final review already gets
  one fix dispatch — carrying it there costs nothing and spends no extra round.
  Cost if wrong: a future dynamic import of the erasure module goes unflagged by the
  invariant, while every other reachability control (allowlist, TOOL_ACTION_CLASS,
  READ_ONLY_TOOLS) still refuses it independently.

Task 6: dispatched (BASE 1afe20a, opus — the plan describes the four route handlers
  by shape rather than in full, and the screen confirms an irreversible destruction).
Task 6: implementer reported DONE (commit ccde4eb). 108 files / 1373 tests, 17 new,
  all watched failing first. Four additions beyond the brief's literal text, all
  spec-driven: renderErasureDone (spec §7 file-deletion failures on screen, §10 the
  provider-copy caveat), per-item keep controls on the preview (§7 step 2),
  `plan: ErasurePlan | null` so the empty screen is not a delete button under a table
  of zeros, and one nav link.

  Ruling: the implementer's concern 1 is a CONFIRMED CRITICAL, and I verified it
  myself rather than pass it to the reviewer as a question. `ingest.ts:237` stores
  `stored_path` RELATIVE — `${businessId}/${documentId}/original.${ext}` — and builds
  the absolute path separately at :272 via `join(documentRoot, ...)`, because
  `config.documentRoot` is resolved absolute exactly once (config.ts:82, with a
  docblock saying why). `erasure-plan.ts:274` pushes the raw `stored_path` into
  `plan.filePaths`, and `erasure.ts:200` calls `unlink(path)` on it directly — so in
  production it resolves against process CWD, finds nothing, and `:205` treats ENOENT
  as SUCCESS and continues. Result: every row destroyed, the document's bytes still
  on disk, `filesFailed` empty, and the screen telling the owner it is done. The
  tests cannot see it because they pass absolute temp paths.
  This is a defect in MY plan text — Task 3 wrote the column into filePaths and Task 4
  unlinked it — surfaced by Task 6's implementer reading its own dependency. It is the
  third instance on this branch of the same family: the preview and the deletion
  disagreeing (C1, N1, now this), except here it is the *outcome* that lies.
  Cost if wrong: an erasure that reports success and leaves the file. That is the one
  outcome the whole feature exists to prevent.
  It enters Task 6's fix round even though the fix lands in erasure-plan.ts.

Task 6: review ❌ (spec) / Approved (quality) — 1 Critical, 3 Important, 6 Minor.
  The reviewer's answers on the confirmed Critical, all accepted: the PLAN BUILDER
  owns the join (§4.4/§8 make the executor something that "resolves nothing of its
  own"; erasure-plan.ts already imports config, and documents/verify.ts:76 is the
  house convention); erasure-plan.ts:274 is the SINGLE site — nothing else on the
  branch consumes stored_path with the same assumption; and the test must assert
  BOTH `filesRemoved === 1` and the file's absence against the real config root,
  because the count assertion is the load-bearing half — without it ENOENT keeps the
  test green while the file survives. Rulings:

  Ruling: ENOENT tolerance STAYS, and stops being indistinguishable from success.
  A third bucket, `filesAlreadyGone`, beside filesRemoved and filesFailed. Tolerating
  an already-deleted file is right; reporting it as a deletion we performed is what
  hid a total failure to delete anything. Cost if wrong: one more number on a screen.

  Ruling: I2 is resolved by a HASH, not a stored plan handle, and this is the one
  place I overrode the reviewer's suggested shape. It proposed a server-side plan
  handle; that needs a table, a lifetime and a sweep, for a value that lives seconds.
  This codebase already owns the idiom for exactly this problem — approvals carry
  `input_hash` for finding a row and `input_hash_at_decision` for verifying it, and
  `canonicalJson` is the deterministic hash three other controls rest on. So: the
  preview renders the plan's canonical hash into the form; confirm REBUILDS the plan
  server-side, hashes it, and refuses if it differs from the one the owner saw,
  showing the new preview to authorise instead. The anchor may still round-trip,
  because it is no longer what is trusted — the hash is. Fails closed, needs no
  schema, and keeps the executor's in-transaction liveness re-check untouched.
  Cost if wrong: a world that changed between preview and confirm costs the owner one
  extra look at what is now true — which for an irreversible destruction is the
  outcome we want anyway.

  Ruling: Minor 6 is fixed by WIRING the note, not by deleting the dead read.
  `noteFrom` is read and no form submits it, so spec §6's free-text note is
  unreachable from the UI. Deleting the reader would make the code honest and the
  spec unmet; the note is why the owner can say what they wanted kept. Wire the form.

  Ruling: Minor 9 is PARKED, not fixed. The readForgetCommand unit test sitting in
  the render block is misplaced, inherited verbatim from my brief, and asserts
  something true that Task 2 already covers. Moving it buys tidiness and risks
  nothing but churn on a green file. Named for the final whole-branch review.
Task 6: fix round 1/5 dispatched to the resumed implementer.
Task 6: fix round 1 returned (commit ccde4eb..113dfe4). 108 files / 1386 tests green,
  typecheck clean, 13 new or changed assertions each watched failing first — relative
  path, missing filesAlreadyGone, missing planHash field, missing .danger rule,
  missing name="note", un-stripped U+202E.

  Ruling: the implementer overrode my I2 shape and was RIGHT to. I specified a
  canonicalHash of the plan; it implemented a normalised fingerprint, because the
  plan's id arrays come from SELECTs with no ORDER BY and a raw hash would therefore
  refuse at random on an unchanged world — a guard that cries wolf on a destructive
  screen is a guard the owner learns to click through. Sorting before hashing is
  documented at the function and both directions are tested. Accepted.
  But it moves the risk rather than removing it: a fingerprint that normalises TOO
  much reports agreement between two different plans, which is worse than no guard at
  all. Re-reviewer told to construct two plans differing only in a field it suspects
  is outside the fingerprint — items, excluded, refusals, memoryIds, filePaths, not
  merely the id arrays — and that any omission is a Critical, not a Minor.
  Cost if wrong: confirm authorises a destruction wider than the one previewed, which
  is the exact failure I2 was raised to close.
Task 6: fix round 1/5 (8 addressed, 0 open; commits ccde4eb..113dfe4)
Task 6: complete (commits 1afe20a..113dfe4, review clean)
  - the reviewer PROBED the fingerprint rather than reading it: temporarily exported
    planFingerprint, ran a throwaway probe, restored. ErasurePlan has exactly 8 fields
    and all 8 are in the hash — it differs for items[].count, items[].table/action,
    memoryIds, filePaths, jobIds, documentIds, refusals, anchor, an excluded entry
    removed, and excluded[].itemKind; it agrees only on a genuine reordering. Not
    over-normalised: no two plans with different destruction scopes fingerprint alike.
  - C1 verified fixed in the right module: erasure-plan.ts:289 joins documentRoot and
    filePaths is absolute by construction, while erasure.ts:213 still unlinks the plan
    entry verbatim — the executor was NOT changed to compensate. The old
    absolute-temp-path test was replaced, not kept beside the new one.
  - the done screen now raises `אף קובץ לא נמחק בפועל` in red on exactly the signature
    C1 produced — the failure that previously read as success.
  - CSRF still first in all three POST handlers after the documentRoot edits.

  Ruling: the 800ms timing test STAYS. The reviewer verified the implementer's
  fail-safe claim mechanically — the asserted wording exists in exactly one non-test
  place (erasure.ts:133), so a timing slip routes to the plan-time branch whose
  wording differs and the test goes red, never falsely green. It is the only reachable
  proof that the executor's locked refusal renders instead of 500ing, and its residual
  cost is a false RED on a stalled machine, which is the harmless direction.
  Deferred-minor: convert the duration into a condition (poll pg_locks until a backend
  waits on that row, then commit). Named for the final review.

  Minor (deferred): excluded[].keptAt and excluded[].note sit outside the fingerprint.
  They cannot change what is destroyed — a kept entry is already subtracted from the
  id arrays the executor consumes — so this is a docblock sentence, not a defect.

Task 7: dispatched (BASE 113dfe4, sonnet — documentation against a finished tree).
Task 7: complete (commit 23f4144). CLAUDE.md test count updated 1312 → 1386 from a
  measured run, not carried over. All five as-built corrections verified against
  source and written up; no further divergence from the brief found.

  Ruling: Task 7 gets NO separate task review — it is folded into the final
  whole-branch review, which reads the same CLAUDE.md and roadmap diff anyway and
  is better placed to judge whether the prose matches the tree, since it has just
  read the tree. A second reviewer for prose alone would duplicate it.
  Cost if wrong: an inaccurate paragraph in the file future readers trust over the
  source — which is why the final reviewer is told to check exactly that.

Final whole-branch review dispatched on opus, range 16203d6..23f4144 (16 commits),
  pointed at the eight deferred/parked items by name.

  Ruling on scope: the range starts at 16203d6 and not at `git merge-base main HEAD`
  (f558f2d), because this branch was cut from `local-tool-executor`, not from main.
  Two commits below the spec — a03cbe1 and 16203d6, the local tool executor and the
  first memory layer — are a DIFFERENT sub-project, had their own cycle on their own
  branch, and are outside this plan's scope. The reviewer was told to review
  16203d6..HEAD only, and to say so if the erasure work leans on those two fragilely.
  **This matters at merge time and is recorded here so it is not lost:** merging
  `erasure` into main will carry both commits with it. main has neither
  src/memory/store.ts nor src/orchestrator/local-tools.ts today.
Final review: first dispatch (opus) died on an account session limit before reading
  anything — no partial verdict, nothing lost but time.

  Ruling: re-dispatched on sonnet rather than waiting for the opus window to reset.
  The skill asks for the most capable model on the final review, and this is a real
  downgrade, not a preference — so it is compensated rather than waved through: the
  reviewer is pointed at all eight deferred items BY NAME, told the three exact shapes
  in which the preview-equals-destruction promise has already failed on this branch and
  to hunt a fourth, and told to verify the never-a-tool property by property rather
  than by reading the invariant that asserts it. The three per-task reviews it builds
  on were themselves run on opus, and each probed rather than read — the fingerprint
  was exported and tested, the scans were bitten with the reviewer's own mutations.
  Cost if wrong: a subtler cross-task defect survives to the merge decision. If the
  verdict comes back thin rather than clean, re-run it on opus after the reset instead
  of accepting it.

Final review: BOTH reviews exist and converge on FIX FIRST.
  The opus dispatch did NOT lose its work — it wrote final-review.md in full (22KB,
  156 lines, N1-N10) and died only while summarising back to me. The sonnet retry
  independently re-derived the highest-stakes claims against current source, found
  the same Critical, and left the opus file as the deliverable. Two reviewers, one
  verdict, arrived at separately.

  N1 (Critical, the FOURTH instance of this branch's recurring family, and the first
  where content SURVIVES rather than merely being undercounted): an
  `approval_requests` row with `job_id IS NULL` — holding the recipient address and
  the full message body in summary/detail/proposed_input/edited_input — is found by
  the contact search, discarded by `AND job_id IS NOT NULL` (erasure-plan.ts:130),
  and never counted or deleted. Reachable in production: GateContext.jobId is
  `string | null` and evaluateToolCall writes `jobId: ctx.jobId ?? null` into
  enqueueApproval, which is exactly the SDK path with no job row. Proved with a
  throwaway test: plan lists nothing, row survives.

  Rulings on the rest, all recorded in final-fix-brief.md:
  - N3: IMPLEMENT spec §5.1.1's conditional rather than amend the spec. A signature is
    evidence of a human act, and migration 020 already encodes that ethic by making the
    signature survive the document's deletion under RESTRICT. Scrub and keep when
    signatures.approval_id matches.
  - N6: EXTRACT the duplicated proposals predicate to one exported constant. Tests bite
    on drift today, but this is the one place the branch's core promise rests on two
    copies staying equal BY HAND, and making it structural is the branch's own lesson.
  - N7: WIRE listKept into the entry screen — closes both a dead export (a shape this
    codebase has a documented allergy to) and spec §6 in one move.
  - N4: the three pickers of spec §4.2 are DEFERRED and must be RECORDED as deferred in
    the roadmap, which currently reads as if §4 shipped whole. Not a safety defect —
    everything still passes a counted preview and a fingerprinted confirm — but the
    document anchor is unusable without database access until they exist.
  - N5, N9: docblock/spec sentences only.
  - N8: fix only if it stays narrow; report as deferred if it spreads.
  - Items 1, 4, 7 accepted as-is with reasons in the review file.

  Verified by the opus reviewer by hand, worth keeping: it walked every foreign key
  hunting a fifth cascade path and found none — the `jobs` row is SCRUBBED, never
  deleted, so no job-child cascade can fire and pre-empt an explicit count, and the
  whole job-side accounting rests on that. It also confirmed never-a-tool BY PROPERTY
  (a grep for importers returns six lines, all in dashboard, four of them `import type`)
  rather than by reading the invariant that asserts it, and bit two tests with its own
  mutations.
Final fix round dispatched on opus (the limit had reset).
Final fix round returned (commits 23f4144..2d40400, nine logical commits). 108 files /
  1394 tests, up from 1386 — eight new, none weakened or removed. Typecheck clean.
  All nine brief items done; nothing deferred or narrowed.

  Ruling: the implementer's N1 document-anchor decision — NO closure, deliberately —
  is ACCEPTED pending the re-reviewer's verification of each link. Its argument:
  approval_requests carries no document reference of any kind (no document_id, no
  reading_id, no proposal_id), and an orphan card has no job either, so it is not
  reachable through the proposals→readings chain the document anchor uses for
  everything else. The only available predicates would be "delete every orphan card" —
  destroying content the anchor never named, which is the exact defect this round
  closes — or a match against documents.original_name, which is the sender's chosen
  string and precisely what this codebase refuses to treat as identity (CLAUDE.md,
  "שם הקובץ אינו זהות"). That reasoning is right, and it is in a docblock at the
  constant rather than left as an unexplained hole. It is also not a new gap: before
  this round a document anchor reached no orphan card either.
  Cost if wrong: an orphan approval card survives a DOCUMENT-anchored erasure. Bounded
  by the same fact that makes the closure impossible — nothing links the two — and the
  contact and window anchors both now reach it.

  Ruling: leaving deferred item 8 (the misplaced duplicate readForgetCommand test) in
  place is CORRECT and I endorse the implementer's reasoning unprompted. The review
  called its removal optional, and deleting a green assertion is not something a fix
  round should do unasked.

Scoped re-review of the fix round dispatched on opus, told to verify each link of the
  document-anchor argument, to check the window closure cannot widen beyond
  `job_id IS NULL`, and to TRY TO BREAK the new predicate by constructing a case where
  the plan lists one count and the executor deletes a different set.

Fix-round re-review: 8 of 9 ADDRESSED, and a CRITICAL inside the N1 fix itself.
  Both of the implementer's anchor judgements were independently confirmed:
  - (a) document anchor: the reviewer checked each link against 001_spine.sql and
    agreed no closure is available. It found one link the implementer did NOT
    enumerate — `signatures` carries both document_id and approval_id, so
    signature→approval IS a real join — but it reaches only rows §5.1.1 scrubs and
    keeps, and a document anchor on a signed document is refused at plan time and
    again by the FK. Conclusion stands.
  - (b) window anchor: the arm is lexically nested inside `job_id IS NULL` and the
    thirty-day-old card test bites. Uncovered: a card WITH a job_id outside the window
    but created_at inside it — nothing would catch the arm being lifted out of the
    guard. One seeded row locks it.
  - (c) the reviewer TRIED TO BREAK the predicate and could not: three shared exported
    constants interpolated verbatim at both sites, both calling one shared params
    function; the two arms are NOT EXISTS/EXISTS over one matched set, disjoint and
    exhaustive; nothing the executor deletes earlier cascades into approval_requests
    or signatures (document_id is RESTRICT), so the scrub's matched set at statement
    time equals the preview's; the anchor round-trips through zod with min(1) so no
    empty identifier can sweep with `%%`.

  F1 (CRITICAL, and the FIFTH instance of this family — this time inside the fix for
  the fourth): APPROVAL_REQUESTS_MATCHED is a template literal writing `ESCAPE '\'`
  four times. JS collapses `\'` to `'`, so Postgres receives `ESCAPE ''` and escape
  processing is DISABLED. Every other LIKE site in the file writes `ESCAPE '\'`
  correctly; only the new constant does not. likeLiteral still prefixes backslashes,
  which then match nothing. Proved twice — in Postgres directly, and end to end with an
  orphan card for `dana_cohen@beta-log.example`: plan lists 0, row survives.
  So N1 is exactly as open as before the fix for any contact identifier containing
  `_`, `%` or `\` — an ordinary email local part.
  The twelve-store sweep missed it only because PROBE contains no `_`.

  Ruling: F1 gets a second fix round even though the skill allows ONE fix dispatch
  after the final review. A Critical that leaves the finding it was dispatched to close
  still open is not a residual to park — parking it would ship the exact defect the
  round was for. The round is tightly scoped: four backslashes, one character in PROBE
  so the sweep becomes self-detecting, one seeded row to lock (b)'s guard by test
  rather than by nesting, and one dangling CLAUDE.md sentence.
  Ruling: the failing test must be the IDENTIFIER-shaped one (an orphan card whose
  contact identifier contains `_`), not an assertion about backslash counts, so what is
  locked in is the behaviour and not the spelling of the fix.

Fix round 2 returned (commits 2d40400..8789ef5). 108 files / 1396 tests, two more than
  round 1, none weakened. F1 reproduced before fixing (`expected +0 to be 1` on an
  orphan card for dana_cohen@beta-log.example), and the locked-in test is the
  identifier-shaped one with a near-twin (danaXcohen@...) differing only in where the
  wildcard sits — so a predicate that stops escaping sweeps BOTH and fails, rather than
  passing. The sweep is now self-detecting, verified mechanically: with the escapes
  reverted, erasure-invariants.test.ts names approval_requests.summary and seven more
  columns on its own. The window-guard row is seeded and survives.

  Ruling: the implementer's own residual — "I fixed the instance, not the class" —
  gets a third round, and it is the last. Nothing structurally stops a twelfth LIKE
  site being written with one backslash: it typechecks, it reads right, and it fails
  silently and only for anchors carrying a wildcard, which is exactly how F1 reached
  the final gate. Extracting one exported escape fragment used at all eleven sites is
  mechanical and closes the class.
  The deciding argument is consistency with my own N6 ruling one round earlier: having
  extracted the proposals predicate so the preview and the destruction cannot drift
  apart by hand, leaving eleven hand-typed escape clauses beside it would be
  incoherent. Both Criticals at the end of this branch were the same shape — a property
  held by hand rather than by construction.
  Cost if wrong: one more small round on a branch that is otherwise ready. Scoped to
  the extraction only; the three shared constants, the params function and the arms'
  disjointness are verified and must not move.

Fix round 3 returned (commit 25491f1). 1396 tests, typecheck clean, NO test added or
  changed — the round's whole proof is that the existing ones still bite. Mutation
  watched: reverting LIKE_ESCAPE to the one-backslash spelling turned both the
  dana_cohen identifier test and the twelve-store sweep red; restored, green.
  Spelled with String.raw — the one spelling the collapsing rule cannot touch — so the
  defect cannot be reintroduced by the mechanism that caused it, verified by running
  all three spellings rather than reasoning about them.
  The count was FOURTEEN LIKE sites, not the eleven I gave it. LIKE_ESCAPE and
  likeLiteral had to move above the predicate constants, which reference the fragment
  in their own module-level initialisers (a const below them is a TDZ error at import);
  nothing about the predicates moved.

  Ruling: the fifteenth LIKE site — src/memory/store.ts:239, recallMemories, with its
  own inline copy of both halves — stays OUT of this branch, and the consistency debt
  is recorded here instead. The implementer read it and reports it correct today (two
  backslashes in a template literal), and it declined to force the sharing because
  memory/store.ts importing from governance/erasure-plan.ts is precisely what this
  branch's central invariant forbids — it would turn erasure-invariants.test.ts red
  naming the file. Its proposed alternative, hoisting both halves into a neutral
  src/util/like.ts with the import direction inward, is CORRECT and is the right fix.
  It is ruled out here on scope, not on merit: memory/store.ts belongs to a different
  sub-project sitting on this branch's unmerged base, and an erasure branch must not
  restructure another sub-project's module. FOLLOW-UP for sub-project B.
  Cost if wrong: one correct hand-typed copy survives outside the erasure module. The
  re-reviewer was asked to confirm it is correct today, so what is deferred is a
  consistency debt and not a live bug.

Final verification pass dispatched to the re-reviewer for rounds 2-3, told to redo the
  LIKE_ESCAPE mutation itself, to confirm no LIKE site in the module was missed, and to
  check my fifteenth-site reasoning rather than accept it.

Final verification of fix rounds 2-3: SHIP. The reviewer redid the LIKE_ESCAPE mutation
  itself (both the dana_cohen identifier test and the twelve-store sweep go red, then
  restored byte-identically), enumerated all fourteen LIKE sites and grepped for any
  `I?LIKE $n` not carrying the fragment — none missed, and LIKE_ESCAPE is exported but
  imported nowhere, so the reachability invariant is untouched. It also confirmed the
  near-twin `danaXcohen@...` does real work: neutering likeLiteral to the identity gives
  `expected 2 to be 1` — two failure directions, so the test cannot rot into a spelling
  check. Fifteenth site checked mechanically and correct today, so my deferral stands.

Branch security review (CLAUDE.md requires one when migrations are touched; 024 and 025
  both are, and both final reviewers asked for it independently). Scoped to the 18
  commits this branch adds, f558f2d..HEAD — the erasure work plus the memory layer and
  local tool executor beneath it. ONE finding, MEDIUM, and everything else clean:
  no SQL injection (every value is $n; the only interpolated fragments are data-free
  constants and both ESCAPE declarations spelled correctly), no path traversal
  (stored_path is machine-generated from config + a generated id + a closed extension
  map), NO PATH from model output, document content or a plan step to the erasure
  executor — only the dashboard imports it, which is the highest-stakes property here —
  no XSS on the new screens, correct session + CSRF gating on all four routes, a confirm
  handshake covering every field the executor reads and failing closed on a missing
  hash, count-only audit row, prototype-safe dispatch in local-tools.ts, no provenance
  laundering in the memory store.

  Ruling: the MEDIUM is FIXED, not accepted, and I verified it by reading
  server.ts:507-514 rather than taking the report. A recognised forget command redirects
  `303 /erase?identifier=<address>`, so the contact's email or phone — the exact identity
  the feature exists to destroy — lands in the mandated reverse proxy's access log and in
  browser history, both places the erasure cannot reach, and outlives it. For a feature
  whose whole promise is that the identity is gone and only counts remain, that is the
  promise broken at the doorstep.
  Fix: render the erase screen inline from the POST (200) instead of redirecting with the
  prefill in the URL. Post/Redirect/Get has nothing to protect on this path — a
  recognised forget command creates no job, grants no authorisation and calls no model,
  returning before runInstruction — so the inline render costs nothing and keeps the
  prefill the owner just typed. No schema change.
  The locked-in test is that no response header and no rendered URL carries the
  identifier, written to fail against the current redirect first.
  Cost if wrong: the owner retypes an address on one screen.

Security fix landed (commit b046156). 108 files / 1397 tests — one net new, since the
  old redirect test became two (identifier shape and date-only shape). Both written to
  fail against the redirect and watched doing it (`expected 303 to be 200`). The
  assertion checks the address appears in NO response header whatever it is called, and
  in no URL the page itself emits, raw or percent-encoded — not merely that `Location`
  is absent.
  Two things the implementer did beyond the brief, both right: it routed the inline
  render and `GET /erase` through ONE `sendErasureScreenFor`, so the two entrances
  cannot answer the same prefill with two different screens; and it threaded
  `documentRoot` into `handleInstructPost`, because a fingerprint computed over a
  different root is a fingerprint of a different plan — the same class of bug as C1,
  caught before it existed. It also removed `redirectSeeOther`, now callerless, rather
  than leave a helper with no reader (a shape this codebase has a documented allergy to).
  Verified by the controller directly: no stray `redirectSeeOther` reference anywhere in
  src/, no query-string construction for the identifier, one shared renderer with exactly
  two callers, and `npx vitest run src/dashboard/erasure-routes.test.ts` green at 30.

RESTORE DONE: `.claude/settings.json` restored from `.claude/settings.json.sdd-backup`
  (verified a clean superset beforehand — the only difference was the Stop hook block),
  and the backup file deleted. The end-of-turn typecheck+test hook is live again.
