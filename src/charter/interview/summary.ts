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
import type {
  BusinessCharter,
  CharterCounterparty,
  UnsignedCharter,
  Weekday,
} from '../../domain/charter.js';
import { ACTION_CLASS_HE, AUTONOMY_LEVEL_HE } from '../../domain/labels.js';
import type { AutonomyMode } from '../../governance/autonomy-mode.js';
import { MAIL_PROVIDER_NAME, MAILBOX_SYSTEM, type MailProvider } from '../../mail/mailbox.js';
import { signedMailboxProvider } from '../amend-mailbox.js';
import { formatMinor } from '../../util/money.js';
import { INTERVIEW_NEVER_PREFIX, INTERVIEW_RULE_PREFIX, isInterviewCounterparty } from './build.js';
import { DEFAULTS_CHOSEN_HE, FIXED_FORBIDDEN } from './defaults.js';
import { INTERVIEW_ROWS, MONEY_ROWS, availabilityOf, cannotAtAll } from './rows.js';

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
export const ZERO_MONEY_CEILING_NOTE = 'סכום מקסימלי 0 — כל פעולה עם כסף תיחסם.';
export const ZERO_DISCOUNT_CEILING_NOTE = 'הנחה מקסימלית 0% — כל הנחה תיחסם.';
/** Shown only when `changes` is empty — and `changes` covers every field the interview asks. */
export const NO_CHANGES_NOTE = 'אין שינויים בכללים שנשאלו כאן.';

/** Owner-facing names, shared by the interview's step screens and the summary. */
export const REGISTER_HE: Readonly<Record<UnsignedCharter['voice']['register'], string>> = {
  formal: 'רשמי',
  professional: 'מקצועי',
  warm: 'חם',
  casual: 'קליל',
};
export const EMOJI_POLICY_HE: Readonly<Record<UnsignedCharter['voice']['emojiPolicy'], string>> = {
  never: 'אף פעם',
  sparingly: 'במשורה',
  match_counterparty: 'כמו הצד השני',
};
export const WEEKDAY_HE: Readonly<Record<Weekday, string>> = {
  sun: 'א׳',
  mon: 'ב׳',
  tue: 'ג׳',
  wed: 'ד׳',
  thu: 'ה׳',
  fri: 'ו׳',
  sat: 'ש׳',
};
/** The dial's positions in the interview's own words (step 9). */
export const AUTONOMY_MODE_INTERVIEW_HE: Readonly<Record<AutonomyMode, string>> = {
  off: 'כבוי',
  ask: 'שואלת תמיד',
  learn: 'לומדת',
};

export interface SummaryLine {
  actionClass: ActionClass;
  label: string;
  levelHe: string;
}

/** The principal as the charter names them — whose instructions the assistant takes. */
export interface SummaryPrincipal {
  displayName: string;
  whatsapp: string | null;
  email: string | null;
}

/** A counterparty the charter recognises (not a do-not-contact entry). */
export interface SummaryCounterparty {
  label: string;
  emailDomain: string | null;
  phone: string | null;
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
  /** Whose instructions the assistant takes — authority-bearing, so always shown. */
  principal: SummaryPrincipal | null;
  /** Counterparties the charter recognises; their domain/phone resolves recipients. */
  knownCounterparties: SummaryCounterparty[];
  /**
   * The provider of a mailbox this charter declares and the previous one did
   * not (`null` otherwise). Signing it authorises reading and labelling every
   * incoming mail, so the summary must carry the mailbox-signing text.
   */
  mailboxAdded: MailProvider | null;
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
  out.push(...zeroCeilingNotes(charter));
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

function counterpartyText(c: CharterCounterparty): string {
  const handles = [c.match.emailDomain, c.match.phone].filter((h): h is string => h !== undefined);
  return handles.length === 0 ? c.label : `${c.label} (${handles.join(', ')})`;
}

/** A money row the charter lets run at all: not draft-only/forbidden and not forbidden outright. */
function rowAllowed(charter: UnsignedCharter, cls: ActionClass): boolean {
  const base = charter.autonomy.base[cls];
  return base !== 'draft_only' && base !== 'forbidden' && !forbiddenOutright(charter, cls);
}

/**
 * A money row the owner allowed, under a ceiling of 0, is a row that can
 * never run: every amount above zero is over the single, daily or monthly
 * ceiling, and every discount over 0%. Said, so the summary does not read as
 * "allowed" for something the budget step will refuse every time.
 */
function zeroCeilingNotes(charter: UnsignedCharter): string[] {
  const { money } = charter;
  const out: string[] = [];
  const amountRows = [...MONEY_ROWS].filter((row) => row !== 'discount.grant' && rowAllowed(charter, row));
  const lowest = Math.min(money.singleActionCeilingMinor, money.dailyCeilingMinor, money.monthlyCeilingMinor);
  if (amountRows.length > 0 && lowest === 0) out.push(ZERO_MONEY_CEILING_NOTE);
  if (rowAllowed(charter, 'discount.grant') && money.maxDiscountPercent === 0) out.push(ZERO_DISCOUNT_CEILING_NOTE);
  return out;
}

function hasMailbox(charter: Pick<UnsignedCharter, 'connections'>): boolean {
  return charter.connections.some((c) => c.system === MAILBOX_SYSTEM);
}

/** The provider of a mailbox `charter` declares and `previous` does not; `null` otherwise. */
export function mailboxAddedBy(charter: UnsignedCharter, previous: BusinessCharter | null): MailProvider | null {
  if (previous !== null && hasMailbox(previous)) return null;
  const connection = charter.connections.find((c) => c.system === MAILBOX_SYSTEM);
  return connection === undefined ? null : signedMailboxProvider(connection);
}

const NONE_HE = 'אין';

function orNone(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? NONE_HE : value;
}

function quietOf(c: UnsignedCharter): string {
  const q = c.operations.quietHours;
  return q === undefined ? NONE_HE : `${q.from}–${q.to}`;
}

function workweekOf(c: UnsignedCharter): string {
  return c.operations.workweek.map((d) => WEEKDAY_HE[d]).join(' ');
}

function hoursOf(c: UnsignedCharter): string {
  const spans = [...new Set(c.operations.businessHours.map((h) => `${h.open}–${h.close}`))];
  return spans.length === 0 ? NONE_HE : spans.join(', ');
}

function principalOf(c: UnsignedCharter) {
  return c.people.find((p) => p.isPrincipal);
}

/** `label: before ← after`, when the two differ. */
function pushChange(out: string[], label: string, before: string, after: string): void {
  if (before !== after) out.push(`${label}: ${before} ← ${after}`);
}

/** One line per item added to, and per item removed from, a list. */
function pushListChange(
  out: string[],
  before: readonly string[],
  after: readonly string[],
  added: string,
  removed: string,
): void {
  const b = new Set(before);
  const a = new Set(after);
  for (const item of a) if (!b.has(item)) out.push(`${added}: ${item}`);
  for (const item of b) if (!a.has(item)) out.push(`${removed}: ${item}`);
}

/**
 * Every field the interview asks, diffed against the charter it edits, step
 * by step. The empty state ("no changes") is shown exactly when this list is
 * empty, so the list must cover the whole interview: a field left out here is
 * a change the owner signs while being told nothing changed. Fields the
 * interview does not ask are kept byte-for-byte by the build and listed under
 * `preserved` instead.
 */
function changesOf(charter: UnsignedCharter, previous: BusinessCharter): string[] {
  const out: string[] = [];

  // Step 1 — the business.
  const id = charter.identity;
  const idBefore = previous.identity;
  pushChange(out, 'השם המשפטי', idBefore.legalName, id.legalName);
  pushChange(out, 'השם המסחרי', idBefore.tradeName, id.tradeName);
  pushChange(out, 'תחום העסק', idBefore.vertical, id.vertical);
  if (idBefore.whatWeDo !== id.whatWeDo) out.push(`תיאור העסק השתנה: ${id.whatWeDo}`);
  pushListChange(out, idBefore.whatWeDoNotDo, id.whatWeDoNotDo, 'נוסף למה שהעסק לא עושה', 'הוסר ממה שהעסק לא עושה');
  pushListChange(
    out,
    idBefore.keyFacts.map((f) => `${f.q} ${f.a}`),
    id.keyFacts.map((f) => `${f.q} ${f.a}`),
    'עובדה חדשה',
    'עובדה שהוסרה',
  );

  // Step 2 — the principal.
  const p = principalOf(charter);
  const pBefore = principalOf(previous);
  pushChange(out, 'שם הבעלים', orNone(pBefore?.displayName), orNone(p?.displayName));
  pushChange(out, 'תפקיד הבעלים', orNone(pBefore?.role), orNone(p?.role));
  pushChange(out, 'הוואטסאפ של הבעלים', orNone(pBefore?.channels['whatsapp']), orNone(p?.channels['whatsapp']));
  pushChange(out, 'המייל של הבעלים', orNone(pBefore?.channels['email']), orNone(p?.channels['email']));

  // Step 3 — the voice.
  pushChange(out, 'סגנון הדיבור', REGISTER_HE[previous.voice.register], REGISTER_HE[charter.voice.register]);
  pushChange(out, 'חתימה על הודעות', orNone(previous.voice.signOff['he']), orNone(charter.voice.signOff['he']));
  pushChange(out, 'אימוג׳ים', EMOJI_POLICY_HE[previous.voice.emojiPolicy], EMOJI_POLICY_HE[charter.voice.emojiPolicy]);
  pushListChange(out, previous.voice.mustNeverSay, charter.voice.mustNeverSay, 'נוסף ל„לעולם לא לומר”', 'הוסר מ„לעולם לא לומר”');

  // Step 4 — hours.
  pushChange(out, 'ימי עבודה', workweekOf(previous), workweekOf(charter));
  pushChange(out, 'שעות פעילות', hoursOf(previous), hoursOf(charter));
  pushChange(out, 'שעות שקט', quietOf(previous), quietOf(charter));
  pushChange(out, 'אזור זמן', idBefore.timezone, id.timezone);

  // Step 5 — the mailbox, and any other connection added or removed.
  const added = mailboxAddedBy(charter, previous);
  if (added !== null) out.push(`נוספה תיבת המייל של העסק: ${MAIL_PROVIDER_NAME[added]}`);
  if (hasMailbox(previous) && !hasMailbox(charter)) out.push('הוסרה תיבת המייל של העסק');
  const others = (c: UnsignedCharter) => c.connections.map((k) => k.system).filter((s) => s !== MAILBOX_SYSTEM);
  pushListChange(out, others(previous), others(charter), 'חיבור שנוסף', 'חיבור שהוסר');

  // Step 6 — the action rows.
  for (const row of INTERVIEW_ROWS) {
    const before = previous.autonomy.base[row];
    const after = charter.autonomy.base[row];
    if (before !== after) {
      out.push(`${ACTION_CLASS_HE[row]}: ${AUTONOMY_LEVEL_HE[before]} ← ${AUTONOMY_LEVEL_HE[after]}`);
    }
  }

  // Step 7 — money.
  const m = charter.money;
  const mBefore = previous.money;
  const money = (minor: number, currency: string) => formatMinor(minor, currency);
  pushChange(out, 'סכום מקסימלי לפעולה אחת', money(mBefore.singleActionCeilingMinor, mBefore.currency), money(m.singleActionCeilingMinor, m.currency));
  pushChange(out, 'סכום מקסימלי ליום', money(mBefore.dailyCeilingMinor, mBefore.currency), money(m.dailyCeilingMinor, m.currency));
  pushChange(out, 'סכום מקסימלי לחודש', money(mBefore.monthlyCeilingMinor, mBefore.currency), money(m.monthlyCeilingMinor, m.currency));
  pushChange(out, 'הנחה מקסימלית', `${mBefore.maxDiscountPercent}%`, `${m.maxDiscountPercent}%`);

  // Step 8 (and step-10 do-not-contact entries) — counterparties, by what they are.
  const cpBefore = new Map(previous.counterparties.map((c) => [counterpartyKey(c), c]));
  const cpAfter = new Map(charter.counterparties.map((c) => [counterpartyKey(c), c]));
  for (const [k, c] of cpAfter) {
    if (cpBefore.has(k)) continue;
    out.push(`${c.doNotContact ? 'נוסף לרשימת „אסור לפנות”' : 'נוסף לצדדים המוכרים'}: ${counterpartyText(c)}`);
  }
  for (const [k, c] of cpBefore) {
    if (cpAfter.has(k)) continue;
    out.push(`${c.doNotContact ? 'הוסר מרשימת „אסור לפנות”' : 'הוסר מהצדדים המוכרים'}: ${counterpartyText(c)}`);
  }

  // Step 10 — rules. The interview's own "never" rules are already visible as a row change.
  const isOwn = (ruleId: string) => ruleId.startsWith(INTERVIEW_NEVER_PREFIX);
  const prevRules = new Map(previous.forbidden.filter((r) => !isOwn(r.id)).map((r) => [r.id, r]));
  const newRules = new Map(charter.forbidden.filter((r) => !isOwn(r.id)).map((r) => [r.id, r]));
  for (const [ruleId, r] of newRules) {
    const before = prevRules.get(ruleId);
    if (before === undefined) out.push(`כלל חדש: ${r.description}`);
    else if (before.description !== r.description || before.actionClasses.join() !== r.actionClasses.join()) {
      out.push(`כלל שהשתנה: ${before.description} ← ${r.description}`);
    }
  }
  for (const [ruleId, r] of prevRules) if (!newRules.has(ruleId)) out.push(`כלל שהוסר: ${r.description}`);
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

function principalSummary(charter: UnsignedCharter): SummaryPrincipal | null {
  const p = principalOf(charter);
  if (p === undefined) return null;
  return { displayName: p.displayName, whatsapp: p.channels['whatsapp'] ?? null, email: p.channels['email'] ?? null };
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
    principal: principalSummary(charter),
    knownCounterparties: charter.counterparties
      .filter((c) => !c.doNotContact)
      .map((c) => ({ label: c.label, emailDomain: c.match.emailDomain ?? null, phone: c.match.phone ?? null })),
    mailboxAdded: mailboxAddedBy(charter, previous),
  };
}
