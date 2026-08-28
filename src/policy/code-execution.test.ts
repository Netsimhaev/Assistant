import { describe, expect, it } from 'vitest';
import { READ_ONLY_TOOLS, classifyAction } from './classify.js';
import { isToolPermitted } from '../charter/capabilities.js';

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

  it('stays available to the agent that produces deliverables', () => {
    expect(isToolPermitted('prod.docs', 'code_execution')).toBe(true);
  });
});
