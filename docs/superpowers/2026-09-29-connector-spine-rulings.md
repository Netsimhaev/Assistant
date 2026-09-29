# SDD ledger — plan: docs/superpowers/plans/2026-09-29-connector-spine.md

Spec: docs/superpowers/specs/2026-09-28-connector-spine-design.md (read — binding authority;
amended once at 18ee945 before execution: §3.1א, the token service is the existing
CredentialSource composed over the existing store, not a new signature requiring a
businessId on AdapterCall).

Branch: `connector-spine`, cut from `main` at 95a09db. Working in the main checkout on a
non-main branch — the pattern every prior sub-project in this repo used. No worktree.

## RESTORE BEFORE FINISHING

`.claude/settings.json` — the Stop hook was parked and backed up to
`.claude/settings.json.sdd-backup`. It runs typecheck + the full suite at the end of every
turn and collides with subagents against the same Postgres; this project has already paid
for that three times in one session. **Restore it before the branch is finished, and only
after the last manual suite run.**

## Open loose ends that are NOT this plan

- Branch `charter-schema-version` (commit 7145cc8) is green, its security review is clean,
  and it awaits the owner's merge decision. Independent of this plan.
- Live-run leftovers on `dev-business`: a temporary dashboard account `liverun`, and the
  autonomy mode moved from `off` to `ask`. Recorded 27/09.

## Note for implementers, carried into every dispatch

Three migrations land in this plan (032, 033, 034). `npm run migrate:test` must be run
before the tests of any task that adds one, or the table will not exist in `assistant_test`.

## Preflight scan

### Pairs that share a file or an interface

| A → B | produced | consumed | finding |
|---|---|---|---|
| T1 → T2 | `grantAad`, `writeGrant`, `readGrantBySystem` | rotate's second loop + its test | clean — signatures in T1's Produces match T2's usage exactly |
| T1 → T3 | `readGrantByRef`, `recordRefresh`, `markNeedsReauth`, `revokeGrant`, `listGrants`, `readGrantBySystem` | the token service | clean |
| T1 → T5 | `writeGrant` | the callback route | clean, but see R4 — the WRITE must live in `oauth-routes.ts` |
| T1 → T6 | `listGrants` (no key, so it cannot return a token) | the screen | clean |
| T1 & T5 | both edit `src/test/db.ts` TRUNCATE list | — | **R3**: sequential, but T5 must ADD `oauth_states` beside T1's `oauth_grants`, not replace |
| T3 → T4 | `oauthCredentials(...)` | `buildRuntime` must pass it as the `credentials` source | **R2 — GAP: no task wired it.** Folded into T4 |
| T4 & T7 | both edit `src/orchestrator/bindings.ts` | — | **R3**: T4 adds the `provider` column, T7 adds `recordBindingOutcome`. Additive, sequential |
| T5 & T6 | both edit `src/dashboard/server.ts` | — | **R3**: T5 adds three `/oauth/*` routes, T6 adds `GET /connections`. Additive |
| T2,T3,T5 → T8 | the two source scans | `FROM oauth_grants` in secret-key.ts; exactly two importers of the writer | clean given R4 |

### Per-task self-consistency

| Task | finding |
|---|---|
| T1 | clean. `writeKeyState(key, keyId, options)` and `revokeGrant(system, businessId, by)` match the real signatures |
| T2 | `runRotate` is described rather than written — points at the existing pattern in `src/cli/secret-key.test.ts`. Acceptable: the file is named and real |
| T3 | **R5**: `recordingHttp`, `stubSource`, `clock`, `NEVER_CALLED`, `REJECTING_HTTP` are named, not defined. Local test helpers; the implementer writes them |
| T4 | **R1 — DEFECT, load-bearing.** Step 7 drives the proof call through `runPlanForJob`. It cannot work: `calendar.read` is in `READ_ONLY_TOOLS` and NOT in `OUTBOUND_TOOLS`, so `needsChannel` is false and `performStep` (`run-plan.ts:496`) routes it to `runLocalTool` — no adapter, no credential resolution |
| T4 | **R5**: `call()`, `handle()`, `CALENDAR_CONNECTION`, `jobWithOneStep()` named, not defined |
| T5 | clean |
| T6 | clean |
| T7 | clean |
| T8 | clean given R4 |

### Rulings

**R1 — the proof call does not go through `runPlan`, and that is scoped out rather than forced.**
Measured, not assumed: `calendar.read` sits in `READ_ONLY_TOOLS` and not in `OUTBOUND_TOOLS`, so
`needsChannel` is false and the step is a LOCAL step. Three ways out were weighed:
(a) add `calendar.read` to `OUTBOUND_TOOLS` — that list decides four things (kill-switch scope,
data-sensitivity, quiet hours, and whether the payload is redacted at all), and it would make one
external read behave unlike `crm.read`, which the code comment at `run-plan.ts:292` names
explicitly as a tool that must NOT require a channel;
(b) widen `needsChannel` — a change to a shared policy predicate that plan validation also calls;
(c) prove the spine one layer below the orchestrator.
Decided: (c). The spine's claim is "a declared connection becomes a real one" — charter → binding →
grant → token → provider call. Routing read-only external tools through the plan runner is a
policy-layer question that belongs to sub-project 2, where the capability that needs it lives, and
dragging it into a sub-project about credentials would put a `needsChannel` change inside a task
about secrets. Task 4's end-to-end test composes the chain directly, and a script
`scripts/connector-calendar.ts` is what the live run drives.
**Cost if wrong:** the spine ships proven one layer below `runPlan`, so sub-project 2 must prove the
orchestrator path itself — a step that would otherwise have been paid for here. Nothing is built on
a false assumption; the gap is named.

**R2 — `oauthCredentials` is wired into `buildRuntime` in Task 4.** No task did it, and without it
the composed source exists with no production caller — the defect class this repo has paid for six
times. **Cost if wrong:** one wiring line lands in the task that also touches `runtime.ts`, which is
where it belongs anyway.

**R3 — three files are edited by two tasks each** (`src/test/db.ts`, `src/dashboard/server.ts`,
`src/orchestrator/bindings.ts`). Sequential execution makes this safe; every dispatch for the SECOND
task on each file carries "add beside what is there, do not replace". **Cost if wrong:** one
implementer overwrites the other's line, and the suite goes red immediately.

**R4 — the grant write lives in `oauth-routes.ts`, not `oauth-consent.ts`.** Task 8's source scan
pins the importer list at exactly two files, and `oauth-consent.ts` builds URLs and exchanges codes
— it must not touch the store. **Cost if wrong:** the invariant in Task 8 fails and names the file
that broke it.

**R5 — test helpers named in Tasks 3 and 4 are written by their implementers, locally in the test
file.** They must not become production code. Each dispatch names an existing file with the same
shape to copy from. **Cost if wrong:** a helper lands in `src/` and the reviewer flags it.

**Plan amended** for R1 and R2 before Task 1 was dispatched, because implementers read briefs cut
from the plan file and a ruling recorded only here would not reach them.

Task 1: implementer DONE (commit db36c1b, 5/5 in oauth-grants.test.ts; credential-store 18/18 and
  master-key 13+1skip re-run as regression; typecheck clean). Mutation on `grantAad` (uppercase ref)
  reddened exactly the "cannot be opened as if it were a secret" test and nothing else; reverted.
Task 1: implementer concern, and it is a real observation about EXISTING code my new code inherits:
  `liveKeyId(db)` (credential-store.ts:149) reads `config.businessId`, not the businessId being
  written. So a grant written for another business is stamped with the CONFIGURED business's key id.
  Benign in a one-installation-per-business deployment (and `putSecret` has had the same property
  since it was written; decryption depends on the master key and the AAD, not on `key_id`), but it
  is the shape the global constraint forbids, and the brief's test could not run until the
  implementer seeded a key for the default business as well — the same line
  `credential-store.test.ts` already carries. Carried to the reviewer rather than adjudicated here.
Task 1: review — spec ✅, quality NOT approved. 3 Important, 5 Minor. Opus, security-weighted.
  Verified clean and worth recording: `config` is not imported into `oauth-grants.ts` at all, so the
  forbidden default is unreachable rather than merely absent; the AAD separation holds
  UNCONDITIONALLY because `ConnectionBinding.system` is an unconstrained string and `grant:<anything>`
  can never match `^[A-Z0-9_]+$`; the "cannot be opened as a secret" test hardcodes the literal AAD
  rather than calling `grantAad`, which is exactly why the mutation reddens it instead of moving both
  halves together; and `openGrant` building the AAD from the DESTINATION row's `system` means a
  ciphertext lifted between rows fails to open.
Task 1: **Ruling — Important 2, make the ref index partial on `revoked_at IS NULL`.** The index I
  specified is unconditional while the revoke is soft, so a revoked grant consumes its ref forever and
  a renamed system dies on a raw Postgres unique violation instead of a readable refusal. The repo's
  own precedent is partial (migration 024 puts `WHERE retired_at IS NULL` on both memory indexes for
  exactly this reason). The brief was wrong; the finding is right.
  Cost if wrong: the index permits two rows per ref where one is revoked — which is the state the soft
  revoke is FOR, so the risk is a duplicate that reads cannot reach anyway.
Task 1: **Ruling — Important 3, verify the key install-wide, matching `putSecret`.** My brief specified
  `verifyKeyState(key, { businessId: input.businessId, db })` followed by `liveKeyId(db)`, which reads
  `config.businessId` — two different rows of `credential_key_state`. `putSecret` asks both questions
  install-wide and is therefore consistent; my brief invented the mixture, and it is precisely the
  hazard both docblocks describe (a row labelled with one key and sealed with another).
  Cost if wrong: the per-business key check is lost — but one installation serves one business, so the
  two rows cannot differ in production, and consistency with the function this one was modelled on is
  worth more than a check that can only differ in a test.
Task 1: minor (deferred to Task 8): the leak assertion enumerates five columns by hand and cannot see
  a column added later. Task 8 already specifies the schema-derived scan over every table; that is
  where this is answered, not here.
Task 1: fix round 1 dispatched — Important 1, 2, 3 and Minors 4, 5, 7, 8. Minor 6 deferred as above.
Task 1: fix round 1/5 landed (commit 83a2741, 13/13 in oauth-grants.test.ts, typecheck clean;
  credential-store 18/18 and erasure-invariants re-run as regression, 24/24). All seven items
  reported addressed. Migration 035 adds the partial index as a NEW FILE rather than editing 032 —
  correct: the runner tracks by filename, so an in-place edit would leave every database that already
  ran 032 on the old index while the file claimed otherwise. Implementer flagged one note where its
  reading of which `writeKeyState` line became redundant may differ from my phrasing.
Task 1: fix round 1/5 re-review — all 7 ADDRESSED, no Critical/Important breakage. The re-reviewer
  confirmed the tests can fail: the throw tests target a genuinely absent and a genuinely revoked row,
  and the two re-seal tests prove the token is unchanged vs. replaced rather than merely "no error".
  Also confirmed 032's index definition was left untouched and 035 drops-and-recreates.
Task 1: minor (deferred to final review): the re-seal branch's OWN `revoked_at IS NULL` filter is not
  exercised — the revoke test calls `recordRefresh` with `rotatedRefreshToken: null`, so a mutation
  dropping that one filter would stay green.
Task 1: minor (deferred to final review): the new Hebrew refusal messages carry `system` but not
  `businessId`. They satisfy "never the token"; they fall short of the fuller bar I set, and the same
  system name can recur across businesses.
Task 1: complete (commits 8f2af05..83a2741, review clean after 1 round).
Task 2: implementer DONE (commit 79fd43b, 3 new in secret-key-grants.test.ts + 20 existing in secret-key.test.ts = 23/23; typecheck clean). Noted that connector-invariants.test.ts, named in the brief's own comment, does not exist yet — correct, it is Task 8.
Task 2: review — spec ✅, quality APPROVED, zero findings. Opened `secret-key.ts` in full and confirmed
  what the diff alone could not: the new loop sits inside the SAME transaction and the SAME advisory
  lock, before `writeKeyState` overwrites the key-state row, with the pre-transaction sealing of the
  recovery copy untouched; no `revoked_at` filter, so revoked rows are re-encrypted (skipping them
  would make retained evidence permanently unopenable); the abort message names `(business_id, system)`
  and nothing else. The third test is the one that earns its place: it seeds a grant sealed under a key
  the installation never held, and proves that a good CREDENTIAL survives the abort — which can only be
  explained by the new loop's rollback crossing tables.
Task 2: ⚠️ "cannot verify from diff — does the full suite still pass" RESOLVED by me: grep finds no
  other consumer of `RotationOutcome`/`secretsReEncrypted`/`grantsReEncrypted` anywhere in `src` or
  `scripts`, and the whole `src/cli` directory runs 67/67 green. No gap.
Task 2: note carried to Task 8: a comment at `secret-key.ts:598` cites `connector-invariants.test.ts`
  as what keeps rotation coverage closed. That file does not exist yet — Task 8 creates it, and the
  comment is a promissory note Task 8 must actually fulfil.
Task 2: complete (commits 83a2741..79fd43b, review clean, 0 rounds).
Task 3: implementer DONE (commit 9cca4b5, 8/8 in oauth-token.test.ts — the brief's 6 plus a transient
  failure test and the audit test; typecheck clean; oauth-grants + adapters re-run, 105 green). Both
  Step 6 mutations run and reverted, each reddening exactly its named test.
Task 3: **an inconsistency in MY brief, caught by the implementer.** My Step 3 pseudocode calls
  `fallback.resolve()` unconditionally whenever a grant is found, in order to detect an ambiguous ref —
  while four of the six tests I wrote pass a `NEVER_CALLED` fallback (one whose `resolve` throws) in
  exactly that situation. The two cannot both hold. Its resolution: check ambiguity only on a cache
  miss, and treat a throwing fallback the same as a null-returning one. Carried to the reviewer as a
  judgement point rather than adjudicated by me, because the resolution has two consequences worth a
  second pair of eyes: a ref that becomes ambiguous after a cache hit is not detected, and a fallback
  that throws for a REAL reason (a lost connection inside `storedCredentials`) is read as "no secret
  under that ref" rather than surfacing.
Task 3: implementer note: `defaultTokenHttp()`'s environment-variable names are its own invention,
  nothing upstream specified them. Tasks 4 and 5 treat them as a starting point.
Task 3: review — spec ❌, quality NOT approved. 1 Critical, 3 Important, 4 Minor. Opus.
  Verified clean and worth recording: `config` is not imported; no token value in any error message, in
  the audit `reason`, or in `inputHash`; the cache lives in the closure; `revoked_at` is read before the
  cache is consulted; the throws from `recordRefresh`/`markNeedsReauth` are not swallowed; no retry-on-401
  leaked in. And the cache test's ordering is right — it proves one exchange rather than two BEFORE it
  proves revocation bites through the cache.
Task 3: **Ruling — C1 is accepted in full, and the cause was my test doubles, not the implementer.**
  `safeFallbackResolve`'s bare catch reads a rejecting `db.query` as "no secret under that ref", and on
  the fall-through path `run-plan.ts:569` turns that into a NON-retryable `credential_unavailable` — a
  five-second database blip recorded as a permanent provisioning fault. `notify.ts:170-180` carries a
  docblock in this repo that retracts exactly the opposite claim, so the failure mode is documented
  fact, not speculation. The wrapper exists only because four of the six tests I wrote pass a
  `NEVER_CALLED` fallback that THROWS in the one situation the ambiguity check must consult it. Decided:
  delete the wrapper, and replace the throwing double with a counting `stubSource({})` that returns
  `null` honestly and records its calls — strictly stronger, because it distinguishes "consulted and
  declined" from "never consulted", which a swallowed throw cannot.
  Cost if wrong: nothing. Eleven lines of production code removed and a test double made more precise.
Task 3: **Ruling — I1: two clauses of my own spec conflict, and §4.4 wins. §3.5 is corrected.**
  §3.5 requires the refresh to sit INSIDE the step's time budget. Measured: `performStep` resolves the
  credential at `run-plan.ts:568` and opens `callWithDeadline` at `:577` — the resolution is outside the
  step's deadline, and putting it inside means editing `run-plan.ts`, which §4.4 promises not to touch
  and which protects the proven mail path. Decided: keep `run-plan.ts` untouched and correct §3.5 — the
  budget is enforced by a real RACE (not an `AbortSignal` alone, which is advisory) with its own named
  constant, and the spec says why it sits beside the step's budget rather than inside it.
  Cost if wrong: a refresh has its own ceiling rather than sharing the step's, so a pathological provider
  could consume both in sequence. Bounded by two named constants instead of one.
Task 3: **Ruling — I2: `defaultTokenHttp` leaves Task 3 entirely.** It has no caller here, and it reads
  an OAuth client secret from `process.env` — in the branch whose entire purpose is getting secrets out
  of the environment, with `master-key.ts` spelling out why and `SMTP_PASS` deleted on that argument two
  weeks ago. It also classifies missing configuration as `transient`, which retries a config error every
  five minutes forever where §3.4 makes an unprovisioned credential terminal. Decided: remove it. The
  real `TokenHttp` is built where the client secret can be resolved from the EXISTING secret store —
  Task 4's wiring — exactly as spec §5.4 already requires. Plan Task 4 amended.
  Cost if wrong: Task 4 carries one more small piece of construction. Nothing is lost.
Task 3: **Ruling — I3: a revoked grant must refuse, not fall through, and Task 1's module gains one
  function to make that expressible.** §3.4 says a revoked grant is terminal; `readGrantByRef` filters
  `revoked_at IS NULL` in SQL, so "no row" and "revoked row" arrive indistinguishable and both take the
  fallback. The consequence is the one §3.1א refuses by name: a ref configured as both refuses loudly
  while the grant is live, and silently starts using the static secret the moment the owner revokes.
  Decided: add `grantStatusByRef(credentialRef, businessId, options) => 'none' | 'live' | 'revoked'` to
  `oauth-grants.ts` — no key parameter, so it cannot return a token — and refuse on `'revoked'`.
  Cost if wrong: one more small read on the resolve path, in a module that already reads there.
Task 3: minor (deferred to final review): no test covers the skew window (`SKEW_MS` can be set to 0 and
  all tests still pass), and one test's name promises a second call it never makes, which makes its
  injected clock decorative.
Task 3: fix round 1 dispatched — C1, I1, I2, I3, M1, M2, and M3's two-business cache test.
Task 3: fix round 1/5 landed (commit 7284827, oauth-token 9 + oauth-grants 13 = 22/22, typecheck clean). All four findings plus M1-M3 reported addressed. Two deviations flagged by the implementer: it raced THREE calls rather than the two I named (adding `grantStatusByRef`), and the revoked-grant error names the ref rather than the system.
Task 3: fix round 1/5 re-review — all 7 ADDRESSED, no new breakage. Judged the two flagged deviations and
  both stand: racing `grantStatusByRef` as well as the two I named is correct (it is a DB call added in
  the same round that can hang identically — leaving it unraced would have been the inconsistency), and
  naming the ref rather than the system in the revoked error is right because `grantStatusByRef` has no
  system name available by design and fetching one would cost a second query for a credential the ref
  already identifies uniquely.
Task 3: complete (commits 79fd43b..7284827, review clean after 1 round).
Task 4: implementer DONE_WITH_CONCERNS (commit 648ce1c; typecheck clean; google-calendar 8,
  google-token-http 10 new, runtime 18, plus 157 in 12 mechanically-touched files = 285 green; Step 6
  mutation confirmed red then reverted).
Task 4: **Ruling — accept the two invented credential refs, and carry them into Task 5.** The implementer
  built `google-token-http.ts` (correct: Steps 8 and 9 import it, and Task 3's `defaultTokenHttp` was
  removed precisely so this would be built where the client secret can come from the STORE) and named the
  refs `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` itself, since spec §5.4 says only "the app
  secret", singular. Decided: keep both names, and Task 5's consent flow must resolve the SAME two refs —
  a flow that invents a third name would leave an operator provisioning refs nothing reads. Provisioning
  the client id through the store rather than env is also right on its own terms: spec §1.4 constraint 2
  requires connection configuration to be provisionable like a secret, not hand-edited per machine.
  Cost if wrong: two ref names differ from whatever a future provider doc calls them — a rename, caught
  by the readiness report the moment a ref does not resolve.
Task 4: implementer note (expected, not a finding): no live run against a real Google account was
  possible here. That is the closing section of the plan, not a task.
Task 4: review — spec ✅, quality NOT approved. 0 Critical, 6 Important, 9 Minor. Opus.
  Verified by opening files, not by trusting the diff: `git diff --stat` over `adapters/mail.ts`,
  `adapters/types.ts`, `policy/engine.ts`, `run-plan.ts`, `execute.ts`, `mail/transport.ts`, `notify.ts`,
  `credentials.ts`, `credential-store.ts`, `domain/charter.ts`, `policy/classify.ts` and
  `charter/capabilities.ts` is EMPTY — the gate, the adapter contract and the mail path are untouched.
  `buildRuntime()` is zero-argument at all three production sites. The client secret is resolved through
  the store with a mandatory businessId and never from env. All four edits for `calendar.read` were
  already in place. And the 12 mechanical `provider: null` insertions were diffed line by line: not one
  assertion, fixture value or test name changed meaning.
Task 4: **Ruling — I1 is accepted and is the sharpest finding on the branch.** The registration loop keys
  on `provider === 'google'` and `channel: 'api'` and never consults `connection.serves`. Both seed
  scripts declare `office-mail` as `channel: 'api'`, and `AdapterRegistry`'s constructor throws on a
  duplicate system id — so `provider='google'` on `office-mail`, which is the natural thing for an owner
  authorising Gmail through Task 5's screen, makes `buildRuntime` THROW and the scheduler refuse to boot.
  A row a dashboard writes must not be able to stop the process from starting. One line fixes it:
  require `connection.serves.includes('calendar.read')`. Cost if wrong: a Google system that serves
  calendar reads under an unexpected tool name gets no adapter — a readable MISS, not a dead process.
Task 4: **Ruling — I2: add a third `RefreshOutcome` kind rather than throwing from the provider.**
  Missing local OAuth configuration is currently reported as `rejected`, which Task 3 wired to mean "the
  provider looked at your refresh token and refused it" — so an install that has simply not run
  `secret put` gets an audit row asserting something false about Google and a grant stamped for
  re-consent it cannot fix. Decided: `kind: 'misconfigured'`, terminal, neither audited as a provider
  rejection nor stamped. Rejected the alternative (throw from `googleTokenHttp`) because a throw bypasses
  the deadline race and the classification table, and one exit shape is worth more than one fewer enum
  member. Cost if wrong: a one-member widening of a two-task-old interface.
Task 4: **Ruling — I4: document the restart requirement now; re-derivation is its own design.** The
  registry is built once per process, so a `provider` written by Task 5's dashboard needs a scheduler
  restart — reintroducing, one column over, exactly the hazard the "register even without a grant" rule
  removed. Re-deriving per pass means re-reading the charter and the master key every 30 seconds, which is
  an architecture decision and not a fix-wave line. Decided: correct `buildRuntime`'s docblock (it
  currently implies the opposite), say it in the runbook, and Task 5's screen must tell the owner in
  words. Cost if wrong: an owner who authorises must restart the scheduler — friction the screen names,
  rather than silence.
Task 4: **Ruling — I5: `run-plan.ts` MAY gain a catch, and spec §4.4 is narrowed to say so.** The token
  service throws four error classes; `executeStep` catches only `StepChannelError`, so an OAuth throw
  escapes into the `errored` bucket and leaves the job in `execute` with a frozen `updated_at` — the
  starvation `run-scheduler.ts` documents at length. §3.4's classification table cannot be honoured
  without mapping those throws onto `StepChannelError` with the right `retryable`, and `performStep` is
  the only place that can. §4.4 promised "no change to `performStep`"; narrowed to "no change to the mail
  path's behaviour" — a catch whose branches are unreachable for a static secret changes nothing for mail.
  Cost if wrong: `run-plan.ts` carries four dead branches until a grant exists.
Task 4: **Ruling — I6: thread `businessId` through `exchangeRefresh`.** The client secret is resolved for
  `config.businessId` while the grant is resolved for the caller's business, and `oauth-token.ts`'s own
  docblock claims as a guarantee that the forbidden pattern is "unreachable here, not merely unused". The
  composition reintroduced it at the one seam the interface could not express. Cost if wrong: one more
  field on a two-task-old interface. Leaving it would make a docblock lie, which this project punishes.
Task 4: minor (deferred to final review): migration 033 added after 035 exists with no 034 (the runner is
  a set difference, so both orders reach the same schema, and renumbering now would be worse); the audit
  `reason` for a binding change still names only `status`, following the precedent `endpoint` already set;
  thin zod validation on `fromIso`/`maxResults`; and `credential_unavailable` spelled differently by the
  two adapters for the same condition — noted so nobody "harmonises" one side and changes a documented
  meaning.
Task 4: fix round 1 dispatched — I1, I2, I3, I4, I5, I6 and Minors 2, 3, 4, 5, 7.
Task 4: fix round 1/5 landed (commit 2428e52; typecheck clean plus a temporary-tsconfig pass over scripts/**; 313 tests across 19 touched files green). All six Important and five Minors reported addressed; I1 now has a dedicated regression test, and I3's new assertion was verified to go red when the code it guards is broken.
Task 4: fix round 1/5 re-review — 10 of 11 ADDRESSED, 1 NOT ADDRESSED, no new breakage.
  The re-reviewer confirmed structurally (not from the report's claim) that I1's regression test is
  load-bearing: without the guard the configuration pushes two adapters under system id `office-mail` and
  the registry constructor throws on the duplicate. And it verified I5's mail-path safety the right way —
  `storedCredentials.resolve` only ever throws `CredentialStoreError` or returns a handle/`null`, never any
  of the five OAuth classes, so every new branch in `run-plan.ts` is structurally unreachable for a static
  secret.
  NOT ADDRESSED — I2's test. The `'misconfigured'` branch itself is correct and does not audit or stamp,
  but `oauth-token.test.ts` is untouched in the fix diff and contains zero hits for "misconfigured": the
  consumer-side absences I asked to be proven are unproven, while the sibling tests for `'rejected'` and
  `'transient'` show exactly the pattern that is missing.
Task 4: fix round 2 dispatched — I2's missing test, plus Minor 7's docblock.
Task 4: fix round 2/5 landed (commit 9d97aef, oauth-token 10/10, typecheck clean). The implementer verified the new test is load-bearing by temporarily merging the misconfigured branch back into rejected-style behaviour, seeing it fail on the audit-row count, then reverting — git diff on oauth-token.ts shows zero net change.
Task 4: fix round 2/5 re-review — both ADDRESSED, no new breakage. Confirmed the revert was complete:
  `oauth-token.ts` is not in the round-2 diff at all.
Task 4: complete (commits 7284827..9d97aef, review clean after 2 rounds).
Task 5: **Ruling, before dispatch — the callback must also write the binding's `provider`, not only the
  grant.** The plan's Task 5 says the callback "writes a grant" and stops there. But Task 4's I1 fix means
  the provider adapter is registered only when the charter's connection serves the tool AND the binding's
  `provider` column names the vendor — so a consent ceremony that writes only the grant leaves the owner
  having authorised Google with no adapter registered and nothing to show for it. The callback therefore
  calls `upsertBinding` with `provider` in the same flow. And per Task 4's I4 ruling the screen must say in
  words that the scheduler re-reads bindings only at startup.
  Cost if wrong: the consent flow writes one more column on a row it already owns operationally — and
  without it, the single most visible action in the whole sub-project silently does nothing.
Task 5: dispatched.
Task 5: implementer DONE (commit 8251ddc, 133/133 across four touched test files plus typecheck clean;
  six adjacent files re-run green).
Task 5: **the mutation did its job the hard way, and this is worth keeping.** Trusting `system` from the
  query string instead of the stored `state` row did NOT redden the suite on the first pass — no existing
  test forged that parameter. The implementer added one that does, confirmed it fails under the mutation,
  and reverted. A mutation that passes is a missing test, and this one found it.
Task 5: implementer concerns carried to the reviewer: `oauth-routes.test.ts` added (not in the brief's
  list, but the required route test and mutation need it); `live-thread-status.ts` touched to print the
  computed redirect URI and check the two app-secret refs (I asked for this in the dispatch); revoke
  redirects to `/connections`, which Task 6 creates (404 today, forward-compatible); and **the grant write
  and the binding write are two sequential idempotent upserts rather than one transaction** — the
  implementer's position is that a crash between them self-heals by re-running the ceremony. That last one
  is the judgement point I sent to the reviewer.
Task 5: review — spec ✅, quality NOT approved. 1 Critical, 5 Important, 7 Minor. Opus.
  The gate itself was built right, and the reviewer checked it line by line: `consumeState` is one
  statement, the session binding IS enforced in code (with the same message as an invalid state, so a
  prober cannot tell the halves apart), the callback takes `system` from the stored row, PKCE is complete
  with the verifier in the state row and sent only on the exchange, offline+consent are both requested,
  the persisted scopes are the provider's GRANTED set, revocation is local-first, and no secret reaches a
  page, a message, a log or an audit row.
Task 5: **Ruling — C1 is real, I verified it myself, and the fix is `SameSite=Lax`.** The session cookie
  is `SameSite=Strict` (`server.ts:162`). Google returns the owner by a cross-site top-level navigation,
  and a Strict cookie is withheld on exactly that — so `loadSession` returns null, the owner is redirected
  to `/login` with the query string discarded, the authorisation code is thrown away, and the state row
  expires in silence. **Every piece of this task is correct and the ceremony still cannot finish in a real
  browser**, and no test can catch it because the harness sets the cookie header explicitly.
  Verified by me: the attribute is where the reviewer says, and every GET route in the dashboard is a
  read-only page except `/oauth/:system/start`, whose only write is a pending state row bound to the
  victim's own session — not exploitable in the harmful direction.
  Decided: `SameSite=Lax`, and correct the comment at `server.ts:261` that leans on Strict. Lax still
  withholds the cookie on cross-site POSTs, which is every state-changing route here, and the one
  cross-site GET that now exists is gated by the server-side single-use state row this task just built.
  Rejected the alternative (keep Strict, bounce through a session-optional page that re-navigates
  same-site): more moving parts and a new session-optional route is its own surface.
  Cost if wrong: the dashboard's cookie is one notch less strict on cross-site top-level GETs, none of
  which mutate anything.
Task 5: **Ruling — the grant, its audit row and the binding become ONE transaction.** The implementer's
  self-healing argument is half right (both writes are upserts and `prompt=consent` yields a fresh token
  on retry) and misses the real hazard: `appendAudit` is its own commit AFTER the grant has committed, so
  a failure there leaves a refresh token for the business's Google account sealed in the database with no
  `credential_change` row anywhere. `upsertBinding`'s own docblock forbids that shape in words, and
  `decideAndSign` makes the same ruling with a docblock saying three separate commits left a state nobody
  could repair. Two functions in this repo already refuse what this callback adopted. And "re-run the
  ceremony at the provider" is not a proportionate recovery for a partial write the code can make atomic —
  it sends a non-technical owner back through Google's consent screens to repair a database inconsistency.
  The reviewer checked the two objections that would normally block it: no provider call falls inside the
  transaction, and the lock order (rotation then audit) matches `putSecret` with no path taking it in
  reverse.
  Cost if wrong: a failure anywhere rolls the grant back too, and the state row stays consumed — so the
  owner restarts the ceremony. That is the same trade `decideAndSign` already makes.
Task 5: minor (deferred to final review): `credentialRefForSystem` is lossy, so two differently-spelled
  systems collide on the partial unique index and raise a raw 500 after the state is burned (low exposure:
  one system name exists today); `readSmallFormBody` duplicates `readFormBody` with different overflow
  semantics because the original is not exported; and revoke redirects to `/connections`, which Task 6
  creates.
Task 5: fix round 1 dispatched — C1, the one-transaction ruling, I2-I5, and Minors 6, 7, 9, 11.
Task 5: fix round 1/5 landed (commit 76ace34; typecheck clean; oauth-state 6, oauth-consent 18, oauth-routes 16, server 101 = 141/141). All items reported addressed, each of I2-I5 with a regression test that reddens under the described defect; one pre-existing test updated for the cookie change.
Task 5: fix round 1/5 re-review — all findings ADDRESSED, and one NEW Important in the fix diff, which is
  mine: the corrected `SECURITY_HEADERS` comment says "every state-changing route on this dashboard is a
  POST" — the sentence I dictated — and it is false as of this very task. `GET /oauth/:system/start`
  requires only the session cookie and writes a real row. Under `Lax` a cross-site top-level navigation
  does carry the cookie to a GET, so that route is CSRF-reachable in a way the comment denies. **The
  ruling was right and the sentence was wrong**, and the distinction matters: my own reasoning when I ruled
  was that the worst case is a pending state row the attacker cannot use, because completing the grant
  needs the victim to approve at Google and the callback binds the victim's own account. That is what the
  comment should have said.
  Also confirmed, and worth recording: no lock-ordering hazard. `ROTATION_LOCK_SCOPE` is always taken
  before `audit:<business>` across `oauth-grants.ts`, `credential-store.ts` and both `secret-key.ts`
  paths, the new transaction follows the same order, and the nested `appendAudit` inside `upsertBinding`
  re-acquires the same advisory lock within one transaction, which Postgres permits.
Task 5: fix round 2 dispatched — the one new Important (my inaccurate comment).
Task 5: fix round 2/5 landed (commit d1a997e, comments only in server.ts; 101/101 in server.test.ts, typecheck clean).
Task 5: fix round 2/5 re-review — ADDRESSED. The corrected comment does all four things and the CSRF
  reasoning is now sound.
Task 5: minor (deferred to final review), and I caught it in the re-reviewer's own table rather than in its
  verdict: it listed `GET /oauth/callback` as a route that READS. It writes — the grant, the binding and
  the audit row, in one transaction. So the new comment's clause "the one GET route in this file that
  writes anything" is still inaccurate, one notch smaller than the claim it replaced. The security
  reasoning is unaffected, because the callback needs a valid single-use state row bound to the caller's
  own session and an authorisation code, so it is not forgeable. The honest phrasing is "the one GET a
  cross-site navigation can usefully reach". Minor, so it does not enter the loop — but it is the third
  appearance of the same class in one file, which is itself worth the final review's attention.
Task 5: complete (commits 9d97aef..d1a997e, review clean after 2 rounds).
Task 6: implementer DONE (commit cc2bded; connection-groups 7/7, oauth-routes 23/23 with 8 new
  /connections tests, server 101/101, typecheck clean).
Task 6: **my error, caught by the implementer rather than assumed around.** My dispatch cited
  `probeActiveCharter` as existing precedent. It does not exist on this branch: I built it on
  `charter-schema-version` (commit 7145cc8), which is NOT merged — `connector-spine` was cut from `main`
  before it. Verified myself: `git merge-base --is-ancestor 7145cc8 HEAD` says not an ancestor, and the
  only hit for the name in `src/` is the implementer's own comment explaining its absence. It grepped
  instead of trusting me, which is the behaviour this project asks for.
Task 6: **Ruling — keep the local `try`/`catch` and record the cleanup for the merge.** The implementer
  handled "a screen must survive an unreadable charter" with a scoped `try`/`catch` in the handler rather
  than inventing a shared export beyond its file list. That is the right call for a branch that does not
  have the shared helper. **But it creates a merge obligation I must not lose:** when
  `charter-schema-version` lands, the honest cleanup replaces that catch with `probeActiveCharter` — and
  the allowed-caller set for that function, which its own docblock pins to "the install path and the
  readiness report", must be widened to name this screen as a third, or Task 8's import invariant will
  fail on it. Recorded here because the two branches cannot see each other.
  Cost if wrong: one branch carries a local catch that a later merge makes redundant — visible, not silent.
Task 6: review — spec ✅, quality approved with one Important. Sonnet.
  Verified independently and worth recording: the group mapping is genuinely POSITIVE (a hand-written
  prefix table with `Object.hasOwn`, so `constructor`/`__proto__` cannot ride the prototype chain into a
  false match); `grep` over `src/policy`, `src/charter` and `src/orchestrator` finds no reader of the
  grouping outside the view, so the display-only invariant holds in fact and not only in the docblock; the
  restart notice matches `buildRuntime`'s docblock and the runbook on the substantive claim; and the "no
  token on the page" test writes a real secret and asserts its absence AFTER asserting the page rendered.
Task 6: ⚠️ "cannot verify whether the dispatch named `loadBindings`" RESOLVED by me: it did. My live
  dispatch listed `loadBindings({ businessId })` and named `provider`, `lastOkAt` and `lastError` under the
  interfaces this task consumes; the reviewer could only see the extracted brief file, which does not. So
  the operational-status column is NOT scope creep — I handed it those fields — and the implementer's
  citation was accurate to what it was given.
Task 6: minor (deferred to final review): the implementer's own mutation report enumerates four reddened
  tests while claiming five, and the missing one is the primary happy-path assertion. Not a code defect;
  recorded because this project weighs the gap between a claim and what happened.
Task 6: minor (deferred): `connection.system` is interpolated into an href path segment with HTML-escaping
  but no URI-encoding — not attacker-reachable (the value is owner-authored and charter-signed), but a
  system name containing a slash would yield a dead link rather than a working one.
Task 6: fix round 1 dispatched — the one Important (a silent catch with no log line).
Task 6: fix round 1/5 landed (commit 2d0f590; one log line plus a comment; server 101/101, typecheck clean). The implementer also went back to its own mutation output and corrected the undercount itself — the fifth reddened test was the primary happy-path one, truncated out of a tail-piped capture.
Task 6: fix round 1/5 re-review — ADDRESSED. The log line matches the route-level handler's shape exactly,
  the page still renders 200 with the unreadable-charter state, and only two executable lines changed
  (binding the error, and the log call).
Task 6: complete (commits d1a997e..2d0f590, review clean after 1 round).
Task 7: implementer DONE (commit e427e11; binding-health 3/3, plus 61/61 across every performStep/runPlan
  suite; typecheck clean). Mutation: reverting the success-branch CASE made Postgres itself reject the
  statement, so every call threw — and `runPlan` still returned its normal `done`/`halted`, which proves
  BOTH that the write is load-bearing and that a broken write cannot fail the step.
Task 7: **a consequence of my own earlier work, and it blocks the closing live run on this branch.** The dev
  database holds a charter at `schemaVersion "1.2"` because I installed one while working on
  `charter-schema-version` (commit 7145cc8) on 27/09. That branch is NOT merged here, so this branch's code
  expects `"1.1"` and `buildRuntime` throws — the guard I built firing in its OTHER direction: "signed under
  a newer schema than this code understands — roll the code forward, do not re-sign." Nothing is broken;
  the two branches disagree, and the guard says so legibly, which is what it is for.
  **What this means for the finish:** the live run at the end of this plan needs either
  `charter-schema-version` merged first, or a 1.1 charter installed on the dev database. Merging first is
  the honest order — it is green, its security review was clean, and it is the branch that made the version
  meaningful.
Task 7: implementer note (correct, not a finding): `recordBindingOutcome` is a silent no-op when no
  `connection_bindings` row exists, mirroring `upsertBinding`. For this function a missing row is the
  expected case — a local tool has no binding at all.
Task 7: review — spec ✅, quality NOT approved. 2 Important, 2 Minor. Sonnet.
  Verified by tracing rather than by trusting: `errorCode`/`errorMessage` come only from the adapter's own
  `AdapterResult` and never from anything else in the closure; the write is wrapped in its own `.catch`, so
  a broken UPDATE cannot fail the step — by mechanism, not by intention; nothing in the diff writes
  `status`; and the leak test asserts the error was genuinely recorded BEFORE asserting the sentinel is
  absent.
  Both Importants are comment-accuracy defects, and the first is structural: the new function was inserted
  BETWEEN an existing docblock and the function it described, so `upsertBinding` — the one that really does
  validate, replace the whole row and audit — lost its explanation entirely, while its claims now sit above
  a function that does none of them. The second: the new docblock cites `upsertBinding` as precedent for a
  mandatory `businessId`, and `upsertBinding` does the opposite (`options.businessId ?? config.businessId`).
Task 7: the reviewer also corrected the implementer's justification for the missing-row no-op, and the
  correction is worth keeping: a local tool never reaches that code at all, and neither does a system with
  no binding row — `resolveChannel` returns `unavailable` and `performStep` throws `channel_unavailable`
  first. The no-op is real only for a narrow race (the row deleted between the plan's one-time
  `loadBindings` and this step's write). Silence is still right; the example given for it was not reachable.
Task 7: fix round 1 dispatched — both Importants and both Minors.
Task 7: fix round 1/5 landed (commit ad2bc05; docblock reorder plus three comment corrections and one report correction; 61/61 across the performStep/runPlan suites, typecheck clean).
Task 7: fix round 1/5 re-review — all four ADDRESSED. Confirmed the docblock now sits directly above
  `upsertBinding`, the corrected citation names `upsertBinding` as the exception AND the claim was verified
  true in both directions, migration 003's SQL is byte-identical with only comments changed, and the only
  executable change is the function's position.
Task 7: complete (commits 2d0f590..ad2bc05, review clean after 1 round).
Task 8: implementer DONE (commit 69fbbce; FULL suite run once: 150 files, 1992 passed, 1 skipped, exit code 0 measured by redirection rather than piped; typecheck clean). All three required mutations reddened their own assertion and were reverted: breaking the writer-importer set, dropping the grant table from the rotation loop, and planting the sentinel in a plaintext column.
Task 8: review — spec ✅, quality NOT approved. 2 Important. Sonnet.
  Verified sound and worth recording: the writer/reader distinction is real, not cosmetic — `server.ts`
  (listGrants only), `views.ts` (type-only) and `secret-key.ts` (grantAad only) are all correctly NOT
  flagged, and only the two intended modules are; the walk is recursive with an exclusion by name and its
  floor found over a thousand files; the leak scan derives 228 columns from `information_schema`, excludes
  `bytea` correctly, and drives the REAL token service rather than a mock; and every factual claim in the
  new documentation was checked against code and holds, including the subtle one that the cache clears only
  on a rejection and not on a transient or misconfigured outcome.
  Important 1: the leak scan's own docblock says the sentinel refresh token passes through "the cache write
  and the handle handed back" — it does not; only the access token does, and the test's own assertion says
  so. Worse, it contradicts the CLAUDE.md paragraph added in the SAME commit, which states the refresh
  token is never cached. The code matches CLAUDE.md. This is the comment-overclaim class appearing inside
  the very patch built to prevent drift.
  Important 2: the writer-import scan matches only a static named-import clause, so a namespace import, a
  dynamic import or a re-export gives a module write capability undetected — demonstrated empirically by the
  reviewer, not argued. And the template it was told to copy uses a deliberately broad pattern precisely
  because it was burned once by a scan that missed a dynamic import.
Task 8: **my own instruction left a stale comment, and the reviewer found it.** In Task 1's fix round I told
  the implementer to name Task 2 as the task that would close the rotation gap. Task 2 closed it, and
  `oauth-grants.ts:10-14` still says `oauth_grants` "does not appear in rotate at all" — now directly
  contradicted by the accurate CLAUDE.md paragraph Task 8 just added. Folded into this fix round: a
  forward reference is only honest until the thing it points at lands.
Task 8: fix round 1 dispatched — both Importants plus the stale forward reference.
Task 8: fix round 1/5 landed (commit 1107931; full suite re-run exit 0, 150 files, 1992 passed, 1 skipped — identical counts; typecheck clean). The writer scan is now a two-stage fail-closed classifier returning none/writer/reader-only/unrecognized, and the mutation was re-run with a NAMESPACE import — the form the old regex missed — and reddens.
Task 8: fix round 2/5 landed (commit fd13895, comment only; 3/3 in the invariants file, typecheck clean). The report now names the pattern across all three rounds: an unverified data-flow narration recurring in the one file whose purpose is stating what is actually proven.
Task 8: fix round 2/5 re-review — ADDRESSED. All four replacement claims traced to specific lines, the
  false re-seal claim is gone rather than softened, and the change is comment-only.
Task 8: complete (commits ad2bc05..fd13895, review clean after 2 rounds).

ALL EIGHT TASKS COMPLETE. Full suite on the finished branch: 150 files, 1992 passed, 1 skipped, exit 0.

FINAL WHOLE-BRANCH REVIEW (opus): **not ready to merge.** 1 Critical, 5 Important, 7 new Minor, plus a
  triage of every deferred item and a judgement on all 21 rulings. Nothing found in the cryptography, the
  state machine or the gate — the parts each task review scrutinised hardest are sound. Everything found is
  in the seams.
  **Correction to my own accounting:** the ledger carries 21 bolded rulings, not the twelve I had been
  citing. The reviewer counted them and judged all of them so none was silently dropped.
  **C1 — authorising Google on the MAIL connection permanently poisons `OFFICE_MAIL`.** The screen offers a
  connect link for every declared connection without a grant, including `office-mail`; `handleOAuthStart`
  validates nothing about the system; the callback derives `OFFICE_MAIL` from it — byte-identical to the
  static SMTP ref the runbook provisions — and `upsertBinding` writes that ref plus `provider: 'google'`
  onto the mail row. Every later `mail.send` then resolves a ref that exists as BOTH a grant and a secret,
  which the composed source correctly refuses as ambiguous and non-retryable. **And revoking does not
  recover it**: a revoked grant refuses rather than handing off to the static secret, by design. One click
  on a link the product itself offers terminally disables the only capability ever proven live, plus
  approval mail, with no in-product recovery. Task 4's own I1 ruling named that exact click as "the natural
  thing" and fixed only the boot collision.
  **I would not have found this**, and neither did eight task reviews: it is only visible whole.
FINAL FIX WAVE landed (commits fd13895..e4c056e, eight commits covering all 14 brief items). Full suite run
  uncontested: 151 files, 2014 passed, 1 skipped, REAL exit code 0; typecheck clean. Item 1's mutation
  (removing the `serves` gate) reddened the ceremony-refusal test and was reverted.
  The implementer hit this project's documented concurrent-test-run collision — it started a second vitest
  against the same test database while a background full run was live — diagnosed it correctly rather than
  reporting regressions, and re-ran clean twice. That contested run also surfaced three genuine bugs in its
  OWN new test code, which it fixed.
  Items 7 and 10 have no automated tests: `scripts/` is outside `vitest.config.ts`'s include, consistent
  with how the whole directory is already treated. Recorded, not hidden.

FINAL FIX WAVE RE-REVIEW (opus): **all 14 ADDRESSED, zero NOT ADDRESSED, no new Critical or Important.**
  Item 1's four parts were verified independently and then composed. Path A — the reported one — is closed
  four independent times over: the link is a muted span, a hand-typed start URL is a 400 with no state row,
  the callback is unreachable without a state row, and the derived ref is namespaced anyway. Path B is not a
  way in at all: `resolveChannel` already refuses `mail.send` for a charter that never names it.
  Also verified clean: `evaluateToolCall` and `capabilities.ts` byte-untouched; no token, refresh token or
  client secret in any new message, page, audit row or `last_error`; `retryable: true` not widened anywhere;
  `businessId` explicit and mandatory on every new call.

## Residuals — no second fix wave, so each is parked with a ruling

**Parked — Ruling: Path C stays open, narrowed, and it goes to the owner rather than to a ninth round.**
  A HAND-AUTHORED charter declaring one system that serves both `mail.send` and `calendar.read` still passes
  the ceremony's eligibility check — correctly, since it does serve a calendar tool — and the whole-row
  `upsertBinding` then replaces that binding's `OFFICE_MAIL` with the namespaced ref, so a later `mail.send`
  would hand a Google access token to SMTP as a password. It is materially better than what was reported:
  not an ambiguous-ref refusal, `buildRuntime` still boots, the readiness script survives and prints the
  ref, and re-running `scripts/seed-charter.ts` restores the binding — recovery is a documented script, not
  hand SQL. **No seed script produces that charter shape, so no shipped install is exposed.** The clean
  close is a callback-side refusal when the target also serves `mail.send`, or having revoke clear what it
  wrote. Cost of parking: an owner who hand-authors a single combined Google connection breaks mail until
  they re-run one script.

**Parked — Ruling: `seed-charter-live.ts` still supersedes unconditionally, and my brief is why.** Item 7's
  problem statement named it; my Fix clause named only `seed-charter.ts`. That script has always superseded
  without a skip condition, so this is pre-existing — but item 7 made it more consequential, because now
  there is a calendar declaration to lose. Cost of parking: an operator who runs the `-live` variant after
  hand-installing a calendar charter loses the calendar connection silently.

**Parked — Ruling: two runbook inaccuracies stand.** §10.0 still tells the operator to hand-write a calendar
  charter variant the seed script now declares, and §10.1 says the link reads "התחבר" where the code renders
  "לחיבור". Both are one-line edits; neither is load-bearing; and item 14's own point was operator accuracy,
  so they are named rather than dropped. Cost of parking: an operator does redundant work once.

**Parked — Ruling: `credentialRefForSystem`'s docblock overclaims, and it is the fourth of its class on this
  branch.** It calls the `OAUTH_` prefix collision "structurally impossible" while nothing reserves the
  prefix in `putSecret` — it is convention-strong, not structural. No documented ref uses it, so exposure is
  nil. Recorded here specifically because three rounds of this branch were spent on exactly this class, and
  a fourth instance slipping through the wave that fixed the third is the most honest thing I can hand over.

**Parked — Ruling: the callback does not re-check eligibility.** It re-derives the ref but does not re-run
  the charter check, leaving a ten-minute window in which a charter amendment could change the answer
  mid-ceremony. Narrow enough to park; named because it is the same shape as the TOCTOU guards this project
  already doubles elsewhere.

**Accepted as correct, not parked:** items 7 and 10 having no automated tests. Widening vitest's include to
  `scripts/` would import files that call `buildRuntime()` and `closePool()` at module load, which is worse
  than the gap. The reviewer's better suggestion — extract item 7's skip predicate into `src/` where it can
  be tested — is recorded for whoever touches that script next.

FINAL STATE: 151 test files, 2014 passed, 1 skipped, real exit code 0 — measured by redirection, on the
tree that is offered for merge. `npm run typecheck` clean. No leftover mutation in tracked source. Stop hook
restored from the backup.

Started from 1884 tests on `main`; 130 net new. Twenty-four commits plus eight in the final fix wave.
