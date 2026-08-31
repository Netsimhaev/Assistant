import { describe, expect, it } from 'vitest';
import { Proposal, ProposedAction, Stance } from './proposal.js';

const SOURCE = { ordinal: 0, locator: null };
const REASON = { text: 'תנאי התשלום הורעו', findingLabel: 'תנאי תשלום', sourceRef: SOURCE };

const ACTION = {
  headline: 'אשלח מייל לדנה',
  purpose: 'כדי לאשר את מועד ההתקנה',
  intent: 'reply_to_sender',
  agent: 'comms.email',
  toolName: 'mail.send',
  input: { to: 'dana@example.com', subject: 'תיאום', body: 'שלום' },
  expectedActionClass: 'email.reply',
};

function proposal(overrides: Record<string, unknown> = {}) {
  return { stance: 'act', headline: 'אשיב לדנה', reasons: [REASON], action: ACTION, ...overrides };
}

describe('Proposal', () => {
  it('accepts a well-formed act proposal', () => {
    expect(Proposal.safeParse(proposal()).success).toBe(true);
  });

  it('accepts a proposal with no action', () => {
    expect(Proposal.safeParse(proposal({ stance: 'no_action', action: null })).success).toBe(true);
  });

  it('rejects an empty reasons array, because a position without a reason cannot be argued with', () => {
    expect(Proposal.safeParse(proposal({ reasons: [] })).success).toBe(false);
  });

  it('rejects an unknown stance', () => {
    expect(Proposal.safeParse(proposal({ stance: 'maybe' })).success).toBe(false);
  });

  it('rejects a reason that cites no finding', () => {
    const bare = { text: 'לא כדאי', findingLabel: '', sourceRef: SOURCE };
    expect(Proposal.safeParse(proposal({ reasons: [bare] })).success).toBe(false);
  });

  it('rejects an action naming an agent that does not exist', () => {
    expect(ProposedAction.safeParse({ ...ACTION, agent: 'comms.telepathy' }).success).toBe(false);
  });

  it('rejects an action whose intent is not in the registry', () => {
    expect(ProposedAction.safeParse({ ...ACTION, intent: 'sign_contract' }).success).toBe(false);
  });

  it('requires an action to say what it is for, not only what it does', () => {
    const { purpose: _dropped, ...noPurpose } = ACTION;
    expect(ProposedAction.safeParse(noPurpose).success).toBe(false);
  });

  it('declares exactly four stances', () => {
    expect([...Stance.options].sort()).toEqual(['act', 'advise_against', 'ask', 'no_action']);
  });
});
