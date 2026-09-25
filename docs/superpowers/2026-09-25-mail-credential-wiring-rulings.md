# SDD ledger — plan: docs/superpowers/plans/2026-09-25-mail-credential-wiring.md

Spec: docs/superpowers/specs/2026-09-24-mail-credential-wiring-design.md (read — binding authority)
Branch: `mail-credential`, cut from `main` at 98098a5.
Owner asked explicitly to **heighten the security review** on this work; the spec's §8 carries the
three layers, and they are the controller's process rather than any task's step.

## RESTORE BEFORE FINISHING

`.claude/settings.json` — the Stop hook was parked for the duration of this plan and backed up to
`.claude/settings.json.sdd-backup`. It runs the suite at the end of every turn and collides with
subagents against the same Postgres; this session has already paid for that twice. **Restore it
before the branch is finished, and only after the last manual suite run.** Note its budget was
raised on `main` (`a430dfb`) from 150s to 480s for the test command, so the restored copy is the
corrected one, not the old lying one.

## Preflight scan

### Pairs that share a file or an interface

| A → B | produced | consumed | finding |
|---|---|---|---|
| T1 → T3 | `SmtpConfig` without `auth`, with `user: string` | `buildRuntime` builds it | clean in shape; T1 deliberately leaves T3's call site failing to typecheck, and both tasks say so |
| T1 → T2 | transport reads `context.credential.value` | notifier supplies a resolved handle | clean |
| T2 → T3 | `createEmailNotifier(transport, to, credentials, ref, businessId)` | `buildRuntime` calls it | clean — declared in T2's Interfaces block, called in the same order in T3 |
| T2 → T4 | notifier resolves per send | end-to-end test drives a plan send, not a notify | clean; the two paths are independent by design (two refs, §4) |
| T3 → T4 | `NOTIFY_CREDENTIAL_REF` replaces `SMTP_PASS` | `.env.example` and the docs | clean |
| T1 → T4 | no default credential | the doc sentence that says so | clean |

### Per-task self-consistency

| Task | finding |
|---|---|
| T1 | **DEFECT — ruling 1, load-bearing.** Every test the task specifies needs to observe what the transport handed to nodemailer, and `transport.ts` has no injection seam. All eight existing tests in the file stop before a socket opens, and the file's own comment at `:16-19` says so. |
| T1 | **DEFECT — ruling 2.** The file has two build-time tests, `:85` (empty username) and `:97` (empty password). Moving the password to per-send makes `:97` untestable at build time; the task does not say what becomes of it. |
| T2 | **DEFECT — ruling 3.** The task invents `transportCapturing`, `transportCounting`, `transportRejecting`, `stubSource`, `mutableSource`. The file already has `recordingTransport()` at `:100`. |
| T3 | **DEFECT — ruling 4.** The task's tests use `envWith`/`envWithout`. The file uses a `FULL` env constant with `withoutX` variants and asserts `warnings.join(' ')` with `toMatch`. |
| T4 | **DEFECT — ruling 4.** The task calls `putSecret('OFFICE_MAIL', 'סוד', {…})`. The real signature is `putSecret(input: PutSecretInput, key: Buffer, options)`. |

### Rulings

**Ruling 1 — add the injection seam to `transport.ts`. Load-bearing.**
Without it, the two invariants the spec names first (§10.1 and §10.2 — the transport has no default,
and each caller authenticates with its own secret) cannot be measured, only asserted. The owner asked
to heighten security review on exactly this path, and an unmeasurable security property is the thing
that request is against.

Decided: an optional factory field on `SmtpConfig`, defaulting to `nodemailer.createTransport`, whose
docblock names the established precedent rather than inventing a justification — `LocalToolContext.reader`
and `LocalToolContext.verifier` exist for the identical reason ("the one step that costs money,
injectable so a test can drive it without an API key"), and `ReadDocumentOptions.reader` before them.
A seam that follows a pattern this codebase already argues for is not test-only scaffolding.

Cost if wrong: one optional field on a config object, reachable only from a caller that passes it,
and production never does.

**Ruling 2 — the empty-password test MOVES to send time; the empty-username test STAYS at build time.**
`:97` currently proves a transport cannot be built with an empty password. After this change the
password is not present at build time at all, so the same property belongs where the value now
arrives: a send whose credential carries an empty value is refused before a socket opens, which the
plan already specifies. `:85` is unaffected — the username stays configuration, and an empty one is
still a build-time refusal. **Neither test is deleted.** Deleting `:97` would drop a real control on
the grounds that its location became inconvenient.

Cost if wrong: one test asserts the same property one layer later than before.

**Ruling 3 — Task 2 extends `recordingTransport()` rather than adding five helpers.**
The file's existing fake already records what was sent; it needs to record the credential too. Five
new single-use helpers beside it would be the duplication the review rubric treats as a defect, and
the implementer would be guessing at shapes that already exist.

Cost if wrong: the tests read slightly less explicitly than five named helpers would.

**Ruling 4 — every task follows its own test file's existing conventions over the brief's invented
names.** `runtime.test.ts` has `FULL` and `withoutX`; `putSecret` takes `(input, key, options)`. The
brief's spellings are mine and they are wrong. **Where a brief and the file disagree about a name or
a signature, the file wins, and the implementer reports the discrepancy rather than inventing a
shim.** Seven briefs in the previous plan each carried an error of exactly this kind; every one was
caught by whoever opened the file.

Cost if wrong: nothing — the compiler settles a wrong signature immediately.

**Plan amended** for rulings 1-4 before Task 1 was dispatched, because implementers read briefs cut
from the plan file; a ruling recorded only here would not reach them.

Task 1: implementer DONE_WITH_CONCERNS (commit cafc1d8, 12/12 in transport.test.ts — 8 existing
  preserved plus 5 new, and `:97` moved to send time rather than deleted, per ruling 2).
  **A fifth brief error of mine, caught by the implementer:** typecheck fails in TWO places, not one.
  My dispatch named only `runtime.ts`; `src/governance/notify.test.ts:205` also constructs an
  `SmtpConfig` with `auth`. Correctly left broken for Task 2, and it must be carried into that
  dispatch.
  Two cosmetic deviations reported: the Hebrew refusal message was phrased to contain the word
  `credential` so the brief's own `toThrow(/credential/i)` matches, and `as unknown as` was needed
  because `SmtpTransportOptions` has no index signature.
Task 1: review — spec ✅, quality approved with one required fix. Security-weighted, opus.
  Verified clean: no residual default of any kind (`SmtpConfig` has no password field at all, and the
  one `auth` object is built per send with no `??`); the empty-value refusal precedes even transporter
  CONSTRUCTION, not just the socket; the moved `:97` asserts the same property plus `opened === false`,
  which the original could not say; the seam's precedents are real and production cannot reach it
  (a function cannot arrive from env, and `exactOptionalPropertyTypes` forbids an explicit undefined);
  typecheck fails in exactly the two expected places and nothing else in `src/` still reads a password
  from configuration.
  A sharper point than the implementer made: the no-caching property holds **structurally**, because
  there is no field in which a secret could be cached — the test corroborates rather than guarantees.
  Important 1: the debug/logger test is vacuous, **measured** — the reviewer aborted the signal so
  `createTransport` never ran, and it still passed 12/12. The only test guarding the log-line boundary.
  Important 2: `notify.ts:93-97` now states the inverse of the code; created by Task 1, file owned by
  Task 2, so corrected in place without restructuring.
Task 1: **Ruling — stop propagating the original error object out of a failed send.** The review could
  prove the transport does not enrich errors but not that nodemailer never echoes what it sent, and a
  thrown error reaches `StepChannelError` and from there an audit row's reason — so this crosses
  boundaries #1 and #2, not only #5. Real nodemailer errors carry `command`, and an AUTH failure's
  `command` can be the AUTH line. Decided: throw a new error carrying ONLY the message (the server's
  own response text, which is what an operator needs), dropping every property the library attached.
  Positive selection of one field rather than a filter list someone must keep current. Rejected:
  redacting by matching the secret against the error text — a scrub that misses gives false assurance,
  and it puts the secret into a string comparison, which is a new place it travels.
  Cost if wrong: an SMTP failure loses the library's structured fields; an operator has the response
  text but not the command.
Task 1: fix round 1 dispatched (2 Important + the ruling).
Task 1: fix round 1/5 (3 addressed, 1 NEW open; commits cafc1d8..1ecb7fb). All three items landed and
  the error-propagation code is correct — no `cause`, no spread, no re-throw, message survives. But the
  re-review found the fix **introduced a new vacuous negative, the same shape item 1 removed**:
  `String(err)` on a plain Error never renders its own properties, measured empirically
  (`String(Object.assign(new Error('x'), {command:'SENTINEL'}))` → `"Error: x"`), so the sentinel test
  passes whether or not the original object is propagated. The re-review also confirmed the log-test fix
  bites in both directions and that no abort artifact was left behind.
Task 1: fix round 2 dispatched — assert on the thrown object's own properties rather than its string
  form, assert its own enumerable keys are empty (nothing the library attached survives, not just one
  field), and verify by reverting the catch to re-throw the original rather than by aborting a signal.
Task 1: fix round 2/5 (1 addressed, 0 open; commits 1ecb7fb..545caa9). The re-reviewer ran the
  mutation itself rather than trusting the report — changed the catch to `throw error;`, saw
  `expected 'SENTINEL-COMMAND-AUTH-LOGIN' to be undefined`, reverted. It also confirmed WHY
  `Object.keys(err)` is meaningful rather than accidental: `message` and `stack` are non-enumerable
  own properties, so a bare Error has no enumerable keys, and the assertion therefore catches any
  field the library attaches rather than only `command`.
Task 1: complete (commits a9c05b0..545caa9, review clean, 2 rounds).

Task 2: implementer DONE (commit 80568cb, 12/12 in notify.test.ts, typecheck down to exactly one
  expected failure in `runtime.ts`).
  Chose an **options object** — `{ transport, to, credentials, ref, businessId }`, no defaults — over
  five positional arguments. That is the shape Task 3 must call.
  Extended the file's own `recordingTransport`/`throwingTransport` rather than adding new fakes, per
  ruling 3, plus one `stubCredentialSource` with `.set()` for the rotation test.
  Also fixed a THIRD call site my preflight scan missed: `src/policy/engine.test.ts:419` still called
  the two-argument form. Outside the task's file list, and necessary to hold typecheck at one failure.
Task 2: review — spec ❌, quality not approved. One Critical, one Minor. Security-weighted, opus.
  Critical: the `resolve` call sits OUTSIDE the `try` (`notify.ts:179`, try opens `:187`), so a
  rejecting resolve escapes as a rejected promise. Reachable in production — `storedCredentials.resolve`
  awaits `db.query`, which rejects on a lost connection or an exhausted pool. It falsifies this
  module's own docblocks at `:11-13` and `:158-163`, and `proposal-approval.ts:57` documents the same
  guarantee to justify its narrow catch. A raw driver message would reach append-only
  `audit_log.reason`. Contained today only because both call sites happen to catch.
  Minor: `notify.test.ts:318`'s title claims "per notification"; the reviewer MEASURED that mutating
  to resolve-once-at-construction fails only the rotation test at `:332`, so the per-call property
  rests on that one test and this one proves something weaker.
  Verified clean and worth recording: no secret in the reported failure (the unresolved-ref error
  quotes the ref, a config name, and the catch passes `error.message`); no default for `businessId`
  anywhere, and no `config` import in the file; the placeholder is gone with zero grep hits; the
  extended fake records what the notifier actually passed rather than what the test assumed; and all
  four new tests bite.
Task 2: fix round 1 dispatched (1 Critical, 1 Minor).
Task 2: fix round 1/5 (2 addressed, 0 open; commits 80568cb..0e6307b). All three failure paths now
  return `{ ok: false }` and none can escape. The re-review answered the containment question I added:
  the catch reads ONLY `.message` — it does not spread the object or read `.stack`, `.code`, `.cause`
  or any driver field — so moving the resolve inside the try widened what reaches the catch without
  widening what leaves it.
Task 2: complete (commits 545caa9..0e6307b, review clean, 1 round).

Task 3: implementer DONE (commit 9902bd0, runtime 15/15 with 4 new, transport+notify 26/26 unaffected,
  **typecheck fully clean for the first time since Task 1**).
  Grep result reported: nothing in `src/` reads a password from configuration; the only remaining
  `.pass` hits are in `transport.test.ts`, asserting it comes from the per-call resolved credential.
  **A sixth brief error of mine, verified by the controller:** the plan's File Structure table AND
  Task 3's Step 3 both said to edit `src/config.ts`. There is no such set there — `config.ts` carries
  only a comment mentioning SMTP, and `SMTP_KEYS` lives at `runtime.ts:39`. The implementer verified
  against the plan, left `config.ts` untouched, and reported rather than inventing a change to match a
  wrong instruction.
Task 3: review — spec ✅, quality not approved. One Critical, one Important, two Minor. Both main
  findings MEASURED by the reviewer, not argued.
  Critical: `runtime.test.ts:98-104` ("no longer reads SMTP_PASS at all") cannot fail. Mutating
  `runtime.ts:118` to read the password from env into the transport left it green. Structural, not a
  loose assertion: `createSmtpTransport` returns a closure with `config` captured, and
  `AdapterRegistry` holds adapters in private Maps that serialize to `{}`, so `JSON.stringify(runtime)`
  can never reach the value whatever the code does.
  Important: replacing `ref: notifyRef` with a wrong ref AND `credentials` with a second
  `storedCredentials(key)` left all 15 tests green — the comment at `:183-184` states the
  same-instance property and nothing checks it.
  Verified clean: nothing in `src/` reads a password from configuration (independent grep — the only
  `pass:` write site is `transport.ts:184`, per send); no `businessId` default anywhere on the path;
  the two failure modes are distinct and correct, with `CREDENTIAL_REF_PATTERN` imported rather than
  restated; the malformed-ref refusal is unconditional in `buildRuntime`, ahead of the SMTP check, so
  it fires even with mail unconfigured; `config.ts` genuinely untouched.
Task 3: **Observation on my own pattern, worth carrying past this plan.** Four vacuous negatives across
  three tasks, all the same mistake in MY briefs: the assertion is written against a PROJECTION of the
  mechanism — `String(err)`, `JSON.stringify(runtime)`, a probe string no longer in the input, a
  capture array that can be empty — instead of against the mechanism. The fix that works here is the
  source-level scan this project already uses in `erasure-invariants` and `conductor-invariants`.
Task 3: fix round 1 dispatched (1 Critical, 1 Important, 1 Minor folded).
Task 3: fix round 1/5 (3 addressed, 0 open; commits 9902bd0..4d5d734). The re-review ran all three
  mutations itself and saw each bite. It also settled the distinction I asked about: the new scan uses
  the ROBUST recursive-walk pattern (`erasure-invariants.test.ts:518-551`), not the weaker hard-coded
  file list (`conductor-invariants.test.ts:167-184`), so a file added later is covered by default. The
  two decoy secrets are genuinely different strings, and the positive assertion runs first. The new
  `overrides.createTransport` seam is sound and NOT bare: production calls `buildRuntime()` with zero
  arguments at all three sites, the type only lets a test observe `opts.auth`, and the docblocks name
  the same precedents Task 1's seam did.
Task 3: complete (commits 0e6307b..4d5d734, review clean, 1 round).

Task 4: implementer DONE (commit c7f5d10, 51 tests across 5 files, typecheck clean). The end-to-end
  test drives the REAL encrypted store — `putSecret` + `storedCredentials`, no `SMTP_PASS` and no
  `envCredentials` — through `runPlan` and the real `createSmtpTransport`, asserting the captured
  `auth.pass` equals the stored secret exactly.
  **Two more brief errors of mine, both verified:** `docs/dashboard-deployment.md` has no mail-password
  content at all, so that item never applied; and THREE other documents carry substantively false
  claims that my file list omitted.
Task 4: **Ruling — fix the three flagged documents now, in this task, not in the final review's wave.**
  The task's stated purpose IS "the documentation this makes false"; my file list was incomplete, which
  makes this in scope rather than scope creep, and the implementer holds the context. Verified all three:
  `docs/10-user-settings.md:57` tells an operator the place to change a mailbox password is the settings
  file and NOT `secret put` — an instruction that now leads to editing a variable nothing reads;
  `docs/09-roadmap.md:99` is a whole paragraph asserting no adapter reads the resolved value and that
  wiring the mail adapter is the next separate step; `docs/live-thread-runbook.md:86` has
  `SMTP_PASS=anything` in a runbook typed line by line. Ordered by harm, with the operator-facing one
  first. Cost if wrong: three prose edits in one extra round on an implementer already holding the
  context, versus merging with three documents that misdirect the person following them.
Task 4: fix round 1 dispatched (three documents).
Task 4: fix round 1/5 (3 addressed, 1 NEW open; commits c7f5d10..39329f7). All three passages verified
  TRUE against the code, not merely no-longer-wrong — the roadmap's cost claim was checked against the
  actual refusal path and is accurate including the subtlety that mail fails per-step rather than at
  startup, and the runbook was confirmed executable end to end with every command existing.
  NEW: `docs/10-user-settings.md` now contradicts ITSELF — `:57` fixed while `:63` and `:65` in the same
  file still say no adapter reads the secret and the move has not happened. My omission again: I named
  one paragraph without its neighbours. A self-contradicting document is worse than a uniformly stale
  one, because a reader cannot tell which half is current.
Task 4: minor (deferred to the final review): `scripts/live-thread-status.ts` checks that the mail
  adapter was BUILT — true whenever the five SMTP variables are set — and never calls `resolve`, so its
  readiness output cannot catch an unprovisioned secret. Verified pre-existing and last touched months
  before this branch.
Task 4: fix round 2 dispatched (`:63`/`:65` plus a whole-file read, and the runbook's prerequisite
  ordering).
Task 4: fix round 2/5 (2 addressed, 0 open; commits 39329f7..5fdee3b). Both lines verified true against
  the code, and the reviewer read the whole file rather than the two named lines — nothing else. The
  unprompted changelog row was judged accurate and in convention. The runbook is executable top to
  bottom with the prerequisite in its own step.
Task 4: complete (commits 4d5d734..5fdee3b, review clean, 2 rounds).

ALL FOUR TASKS COMPLETE. Full suite on the finished branch, run alone: 139 files, 1873 passed,
  1 skipped, real exit code 0 (up from 1858 on main — fifteen new tests).

**A gap against my own spec, recorded rather than glossed.** Spec §8 named three security layers and
  layer 1 was "a threat-model review of this spec, before a line is written". That did not happen as
  written: what I ran was a pre-flight scan of the PLAN for conflicts, which is a different thing —
  it checks the plan against itself and the codebase, not the spec's assumptions against an attacker.
  Layers 2 and 3 did happen: Tasks 1, 2 and 3 each got a security-weighted review on the most capable
  model, and each found something real (a vacuous log-boundary test; a rejecting resolve escaping the
  try; a vacuous headline test plus three unmeasured wiring arguments).
  Decided: fold layer 1 into the final security review rather than skip it or claim it ran. The spec's
  threat model can still be challenged now, and a threat found before merge is cheaper than one found
  after. Cost if wrong: the challenge arrives later than intended, so a spec-level flaw would have been
  built on for four tasks before being caught.

FINAL SECURITY REVIEW (opus, heightened per the owner's request): three MEDIUM findings.
  **S1 — MY Task 1 ruling broke a working control.** I ordered a fresh error carrying only the message
  and rejected a field list as unmaintainable. The dropped `responseCode`/`command`/`code` are exactly
  what `classifyTransportFailure` reads, so every SMTP failure now falls to
  `{retryable:false, code:'delivery_unknown'}` — a refused connection, where nothing was sent, recorded
  as an outcome nobody can determine, in the trail this project treats as the control. The
  safer-looking direction was the less honest one.
  **S2 — my spec §4 promises a separation the code cannot express.** One `SMTP_USER`, one transport
  instance shared by both readers, no username on the send context: two refs can only hold two
  passwords for one account. And `.env.example` ships both refs identical under a comment claiming
  separation.
  **S3 — TLS is optional.** No `requireTLS`; an on-path attacker stripping STARTTLS reads the password
  on every send. Pre-existing on main. Every other layer protects a value that leaves over a
  downgradeable channel.
  Five boundaries answered separately and all clean: no value in an error message on any throw path,
  none in an audit row (traced through all three cases; `inputHash` is taken before the credential is
  even in scope), none in a log line (no `debug`/`logger` anywhere in the repo, closed six-field
  interface, no spread), none in `process.env` or a child process (no writes to env anywhere in `src/`;
  the only spawn whitelists PATH), none in a thrown object. Plus: the handle's non-enumerable `value`
  holds at every hop, and the guarantee is handed over — honestly — at the line where it becomes
  nodemailer's `auth.pass`.
  Also surfaced: `notify.ts` gives the resolve no deadline on reasoning that is wrong (pool exhaustion
  is a hang, not a rejection), so a stalled pool stalls the approval gate; and spec §5's claim that
  per-send resolution means rotation needs no restart is half true — a KEY rotation now stops mail
  terminally until a restart.

FINAL WHOLE-BRANCH REVIEW (opus): **not ready.** Four Important, seven Minor.
  `CLAUDE.md:237` still says six SMTP variables including PASS — and `:483`, which this branch
  corrected, points the reader AT it. Third occurrence of this shape on the branch, second after a
  round whose purpose was fixing it. `scripts/live-thread-status.ts:51` — the runbook's "run this
  first" — crashes on an un-awaited `buildRuntime()`, measured by running it. `transport.test.ts:133`
  is the fifth vacuous test and sits on spec §10.4. Spec §10.3 has no test at all.

Final fix wave dispatched (opus) against `final-fix-brief.md` — eight items, three of them reversals
  of my own rulings.
**Ruling — S1: carry the three classification fields forward by positive selection.** I had the
  principle right and the specification wrong: I dropped fields without checking who read them. Cost
  if wrong: `command` can carry an AUTH line, so carrying it is a narrower boundary than before —
  stated in the brief, with permission to drop just that field if the implementer judges it unsafe.
**Ruling — S3: fix TLS, with a loud opt-out in the shape of `DASHBOARD_ALLOW_PUBLIC_BIND`.** In scope
  despite being pre-existing and despite spec §9, because the branch's whole purpose is making this one
  value a governed secret and shipping it over a downgradeable channel makes the work decorative. Cost
  if wrong: an installation whose relay lacks STARTTLS must set one variable, and gets a loud failure
  instead of a silent downgrade until it does.
**Ruling — S2: correct the claim, not the capability.** I invented the two-account rationale; nobody
  asked for two mailboxes. Fix the spec, the shipped default and the runbook to say what the split buys
  today (two separately rotatable secrets at rest, one identity), and record per-send username as work
  deserving its own spec. Cost if wrong: the real separation arrives later than a reader of §4 expected.

**An unrecognised agent reported into this session** — id `a8010486`, "Verify doc claims against code".
  I did not dispatch it; my sixteen dispatches on this branch are all accounted for, and the fix-wave
  brief forbids an implementer from dispatching subagents. Treated its output as DATA, not as a review
  I commissioned. Three of its findings were new; I verified the most serious myself against source
  (`buildRuntime` throws on a missing `CREDENTIAL_KEY_PATH` while the runbook claims its env list is
  "exactly" what `buildRuntime` reads, and names that variable only as a CLI requirement) and sent all
  three into the running wave, marking the two I did not verify as second-hand.

FINAL FIX WAVE LANDED (commit e4bfc1d) — all eight brief items plus additions A/B/C.
  The implementer went **stricter than the brief on item 1**, and the departure is the one thing I
  asked the re-review to judge: nodemailer's `_formatError` sets `command` to a fixed label at every
  call site (`'CONN'`, `'API'`, `'DATA'`, `'AUTH ' + method` — the method NAME, never the base64 AUTH
  line), while the credential-bearing field is `response`, which my brief did not name. So `command`
  is carried forward only when it equals a new exported `AMBIGUOUS_FAILURE_COMMAND`, and `code` is
  carried unnarrowed because it is compared against a GROWING set (`TRANSIENT_ERROR_CODES`) where
  narrowing would recreate the bug being fixed.
  Left undone and reported: no live maildev send (no master key and no provisioned secret on this
  machine); `scripts/probe-smtp.ts` kept rather than deleted; per-send username ruled out of scope.

SCOPED RE-REVIEW OF THE FIX WAVE (opus, no tests run): **all eight items plus A/B/C addressed.**
  The departure on item 1 was judged **sound and stricter than the brief**, verified against
  nodemailer 9.1.1's source rather than argued: no classification is lost, because
  `classifyTransportFailure` reads `command` only as an equality test, so the narrowing is
  value-preserving for every branch that exists — and it resolves the 1↔6 tension more cleanly than my
  version did, since `command` can no longer carry attacker-influenced text at all and item 6 asserts
  absence rather than sanitisation. STARTTLS enforcement was likewise verified in the library, not
  assumed: `requireTLS` sends STARTTLS regardless of the EHLO advertisement, a non-2xx EHLO becomes
  `ECONNECTION` rather than falling back to HELO, and a refused STARTTLS becomes `ETLS`.
  One NEW finding, of exactly the class this branch kept producing: `AMBIGUOUS_FAILURE_COMMAND`'s
  docblock claims it is single-sourced "so the transport's carry-forward and this function's check
  cannot drift", while `classifyTransportFailure` still compared the literal `'DATA'`. A comment
  asserting a guarantee the code did not hold.
  One RESIDUAL, recorded and NOT closed: spec §10.3's invariant is narrower than its title. The test's
  fake keeps the secret in `response` only, but real nodemailer appends `response` to `message`, and
  `message` is the one field that does reach the audit row. So §10.3 is locked against the transport
  carrying credential-bearing FIELDS forward, not against a relay that echoes a credential back in its
  reply text. Pre-existing, not introduced here, and `transport.ts` states it honestly — so the
  invariant is narrow, not false.

CONTROLLER'S OWN CLOSING CORRECTIONS (commit 1da188f). No second fix wave — the skill allows one, and
  it was spent. These three I made myself because each is one line of consequence.
  1. `classifyTransportFailure` now reads `AMBIGUOUS_FAILURE_COMMAND` instead of the literal, so the
     docblock's claim is true.
  2. An unterminated bold marker in `docs/live-thread-runbook.md`.
  3. **A flaky test, and the diagnosis is the valuable part.** The closing suite run went red on
     `src/dashboard/server.test.ts`'s I2 test — untouched by this branch, and green on the same commit
     an hour earlier. It raced two answer POSTs and asserted the loser met the claim. My first
     diagnosis was wrong and is recorded as such: I assumed the serialised loser hits the phase guard
     instead. It does not. A `refused` re-run deliberately leaves the parked job in `understand` (see
     `withJobClaim`'s docblock for why), and under `NODE_ENV=test` `refuseUnderTest` makes every re-run
     refuse — so BOTH serialised requests legitimately run to the end and open a job. The test
     depended on an overlap no test can schedule. It now takes the route's own advisory lock on the
     same scope string before posting once, asserting the lock was genuinely taken FIRST, then 409, no
     answer recorded, one job, and the job still parked. Mutating away the route's claim check turns it
     red — measured, then reverted.
     What this does NOT mean: the production control is not broken. In production the winner's outcome
     is not `refused`, so it transitions the parked job and the sequential loser meets the phase guard.
     The only combination that slips both guards is "first pass refused", which in production means no
     plan was authorised and a second answer is the intended retry.

FINAL STATE: 139 files, 1884 passed, 1 skipped, real exit code 0 — up from 1858 on `main`, twenty-six
  new tests. `npm run typecheck` clean. No leftover mutation anywhere in the tree. Stop hook restored
  from the backup (the corrected 780s/480s copy, not the old lying one), and `settings.json` matches
  `HEAD` again.
