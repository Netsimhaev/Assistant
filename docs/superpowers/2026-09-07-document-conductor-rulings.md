# SDD ledger — plan: docs/superpowers/plans/2026-09-07-document-conductor.md

Branch: document-conductor (off main @ 17e0236)
Spec: docs/superpowers/specs/2026-09-07-document-conductor-design.md — read, binding.

## Pre-flight scan

### Task-pair rows (shared file or interface)

| Pair | Produced | Consumed | Finding |
|---|---|---|---|
| T1 → T4 | `documentsAwaitingRead(limit, opts)`, `recordReadFailure(id, msg, opts)`, `readingsToday(opts)` | same three, same arg order | agree |
| T3 → T4 | `raiseProposalApproval(input, opts): Promise<string \| null>` | branches on `=== null` | agree |
| T2 → T5 | `scanInbox(opts): Promise<ScanResult>` | `result.scan` | agree |
| T4 → T5 | `conductPendingDocuments(opts): Promise<ConductResult>` | `result.conduct` | agree |
| T1 → T7 | `.env.example` entries | T7 verifies them | not a conflict; T7 is a check, not a rewrite |
| T6 → T6 | `recentReadings` → `renderReadings` | `ReadingSummary` | agree |
| T1 ↔ T6 | both write raw SQL against `document_readings` | — | **DEFECT P1/P2, see below** |

### Per-task self-agreement rows

| Task | Its tests vs its code | Finding |
|---|---|---|
| T1 | test SQL vs real schema | **P1 — broken** |
| T2 | test asserts subdirs + no re-ingest vs claim-by-rename | agree |
| T3 | tests assert null-return paths vs two early returns | agree |
| T4 | reader/proposer stubs vs the real seam types | **P3 — broken** |
| T5 | test asserts `scan`/`null` vs the widened result type | agree |
| T6 | test SQL and query columns vs real schema | **P2/P6 — broken** |
| T7 | invariants vs the strings T3/T4 actually contain | agree |

### Findings and rulings — all four are defects in MY plan, ruled before dispatch

Ruling: P1 — my `document_readings` test INSERTs named a `reading` column and a
`raw` column. The real columns are `content`, with no `raw` on readings, and
`status`/`model`/`prompt_version` are NOT NULL and were omitted. Corrected the
plan against `reading-store.ts`'s own INSERT, which is authoritative.
Cost if wrong: T1 and T6 fail at the first test run — visible immediately.

Ruling: P2 — same class on `proposals`: `content` not `proposal`, plus required
`model` and `prompt_version`. Corrected against `proposal-store.ts`.
Cost if wrong: T6 fails at its first test run.

Ruling: P3 — my `reader` stub returned `{status, reading, raw}`, but `ReadOutcome`
carries `denials` and `turns` on both branches. Added them.
Cost if wrong: T4 fails typecheck, not silently.

Ruling: P6 — `recentReadings` selected `r.reading` / `p.proposal`; aliased
`r.content AS reading` and `p.content AS proposal` so the row interface is
unchanged. Cost if wrong: T6's query throws on an unknown column.

Ruling: noted that `DocumentRecord` lives in `src/documents/types.ts`, not
`store.ts` — the plan said "and to DocumentRecord" without saying where.
Cost if wrong: an implementer edits the wrong file and typecheck catches it.

Verified correct and left alone: `installCharter(charter, { businessId })`,
`BusinessCharter.charterVersion`, `ProposeOutcome` (my proposer stub already
matched), `DocumentRecord.originalName`, `LEGAL_TRANSITIONS` allowing
`intake → understand → plan → await_approval` and `plan → closed`.

## Execution

Task 1: complete (commits 8912a84..887fa1e, review clean)
Task 1: minor (deferred): `documentsAwaitingRead` uses `SELECT d.*` while sibling readers use explicit column lists — a future column rides along unnoticed.
Task 1: minor (deferred): `positiveInt` in config.ts accepts 0; `nonNegativeInt` is the honest name.
Task 1: minor (deferred): no test exercises a cross-business `document_readings` row against `documentsAwaitingRead`'s NOT EXISTS correlation (the sibling `readingsToday` test does prove the schema hazard is real).
Task 1: note — implementer necessarily edited two files beyond the brief: `document-for-approval.ts` (its own private DocumentRow duplicate) and `loadDocument`'s explicit SELECT list, which would otherwise have returned the new fields as undefined. Reviewer searched for a third such place and found none.

Task 2: review found 2 Critical, 3 Important, 2 Minor. Both Criticals are defects in MY plan text, transcribed faithfully.
Task 2: Ruling: C1 — the plan wrote the ingest outcome as `if (status === 'rejected') … else …`, which files a stuck `pending` document into `processed/` and counts it ingested; `insertOrGetDocument` returns an existing row without throwing, so one prior partial failure makes every later arrival of those bytes silently succeed. Replaced with a positive three-way switch and a fourth `failed/` folder. Cost if wrong: a fifth ScanResult counter nobody reads.
Task 2: Ruling: C2 — the plan's catch filed thrown faults as document rejections, and its comment claimed ingest throws for hostile files (it does not; every document verdict is a returned status). A fault now moves the file back to the inbox root and counts `deferred`, so it retries. A permanent fault loops visibly, which is recoverable; mislabelling good documents in the owner's own record is not. Cost if wrong: a genuinely poisonous file loops each pass instead of being filed away.
Task 2: Ruling: I2 — `moveWithoutClobber`'s stat-then-rename is check-then-act and `fs.rename` clobbers on every platform Node targets. Replaced with `link`+`unlink` (EEXIST is the atomic no-clobber signal), falling back to rename only on EXDEV/EPERM. Cost if wrong: a filesystem without hard links takes the documented non-atomic path.
Task 2: fix round 1/5 dispatched (resumed implementer a22139e)
Task 2: fix round 1/5 (8 addressed, 1 new — the try-split left the three positive-path moves unguarded, worse than before; commits db9a8e1..17a71cb)
Task 2: fix round 2/5 dispatched — guard the three positive-path moves, and do not increment an outcome counter when the move itself failed.
Task 2: fix round 2/5 (1 addressed, 0 open; commits 17a71cb..aef2d3e)
Task 2: complete (commits 887fa1e..aef2d3e, review clean). Suite 1119 green on a quiet database.
Task 2: note — the round-2 re-reviewer edited the working tree to verify a mutation despite a read-only instruction, and restored it; controller confirmed clean before dispatching Task 3.

Task 3: implementer reported DONE_WITH_CONCERNS — my Step 5 mutation did not fail. Verified: with `provenanceChainDerived: false` hardcoded, the first-contact exemption cannot fire, so the band is `sensitive` under either provenance (boss total 21, unknown_external 28 — same band). The assertion held with and without the code it claimed to cover.
Task 3: Ruling: assert `risk.dimensions.provenance.level` directly. `assessRisk` copies `facts.provenance` verbatim onto that dimension (risk.ts:98-101) and `enqueueApproval` stores the whole assessment as jsonb, so the stamp is observable exactly with no arithmetic between. Cost if wrong: an assertion coupled to a field name that a risk-engine refactor could rename — cheap to spot, unlike a test that silently proves nothing.
Task 3: fix round 1/5 dispatched (resumed implementer ab0eb7d)
Task 3: fix round 1/5 (1 addressed, 0 open; commits b87ced8..ecc6e1c)
Task 3: complete (commits aef2d3e..ecc6e1c, review clean, no findings). Suite 1124 green on a quiet database.

Task 4: review — provenance confirmed unforgeable (inline literal, no field on ConductOptions, proposeForReading re-derives from the job row). 4 Important, 6 Minor.
Task 4: Ruling: I1 — the catch protects the batch and abandons the job; no phase reader exists for intake/understand/plan, so every throw strands a row forever. Added a guarded job-level `failed` transition in the catch. Cost if wrong: a transition failure inside the catch is swallowed silently, which is why it gets its own try.
Task 4: Ruling: I2 — MY plan made `documentsAwaitingRead` exclude documents that have a *reading*, so any throw after the read paid for the reading and retired the document forever, with no card. Reachable via `readAmountMinor` throwing TypeError on a decimal `amountMinor` a model read off a hostile invoice. Completion marker changed from reading to **proposal**: a re-read is a cache hit (free, writes no row, does not consume the ceiling), `unproposable` still writes a proposal row so genuine dead ends terminate, and `read_attempts < 3` still bounds it. Cost if wrong: a document with a reading but no proposal is re-selected each pass until the attempt cap, at zero model cost.
Task 4: Ruling: I3 — two overlapping passes double-spend the ceiling and produce two cards for one document. Added `pg_try_advisory_xact_lock` on the business, following runDueJobs' precedent; try_ and not blocking, so a second scheduler skips the round rather than repeating the first's work. Cost if wrong: a contended round does nothing and retries next interval.
Task 4: Ruling: M2 parked — `ceilingReached` cannot distinguish three stop reasons; defensible, and the caller that would care does not exist.
Task 4: Ruling: M4 parked — `original_name` reaches `jobs.title` carrying bidi characters; nothing renders jobs.title today, and the control belongs where a reader first prints it.
Task 4: fix round 1/5 dispatched (resumed implementer ab7c8e6)
Task 4: fix round 1/5 (4 Important + 3 Minor addressed, 0 open; commits ab4a21d..072dcdb). I2's load-bearing claim verified at source: a re-read is a cache hit for `unreadable` rows too, writes no reading row, spends no ceiling.
Task 4: complete (commits ecc6e1c..072dcdb, review clean). Suite 1132 green on a quiet database.
Task 4: minor (deferred, FOR FINAL REVIEW): conduct.ts's comment claims it follows run-due.ts's precedent for the connection checkout. It does not — run-due connects per job and releases per job; conduct holds one connection for the whole pass. The parity claim is true only of the unlock/destroy handling. This is the "comment asserting a property the code does not have" pattern this project has hit three times today.
Task 4: minor (deferred): no mutation was run for I3 (delete the lock acquisition, confirm `considered` sums to 2 across two overlapping passes). The race test is real — the reviewer judged it stronger than the implementer claimed — but the cheap isolation was skipped.
Task 4: minor (deferred): a pending card can outlive its job if the await_approval transition throws after enqueueApproval returns. `resumeAfterDecision` guards on phase and returns cleanly, so the card is inert and expires. New state, not a break.
Task 4: minor (deferred): two test orderings tie-break on created_at alone where documentsAwaitingRead itself adds `, document_id ASC`.
Task 4: note — pool exhaustion would surface as a document marked failed with a pool-timeout string in read_error and an attempt burned; a capacity problem written into the record as a document defect. Arrives around ten concurrent business passes.

Task 5: review — ordering, typing, three-way inbox handling and the CloseVerifiedResult correction all clean. 2 Important, 2 Minor.
Task 5: Ruling: I1 — an unguarded scanInbox throw starves conduct/due/verified every interval, and crashes run-scheduler.ts on launch. This is a spec violation: the design doc's failure table says a missing or inaccessible folder is recorded once and the scheduler carries on. My plan omitted the guard. Fix: fold a thrown scan fault into a non-fatal outcome. Cost if wrong: a genuinely broken inbox is reported per pass instead of once.
Task 5: Ruling: I2 — both new tests pass readsPerDay: 0, so replacing the conductPendingDocuments call with a hardcoded zero object leaves them green. Fourth vacuous assertion in this plan. Fix: assert on result.conduct, and drive one document through schedulerPass with injected seams. Cost if wrong: none — a stronger test.
Task 5: fix round 1/5 dispatched (resumed implementer a00bd02)
Task 5: fix round 1/5 (2 Important + 2 Minor addressed, 0 open; commits 5598451..22e49fd)
Task 5: complete (commits 072dcdb..22e49fd, review clean). Suite 1137 green on a quiet database.

Task 6: review — routing, session guard, tenant scoping and XSS clean. Implementer's LEFT JOIN LATERAL deviation from my plan judged correct: my plain join on job_id would have duplicated reading rows once a job carries more than one approval. 1 Critical, 3 Important, 2 Minor.
Task 6: Ruling: C1 — `toSummary` dereferences `row.reading.summary`, but content is NULL for every `unreadable` reading (migration 013 enforces it, read.ts writes it), so the whole page 500s for any business that has ever had a failed read. Render them with the stored `reason` rather than filtering them out: a screen called "what I read" that omits what it could not read answers a different question than its title. Cost if wrong: an extra row shape on a read-only page.
Task 6: fix round 1/5 dispatched (resumed implementer a4ba30d)
Task 6: fix round 1/5 (1 Critical + 3 Important + 2 Minor addressed, 0 open; commits 613a187..8466a67)
Task 6: complete (commits 22e49fd..8466a67, review clean). Suite 1147 green on a quiet database.
Task 6: Ruling: the live run in Task 7 is the controller's to perform, not an implementer's — it spends the owner's API credits and touches their real folder. Task 7's dispatch covers invariants and documentation only. Cost if wrong: the live run happens one step later than the plan drew it.

Task 7: review — all four invariants pass and hold today; every documentation claim verified against source, including the four subtle ones, and correctly phrased conditionally. 1 Important, 2 Minor.
Task 7: Ruling: the provenance invariant is evadable by a plausible refactor the reviewer constructed and replayed — rename the parameter, parameterize only createJob's provenance, and the file's second `unknown_external` literal (on readDocument) keeps the positive assertion satisfied while job.provenance becomes caller-controlled. Anchor the assertion to the createJob call block specifically, and rewrite the negative check as a positive one (allowlist the literal) rather than a denylist of four identifier names. Cost if wrong: a stricter structural test that a legitimate refactor must update deliberately.
Task 7: Ruling: skip the minor that invariant 4 does not lock RAMP_HONESTY's *content* — emptying a well-named exported constant is a deliberate act, and the test would be checking itself.
Task 7: fix round 1/5 dispatched (resumed implementer aae1c84)
Task 7: fix round 1/5 (1 Important + 1 Minor addressed, 0 open; commits a4d7d81..beb9bea). Implementer replayed the reviewer's exact defeat and confirmed the tightened invariant catches it.
Task 7: complete (commits 8466a67..beb9bea, review clean). Suite 1152 green.

## LIVE RUN — performed by the controller, 2026-09-07

Setup: DOCUMENT_INBOX=C:/Users/user/Desktop/עוזרת-נכנס, DOCUMENT_READS_PER_DAY=2, real API key.
One `schedulerPass` over a real marketing contract (.docx).

Result: scan {ingested:1}, scanError null, conduct {considered:2, carded:0, readOnly:1, failed:1}.
File moved to processed/. All four subdirectories created. Readings, proposals and jobs all written; jobs walked to `closed` and `failed` correctly; the `unproposable` path recorded its reason and failed its job as designed.

**FINDING the live run surfaced, which no test could have.** Every `act` proposal the model produced — four of them across this and earlier sessions — names `agent.request_help` or `escalate_to_human`. Both have `expectedActionClass: null`, so `raiseProposalApproval` returns null and **no card is ever raised**; the job closes as readOnly. The behaviour is internally correct (raising a card that asks "shall I tell you?" is absurd) but the consequence is that in practice almost everything lands on /readings and the approvals queue — and therefore the sign button — stays empty. The proposer is told the assistant may only draft, so "flag it for the owner" is the sensible proposal, and that is a read-only tool. This is a product decision for the owner, not a defect to patch silently. NOT FIXED — surfaced.

## REAL FAILURE found by the live run — for the final fix wave

`scheduler-conducts.test.ts:176` "does not scan and does not fail when no inbox is configured" asserts `result.scan` is null but never makes the precondition true — it relies on `config.documentInbox` being ambiently unset in `.env`. The moment the live run configured DOCUMENT_INBOX (i.e. the moment anyone actually uses the feature), the scan ran and the test went red.

This is not a collision. It is a real defect: configuring the feature breaks the suite. The sibling test at :182 already does it correctly, mutating `config.documentInbox` for its duration and restoring it. Fix: the same treatment — set it to null explicitly, restore in a finally.

Controller did NOT fix it — carried to the final fix wave so it goes through review like everything else.

## Final review + fix wave
Final whole-branch review: no Critical. Security invariant traced end to end and holds — provenance unforgeable at four independent sites, reading cache cannot launder trust, nothing the model returns picks a target, the second path to approval_requests grants no authority. 4 Important, 9 Minor.
Final fix wave: all 4 Important + the live-run test defect + 6 Minor addressed (commits c459916..049967a). Scoped re-review: all addressed.
Ruling: I-4's document-decision allowlist stays at `file_document` alone, upholding the implementer against my own instinct to widen it. `flag_for_owner` looks tempting because the live run showed it is the dominant real proposal — but its action is an outbound notification, so the approve button's object is the message while the sign button's object is the document. That is the exact conflation I-4 was about. Consequence: the sign button will almost never appear. That is a product question for the owner, not a reason to weaken an irreversible control. Cost if wrong: signing stays dormant until the owner decides otherwise.
Ruling: endorsed the implementer going past the literal ruling by enforcing the allowlist in POST /a/:id/sign as well as in the view. A removed button is not a control against a stale tab, and the row it would write cannot be deleted. Cost if wrong: one extra refusal branch.
Parked: `cli/seed-job.ts` transitions to `execute` and binds the plan afterwards; now that an unbound execute job is moved to `failed`, a scheduler pass landing in that one-query window kills a seeding job. Manual dev tool, trivially fixed by binding before the transition — surfaced to the owner rather than fixed without review.
Parked: `notifyOwner` calls `getApproval` on the pool rather than threading `options.db`. Harmless today (the only caller supplying a notifier supplies no db).
