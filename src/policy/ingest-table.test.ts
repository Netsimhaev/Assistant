import { describe, expect, it } from 'vitest';
import { ActionClass } from '../domain/action.js';
import {
  REFINEMENT_RULES,
  READ_ONLY_TOOLS,
  refineActionClass,
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
                     'calendar.propose_slots',
                     // `gov.verify`'s judging step: it loads the saved `Reading`
                     // of a document and that document's artifacts, and composes
                     // the judge's answer from them. `false` was accurate only
                     // while nothing implemented the tool.
                     'assert.evaluate']) {
      expect(ingestsExternalContent(t), t).toBe(true);
    }
  });

  it('does not classify local composition or outbound writes as ingesting', () => {
    for (const t of ['mail.draft', 'mail.send', 'template.render', 'render.markdown',
                     'chart.render', 'charter.read', 'charter.voice', 'norms.query',
                     'schema.map', 'escalate_to_human',
                     'wa.conversation_state', 'credential.request_session',
                     'calendar.write', 'crm.write', 'file.write']) {
      expect(ingestsExternalContent(t), t).toBe(false);
    }
  });
});

describe('the payload-refinement rules match the function that enforces them', () => {
  /**
   * The rules are prose the planner reads; `refineActionClass` is the code the
   * gate runs. A rule stated in one place and enforced in another drifts, and
   * the live run of 11/09 is what that drift costs: the planner declared
   * `email.reply` for a `mail.send` with no thread, the gate said
   * `email.initiate`, and the owner's whole instruction was refused.
   *
   * Both directions, mechanically, so neither list can grow without the other.
   */
  it('covers exactly the base classes the payload actually refines', () => {
    // A battery of payloads spanning every field any branch reads. A base
    // class that changes under ANY of these is refined and needs a rule.
    const probes: Record<string, unknown>[] = [
      {},
      { inReplyTo: 'm-1' },
      { conversationId: 'c-1' },
      { amountMinor: 5_000 },
      { operation: 'move' },
      { operation: 'cancel' },
      { operation: 'something-nobody-defined' },
    ];

    const refined = ActionClass.options
      .filter((base) => probes.some((input) => refineActionClass(base, input) !== base))
      .sort();
    const documented = REFINEMENT_RULES.map((r) => r.base).sort();

    expect(documented).toEqual(refined);
  });

  it('gives every rule a body that names the field the branch actually reads', () => {
    // Without this the list could satisfy the test above while saying nothing
    // a planner could act on — the defect being fixed was precisely a model
    // that had no way to know which field decided.
    const fieldOf: Record<string, string> = {
      'email.reply': 'inReplyTo',
      'whatsapp.reply': 'conversationId',
      'calendar.create': 'operation',
      'browser.interact': 'amountMinor',
    };
    for (const { base, rule } of REFINEMENT_RULES) {
      const field = fieldOf[base];
      expect(field, `no expected field recorded for ${base}`).toBeDefined();
      expect(rule, `rule for ${base} does not name ${field}`).toContain(field as string);
    }
  });
});
