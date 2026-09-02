import { describe, expect, it } from 'vitest';
import { Plan, planProblems } from '../domain/plan.js';
import type { Proposal } from '../domain/proposal.js';
import { proposalToApprovalText, proposalToPlan } from './proposal-to-plan.js';

const SOURCE = { ordinal: 0, locator: null };

const PROPOSAL: Proposal = {
  stance: 'act',
  headline: 'אשיב לדנה',
  reasons: [{ text: 'התנאים הורעו', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: {
    headline: 'אשלח מייל לדנה',
    purpose: 'כדי לאשר את התנאים',
    intent: 'reply_to_sender',
    agent: 'comms.email',
    toolName: 'mail.send',
    input: { to: 'dana@example.com', inReplyTo: 'msg-1' },
    expectedActionClass: 'email.reply',
  },
  clarifyingQuestion: null,
};

describe('proposalToPlan', () => {
  it('produces a plan the schema and the DAG check both accept', () => {
    const plan = proposalToPlan(PROPOSAL, { goal: 'לטפל בהצעת המחיר' });
    expect(plan).not.toBeNull();
    expect(Plan.safeParse(plan).success).toBe(true);
    expect(planProblems(plan!)).toEqual([]);
  });

  it('produces exactly one step, carrying the proposal\'s own values', () => {
    const plan = proposalToPlan(PROPOSAL, { goal: 'לטפל בהצעת המחיר' });
    expect(plan?.steps).toHaveLength(1);
    const step = plan?.steps[0];
    expect(step?.agent).toBe('comms.email');
    expect(step?.toolName).toBe('mail.send');
    expect(step?.input).toEqual({ to: 'dana@example.com', inReplyTo: 'msg-1' });
    expect(step?.expectedActionClass).toBe('email.reply');
    expect(step?.dependsOn).toEqual([]);
  });

  it('carries the action\'s purpose as the step intent, so the audit row says why', () => {
    const plan = proposalToPlan(PROPOSAL, { goal: 'x' });
    expect(plan?.steps[0]?.intent).toContain('כדי לאשר את התנאים');
  });

  it('returns null when the proposal carries no action', () => {
    expect(proposalToPlan({ ...PROPOSAL, stance: 'no_action', action: null }, { goal: 'x' })).toBeNull();
  });

  it('compiles the alternative action of an advise_against proposal', () => {
    const plan = proposalToPlan({ ...PROPOSAL, stance: 'advise_against' }, { goal: 'x' });
    expect(plan?.steps).toHaveLength(1);
  });

  it('is deterministic — the same proposal compiles identically', () => {
    const a = proposalToPlan(PROPOSAL, { goal: 'x' });
    const b = proposalToPlan(PROPOSAL, { goal: 'x' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('proposalToApprovalText', () => {
  it('titles the card with the action, so the owner reads what will happen', () => {
    expect(proposalToApprovalText(PROPOSAL)?.headline).toBe('אשלח מייל לדנה');
  });

  // Spec §4, and the reason is the whole reason: the objection is not the
  // thing being approved. A card headed "אני נגד חתימה" over an Approve
  // button leaves the owner unable to tell whether they approved the
  // objection or the send.
  it('titles an advise_against card with the alternative action, never with the objection', () => {
    const text = proposalToApprovalText({
      ...PROPOSAL,
      stance: 'advise_against',
      headline: 'אני נגד חתימה',
      action: { ...PROPOSAL.action!, headline: 'אשלח לו הודעה בוואטסאפ' },
    });

    expect(text?.headline).toBe('אשלח לו הודעה בוואטסאפ');
    expect(text?.headline).not.toBe('אני נגד חתימה');
  });

  it('carries the purpose and every reason into the detail line', () => {
    const text = proposalToApprovalText({
      ...PROPOSAL,
      reasons: [
        { text: 'התנאים הורעו', findingLabel: 'תנאי תשלום', sourceRef: SOURCE },
        { text: 'המועד לא נקבע', findingLabel: 'מועד', sourceRef: SOURCE },
      ],
    });

    expect(text?.detail).toContain('כדי לאשר את התנאים');
    expect(text?.detail).toContain('התנאים הורעו');
    expect(text?.detail).toContain('המועד לא נקבע');
  });

  it('returns null when the proposal carries no action, because no approval will be raised', () => {
    expect(proposalToApprovalText({ ...PROPOSAL, stance: 'no_action', action: null })).toBeNull();
  });
});
