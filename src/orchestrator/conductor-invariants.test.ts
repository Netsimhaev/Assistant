/**
 * Structural, in the style of `positive-controls.test.ts`. These do not test
 * behaviour — they hold three properties that a future edit could quietly
 * remove while every behavioural test stayed green.
 *
 * **Anchored per call, never per file.** Each provenance check extracts the
 * text of the one call it is about (`callBlock`) before asserting anything.
 * A file-wide check lets one call's literal satisfy an assertion meant for
 * another — which is exactly how a parameterised `createJob` once passed a
 * check that `readDocument`'s untouched literal was quietly answering.
 *
 * **What the standing-authorisation and ramp checks do not cover.** They scan
 * `conduct.ts`, `proposal-approval.ts` (and `inbox-scan.ts` for the ramp
 * check) as text for the literal identifiers `useStandingAuthorization`,
 * `grantAuthorization` and `setRampLevel`. An indirect route — a new option
 * threaded through `proposeForReading` (already imported by `conduct.ts`)
 * that reached authorisation or the ramp from inside `propose.ts` itself —
 * would not be caught here. Nothing today does that: `ProposeForReadingOptions`
 * (`src/orchestrator/propose.ts`) carries only `businessId`, `db` and
 * `proposer`, none of which reach authorisation or the ramp — verified at the
 * time this test was written. A future field added to that options type is
 * not something this file watches.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function source(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/**
 * The full text of every call to `name(...)` in `src`, in source order.
 *
 * Anchoring an assertion to "somewhere in the file" lets one literal — the
 * `readDocument` call's `provenance: 'unknown_external'`, say — satisfy a
 * check meant for a different call entirely (`createJob`'s). Extracting each
 * call's own text first means each is judged only by what it itself sets.
 *
 * Simple paren balance (no unbalanced parens inside string or template
 * contents, which holds for these files' actual source).
 */
function allCallBlocks(src: string, name: string): string[] {
  const marker = `${name}(`;
  const blocks: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = src.indexOf(marker, searchFrom);
    if (start === -1) break;
    let depth = 0;
    let i = start + name.length;
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    blocks.push(src.slice(start, i));
    searchFrom = i;
  }
  return blocks;
}

/**
 * The full text of one call to `name(...)`, by its 0-indexed occurrence in
 * source order.
 *
 * **Fix round 1, Important 7.** This used to assume exactly one call to
 * `name` in the source and always return the first — true when this file was
 * written, but `conduct.ts` gained a SECOND `createJob(...)` call (Task 11's
 * `beginVerification`, textually before the document job's own call) without
 * this file's stated assumption being rechecked. The old implementation kept
 * silently returning `beginVerification`'s call — the WRONG one — for a test
 * whose name says it pins the document job's provenance. An occurrence index
 * makes the choice explicit at every call site instead of an unstated
 * assumption a future second call can quietly invalidate again.
 */
function callBlock(src: string, name: string, occurrence = 0): string {
  const blocks = allCallBlocks(src, name);
  const block = blocks[occurrence];
  if (block === undefined) {
    throw new Error(
      `no call to ${name}(...) found at occurrence ${occurrence} (found ${blocks.length} total)`,
    );
  }
  return block;
}

/**
 * Every `provenance:` property inside `block` must set exactly the literal
 * `'unknown_external'` — never an identifier, a property access, a ternary, a
 * `??` fallback, or any other expression, no matter how it is spelled or what
 * it is named.
 *
 * Written as an allowlist of the one acceptable right-hand side, not a
 * denylist of caller-controlled names to reject: CLAUDE.md's own rule is that
 * a control is written positively. A denylist of `options`/`input`/etc. is
 * exactly what a rename defeats; an allowlist of the one literal answer is
 * not.
 */
function expectOnlyLiteralProvenance(block: string, label: string): void {
  const matches = [...block.matchAll(/provenance\s*:\s*([^,\n}]+)/g)];
  expect(matches.length, `${label} must set provenance`).toBeGreaterThan(0);
  for (const match of matches) {
    const rhs = (match[1] ?? '').trim();
    expect(
      rhs,
      `${label}: provenance must be the literal 'unknown_external', not an expression a caller could steer`,
    ).toBe("'unknown_external'");
  }
}

describe('the conductor cannot grant authority', () => {
  it('stamps the job it opens as external, and offers no way to ask otherwise', () => {
    const conduct = source('orchestrator/conduct.ts');
    // Occurrence 1, not the default 0: `conduct.ts` now makes TWO `createJob`
    // calls — `beginVerification`'s (Task 11), textually first in the file,
    // and the document's own job, textually second — and this test is about
    // the DOCUMENT job specifically (see `callBlock`'s own docblock, fix
    // round 1's Important 7). The verify job's own literal is pinned
    // separately and just as strictly by `conduct.test.ts`'s own
    // `the verification job carries unknown_external as a literal`, which
    // checks BOTH calls independently rather than trusting an index here.
    const createJobCall = callBlock(conduct, 'createJob', 1);
    expectOnlyLiteralProvenance(createJobCall, 'conduct.ts createJob(...) (document job)');
  });

  it('reads the document under the same fixed provenance it stamped the job with', () => {
    const conduct = source('orchestrator/conduct.ts');
    const readDocumentCall = callBlock(conduct, 'readDocument');
    expectOnlyLiteralProvenance(readDocumentCall, 'conduct.ts readDocument(...)');
  });

  // M4: the third site, and the one nothing structural held. `conduct.ts`'s
  // two literals decide what the JOB is stamped as and what the READING is
  // filed under; `proposal-approval.ts`'s `buildFacts` call decides the risk
  // band actually stored on the approval row the owner answers. A refactor
  // that parameterised this one while leaving the other two alone passed
  // every check in this file.
  it('builds the approval facts under the same fixed provenance', () => {
    const raise = source('orchestrator/proposal-approval.ts');
    const buildFactsCall = callBlock(raise, 'buildFacts');
    expectOnlyLiteralProvenance(buildFactsCall, 'proposal-approval.ts buildFacts(...)');
  });

  // The other half of the same call, and it moves the band in the opposite
  // direction: `provenanceChainDerived: true` is the first-contact exemption,
  // which drops a `sensitive` band to `routine`. The chain that produced this
  // proposal read a document that arrived from outside, which is exactly the
  // condition that disqualifies the exemption — so the only acceptable value
  // here is the literal `false`, never an expression a caller could steer.
  it('never claims the first-contact exemption for a document that came from outside', () => {
    const raise = source('orchestrator/proposal-approval.ts');
    const buildFactsCall = callBlock(raise, 'buildFacts');
    const matches = [...buildFactsCall.matchAll(/provenanceChainDerived\s*:\s*([^,\n}]+)/g)];
    expect(matches.length, 'buildFacts must set provenanceChainDerived').toBe(1);
    expect((matches[0]?.[1] ?? '').trim()).toBe('false');
  });

  it('never turns on standing authorisation', () => {
    for (const file of ['orchestrator/conduct.ts', 'orchestrator/proposal-approval.ts']) {
      expect(source(file), `${file} must not reach for standing authorisation`).not.toContain(
        'useStandingAuthorization',
      );
      expect(source(file)).not.toContain('grantAuthorization');
    }
  });

  it('never raises a ramp level', () => {
    for (const file of [
      'orchestrator/conduct.ts',
      'orchestrator/proposal-approval.ts',
      'orchestrator/inbox-scan.ts',
    ]) {
      expect(source(file), `${file} must not move the ramp`).not.toContain('setRampLevel');
    }
  });

  it('says on every card that approving does not execute', () => {
    const raise = source('orchestrator/proposal-approval.ts');
    expect(raise).toContain('RAMP_HONESTY');
    // Not a check on the exact source text of the template literal — a
    // harmless reformatting (different whitespace between the two
    // interpolations, a literal newline instead of an escaped one) should
    // not be able to break this test. What must hold is the property: the
    // stored `detail` is built from `text.detail` followed by `RAMP_HONESTY`
    // in the same template literal, in that order. Removing the
    // interpolation, dropping `RAMP_HONESTY`, or reversing the order all
    // still fail it.
    expect(
      raise,
      'the detail sent to enqueueApproval must interpolate text.detail before RAMP_HONESTY',
    ).toMatch(/detail:\s*`[^`]*\$\{text\.detail\}[^`]*\$\{RAMP_HONESTY\}[^`]*`/);
  });
});
