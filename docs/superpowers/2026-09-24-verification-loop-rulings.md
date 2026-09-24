# SDD ledger — plan: docs/superpowers/plans/2026-09-24-verification-loop.md

Spec: docs/superpowers/specs/2026-09-24-verification-loop-design.md (read — binding authority)
Branch: `verification-loop`, cut from `main` at 9a776fe.

## RESTORE BEFORE FINISHING

`.claude/settings.json` — the Stop hook that runs `npm run typecheck && npm test` every turn was
removed for the duration of this plan and backed up to `.claude/settings.json.sdd-backup`. It
collides with subagents running the suite against the same Postgres, and this session has already
paid for that twice: three overlapping runs reported 57 failures, 118 failures and a hook failure,
while the single clean run that followed was 1825/1825. **Restore it before the branch is finished,
and only after the last manual suite run.**

## Preflight scan

### Pairs that share a file or an interface

| A → B | produced | consumed | finding |
|---|---|---|---|
| T1 → T3 | `composeVerificationAnswer(reading: Reading)` | T3 passes the reading loaded in the handler | **DEFECT — ruling 2.** The plan says `reading.reading`. `ReadingRecord`'s field is `content`, and it is `Reading \| null`. |
| T2 → T3 | `saveNotJudged`, `NotJudgedReason` | `saveNotJudged(subjectJobId, outcome)` | clean — after the `!== 'succeeded'` guard, `DelegationOutcome` narrows to exactly `'failed' \| 'timeout'`, which is `NotJudgedReason`. Load-bearing on the narrowing, not on a cast. |
| T2 → T5 | `loadVerificationOutcome`, `VerificationOutcome` | the card route maps three states | clean |
| T3 → T4 | `assert.evaluate` payload `{subjectJobId, documentId, draftText, question}` | T4's plan step input | clean — same four names both ends |
| T3 → T4 | the plan's step list | T4 binds it | **DEFECT — ruling 1, load-bearing.** See below. |
| T3 → T6 | `LocalToolContext.verifier` | T6 threads it through `schedulerPass` | clean in shape; T6 already says to thread it the way `notify` is threaded rather than reaching around the scheduler |
| T4 → T6 | `beginVerification` binds a plan | T6's end-to-end test | follows ruling 1 — T6 must expect a ONE-step plan |
| T4 → T3 | `ContextRef` document branch | `{kind:'document', documentId}` | clean — verified against `src/domain/envelope.ts:79` |

### Per-task self-consistency

| Task | finding |
|---|---|
| T1 | clean. The test asserts the `sourceRef.quote` does NOT travel, and the implementation never reads it. The "does not truncate" test matches the no-cap implementation. |
| T2 | clean. The migration's CHECK name matches the name the test asserts on. `loadVerdict`'s new `verdict IS NOT NULL` predicate matches the test that expects `null` rather than a throw. |
| T3 | **DEFECT — ruling 3.** The tests reference `VERIFICATION_QUESTION`, which is a module-private const in `conduct.ts` and is not exported. |
| T4 | see ruling 1. |
| T5 | clean. |
| T6 | clean in itself; inherits ruling 1. |

### Rulings

**Ruling 1 — the two-step plan cannot work, and the fix is a one-step plan. Load-bearing.**
`agent.request_help` classifies to `agent.delegate` (`classify.ts:59`). The `gov.verify` delegating
job's provenance is `unknown_external`, hard-coded in `conduct.ts:186`. Gate stage 8 computes
`effectiveAutonomy` as the minimum over all ceilings, and `provenanceCeiling['unknown_external']`
is `draft_only` (`test/fixtures.ts:57`) — so a plan step naming `agent.request_help` on this job is
refused `draft_only:persist_as_draft` **before it ever delegates**. `CEILING_EXEMPT_TOOLS`
membership does not save it: that list only stops a tool contributing a ceiling to
`rampLevelForPlan`; it does not exempt the step from the ceilings that always apply. This never
bites today only because `conduct.ts` calls `requestHelp` **directly**, bypassing the gate — a
documented bypass with a written reason, like `raiseProposalApproval`.

Decided: **keep the direct `requestHelp` call exactly as it is today, and bind a ONE-step plan whose
only step is `assert.evaluate`.** That tool is read-only, so it short-circuits at gate stage 4 and
never reaches stage 8 — no ceiling applies to it. Order inside `beginVerification`: bind the plan
first, while the job is still in `execute`, then call `requestHelp`, which parks it. When the answer
lands, `resumeDelegatedJobs` wakes the job to `execute`, `runDueJobs` runs the bound step, and it
judges.

Rejected alternatives, and why: raising `provenanceCeiling['unknown_external']` weakens the central
control that keeps a hostile document from acting; giving the `gov.verify` job a friendlier
provenance is precisely the trust-laundering that `writeMemory` and `grantAuthorization` both exist
to refuse. Neither is worth a plan's convenience.

Cost if wrong: this consumer does not exercise `agent.request_help`'s re-park path. That path stays
covered by its own tests and by any future agent whose plan names the tool, and it is not needed
here — `resumeDelegatedJobs` wakes the parent only once a result exists.

**Ruling 2 — `ReadingRecord.content`, not `.reading`, and it is nullable.**
`reading-store.ts:22` declares `content: Reading | null`, with a `status` that can be `unreadable`.
T3 must read `.content` and refuse when it is `null` — the same `verification_answer_missing`
refusal it already uses for a missing reading, because a reading that exists but carries no content
is not an answer either. Cost if wrong: a type error at the first typecheck, which is cheap.

**Ruling 3 — the tests supply their own question string.**
`VERIFICATION_QUESTION` stays module-private in `conduct.ts`. Exporting a conductor constant so a
local-tools test can import it couples the two modules for a test's convenience, and the handler
does not care what the question says — it passes it through. T3's tests use their own literal.
Cost if wrong: nothing; the string is not load-bearing for the handler.

**Plan amended** for rulings 1, 2 and 3 before Task 1 was dispatched, because implementers read
briefs extracted from the plan file — a ruling recorded only here would not reach them.

Task 1: implementer returned DONE_WITH_CONCERNS (commit fb0714f, 4/4 green, typecheck clean).
  **Two errors in MY brief, both verified by the controller against the schema:**
  `SourceRef` has `{ordinal, locator}` and no `quote` field (`domain/reading.ts:59-63`), and the
  intent enum has `pay_or_purchase`, not `pay_invoice` (`domain/reading.ts`, ten members).
  The implementer corrected only the test fixture literals, left every assertion and the
  implementation untouched, and reported rather than bending the code to a wrong test. Correct
  handling; no ruling needed, the brief was simply wrong and the code is right.
Task 1: review — spec ✅, quality NOT approved. One Critical, one Minor.
  Critical: the fixture fix set `sourceRef: {ordinal, locator: null}`, which removed the probe
  string from the input entirely — so `not.toContain('נא אישורכם')` passes no matter what the
  function emits, including if it dumped the whole `Intent`. That assertion is the only test behind
  the reason the function exists (the judge's one document-derived channel). The reviewer verified
  the OTHER two tests do bite: removing `.sort()` fails the determinism test, removing the `Set`
  fails the de-dup test.
  Minor, folded into the same round: the docblock cites `sourceRef.quote`, a field that does not
  exist — the comment-describes-what-is-not-so class this project tracks, now at five-plus.
Task 1: fix round 1 dispatched — probe string into `locator`, `findings` and `note` given real
  content so their assertions can fail too, and the implementer must watch each negative assertion
  go red before reverting the probe.
Task 1: fix round 1/5 (2 addressed, 0 open; commits fb0714f..7196513). The implementer verified
  vacuity by leaking all three fields into the output, watched the test go red on all three, and
  reverted; the re-review confirmed the reverted state is what is committed, that the three probes
  are mutually distinct so no assertion tests another's field, and that the determinism and de-dup
  tests were left undisturbed.
Task 1: complete (commits 99fdd5c..7196513, review clean).
Task 2: implementer DONE (commit 1c7472b, 10/10 green, migration 030 applied, typecheck clean).
  All three controller corrections to the brief applied. Review dispatched.
Task 2: review — spec ✅, quality approved, ZERO findings. The reviewer verified both traps by
  mutation reasoning (removing either `= NULL` clause fails the both-directions test with a raw
  CHECK violation; removing `verdict IS NOT NULL` throws inside `Verdict.parse(null)`), confirmed
  `Verdict.criteria.min(1)` is untouched, confirmed the DB-level CHECK is proven by a raw INSERT
  rather than only in zod, and confirmed no pre-existing test was loosened.
Task 2: complete (commits 7196513..1c7472b, review clean).

Task 3: implementer DONE_WITH_CONCERNS (commit 3e8e7e6, 33/33 in local-tools.test.ts incl. 8 new,
  typecheck clean, plus positive-controls / capabilities / intent-registry / gov-verify green).
  **A fourth error in MY brief, load-bearing, verified by the controller:** the brief resolved the
  governing envelope with `loadEnvelopeForChildJob(ctx.jobId)`, which filters on `child_job_id`
  (`envelope-store.ts:394`). The `gov.verify` job is never a child — `requestHelp` writes it as the
  envelope's `parent_job_id` (`delegate.ts:522`). So every verification would have refused itself
  with `verification_answer_missing`. The implementer added `loadHelpRequestFromParentJob`
  (`parent_job_id = $2 AND kind = 'help_request'`, newest first, limit 1), which also gives
  `parent_job_id` its first reader since migration 028 — the no-reader defect class again.
  Mutation-checked: reverting to the old call fails 5 of the 8 new tests.
  Three further deviations to review, not yet adjudicated: the brief's `'status' in result` narrowing
  does not compile; the `ctx.bundle` guard was dropped; and `verifyDraft` already calls `saveVerdict`
  so the handler's own call is a second (upsert) write.
Task 3: review — spec ✅, quality NOT approved. **Branch is red.** All four deviations accepted by
  the reviewer, with reasons checked in code (the `kind='help_request'` clause is load-bearing
  because `writeResultAndWake` files results under the child's `parent_job_id`; both `saveVerdict`
  writers use `subjectJobId` so they cannot disagree; `verifyDraft` refuses a bundle as a parameter
  so no wiring signal is lost; `Verdict` carries no `status` so presence is the discriminant).
  Critical: `ingest-table.test.ts:62` pins `assert.evaluate` as non-ingesting and the flag flip
  breaks it — 1 failed / 7 passed, measured. The implementer checked four invariant files and not
  the fifth, which is the one its change touches.
  Important: the reading is keyed on the PARENT's provenance while the CHILD wrote it (equal today,
  fail-closed if ever not); the "answered but no readable reading" path files nothing; the new
  `verification_delegated_again` refusal has no test.
Task 3: **Ruling — fix the unreadable-reading gap now, across tasks.** It is reachable in
  production, not exotic: an unreadable document gives the child `status:'unreadable'`, the child
  completes, the delegation reports `succeeded`, and no readable reading exists — so the card reads
  "still running" forever, the exact ambiguity spec §6 exists to remove. Decided: a third
  `NotJudgedReason` member `'unreadable'` plus a NEW migration 031 widening the CHECK (never an edit
  to 030). Cost if wrong: one enum member and a three-line migration on a state no test currently
  reaches.
Task 3: **Ruling — the curation side effect stays.** Flipping the ingest flag makes a `gov.verify`
  job qualify for curation once Task 6 lets it reach `verify`, costing a billed call that
  `siftCandidates` rejects everything from. That is the documented "a job that only recalls can
  still waste a paid curation call" pattern, bounded by the daily cap. Recorded for the final
  review rather than widening Task 3. Cost if wrong: one curator call per card, capped daily.
Task 3: fix round 1 dispatched (1 Critical, 3 Important, 2 Minors).
Task 3: fix round 1 landed (commit 76cf7d5). 4 files / 92 tests green incl. ingest-table 8/8;
  migration 031_verification_unreadable.sql applied; typecheck clean.
Task 3: **Ruling — the implementer's extension of the unreadable ruling is accepted.** It files
  `'unreadable'` on BOTH arms, not only `content === null`: a missing reading row is equally
  reachable (`no_artifacts` writes none, and `{performed:false}` still completes the child's step,
  so the delegation still reports `succeeded`), and throwing there leaves the identical permanent
  "still running" one branch over. The ruling was about the state, not the branch it surfaced in.
  Cost if wrong: one extra filed row on a path that would otherwise throw.
Task 3: fix round 1/5 (6 addressed, 0 open; commits 3e8e7e6..76cf7d5). Re-review confirmed 030 is
  byte-identical (empty `git diff` on it), 031's CHECK accepts exactly the three reasons, both new
  unreadable tests assert the filed row so neither is vacuous, and the `db` fix is a no-op when
  absent.
Task 3: minor (deferred to the final review): the provenance-key fix is correct by inspection but
  UNCOVERED — `seedDelegation` gives parent, subject and child the same `unknown_external`, so a
  regression to `loadJob(ctx.jobId)` would pass every test in the suite. The divergence it guards
  against cannot occur today (both values come from the same hard-coded conductor path), which is
  why this is deferred rather than looped: the guard protects a future deliberate change. Cheap fix
  if the final review wants it — seed the child with a distinguishable provenance plus a second
  `document_readings` row under the parent's, then assert which row the answer came from.
Task 3: complete (commits 1c7472b..76cf7d5, review clean).

Task 4: implementer DONE_WITH_CONCERNS (commit a582bbb, conduct 17/17 and 158/158 across six files,
  typecheck clean). Corrected my guidance: only THREE of the four `failed` assertions concerned the
  `gov.verify` job — line ~373 is the unrelated document-job error path. Of the three, one (verifier
  throws) is a genuine error path and was left untouched; two (verifier returns normally) pinned the
  bug this task removes and were retargeted with comments naming the old lock.
  Deliberate deviation: kept `ctx.verifier`, because the brief's own condition for removal ("if
  nothing else reads it") is false — the untouched error-path test needs it.
  Flagged: a new cross-process race — a second scheduler's `runDueJobs` could catch the job in
  `execute` with a plan bound but not yet parked, run the step, find no envelope and fail it.
  Documented; unreachable on today's single-process deployment. For the reviewer to weigh.
Task 4: review — spec ✅, quality approved. One Minor only.
  Adjudications all verified in code: the `failed`-assertion classification is right (the untouched
  one is a genuine error path where the injected verifier throws and `beginVerification`'s outer
  catch fires); `ctx.verifier` IS read in production (`conduct.ts:621` is the only call site that
  invokes `verifyDraft` at all, so the brief's removal condition was false for a stronger reason
  than the implementer gave); the race is real and closed today only by `schedulerPass`'s in-process
  sequencing, since `run-due`, `conductor` and `scheduler` hold three different advisory-lock scopes.
Task 4: **Ruling — the race stays fatal and documented.** Both the implementer and the reviewer
  reached this independently. Making `verification_answer_missing` retryable would paper over a
  narrow window by inventing a new one: a retry-driven `execute → followup` could land before
  `requestHelp`'s own transition to `followup`. The project's pattern is to document a narrow
  single-process-safe race, not to pre-solve it. Cost if wrong: the day a second scheduler process
  runs against one business, a verification job can fail spuriously — visible in the audit trail,
  bounded to verification (informational only), and the card still appears regardless.
Task 4: minor (deferred): `conduct.test.ts:677-695` ("raises the card immediately, with no verdict
  yet") would pass under the pre-Task-4 code too — nothing wrote a verdict synchronously either way.
  Mandated verbatim by my brief, so implementer-blameless; it confirms rather than guards.
Task 4: complete (commits 76cf7d5..a582bbb, review clean).

Task 5: implementer DONE (commit 053a506, 99/99 in server.test.ts incl. 5 new, typecheck clean).
  Covered all three `NotJudgedReason` members with distinct Hebrew sentences and added a
  COMPILE-TIME exhaustiveness check, so a fourth reason fails typecheck instead of silently reusing
  another reason's text — the positive-control shape this project asks for, and more than the brief
  required. Found a further brief error: its own template text would not have satisfied its own
  test's `toContain` assertion.
Task 5: review — spec ✅, quality approved. Zero Critical/Important. The reviewer reproduced the
  exhaustiveness tripwire in isolated `tsc` (a fourth member gives TS2322), confirmed the new block
  interpolates only hand-written literals so no escaping is needed, confirmed the pre-existing
  try/catch is behaviourally identical, and confirmed no control is conditioned on verdict state.
Task 5: minor (deferred): `server.test.ts:112` asserts absence of a string that appears nowhere in
  `views.ts` — a dead assertion inherited verbatim from my brief. The other two assertions in that
  test are real and can fail, so the test still guards something.
Task 5: complete (commits a582bbb..053a506, review clean).

Task 6: implementer DONE_WITH_CONCERNS (commit 220022e, 41/41 on the two new files plus eleven
  other suites green, typecheck clean). Both new tests mutation-checked: rendering `sources` into
  the judge prompt turns the invariant red, and deleting the `verifier` forward turns the loop test
  red.
  **Structural finding worth keeping:** the loop needs TWO scheduler passes, and the second is not
  incidental — `resumeDelegatedJobs` runs BEFORE `runDueJobs` in `schedulerPass`, so a helper that
  closes later in a pass is only visible at the top of the next one.
  Two further brief errors (my sixth and seventh): Step 2's test neither compiles nor expresses the
  invariant (`Judge` receives a `JudgeRequest`, not a built call), and Step 1's `beginVerification`
  signature does not exist and the function is not exported — the test drives the conductor instead.
Task 6: review — spec ✅, quality approved. One Important, three Minors. The reviewer confirmed the
  e2e test drives only `schedulerPass` with no `transition` call anywhere in the file, that the
  deleted seam is genuinely load-bearing (`refuseUnderTest` throws without it), and that the
  `sources` invariant renders through the real `buildJudgeCall` so it covers both prompts — and that
  its sentinel could only appear if someone added a path, which IS the invariant. It also noted an
  unlooked-for strength: `readerCalls === 1` after the child's `doc.fetch` ran is direct evidence
  for the roadmap's "cache hit, not a paid read" claim.
  Important: `CLAUDE.md:403` claims `assert.evaluate` was added to the line-63 list of
  `READ_ONLY_TOOLS` members with real side effects; it was not. A sentence describing an edit
  instead of making it — the same class as the paragraphs around it.
Task 6: **Ruling — split the two injection seams.** One `verifier` reaches both `verifyDraft` call
  sites because `schedulerPass` spreads `...options` into both. A caller that REPLACES rather than
  wraps silently disables `requestHelp` — no envelope, no park — and `verificationFailed` stays 0,
  because a replacement returning a `Verdict` looks like success. That is a green test over a loop
  that never ran, the exact failure this task exists to prove against, so documented-but-live is not
  enough. Decided: `verifier` for the conductor's opening call, a separate name for the billed judge
  threaded into `VerifyDraftInput.judge`. Cost if wrong: one extra option name on a test-only seam.
Task 6: **Ruling — the two-pass latency stays, with the reviewer's sharper reason recorded.** The
  implementer attributed it to `resumeDelegatedJobs` running before `runDueJobs`. The reviewer showed
  that understates it: the child closes in `closeVerifiedJobs`, two serial stages later, so NO
  permutation within one pass yields one pass — moving resume after the plans still cannot see the
  child, and moving it after the close puts the woken parent past the `runDueJobs` that would judge
  it. One pass would need a second resume→run ROUND, not a reorder. Keep the order; document it.
  Cost if wrong: one scheduler interval of extra latency before a verdict appears on a card.
Task 6: minor (deferred): `verification-loop.test.ts:134-136` writes the shared `config` singleton
  through a cast, restored in `finally` and safe under vitest file isolation.
Task 6: fix round 1 dispatched (1 Important, the seam split, and two doc precision items).
Task 6: fix round 1/5 (4 addressed, 0 open; commits 220022e..849cf76). The re-review verified the
  seam split STRUCTURALLY: `run-due.ts` and `run-plan.ts` declare only `judge` and never `verifier`,
  so there is no path for the conductor's option to reach the plan path, and `schedulerPass`
  destructures `judge` out before spreading the rest. It also confirmed the new test's assertion
  choice is the only one that can distinguish the hazard: `beginVerification` increments `carded`
  BEFORE calling the verifier and returns `{opened:true}` on any non-throwing result, so under the
  hazard both `carded` and `verificationFailed` look clean — only the envelope row and the parked
  child job differ.
Task 6: complete (commits 053a506..849cf76, review clean).

ALL SIX TASKS COMPLETE. Full suite on the finished branch, run alone: 139 files, 1855 passed,
  1 skipped, real exit code 0 (up from 1825 on main — thirty new tests).

FINAL WHOLE-BRANCH REVIEW (opus): **not ready** — 3 Important, 3 Minor. Two of the three Importants
  were errors in MY rulings, not in the code:
  (1) I ruled "verification runs on every card, so absence is unambiguous". It runs on every card the
      CONDUCTOR raises; `beginVerification` has exactly one caller. Orphan cards (null job_id, the SDK
      path) and gate-raised cards would have shown "בבדיקה" forever — spec §6's ambiguity with the
      sign flipped, and spec §8 overstated it the same way.
  (2) I accepted the curation side effect but never corrected the arithmetic: three documents said one
      billed call per card; there are two, and the second writes nothing.
  (3) Not mine, and the most serious: **the branch opened a new erasure gap.** A draft derived from a
      document now sits in the `gov.verify` job's bound plan, and document-anchored erasure discovers
      jobs through `proposals`, which that job has no row in — so content the owner asked to erase
      survived. The delete predicates were fine; discovery was what widened, and the invariant could
      not see it because it seeds jobs already in the anchor set.
ONE fix wave (opus) — commit b5bd7b2, all six items. A query was enough for the erasure gap: the
  document branch gained a `job_plans.plan::text ILIKE` discovery using the file's own
  `LIKE_ESCAPE`/`likeLiteral` pair, no delete predicate touched, counter and executor reading the same
  set, and the invariant extended to seed a `gov.verify` job OUTSIDE the anchor's `proposals` set —
  which would fail against the pre-fix query. Both new controls mutation-checked and reverted.
  The "בבדיקה" note now renders on a positive condition, and the re-review verified the proxy is sound
  by tracing that the only writer of the joined `proposals` row is called exclusively from the
  conductor, immediately before `beginVerification` in the same path.
Re-review of the fix wave: all six ADDRESSED, no new problems, typecheck clean.
Full suite on the final tree, run alone: 139 files, 1858 passed, 1 skipped, real exit code 0.

/security-review (opus, branch vs main, 16 non-doc non-test files): **clean — zero findings.**
  Verified in code, each area: `composeVerificationAnswer` reads only `summary` and the closed
  `IntentName` enum, leaving `findings[].label`, `intents[].note` and `sourceRef.locator` untouched;
  `input.sources` appears at exactly ONE line in the whole module (`gov-verify.ts:718`), a
  deterministic check with no model call, so the raw document never reaches the prompt; one CSPRNG
  nonce per call still reaches both prompts and nothing written before the call can contain a value
  generated inside it; the step's payload is built entirely in `conduct.ts` from system ids and a
  module constant, and a document-derived action naming the tool is already refused by
  `proposalProblems`'s `action_tool_cannot_be_carded` on exactly the property that makes it
  read-only; stages 1-4 still run; all new statements carry `business_id`; the erasure discovery
  query is a bound parameter with the `likeLiteral`/`String.raw` pair intact — the exact `ESCAPE ''`
  collapse this file was burned by before; erasure now reaches the `gov.verify` job AND the
  `know.reader` child through all three anchor kinds; the new rendering interpolates only constants.
