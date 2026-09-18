# SDD ledger — plan: docs/superpowers/plans/2026-09-15-curator.md

Spec: docs/superpowers/specs/2026-09-15-curator-design.md (read — binding authority)
Branch: `curator`, cut from `main` at c8b54dd.

## RESTORE BEFORE FINISHING

`.claude/settings.json` — the Stop hook that runs `npm run typecheck && npm test`
every turn was removed for the duration of this plan and backed up to
`.claude/settings.json.sdd-backup`. It collides with subagents running the suite
against the same Postgres. **Restore it before the branch is finished.**

## Preflight scan

### Pairs that share a file or an interface

| A → B | produced | consumed | finding |
|---|---|---|---|
| T1 → T5 | `jobQualifiesForCuration(plan)` | same name, same arg | clean |
| T2 → T3 | `TouchedSubjects` | `siftCandidates(result, touched)` | clean |
| T2 → T5 | `buildCurationBrief`, `CurationBrief` | same | clean |
| T3 → T4 | `CurationResult` | parsed in `curateWithModel` | clean |
| T3 → T5 | `siftCandidates`, `MAX_CURATED` | same | clean |
| T4 → T5 | `Curator`, `curateWithModel` | injected via `CurateJobOptions.curator` | clean |
| T5 → T6 | `curateJob`, `CurationOutcome` | `closeVerifiedJobs` reads `.ran` | clean |
| T7 → T8 | `recallForPlanning` | called in `instruct.ts` | clean |
| T5 → `src/domain/audit.ts`, `src/config.ts` | `'curation'`, `curationRunsPerDay` | only T5 touches both | clean |
| T8 → `src/sdk/planner.ts` | `PlanRequest.memoryBlock` | only T8 touches it | clean |
| T9 → `views.ts`, `server.ts` | only T9 touches them | — | clean |
| T6 → `verify.ts` | only T6 touches it | — | clean |

### Each task against itself

| Task | check | finding |
|---|---|---|
| T1 | test's regex vs the code it scans | clean — the implementation carries no string literal at all |
| T2 | `job.title` used by the brief | **DEFECT — `Job.title` is `string \| null`; the plan interpolated it bare** |
| T2 | `readEmails` on step payloads | clean — steps carry `to`, which is a field `readEmails` reads |
| T3 | `SafeLookupKey.min(1).max(200)` | **DEFECT — `SafeLookupKey` is `z.string().refine(...)`, i.e. ZodEffects; `.min`/`.max` do not chain off it and Task 3 would not compile** |
| T4 | `Actor: 'orchestrator'` | clean — verified in the `Actor` union |
| T5 | `appendAudit` field set vs `erasure.ts`'s call | clean — same nine fields |
| T5 | conditional spread for `attribute` under `exactOptionalPropertyTypes` | clean; chunk conversion correctly drops it, which the DB CHECK requires |
| T6 | the close reason it rewrites | clean — nothing outside `verify.ts` asserts the old string |
| T7 | budget arithmetic in the truncation test | see ruling below |
| T8 | `readEmails({ text })` | **DEFECT — `readEmails` reads the FIELDS `to`/`recipient`/`email`; free text yields an empty list, so recall scope would always have been empty** |
| T9 | described by shape, not in full | accepted, and named in the plan's own self-review so the reviewer checks it deliberately |

Ruling: the three DEFECTS were corrected in the plan text before Task 1 was
dispatched, and committed as their own commit so the correction is visible.
- T3 becomes `z.string().min(1).max(200).pipe(SafeLookupKey)`.
- T8 exports the EXISTING `emailAddressesIn` from `typed-recipients.ts` and reuses
  it, rather than growing a second address-from-text extractor. That function is
  what standing authorisation is already gated on, and a second one would drift
  from it — the failure this codebase has repeated more than any other.
- T2 uses `job.title ?? '(ללא כותרת)'`.
Cost if wrong: none for T2 and T3 (they would simply not have compiled). For T8,
reusing the gated extractor is a slightly narrower scope than a bespoke one might
find — an address written in an unusual shape reaches standing authorisation and
recall identically, which is the property worth having.

Ruling: T6 keeps its close reason in ENGLISH, against the plan's own text which
proposed Hebrew (`'נסגר אחרי מעבר האוצֵר'`). Every sibling `transition` reason in
`verify.ts` is English (`'all steps completed — no acceptance criteria were
evaluated'`), and CLAUDE.md's Hebrew-for-humans rule covers rejection messages,
`render.ts` output and documents — not this field. One Hebrew string among English
siblings in the same function is inconsistency, not localisation.
New reason: `'closed after the curator pass'`.
Cost if wrong: one string, visible in the audit trail, trivially changed.

Ruling: T7's truncation test may adjust its `budget` number to whatever makes the
property true on the real rendered strings. What is asserted — the owner's fact
survives and the external claim is dropped first — is the control; the exact
character count is arithmetic I did in my head and should not be defended.
Cost if wrong: none; the property is what the test locks.

## Tasks

Task 1: implementer returned NEEDS_CONTEXT rather than bending a failing test —
  correct behaviour, and the contradiction it found was real. Verified by the
  controller against classify.ts directly, not taken on report:
  `crm.write` IS in OUTBOUND_TOOLS (it reaches a third-party SaaS host, and the
  set's docblock says so), and `memory.recall` DOES carry
  `ingestsExternalContent: true` (recalled memory can hold an external claim —
  which is precisely the property this whole sub-project rests on).

  Ruling: the PLAN's test case was wrong, not the predicate and not the tables.
  The derivation is spec-mandated (§4.1 names `ingestsExternalContent` and
  `OUTBOUND_TOOLS` by name), and it is the property worth having — a second
  hand-written definition of "read or communicated" is the failure this codebase
  has repeated most. The example was replaced with `mail.draft` and
  `tasks.update_state`, both verified to sit outside BOTH tables.
  Cost if wrong: none — the test now asserts the same property with an example
  that actually exhibits it.

  Ruling (consequence recorded, not fixed): a job whose ONLY step is
  `memory.recall` now qualifies for curation, because recalling our own memory
  counts as ingesting. Semantically it learned nothing new, so that is a wasted
  billed call. NOT narrowed, for two reasons: the spec mandates the derivation,
  and excluding the memory family would mean writing tool names into the very
  function whose own invariant forbids naming a tool. The exposure is cost, never
  safety, and it is bounded by CURATION_RUNS_PER_DAY.
  Cost if wrong: up to the daily cap in model calls on jobs that learned nothing.
Task 1: implementer reported DONE (commit 0dc01a7). 5/5 in the new file, typecheck
  clean, test file only changed — the implementation was never touched.
  Task review dispatched on sonnet, told to VERIFY my replacement-tools ruling
  against classify.ts rather than accept it: if either `mail.draft` or
  `tasks.update_state` turns out to qualify, the negative test now passes for the
  wrong reason and asserts nothing.
Task 1: complete (commits 5190645..0dc01a7, review clean)
  - spec ✅, quality Approved, no Critical/Important.
  - the reviewer VERIFIED my replacement-tools ruling from classify.ts rather than
    accepting it: mail.draft and tasks.update_state are both `false`/absent in both
    tables, so the negative test asserts something real. It also re-confirmed the
    original pair really did qualify.
  - three mutations run by the reviewer: dropping the isOutbound clause fails test 2,
    dropping the ingest clause fails test 1, and reintroducing a hardcoded literal
    list is caught by the scan test. All reverted clean.
  - minor (deferred): the no-tool-literal scan matches single-quoted strings only;
    a double-quoted literal would slip past. No live risk — the codebase is
    uniformly single-quoted — but it is a control that covers part of its class.
  - minor (deferred): the memory.recall cost consequence, already ruled above,
    surfaced independently by the reviewer for the cost profile.

Task 2: dispatched (BASE 0dc01a7, sonnet — the brief carries complete code, but the
  test needs real DB setup through createJob/bindPlanToJob, which is judgement).
Task 2: implementer reported DONE (commit 602e762). 4/4 in the new file, typecheck
  clean. It reported that the brief's TEST code did not match the tree and corrected
  the test rather than the implementation — the right direction, and the second time
  on this plan an implementer has refused to bend a test to fit.

  Ruling: the brief was wrong on three counts and I verified each against the tree
  rather than accept the report — `createJob` takes ONE argument and requires
  `charterVersion`, it carries no `counterpartyTags` field, and `'comm.mail'` is not
  a member of `AgentId` (`'comms.email'` is). Tasks 5 and 7 carried the IDENTICAL
  wrong shape and would each have cost their implementer the same detour, so all
  three were corrected in the plan text in one commit, and Task 2's own text was
  aligned with what was actually built so the plan stays a truthful record.
  My preflight scan checked Task 2's `readEmails` usage — the helper I was already
  suspicious of — and never checked `createJob`, which I assumed. That is the
  lesson worth keeping: the scan covered what I doubted, not what I took for granted.
  Cost if wrong: none; the corrected shape is the one the tree actually exports.

  Note (not a ruling): the brief listed `stepResults` under Consumes and
  `buildCurationBrief` never needed it — only the plan body. Harmless over-listing
  in the brief, no code impact. Named here in case a later task assumed it.

  Task review dispatched on sonnet, told to judge whether the corrected test still
  asserts what the brief intended, and to answer specifically whether `touched` can
  over- or under-collect — both directions are real defects and only one of them is
  visible from a passing test.

CORRECTION to a preflight ruling — I was wrong, and the evidence was one file away.
  I recorded `SafeLookupKey.min(1).max(200)` as a DEFECT on the grounds that
  `SafeLookupKey` is a ZodEffects and `.min`/`.max` cannot chain off it. That is
  true of zod v3 and false here: this project is on zod ^4.1.12, where `.refine()`
  preserves the string methods. Proved two ways rather than argued — `z.string()
  .refine(...).min` is a function at runtime, and `src/domain/reading.ts:92`
  already writes `SafeLookupKey.min(1)` for an entity id.
  The `.pipe()` spelling I substituted works too, so nothing was broken by the
  mistake; but it is a less direct form than the one the codebase already uses one
  file over, so Task 3 is reverted to `SafeLookupKey.min(1).max(200)`.
  What this cost: nothing in the code. What it is worth recording: I asserted a
  version-specific fact about a library without checking which version was
  installed, inside a scan whose entire purpose is to check rather than assume.

Task 2: review ❌ / Not approved — 2 Critical, 1 Important, 2 Minor. The reviewer
  confirmed the corrected test still asserts what the brief intended and is in fact
  STRONGER than the brief's version (Plan.parse instead of an `as never` cast).
  Both Criticals are defects in MY plan text. Rulings:

  Ruling: C1 enters the fix loop. `touched.recipients` collects from EVERY step with
  no outbound filter, so an email sitting in a non-outbound payload lands in the set —
  and CLAUDE.md documents exactly this for `crm.write`, where the address in the
  payload is the RECORD'S CONTENT (a new lead), not somebody we wrote to. That is
  literally the "stranger enters the set" path the control exists to close: file a
  lead today, and a curated claim about that stranger is accepted tomorrow. Fixed with
  `isOutbound`, which is the filter `buildFacts` already uses for the same question —
  not a second definition.
  Cost if wrong: the set narrows to outbound steps only, so a fact about someone named
  in a non-outbound payload is discarded. That is the safe direction of the two.

  Ruling: C2 enters the fix loop and is half the feature, not a polish item. Spec §5.1
  requires the reading's summary and findings in the brief, the module's own docstring
  CLAIMS it carries them, and nothing wires it — so a job that qualified for curation
  BY READING A DOCUMENT produces a near-empty brief. That is the primary case the
  sub-project exists for. The join is real and I verified it: `proposals` carries both
  `job_id` (018) and `reading_id` (016), and `Reading` carries `summary`, `findings`
  and `intents` whose `subject` is a closed union where only the `entity` branch has
  an id. A job with no proposal row keeps working unchanged.
  Cost if wrong: an extra query per curated job, on a path already bounded by a cap.

  Ruling: the Important (entityIds is a narrow proxy that only fires for
  memory.write_entity steps) is ABSORBED into C2's fix rather than tracked separately —
  wiring the reading's entity-kind intents IS the correct source the reviewer asked
  for, so fixing C2 dissolves it.

  minor (deferred): truncation loses the title if the title alone overflows the
  budget. Unreachable today — the ceiling is 12,000 chars and a job title cannot
  approach it. Named for the final review.

Task 2: fix round 1 returned (commit 602e762..315e303). 7/7 in the file, typecheck
  clean, both Criticals addressed failing-test-first.

  Ruling: MY C1 fix instruction was WRONG and the implementer proved it rather than
  argued it — it implemented `isOutbound(step.toolName)` exactly as I wrote it,
  watched the new test still fail, and only then substituted. `crm.write` IS in
  OUTBOUND_TOOLS, which I had myself verified and ledgered during Task 1's ruling
  three entries above, and then contradicted one entry later. `isOutbound` answers
  "does this reach outside the instance" — crm.write does, it writes to a SaaS host —
  and the question here is "is this address an ADDRESSEE or record content", which is
  a different question with a different answer for the same tool.
  The substitute is correct and is the codebase's own control for exactly this:
  `addresseeOf(refineActionClass(base, input)) === 'person'`, mirroring
  `messagesAPerson` in `risk.ts:220`, whose comment names the crm.write lead case in
  so many words. It uses refineActionClass rather than the base class, which is what
  the gate does and is stricter than what I asked for.
  Cost if wrong: none — it is narrower and correct where mine was wrong.

  Note for the re-review: `messagesAPerson` is a LOCAL const inside `scoreVisibility`,
  not an export, so the expression is necessarily duplicated rather than reused. That
  is the one place this branch now holds a second copy of a control, and the
  re-reviewer is asked to judge whether it should become a shared export.

Task 2: fix round 1/5 (2 addressed, 0 open; commits 602e762..315e303)
  Re-reviewer mutation-tested both: reverting the C1 gate turns exactly the
  crm.write test red (6/7), reverting the C2 reading block turns exactly the two
  reading tests red (5/7). Both restored clean. No new defects in the fix diff.
  It also verified the C2 join against `documentForApproval`'s existing pattern, and
  noted that EntityRef's three-way union STRUCTURALLY guarantees entity-only id
  collection — the other two branches carry no id to take.

  Ruling: the duplicated `messagesAPerson` predicate is EXTRACTED, per the
  re-reviewer's recommendation, into `src/domain/action.ts` beside `addresseeOf`,
  with both `scoreVisibility` and the new `stepAddressesPerson` calling it. The gap
  between the two sites is only where the ActionClass comes from; the predicate is
  identical, and nothing forces the copies to agree.
  The deciding argument is consistency with myself: on the erasure branch I ruled
  that fourteen hand-typed LIKE escape clauses had to become one exported fragment,
  for this exact reason and after that class of defect had already produced a
  Critical at the final gate. Declining the same extraction here, one branch later,
  would be incoherent. `risk.ts` is policy core, so the full suite runs for it.
  Cost if wrong: a one-line indirection in the risk engine, behaviour unchanged and
  covered by the existing suite.

  Ruling: the implementer's stated JUSTIFICATION for using refineActionClass is false
  and is corrected, while the CHOICE stands. Both `email.reply` and `email.initiate`
  map to 'person', and no current REFINEMENT_RULES entry flips the person answer, so
  the "mail.send without inReplyTo" example is simply wrong. Refining is still right —
  it matches the gate and buildFacts and is future-proof — but a comment that states
  a false fact is worse than no comment, because the next reader trusts it over the
  code. That is the same standard CLAUDE.md applies to itself.
  Cost if wrong: none; a comment.

Task 2: fix round 2 returned (commit 315e303..ee084c6). Full suite 110 files / 1409
  tests green, typecheck clean. No new tests — the claim is that both changes are
  behaviour-preserving and the existing suite is the proof.

  Ruling: `risk.ts` is on CLAUDE.md's /security-review trigger list, and this branch
  now touches it. The review is DEFERRED to branch level rather than run now: the
  change is a behaviour-preserving extraction of a pure predicate into the module
  that already owns `addresseeOf`, with no new branch, no new input and no widened
  reachability, and the full suite covers the gate. Running a security review per
  task on a one-line indirection would spend the attention that the whole-branch
  review needs. NAMED HERE so it cannot be lost: the branch security review must
  cover `risk.ts` and `domain/action.ts`.
  Cost if wrong: a policy-core change reaches the branch review unexamined rather
  than unreviewed — it is still reviewed, just later and in context.

  Re-review of round 2 dispatched, with one question that no test answers on its own:
  the implementer claims the full suite proves a behaviour-preserving extraction in
  the RISK ENGINE. The reviewer must name an existing test that would have gone red
  had `scoreVisibility`'s answer changed — and say plainly if it cannot find one,
  because then the claim rests on nothing.
Task 2: fix round 2/5 (2 addressed, 0 open; commits 315e303..ee084c6)
Task 2: complete (commits 0dc01a7..ee084c6, review clean)
  - the re-reviewer ANSWERED the coverage question rather than deflecting it: it
    named `visibility-scoring.test.ts`'s "does not escalate a record-keeping write
    that merely contains an address" — the crm.write case itself — plus four
    siblings, then INVERTED `messagesAPerson` in place and watched 6 tests go red
    across visibility-scoring and positive-controls. The implementer's
    behaviour-preserving claim is supported by evidence, not by assertion.
  - extraction verified byte-identical and parameterised, exactly one surviving
    definition repo-wide, and the crm.write-lead reasoning moved into the exported
    docblock rather than being left behind.
  - the replacement comment was independently re-verified against REFINEMENT_RULES
    and ACTION_ADDRESSEE, so a wrong claim was not swapped for another wrong one.

Task 3: dispatched (BASE ee084c6, haiku — the brief carries complete code for a pure
  module with no DB; transcription plus one mutation check).
Task 3: implementer reported DONE (commit cb6d2ba). 7/7 in the new file, typecheck
  clean. Disabling the control failed exactly two tests — the untouched-subject
  rejection and the mixed-batch sift — which is the pair the brief predicted.
  Task review dispatched on sonnet.

Task 3: review ✅ spec / Not approved — 1 Important, 0 Critical, 0 Minor.
  The reviewer ran the mutation ITS OWN WAY (whole-loop bypass rather than the
  implementer's `if(false)`), reproduced the same two failures, and then went
  further: it independently mutated each of the other four checks one at a time —
  weakening SafeLookupKey, dropping the MAX_CURATED cap, dropping the attribute
  refine, neutering the body ceiling — and each failed exactly and only the test
  claiming to cover it. All restored with an empty diff each time.

  Ruling: the case-sensitivity finding is REAL and enters the fix loop — and the fix
  is larger than the reviewer proposed. Case-folding the comparison alone closes the
  silent rejection but opens a worse one a step downstream: the candidate would then
  be accepted and WRITTEN with whatever casing the model chose, and `recallMemories`
  matches `subject_key` by exact equality — so the memory is stored and never found.
  A silent rejection would have become a silent orphan, which is worse because
  nothing reports it at all.
  Therefore: match case-insensitively, but write the CANONICAL value from the touched
  set, via one `Map<lowercased, canonical>` so the match and the canonical form come
  from a single structure rather than two that can disagree. What is stored is then
  the spelling recall asks for by construction.
  Cost if wrong: entity ids are folded too. They are lower-kebab by convention so
  nothing changes today, and one comparison rule beats two that differ by subject
  type.

  Note: the reviewer did not raise the recall-orphan half. I found it by following
  its finding one step downstream, and it is the half that would have hurt more.
Task 3: fix round 1 returned (commit cb6d2ba..b872e81). 10 tests green, typecheck
  clean. The Map<lowercased, canonical> was built as specified, and the implementer
  reported honestly that the THIRD new test (the stranger still rejected) passed
  immediately rather than failing first — which is correct and is what that test is
  for: it is a regression guard on a control that must not loosen, not a new
  behaviour being driven in.
Task 3: fix round 1/5 (1 addressed, 0 open; commits cb6d2ba..b872e81)
  Re-reviewer attacked the real lookup with five adversarial cases — genuinely
  different, superstring, substring, prefix-padded, entity-superstring — and exact
  `Map.get` rejected all five. The canonical rewrite was confirmed on what is
  RETURNED, not merely matched. Production code is correct.

  Ruling: I am OVERRIDING the re-reviewer's grading of its own finding. It graded the
  test-coverage gap "follow-up Minor, clean to merge"; it enters a fix round instead.
  It proved by mutation that changing the lookup to SUBSTRING matching leaves all ten
  shipped tests green while four of its own scratch tests go red. So the test suite
  for the control this branch's entire safety argument rests on cannot distinguish an
  exact match from a substring match.
  What makes it more than a Minor is the sequence: round 1 LOOSENED a comparison in
  this exact function, and loosening a comparison is precisely how a control stops
  biting in silence. The guard that should have caught that cannot see it. "A test
  that stays green under the mutation it exists to catch is not a test" is this
  codebase's own rule, and it applies hardest to its most important control.
  The superstring case is the one an attacker reaches for — a domain that CONTAINS a
  trusted one.
  Cost if wrong: four test cases and one round, on the branch's central control.
Task 3: fix round 2 returned (commit b872e81..4192e43). 14 tests green, typecheck
  clean, NO production change — as instructed, since a production edit here would
  have meant the control was not what the re-reviewer measured.
  Under the substring mutation, three of the four new tests go red: superstring,
  prefix-padded, and entity-superstring. The implementer reported honestly that the
  fourth stays green and called it "decorative".

  Ruling (provisional, pending the re-reviewer): I think the implementer UNDERSOLD
  its own test and I have asked for it to be settled by measurement rather than by my
  opinion. A substring match can be loosened in two directions, and both the
  implementer's mutation and the re-reviewer's tested only one — candidate contains
  touched. The fourth test (candidate is a substring of a touched address) is the one
  that would fire under the OPPOSITE loosening, `touched.some(t => t.includes(cand))`,
  which is an equally plausible bad rewrite. If that holds, the four tests cover both
  directions and none is decorative.
  I told the implementer to REPLACE any test that stays green under the mutation; it
  kept this one instead. Rather than enforce my own instruction literally, I am having
  the question measured — the instruction existed to prevent tests kept for
  appearance, not to delete a test that guards a direction nobody thought to mutate.
  Cost if wrong: one test that asserts something true but catches nothing, in a file
  whose other thirteen tests have each been watched biting.
Task 3: fix round 2/5 (1 addressed, 0 open; commits b872e81..4192e43)
Task 3: complete (commits ee084c6..4192e43, review clean)
  - SETTLED by measurement, and my reading was right: the re-reviewer ran BOTH
    mutation directions. Direction A (candidate.includes(touched)) fires superstring,
    prefix-padded and entity-superstring; Direction B (touched.includes(candidate))
    fires ONLY the substring-of-email test. The four tests are two pairs covering
    both sides of a two-sided vulnerability and none is redundant.
  - the implementer's own "decorative" characterisation of its fourth test is
    therefore WRONG, and the correction is recorded here rather than dispatched as a
    round: it is a sentence in a report, not code, and the implementer's honesty in
    flagging it is worth more than the inaccuracy costs. The final reviewer reads
    this ledger, so the correction lands where it matters.
  - production code verified byte-identical across the round — `git diff` on
    curation-parse.ts is empty — which is what I asked for, because a production edit
    here would have meant the control was not what had been measured.
  - all 14 tests are load-bearing; each has now been watched failing under a mutation
    aimed at it.

Task 4: dispatched (BASE 4192e43, haiku — one small SDK-calling module that mirrors
  planner.ts, with a refusal guard; transcription plus one test).
Task 4: implementer reported DONE (commit 37c2119). 1 test, typecheck clean.
  Task review dispatched on sonnet with one instruction beyond the usual: prove the
  refusal is REACHED before any billable work, not merely present in the file.

Task 4: review ✅ spec / Approved — but 2 Important, 2 Minor, all entering the loop.
  The guard itself is confirmed: literal first statement, reads config.isTest rather
  than re-deriving NODE_ENV, and no other export can reach the SDK.

  Worth recording about the REVIEWER's method: it deliberately did NOT delete the
  billing guard to watch the test fail, because on this machine that risks the very
  live billed call the guard exists to prevent. It reasoned statically instead and
  said so plainly. That is the right call — a mutation test is not worth performing
  when performing it is the harm.

  Ruling: the `env` finding enters the loop and is the more serious of the two.
  Omitting `env` means the SDK subprocess inherits the FULL process.env — the API
  key, DATABASE_URL, all six SMTP variables — where planner.ts deliberately passes
  `{ PATH }`. It matters MORE here than for the planner, not less: the curator's
  input is a brief built from a document somebody else wrote, and its own docstring
  calls it a quarantine reader whose input is hostile by definition. Handing the
  process that reads hostile content a copy of every credential the installation
  owns is the opposite of quarantine. Not exploitable today — `tools: []` leaves the
  model no way to act on what the process can see — but "not reachable through the
  door we happened to close" is not "not there", and a boundary documented as a
  control must be the control.
  Cost if wrong: none; it is the narrower environment the sibling already uses.

  Ruling: `extractJsonObjects` is EXPORTED from planner.ts and called, not copied.
  Identical reasoning to the messagesAPerson extraction one task ago, and refusing it
  here while having required it there would be incoherent. The naive span fails SAFE
  today — the reviewer worked through prose-before, prose-after, two objects and an
  illustrative example, and JSON's grammar makes a misaligned span throw — so this is
  a robustness regression against a sibling that already solved it, not a live defect.
  Cost if wrong: one more export from a module this branch already touches.

  Ruling: the two Minors are fixed in the same round rather than deferred, because
  both are "a difference that exists by accident". The permissionMode/maxTurns one is
  explicitly allowed to be resolved EITHER way — mirror them, or leave them out with
  a comment saying why the curator does not need them. What is not acceptable is the
  difference remaining unexamined.
Task 4: fix round 1 returned (commit 37c2119..d25d9ae). Curator 1/1, planner 14/14,
  typecheck clean. `extractJsonObjects` exported and called rather than copied;
  `env` restricted to PATH; message reading moved to the terminal result message;
  permissionMode and maxTurns added.
  Verified by the controller directly: env, permissionMode and maxTurns now match
  planner.ts byte-for-byte, so they are the sibling's values and not invented ones.
  know-reader.ts carries the same env expression and maxTurns: 12 — a third caller
  agreeing on the env shape, which is what a real convention looks like.
  Re-review dispatched, with one addition: the implementer justified maxTurns: 3 as
  "multi-turn self-correction", and the reviewer must judge whether that is TRUE for
  this call or whether the honest reason is "mirrors the planner". A comment stating
  a false rationale is worse than none, and that has already happened once here.

Task 4: fix round 1/5 (3 addressed, 1 open; commits 37c2119..d25d9ae)
  Closed and verified: env byte-identical to planner's with nothing re-widening it;
  extractJsonObjects with exactly one definition and parsePlan's call site untouched;
  the curator's selection loop picks the first schema-valid candidate, the same
  discipline parsePlan uses.

  Ruling: the maxTurns comment is FALSE and gets its own round, cheap as it is. Per
  the SDK's own docs a turn is a user message plus an assistant response, and with
  `tools: []` there is no tool round-trip and no mid-query feedback path — so the
  query always ends after one turn and the "self-correct on invalid JSON" mechanism
  the comment describes does not exist. The VALUE is right and stays.
  This is the SECOND false rationale on this branch: Task 2 shipped one about
  refineActionClass and had to correct it too. Both times the decision was right and
  the stated reason invented, and both times a reviewer had to consult the primary
  source to discover it. That is a pattern, not an incident. A comment stating a
  false fact is worse than none, because the next reader trusts it over the code and
  stops checking — which is precisely the habit this file's comments exist to reward.
  Cost if wrong: a round spent on a sentence.

  parked: on a non-success terminal message `raw` stays empty and the caller sees
  "no JSON object in the response", masking the true cause. Ruling: NOT fixed here.
  The flaw is PRE-EXISTING in planner.ts and the curator mirrored it faithfully,
  which was the correct instruction to follow. Fixing it belongs to a change that
  owns the planner's error path; doing it from a curator task would edit a
  sibling's error handling as a side effect. Named for the final whole-branch review.
  Cost if wrong: a misleading error message on a rare SDK failure, in two places
  rather than one.
Task 4: fix round 2/5 (1 addressed, 0 open; commits d25d9ae..a7e4651)
Task 4: complete (commits 4192e43..a7e4651, review clean, 1 parked)
  - comment-only diff confirmed: lines 58-59 alone, with env and maxTurns untouched.
  - the implementer audited the file's other three comments unprompted and the
    re-reviewer spot-checked all three: docstring describes fact, env comment states
    the quarantine reason, JSON comment describes process. No mechanism claims.
  - parked (carried to the final review): on a non-success terminal SDK message
    `raw` stays empty and the caller is told "no JSON object in the response",
    masking the real cause. Pre-existing in planner.ts and faithfully mirrored.

Task 5: dispatched (BASE a7e4651, sonnet — the curator itself: DB writes, the daily
  cap, the conflict rule and the audit row. Multi-file, real judgement, and the one
  task where getting provenance wrong would matter most).
Task 5: implementer reported DONE (commit 46146ed). 7/7 in curate.test.ts, full suite
  1430/1431 with one dashboard concurrency-race failure that passes in isolation —
  a documented flake in this project, and the review was asked to confirm rather than
  accept that.

  Ruling: my Task 5 test example carried the SAME crm.write error I had already
  corrected in Task 1 — I fixed the one I was looking at and missed its twin. The
  implementer caught it and substituted mail.draft, citing Task 1's own test as the
  evidence rather than asserting it. Plan text corrected.
  This is the second time on this branch that a correction I made in one place
  failed to reach its duplicate elsewhere (the createJob shape was the first, caught
  across Tasks 2/5/7). The lesson is the same both times: when a fix applies to a
  pattern, search for the pattern instead of fixing the instance in front of me.
  Cost if wrong: none — caught by the implementer before any code depended on it.

  Also accepted: unique charter version per seedJob call, avoiding a primary-key
  collision when one test seeds two jobs. Matches the pattern local-tools.test.ts
  already uses.

  Task review dispatched on OPUS rather than sonnet — this is the task where the
  gate-bypass argument either holds or does not, and the three controls that replace
  the gate all live or die here.

Task 5: review ❌ / Not approved — 1 Critical, 5 Important, 4 Minor. The opus review
  earned its cost: it found the Critical by PROBING THE REAL DATABASE with throwaway
  tests rather than reading the assertions, and it confirmed the dashboard flake was
  unrelated by noting curateJob has zero production callers, so nothing in this
  commit even runs during that test. Rulings:

  Ruling: C1 is real and enters the loop. `resolveConflict` finds the row it exists
  to protect via `recallMemories`, which is LIMIT-ed and newest-first — so a
  boss-sourced preference sitting behind a few newer live rows on the same subject is
  INVISIBLE to the guard, the check falls through, and a stranger's claim retires the
  owner's row. That is decision 3 inverted in exactly the case it was written for.
  The fix is to ask the question actually meant: a direct query for the live row at
  this exact (kind, subject, attribute), not a paged recall filtered afterwards in JS.
  `recallMemories` answers "what do we know about this subject"; the guard needs "is
  there a live row at this key", and only one of those is bounded by a limit.
  It is also the THIRD false rationale on this branch — the comment asserts "the
  owner's row stays the live fact", which is untrue in precisely that case.
  Cost if wrong: the single most important behaviour the owner chose, silently
  reversed, with a comment claiming otherwise.

  Ruling: I2 is a COST hole, not a tidiness one, and that is why it enters the loop
  rather than being deferred. A billed call that throws writes no audit row, so the
  daily cap never advances for it — a model failing repeatedly would cost money all
  day while the cap sat still. The failure path must write the row.

  Ruling: I3's catch stays broad enough that no job can fail — that part of the
  design is right — but it must stop being SILENT. A TypeError in our own code
  currently looks identical to a model timeout. Record it and return a discriminator.

  Ruling: I4 — the docstring says nothing here can fail a job, and four awaited calls
  sit outside the try. Either is acceptable; the mismatch is not. I asked for the
  promise to be KEPT rather than narrowed, but said plainly that a true narrow
  statement beats a false broad one.

  Ruling: the conflict-branch tests must assert against DIRECT SQL for live rows, not
  through `recallMemories`. That is what §10 asks for, and it is not a stylistic
  preference: reading the state through the same limited helper the guard used is
  what hid C1 in the first place.

  parked: the plan body is loaded twice (once by curateJob, once inside
  buildCurationBrief). Ruling: not fixed — one extra indexed read on a path already
  bounded by a daily cap, against the churn of threading a loaded plan through a
  signature that is clean today. Named for the final review.
  parked: the cap is read without a lock, so two concurrent scheduler passes could
  each see the same count and both proceed. Ruling: not fixed — the overrun is at
  most one extra call per concurrent pass, the scheduler already serialises jobs by
  advisory lock, and locking a counter read would be the first such lock in this
  area. Cost if wrong: slightly exceeding a cost ceiling that exists to bound, not to
  forbid. Named for the final review.

Task 5: the implementer lost its place mid-round — it signed off saying it would
  "wait for a background task's completion notification", as though it were a
  controller. Nothing was running for it. I checked the tree MYSELF before nudging:
  the work was complete and merely uncommitted (341 new lines, the direct SELECT in
  resolveConflict, all twelve tests present), so the recovery was a four-step
  instruction to verify and commit rather than a re-dispatch. Worth noting as a
  failure mode: a confused sign-off does not mean absent work, and re-dispatching
  without looking would have thrown away a finished round.

Task 5: fix round 1 returned (commit 46146ed..48e0a75). 12/12 in the file, typecheck
  clean, full suite 1436/1436 across 113 files.
  The C1 regression was WATCHED FAILING first, with the exact right symptom:
  `expected 'unknown_external' to be 'boss'` — the stranger's claim sitting in the
  live preference where the owner's belonged.
  A first full-suite attempt showed 93 failures, traced to a collision with a
  leftover background `npm test` process finishing at the same moment; the solo
  re-run was green. That matches this project's known behaviour exactly — an
  overlapping run is a collision, not a regression.

Task 5: the opus re-review died on an account session limit before writing anything.
  Its ORIGINAL review survives in task-5-review.md (sections 1-4 plus Findings); only
  the fix verification was lost, so nothing had to be redone twice.

  Ruling: re-dispatched on sonnet rather than waiting for the opus window. Same
  reasoning as the erasure branch's final review, and compensated the same way —
  rather than asking for a verdict, I named the METHOD that found the Critical in the
  first place: write throwaway probes against the real database, seed an owner
  preference behind several newer live rows, and query `memories` directly to see
  whether it survived. I also named the two code checks that matter (the new query
  must not be limited/ordered in a way that hides a row, and must match the SAME key
  writeMemory's retire acts on — a guard reading a different key than the writer
  writes is the same defect in new clothing).
  Cost if wrong: a subtler defect survives to the branch review. If the verdict comes
  back thin rather than clean, re-run on opus after the reset instead of accepting it.
Task 5: fix round 1/5 (6 addressed, 0 open; commits 46146ed..48e0a75)
Task 5: complete (commits a7e4651..48e0a75, review clean, 2 parked)
  - the re-reviewer designed its OWN probe and, finding it a false negative on both
    fixed and buggy code, DISCARDED it and explained why rather than reporting a
    pass: its first design used different subject keys and the `entity` kind, where
    recallMemories filters by subject anyway and an entity cannot have two live rows.
    Its second design — the owner's row buried behind 25 newer live rows on DIFFERENT
    ATTRIBUTES of the same subject, exceeding both the old limit and MAX_RECALL —
    passed on the fix and failed on a temporary revert to 46146ed with the exact
    reported symptom. That is what verifying a fix looks like.
  - the new query is keyed `(business_id, kind, subject_key, attribute IS NOT
    DISTINCT FROM $4) AND retired_at IS NULL` — the SAME predicate writeMemory's
    retire acts on, which was the specific thing I asked to be checked.
  - the two pre-existing conflict tests now assert via direct SQL, so they are no
    longer capable of hiding a C1-shaped bug.
  - no fourth false rationale: both previously-flagged sentences were corrected to
    match behaviour.
  - full suite 1436/1436 run solo, with the reviewer verifying no leftover test
    process was running before trusting the number.

Task 6: dispatched (BASE 48e0a75, sonnet — wiring the curator into closeVerifiedJobs.
  Small diff, but it is production orchestration and it changes a reason string every
  job close writes).

Task 6: implementer reported DONE (commit 53ad91b), full suite 1437/1437 across 113
  files, typecheck clean — and flagged UNPROMPTED that the test I specified would
  still pass with the `curateJob` call deleted. It was right, and right again not to
  redesign a test the brief named verbatim.

  Ruling: the weak test enters a fix round; the brief was mine and it was wrong.
  `expect(result.curated).not.toContain(jobId)` asserts against a field initialised
  to `[]` regardless of whether curation runs, so it holds with the call removed —
  this project's most-repeated defect, and it lands hardest here because Task 6's
  entire purpose is that the call happens.
  The fix follows this codebase's OWN pattern rather than inventing one: `runPlan`
  takes `bindings` as a parameter precisely so a test can inject, and CLAUDE.md
  records that as deliberate. `closeVerifiedJobs` gains an optional `curator` threaded
  through to `curateJob`, which already accepts one from Task 5 — a pass-through, not
  new machinery. The new test asserts the job closed, the job is in `curated`, AND a
  memories row exists.
  The EXISTING test stays: "a job still closes when curation does not run" is the more
  important property — it is what stops a model outage stranding finished work. It
  simply needed a sibling proving the wire exists at all.
  Cost if wrong: one optional parameter on a production function, unused in production.

  Also asked: what the presence of ANTHROPIC_API_KEY in the test environment means for
  curateJob's path — whether it reaches curateWithModel and takes the refusal, or
  short-circuits at `no_key`. Those are different paths with possibly different
  observable results, and the existing test's NAME should say which one it covers.

  Note: this implementer used a `Co-Authored-By: Claude Sonnet 5` trailer rather than
  the Opus line the chat asked for, reasoning that its own system-level instruction
  outranks an in-conversation request. That reasoning is correct and the trailer is
  more accurate than uniformity would have been. Left as it is.
Task 6: fix round 1/5 (1 addressed, 0 open; commits 53ad91b..ab32486)
Task 6: complete (commits 48e0a75..ab32486, review clean)
  - the reviewer disabled the curateJob call ITSELF and watched exactly the
    injected-curator test fail on the `result.curated` assertion while `result.closed`
    still passed — which is the precise shape that proves the wire, not the closing.
  - the ANTHROPIC_API_KEY deletion IS restored, in a `finally`, and only when it was
    set to begin with. No leak into the shared test process. That was the question I
    most wanted answered and the answer is the safe one.
  - it also confirmed the production caller (scheduler.ts) passes no `curator`, so the
    injection seam is genuinely test-only, and that the `runPlan`/`bindings` precedent
    cited in the new docblock is accurately described rather than merely invoked.
  - minor (deferred): `curated`'s docblock says "actually sent to the curator", which
    is also true in the rare partial-write-then-fail case, not only clean success.
  - minor (deferred): the pre-existing "Already past the curator" comment on the
    remember-already branch is only true BECAUSE of the ordering this task introduced;
    the comment sits outside the diff's hunks and was not updated to say so.

Task 7: dispatched (BASE ab32486, haiku — the brief carries complete code; a module
  that reads memory and renders a block, with DB-backed tests).
Task 7: implementer reported DONE (commit d4d9ea0). 5/5, typecheck clean, and it
  reported that the budget number needed NO change — 120 exercises the property as
  written. Task review dispatched on sonnet.

Task 7: review ✅ / Approved — 4 Minor, no Critical or Important. The labelling is
  the correct POSITIVE shape (`boss` plain, everything else attributed), so all four
  non-boss TrustLevel members fall into the attributed branch automatically and so
  would a member added next year. The reviewer mutated both the label and the sort
  comparator and watched exactly the right tests fail, and it computed the real
  string lengths to confirm budget 120 forces the cut rather than passing by accident.
  Rulings:

  Ruling: the missing `limit` enters a fix round despite being graded Minor. With no
  limit `recallMemories` defaults to FIVE rows per subject, where spec §7.2 says
  MAX_RECALL (20) is the ceiling — so the block is four times narrower than intended,
  and a contact with a dozen remembered facts surfaces only the five newest. Retrieval
  thin enough to miss the fact you needed is not much better than none, and this is
  the half of the feature the owner asked for by name.
  Cost if wrong: a longer block, trimmed by the character budget that exists for it.

  Ruling: `continue` becomes `break` in the truncation loop. Today a shorter later row
  takes space a longer earlier row was denied — greedy best-fit rather than a cutoff
  by priority, and priority is the entire point of the ordering. Note the interaction
  that makes this more than cosmetic: with 20 rows instead of 5, truncation will bite
  far more often than it does now.

  Ruling: the subject-order dependence is DOCUMENTED, not fixed. Rows from all
  subjects are pooled and sorted by provenance only, and Array.sort is stable, so a
  later subject can be squeezed out entirely and silently when the first subject's
  facts fill the budget. Interleaving subjects fairly is a larger design question than
  this task should settle — but a silent limitation is worse than a stated one, so the
  docblock must say it and a test must pin it.
  Cost if wrong: under budget pressure the block favours whichever subject was named
  first, which is at least deterministic and now written down.

  Ruling: the spec's three-tier order collapsed to two tiers stands. It matches the
  brief's own reference code, and the security-critical half — external claims last
  and dropped first — is intact. Refining the middle tier is worth doing when there is
  a reason, not because a spec sentence happens to enumerate three things.

Task 7: fix round 1 returned (commit d4d9ea0..b50f98f). 6/6 in the file; the
  implementer reported typecheck only, so the CONTROLLER ran the full suite —
  114 files / 1444 tests green — rather than send a reviewer to discover the gap.

  Re-review: items 1 and 3 clean (limit is the imported MAX_RECALL constant, value 20,
  not a literal; subject-order pinning verified by reversing the processing order and
  watching only the new test fail). It also answered the question I asked about test
  rot: NO original test now passes for a different reason — all five write at most two
  memories per subject, far under both the old and new per-subject limits, so the 4x
  fetch never engages for them.

  Ruling: the `continue`→`break` fix has NO regression coverage and gets its own round.
  Toggling it back to `continue` still passes 6/6, because the row the existing test
  excludes happens to be LAST in the pool — so the two behaviours are indistinguishable
  for it, there being nothing after it to reconsider. The distinction only appears when
  a row that does not fit is followed by a shorter one that would.
  This is the same shape I already promoted to a fix round on Task 3, and applying it
  there and not here would be inconsistent. The new case must keep all three rows in
  ONE provenance tier — straddling the boundary would let the sort reorder them and the
  test would measure the sort instead of the loop.
  Cost if wrong: one test, on a loop whose correctness is otherwise unguarded.

  Also asked for: a correction to the report's own prose, which claims the new test
  pins the break fix when it pins subject-order only. Not a source comment so it does
  not join the false-rationale tally — but the reports are what the final review reads,
  and an overclaim there costs a reviewer real time.
Task 7: fix round 2/5 (1 addressed, 0 open; commits b50f98f..d9cacc2)
Task 7: complete (commits ab32486..d9cacc2, review clean)
  - the re-reviewer ran the mutation itself: under `continue` both the newest and the
    oldest row appear and the huge one is skipped; the new assertion catches exactly
    that. Restored, 7/7.
  - all three seeded rows are boss-provenance, so the sort cannot reorder them and the
    test measures the LOOP rather than the sort — the specific trap I named.
  - production file diff confirmed EMPTY across the round.

Task 8: dispatched (BASE d9cacc2, sonnet — putting the memory block into the planner
  prompt. Small diff, but it touches the most heavily cached text in the system and
  the instruction door's live path).

Task 8: implementer returned NEEDS_CONTEXT — the fourth time on this branch an
  implementer refused to bend a test, and the fourth time it was right.

  Ruling: the defect is MINE and the `as never` cast is what hid it. The brief's test
  called `buildPlannerPrompt({ instruction, memoryBlock } as never)` with no `bundle`,
  and the function builds the capability catalogue from `request.bundle` before
  reaching anything the task adds — so it crashed on `provenanceCeiling` regardless of
  the implementation, both before and after. Had it "run", it would have compared two
  crashes.
  The cast is the lesson: `as never` silenced the compiler on a request that could not
  work. I wrote it to avoid constructing a real bundle, and the type system was trying
  to tell me the object was wrong.
  The corrected test mirrors the file's OWN sibling — `'puts the varying part last so
  the cached prefix survives'` — which already does this properly with the existing
  `bundle()` helper, and asserts the block's index is GREATER than the instruction's,
  which is what proves position rather than mere presence.
  Cost if wrong: none; the production code was already complete and typechecking.

  Told the implementer to verify the section heading against the source rather than
  trust my quotation of it, since I was quoting the plan from memory and not the file.
Task 8: implementer reported DONE (commit e4a5eb7). 114 files / 1446 tests green,
  typecheck clean. It found that `intents: []` was ALSO required and ALSO hidden by
  the same `as never` cast — caught by tsc, never by vitest — and it verified the
  corrected test fails for the right reason (`indexOf` returning -1, block absent) by
  stashing ONLY planner.ts, running, and restoring. That is the proof I asked for and
  it did it the careful way.
  Task review dispatched on sonnet.

Task 8: review ✅ / Approved — 2 Important, 2 Minor. The reviewer forced the memory
  block ABOVE the catalogue itself and watched the cache test fail, so that property
  is locked rather than vacuous. Rulings:

  Ruling: the missing error handling enters the loop, and it corrects an assertion I
  made in the review brief. I told the reviewer the recall step could not fail the
  instruction; it checked and I was wrong — the call sits OUTSIDE the existing try and
  an uncaught throw strands the job in `understand`, which is the exact failure the
  next lines of that same file guard against for the planner. A failed recall must
  degrade to NO MEMORY BLOCK, never to a failed instruction: planning without the past
  is worse than planning with it, and not planning at all because a read failed is
  worse than both.
  Cost if wrong: none — it is strictly more forgiving than today.

  Ruling: the untested wiring enters the loop. `planner.test.ts` proves placement of an
  already-built string; `instruct.test.ts` never mentions recallForPlanning or
  memoryBlock. So deleting the recall call would leave the whole suite green — the
  same defect Task 6 shipped and fixed, and it is not acceptable twice.
  `runInstruction` already accepts an injected planner, so the PlanRequest it is handed
  can be captured and asserted on directly.

  Ruling (SURFACES TO THE OWNER, not fixed here): the scope is NARROWER than decision 2
  implies, and the reviewer proved it with the brief's own example. `emailAddressesIn`
  finds literal address tokens only — it was built for the authorisation question "did
  the owner type this address", not "which parties does this job touch". So an ordinary
  instruction like "תשיבי לרונית" names nobody by address, yields no subjects, and the
  planner gets no memory at all. Automatic recall therefore fires only when the owner
  types a full address, which is not what "before every plan" was chosen to mean.
  This is a consequence of MY instruction to reuse the authorisation extractor rather
  than grow a second one — and that instruction was still right; two extractors drifting
  apart is the worse failure. Closing the gap needs a resolver from a NAME to a subject
  key, which does not exist and is a task, not a fix round.
  Required: the docblock must state the limitation plainly, Task 10's roadmap note must
  record it, and it goes in the final report to the owner.
  Cost if wrong: decision 2 is delivered in mechanism but only partly in practice.
Task 8: fix round 1/5 (2 addressed, 0 open; commits e4a5eb7..c1c9b9f)
Task 8: complete (commits d9cacc2..c1c9b9f, review clean)
  - both Importants verified BY BREAKING them, not by reading: the reviewer made
    recallForPlanning throw unconditionally and watched runInstruction still return
    `planned` with no orphan; and it removed the recall call and watched the new
    wiring test go red on `memoryBlock` staying undefined.
  - the recall's catch mirrors this file's OWN bare-catch shape (`recordQuestion`,
    swallowed by design) rather than the planner's fail-hard catch — which is the
    correct one of the two to copy, since a failed recall must degrade and a failed
    plan must not.
  - the docblock now states plainly that recall scope is literal-address-only.

  Ruling: the report cites `docx.ts:487-501` as precedent for its object-wrapper
  capture workaround, and the reviewer checked: that file uses a plain reassigned
  `let`, which is the very pattern the report says triggers the TS bug. The
  workaround itself is sound — the reviewer reproduced the `never`-narrowing
  independently — but the citation is false.
  This is the FOURTH inaccurate citation on this branch. The other three were in code
  comments and each cost a reviewer a trip to a primary source; this one is in report
  prose. I am recording the correction here rather than spending a round on it, since
  the ledger is what the final review reads — but the pattern itself now belongs in
  Task 10's documentation, because four instances is a habit, not a run of accidents.
  Cost if wrong: a future reader copies a workaround believing a precedent that is not
  there.

Task 9: dispatched (BASE c1c9b9f, sonnet — the owner-facing screen. The plan describes
  it BY SHAPE rather than in full, which the plan's own self-review flagged; the
  dispatch names the one rule that matters, escLabel over esc).

Task 9: implementer reported DONE (commit 1433915), 115 files / 1450 tests green,
  typecheck clean, suite run twice in the foreground. It disclosed three limitations
  of its own accord.

Task 9: review ✅ / Approved — 1 Important, 2 Minor. The reviewer proved the bidi
  control by MUTATION: it reverted escLabel to esc on both fields and watched the raw
  U+202E survive the render. It also killed the provenance label and watched the right
  test fail. Rulings:

  Ruling: the missing nav link enters a fix round, though the reviewer said it would
  not block. There is no link to /memory from anywhere — the pending list points to
  /instruct and /readings, /instruct points to /, /readings and /erase, and nothing
  points at the new screen. A screen reachable only by typing a URL is built, not
  delivered. A test must assert the link, because without one a future edit removes it
  and nothing notices — which is exactly how it came to be missing.
  Cost if wrong: one link and one assertion.

  Ruling: I am UPGRADING the reviewer's Minor on `memoryValue()` using `esc` rather
  than `escLabel`. Its grading was defensible — `renderReadings` does the same, so it
  is not a regression — but the reason it matters here is specific to this screen:
  this is the one page whose entire job is to show the owner, faithfully, what the
  assistant believes, and a chunk body is precisely where an EXTERNAL claim lands. A
  bidirectional override inside that text makes a line render as something other than
  what is stored, on the screen built to audit exactly that. `esc` neutralises tags
  and does not touch the override family.
  Scoped strictly to this screen: touching renderReadings from a curator task would be
  a side effect nobody reviewed.
  Cost if wrong: nothing; escLabel strips overrides, not Hebrew letters.

  Recorded, not fixed: retired memories are invisible because recallMemories hardcodes
  `retired_at IS NULL` with no override (attribution confirmed honest by the reviewer;
  §8 does not require history), and the screen shows at most 20 rows because it reuses
  a recall-into-a-prompt function for browsing. Both are real limitations of that reuse
  and both are fine at today's volume.
Task 9: fix round 1/5 (2 addressed, 0 open; commits 1433915..5c2da3b)
Task 9: complete (commits c1c9b9f..5c2da3b, review clean)
  - both fixes verified by mutation: deleting the nav link fails the new link test;
    reverting memoryValue to `esc` lets the raw U+202E survive into the value column.
  - the link went onto /instruct beside /erase — a page the owner actually passes
    through, which was the specific thing I asked be checked rather than assumed.
  - escLabel change confirmed scoped to memoryValue() alone; renderReadings and every
    other esc( call site untouched.
  - the two recorded limitations are stated in the report at full strength rather than
    softened, so the final review inherits them stated.

Task 10: dispatched (BASE 5c2da3b, sonnet — documentation. It must describe the tree
  AS BUILT: eight things changed after the plan was written, and CLAUDE.md is the file
  readers trust over the source).
Task 10: complete (commit 99d9bec). npm test measured solo in the foreground —
  115 files / 1451 tests; CLAUDE.md's count updated 1386 → 1451.
  All eight as-built corrections verified against source; nothing was wrong.
  It also grounded the new citation-hygiene rule in all FOUR documented incidents by
  reading the ledger rather than inventing an example — including one I had not listed
  in its dispatch (Task 5's resolveConflict comment asserting "the owner's row stays
  the live fact", false in exactly the case the guard exists for).

Final review: SHIP. Fix wave (99d9bec..3b6bb91) + tidy-up (34c2b41). 115 files /
  1453 tests. All four wave items closed and verified: the re-reviewer deleted the
  `limit` argument itself and reproduced the exact symptom (FACT_1..FACT_3 silently
  missing), and confirmed buildRuntime CANNOT throw where it previously returned
  warnings — the degrade-don't-stop contract holds, so a missing key costs curation
  and never the scheduler's approval expiry.
  Documentation judged honest end to end across all four documents.

  Ruling: D1 — the docblock this wave wrote contradicted itself, which is the same
  class of defect the wave was sent to close and the one Task 10 added a rule for.
  Corrected by sentence, not by a new field, and I asked the implementer for its
  OPINION rather than dictating: it argued a mid-attempt throw already leaves a
  `curation` audit row, does not stop the job closing, and does not belong in
  `errored` because grouping it there overstates the damage — and that if per-pass
  visibility is ever wanted, a count beats a job-id array. That reasoning is sound and
  I accepted it.
  Cost if wrong: a curation that threw before writing is visible in the audit trail
  but not in the pass result.

RESTORE DONE: `.claude/settings.json` restored from `.claude/settings.json.sdd-backup`
  and the backup deleted. The end-of-turn typecheck+test hook is live again.
