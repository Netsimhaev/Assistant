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
 * `auto_notify` deliberately does not promise a report. The level is enforced
 * exactly like `auto`, and the per-action update shadow mode added
 * (`orchestrator/action-updates.ts`, 27/10) is tied to a step running with no
 * card, not to this level — `auto` reports the same way. A label saying
 * "ומדווחת" would single out one of two levels the code does not tell apart.
 */
import type { ActionClass } from './action.js';
import type { DocumentCardState, DocumentFormat, DocumentKind, ProductionStage } from './document-spec.js';
import type { LedgerFamily, LedgerStatus } from './ledger.js';
import type { AutonomyLevel, TrustLevel } from './trust.js';

export const ACTION_CLASS_HE: Readonly<Record<ActionClass, string>> = Object.freeze({
  'email.reply': 'מענה במייל',
  'email.initiate': 'שליחת מייל יזום',
  'whatsapp.reply': 'מענה בוואטסאפ',
  'whatsapp.initiate': 'שליחת הודעת וואטסאפ יזומה',
  'calendar.create': 'קביעת פגישה',
  'calendar.move': 'הזזת פגישה',
  'calendar.update': 'עריכת פגישה',
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

export const ledgerFamilyLabel: Readonly<Record<LedgerFamily, string>> = Object.freeze({
  money_in: 'כסף נכנס',
  money_out: 'כסף יוצא',
  meetings: 'פגישות ושיחות',
  warm_leads: 'לקוחות חמים',
  awaiting_reply: 'ממתינים לצד שני',
  projects: 'עבודות פתוחות',
});

export const ledgerStatusLabel: Readonly<Record<LedgerStatus, string>> = Object.freeze({
  open: 'פתוח',
  stuck: 'תקוע',
  closed_by_evidence: 'נסגר לפי ראיה',
  done: 'בוצע',
  cancelled: 'בוטל',
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

export const documentKindLabel: Readonly<Record<DocumentKind, string>> = Object.freeze({
  contract: 'חוזה',
  protocol: 'פרוטוקול',
  price_list: 'מחירון',
  profit_table: 'טבלת רווחיות',
  report: 'דוח',
  letter: 'מכתב',
  presentation: 'מצגת',
  other: 'מסמך',
});

export const documentFormatLabel: Readonly<Record<DocumentFormat, string>> = Object.freeze({
  xlsx: 'אקסל',
  docx: 'וורד',
  pptx: 'מצגת',
  pdf: 'PDF',
});

export const productionStageLabel: Readonly<Record<ProductionStage, string>> = Object.freeze({
  queued: 'בתור',
  drafting: 'כותבת טיוטה',
  building: 'בונה את הקובץ',
  check1: 'בדיקה ראשונה',
  check2: 'בדיקה שנייה',
  fixing: 'מתקנת',
  ready: 'מוכן לאישור',
  failed_checks: 'נעצר בבדיקות',
  failed: 'נכשל',
});

/**
 * A document card's state, as the owner reads it on `/documents`. A new state
 * is a compile error here until it has Hebrew.
 */
export const documentCardStateLabel: Readonly<Record<DocumentCardState, string>> = Object.freeze({
  open: 'מחכה לבדיקתך',
  approved: 'אושר לשליחה',
  saved: 'אושר לשמירה',
  superseded: 'הוחלף בגרסה חדשה',
  failed_send: 'המסירה לא הושלמה',
});
