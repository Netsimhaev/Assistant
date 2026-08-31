import { describe, expect, it } from 'vitest';
import { compileCharter } from '../charter/compile.js';
import type { Reading } from '../domain/reading.js';
import { capabilityCatalogue } from '../orchestrator/catalogue.js';
import { buildCharter } from '../test/fixtures.js';
import { interpretProposerResponse } from './proposer.js';

const bundle = compileCharter(buildCharter());
const catalogue = capabilityCatalogue(bundle, 'boss');

const SOURCE = { ordinal: 0, locator: null };

const READING: Reading = {
  summary: 'הצעת מחיר מספק חדש.',
  findings: [{ label: 'תנאי תשלום', value: '30 יום', sourceRef: SOURCE }],
  intents: [{ intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' }],
  unreadable: [],
};

const VALID_PROPOSAL = {
  stance: 'act',
  headline: 'אשיב לספק',
  reasons: [{ text: 'התנאים סבירים', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: {
    headline: 'אשלח מייל לספק',
    purpose: 'לאשר את התנאים',
    intent: 'reply_to_sender',
    agent: 'comms.email',
    toolName: 'mail.send',
    input: { to: 'supplier@example.com' },
    expectedActionClass: null,
  },
  clarifyingQuestion: null,
};

describe('interpretProposerResponse', () => {
  it('turns a valid response into a proposal and keeps the raw text', () => {
    const raw = JSON.stringify(VALID_PROPOSAL);
    const outcome = interpretProposerResponse(raw, READING, catalogue);
    expect(outcome.status).toBe('proposed');
    expect(outcome.raw).toBe(raw);
    if (outcome.status !== 'proposed') throw new Error('expected proposed');
    expect(outcome.proposal.stance).toBe('act');
  });

  it('finds the proposal inside a fenced block with prose around it', () => {
    const raw = `בטח, הנה ההצעה:\n\`\`\`json\n${JSON.stringify(VALID_PROPOSAL)}\n\`\`\`\nאשמח להמשיך.`;
    const outcome = interpretProposerResponse(raw, READING, catalogue);
    expect(outcome.status).toBe('proposed');
    expect(outcome.raw).toBe(raw);
  });

  it('reports unproposable, with the raw text kept, when nothing parses', () => {
    const raw = 'לא הבנתי את המסמך';
    const outcome = interpretProposerResponse(raw, READING, catalogue);
    expect(outcome.status).toBe('unproposable');
    expect(outcome.raw).toBe(raw);
  });

  it('refuses a stance violation — ask without a clarifying question', () => {
    const raw = JSON.stringify({
      stance: 'ask',
      headline: 'צריך הבהרה',
      reasons: [{ text: 'לא ברור למי לפנות', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
      action: null,
      clarifyingQuestion: null,
    });
    const outcome = interpretProposerResponse(raw, READING, catalogue);
    expect(outcome.status).toBe('unproposable');
    if (outcome.status !== 'unproposable') throw new Error('expected unproposable');
    expect(outcome.reason).toContain('ask_without_question');
  });

  it('refuses a tool the acting agent does not hold in the catalogue', () => {
    const raw = JSON.stringify({
      ...VALID_PROPOSAL,
      action: { ...VALID_PROPOSAL.action, toolName: 'purchase.execute' },
    });
    const outcome = interpretProposerResponse(raw, READING, catalogue);
    expect(outcome.status).toBe('unproposable');
    if (outcome.status !== 'unproposable') throw new Error('expected unproposable');
    expect(outcome.reason).toContain('tool_not_in_catalogue');
  });
});
