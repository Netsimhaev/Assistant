/**
 * The "what I can / can't do" summary the owner reads before signing.
 *
 * It is derived from the UNSIGNED CHARTER, never from the interview answers
 * (spec §6.3): what the owner reads must be what they sign, and a summary
 * built from the answers could say "I reply alone" while the charter carries
 * a ceiling or a rule that says otherwise. Levels come from
 * `charter.autonomy.base`, availability from `availabilityOf` against the
 * charter's own connections. Pure: no DB, no model.
 */
import type { ActionClass } from '../../domain/action.js';
import type { BusinessCharter, CharterCounterparty, UnsignedCharter } from '../../domain/charter.js';
import { ACTION_CLASS_HE, AUTONOMY_LEVEL_HE } from '../../domain/labels.js';
import { MAILBOX_SYSTEM } from '../../mail/mailbox.js';
import { formatMinor } from '../../util/money.js';
import { INTERVIEW_NEVER_PREFIX, INTERVIEW_RULE_PREFIX, isInterviewCounterparty } from './build.js';
import { DEFAULTS_CHOSEN_HE, FIXED_FORBIDDEN } from './defaults.js';
import { INTERVIEW_ROWS, availabilityOf, cannotAtAll } from './rows.js';

export const CEILING_NOTE =
  'הטבלה קובעת את המקסימום. כמה מזה אני משתמשת בפועל תבחר בשלב 9 — ואפשר להעלות ולהוריד בכל רגע.';
export const REPLY_ALONE_NOTE = "זה המקסימום; בפועל אני עונה לבד רק אם תבחר 'לומדת' ואוכיח את עצמי.";
export const BOSS_COMMAND_NOTE =
  'הוראה שאתה נותן לי בעצמך ומאשר בשאלה שאני מציגה — מתבצעת גם אם היא סותרת את הכללים כאן, כולל שעות שקט ואנשים שאסור לפנות אליהם. רק מתג העצירה עוצר אותה.';
export const AUTHORITY_NOTE = 'בלחיצה אתה מצהיר שאתה מוסמך לחייב את העסק בכללים האלה. החתימה על אחריותך.';
export const ONLY_YOU_APPROVE_NOTE = 'היום רק אתה מאשר את הפעולות שלי — בדשבורד ובוואטסאפ שלך.';
export const WHATSAPP_NOTE = 'בוואטסאפ אני מדברת רק איתך. הודעות מלקוחות בוואטסאפ אינן חלק ממה שאני עושה היום.';
export const DOCUMENTS_NOTE = 'את זה מפעיל מי שמתקין את המערכת.';
export const NEVER_ALONE_NOTE = 'לעולם לא לבד — זה גבול של המערכת, לא שלך.';
export const GUIDANCE_TAG = 'הנחיה — לא חסימה';

export interface SummaryLine {
  actionClass: ActionClass;
  label: string;
  levelHe: string;
}

export interface CharterSummary {
  can: SummaryLine[];
  notYetWorking: SummaryLine[];
  cannot: SummaryLine[];
  /** Hebrew labels of the classes no agent can ever perform. */
  cannotAtAll: string[];
  limits: string[];
  guidance: string[];
  /** First-charter defaults; empty on an edit (see `summarizeCharter`). */
  defaultsChosen: string[];
  /** Categories kept from the previous charter that the interview did not ask. */
  preserved: string[];
  /** What changed against the previous charter; null on a first install. */
  changes: string[] | null;
}

export interface SummaryContext {
  previous: BusinessCharter | null;
  documentsWanted: boolean;
}

const FIXED_FORBIDDEN_IDS: ReadonlySet<string> = new Set(FIXED_FORBIDDEN.map((r) => r.id));

/** A rule with no counterparty narrowing forbids its classes outright. */
function forbiddenOutright(charter: UnsignedCharter, cls: ActionClass): boolean {
  return charter.forbidden.some(
    (r) => r.whenCounterpartyTag === undefined && r.actionClasses.includes(cls),
  );
}

function limitsOf(charter: UnsignedCharter, documentsWanted: boolean): string[] {
  const out: string[] = [];
  const { money, operations } = charter;
  const cur = money.currency;
  if (money.singleActionCeilingMinor > 0) {
    out.push(`סכום מקסימלי לפעולה אחת: ${formatMinor(money.singleActionCeilingMinor, cur)}.`);
  }
  if (money.dailyCeilingMinor > 0) out.push(`סכום מקסימלי ליום: ${formatMinor(money.dailyCeilingMinor, cur)}.`);
  if (money.monthlyCeilingMinor > 0) {
    out.push(`סכום מקסימלי לחודש: ${formatMinor(money.monthlyCeilingMinor, cur)}.`);
  }
  if (money.maxDiscountPercent > 0) out.push(`הנחה מקסימלית: ${money.maxDiscountPercent}%.`);
  if (operations.quietHours !== undefined) {
    out.push(`שעות שקט: ${operations.quietHours.from}–${operations.quietHours.to}.`);
  }
  for (const cp of charter.counterparties) {
    if (cp.doNotContact) out.push(`לא לפנות ל: ${cp.label}.`);
  }
  for (const phrase of charter.voice.mustNeverSay) out.push(`לעולם לא לומר: ${phrase}`);
  if (documentsWanted) out.push(`קריאת מסמכים: ${DOCUMENTS_NOTE}`);
  return out;
}

function counterpartyKey(cp: CharterCounterparty): string {
  return `${cp.label}|${cp.match.emailDomain ?? ''}|${cp.match.phone ?? ''}|${cp.doNotContact ? 'x' : 'k'}`;
}

function changesOf(charter: UnsignedCharter, previous: BusinessCharter): string[] {
  const out: string[] = [];
  for (const row of INTERVIEW_ROWS) {
    const before = previous.autonomy.base[row];
    const after = charter.autonomy.base[row];
    if (before !== after) {
      out.push(`${ACTION_CLASS_HE[row]}: ${AUTONOMY_LEVEL_HE[before]} ← ${AUTONOMY_LEVEL_HE[after]}`);
    }
  }
  const before = new Map(previous.counterparties.map((c) => [counterpartyKey(c), c]));
  const after = new Map(charter.counterparties.map((c) => [counterpartyKey(c), c]));
  for (const [k, c] of after) if (!before.has(k)) out.push(`נוסף: ${c.label}`);
  for (const [k, c] of before) if (!after.has(k)) out.push(`הוסר: ${c.label}`);
  // The interview's own "never" rules are already visible as a row change.
  const isOwn = (id: string) => id.startsWith(INTERVIEW_NEVER_PREFIX);
  const prevRules = new Map(previous.forbidden.filter((r) => !isOwn(r.id)).map((r) => [r.id, r]));
  const newRules = new Map(charter.forbidden.filter((r) => !isOwn(r.id)).map((r) => [r.id, r]));
  for (const [id, r] of newRules) if (!prevRules.has(id)) out.push(`כלל חדש: ${r.description}`);
  for (const [id, r] of prevRules) if (!newRules.has(id)) out.push(`כלל שהוסר: ${r.description}`);
  return out;
}

function preservedOf(previous: BusinessCharter): string[] {
  const out: string[] = [];
  if (previous.money.approvedSuppliers.length > 0) out.push('ספקים מאושרים');
  if (previous.money.paymentInstruments.length > 0) out.push('אמצעי תשלום');
  if (previous.connections.some((c) => c.system !== MAILBOX_SYSTEM)) out.push('חיבורים נוספים למערכות');
  if (previous.people.some((p) => !p.isPrincipal)) out.push('אנשים נוספים והרשאותיהם');
  if (previous.counterparties.some((c) => !isInterviewCounterparty(c))) {
    out.push('צדדים נוספים עם הגדרות מיוחדות');
  }
  for (const r of previous.forbidden) {
    if (r.id.startsWith(INTERVIEW_RULE_PREFIX) || FIXED_FORBIDDEN_IDS.has(r.id)) continue;
    out.push(`כלל איסור שנשמר: ${r.description}`);
  }
  if (Object.keys(previous.money.perActionClassCeilingMinor).length > 0) {
    out.push('תקרות כספיות לפי סוג פעולה');
  }
  if (previous.operations.holidays.length > 0) out.push('חגים וימים מיוחדים');
  if (previous.voice.mustSay.length > 0) out.push('משפטים שחובה לומר');
  return out;
}

/**
 * `defaultsChosen` is empty on an edit: `DEFAULTS_CHOSEN_HE` states the
 * values of a FIRST charter, and an edit keeps what the owner already signed
 * for those very fields — claiming the defaults would misdescribe it. What an
 * edit keeps is listed in `preserved` instead. The documents note rides in
 * `limits` when the owner wanted documents read.
 */
export function summarizeCharter(charter: UnsignedCharter, ctx: SummaryContext): CharterSummary {
  const can: SummaryLine[] = [];
  const notYetWorking: SummaryLine[] = [];
  const cannot: SummaryLine[] = [];

  for (const cls of INTERVIEW_ROWS) {
    const base = charter.autonomy.base[cls];
    const levelHe = AUTONOMY_LEVEL_HE[base];
    const label = ACTION_CLASS_HE[cls];
    if (forbiddenOutright(charter, cls) || base === 'draft_only' || base === 'forbidden') {
      cannot.push({ actionClass: cls, label, levelHe });
      continue;
    }
    const availability = availabilityOf(cls, charter.connections);
    if (availability === 'works') can.push({ actionClass: cls, label, levelHe });
    else {
      const note = availability === 'not_connected' ? 'לא מחובר' : 'עוד לא זמין';
      notYetWorking.push({ actionClass: cls, label: `${label} (${note})`, levelHe });
    }
  }

  for (const rule of charter.forbidden) {
    if (!FIXED_FORBIDDEN_IDS.has(rule.id)) continue;
    const actionClass = rule.actionClasses[0];
    if (actionClass === undefined) continue;
    cannot.push({ actionClass, label: rule.description, levelHe: AUTONOMY_LEVEL_HE.forbidden });
  }

  const { previous } = ctx;
  return {
    can,
    notYetWorking,
    cannot,
    cannotAtAll: cannotAtAll().map((c) => ACTION_CLASS_HE[c]),
    limits: limitsOf(charter, ctx.documentsWanted),
    guidance: [
      charter.identity.whatWeDo,
      ...charter.identity.whatWeDoNotDo,
      ...charter.identity.keyFacts.map((f) => `${f.q} ${f.a}`),
    ],
    defaultsChosen: previous === null ? [...DEFAULTS_CHOSEN_HE] : [],
    preserved: previous === null ? [] : preservedOf(previous),
    changes: previous === null ? null : changesOf(charter, previous),
  };
}
