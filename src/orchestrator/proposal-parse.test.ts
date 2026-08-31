import { describe, expect, it } from 'vitest';
import type { Reading } from '../domain/reading.js';
import type { CatalogueEntry } from './catalogue.js';
import { parseProposal, proposalProblems } from './proposal-parse.js';

const SOURCE = { ordinal: 0, locator: null };

const READING: Reading = {
  summary: 'הצעת מחיר.',
  findings: [{ label: 'תנאי תשלום', value: 'שוטף + 60', sourceRef: SOURCE }],
  intents: [{ intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' }],
  unreadable: [],
};

const CATALOGUE: CatalogueEntry[] = [
  { agent: 'comms.email', tools: [{ toolName: 'mail.send', actionClass: 'email.reply', effectiveAutonomy: 'approve_required' }] },
];

const ACTION = {
  headline: 'אשלח מייל לדנה',
  purpose: 'כדי לאשר את התנאים',
  intent: 'reply_to_sender',
  agent: 'comms.email',
  toolName: 'mail.send',
  input: { to: 'dana@example.com', inReplyTo: 'msg-1' },
  expectedActionClass: 'email.reply',
};

const VALID = {
  stance: 'act',
  headline: 'אשיב לדנה על ההצעה',
  reasons: [{ text: 'התנאים הורעו', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: ACTION,
};

describe('parseProposal', () => {
  it('parses a bare JSON object', () => {
    const outcome = parseProposal(JSON.stringify(VALID), READING, CATALOGUE);
    expect(outcome.status).toBe('proposed');
    if (outcome.status !== 'proposed') throw new Error('expected a proposal');
    expect(outcome.proposal.headline).toBe('אשיב לדנה על ההצעה');
  });

  it('parses a response wrapped in prose and a fence', () => {
    const raw = `הנה ההצעה:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``;
    expect(parseProposal(raw, READING, CATALOGUE).status).toBe('proposed');
  });

  it('reports unproposable when there is no JSON', () => {
    const outcome = parseProposal('לא הצלחתי להחליט.', READING, CATALOGUE);
    expect(outcome.status).toBe('unproposable');
    if (outcome.status !== 'unproposable') throw new Error('expected unproposable');
    expect(outcome.reason).toContain('JSON');
  });

  it('refuses act with no action', () => {
    const outcome = parseProposal(JSON.stringify({ ...VALID, action: null }), READING, CATALOGUE);
    expect(outcome.status).toBe('unproposable');
  });

  it('refuses no_action that carries an action', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, stance: 'no_action' }), READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  it('refuses ask without a question', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, stance: 'ask', action: null, clarifyingQuestion: null }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  it('accepts advise_against with an alternative action', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, stance: 'advise_against', headline: 'אני נגד' }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('proposed');
  });

  it('accepts advise_against with no alternative', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, stance: 'advise_against', headline: 'אני נגד', action: null }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('proposed');
  });

  it('refuses a reason citing a finding the reading does not have', () => {
    const invented = { text: 'x', findingLabel: 'סעיף שלא קיים', sourceRef: SOURCE };
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, reasons: [invented] }), READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
    if (outcome.status !== 'unproposable') throw new Error('expected unproposable');
    expect(outcome.reason).toContain('סעיף שלא קיים');
  });

  it('refuses a tool the catalogue does not offer this agent', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, action: { ...ACTION, toolName: 'wa.send_message' } }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  it('refuses an expectedActionClass that contradicts the real classification', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, action: { ...ACTION, expectedActionClass: 'whatsapp.reply' } }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  it("refuses a headline that is the action's own tool name", () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, action: { ...ACTION, headline: 'mail.send' } }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  it('refuses a headline that is a different known tool name', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, action: { ...ACTION, headline: 'wa.send_message' } }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });
});

describe('proposalProblems', () => {
  it('finds nothing wrong with a well-formed proposal', () => {
    const outcome = parseProposal(JSON.stringify(VALID), READING, CATALOGUE);
    if (outcome.status !== 'proposed') throw new Error('expected a proposal');
    expect(proposalProblems(outcome.proposal, READING, CATALOGUE)).toEqual([]);
  });

  it('names the stance problem it found', () => {
    const outcome = parseProposal(JSON.stringify({ ...VALID, stance: 'advise_against', headline: 'x' }), READING, CATALOGUE);
    if (outcome.status !== 'proposed') throw new Error('expected a proposal');
    const problems = proposalProblems({ ...outcome.proposal, action: null, stance: 'act' }, READING, CATALOGUE);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe('act_without_action');
  });
});
