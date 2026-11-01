import { describe, expect, it } from 'vitest';
import { BusinessCharter } from '../../domain/charter.js';
import { AUTONOMY_LEVEL_HE } from '../../domain/labels.js';
import { signCharter } from '../sign.js';
import type { InterviewAnswers } from './answers.js';
import { buildCharterFromInterview } from './build.js';
import { INTERVIEW_ROWS } from './rows.js';
import { ZERO_DISCOUNT_CEILING_NOTE, ZERO_MONEY_CEILING_NOTE, summarizeCharter } from './summary.js';
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
    expect(s.changes?.some((c) => c.startsWith('הוסר מהצדדים המוכרים: '))).toBe(true);
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

describe('summarizeCharter — what an edit changes', () => {
  const previous = () => sign(build(completeAnswers()));

  it('an unchanged edit lists nothing, so the empty state is true', () => {
    const prev = previous();
    expect(summarizeCharter(build(completeAnswers(), prev), { previous: prev, documentsWanted: false }).changes).toEqual([]);
  });

  it('money ceilings and the discount', () => {
    const prev = previous();
    const a = completeAnswers();
    a.money = { singleMinor: 50_000, dailyMinor: 300_000, monthlyMinor: 2_000_000, maxDiscountPercent: 10 };
    const changes = summarizeCharter(build(a, prev), { previous: prev, documentsWanted: false }).changes ?? [];
    expect(changes.some((c) => c.startsWith('סכום מקסימלי לפעולה אחת:') && c.includes('500'))).toBe(true);
    expect(changes).toContain('הנחה מקסימלית: 5% ← 10%');
    expect(changes.some((c) => c.startsWith('סכום מקסימלי ליום'))).toBe(false);
  });

  it('quiet hours added, moved and removed', () => {
    const prev = previous();
    const moved = completeAnswers();
    moved.hours.quietHours = { from: '22:00', to: '07:00' };
    expect(summarizeCharter(build(moved, prev), { previous: prev, documentsWanted: false }).changes).toContain(
      'שעות שקט: 21:00–08:00 ← 22:00–07:00',
    );
    const removed = completeAnswers();
    removed.hours.quietHours = null;
    expect(summarizeCharter(build(removed, prev), { previous: prev, documentsWanted: false }).changes).toContain(
      'שעות שקט: 21:00–08:00 ← אין',
    );
    const signedWithout = sign(build(removed));
    expect(
      summarizeCharter(build(completeAnswers(), signedWithout), { previous: signedWithout, documentsWanted: false }).changes,
    ).toContain('שעות שקט: אין ← 21:00–08:00');
  });

  it("the principal's WhatsApp", () => {
    const prev = previous();
    const a = completeAnswers();
    a.principal.whatsapp = '+972549998877';
    expect(summarizeCharter(build(a, prev), { previous: prev, documentsWanted: false }).changes).toContain(
      'הוואטסאפ של הבעלים: +972541234567 ← +972549998877',
    );
  });

  it('a mailbox added', () => {
    const prev = previous();
    const a = completeAnswers();
    a.reading = { mailbox: 'google', documents: false };
    const s = summarizeCharter(build(a, prev), { previous: prev, documentsWanted: false });
    expect(s.changes?.some((c) => c.startsWith('נוספה תיבת המייל של העסק'))).toBe(true);
    expect(s.mailboxAdded).toBe('google');
  });

  it('a must-never-say phrase removed', () => {
    const prev = previous();
    const a = completeAnswers();
    a.voice.mustNeverSay = [];
    expect(summarizeCharter(build(a, prev), { previous: prev, documentsWanted: false }).changes).toContain(
      'הוסר מ„לעולם לא לומר”: מובטח',
    );
  });

  it('time zone, workweek, hours and voice', () => {
    const prev = previous();
    const a = completeAnswers();
    a.hours.timezone = 'Europe/London';
    a.hours.workweek = ['mon', 'tue'];
    a.hours.close = '18:00';
    a.voice.register = 'formal';
    a.voice.signOff = '';
    a.voice.emojiPolicy = 'never';
    const changes = summarizeCharter(build(a, prev), { previous: prev, documentsWanted: false }).changes ?? [];
    expect(changes).toContain('אזור זמן: Asia/Jerusalem ← Europe/London');
    expect(changes).toContain('ימי עבודה: א׳ ב׳ ג׳ ד׳ ה׳ ← ב׳ ג׳');
    expect(changes).toContain('שעות פעילות: 09:00–19:00 ← 09:00–18:00');
    expect(changes).toContain('סגנון הדיבור: חם ← רשמי');
    expect(changes).toContain('חתימה על הודעות: תודה, דנה ← אין');
    expect(changes).toContain('אימוג׳ים: במשורה ← אף פעם');
  });

  it('counterparties, by kind, and the business guidance', () => {
    const prev = previous();
    const a = completeAnswers();
    a.counterparties.known = [{ label: 'לקוח חדש', emailDomain: 'new.co.il' }];
    a.counterparties.doNotContact = [];
    a.business.notDone = [];
    a.business.keyFacts = [{ q: 'פתוח בשבת?', a: 'לא.' }];
    a.business.tradeName = 'שם חדש';
    const changes = summarizeCharter(build(a, prev), { previous: prev, documentsWanted: false }).changes ?? [];
    expect(changes).toContain('נוסף לצדדים המוכרים: לקוח חדש (new.co.il)');
    expect(changes.some((c) => c.startsWith('הוסר מהצדדים המוכרים: '))).toBe(true);
    expect(changes.some((c) => c.startsWith('הוסר מרשימת „אסור לפנות”: '))).toBe(true);
    expect(changes).toContain('הוסר ממה שהעסק לא עושה: צביעת שיער');
    expect(changes).toContain('עובדה חדשה: פתוח בשבת? לא.');
    expect(changes).toContain('השם המסחרי: דוגמה תספורות ← שם חדש');
  });
});

describe('summarizeCharter — authority shown, and zero ceilings', () => {
  it('names the principal and every known counterparty with its domain or phone', () => {
    const a = completeAnswers();
    const s = summarizeCharter(build(a), { previous: null, documentsWanted: false });
    expect(s.principal).toEqual({ displayName: 'דנה לוי', whatsapp: '+972541234567', email: 'dana@example.co.il' });
    expect(s.knownCounterparties).toEqual(
      a.counterparties.known.map((e) => ({ label: e.label, emailDomain: e.emailDomain ?? null, phone: e.phone ?? null })),
    );
    expect(s.knownCounterparties.length).toBeGreaterThan(0);
    expect(s.mailboxAdded).toBeNull();
  });

  it('an allowed money row under a 0 ceiling says every money action is blocked', () => {
    const a = completeAnswers();
    a.money = { singleMinor: 0, dailyMinor: 300_000, monthlyMinor: 2_000_000, maxDiscountPercent: 5 };
    expect(summarizeCharter(build(a), { previous: null, documentsWanted: false }).limits).toContain(
      ZERO_MONEY_CEILING_NOTE,
    );
    // Every money row "never": a zero ceiling is the point, not a trap.
    const none = completeAnswers();
    none.actions['quote.issue'] = 'never';
    expect(summarizeCharter(build(none), { previous: null, documentsWanted: false }).limits).not.toContain(
      ZERO_MONEY_CEILING_NOTE,
    );
  });

  it('an allowed discount row under 0% says every discount is blocked', () => {
    const a = completeAnswers();
    a.actions['discount.grant'] = 'approve';
    a.money.maxDiscountPercent = 0;
    const limits = summarizeCharter(build(a), { previous: null, documentsWanted: false }).limits;
    expect(limits).toContain(ZERO_DISCOUNT_CEILING_NOTE);
    expect(limits).not.toContain(ZERO_MONEY_CEILING_NOTE);
  });
});
