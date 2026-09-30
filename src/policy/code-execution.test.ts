import { describe, expect, it } from 'vitest';
import { READ_ONLY_TOOLS, classifyAction } from './classify.js';
import { AGENT_ALLOWLISTS, UNOWNED_TOOLS, isToolPermitted } from '../charter/capabilities.js';
import type { AgentId } from '../domain/audit.js';

/**
 * `READ_ONLY_TOOLS` membership is not a description, it is a decision: the tool
 * skips gate steps 5–10 entirely and leaves no audit row, because steps 1–4 do
 * not log. `file.write` was moved out of that set for exactly this reason —
 * "a tool that writes to the filesystem is not a read". Code execution is
 * strictly stronger than a file write, and it sat in the read-only set while
 * being held by `know.reader`, the one agent whose input is untrusted by
 * construction.
 *
 * The quarantine invariant in `capabilities.test.ts` was satisfied only because
 * the tool was unclassified — the very thing that made it dangerous was what
 * made it look safe.
 */
describe('code_execution', () => {
  it('is classified, so it passes the whole gate and leaves a record', () => {
    expect(classifyAction('code_execution')).toBe('artifact.write');
  });

  it('does not skip the gate as a read', () => {
    expect(READ_ONLY_TOOLS.has('code_execution')).toBe(false);
  });

  it('is out of reach of the agent that reads untrusted content', () => {
    expect(isToolPermitted('know.reader', 'code_execution')).toBe(false);
  });

  /**
   * Was `stays available to the agent that produces deliverables`, asserting
   * `prod.docs` could call it. That is no longer true, and the flip IS the
   * close of the 28/08 review's second open finding: `artifact.write` is
   * calibrated for a reversible internal file write, and nothing about
   * running code is reliably any of those. Rather than grade the authority of
   * a capability `runLocalTool` has no handler for, the tool is owned by
   * nobody — see `UNOWNED_TOOLS`'s docblock for why that was preferred over a
   * new `ActionClass`, and for the exact path back if Stage 2 needs it.
   */
  it('is owned by no agent at all, so no allowlist or charter edit can reach it', () => {
    expect(UNOWNED_TOOLS).toContain('code_execution');
    for (const agent of Object.keys(AGENT_ALLOWLISTS) as AgentId[]) {
      expect(isToolPermitted(agent, 'code_execution'), `${agent} → code_execution`).toBe(false);
    }
  });

  /**
   * The mapping outlives the ownership on purpose. An unowned tool that is
   * also unclassified is treated as read-only — skipping gate steps 5–10 and
   * leaving no audit row — the instant someone re-adds it to an allowlist,
   * which is precisely the state the 28/08 review found this tool in.
   */
  it('stays classified while unowned, so re-owning it cannot make it read-only by accident', () => {
    expect(classifyAction('code_execution')).not.toBeNull();
    expect(READ_ONLY_TOOLS.has('code_execution')).toBe(false);
  });
});
