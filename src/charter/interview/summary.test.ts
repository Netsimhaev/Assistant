import { describe, expect, it } from 'vitest';
import { BusinessCharter } from '../../domain/charter.js';
import { AUTONOMY_LEVEL_HE } from '../../domain/labels.js';
import { signCharter } from '../sign.js';
import type { InterviewAnswers } from './answers.js';
import { buildCharterFromInterview } from './build.js';
import { INTERVIEW_ROWS } from './rows.js';
import { summarizeCharter } from './summary.js';
import { completeAnswers } from './test-answers.js';

const FROZEN = new Date('2026-10-31T10:00:00.000Z');
const CTX = { businessId: 'b', frozenAt: FROZEN };

function build(a: InterviewAnswers, previous: BusinessCharter | null = null) {
  return buildCharterFromInterview(a, { ...CTX, previous });
}
function sign(u: ReturnType<typeof build>): BusinessCharter {
  return BusinessCharter.parse(
    signCharter(u, { signedByPersonId: 'u', method: 'dashboard_click', signedAt: FROZEN }),
  );
}

describe('summarizeCharter', () => {
  it('every row appears in exactly one column', () => {
    const s = summarizeCharter(build(completeAnswers()), { previous: null, documentsWanted: false });
    for (const row of INTERVIEW_ROWS) {
      const hits = [s.can, s.notYetWorking, s.cannot].filter((col) => col.some((l) => l.actionClass === row));
      expect(hits, row).toHaveLength(1);
    }
  });

  it('levels come from the charter, not the answers', () => {
    const charter = build(completeAnswers());
    charter.autonomy.base['crm.write'] = 'auto_notify';
    const s = summarizeCharter(charter, { previous: null, documentsWanted: false });
    const line = [...s.can, ...s.notYetWorking].find((l) => l.actionClass === 'crm.write');
    expect(line?.levelHe).toBe(AUTONOMY_LEVEL_HE.auto_notify);
  });

  it('a forbidden row is in cannot even though mail works', () => {
    const a = completeAnswers();
    a.actions['email.reply'] = 'never';
    const charter = build(a);
    const s = summarizeCharter(
      { ...charter, connections: charter.connections },
      { previous: null, documentsWanted: false },
    );
    expect(s.cannot.some((l) => l.actionClass === 'email.reply')).toBe(true);
    expect(s.can.some((l) => l.actionClass === 'email.reply')).toBe(false);
  });

  it('changes is null on a first install and lists a changed row on an edit', () => {
    const first = build(completeAnswers());
    expect(summarizeCharter(first, { previous: null, documentsWanted: false }).changes).toBeNull();

    const previous = sign(first);
    const a = completeAnswers();
    a.actions['calendar.create'] = 'approve';
    a.counterparties.known = [];
    const s = summarizeCharter(build(a, previous), { previous, documentsWanted: false });
    expect(s.changes).not.toBeNull();
    expect(s.changes?.some((c) => c.includes(AUTONOMY_LEVEL_HE.approve_required))).toBe(true);
    expect(s.changes?.some((c) => c.startsWith('הוסר: '))).toBe(true);
    expect(s.defaultsChosen).toEqual([]);
  });

  it('lists limits and guidance from the charter, and preserved categories on edit', () => {
    const first = build(completeAnswers());
    const s1 = summarizeCharter(first, { previous: null, documentsWanted: true });
    expect(s1.limits.some((l) => l.includes('מובטח'))).toBe(true);
    expect(s1.limits.some((l) => l.includes('21:00'))).toBe(true);
    expect(s1.limits.some((l) => l.includes('₪'))).toBe(true);
    expect(s1.guidance).toContain(first.identity.whatWeDo);
    expect(s1.defaultsChosen.length).toBeGreaterThan(0);
    expect(s1.preserved).toEqual([]);

    const prev = sign(first);
    prev.money.approvedSuppliers = [{ supplierId: 's1', name: 'ספק', ceilingMinor: 100 }] as never;
    const s2 = summarizeCharter(build(completeAnswers(), prev), { previous: prev, documentsWanted: false });
    expect(s2.preserved).toContain('ספקים מאושרים');
  });
});
