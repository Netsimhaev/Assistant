/**
 * Structural, in the style of `positive-controls.test.ts`. These do not test
 * behaviour — they hold three properties that a future edit could quietly
 * remove while every behavioural test stayed green.
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
 * The full text of one call, from `name(` to its matching closing paren.
 *
 * Anchoring an assertion to "somewhere in the file" lets one literal — the
 * `readDocument` call's `provenance: 'unknown_external'`, say — satisfy a
 * check meant for a different call entirely (`createJob`'s). A refactor that
 * parameterises `createJob`'s provenance while leaving `readDocument`'s
 * literal untouched passed the old, file-wide version of this test for
 * exactly that reason. Extracting the call's own text first means each call
 * is judged only by what it itself sets.
 *
 * Assumes exactly one call to `name` in the source — true for both calls this
 * file inspects — and simple paren balance (no unbalanced parens inside
 * string or template contents, which holds for this file's actual source).
 */
function callBlock(src: string, name: string): string {
  const marker = `${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) {
    throw new Error(`no call to ${name}(...) found`);
  }
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
  return src.slice(start, i);
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
    const createJobCall = callBlock(conduct, 'createJob');
    expectOnlyLiteralProvenance(createJobCall, 'conduct.ts createJob(...)');
  });

  it('reads the document under the same fixed provenance it stamped the job with', () => {
    const conduct = source('orchestrator/conduct.ts');
    const readDocumentCall = callBlock(conduct, 'readDocument');
    expectOnlyLiteralProvenance(readDocumentCall, 'conduct.ts readDocument(...)');
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
