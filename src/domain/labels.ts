/**
 * What the owner reads for an action class, an autonomy level and a trust
 * level — the one place those words are chosen.
 *
 * The identifiers stay English everywhere in code, the database and the audit
 * trail; this module is only the last step before a human reads one. Each
 * record is typed exhaustive (`Record<Enum, string>`), so a member added to the
 * enum is a compile error here until someone writes its Hebrew — the same
 * forcing `CURRENT_SCHEMA_VERSION` relies on for the charter.
 *
 * `auto_notify` deliberately does not promise a report. CLAUDE.md records that
 * the "notify" half was never built and the level is enforced exactly like
 * `auto`; a label saying "ומדווחת" would tell the owner something the code
 * does not do.
 */
import type { ActionClass } from './action.js';
import type { AutonomyLevel, TrustLevel } from './trust.js';

export const ACTION_CLASS_HE: Readonly<Record<ActionClass, string>> = Object.freeze({
  'email.reply': 'מענה במייל',
  'email.initiate': 'שליחת מייל יזום',
  'whatsapp.reply': 'מענה בוואטסאפ',
  'whatsapp.initiate': 'שליחת הודעת וואטסאפ יזומה',
  'calendar.create': 'קביעת פגישה',
  'calendar.move': 'הזזת פגישה',
  'calendar.cancel': 'ביטול פגישה',
  'quote.issue': 'הוצאת הצעת מחיר',
  'discount.grant': 'מתן הנחה',
  'commitment.make': 'התחייבות בשם העסק',
  'purchase.place': 'ביצוע רכישה',
  'payment.make': 'ביצוע תשלום',
  'refund.issue': 'מתן החזר כספי',
  'crm.write': 'עדכון רשומת לקוח',
  'accounting.write': 'רישום בהנהלת החשבונות',
  'artifact.write': 'יצירת קובץ',
  'doc.deliver': 'מסירת מסמך',
  'media.publish': 'פרסום תוכן',
  'browser.interact': 'פעולה באתר אינטרנט',
  'browser.session': 'כניסה לחשבון באתר',
  'contract.sign': 'חתימה על חוזה',
  'data.export': 'ייצוא נתונים',
  'memory.write_longterm': 'רישום בזיכרון',
  'charter.amend': 'שינוי התקנון',
  'agent.delegate': 'בקשת עזרה מסוכן אחר',
});

export const AUTONOMY_LEVEL_HE: Readonly<Record<AutonomyLevel, string>> = Object.freeze({
  forbidden: 'אסור',
  draft_only: 'טיוטה בלבד',
  approve_required: 'פועלת אחרי אישור',
  auto_notify: 'פועלת בלי לשאול',
  auto: 'פועלת בלי לשאול, בלי הגבלה',
});

export const TRUST_LEVEL_HE: Readonly<Record<TrustLevel, string>> = Object.freeze({
  boss: 'בעל העסק',
  staff: 'צוות העסק',
  known_counterparty: 'גורם מוכר',
  unknown_external: 'גורם חיצוני לא מוכר',
  open_web: 'אתר אינטרנט פתוח',
});

/**
 * Values read back from the database are plain strings, not the enum. A known
 * one is translated; anything else is returned as it is, because hiding an
 * unfamiliar stored word tells the owner less than showing it. `Object.hasOwn`,
 * not `in` or a bare index: `constructor` would otherwise resolve to a
 * function on the prototype and be treated as a label.
 */
function lookup(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] ?? value) : value;
}

export function actionClassLabel(value: string): string {
  return lookup(ACTION_CLASS_HE, value);
}

export function autonomyLevelLabel(value: string): string {
  return lookup(AUTONOMY_LEVEL_HE, value);
}

export function trustLevelLabel(value: string): string {
  return lookup(TRUST_LEVEL_HE, value);
}
