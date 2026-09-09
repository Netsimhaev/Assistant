import { describe, expect, it } from 'vitest';
import { Stance } from '../domain/proposal.js';
import type { Reading } from '../domain/reading.js';
import { buildCharter } from '../test/fixtures.js';
import { compileCharter } from '../charter/compile.js';
import {
  READ_ONLY_CLASS_LABEL,
  capabilityCatalogue,
  renderCatalogue,
} from '../orchestrator/catalogue.js';
import {
  PROPOSAL_PROMPT_VERSION,
  buildProposalSystemPrompt,
  renderReadingForProposal,
} from './proposal-prompt.js';

const bundle = compileCharter(buildCharter());
const catalogue = renderCatalogue(capabilityCatalogue(bundle, 'boss'));

const READING: Reading = {
  summary: 'הצעת מחיר מספק חדש.',
  findings: [
    { label: 'סכום ההצעה', value: '4,200 ש"ח', sourceRef: { ordinal: 0, locator: 'סעיף 2' } },
    { label: 'תוקף ההצעה', value: '30 יום', sourceRef: { ordinal: 0, locator: null } },
  ],
  intents: [
    { intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null }, note: '' },
  ],
  unreadable: ['תאריך המסמך עצמו לא צוין'],
};

describe('buildProposalSystemPrompt', () => {
  it('names every stance in Stance.options', () => {
    const prompt = buildProposalSystemPrompt(bundle, catalogue);
    for (const stance of Stance.options) {
      expect(prompt, `${stance} missing from the prompt`).toContain(stance);
    }
  });

  it('opens with the charter the owner signed', () => {
    const prompt = buildProposalSystemPrompt(bundle, catalogue);
    expect(prompt.startsWith(bundle.plainLanguage)).toBe(true);
  });

  it('carries the rendered catalogue', () => {
    const prompt = buildProposalSystemPrompt(bundle, catalogue);
    expect(prompt).toContain(catalogue);
  });

  it('is byte-identical across calls, so the cached prefix survives', () => {
    expect(buildProposalSystemPrompt(bundle, catalogue)).toBe(buildProposalSystemPrompt(bundle, catalogue));
  });

  it('has a version that is a declared constant, not a hash', () => {
    // A hash would change on a comma and invalidate every stored proposal
    // while the question asked stayed identical.
    expect(PROPOSAL_PROMPT_VERSION).toMatch(/^v\d+$/);
  });

  it('states the four rules the validator enforces', () => {
    const prompt = buildProposalSystemPrompt(bundle, catalogue);
    // 1. every reason must cite a finding label verbatim
    expect(prompt).toMatch(/findingLabel/);
    // 2. act requires an action; ask/no_action forbid one
    expect(prompt).toContain('act');
    expect(prompt).toContain('ask');
    expect(prompt).toContain('no_action');
    // 3. the tool must come from the catalogue
    expect(prompt).toMatch(/קטלוג/);
    // 4. headline is in the owner's language, not a tool name
    expect(prompt).toMatch(/headline/);
  });

  /**
   * L1 reaches this prompt too: `catalogue` above is the very same
   * `renderCatalogue` output the planner is given, so a class-less tool's
   * label appears here verbatim. `ProposedAction.expectedActionClass` is
   * `ActionClass.nullable()` exactly as `PlanStep`'s is, so a copied label
   * fails `Proposal.safeParse` the same way it failed `Plan.safeParse`.
   *
   * The first assertion pins the subject present: without a class-less tool
   * in the rendered catalogue, "no bare `read-only`" would hold for a reason
   * that has nothing to do with the rendering.
   */
  it('tells the proposer that a class-less tool takes null', () => {
    expect(catalogue).toContain(READ_ONLY_CLASS_LABEL);
    const prompt = buildProposalSystemPrompt(bundle, catalogue);
    expect(prompt).toContain(READ_ONLY_CLASS_LABEL);
    expect(prompt).not.toMatch(/ · read-only · /);
  });
});

describe('renderReadingForProposal', () => {
  it('carries every finding label', () => {
    const rendered = renderReadingForProposal(READING);
    for (const finding of READING.findings) {
      expect(rendered, `${finding.label} missing from the rendered reading`).toContain(finding.label);
    }
  });

  it('carries every finding value', () => {
    const rendered = renderReadingForProposal(READING);
    for (const finding of READING.findings) {
      expect(rendered).toContain(finding.value);
    }
  });

  it('carries the summary and the unreadable list', () => {
    const rendered = renderReadingForProposal(READING);
    expect(rendered).toContain(READING.summary);
    for (const item of READING.unreadable) {
      expect(rendered).toContain(item);
    }
  });

  it('is byte-identical across calls', () => {
    expect(renderReadingForProposal(READING)).toBe(renderReadingForProposal(READING));
  });
});
