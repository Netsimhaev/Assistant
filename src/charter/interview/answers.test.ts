import { describe, expect, it } from 'vitest';
import { emailDomainProblem } from '../../domain/charter.js';
import {
  CounterpartyEntry,
  INTERVIEW_SECTIONS,
  InterviewAnswers,
  InterviewAnswersDraft,
} from './answers.js';

const business = {
  description: 'חנות',
  legalName: 'אלפא בע"מ',
  tradeName: 'אלפא',
  vertical: 'retail',
  employees: 3,
  expectations: '',
  notDone: [],
  keyFacts: [],
};

const principal = (whatsapp: string | null) => ({
  displayName: 'דנה',
  role: 'בעלים',
  whatsapp,
  email: null,
});

describe('interview answers schema', () => {
  it("rejects a wildcard domain with the charter's own message", () => {
    const r = CounterpartyEntry.safeParse({ label: 'מתחרה', emailDomain: '*.rival.co.il' });
    expect(r.success).toBe(false);
    const expected = emailDomainProblem('*.rival.co.il');
    expect(expected).not.toBeNull();
    expect(r.error?.issues.map((i) => i.message)).toContain(expected);
  });

  it('rejects a principal WhatsApp number in local form', () => {
    const shape = InterviewAnswers.shape.principal;
    expect(shape.safeParse(principal('0541234567')).success).toBe(false);
    expect(shape.safeParse(principal('+972541234567')).success).toBe(true);
    expect(shape.safeParse(principal(null)).success).toBe(true);
  });

  it('a counterparty needs a domain or a phone', () => {
    expect(CounterpartyEntry.safeParse({ label: 'x' }).success).toBe(false);
    expect(CounterpartyEntry.safeParse({ label: 'x', emailDomain: 'rival.co.il' }).success).toBe(true);
    expect(CounterpartyEntry.safeParse({ label: 'x', phone: '+972541234567' }).success).toBe(true);
    expect(CounterpartyEntry.safeParse({ label: 'x', phone: '054' }).success).toBe(false);
  });

  it('InterviewAnswersDraft accepts a draft holding only business', () => {
    expect(InterviewAnswersDraft.safeParse({ business }).success).toBe(true);
  });

  it('lists the sections in step order', () => {
    expect(INTERVIEW_SECTIONS).toEqual([
      'business', 'principal', 'voice', 'hours', 'reading', 'actions',
      'money', 'counterparties', 'autonomy', 'extra',
    ]);
  });

  it('caps rule text at 500 characters', () => {
    const rules = InterviewAnswers.shape.extra.shape.accepted;
    expect(rules.safeParse([{ kind: 'guidance', text: 'x'.repeat(501) }]).success).toBe(false);
    expect(rules.safeParse([{ kind: 'guidance', text: 'x'.repeat(500) }]).success).toBe(true);
  });
});
