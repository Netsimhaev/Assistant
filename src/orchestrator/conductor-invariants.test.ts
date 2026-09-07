/**
 * Structural, in the style of `positive-controls.test.ts`. These do not test
 * behaviour — they hold three properties that a future edit could quietly
 * remove while every behavioural test stayed green.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function source(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

describe('the conductor cannot grant authority', () => {
  it('stamps every job it opens as external, and offers no way to ask otherwise', () => {
    const conduct = source('orchestrator/conduct.ts');
    expect(conduct).toContain("provenance: 'unknown_external'");
    expect(conduct, 'a provenance the caller can choose is a provenance an attacker can choose')
      .not.toMatch(/provenance:\s*(options|input|document|proposal)\./);
    expect(conduct).not.toContain("provenance: 'boss'");
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
