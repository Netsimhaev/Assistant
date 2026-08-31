import { describe, expect, it } from 'vitest';
import { Plan, planProblems } from '../domain/plan.js';
import type { Proposal } from '../domain/proposal.js';
import { proposalToPlan } from './proposal-to-plan.js';

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
