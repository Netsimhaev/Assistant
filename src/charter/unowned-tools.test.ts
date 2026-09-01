import { describe, expect, it } from 'vitest';
import { AGENT_ALLOWLISTS, UNOWNED_TOOLS, isToolPermitted, matchesPattern } from './capabilities.js';
import { AgentId } from '../domain/audit.js';

/**
 * The three tools nobody owns, named rather than counted.
 *
 * `capabilities.test.ts` asserts that every classified tool is either owned or
 * deliberately unowned — which stays green the day one of these gains an owner.
 * The signing design (2026-09-01) rests on `contract.sign` being unreachable by
 * construction, so the claim is made checkable here: whoever gives one of these
 * an owner does it against a red test, in the open.
 */
describe('the deliberately unowned tools', () => {
  it('names exactly the three the capability layer documents', () => {
    expect([...UNOWNED_TOOLS].sort()).toEqual(
      ['charter.apply_amendment', 'contract.sign', 'payment.charge'].sort(),
    );
  });

  /**
   * Hygiene: no allowlist reaches an unowned tool, even through a wildcard.
   *
   * The plan this test started from filtered with `.includes(tool)` — an
   * exact string match. Allowlist entries are patterns, though
   * (`matchesPattern`, `capabilities.ts`), so an allowlist that gained
   * `'contract.*'` would grant a pattern covering `contract.sign` while the
   * literal string `'contract.*'` never appears in `UNOWNED_TOOLS` — the
   * `.includes` version would have stayed green. This asks the question the
   * other way round: does any allowlist *pattern* match an unowned tool,
   * with the arguments in the order `matchesPattern` expects (concrete tool
   * first, pattern second).
   */
  it('gives none of them to any agent, even by wildcard', () => {
    const agents = Object.keys(AGENT_ALLOWLISTS) as AgentId[];
    const owned = agents.flatMap((agent) =>
      AGENT_ALLOWLISTS[agent]
        .filter((pattern) => UNOWNED_TOOLS.some((tool) => matchesPattern(tool, pattern)))
        .map((pattern) => `${agent} → ${pattern}`),
    );
    expect(owned).toEqual([]);
  });

  /**
   * The reachability claim itself: `isToolPermitted` refuses every unowned
   * tool for every agent.
   *
   * Be honest about what this does and does not cover. `isToolPermitted`
   * short-circuits on `UNOWNED_TOOLS` before it ever consults an allowlist
   * (`capabilities.ts`), so this test cannot go red from an allowlist edit —
   * only from a tool being removed from `UNOWNED_TOOLS`. That is still worth
   * having, because it is the spec's actual claim ("unreachable by
   * construction"), but it is not a second check on allowlists. The test
   * above is the one that catches an allowlist widening — this one and that
   * one divide the claim cleanly, and neither substitutes for the other.
   */
  it('refuses every agent for every unowned tool', () => {
    for (const agent of AgentId.options) {
      for (const tool of UNOWNED_TOOLS) {
        expect(isToolPermitted(agent, tool), `${agent} → ${tool}`).toBe(false);
      }
    }
  });
});
