import { describe, expect, it } from 'vitest';
import {
  READ_ONLY_TOOLS,
  classifiedToolNames,
  ingestsExternalContent,
  toolsWithIngestDecision,
} from './classify.js';

describe('the content-ingesting table', () => {
  it('decides every tool the system knows about, explicitly', () => {
    // A known tool absent from the table would fall to the `?? true`
    // fail-safe. That is the safe direction, but it is also silent: nobody
    // reasoned about the tool, and the table would drift out of sync with the
    // tool list without a single test going red. Asserting explicit coverage
    // is what makes adding a tool a decision rather than an omission.
    const known = new Set([...classifiedToolNames(), ...READ_ONLY_TOOLS]);
    const decided = new Set(toolsWithIngestDecision());
    const undecided = [...known].filter((t) => !decided.has(t)).sort();
    expect(undecided).toEqual([]);
  });

  it('carries no decision for a tool the system does not know', () => {
    // The other direction: a stale entry for a tool that no longer exists is
    // dead weight that hides the real coverage number.
    const known = new Set([...classifiedToolNames(), ...READ_ONLY_TOOLS]);
    const stale = toolsWithIngestDecision().filter((t) => !known.has(t)).sort();
    expect(stale).toEqual([]);
  });

  it('treats an unknown tool as ingesting', () => {
    // Fail-safe: a name nobody classified must not buy an exemption.
    expect(ingestsExternalContent('some.tool.invented.later')).toBe(true);
  });

  it('classifies the browser surface as ingesting, all of it', () => {
    for (const t of ['browser.navigate', 'browser.snapshot', 'browser.screenshot',
                     'browser.click', 'browser.fill', 'browser.submit_order']) {
      expect(ingestsExternalContent(t), t).toBe(true);
    }
  });

  it('classifies stored-content readers as ingesting', () => {
    // Provenance travels with a stored chunk forever (docs/06-memory.md), so
    // recall is a read of possibly-untrusted content however old it is.
    for (const t of ['memory.recall', 'memory.recall_shallow', 'doc.fetch',
                     'crm.read', 'accounting.read', 'calendar.read', 'tasks.read',
                     'artifact.read', 'recipe.load', 'media.inspect', 'code_execution',
                     'calendar.propose_slots']) {
      expect(ingestsExternalContent(t), t).toBe(true);
    }
  });

  it('does not classify local composition or outbound writes as ingesting', () => {
    for (const t of ['mail.draft', 'mail.send', 'template.render', 'render.markdown',
                     'chart.render', 'charter.read', 'charter.voice', 'norms.query',
                     'schema.map', 'assert.evaluate', 'escalate_to_human',
                     'wa.conversation_state', 'credential.request_session',
                     'calendar.write', 'crm.write', 'file.write']) {
      expect(ingestsExternalContent(t), t).toBe(false);
    }
  });
});
