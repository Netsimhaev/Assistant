# SDD ledger — plan: docs/superpowers/plans/2026-09-23-agent-envelope.md

Spec: docs/superpowers/specs/2026-09-23-agent-envelope-design.md (read — binding authority)
Branch: `agent-envelope`, cut from `main` at 3ab1dad (main == 3ab1dad, credential broker merged).

## RESTORE BEFORE FINISHING

`.claude/settings.json` — the Stop hook that runs `npm run typecheck && npm test`
every turn is parked for the duration of this plan, backed up to
`.claude/settings.json.sdd-backup`. It collides with subagents running the suite
against the same Postgres. **Restore it before the branch is finished.** On the
credential-broker plan this note went unread until the final review caught it.

## Preflight scan

### Pairs that share a file or an interface

| A → B | produced | consumed | finding |
|---|---|---|---|
| T1 → T4 | `mayDelegate` | the gate's stage 3 | **DEFECT — ruling 1** |
| T1 → T5 | `delegationProblems` | `runPlan` | clean |
| T1 → T6 | the four guards, `tightenConstraints`, `contextRefsHash` | `requestHelp` | clean |
| T2 → T6 | `writeEnvelope`, `priorQuadruples`, `countPairExchanges`, `delegationsToday`, `attachChildJob` | `requestHelp` | clean |
| T2 → T7 | `loadEnvelope`, `writeEnvelope` | `resumeDelegatedJobs` | clean |
| T2 → T8 | the two tables | the eraser | clean |
| T3 → T4 | `ops.web` loses the tool | the gate's negative test | caught in the plan's own self-review; T4 Step 1 carries the caveat and asserts the exact deny code — verified present |
| T3 → charter builders | new `ActionClass` member | `autonomy.base` is `z.record(ActionClass, …)`, "every class must be declared" | **DEFECT — ruling 2** |
| T3 → T6 | `gov.verify` gains the tool | `requestHelp` needs it to hold it | clean |
| T6 → T7 | `awaitingEnvelopeId`, the envelope, the child | the resumer | clean |
| T6 → T10 | `requestHelp` | `gov.verify` | clean |
| T9 → T10 | `ungroundedNumbers`, `Verdict`, `saveVerdict` | `gov.verify` | clean |
| T9 → T11 | `loadVerdict` | `views.ts` | clean |
| T10 → T11 | `verifyDraft` | `conduct.ts` | clean |
| **the whole chain → the execution path** | a plan step naming `agent.request_help` | nothing routes it to `requestHelp` | **DEFECT — ruling 3** |
| **T6's registry → the child's step** | `tool: 'doc.fetch'` | `doc.fetch` is read-only and unimplemented | **DEFECT — ruling 4** |

### Each task against itself

| Task | check | finding |
|---|---|---|
| T1 | the code it gives against the imports it declares | clean — `lowestTrust`/`mostRestrictiveAutonomy` exist and are imported, not rewritten |
| T2 | the migration's `CHECK (hops <= 6)` against `MAX_HOPS` | clean — identical, and ruling 5 records why the duplication stands |
| T3 | the three lists against the invariant it writes | clean |
| T4 | its negative test against what T3 leaves in place | clean — caveat present |
| T5 | the files it names against the files that exist | clean — `run-plan.ts:207` verified |
| T6 | the registry's `tool` against the tool's implementation | **DEFECT — ruling 4** |
| T7 | `StepOutcome`'s four statuses against a parked job | **DEFECT — ruling 3** |
| T8 | the seeding order against the scan | clean — Step 2 requires red before wiring |
| T9 | the empty-source case | clean — caught in the plan's self-review and present |
| T10 | the quarantine invariant against the imports it forbids | clean |
| T11 | escaping of the verdict | clean — Step 1 item 5 |
| T12 | docs only, plus the live run | clean |

---

Ruling 1: **`src/policy/engine.ts:5` imports `AgentId` as `import type`.** The plan's
T4 Step 4 code calls `AgentId.safeParse(to)`, which needs a runtime value, and
`verbatimModuleSyntax` makes a type-only import carry none — it would not compile.
Ruled: T4 adds a **separate value import** (`import { AgentId } from '../domain/audit.js';`)
alongside the existing type import rather than converting it, so nothing else in
the file changes meaning. Carried into T4's dispatch.
Cost if wrong: a compile error the implementer sees immediately.

Ruling 2: **`CharterAutonomy.base` is `z.record(ActionClass, AutonomyLevel)` and its
docblock says every class must be declared.** T3 names only `src/test/fixtures.ts`,
but `scripts/seed-charter.ts` and `scripts/seed-charter-live.ts` build charters too.
Ruled: T3 declares `'agent.delegate': 'auto'` in **all three**, and the implementer
greps for every construction site of `autonomy.base` rather than trusting this list.
Cost if wrong: a seed script that fails to sign a charter — loud, not silent.

Ruling 3: **nothing routes a plan step naming `agent.request_help` to `requestHelp`,
and `StepOutcome` has no way to say "this step parked the job".** `agent.delegate`
addresses `internal`, so the step is not outbound, needs no channel, and lands in
`runLocalTool` — which implements the memory family only and would return
`not_implemented`. And once `requestHelp` moves the parent to `followup`,
`executeStep` would attempt `followup → verify`, which `LEGAL_TRANSITIONS` forbids
and `transition` throws on.
Ruled: **T7 owns both halves of parking.** It gains (a) an `agent.request_help`
implementation in `runLocalTool` that calls `requestHelp`, with a
`LOCAL_TOOL_CONTRACTS` entry so the planner learns the payload shape, and (b) a
fifth `StepOutcome` status — `parked` — that `executeStep` returns without
transitioning, because the step already moved the job itself. T7's title becomes
"the parent parks and wakes", which is one coherent deliverable rather than two.
Rejected alternative: having `gov.verify` call `requestHelp` directly, the curator's
documented gate-bypass pattern. Rejected because spec §4.2 states the flow as a step
that emits through `evaluateToolCall`, and because T5's plan-validation layer would
become dead code — the exact defect class this whole sub-project exists to close.
Cost if wrong: `executeStep` gains a status with one producer. Contained, and the
alternative silently guts two other tasks.

Ruling 4: **the registry names `doc.fetch`, which sits in `READ_ONLY_TOOLS` and has
no implementation.** A child whose one step calls it would complete with
`performed: false` and teach the parent nothing — a delegation that runs end to end
and does no work, which is the hollow-mechanism trap this sub-project was chosen to
close.
Ruled: **T6 implements `doc.fetch` in `runLocalTool`**, resolving the document
context ref and calling `readDocument` (`src/documents/read.ts`) — the function that
already produces a validated `Reading` and is called today only from `conduct.ts`.
This makes `know.reader`'s allowlist entry meaningful for the first time. T6's
registry invariant is extended: every registered intent must name a tool that has an
implementation, not merely one that is known and permitted.
Cost if wrong: `doc.fetch` gains a reader before the rest of `know.reader` exists.
That is the direction this project already prefers — a mechanism with a caller.

Ruling 5: **`MAX_HOPS` appears both in TypeScript and as `CHECK (hops <= 6)` in the
migration, which looks like the duplication this codebase warns about.** Ruled: it
stands. The precedent is deliberate and documented — the instruction-length cap is
checked in TypeScript *and* as a SQL `CHECK` in migration 022, "two layers on
purpose, one bypassable and one not". The guard refuses before a seventh envelope is
built; the `CHECK` is the layer that holds when someone writes a row by hand.
Cost if wrong: none — a second layer that can only refuse.

---
Task 1: DONE (402ab40). 21 tests. The implementer ran **11 mutations one at a time**
— every field of `tightenConstraints`, all four guards, `mayDelegate`,
`contextRefsHash`, `delegationProblems` — and each felled its named test.
Review: spec ✅, quality Approved, zero Critical/Important.
Reviewer checked every `Consumes` dependency against its real source rather than
trusting the report, and confirmed the `Object.hasOwn` mutation fells via a thrown
TypeError rather than a clean assertion — honest about the mechanism.
⚠️ item resolved by me: "nothing wires `mayDelegate` to the compiled
`collaborationGraph`" — correct, and it is Task 4 (gate) and Task 5 (plan
validation). Not a gap.
Carried to T7: `delegationProblems` reads `step.input['to']` with no payload schema
behind it yet. T7's `LOCAL_TOOL_CONTRACTS` entry for `agent.request_help` must use
the field name `to`, or the two drift silently.
Task 1: complete (commits b65ef9b..402ab40, review clean)

Task 2: DONE (a78b1f9). 6 tests. Mutation (dropping `correlation_id` from
`priorQuadruples`) felled test 3 and only test 3.
Review: spec ✅ byte-for-byte against the brief's SQL; quality Approved with one
Important and two Minor.
  Important: `countPairExchanges` is correctly scoped to a correlation in the code,
  but its test seeds every envelope under ONE correlation — so dropping the scope
  returns 2 either way and the test still passes. Same defect class the brief
  guarded for `priorQuadruples`, one function over. `countPairExchanges` backs the
  oscillation guard, so an unscoped version would let one job's exchanges fire the
  guard in an unrelated job. → fix round 1.
  Minor (folded into round 1, one line): `AgentEnvelope` imported as a value, used
  only as a type.
Task 2: minor (deferred): test 2 proves the duplicate RESULT but not the
  insert-then-read SHAPE — a read-then-insert implementation passes it identically
  in a single-threaded test. A real proof needs two connections racing. Code
  verified correct by reading; flagged for the final review to triage.
Task 2: minor (deferred): no FK from `agent_envelopes.parent_job_id`/`child_job_id`
  to `jobs`. Deliberate at this layer; T6/T7 create both jobs themselves.
Task 2: minor (deferred): `writeEnvelope`'s duplicate path returns the stored row
  without comparing the offered payload. Adjudicated by me: the idempotency key IS
  `canonicalHash` over the payload, so a matching key is a matching payload by
  construction. Not a defect. Recorded because the implementer raised it.

Ruling 2 — CORRECTED before T3 was dispatched. I was wrong that the two seed
scripts build their own charters: `scripts/seed-charter.ts:19` and
`scripts/seed-charter-live.ts:30` both **import `buildCharter` from
`src/test/fixtures.js`**, so `src/test/fixtures.ts` really is the only
`autonomy.base` construction site, exactly as the plan said.
What the grep DID find, and it is sharper: **two tests in
`src/charter/capabilities.test.ts` map over `ActionClass.options` and will fail
the moment a member is added.** `has an entry for every action class` (line ~222)
asserts an `EXPECTED` addressee table has one entry per class, and `it.each`
(line ~226) checks each one. T3 must add `'agent.delegate': 'internal'` to that
table. Separately, `every action class is reachable` (line ~65) requires some
tool to produce the class — satisfied, because `agent.request_help` maps to it
directly once T3 lands.
Ruled: T3's dispatch names all four edit sites — `ActionClass`,
`ACTION_ADDRESSEE`, the `EXPECTED` table, and `buildCharter`'s `autonomy.base` —
and tells the implementer these tests failing is the table needing the entry,
never the test needing softening.
Cost if wrong: a failing test the implementer sees on the first run.

Facts gathered for T6's dispatch (ruling 4 — implementing `doc.fetch`):
`readDocument(input: ReadDocumentInput, options: ReadDocumentOptions = {})` at
`src/documents/read.ts:116`. `input` carries `documentId` and `jobId`
(`jobId: null` is a real, handled case). `options` carries an injectable
`reader` (defaults to `runKnowReader`) — that is the seam a test uses instead of
a live model call, and T6's `doc.fetch` implementation must pass it through or
the test needs an API key. Returns a discriminated union whose members include
`{ status: 'no_artifacts'; denials: string[] }`, so the local tool must handle a
document with nothing extracted as a real outcome rather than a throw.
Task 2: fix round 1/5 (1 addressed, 1 open — mutation evidence invalid; commits a78b1f9..6a05ea8)
  The test was extended with a fourth envelope under a different correlation, and
  the Minor import was fixed. But the reported mutation felled the test with
  `could not determine data type of parameter $2` — a MALFORMED query, not an
  unscoped one: the predicate was deleted while the parameter was still passed.
  A red from the wrong cause is not evidence, which is the same class as the
  finding being fixed. Round 2 asks for a valid unscoped query (renumber the
  placeholders, drop the unused value) and an ASSERTION failure, not a thrown
  database error.
Task 2: fix round 2/5 (evidence only, no code change — valid mutation produced
  `AssertionError: expected 3 to be 2`, a real assertion failure)
Task 2: scoped re-review — all three findings ADDRESSED. The re-reviewer did NOT
  take the reported output on trust: it traced the round-2 mutated query against
  the seeded rows itself and derived 3 independently. New breakage: none.
Task 2: complete (commits 402ab40..6a05ea8, review clean)

Task 3: DONE (cc9b71b). Full suite 1674 passed, 0 failed.
  The implementer found ripples the brief did not name and handled them: four more
  exhaustive `Record<ActionClass, _>` tables needed the new key, and
  `proposal-parse.test.ts` was using `agent.request_help` as its example of a tool
  the gate CANNOT classify — true before this task, false after. It moved the
  fixture and repaired a matching stale comment.
Review (opus, because this touched the allowlists): spec ✅, and it verified the
  security properties directly — `ops.web` still holds no delegation tool, the
  allowlist/graph equality bites in both directions across all 15 agents, the
  quarantine agents gained nothing, and no denylist pattern silently covers the new
  tool. It also confirmed empirically that zod 4 enforces exhaustiveness on
  enum-keyed records, which is what stops a real charter missing `agent.delegate`
  from reading as permissive.
  Three Important + three Minor. → fix round 1.

  Important 1 — **the exemption defeats itself.** `rampLevelForPlan` returns
  `RAMP_FLOOR` when nothing contributed, so a plan whose every step is exempt or
  read-only floors to `draft_only` — and a classified exempt step does NOT
  short-circuit at stage 4 the way a read-only one does, so stage 8 denies it. A
  one-step delegation plan, which is exactly what T6 builds for every child job, was
  dead on arrival. This is the 11/09 pathology reproduced one case narrower, inside
  the very mechanism written to prevent it.
  Important 2 — `src/sdk/proposal-prompt.ts:169` ships a Hebrew line to the model
  saying an action may not be "a tool that asks for help". Now false, and unlike the
  comment the implementer did repair, this one steers model output.
  Important 3 — deleting the skip line leaves the whole suite green. The two new
  invariants assert table membership and table properties, never the behaviour.

Task 3: Ruling — Minor 4 folded into the fix round although the skill keeps minors
  out of the loop. `toEqual` on the member list throws before the loop, so the
  `addresseeOf === 'internal'` assertion can never be the thing that fails. An
  assertion that cannot fail is the cardinal rule of this project, not a Minor,
  whatever grade it carried. The fix is a two-line reorder and yields two mutations
  with two distinct failures — the standard `credential-store.test.ts` set.
  Cost if wrong: two lines.

Task 3: minor (deferred): `agent.delegate` owns an `autonomy_ramp` row no reader
  consults — `rampLevelForPlan` skips it and `evaluateAutonomy` can promote or demote
  it writing events that change nothing. `npm run ramp:set -- agent.delegate …` would
  print a confirmation for a level nothing reads, and that command exists precisely
  because "a raise that isn't felt looks identical to a broken system". For the final
  review to triage: refuse ceiling-exempt classes in `set-ramp.ts`, or print that the
  row is advisory.
Task 3: minor (deferred): the disjointness docblock at
  `positive-controls.test.ts:239-261` describes as the hazard exactly what
  `CEILING_EXEMPT_TOOLS` now does on purpose. Neither text references the other, so a
  reader arriving at either believes the other cannot exist. One cross-reference each.

⚠️ RESOLVED BY ME (1/2): "does any task produce a delegation-only plan?" — **yes, and
  it is the common case.** T6 builds the child's plan as exactly one step. So
  Important 1 was live, not latent, and the fix is required rather than prudent.

⚠️ CARRIED TO TASK 6 (2/2) — the central safety claim, unverifiable from T3's diff:
  `CEILING_EXEMPT_TOOLS`'s entire justification is that "the child job's every step
  faces all ten gate stages under its own ramp". Nothing has tested that. **T6's
  dispatch must require a test that the child's steps are gated under the CHILD's
  ramp level and not the parent's `ctx.rampLevel`.** If the child inherits the
  parent's computed ramp, the exemption stops being safe and becomes a hole.
Task 3: fix round 1/5 (4 addressed, 0 open; commits cc9b71b..80b5633). 1676 tests.
  Minor 4's two mutations landed at two distinct sites exactly as asked: `mail.send`
  fails inside the loop on the property, `crm.write` passes the loop and fails on the
  count.
Task 3: scoped re-review (opus) — all four ADDRESSED, each derived from the code
  rather than taken from the report. It also proved the new branch is pinned in BOTH
  directions: mutating the return to a bare `RAMP_FLOOR` fells the delegation-only
  test while leaving the two-step test green, and mutating it to an unconditional
  `'auto'` is caught by the pre-existing all-read-only test.
  On the question that mattered — can a plan reach the new `'auto'` return while
  holding a step that is neither exempt nor read-only — it walked the loop's three
  branches and showed it is structurally impossible, and went further: the exempt
  test keys on the tool name, and that tool has no `REFINEMENT_RULES` entry, so no
  payload can steer the exempt slot onto an outbound class.
Task 3: minor (deferred): `ramp.test.ts:166` docblock names `draft_only` for a test
  that runs under mode `learn`, where an unset row clamps to `approve_required`. The
  comment-misdescribes-code class. One word.
Task 3: minor (deferred, and a real hardening for the final review): the exempt-set
  invariant checks `addresseeOf === 'internal'`, which does NOT enforce the docblock's
  claim of "no outbound authority" — `crm.write` and `accounting.write` are internal
  AND in `OUTBOUND_TOOLS`. A future second member could be outbound-capable and still
  satisfy the loop; only `size === 1` stops it. Closing it needs `OUTBOUND_TOOLS`
  exported.
Task 3: complete (commits 6a05ea8..80b5633, review clean)

Task 4: DONE (757c723). 1680 tests. Mutation: removing the `mayDelegate` block turns
  both negative tests to `allow` — the right failure signal, since the delegation
  would then be permitted.
  Deviation, and my ruling 1 was wrong in its mechanism: adding a value import
  alongside the existing `import type { AgentId }` gives `TS2300: Duplicate
  identifier`. The implementer replaced the type-only import with a plain value
  import, which works because `domain/audit.ts` exports `AgentId` as a merged
  const+type. The re-reviewer confirmed the type annotation at `engine.ts:32` resolves
  to the byte-identical type, and that `governance/delegation.ts:8` already does the
  same thing — house style, not a one-off.
  **The extended reader test found seven more fields.** `redactPatterns` was a genuine
  test omission (fixed by adding `redact.ts` to `GATE_SOURCES`); four are legitimately
  excluded with written reasons; and `allowlists`/`denylists` were reported as a
  sixth instance of the defect class.
Review (opus): spec ✅. Three Important, four Minor. → fix round 1.
  Important 1 — **the defect class recurring inside the test written to catch it.**
  `connections` passes the new invariant because the only occurrence of that string in
  any gate source is ENGLISH PROSE IN A COMMENT at `engine.ts:639`. The real reader is
  `channels.ts:30`, not in the list. Reword that comment and the test reddens on a
  field nothing changed; leave it and it gives false assurance about the one bundle
  field whose own docblock says it was carried in so the resolver reads the same
  artefact the gate is judged against.
  Important 2 — the unreadable-`to` guard cannot fail. `mayDelegate` returns false for
  `undefined` and for `123`, so both fall through to the second deny, **which returns
  the same code**. The test asserts only outcome and code. The Step 7 mutation proved
  the block, never the guard inside it.
  Important 3 — the `charterVersion` exclusion is unnecessary (it appears eight times
  in `engine.ts`, including the stage-2 staleness comparison) and excluding it removes
  stage 2 from the invariant permanently. **My brief seeded that exclusion; it was my
  defect.**

Task 4: Ruling — Minors 4, 5 and 6 folded into the round. 4 closes a silent bypass (a
  second tool mapped to `agent.delegate` would not be graph-checked, because the gate
  names one string); 5 tightens a floor with eight fields of slack around the one set
  that can defeat the invariant; 6 removes positional coupling in an array this task
  edited twice. All three are test-file lines.
  Cost if wrong: a handful of test lines.

Task 4: Ruling — **the `allowlists`/`denylists` gap is NOT the sixth instance, and I
  am not changing the source.** The review corrected the framing and I accept it:
  those three fields are not in the signed charter at all — `compile.ts:51-53` injects
  them from module constants — so nothing signed goes unread, and `capabilities.ts`'s
  own docblock says they describe what an agent IS, not what an owner permits. More
  to the point, the direction matters: reading the live table means a deploy that
  TIGHTENS a capability applies immediately, whereas reading the install-time bundle
  would let a stale snapshot keep permitting a tool the code just withdrew. "Read the
  bundle" is therefore not unambiguously safer. What the bundle buys is
  reproducibility, not authentication.
  Ruled: add the invariant that asserts the property the exclusion comment currently
  only claims in prose — the compiled bundle carries the live tables verbatim — and
  leave `isToolPermitted` alone. If this is ever scoped properly, the review's
  recommendation is to enforce the INTERSECTION of both tables, the only reading safe
  in both directions.
  Cost if wrong: an unpinned capability table, which requires a deploy that WIDENS a
  list plus installs holding an older bundle, and no model, document or counterparty
  can influence either table.

Task 4: minor (deferred): `AGENT_ALLOWLISTS` is `Record<AgentId, string[]>` — mutable
  arrays on a mutable exported object, and `compile.ts` copies by reference, so a
  freshly compiled in-process bundle SHARES those arrays. `Object.freeze` is smaller
  and more clearly positive than anything else discussed here. Held back mid-plan
  only because freezing could surface a hidden mutator; for the final review.
Task 4: minor (deferred to Task 12, which owns docs): CLAUDE.md is now stale in two
  paragraphs — it still lists `agent.request_help` under `READ_ONLY_TOOLS`, and still
  says it and `escalate_to_human` are "members of READ_ONLY_TOOLS today".
Task 4: noted — CLAUDE.md requires `/security-review` for changes touching
  `policy/engine.ts`. Task 12 Step 3 already requires it. Covered, not forgotten.
Task 4: fix round 1 — the implementer returned WITHOUT committing, having parked
  itself waiting on a Monitor notification that would never reach it. I checked the
  tree myself: four files modified, HEAD still 757c723. Resumed with explicit
  foreground steps. This is the eighth time in this project an implementer has ended
  a turn on a backgrounded suite with the work uncommitted; checking the tree rather
  than trusting the return is the standing correction.
Task 4: fix round 1 — **I caused a test collision and it cost two implementer turns.**
  I ran `npm test` from the controller session while the implementer's own background
  run was live; both truncate the same test database, and 86 tests failed across 31
  files neither of us touched. The implementer's own diagnosis was correct and it was
  right to refuse to commit on that red. Corrected by splitting the work: the
  implementer runs targeted files and the mutation only, and **I own the single
  full-suite run, alone, after it commits.** Recorded because the failure mode is mine,
  not the plan's, and the standing note in my memory ("a red from an overlapping run is
  a collision, not a regression") is the thing I failed to apply to myself.
Task 4: fix round 1/5 (6 addressed, 0 open; commits 757c723..21500fc). Full suite run
  by me, alone: 131 files, 1682 passed, 0 failed, typecheck clean.
  The Important 2 mutation now fails on the RIGHT thing and proves the reviewer's
  point exactly: `expected 'gov.verify אינו רשאי לבקש עזרה מ-undefined' to contain
  'בלי נמען קריא'`, with outcome and code unchanged at deny/`delegation_not_permitted`.
  The code assertion could never have caught it; the reason is the only discriminator.
Task 4: scoped re-review (opus) — all six ADDRESSED. It widened the check I asked for:
  instead of grepping `channels.ts` for the two field families the implementer checked,
  it grepped all 18 top-level bundle fields, all 7 ceiling keys and all 4 do-not-contact
  buckets, and built a per-field/per-source hit matrix. It then verified each of the
  twelve non-excluded fields resolves to a REAL reader rather than prose, and judged all
  six surviving exclusions on the merits (zero gate hits for each — every one
  load-bearing, unlike `charterVersion`, which had eight).

Task 4: Ruling — round 2 opened for two findings the reviewer graded Minor, against the
  skill's rule that minors stay out of the loop.
  The reason: adding `channels.ts` closed `connections` but brought in a prose-only hit
  on `ceilings` at `channels.ts:139`. So **the same defeat mode now exists for a second
  field, inside the very task whose second half exists to make a sixth instance
  impossible.** An invariant an English comment can satisfy does not close a defect
  class. The structural fix the review recommends — match `bundle.<field>` instead of
  the bare name — makes the check finally say what its docblock claims, and any field
  whose verdict changes under it was being hidden by the loose match too.
  Cost if wrong: a stricter scan that surfaces fields needing an explicit reason, which
  is the outcome I want anyway.
Task 4: minor (deferred): `compiledAt` is dead in production — only the write in
  `compile.ts:34` and the schema. A bundle field with no reader anywhere is the shape
  this invariant exists for, even carrying no rule. For the final review.
Task 4: fix round 2/5 (2 addressed, 0 open; commits 21500fc..9cd543a). Test-file only.
  The proving mutation did what it was asked to prove: replacing both genuine
  `ceilings` readers with bracket notation yields `expected [ 'ceilings' ] to deeply
  equal []`, so the `channels.ts` prose can no longer paper over an absent reader.
  No field's verdict changed under the stricter match — all 12 have a real `.field`
  reader, and the re-reviewer checked all twelve itself rather than the four I asked
  for, running the regexes rather than trusting the table.
  It also tested the anchoring directly: a parameter list `ceilings: CompiledCeilings`
  does NOT match, an inline destructure does, and a multi-line destructure does too —
  so the false-negative risk I raised does not materialise.
Task 4: minor (deferred): `readsField` scans raw text without stripping comments, so a
  docblock quoting a dot-prefixed fragment (`ctx.bundle.knownCounterparties`) would
  still satisfy it. None exists today — verified across all five sources for all
  twelve fields. This is a much narrower version of the class than where we started
  (any bare English word), and two rounds is where the returns stop. For the final
  review.
Task 4: minor (deferred): a renamed destructure `{ ceilings: c }` matches neither
  branch. Not used anywhere today, and it fails in the safe direction — a real reader
  would look absent, which surfaces as a red, not a silent pass.
Task 4: complete (commits 80b5633..9cd543a, review clean)

Task 5: DONE (7bc5b88). 5/5. Review: spec ✅, quality Approved, zero findings.
  The mutation is the best evidence produced so far: with the guard commented out,
  step `s1` (`mail.send`) RAN TO COMPLETION and committed its `job_step_results` row
  before `s2` was refused at the gate — the exact failure this layer exists to
  prevent, demonstrated rather than argued. The reviewer traced the observed `halted`
  status through `engine.ts` → `execute.ts` → `run-plan.ts` to confirm it came from
  the gate's own collaboration check catching the same bad step one step too late,
  not from a kill switch or a phase guard.
  It also confirmed the test asserts absence rather than rejection: zero rows in
  `job_step_results` AND an empty adapter send list, with `s1` made genuinely
  executable (real connection, live binding, standing authorization) so "it never
  ran" is load-bearing.
Task 5: complete (commits 9cd543a..7bc5b88, review clean)

Task 6: DONE (1a2cd8b). 33 tests across three files. Mutation (bypass
  `tightenConstraints`): `expected 'boss' to be 'staff'`. `doc.fetch` given a real
  implementation per ruling 4 — it was registered and unimplemented, which would have
  made every delegation a hollow no-op.
Review (opus): spec ✅ with two declared deviations, no Critical, **eleven Important**.
  The one property the plan rests on does hold: the child's provenance is re-derived
  from the parent job's own row and fed through `lowestTrust`, so a fabricated parent
  envelope can only LOWER trust. And the argument order of `tightenConstraints` is
  type-enforced — arg 2 is `Partial`, so a swap will not compile.
  The two that would have become real holes the moment Task 10 lands:
  (1) `requestHelp` never calls `mayDelegate`, and `input.from` is never parsed — so
      `requestHelp({from: 'ops.web', …})` opens a child today, and Task 10 calls
      `requestHelp` DIRECTLY rather than through a gated plan step, so the single choke
      point that opens a child would carry no graph check at all.
  (2) `attachChildJob` runs AFTER the child moves to `execute`. `runDueJobs` takes
      anything in `execute` with a bound plan, so a crash in that window leaves a child
      that RUNS AND ANSWERS INTO THE VOID with no envelope pointing at it — and the
      deadline path cannot wake the parent either, because it finds parents by
      `awaiting_envelope_id`. Two adjacent calls swapped closes it. The report had named
      a milder sub-window.
  And the finding that changes what a claim rests on: **`doc.fetch` is read-only, so the
  child's only step short-circuits at gate stage 4 and never reaches stage 8.** For
  today's single registry entry, `CEILING_EXEMPT_TOOLS`'s safety justification is carried
  by the delegated tool being read-only, not by the child's own ramp. Required to be
  recorded in the report.

Task 6: Ruling — finding 3 (`autonomyCeiling` and `moneyCeilingMinor` are tightened,
  stored, and read by nobody) is **carried to Task 7, not fixed here.** The reader
  already exists — `GateContext.autonomyCeiling` is documented as the envelope's hard cap
  and is folded into `effectiveAutonomy` — but it is `runDueJobs` that builds the child's
  gate context, and that is Task 7's file. Fixing it here would mean editing Task 7's
  code from Task 6.
  Cost if wrong: the tightening stays decorative one task longer. Harmless today only
  because the root ancestor is permissive and the job-derived side hardcodes `auto`/null;
  the moment an ancestor carries a real ceiling it stops being harmless.
  This is the `compiled policy has a reader` class one layer up, and it must not be
  parked past Task 7.
Task 6: fix round 1/5 (11 addressed, 0 open; commits 1a2cd8b..ecb844a). Full suite by
  me: 133 files, 1710 passed, 0 failed.
  Mutations: `expected 'boss' to be 'unknown_external'` (ancestor constraints now bite),
  `expected 'opened' to be 'duplicate'` (the duplicate early return now covered).
  The `ops.web` refusal test is green for the RIGHT reason — the re-reviewer checked
  that the graph carries an explicit `[]` entry rather than omitting the key, so the
  refusal is the empty value and not `Object.hasOwn` failing. `mayDelegate` refuses
  both ways, so the test could have passed for the weaker reason.
  The child-ramp test now observes production: it runs the real `runDueJobs`, asserts
  the child appears in `due.ran` with `status: 'done'`, that the injected reader was
  called exactly once (which also proves no cache hit and no live call), and that the
  child reached `verify`.
Task 6: fix round 2 opened for five residuals the re-review surfaced:
  (1) the envelope check verifies LINKAGE but every authority value — hops,
      correlationId, causalChain, ancestor constraints — is still read off the caller's
      object, so a caller with a legitimate envelope id can still slip `hopGuard` or
      escape both anti-ping-pong guards' scope. Deriving them from the row via
      `loadEnvelope` is SMALLER than the check that was written, and makes it redundant.
  (2) the report's reason for declining `refuseUnderTest` was wrong, and the repo holds
      the counter-example: `curator.ts` puts the guard inside the DEFAULT implementation,
      so injection bypasses it. The finding-8 test would have kept working. CLAUDE.md
      states the requirement literally — live-call protection must not rest on test
      discipline.
  (3) the `duplicate` → `childJobId` path is correct and unpinned; hardcoding `null`
      survives the suite.
  (4) **`doc.fetch` through a delegation bypasses `DOCUMENT_READS_PER_DAY` entirely** —
      the cap lives in `conductPendingDocuments`, not in `readDocument`, so a
      delegation-driven read is billed and bounded only by `delegationsPerDay`. Ruled:
      count it against the document-read cap; do NOT gate on `DOCUMENT_INBOX`, which is
      the inbox loop's switch and not a cap on every read.
  (5) two comments assert what `resumeDelegatedJobs` does — a function Task 7 has not
      written yet.
Task 6: minor (deferred): `ROOT_ANCESTOR_CONSTRAINTS.deadlineAt` uses a `9999-12-31`
  sentinel where `moneyCeilingMinor` uses `null` for the same "no ceiling" idea.
Task 6: fix round 2/5 (5 addressed, 0 open; commits ecb844a..d1c7425). 1713 passed.
  Mutation: hardcoding the duplicate's `childJobId` to null now gives
  `expected null to be 'J-01M385QYE4BSA7NT39R3VNSFSD'`.
  The re-reviewer grepped `input.parentEnvelope` and found exactly four remaining hits
  — the type, the null test, the id, and the id inside the refusal string. No authority
  value is read from the argument after the check, and a NONEXISTENT envelope takes the
  same refusal branch as a mismatch rather than falling back to the permissive root.
  It also noted a consequence worth knowing: a child under a verified ancestor runs on
  the ANCESTOR's charter version, not the live bundle.
  Cache hits correctly do not consume the document-read budget — `readDocument` returns
  before `saveReading`, so no row is written and the count does not move.
Task 6: fix round 3 opened for three items:
  (1) **`DOCUMENT_READS_PER_DAY=0` became an unbounded retry loop.** `positiveInt`
      accepts 0 and CLAUDE.md documents it as a legitimate ceiling, so the new check
      throws retryable on the first call forever — flat five-minute parks, no attempt
      counter, child never fails, parent never unparks. Ruled: refuse FINALLY at 0,
      where a retryable refusal is a lie, and keep retryable for a genuine cap that
      resets at midnight.
  (2) a docblock citing `envelopeOpenedChild`, deleted in the same round.
  (3) `proposer.ts` is the fourth billed SDK entry point and the only one still without
      `refuseUnderTest`.
Task 6: minor (deferred to the final review): an exhausted NORMAL cap still churns
  ~288 wake cycles a day until the envelope deadline frees the parent. Task 7's deadline
  path bounds it; the honest fix — waking at the next day boundary instead of +5 minutes
  — needs `StepChannelError` to carry a `wakeAt`, which is Task 7's file, and I did not
  want Task 6 editing it.
⚠️ CARRIED TO TASK 10: `requestHelp` reads `collaborationGraph` and `charterVersion` from
  the `input.bundle` the CALLER supplies, and never loads the active charter itself. That
  is the same unverified-caller-claim shape round 2 just closed for `parentEnvelope`. It
  is harmless while the only caller is a test — but Task 10 calls `requestHelp` directly,
  so **Task 10 must pass a bundle from `loadActiveCharter`, never one it builds.**
Task 6: fix round 3/5 (3 addressed, 0 open; commits d1c7425..e0d28bf). 1713 passed.
  The re-reviewer verified the "no test reaches the real proposer" claim itself rather
  than accepting it — walked every `proposeForReading` and `conductPendingDocuments`
  call in both test files and confirmed each injects. So `proposer.ts`'s new guard is
  defence in depth, and the other three entry points already had theirs.
Task 6: fix round 4/5 opened for one item: the `DOCUMENT_READS_PER_DAY === 0` →
  `retryable: false` branch — the fix I demanded in round 3 — has no test. Only the
  nonzero path is exercised, so reverting `config.documentReadsPerDay > 0` to a bare
  `true` passes the whole suite. A branch whose only purpose is to distinguish "will
  reset at midnight" from "can never succeed", with nothing pinning the distinction.
Task 6: fix round 4/5 (1 addressed, 0 open; commits e0d28bf..0707f3f). Test-only.
  Mutation: `expected true to be false`. The re-reviewer confirmed the test drives the
  genuine zero-cap path (empty table, so `0 >= 0` fires on the cap itself, not on
  accumulated exhaustion), asserts finality rather than mere refusal, asserts the reader
  was never called, and restores the overridden config in a `finally` so a failure
  cannot poison the rest of the file. The pair is now mutation-tight in both directions.
Task 6: complete (commits 7bc5b88..0707f3f, review clean). 1714 passed.

Task 7: DONE (bf163cc). 1722 passed. Mutation 2 is the strongest evidence in the branch
  so far — with the envelope's ceiling honoured the child halts at
  `draft_only:persist_as_draft`; ignore it and the child runs to `done` and a mail
  actually goes out. That is stage 8 changing its answer, not a value being passed
  around, and it closes the ⚠️ carried from Task 3.
Review (opus): spec ✅ but **NOT APPROVED — one Critical.**
  **A delegation that succeeds end to end currently ends with the parent job marked
  `failed`, in the default production configuration.** A `parked` step writes no
  completion row, so the resumed run re-runs the `agent.request_help` step; guard 4 runs
  BEFORE `writeEnvelope`, `priorQuadruples` has no `kind` filter, and the re-run's
  quadruple is byte-identical to the envelope the first pass wrote — so it returns
  `no_new_information`, never `duplicate`. The handler throws non-retryable and the
  parent goes to `failed`. The entire `duplicate` block the implementer wrote for this
  case is dead code, and its comment describes a path the code cannot execute.
  **No test ran `resumeDelegatedJobs` and `runDueJobs` in the same pass** — that absence
  is the only reason the suite is green.

Task 7: Ruling — fix it by checking the idempotency key BEFORE guard 4, not by recording
  the parked step as completed. Two reasons. The guards are ordered wrong as they stand:
  "I already did exactly this, here is its child" is a specific answer being shadowed by
  a general "you are asking the same thing again". And the handler already holds the
  correct downstream logic for `duplicate`, so this makes a dead block live rather than
  adding new code. The alternative — recording completion inside `requestHelp`'s own
  transaction — would work but needs the step id threaded into a function that has no
  business knowing it.
  Cost if wrong: an extra lookup per delegation request, and the `duplicate` path becomes
  the retry path rather than an unreachable one.

  Four Important, all real: corrupted shapes have no exit AND starve the window (never-
  updated rows sort first forever under `ORDER BY updated_at`, the exact starvation
  `run-due.ts` documents and fixed for `unbound`); the new bucket is printed nowhere and
  its diagnostics are discarded; an unreadable deadline reads as "inside the window"
  because `NaN <= now` is false, against the house rule with its own paragraph; and the
  derived-ancestry lookup is deletable with the suite green, which would hand every
  second-hop delegation the permissive root ancestor and reset the correlation that
  scopes both anti-ping-pong guards.
  Two Minors folded: no `kind` filter on the guard queries, so an answer now counts as a
  request in the reverse direction; and the child index is not unique, so two rows naming
  one child give the gate a nondeterministic ceiling.
Task 7: fix round 1/5 (6 addressed — Critical + 4 Important + 2 Minor; commits
  bf163cc..dc841f9). 1725 passed. The mutation reproduced the Critical exactly:
  `expected 'halted' to be 'done'`, parent on `failed`. The `duplicate` block is
  reachable in production now, through `child.phase === 'closed'` → `answered`.
  The re-reviewer confirmed guard 3's hit set is a strict SUBSET of guard 4's (an
  identical key implies an identical quadruple), so no request that previously
  succeeded now returns `duplicate` — blast radius minimal.
Task 7: fix round 2/5 opened — **the fix introduced four things, and the first two are
  the Critical surviving through different doors.**
  (1) `dailyCapGuard` still sits above the idempotency lookup, and unlike `hopGuard` it
      reads a SHARED, TIME-VARYING counter — so its answer differs between passes. Once
      the installation hits `DELEGATIONS_PER_DAY`, every parked parent resuming that day
      is marked `failed` with its child's answer sitting in `closed`. Hitting a daily cap
      is a normal operational state.
  (2) the deadline wake became an unbounded poll. The resumed step finds the child
      non-terminal, throws retryable, and `transition` writes
      `awaiting_envelope_id = $6 ?? null` — **clearing the column** — so
      `resumeDelegatedJobs` never sees that parent again and `timedOut` cannot fire
      twice. No attempt counter. Before the fix this ended terminally.
  Ruled: fix (2) by reading the `result` envelope instead of the child's phase.
  `resumeDelegatedJobs` already writes one for a close, a failure AND a timeout, so the
  branch stops depending on the child's phase and all three outcomes flow the same way.
  (3) the idempotency key omits `parentJobId`, so two sibling parents in one correlation
      both resolve to the first's envelope and the second reports `answered` with a child
      it never opened. Adding it also restores the division the reordering blurred:
      guard 3 answers "this same job is retrying", guard 4 answers "someone else in this
      tree is asking the same thing".
  (4) the `kind = 'help_request'` filter is deletable with the suite green.

Task 7: Ruling — a child that `failed` or `halted` yielding a `done` parent step STAYS.
  It is the stated design that the parent never fails on its own account, and the failure
  is carried in the step result for a later reader. Required only that the branch's
  comment say it was chosen rather than inherited.
  Cost if wrong: a failed delegation closes the parent as a success until Task 10 reads
  the result. Visible in the step result, not silent.

Task 8 confirmed necessary by this review, independently: `agent_envelopes` and
  `verification_verdicts` are still not wired into the eraser, and
  `erasure-invariants.test.ts` is green only because the probe is never seeded into
  either table — which is the exact blind spot that rule's own history names.
Task 7: fix round 2/5 (4 addressed, 0 open; commits dc841f9..63dde0a). 1730 passed.
  Four mutations, four distinct failures. The re-park choice was judged sound on the
  question that mattered: the wake/re-park pair **cannot** livelock, because
  `resumeDelegatedJobs` never wakes a parent without first writing a `result`, and the
  re-park branch is reached only when no `result` exists — so a wake is always followed
  by completion, never by another re-park. And if nothing wakes it, the envelope's
  absolute `deadlineAt` terminates it. A real bound, not a retry budget.
  The reviewer also walked every check still sitting ABOVE the idempotency lookup and
  classified each by whether its answer can differ between the two passes. Only one can.
Task 7: Ruling — `mayDelegate` stays above the idempotency lookup. A signed charter
  amendment that drops a delegation edge between the original call and the resume will
  fail the parent with the child's answer already written. That is correct: a signed
  amendment revoking a permission SHOULD stop work in flight, and failing the parent is
  the honest consequence of the owner having revoked the permission that produced the
  answer. Required only that the comment say it was chosen.
  Cost if wrong: a deliberate amendment discards one in-flight answer. Rare by
  construction — a signed act, not an automatic increment.
Task 7: fix round 3/5 opened for three items from inside the fix:
  (a) an unreadable `result` payload yields `outcome: 'unknown'` on a step that records
      `done`, so a child that genuinely FAILED and a malformed envelope are
      indistinguishable at the one place the distinction is carried — and Task 10 branches
      on it. Against the rule this project states flatly.
  (b) the result lookup is unscoped; the invariant lives in a comment, not the predicate.
  (c) the re-park's `transition` omits `envelopeId`, leaving `job_steps.envelope_id` NULL
      — the column that has existed since migration 001, threaded end to end and always
      null, and filling which is part of this sub-project's point.
Task 7: fix round 3/5 (3 addressed, 0 open; commits 63dde0a..6a97f20). 1732 passed.
  Item 1's mutation is the clearest statement of the rule in the whole branch: reverting
  to the hand-narrowed read made the code silently return
  `{status:'answered', outcome:'unknown'}` and throw NOTHING — `expected undefined to be
  an instance of StepChannelError`. A permitting default, exactly.
  The re-reviewer confirmed the schema is genuinely shared (one definition in
  `domain/envelope.ts`, imported as a VALUE in both places because `.safeParse` is called
  on it), that an unparseable payload now fails non-retryably rather than looping, and
  that the writer can never produce something the schema rejects — so the happy path
  cannot break.
Task 7: complete (commits 0707f3f..6a97f20, review clean). 1732 passed.

Task 8: DONE (dc74eaf). 40/40 in the erasure files. The implementer did the steps in the
  required order and reported the red before wiring, naming all three columns —
  `expected [ 'agent_envelopes.payload', 'agent_envelopes.context_refs',
  'verification_verdicts.verdict' ] to deeply equal []`. That red is what proves the
  seeding is real rather than the scan being vacuous.
Review (opus): spec ✅. Predicate sharing clean — both predicates are EXPORTED CONSTANTS
  interpolated in both places with byte-identical parameter arrays, so the text cannot
  drift. Cascade analysis verified against the migrations rather than taken on report, and
  the reverse direction checked too (no other code path deletes from either table, so
  neither delete can be pre-empted and read as zero). Audit honesty untouched.
  Three Important, four Minor. → fix round 1.

Task 8: Ruling — **the `OR child_job_id` arm comes out, and the gap it was reaching for is
  closed a different way.** The review traced that only `payload` can name a counterparty
  (`context_refs` is a closed union of four id-only shapes, `intent` is a registry key, the
  rest are hashes, generated ids and enums), and that `payload` comes straight off the plan
  step — which lives in the PARENT's `job_plans.plan`, already searched by
  `plan::text ILIKE`. So the under-deletion case the arm was added for does not exist, while
  the arm produces over-deletion of a job whose envelope holds nothing about the contact —
  including a job the owner explicitly KEPT, because kept jobs are removed from `jobIds` but
  the envelope is still reached through the child.
  But the gap is real for a different reason: **Task 10 calls `requestHelp` directly, not
  through a plan step**, so a payload can name a contact with no plan text to discover it by
  — and the child arm does not help there either, since an undiscoverable parent means an
  undiscoverable child. Ruled: single-armed `parent_job_id` predicate, plus
  `agent_envelopes.payload` as an anchor-DISCOVERY source, the dual role
  `boss_instructions.text` and `autonomy_marks.note` already hold.
  Cost if wrong: an envelope whose payload names nobody survives an unrelated erasure.
  Against: a kept job's envelope destroyed, and the keep button not shielding.

Task 8: second Important — **erasing a contact terminates a parked job.**
  `jobs.awaiting_envelope_id` is plain TEXT with no FK, the `jobs` scrub only nulls `title`,
  and `LIVE_PHASES` does not include `followup` — so a parked parent's envelope is deleted,
  `loadEnvelopeWithChild` returns null next pass, and `failCorruptedParent` fails the job.
  The preview says "agent_envelopes: delete N" and nothing about a job about to die. This
  applies to the brief-mandated arm too, not only the one being dropped. Fix: clear the
  column in the `jobs` scrub.
Task 8: third Important — `countItems`' new arithmetic is asserted NOWHERE. Deleting both
  blocks leaves the suite green, which is exactly the preview/deletion divergence the
  shared-constant rule exists to prevent, one level above where sharing a constant helps.
Task 8: fix round 1/5 (5 addressed, 0 open; commits dc74eaf..7bcd092). 1733 passed.
  The discovery query was verified against every sibling — same `likeLiteral` pattern,
  same interpolated `LIKE_ESCAPE`, `payload::text ILIKE` mirroring `plan::text ILIKE`,
  and `parent_job_id NOT NULL` so unlike the `approval_requests` discovery it cannot
  inject a NULL into `jobIds`. And the keep shield is now COHERENT rather than partial:
  with the arm gone, the pointer-holder is always the envelope's own parent, so a kept
  parent keeps both its envelope and a valid pointer to it.
  The scrub predicate was widened deliberately — `title IS NOT NULL` became
  `(title IS NOT NULL OR awaiting_envelope_id IS NOT NULL)` — a declared behaviour
  change, not one hiding in a refactor, and necessary since a job with a NULL title but
  a live pointer must still be picked up.
Task 8: fix round 2/5 opened for three items:
  (1) **the fix converted "parked job killed" into "parked job stranded."** After the
      pointer is cleared the job sits in `followup` with `closed_at IS NULL`, no waker
      (both parks leave `wake_at` NULL and `wakeDueJobs` requires it non-null), and no
      terminal state — while being unrunnable anyway, since its `job_plans` row went in
      the same transaction. The leak this codebase names outright: a phase with no reader
      is not a resting place. Ruled: move it to `failed` — it did not finish its work and
      the erasure removed what it needed — **and count it in the preview**, because the
      original complaint was that the owner approves a screen that says nothing about a
      waiting task about to die.
  (2) the `_`-wildcard control does not reach the new discovery query: the envelope row is
      reached through `parent_job_id` membership earned by four other seeds, so the sweep
      stays green even if this query's escaping breaks, and the dedicated test uses an
      identifier with no underscore. The escaping itself is correct — it interpolates the
      shared constant — so this is the control not covering the class, not a defect.
  (3) keeping the CHILD job does not shield the envelope. Defensible, undocumented.
Task 8: fix round 2/5 (3 addressed, 0 open; commits 7bcd092..91435e3). 1735 passed.
  The bypass of `transition()` was upheld, and the reviewer strengthened the case: it
  takes a SEPARATE pooled connection and would block forever on a row this transaction
  already holds `FOR UPDATE` — Postgres's deadlock detector would not even fire, since
  the outer transaction is blocked in the application rather than on a lock. And a second
  argument the implementer did not make: `transition()` commits independently, so a move
  made through it would survive a rollback of the erasure; the bypass keeps the phase
  change atomic with the deletes that caused it.
  The reviewer also enumerated which phases the predicate can reach (only `followup`) and
  confirmed `followup → failed` is legal, then checked every consumer of `plan.items` and
  proved `planFingerprint` already keys on `table:action:count` and sorts — so the second
  `'jobs'` entry can neither collide nor reorder the hash that stops a confirm from
  destroying a wider set than the owner read.
Task 8: fix round 3/5 opened for six items, all around the bypass:
  the legality guard lives in a comment rather than in the SQL (no phase guard in the
  `WHERE`, `from_phase` hardcoded, nothing that can fail); the stranded set is expressed
  twice in two languages against this module's single-predicate discipline; `wake_at` is
  not normalised; `total` double-counts one physical row for the first time in this
  function, inflating what the owner is told and the `inputHash`; the `fail` row renders
  under the label chosen for the title scrub; and a test docblock cites a precedent that
  says the opposite of what it claims — the fifth instance of that class here.
Task 8: Ruling on `total` — fix it by principle, not arithmetic: **`total` counts content
  destroyed, and failing a job destroys nothing.** The `fail` item stays visible in
  `plan.items` because the owner should see the job will be stopped; it simply is not a
  destroyed item.
  Cost if wrong: the owner's count omits a disposition they can still see listed.
Task 8: deferred to the final review (F7, deliberately out of scope): a live CHILD job is
  not refused and keeps running after its parent's envelope is erased. The liveness
  refusal covers only `jobIds`, so a parent discovered by its envelope payload can be
  failed while the child completes into a result nothing will ever read. This is the
  remaining asymmetry of round 1's decision to drop the `child_job_id` arm, and it is
  written down nowhere in the code.
Task 8: fix round 3/5 (6 addressed, 0 open; commits 91435e3..7bf3b82). 1735 passed.
  Item 1's mutation was the best-built proof in the branch: the implementer widened the JS
  filter, then drove a job legally to `verify`, planted `awaiting_envelope_id` on it with
  raw SQL, and showed the `fail` item reported 0, the phase never flipped, and no
  `job_steps` row claimed a false `followup → failed` — so both the SQL guard AND the
  `RETURNING`-gated insert refused.
  The re-reviewer checked every hazard I named about the computed column on the locked
  SELECT: the `WHERE` is byte-identical so the locked row set and its order are unchanged,
  the predicate is still evaluated before the first DELETE, the `$` numbering lines up
  because both statements bind `[businessId, jobIds]` in the same order, and `stranded`
  can never be NULL. It also noted the predicate references `business_id`, which the
  statement does not select — legal, since every column of the FROM relation is in scope.
Task 8: fix round 4/5 opened for three items:
  (1) **the `total` exclusion I asked for last round is unpinned** — `erasure.test.ts:232`
      computes it by the PRE-fix formula and is green only because that fixture's job never
      parks, so both formulas coincide at zero. Deleting the production `.filter(...)`
      fells nothing.
  (2) **three tables render as raw English identifiers on the screen the owner approves** —
      `agent_envelopes`, `verification_verdicts` and `autonomy_marks` have no
      `TABLE_LABELS` entry, and the fallback is `?? item.table`. Two are this task's own.
      That page's docblock says it must name every table it touches, and the project rule
      is Hebrew for humans. Also asked for an invariant deriving the expected set from the
      code, the way the erasure invariants read `information_schema` rather than a list.
  (3) one sentence naming which half of the predicate is shared and which is still twice.
Task 8: fix round 4/5 (3 addressed, 0 open; commits 7bf3b82..fdaeea0). 1737 passed.
  Item 1's mutation: `expected '...' to contain '7 פריטים'` against an actual
  `8 פריטים` — the stranded row double-counted across `jobs:scrub` and `jobs:fail`,
  exactly as diagnosed.
  The label invariant is genuinely source-derived — it parses the `await one('table',`
  calls out of `erasure-plan.ts` itself, and a companion assertion requires more than ten
  tables found and names the three new ones, so a broken extraction fails loudly instead
  of passing vacuously. The re-reviewer cross-checked the regex by hand: 17 calls, 15
  unique tables, matching `TABLE_LABELS` one to one.
Task 8: complete (commits 6a97f20..fdaeea0, review clean). 1737 passed.
  Four rounds, and each found something real: an over-deleting predicate that defeated the
  keep button, an erasure that terminated a parked job, a preview that omitted what the
  executor destroyed, a phase change written outside the one chokepoint that validates
  them, a total that counted one row twice, and three tables named in English on the
  screen the owner approves.

Task 9: DONE (658f94e). 8/8. Three mutations, three clean failures, each verified by the
  reviewer through hand-tracing rather than taken from the report. `ON CONFLICT
  (business_id, job_id)` checked against migration 028's actual primary key.
Review (sonnet): spec ✅. One Important and six Minor.
  Important: **the check extracts EVERY digit run**, so a date, a phone number or an
  order id the business itself assigned is reported as ungrounded — and Task 10 calls it
  against a full draft body. As written it fires on essentially every real outgoing
  message.

Task 9: Ruling — **and it starts with correcting my own brief.** I told the implementer
  the grounding result is a `must` criterion, so a false positive is a blocked send. That
  is NOT what this design does: spec §7.3 puts the verdict on the approval card and §7.4
  says explicitly that nothing — not a send, not a job closing — is conditioned on it. My
  brief overstated the stakes and the implementer reasoned correctly from what I gave it.
  The finding still stands, for a different reason: a control that lights up when nothing
  happened teaches people to click past it, which this project states outright. A line
  that reports three ungrounded numbers on every card is a line the owner stops reading.
  Ruled: narrow it POSITIVELY — exclude a digit run adjacent to `/`, `-` or `:`, which
  covers dates, phone numbers, times and ranges while keeping small amounts like `500`
  that a magnitude threshold would have discarded. An exclusion written as "what it sits
  next to" is checkable; one written as "probably not a quantity" is not. And require the
  docblock to state what the check CANNOT catch, because that half is the honest one.
  Cost if wrong: a hallucinated number that arrives inside a date or an identifier is not
  checked. Written down rather than discovered.
Task 9: also in the round — the sign is dropped entirely, so `-500` normalises to `500`
  and a credit turned into a debit is silently grounded, on the one axis this check exists
  for; and `numbersIn`'s null guard is deletable with the suite green, which would throw on
  a source chunk containing no digits at all.
Task 9: fix round 1/5 (4 addressed, 0 open; commits 658f94e..1403f5d). 1749 passed.
  Both mutations bit cleanly: removing the adjacency exclusion leaked the date and time
  digits (`expected [ '12500', '15', '10', '10', '30' ] to deeply equal [ '12500' ]`), and
  dropping the sign wrongly grounded `-500` against a source `500`.
  The implementer found a fourth limit while implementing — a hyphen preceded by a LETTER
  reads as a sign, so `ORDER-12345` becomes `-12345` — and wrote it down rather than
  leaving it. The re-reviewer walked all six sign cases individually and confirmed the
  disambiguation holds for each.
Task 9: fix round 2/5 opened for one regression and two documentation gaps.
  **The regression is real and specific to this market:** `nextChar === '-'` is
  unconditional, so `500-` — the standard Israeli and spreadsheet way of writing a
  negative balance — is discarded entirely. Before this round both sides dropped the sign
  and grounded correctly by accident; after it, a source reading `יתרה 500-` and a draft
  reading `זיכוי -500` no longer match, so a genuinely correct amount is reported as
  ungrounded on the owner's card. Fix: treat a following dash as separator noise only when
  a DIGIT follows it.
  Also: a docblock claim broader than the code ("an identifier" should be "digit-shaped
  identifier", since a letter-prefixed one IS checked, with a wrong sign), and one missing
  limit that is the mirror of the narrowing I asked for — two genuine amounts either side
  of a slash are both dropped, because an adjacency rule cannot tell a date from two real
  numbers.
Task 9: fix round 2/5 (3 addressed, 0 open; commits 1403f5d..71399a8). 1751 passed.
  Mutation: `expected [ '-500' ] to deeply equal []`. The re-reviewer walked all seven
  sign cases through the code in a table — `500-`, `1500-2000`, `052-1234567`, `-500`,
  `500 - 300`, `500-` at end of string, `500--` — and each reads correctly.
Task 9: fix round 3/5 opened for one item, and it is the mirror of the last one in the
  opposite direction. The trailing-side check tests only whether the next character is a
  digit, so a letter reads as a sign: a source containing `דגם 100-A` emits `-100` into
  the GROUNDED set, and a draft's genuine `זיכוי -100` is then silently reported as
  grounded. New behaviour — before this round the trailing branch was unconditional and
  could only ever DROP a number, never falsely ground one, so it flipped from
  safe-by-omission to silently-grounding. Ruled: a trailing sign may be followed by a
  terminator or punctuation, never by a letter or a digit.
Task 9: fix round 3/5 (1 addressed, 0 open; commits 71399a8..3343baf). 1753 effectively
  passing (the one red is the documented flaky concurrency test, 87/87 in isolation).
  Two mutations trip two DIFFERENT tests — one exercises the draft-side drop, one the
  source-side drop — so neither passes off the other's setup.
  The letter test is written positively as `/[\p{L}\p{N}]/u`, so Hebrew, accented Latin
  and Cyrillic all read as letters uniformly rather than by enumerating punctuation. The
  re-reviewer walked ten cases in a table and confirmed the change can only move a token
  from "compared" to "dropped on both sides symmetrically", so it cannot create a new
  equal/unequal collision in either direction.
Task 9: complete (commits fdaeea0..3343baf, review clean).
  Three rounds, and the shape of them is worth keeping: the first narrowing I asked for
  introduced a regression specific to this market (`500-`), and fixing THAT introduced its
  mirror in the opposite direction (`100-A` falsely grounding a real negative). Each was
  found only because the reviewer was asked to name a pair of strings whose comparison
  changed — not by asking whether the code looked right.

Task 10: DONE (c51abeb). 11/11 in its own file. Mutation (a) removed `refuseUnderTest` and
  **a real billed model call went through** — honest proof, and it also establishes that
  this machine now has a working API key, which changes the picture for Task 12's live run.
Review (opus): **spec ❌, one Critical.**
  Critical — **the quarantine boundary is already crossed.** `gov-verify.ts:54` imports
  `extractJsonObjects` from `planner.ts`, which imports `local-tools.ts`, which imports
  `readDocument`. No runtime read happens today, so the behavioural quarantine holds — but
  the control does not, and the control is what makes this agent's verdict mean anything.
  The invariant reads ONE file ONE hop; it filters to lines starting with `import` and then
  checks that same line, so a Prettier-shaped multi-line import passes everything (and
  `delegate.ts`, which this module imports, already carries two of those); and its path
  regex requires `from`, so a bare side-effect import and a dynamic import both pass. Its
  docblock cites `erasure-invariants.test.ts` as the pattern it follows — and that test
  walks all of `src/` recursively, scans WHOLE FILE source, and matches
  `(?:from|import\s*\()` precisely because the `from`-only version was the bug it fixed.
  Fifth instance of the citing-a-precedent class.
  Four more Important, and the ⚠️ I carried into this task was NOT done: `verifyDraft`
  takes the bundle from its caller and never calls `loadActiveCharter`, while every
  equivalent chain in production terminates at one. The report's justification was a
  non-sequitur — envelope verification says nothing about the bundle.
  Also: the judge prompt interpolates hostile text with no fencing, no cap and no
  untrusted-data instruction, against `brief.ts` and `render.ts` precedent; the signed
  charter's own `gov.verify` prompt fragment is compiled and ignored, so an amendment
  changes nothing; and five things in the file are deletable with the suite green,
  including `saveVerdict` in its entirety — no test reads a verdict back, so the whole
  persistence contract with Task 9 is unpinned — and `tools: []`, which the file's own
  comment calls its most safety-relevant line.
  The timing assertion was judged a weak pin and is being replaced with a state
  observation: no `job_step_results` row and no saved verdict, so "returned before the
  child produced anything" is asserted rather than timed.
Task 10: fix round 1/5 (Critical + 5 Important addressed; commits c51abeb..969b2db).
  1773 passed. Five mutations, five clean failures.
  The implementer found a SECOND independent quarantine edge I had not seen —
  `delegate.ts` → `intent-registry.ts` → `local-tools.ts` → `readDocument` — and closed it
  by moving a test-only helper into the test file. `extractJsonObjects` went to
  `src/util/json-extract.ts` and two other private duplicates were deleted with it.
  The re-reviewer **wrote its own static import-graph walker** rather than trusting the
  report, reproduced the six offenders at 3-4 hops, confirmed the second edge, verified the
  BFS terminates and survives cycles (seen-guard before expansion), and compared all four
  `extractJsonObjects` implementations byte-for-byte to prove the move changed no
  behaviour.
Task 10: fix round 2/5 opened for six items. **Three of them are tests that pass on
  nothing:**
  (1) the transitivity of the new walk is unpinned — capping at depth 1 gives 9 reached and
      zero offenders and the test still passes, so reducing it to the one-hop check it
      replaced goes green.
  (2) the charter-fragment pin is vacuous: `indexOf('MARKER')` is `-1` when the marker is
      ABSENT, which is less than any positive index, so dropping the fragment entirely
      leaves all four prompt tests green — the finding I raised last round is still unpinned.
  (3) the fence and both new caps are deletable with zero failures, because
      `renderJudgePrompt` is private and the constants are referenced by no test.
  And three real properties: the fence is escapable by an answer containing its own end
  marker (a convention the model is asked to honour, not a boundary the code enforces);
  truncation is not durably recorded and for the answer the notice lands INSIDE the
  attacker-controlled fence, so it is forgeable; and `curator.ts` still imports
  `extractJsonObjects` from `planner.ts`, leaving a second quarantine-crossing supplier
  that only `gov-verify.ts` has a walk to notice.
Task 10: fix round 2/5 (5 of 6 addressed, 1 open; commits 969b2db..7b2594f). 1777 passed.
  The transitivity pin now names a depth-3 and a depth-4 module, and the reviewer re-ran
  the walk itself to confirm both chains and that depth 4 is the graph's own maximum — so
  the second pin sits at the frontier rather than being a count.
  **Item 3 NOT addressed, and the reviewer proved it by running the strings:**
  `stripFenceMarkers` is a single-pass replace that rejoins and never re-scans, so
  `'=== סוף תוכן מצוט' + CLOSE + 'ט ==='` strips to EXACTLY the close marker. It rendered
  the prompt and got the fence opening, an immediate close, the attacker's forged draft
  OUTSIDE the fence, then the real close — `closeCount` 2. The exact escape the round
  claimed to have closed. Only the CLOSE-inside-OPEN direction is neutralised, by accident
  of pass order.
Task 10: Ruling — **do not iterate the strip; change the marker.** A byte-exact strip
  cannot hold against a model's parse either: `===  סוף תוכן מצוטט  ===`,
  `===סוף תוכן מצוטט===` and a bidi-marked variant all survive unchanged, and a truncation
  cut can CREATE a marker out of legitimate `===`-heavy text. Ruled: a **per-call random
  nonce** in both markers. The attacker cannot type what they cannot predict, so the whole
  class goes at once — no fixed literal to forge, whitespace variants irrelevant,
  near-misses irrelevant, truncation cannot synthesise one.
  Cost if wrong: a nonce per call, and the markers stop being greppable constants.
  Also in the round: `draftText` is neither fenced nor stripped, and a draft beginning with
  the open marker dresses itself as unjudgeable quoted text under the system prompt's own
  instruction — fail-open, same class; a stripped marker leaves no durable record, though
  an answer that tried to forge a fence is the most interesting thing an owner could learn;
  and NEW BREAKAGE — `answerTruncated` is a bare `z.boolean()` parsed with `.parse`, so
  `loadVerdict` now THROWS on any row written before this commit.
Task 10: fix round 3/5 (all addressed; commits 7b2594f..67d94e7). 1786 passed.
  The nonce is `randomBytes(16).toString('hex')`, one per call, passed explicitly to both
  prompt halves. The re-reviewer computed rather than reasoned: it built the nesting payload
  against the new scheme and got neither marker; it found that the OPEN→CLOSE synthesis
  direction IS reachable under a single pass and is closed only by the loop, not by the
  nonce; and it proved `stripUntilStable` terminates — each pass either fixpoints or removes
  a non-empty marker so length strictly decreases, measured on a 178 KB 2000-deep
  self-nesting input reducing to zero in 140 ms.
Task 10: fix round 4/5 opened for five items. **The first undoes the value of round 3:**
  `refuseUnderTest()` is the first statement of `judgeWithModel`, so every line after it is
  unreachable under test — including the nonce's generation and both calls that carry it.
  Dropping the argument from either call leaves the suite green AND type-checks, because both
  parameters are optional-with-default, and the two halves would then describe different
  markers. The closest test compares two renders and asserts they DIFFER, which a counter
  would satisfy.
  And four more: `question` reaches the prompt unfenced, unsanitised and unchecked, 500
  characters of un-quoted text above both fences from the same trust class as the answer;
  the forgery detector fires on ordinary document text — a setext underline, a `====`
  divider in a plain-text invoice, even `Total: 5 === 5 === ok` — which is the noisy-control
  doctrine, and an attacker can deliberately set it on every verification to desensitise;
  `.default(false)` makes unreadable mean BENIGN for a security signal, the inverse of the
  house rule, where `.optional()` would let a future reader tell "old row, unknown" from
  "checked, clean"; and NEW BREAKAGE — the draft got the answer's fence and cap but not its
  truncation record, so a 4,500-character draft is silently cut and the verdict can read
  `passed: true` with nothing saying the judge never saw the tail.
Task 10: fix round 4/5 (5 addressed, 1 partial; commits 67d94e7..360cadc). 1791 passed.
  `buildJudgeCall` is pure and runs outside the test guard, and the assertion PULLS the
  fence line out of the returned prompt and requires that exact string in the system prompt
  — proving the two halves agree rather than assuming it.
  The tightened detector was computed against all five payloads: the setext underline, the
  invoice divider, `=== Section ===` and `Total: 5 === 5 === ok` are all now false, while
  both real marker forms still trip. And the narrowing provably cannot miss a viable
  forgery: any string that could collide with a live marker must be the exact label plus
  ` :: ` plus 32 lowercase hex, and every such string matches — what it stopped flagging
  (a bare label, an uppercase or 31-character guess) could never have matched a real
  marker, because `freshNonce()` is always 32 lowercase hex.
  Reviewer's adjudication list: **nothing must-fix before merge**, four residuals all
  "safe to defer".
Task 10: Ruling — I spent the fifth and final round on all four residuals anyway. Three of
  them are defect classes this project has already paid for: an untested guard that is
  deletable with the suite green (the class round 1 existed to close, reintroduced one round
  later at smaller scale); a fence label and contract prose claiming the question "comes
  back through an untrusted layer" when it does not round-trip at all — the fifth instance
  in this branch of a comment claiming what the code does not do; a comment asserting a fact
  about a caller that does not exist, where the erasure docblock IN THE SAME COMMIT handles
  the identical uncertainty correctly by saying it cannot be seen from there; and
  `FENCE_LABELS` hand-kept in sync with three other places, where missing the fourth edit
  leaves a field fenced and sanitised but invisible to the forgery detector — the "a new
  write tool needs two edits" shape this project locks with invariants elsewhere.
  Cost if wrong: four small edits at the end of a five-round task.
Task 10: fix round 5/5 (4 addressed, 0 open; commits 360cadc..c659a44). 1792 passed.
  Item 4 was fixed by DERIVATION rather than an invariant: one `FENCED_FIELD_LABEL` record
  that the prompt renderer, the output contract and the detector array all read, with the
  three per-field constants kept as true aliases. Each label string now appears exactly once
  in the file, and a fourth key reaches the detector with zero extra edits. The remaining
  gap is stated in its own docblock rather than hidden — nothing type-enforces that a future
  `buildFence` call sources its label from the record.
Task 10: complete (commits 3343baf..c659a44, review clean). 1792 passed.
  Five rounds, and the arc is worth keeping. The quarantine boundary that makes this agent's
  verdict mean anything was already crossed transitively when the task first reported done,
  and the invariant written to catch it read one file one hop. Closing that surfaced a second
  independent crossing. Then the fence protecting the judge's prompt was defended by a strip
  that **synthesised the very marker it removed** — proven by running the strings, not by
  reading the code — and replacing the fixed marker with a per-call nonce made the whole
  class disappear. Three separate times a test written to lock a finding passed on nothing:
  a depth-1 walk, an `indexOf` comparison that succeeds when the marker is ABSENT, and a
  guard reachable only in production because `refuseUnderTest` returns before it.

Task 11: DONE (8587827). 1799 passed. The discovery-query question the erasure docblock left
  for this task was answered with real reasoning: `beginVerification` binds no plan to the
  `gov.verify` job, so a verdict's quoted draft is NOT reachable through `job_plans.plan` the
  way a plan-issued delegation's payload is — so a query is genuinely needed, and it was added
  with a wildcard test matching its siblings.
Review (opus): **spec ❌, two Criticals.**
  Critical 1 — **the verdict is stored under one job id and the card looks it up under
  another.** `saveVerdict` keys on the delegating (`gov.verify`) job; `server.ts` loads by the
  approval's job, which is the DOCUMENT's job. Nothing links them, so the verdict can never
  appear on the card — the task's entire deliverable. And it is structural: `requestHelp`
  requires the delegating job to be in `execute`, while the document's job is in
  `await_approval` by then, so the document job can never legally be the delegating one.
  **The test could not see it because it wrote the row by hand under the document job — 
  fabricating exactly the linkage production does not create.**
  Critical 2 — the lifecycle docblock says the verification job "will sit in `execute`
  un-rerun". It will not: `resumeDelegatedJobs` wakes it, `runDueJobs` finds no bound plan and
  transitions it to `failed` with `no_plan_bound`, and the scheduler prints an operator error
  line — and `run-due.ts` itself names the conductor as the first production producer of
  exactly this. So every carded document leaves a failed job and an error line on a healthy
  installation, and the whole "documented dormancy is acceptable" argument rested on that one
  false sentence. Fifth instance of the citing-a-precedent class in this branch.
  Five Important, including: a bad verdict row 500s the owner's ENTIRE decision surface
  (approve, deny, edit, note and sign) because `Verdict.parse` is unguarded on the card path,
  and `verdict-store.ts` warned about precisely this, saying the blast radius was small only
  because nothing read a verdict back — which is what this task changed; `sources` is the
  TRUNCATED prompt brief rather than the artifact text, so a number appearing only in a
  dropped section reads as ungrounded and nothing records the cut; and the number
  reformatting renders `0521234567` as `0,521,234,567`, asserting a grouping the draft never
  had and destroying the one thing the reformatting was for.
Task 11: Ruling — print the stored token verbatim with a sentence saying it is a normalised
  comparison form, rather than reformatting. That is the posture this codebase already takes
  when it shows a sha256 prefix beside a filename instead of prettifying the name.
  Cost if wrong: the owner sees a number spelled unlike their own draft, with the reason said
  out loud.
Task 11: fix round 1/5 (2 Critical + 5 Important + 3 minor addressed; commits
  8587827..8ff2a98). 1806 effectively passing.
  The two job ids are now separate required fields with no defaults, and — the part that
  matters — the test creates the row through the PRODUCTION path: real `verifyDraft`, real
  `saveVerdict`, real `loadVerdict` on both ids. The conduct test bites only because
  `requestHelp` refuses `job_not_executable` when the ids are conflated, which is the
  structural fact that made the original bug possible.
Task 11: fix round 2/5 opened, and **the first item is a regression my own instruction
  caused.** I told the implementer to pass the artifact text rather than the truncated brief.
  It passed the stored `content`, which is JSON — and `numbersIn` skips any digit run
  preceded by `:`, while `JSON.stringify` emits no space after a key colon. So
  `{"v":11988,"t":"number"}` drops the amount, the grounded set comes back EMPTY, and because
  `sources` is non-empty the "an empty source list grounds everything" safety never fires —
  **every number in the draft is reported ungrounded.** On an `.xlsx` quote, the canonical
  case and this module's own fixture, the card lists the correct amount as unverified. The
  old brief path grounded it correctly because it rendered cells pipe-separated. What I asked
  for was the untruncated extraction, not its serialisation.
  Four more: `verificationFailed` reaches no operator while its docblock says it does (the
  scheduler prints five other buckets and not conduct's); a `Verdict` return falls through the
  terminal transition and leaves the job in `execute` unbound — the exact state Critical 2
  removed, one branch over; the extractors cap BEFORE storage and record it in
  `artifact.flags`, which is discarded, so "nothing dropped" is still untrue one layer down;
  and the new comment's own example reintroduces the separator the sentence says is gone.
  Ruled: the cross-process race window gets written down rather than solved — one scheduler
  runs here and the pass lock serialises the common case, but the next reader should meet it
  as a known limit rather than as a mystery in a log.
Task 11: fix round 2/5 (5 addressed, 0 open; commits 8ff2a98..48572a5). 1810 passed.
  `renderArtifactFull` reuses the brief's own cell and block layout without its two caps.
  The re-reviewer ran all four artifact shapes — spreadsheet, CSV, text, outline — through
  the real renderer and the real `numbersIn` as strings, and every one now grounds, while
  dates and phone numbers still correctly do not. It also measured that a pipe or a newline
  inside a cell value can neither create a false grounding nor hide a number.
  Nothing must-fix; six residuals, all "safe to defer".
Task 11: fix round 3/5 opened, pulling in the reviewer's out-of-scope item because it
  matters more than the six residuals together and is specific to this market.
  **`numbersIn` treats a dash before digits as a sign unless a digit precedes the dash — but
  Hebrew writes `ו-950`, `ב-11,988`, `ל-7.5` as the natural form.** Measured, those normalise
  to negatives and do not match the source, so every one lands on the owner's card as
  ungrounded. Round 1 removed the catastrophic case (every number on every spreadsheet); this
  one still fires on an ordinary business letter, which is the document the owner actually
  reads a card about. `LEADING_HEBREW_PARTICLE` already exists in `typed-recipients.ts` and is
  already imported rather than duplicated by the contact resolver.
  Also: the full renderer is a line-for-line copy of the capped one and nothing pins them
  equal — the test named "renders a table the same way `renderReadingBrief` does" asserts a
  hard-coded literal and never calls it, so changing the separator in one path leaves the
  suite green while the two diverge. Ruled: collapse to one function with the caps as
  parameters.
Task 11: fix round 3/5 (4 addressed; commits 48572a5..5b15e9b). 1818 passed. The renderers
  collapsed into one function with the caps as parameters, and the re-reviewer mutated the
  shared separator and confirmed a capped-path test AND a full-path test fail together while
  the derived equality test correctly passes both ways.
Task 11: fix round 4/5 opened — **my round-3 instruction introduced a false negative on
  money, and the reviewer proved it by transpiling the file and running it.**
  `LEADING_HEBREW_PARTICLE` is anchored with `^` and its home callers apply it to a
  whitespace-split token. Applied instead to a two-character window cut from the middle of the
  text, the anchor binds to an artificial cut — so what is actually enforced is "the one
  character before the dash is one of these seven letters", with no boundary check. And the
  set includes **ה**, the most common word-final letter in Hebrew.
  Measured: `הנחה-500`, `יתרה-1,200` and `סה"כ-500` now all read POSITIVE, so a draft stating a
  credit the document never carries grounds silently against the document's charge. `הנחה`,
  `יתרה`, `עמלה`, `הוצאה`, `הכנסה`, `חובה`, `הלוואה` all end in ה. That is a false negative on
  money, in the one place this module tracks signs — and `numbersIn`'s own docblock says the
  sign tracking exists so a draft that turns a credit into a debit cannot silently ground.
  The docblock asserted no boundary check was needed. It was wrong, and the report repeated it.
  **Third consecutive instruction of mine on this function that introduced a regression in the
  opposite direction** — narrowing for dates broke the trailing minus, fixing that let a model
  code ground a real negative, and fixing the Hebrew particle now hides one. Each was caught
  only because the reviewer was asked to name a pair of strings whose outcome changed.
Task 11: fix round 4/5 (3 addressed; commits 5b15e9b..f93ad9a). 1820 passed. Mutations:
  `expected [] to deeply equal ['-500']` and a `TypeError` on the malformed cell.
Task 11: fix round 5/5 opened — **a fourth regression in the opposite direction, and the
  answer was already in this repo.** The boundary condition rejects the particle if ANY letter
  precedes it, but **Hebrew stacks prefix particles** — `contact-resolver.ts:38` has
  `MAX_PARTICLE_LAYERS = 2` and a docblock saying so, and CLAUDE.md states the same rule; I
  built that myself in the contact-resolver subproject. So `מה-5,000` ("from the"), `ול-950`,
  `וב-11,988`, `וה-1,200`, `כשה-2024` and `ומ-50` — six measured pairs — all flipped from
  grounded to flagged, and those constructions are far more common in ordinary Hebrew business
  text than `הנחה-500` with a glued minus.
  Ruled: peel the particle chain the way the contact resolver already does, then require a
  non-letter at the chain head. Verified against both corpora: the stacked forms read as
  prefixes, while `הנחה-500`, `יתרה-1,200`, `עמלה-75` and `ההנחה-500` stay signed.
  Also: the round-4 docblock describes the bug it fixed BACKWARDS in three places — it says
  round 3 read `הנחה-500` as `-500` and "matched nothing", where measurement shows it produced
  the unsigned `500`, MATCHED, and therefore passed silently; and a `שלב-2` sentence whose
  parenthetical correctly negates the clause it modifies. Fifth instance in this branch, and
  load-bearing: the next reader deciding whether that string is positive or negative would read
  line 135 and conclude the committed behaviour is the bug.
Task 11: fix round 5/5 (2 addressed; commits f93ad9a..8e08022). 1822 passed. The re-reviewer
  bundled three commits of the file with esbuild and drove the real exported function, then
  measured 22 Hebrew accounting labels — `הנחה יתרה עמלה חוב חובה חיוב זיכוי הפרש הכנסה
  הוצאה סכום תשלום החזר ניכוי ריבית שכר מס קנס מכס מלווה הלוואה שווה` — and **every one still
  reads signed**, because any word of four letters or more puts a real letter at the chain
  head. So no money false negative was introduced. It also confirmed the rule only ever
  widens, so nothing can flip unsigned→signed, and that the reused regex carries no `g` flag,
  which would itself have been the fifth regression.
  Accepted casualty, measured and recorded: `שלב-2` now reads unsigned, because a 1–3 letter
  token drawn entirely from the particle set is mechanically indistinguishable from a genuine
  stack. The swept words are connectors (`של`, `מה`, `כמה`), not amount labels.

Task 11: **ROUND CAP REACHED — adjudicating the three open findings myself.**
  Ruling 1: `numeric-grounding.test.ts:203-205` names the wrong blocker in its `עמלה`
  explanation (it says `מ`, which is peeled; the blocker is `ע`) and contradicts its own line
  two above. Prose only, no behaviour. **Parked and carried into the final review's fix wave**
  rather than opening a sixth round.
  Ruling 2: `numeric-grounding.ts:254-255` says `ו־950` with a maqaf "still reads as `-950`";
  measured, it reads `950` — correctly — because the maqaf never enters the hyphen branch at
  all. Prose only. Same disposition. This is the fifth backwards-docblock in this branch, and
  the round convened to remove them left one in place.
  Ruling 3: a four-deep stack (`וכשה-2024`, `ולכשה-`) falls back to a sign because the peel
  caps at three, and the cap's rationale does not record it. Live, in the FALSE-POSITIVE
  direction only — the cap can never suppress a sign, only produce one. Parked and carried.
  Cost if wrong for all three: two sentences of prose and one recorded limit, none of which
  any later task builds on.
Task 11: complete (commits c659a44..8e08022, 5 rounds, 3 parked). 1822 passed.


Task 12: review of 0909408 returned **spec ❌** — 1 Critical, 6 Important, all small.
  Critical: `run-delegate.ts:249-254` passes `curator: async () => ({ candidates: [] })` into
  `closeVerifiedJobs`, which forwards it **per job** over a business-wide query (`verify.ts`,
  limit 20, oldest-first). Any unrelated job sitting in `verify`/`remember` would be closed
  through `remember` with a curator returning nothing, and a closed job is never re-curated —
  permanent loss of curation on rows the script never opened. The script's own docblock argues
  `touched` is empty for the probe child, which makes the stub unnecessary; it is the stub that
  creates the blast radius. Fix: delete the option.
  Important 1: `runDueJobs({ limit: 5 })` — probe child is newest, sorts LAST by `updated_at`,
  so on a backlog it is not in the batch while five unrelated plans execute for real.
  Important 2: five of the script's checks cannot fail (two `'auto'`==`'auto'`, two `null`==`null`,
  two SQL tautologies, one phase set three lines earlier). Only `provenanceCeiling` and the
  deadline window carry weight.
  Important 3: `docs/09-roadmap.md:107` states `gov.verify`'s role backwards — "נמען בלבד"
  where it is requester-only, contradicting `intent-registry.ts:6-8` and inviting the exact
  edit that file's docblock forbids.
  Important 4: `CLAUDE.md:382` — "המעטפת נושאת מצביעים, ולעולם לא טקסט" overstates; `payload`
  is where text lives (`z.unknown()`, `question: z.string().max(500)`, `note: z.string()`).
  The code's docblock is correctly scoped to `contextRefs`. Fifth doc-overstates-code instance
  in this branch, and it landed in the file that tracks that class.
  Important 5: `docs/03-protocol.md:175,193` still assert the envelope/`hops`/`help_request`
  do not exist — left false by the branch that made them false, in the spec a future
  implementer opens to add the remaining four envelope kinds.
  Important 6: the roadmap's open-items paragraph stops short of the consequence —
  `transition(..., 'failed')` nulls `awaiting_envelope_id`, so on the conductor path no
  `result` envelope is ever written and the child's billed read is discarded unread;
  `resumeDelegatedJobs` is a no-op by construction today while CLAUDE.md calls it exercised.
Task 12: fix round 1 dispatched to a0b6fd706c8da668b (7 must-fix + 5 minors).
Task 12: fix round 1 landed — commit 4deb668. Scope verified by the controller before re-review:
  4 files, 105+/31-, and **no production module touched** — `src/sdk/run-delegate.ts` (the script)
  plus `CLAUDE.md`, `docs/03-protocol.md`, `docs/09-roadmap.md`. The curator stub is gone;
  `QUEUE_LIMIT = 500` is declared at `run-delegate.ts:111` and used only by the script's three
  business-wide calls, so `verify.ts`/`run-due.ts`/`resume-delegated.ts` keep their own defaults.
  Scoped re-review dispatched (sonnet) against the fix diff.
Task 12: scoped re-review returned all seven findings **addressed**, no new problems.
  The re-review reported 3-7 and the five minors but **skipped 1 and 2**; the controller verified
  both directly in the code rather than accepting the report:
    1 (Critical) — `run-delegate.ts:312` calls `closeVerifiedJobs({ businessId, limit })` with no
      `curator` key anywhere in the file; the only remaining mentions are the docblock and an
      inline comment explaining why a stub is refused. The real default curator now runs for
      every job in the pass, exactly as a production scheduler pass would.
    2 — `QUEUE_LIMIT = 500` (`:111`) is used by all three business-wide calls (`:295`, `:312`,
      `:322`), and the docblock now states in bold that the script drives the business's whole
      execute/verify/remember/followup queue and that the probe's rows sort LAST.
  `git diff 0909408..HEAD` over `src/orchestrator/`, `src/governance/`, `src/policy/`,
  `src/memory/` is empty — the fix reached no production module.
  Ruling on what the fix deliberately buys: `npm run sdk:delegate` now spends real curation
  model calls on unrelated jobs in the business's queue. That is the honest behaviour (identical
  to a scheduler pass) and the caveat is carried in CLAUDE.md's commands block; the alternative
  was the destructive stub. Cost if wrong: a documented, reversible spend on an operator-run
  script, versus permanent loss of curation.
Task 12: complete (commits 0909408..4deb668, 1 round, 0 parked).

/security-review (opus, branch vs main, 76 files): **clean — zero findings above the bar.**
  Note: the skill's own capture computed a base predating the credential-broker merge and listed
  ~350 files; the review was pointed at the true delta (`git diff main...HEAD`) instead.
  Verified, each by opening the code: (1) `tightenConstraints` takes the stricter side on all five
  fields AND the caller's claim of ancestry cannot widen anything — `requestHelp` uses
  `input.parentEnvelope` only as an id, re-loads the row, and refuses unless
  `stored.childJobId === parent.jobId`; (2) `rampLevelForPlan`'s permissive `'auto'` fires only
  when `levels` is empty, and read-only tools short-circuit at stage 4 before stage 8 reads the
  value — a mixed plan cannot run its outbound step at a loosened ceiling; (3) stage 3 uses
  `Object.hasOwn` + `AgentId.safeParse`, sits after the allowlist and before stage 4, and the
  graph is compiled from a constant, not owner-editable JSON; (4) the reviewer wrote its own BFS
  over `gov-verify.ts`'s transitive imports — 35 files, none under `src/documents/`, neither
  `local-tools.ts` nor `planner.ts`; both previously-breached chains closed; (5) one
  `randomBytes(16)` nonce per call reaches both prompts via `buildJudgeCall`, so the
  two-independent-nonce failure is structurally excluded; (6) guards 4 and 5 filter
  `kind='help_request'` so swapped-direction `result` rows cannot corrupt them, and guard 3 runs
  first so a resumed call is never refused by a time-varying counter; (7) all 11 statements in the
  two new stores lead with `business_id = $1`, judged on their own merits and not on AEAD binding;
  (8) both new tables are wired into erasure as deletion targets AND as discovery sources, and
  `LIKE_ESCAPE` is `String.raw` — the correct spelling of the bug CLAUDE.md records;
  (9) the three newly rendered untrusted values all go through `escLabel`.
  Two latent hazards named as non-findings, carried to the final fix wave for a ruling:
    (a) `requestHelp` accepts `parentEnvelope: null` without proving the parent has no incoming
        envelope — unreachable from attacker input today (all three callers derive or freshly
        create the parent) and it loosens only the loop counters, never provenance/money/autonomy.
    (b) `toEnvelope` (`envelope-store.ts:38`) casts `constraints`/`contextRefs` with `as` instead
        of re-parsing with zod on read. Only `writeEnvelope` writes those rows, from validated
        objects, so nothing attacker-reachable can plant a malformed ceiling.

FINAL WHOLE-BRANCH REVIEW (opus): **ready to merge after a documentation-accuracy pass.**
  No behavioural defect, no unreachable guard, no test that passes on nothing. Every finding is
  prose the code contradicts, plus one large by-design dead end that is disclosed in the roadmap
  but missing from CLAUDE.md. Findings verified by the controller where they correct my own claims:
  - Five docblocks still say a later task is unbuilt; all five are built. `envelope-store.ts`
    contradicts ITSELF at :328/:439 vs :361 on whether `resumeDelegatedJobs` reads the child index.
  - **CLAUDE.md's no-op claim is over-broad, and I authored it in the Task 12 round.** Verified in
    code: `local-tools.ts:449` calls `requestHelp` and returns `parked: true` at :467, wired through
    `run-plan.ts:512` to `execute.ts:401` — a SECOND, live producer of a parked parent. The no-op is
    real only on the conductor path.
  - **The verdict half has no production writer.** Verified: `saveVerdict` sits behind
    `if (input.answer !== null)` and `conduct.ts:240` hard-codes `answer: null` (its own comment at
    :254 says so). So `judgeWithModel` never runs in production, the nonce fence governs nothing
    yet, and `numeric-grounding.ts` (326 lines) is consumer-free. Disclosed in the roadmap, absent
    from CLAUDE.md.
  - **My Task 12 finding 7 was wrong on one word.** The child's read is a CACHE HIT, not a billed
    call: `loadLatestReading`'s key matches because the child's provenance is `tightenConstraints`
    over the parent's `unknown_external`, equal to the conductor's. Real waste is two jobs and one
    audit row against `DELEGATIONS_PER_DAY`, not money.
  - The three parked Task 11 rulings are all still present and still wrong as stated.
  - Minors: two exported `DelegationOutcome` symbols with unrelated shapes; two `failCorruptedParent`
    arms untested. Spec §6.1's "eight of fifteen" is ten — arithmetic, not a rule; spec left alone.

Ruling on the one open item the review left to me: **the exhausted-NORMAL-cap churn (~288 wakes/day)
  stays unfixed.** The fix is `StepChannelError` carrying `wakeAt` — a behavioural change to the
  retry path at the end of an otherwise-green branch, for a state that only occurs once a daily cap
  is exhausted. The note moves from a code comment into CLAUDE.md's known-issues section so it is
  recorded rather than rediscovered. Cost if wrong: churn on an exhausted cap, visible in the audit
  log and bounded by the cap itself.
Ruling on the security review's two latent hazards: **both close now**, as positive controls rather
  than comments — `requestHelp` refuses when `parentEnvelope` is null but the parent already has an
  incoming envelope, and `toEnvelope` re-parses with zod on read instead of casting. Each gets a
  test. Cost if wrong: a refusal on a path nothing currently takes.

ONE fix wave dispatched (opus, fresh implementer) against
  `.superpowers/sdd/2026-09-23-agent-envelope/final-fix-brief.md` — sections A-J.
