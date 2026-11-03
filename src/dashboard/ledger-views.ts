/**
 * "הפנקס" — the ledger list and its settings screen. Pure rendering; the
 * handlers in `ledger-routes.ts` do the reading.
 *
 * Everything an item carries — description, counterparty, reference, stage
 * titles, an opened follow-up draft — can originate in a document or a mail a
 * stranger wrote, so each goes through `escLabel` (bidi controls stripped
 * before escaping). Times are shown in the charter's zone by `Intl`, money
 * through `formatMinor` in the charter's currency.
 */
import { NO_ACT_FAMILIES_SENTENCE, type CriticalRule } from '../ledger/settings.js';
import { ledgerFamilyLabel, ledgerStatusLabel } from '../domain/labels.js';
import { LedgerFamily, isLedgerOverdue, type Importance, type LedgerEvent, type LedgerEventKind, type LedgerItem } from '../domain/ledger.js';
import { formatMinor } from '../util/money.js';
import { escLabel, escapeHtml as esc, page } from './views.js';

export const LEDGER_FILTERS = ['open', 'overdue', 'stuck', 'evidence', 'critical', 'all'] as const;
export type LedgerFilter = (typeof LEDGER_FILTERS)[number];

const FILTER_LABEL: Readonly<Record<LedgerFilter, string>> = Object.freeze({
  open: 'פתוח',
  overdue: 'באיחור',
  stuck: 'תקוע',
  evidence: 'נסגר לפי ראיה',
  critical: 'קריטי',
  all: 'הכול',
});

const IMPORTANCE_LABEL: Readonly<Record<Importance, string>> = Object.freeze({
  normal: 'רגיל',
  critical: 'קריטי',
});

const EVENT_LABEL: Readonly<Record<LedgerEventKind, string>> = Object.freeze({
  created: 'נוצרה',
  updated: 'עודכנה',
  reminded: 'הוזכרה לך',
  nudged: 'נשלח נדנוד לצד השני',
  nudge_fallback: 'הנדנוד לא יצא — טיוטה הובאה אליך',
  closed_by_evidence: 'נסגרה לפי ראיה',
  reopened: 'נפתחה מחדש',
  done: 'סומנה כבוצעה',
  cancelled: 'בוטלה',
  snoozed: 'נדחתה',
  stuck: 'הועלתה כתקועה',
  held: 'התקיימה',
  not_held: 'לא התקיימה',
  stages_saved: 'השלבים נשמרו',
  address_confirmed: 'הכתובת אושרה',
  pace_alert: 'התרעת קצב',
});

const STYLE = `
  nav a { margin-inline-end: 0.6rem; }
  .item { border: 1px solid #8884; border-radius: 0.5rem; padding: 0.6rem 0.9rem; margin-bottom: 0.7rem; }
  .item.critical { border-color: #c0392b; }
  .badge { display: inline-block; font-size: 0.8em; padding: 0 0.4rem; border: 1px solid #8886; border-radius: 0.3rem; margin-inline-end: 0.3rem; }
  .badge.warn { color: #ef6c00; border-color: #ef6c00; }
  .badge.crit { color: #c0392b; border-color: #c0392b; }
  .actions button { margin-top: 0.4rem; padding: 0.2rem 0.6rem; }
  ul.events { margin: 0.3rem 0; padding-inline-start: 1.2rem; font-size: 0.85em; opacity: 0.8; }
  .draft { white-space: pre-wrap; word-break: break-word; background: #8881; padding: 0.5rem; border-radius: 0.4rem; }
  fieldset { margin-top: 0.8rem; }
  input[type="number"], input[type="text"], input[type="date"], select { padding: 0.3rem; }
`;

function logoutForm(csrf: string): string {
  return `<form method="post" action="/logout" style="display:inline">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <button type="submit">התנתקות</button>
</form>`;
}

function nav(): string {
  return `<nav><a href="/">לכרטיסי האישור</a><a href="/ledger">הפנקס</a><a href="/ledger/settings">הגדרות הפנקס</a><a href="/instruct">מה לעשות</a><a href="/autonomy">כמה חופש לתת</a></nav>`;
}

function fmtDateTime(d: Date, timeZone: string, dateOnly: boolean): string {
  const opts: Intl.DateTimeFormatOptions = dateOnly
    ? { timeZone, dateStyle: 'medium' }
    : { timeZone, dateStyle: 'medium', timeStyle: 'short' };
  return new Intl.DateTimeFormat('he-IL', opts).format(d);
}

// ------------------------------------------------------------------ list

export interface LedgerRowView {
  item: LedgerItem;
  /** The last events, oldest first. */
  events: LedgerEvent[];
  /** Where the item's follow-up stands; `null` when it never had one. */
  followup: LedgerFollowup | null;
}

/**
 * The follow-up line (spec F-I3), decided from the nudge's own record — never
 * from owner-delivery columns: in flight (a nudge job linked), sent (the
 * latest `nudged` event is newer than any fallback), or a draft that did not
 * go out (the latest `nudge_fallback`'s reminder, with its draft).
 */
export type LedgerFollowup =
  | { kind: 'pending' }
  | { kind: 'sent'; at: Date }
  | { kind: 'unsent'; draft: string };

export interface LedgerListInput {
  rows: LedgerRowView[];
  filter: LedgerFilter;
  csrf: string;
  timeZone: string;
  currency: string;
  now: Date;
  error?: string | undefined;
}



function actionButtons(item: LedgerItem): string {
  const live = item.status === 'open' || item.status === 'stuck';
  const buttons: string[] = [];
  const b = (action: string, label: string): void => {
    buttons.push(`<button type="submit" name="action" value="${action}">${esc(label)}</button>`);
  };
  if (live) {
    b('done', 'בוצע');
    b('cancel', 'בטלי');
    if (item.importance !== 'critical') b('critical', 'סמני כקריטי');
    if (item.family === 'meetings') {
      b('held', 'התקיימה');
      if (item.status === 'open') b('not_held', 'לא התקיימה');
    }
    if (item.proposedStages !== null) b('save_stages', 'שמרי את השלבים המוצעים');
    if (item.counterpartyEmail !== null && !item.counterpartyEmailVerified) b('confirm_address', 'אשרי כתובת');
    buttons.push(
      `<input type="date" name="date" aria-label="דחייה ליום"><button type="submit" name="action" value="snooze">דחי ליום</button>`,
    );
  } else {
    b('reopen', 'פתחי מחדש');
  }
  return buttons.join(' ');
}

function renderItem(row: LedgerRowView, input: LedgerListInput): string {
  const { item } = row;
  const critical = item.importance === 'critical';
  const overdue = isLedgerOverdue(item, input.now, input.timeZone);
  const badges: string[] = [`<span class="badge">${esc(ledgerStatusLabel[item.status])}</span>`];
  badges.push(`<span class="badge${critical ? ' crit' : ''}">${esc(IMPORTANCE_LABEL[item.importance])}</span>`);
  if (overdue) badges.push(`<span class="badge warn">באיחור</span>`);
  if (item.counterpartyEmail !== null && !item.counterpartyEmailVerified) {
    badges.push(`<span class="badge warn">כתובת לא מאומתת</span>`);
  }

  const lines: string[] = [];
  if (item.counterpartyName !== null) lines.push(`צד שני: ${escLabel(item.counterpartyName)}`);
  if (item.counterpartyEmail !== null) lines.push(`כתובת: ${escLabel(item.counterpartyEmail)}`);
  if (item.dueAt !== null) lines.push(`מועד: ${esc(fmtDateTime(item.dueAt, input.timeZone, item.dueIsDateOnly))}`);
  if (item.reference !== null) lines.push(`אסמכתא: ${escLabel(item.reference)}`);
  if (item.amountMinor !== null) lines.push(`סכום: ${esc(formatMinor(item.amountMinor, input.currency))}`);

  const stages =
    item.stages.length === 0
      ? ''
      : `<ul>${item.stages.map((s) => `<li>${s.done ? '☑' : '☐'} ${escLabel(s.title)}</li>`).join('')}</ul>`;
  const proposed =
    item.proposedStages === null
      ? ''
      : `<p class="muted">שלבים מוצעים (טרם נשמרו):</p><ul>${item.proposedStages
          .map((s) => `<li>${escLabel(s.title)}</li>`)
          .join('')}</ul>`;
  let draft = '';
  if (row.followup?.kind === 'pending') draft = `<p class="muted">פולואפ ממתין לאישורך</p>`;
  if (row.followup?.kind === 'sent') {
    draft = `<p class="muted">נשלח פולואפ — ${esc(fmtDateTime(row.followup.at, input.timeZone, false))}</p>`;
  }
  if (row.followup?.kind === 'unsent') {
    draft = `<p class="muted">טיוטת פולואפ — לא יצאה לצד השני:</p><div class="draft">${escLabel(row.followup.draft)}</div>`;
  }
  const events =
    row.events.length === 0
      ? ''
      : `<ul class="events">${row.events
          .map((e) => {
            const note = e.note !== null && e.note !== '' ? ` — ${escLabel(e.note)}` : '';
            return `<li>${esc(fmtDateTime(e.at, input.timeZone, false))}: ${esc(EVENT_LABEL[e.kind])}${note}</li>`;
          })
          .join('')}</ul>`;

  return `<div class="item${critical ? ' critical' : ''}">
  <div>${badges.join('')}<strong>${escLabel(item.description)}</strong></div>
  <div class="muted">${lines.join(' · ')}</div>
  ${stages}${proposed}${draft}${events}
  <form method="post" action="/ledger/${encodeURIComponent(item.itemId)}/action" class="actions">
    <input type="hidden" name="csrf" value="${esc(input.csrf)}">
    ${actionButtons(item)}
  </form>
</div>`;
}

export function renderLedger(input: LedgerListInput): string {
  const stuckList = input.rows.filter((r) => r.item.status === 'stuck' || isLedgerOverdue(r.item, input.now, input.timeZone));
  const stuckIds = new Set(stuckList.map((r) => r.item.itemId));
  const rest = input.rows.filter((r) => !stuckIds.has(r.item.itemId));

  const filters = LEDGER_FILTERS.map((f) =>
    f === input.filter
      ? `<strong>${esc(FILTER_LABEL[f])}</strong>`
      : `<a href="/ledger?filter=${f}">${esc(FILTER_LABEL[f])}</a>`,
  ).join(' · ');

  const stuckSection = `<section>
  <h2>רשימת התקוע</h2>
  ${stuckList.length === 0 ? '<p class="muted">אין כרגע שורות תקועות או באיחור.</p>' : stuckList.map((r) => renderItem(r, input)).join('\n')}
</section>`;

  const families = LedgerFamily.options
    .map((family) => {
      const inFamily = rest.filter((r) => r.item.family === family);
      if (inFamily.length === 0) return '';
      return `<section>
  <h2>${esc(ledgerFamilyLabel[family])}</h2>
  ${inFamily.map((r) => renderItem(r, input)).join('\n')}
</section>`;
    })
    .join('\n');

  const body = `<header>
  <h1>הפנקס</h1>
  ${logoutForm(input.csrf)}
</header>
${nav()}
${input.error !== undefined ? `<p class="error" role="alert">${esc(input.error)}</p>` : ''}
<p>${filters}</p>
${stuckSection}
${families}
${input.rows.length === 0 ? '<p class="muted">אין שורות להצגה בסינון הזה.</p>' : ''}
<style>${STYLE}</style>`;
  return page('הפנקס', body);
}

// -------------------------------------------------------------- settings

/** What the settings form holds: strings for numbers so a refused value is shown back as typed. */
export interface LedgerSettingsFormValues {
  modes: Record<LedgerFamily, string>;
  toWhatsApp: boolean;
  toEmail: boolean;
  toScreen: boolean;
  meetingLeadMinutes: string;
  meetingLeadMinutesCritical: string;
  dueLeadDaysCritical: string;
  nudgeAfterBusinessDays: string;
  checkinEveryDays: string;
  checkinEveryDaysCritical: string;
  dailyHour: string;
}

export interface LedgerSettingsInput {
  values: LedgerSettingsFormValues;
  rules: CriticalRule[];
  csrf: string;
  currency: string;
  error?: string | undefined;
}

export const MONEY_OUT_LOCK_SENTENCE = 'רק תזכורת — אין עדיין כלי תשלום';

/** Remind-only families other than money_out, and why (M3). */
const LOCK_SENTENCE: Partial<Record<LedgerFamily, string>> = {
  money_out: MONEY_OUT_LOCK_SENTENCE,
  meetings: NO_ACT_FAMILIES_SENTENCE,
  projects: NO_ACT_FAMILIES_SENTENCE,
};

function modeRow(family: LedgerFamily, current: string): string {
  const lockSentence = LOCK_SENTENCE[family];
  const locked = lockSentence !== undefined;
  const radio = (value: 'remind' | 'act', label: string): string => {
    const checked = locked ? value === 'remind' : current === value;
    return `<label style="display:inline-block;margin-inline-end:1rem"><input type="radio" name="mode_${family}" value="${value}"${checked ? ' checked' : ''}${locked ? ' disabled' : ''}> ${esc(label)}</label>`;
  };
  return `<div class="card"><strong>${esc(ledgerFamilyLabel[family])}</strong><br>
  ${radio('remind', 'רק תזכורת')}${lockSentence !== undefined ? `<span class="muted">${esc(lockSentence)}</span>` : radio('act', 'תוצאה')}
</div>`;
}

function numberField(name: string, label: string, value: string, hint = ''): string {
  return `<label>${esc(label)}<br><input type="number" name="${name}" value="${esc(value)}" inputmode="numeric">${hint === '' ? '' : ` <span class="muted">${esc(hint)}</span>`}</label>`;
}

/** Escaped label of one rule; the counterparty text is stranger-derived, so it takes the bidi strip. */
function ruleLabelHtml(rule: CriticalRule, currency: string): string {
  if (rule.kind === 'family') return esc(`כל שורה מסוג "${ledgerFamilyLabel[rule.family]}"`);
  if (rule.kind === 'amount_over') return esc(`סכום מעל ${formatMinor(rule.amountMinor, currency)}`);
  return `צד שני: ${escLabel(rule.match)}`;
}

export function renderLedgerSettings(input: LedgerSettingsInput): string {
  const v = input.values;
  const rules =
    input.rules.length === 0
      ? '<p class="muted">עדיין אין כללים. שורה שתסמן ידנית כקריטית תמיד תיחשב קריטית.</p>'
      : `<ul>${input.rules
          .map(
            (r) => `<li>${ruleLabelHtml(r, input.currency)}
  <form method="post" action="/ledger/rules/${encodeURIComponent(r.ruleId)}/delete" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(input.csrf)}"><button type="submit">הסר</button>
  </form></li>`,
          )
          .join('')}</ul>`;

  const body = `<header>
  <h1>הפנקס — הגדרות</h1>
  ${logoutForm(input.csrf)}
</header>
${nav()}
${input.error !== undefined ? `<p class="error" role="alert">${esc(input.error)}</p>` : ''}
<p class="muted">ההגדרות כאן קובעות מתי ואיפה העוזרת מזכירה ומה היא מנסה לעשות — הן אינן נותנות לה סמכות. מצב "תוצאה" עובר תמיד דרך "רמת החופש" והתקנון החתום: כשרמת החופש על "כבוי", במקום שהעוזרת תשלח משהו לצד השני היא מכינה טיוטה ומביאה אותה אליך.</p>
<form method="post" action="/ledger/settings">
  <input type="hidden" name="csrf" value="${esc(input.csrf)}">
  <h2>מה לעשות לכל סוג שורה</h2>
  ${LedgerFamily.options.map((f) => modeRow(f, v.modes[f])).join('\n')}
  <h2>איפה להזכיר לך</h2>
  <p class="muted">חובה לבחור לפחות דרך אחת.</p>
  <label><input type="checkbox" name="toWhatsApp"${v.toWhatsApp ? ' checked' : ''}> וואטסאפ</label>
  <label><input type="checkbox" name="toEmail"${v.toEmail ? ' checked' : ''}> מייל</label>
  <label><input type="checkbox" name="toScreen"${v.toScreen ? ' checked' : ''}> מסך</label>
  <h2>מועדים</h2>
  ${numberField('meetingLeadMinutes', 'תזכורת לפגישה — כמה דקות לפני', v.meetingLeadMinutes)}
  <label>תזכורות לפגישה קריטית — דקות לפני, מופרדות בפסיק<br><input type="text" name="meetingLeadMinutesCritical" value="${esc(v.meetingLeadMinutesCritical)}"></label>
  ${numberField('dueLeadDaysCritical', 'תזכורת קריטית למועד — כמה ימים לפני', v.dueLeadDaysCritical)}
  ${numberField('nudgeAfterBusinessDays', 'כמה ימי עבודה לחכות לתשובה לפני נדנוד', v.nudgeAfterBusinessDays)}
  ${numberField('checkinEveryDays', 'בדיקת מצב לפרויקט — כל כמה ימים', v.checkinEveryDays)}
  ${numberField('checkinEveryDaysCritical', 'בדיקת מצב לפרויקט קריטי — כל כמה ימים', v.checkinEveryDaysCritical)}
  ${numberField('dailyHour', 'שעת התזכורות היומיות', v.dailyHour, '0 עד 23, באזור הזמן של התקנון')}
  <div><button type="submit">שמירה</button></div>
</form>
<h2>מה נחשב קריטי</h2>
${rules}
<form method="post" action="/ledger/rules" class="card">
  <input type="hidden" name="csrf" value="${esc(input.csrf)}">
  <input type="hidden" name="kind" value="family">
  <label>כל שורה מסוג
    <select name="family">${LedgerFamily.options.map((f) => `<option value="${f}">${esc(ledgerFamilyLabel[f])}</option>`).join('')}</select>
  </label>
  <button type="submit">הוסף כלל</button>
</form>
<form method="post" action="/ledger/rules" class="card">
  <input type="hidden" name="csrf" value="${esc(input.csrf)}">
  <input type="hidden" name="kind" value="amount_over">
  <label>סכום מעל (ביחידות שלמות, עד שתי ספרות אחרי הנקודה)
    <input type="text" name="amount" inputmode="decimal" placeholder="1500.50">
  </label>
  <button type="submit">הוסף כלל</button>
</form>
<form method="post" action="/ledger/rules" class="card">
  <input type="hidden" name="csrf" value="${esc(input.csrf)}">
  <input type="hidden" name="kind" value="counterparty">
  <label>צד שני — שם, כתובת או דומיין
    <input type="text" name="match">
  </label>
  <button type="submit">הוסף כלל</button>
</form>
<style>${STYLE}</style>`;
  return page('הפנקס — הגדרות', body);
}
