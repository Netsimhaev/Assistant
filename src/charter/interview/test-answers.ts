import type { InterviewAnswers } from './answers.js';
import { ROW_DEFAULTS } from './rows.js';

/** A complete, valid set of interview answers shared by the build and summary tests. */
export function completeAnswers(): InterviewAnswers {
  return {
    business: {
      description: 'מספרה לגברים בחולון.',
      legalName: 'דוגמה תספורות בע"מ',
      tradeName: 'דוגמה תספורות',
      vertical: 'מספרה',
      employees: 3,
      expectations: 'לקבוע תורים ולענות ללקוחות.',
      notDone: ['צביעת שיער'],
      keyFacts: [{ q: 'יש חניה?', a: 'כן, ברחוב.' }],
    },
    principal: {
      displayName: 'דנה לוי',
      role: 'בעלים',
      whatsapp: '+972541234567',
      email: 'dana@example.co.il',
    },
    voice: {
      register: 'warm',
      signOff: 'תודה, דנה',
      emojiPolicy: 'sparingly',
      mustNeverSay: ['מובטח'],
    },
    hours: {
      workweek: ['sun', 'mon', 'tue', 'wed', 'thu'],
      open: '09:00',
      close: '19:00',
      quietHours: { from: '21:00', to: '08:00' },
      timezone: 'Asia/Jerusalem',
    },
    reading: { mailbox: 'none', documents: false },
    // Every row stated, so the round trip compares like with like; the money
    // row is opened so the money section is not zeroed.
    actions: { ...ROW_DEFAULTS, 'quote.issue': 'approve', 'calendar.create': 'alone' },
    money: { singleMinor: 100_000, dailyMinor: 300_000, monthlyMinor: 2_000_000, maxDiscountPercent: 5 },
    counterparties: {
      known: [{ label: 'ספק מוצרים', emailDomain: 'supplier.co.il' }],
      doNotContact: [{ label: 'מתחרה', phone: '+972501112233' }],
    },
    autonomy: { mode: 'off' },
    extra: {
      accepted: [{ kind: 'forbid', text: 'לעולם לא לפרסם מחירים.', actionClasses: ['media.publish'] }],
      pending: [],
    },
  };
}
