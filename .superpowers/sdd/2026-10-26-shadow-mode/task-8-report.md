# Task 8 report — documentation

Status: DONE_WITH_CONCERNS (one pending item: the test-count line)
Commit: 55b128e `docs: shadow mode, learning level, learned replies`

## What changed

**CLAUDE.md**
- Erasure counts: 19 → **20 tables** (`countItems`/executor; I checked both files and found 20 table names in each), and sixteen → **seventeen** seeded content stores (`action_updates` added). Kept as two distinct numbers in all three places.
- The first-contact paragraph and the ramp-floor paragraph: "ten clean approvals / streak" → the >80% of ≥5 rule.
- Dial paragraph: "two ceilings ALWAYS present" → only the charter cap is always present. The provenance ceiling has two named exceptions: approvedReplyCovers drops it together with the ramp, and learnedReplyCovers drops it alone.
- `approvalStreak` → `agreementFor` in the first-rung paragraph.
- The `auto_notify` paragraph is rewritten. The two levels still enforce identically, and the notify half is now built. It is tied to "ran with no card", not to the level.
- New paragraph on `dispatchActionUpdates`. It covers:
  - one update per step, never batched;
  - `fromInstruction` excluded;
  - insert-then-send with ON CONFLICT;
  - at least one channel, enforced in two layers, with defaults of email + screen;
  - the 040 channel states and `seen_at`;
  - the update id in the sent text, and why;
  - the 24h bound in SQL;
  - the plain-text body for erasure.
- "Every number is derived" paragraph: `approvalStreak` → `agreementFor`.
- New paragraph on the promotion rule. It covers:
  - `isLearned` and its thresholds;
  - evidence from mailbox reply jobs only;
  - only the first decided card counts, and re-raises are dropped;
  - expired and cancelled cards are not counted;
  - the relink undercount;
  - `agreementVerdict`: a recipient, number or date change is always wrong, otherwise up to 3 words is right;
  - numbers compared in order;
  - date-word details and the known gaps;
  - the reason string;
  - one source shared with learning-view.
- Demotion-window paragraph rewritten: GREATEST(14 days, `lastEventAt`) for agreement; `markCount`/`failureCount` since the last move.
- New `learnedReplyCovers` paragraph, placed right after `approvedReplyCovers`. It covers:
  - every condition, as written in learned-reply.ts;
  - it drops ONLY the provenance ceiling;
  - the no-`unknown`-row condition, and why;
  - the risk band is kept, so unknown senders still get a card;
  - no lost-claim recompute;
  - the `learned_reply_exemption` marker on `intent_to_act`;
  - the `raiseReplyCard` fork with `LEARNED_NO_CARD_REASON`;
  - `reraiseLearnedReplies` (disjoint from the first branch; `claimFailedReply`; the may-have-sent rule);
  - the stage-8 test discipline.
- A separate ⚠️ paragraph for the **27/10 owner ruling**: a forged From of a known domain gets an autonomous reply; there is no DMARC/SPF/DKIM check; Microsoft `/reply` quotes the original, so the forged text is relayed inside a genuine business email; this is an accepted, documented risk, not a bug.
- Labels paragraph: the "notify half never built" clause is corrected.
- Known issues: a new block with (a) the `plan::text ILIKE` JSON-escaping miss (pre-existing), (b) GET `/autonomy/actions` sets `seen_at` (SameSite=Lax), (c) a learned send that ended `unknown` or failed gets no `action_updates` row, (d) the timing-flaky mail-poll attachment-budget test.

**Other files**
- `src/orchestrator/ramp.ts`: the `loadRampLevel` docblock now says the charter cap is always present and the provenance ceiling has the two exceptions. (Line ~214's claim about the delegation-exempt step is still true, so I left it.)
- `src/domain/labels.ts`: the docblock is corrected. It claimed the notify half was never built. I found this beyond the listed items, as the same stale claim.
- `docs/05-approvals.md`: the "two always present" claim is fixed. The promotion section is rewritten with the shadow-mode rule. A new subsection covers learned replies and per-action updates. "Resets the streak" / "the ten" wording is gone from the demotion section.
- `docs/08-risks.md`: a sub-bullet under the Shadow mode guardrail says what was built, what was not (non-mail classes have no evidence source), the §5.6 price, and the forged-From ruling with the Microsoft quoting.
- `docs/09-roadmap.md`: the Shadow mode bullet is struck through and marked built. The ramp bullet is updated. A new "built" note says what was and was not built. The 22/09 "proactive notification not built" item is annotated.
- `docs/10-user-settings.md`:
  - §1: the measurement rule is rewritten, "resets the streak" is removed, and the "no notifications" paragraph is replaced. It now names learned replies going out alone to known senders, and the forged-From risk. The status line is updated.
  - §4: "no mail goes out without your approval — always" is fixed. It contradicted the learned reply.
  - Changelog row added.
- `src/governance/erasure-invariants.test.ts`: the `autonomy_marks` docblock is moved back above its `it(...)`. The diff is a pure move of 17 lines.

## Verification
- `npm run typecheck`: clean.
- `npx vitest run src/governance/erasure-invariants.test.ts --no-file-parallelism`: 13/13 passed.
- Every code claim was checked against the file it names. Files read: agreement.ts, agreement-verdict.ts, promote.ts, learned-reply.ts, the engine.ts diff, the mail-reply.ts diff, action-updates.ts, action-update-settings.ts, migration 047, autonomous-actions.ts, learning-view.ts imports, erasure-plan.ts/erasure.ts table names, graph.ts `sendReply`, and server.ts cookie attributes.

## Pending / concerns
- **Test count line (CLAUDE.md line 11) is untouched**, as instructed. It still says 2803. Replace it with the controller's final "2,9xx" figure.
- `src/dashboard/autonomous-actions.ts` docblock: the brief listed it, but Task 5/6 had already rewritten it for H3. I left it.
- I did not run `npm test` (per instructions).

## Fix round 1

1. CLAUDE.md:124: the autonomy_events reason example is now "5 מתוך 6 הכרעות אחרונות (83%)". I checked this against promote.ts:363 (`${right} מתוך ${counted} הכרעות אחרונות (${pct}%)`). The same stale example sat in the src/governance/erasure-plan.ts:29 comment, so I fixed it the same way.
2. docs/09-roadmap.md:95: item (2) now states the current fact. The per-action update has existed since 27/10, and one short clause keeps the 22/09 history. Item (1) now ends "never a result of the measurement" instead of "of a streak". I removed the appended 27/10 note.
3. promote.test.ts:401/419: "streak starts again" is now "window starts again", in the test name and in the comment. I changed wording only.

Verification: `npx vitest run src/orchestrator/promote.test.ts --no-file-parallelism` passes 18/18, and typecheck is clean.

Remaining grep hits ("רצופים", "streak", "ten consecutive", "STREAK_REQUIRED"), and why each one is correct:
- CLAUDE.md:394: "measured by agreement rate, not by streak". It names what was replaced.
- docs/09-roadmap.md:126: "instead of ten consecutive approvals". It names what was replaced.
- docs/superpowers/plans/2026-09-22-autonomy-promotion.md and specs/2026-09-22-autonomy-promotion-design.md: historical plan and spec for the 22/09 work.
- docs/superpowers/plans/2026-10-26-shadow-mode.md and specs/2026-10-26-shadow-mode-design.md: this feature's own plan and spec, which describe the replacement.
- src/dashboard/auth.ts:243: a "failed-attempt streak" of login failures. It is unrelated to promotion.
