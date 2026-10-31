import { describe, expect, it } from 'vitest';
import { proposeRuleWithModel } from '../../sdk/interview-rule.js';
import { describeRule, parseRuleProposal } from './rule-proposal.js';

const TEXT = 'לא להוציא הצעות מחיר';

describe('parseRuleProposal', () => {
  it('maps a forbid onto known rows only', () => {
    const raw = JSON.stringify({
      kind: 'forbid',
      actionClasses: ['quote.issue', 'payment.charge', 'nonsense'],
    });
    expect(parseRuleProposal(raw, TEXT)).toEqual({
      kind: 'forbid',
      text: TEXT,
      actionClasses: ['quote.issue'],
    });
  });

  it('falls back to guidance on garbage', () => {
    expect(parseRuleProposal('not json at all', TEXT)).toEqual({ kind: 'guidance', text: TEXT });
    expect(parseRuleProposal('{"kind":"delete_everything"}', TEXT)).toEqual({
      kind: 'guidance',
      text: TEXT,
    });
  });

  it('an all-unknown forbid becomes guidance', () => {
    const raw = JSON.stringify({ kind: 'forbid', actionClasses: ['payment.charge', 'x'] });
    expect(parseRuleProposal(raw, TEXT)).toEqual({ kind: 'guidance', text: TEXT });
  });

  it('do_not_contact with a wildcard domain becomes guidance', () => {
    const raw = JSON.stringify({ kind: 'do_not_contact', label: 'רייבל', emailDomain: '*.rival.co.il' });
    expect(parseRuleProposal(raw, TEXT)).toEqual({ kind: 'guidance', text: TEXT });
  });

  it('builds a do_not_contact from a valid domain', () => {
    const raw = JSON.stringify({ kind: 'do_not_contact', label: 'רייבל', emailDomain: 'rival.co.il' });
    expect(parseRuleProposal(raw, TEXT)).toEqual({
      kind: 'do_not_contact',
      text: TEXT,
      entry: { label: 'רייבל', emailDomain: 'rival.co.il' },
    });
  });

  it('builds a never_say and ignores model-supplied text', () => {
    const raw = JSON.stringify({ kind: 'never_say', phrase: 'מובטח', text: 'evil' });
    expect(parseRuleProposal(raw, TEXT)).toEqual({ kind: 'never_say', text: TEXT, phrase: 'מובטח' });
  });
});

describe('describeRule', () => {
  it('describes all four kinds in Hebrew', () => {
    expect(describeRule({ kind: 'forbid', text: TEXT, actionClasses: ['quote.issue'] })).toContain(
      'לעולם לא',
    );
    expect(
      describeRule({
        kind: 'do_not_contact',
        text: TEXT,
        entry: { label: 'רייבל', emailDomain: 'rival.co.il' },
      }),
    ).toMatch(/רייבל.*rival\.co\.il/);
    expect(describeRule({ kind: 'never_say', text: TEXT, phrase: 'מובטח' })).toContain('מובטח');
    expect(describeRule({ kind: 'guidance', text: TEXT })).toContain(TEXT);
  });
});

describe('proposeRuleWithModel', () => {
  it('refuses under test', async () => {
    await expect(proposeRuleWithModel(TEXT)).rejects.toThrow(/refusing to run under NODE_ENV=test/);
  });
});
