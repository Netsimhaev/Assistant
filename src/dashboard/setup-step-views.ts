/**
 * The ten step bodies of the setup interview (spec §5). Each renders from a
 * `value` — the saved section, or on a failed POST the candidate the owner
 * just typed — so a re-render after an error shows exactly what was typed,
 * with the issue next to the field it is about.
 *
 * Every typed value goes through `escLabel`. Fixed copy goes through `esc`.
 */
import type { AcceptedRule, InterviewAnswersDraft } from '../charter/interview/answers.js';
import { describeRule } from '../charter/interview/rule-proposal.js';
import {
  ALONE_ALLOWED,
  INTERVIEW_ROWS,
  ROW_DEFAULTS,
  ROW_EXAMPLES,
  availabilityOf,
  type Availability,
} from '../charter/interview/rows.js';
import {
  CEILING_NOTE,
  DOCUMENTS_NOTE,
  GUIDANCE_TAG,
  NEVER_ALONE_NOTE,
  ONLY_YOU_APPROVE_NOTE,
  REPLY_ALONE_NOTE,
  WHATSAPP_NOTE,
} from '../charter/interview/summary.js';
import type { CharterConnection } from '../domain/connection.js';
import { Weekday } from '../domain/charter.js';
import { ACTION_CLASS_HE } from '../domain/labels.js';
import type { MailProvider } from '../mail/mailbox.js';
import {
  BLANK_ROWS,
  FOLLOW_UPS,
  FOLLOW_UP_UNDER_WORDS,
  minorToShekels,
  moneyUntouched,
  wordCount,
  type SetupIssue,
} from './setup-forms.js';
import { STEP_TAGS, STEP_TITLES, STEP_WHY, issuesAt, issuesBox, setupPage } from './setup-views.js';
import { canonicalHash } from '../util/canonical.js';
import { escLabel, escapeHtml as esc } from './views.js';

/** Maximum length of one stage-10 sentence; `AcceptedRule.text` is capped at the same. */
export const RULE_TEXT_MAX = 500;

export interface StepView {
  step: number;
  draft: InterviewAnswersDraft | null;
  /** The saved section, or the candidate of a failed POST; `null` when unsaved. */
  value: unknown;
  issues: readonly SetupIssue[];
  csrf: string;
  /** A notice above the step (the unreadable-charter door). */
  notice?: string;
  /** Step 1: the owner was sent back once to expand a short answer. */
  followUp?: boolean;
  /** Step 5: the provider the base charter already signed; shown read-only. */
  pinnedMailbox?: MailProvider | null;
  /** Step 6: the connections the charter would declare, for the availability label. */
  connections?: readonly CharterConnection[];
  /** Step 10: text to prefill (a "fix"), and an error on the proposal form. */
  ruleText?: string;
  ruleError?: string;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str) : [];
}

function field(label: string, name: string, value: string, issues: readonly SetupIssue[], type = 'text'): string {
  return `<label>${esc(label)}
  <input type="${type}" name="${esc(name)}" value="${escLabel(value)}">
</label>${issuesAt(issues, [name])}`;
}

function area(label: string, name: string, value: string, issues: readonly SetupIssue[], hint = ''): string {
  return `<label>${esc(label)}${hint === '' ? '' : ` <span class="muted">${esc(hint)}</span>`}
  <textarea name="${esc(name)}" rows="4">${escLabel(value)}</textarea>
</label>${issuesAt(issues, [name])}`;
}

function radios(name: string, options: readonly (readonly [string, string])[], checked: string): string {
  return options
    .map(
      ([v, label]) =>
        `<label><input type="radio" name="${esc(name)}" value="${esc(v)}"${v === checked ? ' checked' : ''}> ${esc(label)}</label>`,
    )
    .join('');
}

function submit(more = false): string {
  return `<button type="submit">שמור והמשך</button>${
    more ? ' <button type="submit" name="stay" value="1">שמור והוסף עוד שורות</button>' : ''
  }`;
}

function frame(view: StepView, inner: string): string {
  const i = view.step - 1;
  return setupPage({
    title: `שלב ${view.step}: ${STEP_TITLES[i] ?? ''}`,
    draft: view.draft,
    current: view.step,
    body: `${view.notice === undefined ? '' : `<p class="error">${esc(view.notice)}</p>`}
<h2>שלב ${view.step} מתוך ${STEP_TITLES.length}: ${esc(STEP_TITLES[i] ?? '')}</h2>
<p>${esc(STEP_WHY[i] ?? '')}</p>
<p><span class="tag">${esc(STEP_TAGS[i] ?? '')}</span></p>
${issuesBox(view.issues)}
${inner}`,
  });
}

function form(view: StepView, fields: string, more = false): string {
  return `<form method="post" action="/setup/step/${view.step}">
  <input type="hidden" name="csrf" value="${esc(view.csrf)}">
  ${fields}
  ${submit(more)}
</form>`;
}

// --- step 1 ------------------------------------------------------------------

function followUpUnder(value: string, line: string): string {
  const n = wordCount(value);
  return n > 0 && n < FOLLOW_UP_UNDER_WORDS ? `<p class="note">${esc(line)}</p>` : '';
}

function step1(view: StepView): string {
  const v = obj(view.value);
  const facts = Array.isArray(v['keyFacts']) ? v['keyFacts'].map(obj) : [];
  const factRows = [...facts, ...Array.from({ length: BLANK_ROWS }, () => ({}))]
    .map(
      (f, i) => `<div class="row">
  <label>שאלה <input type="text" name="kf${i}_q" value="${escLabel(str(obj(f)['q']))}"></label>
  <label>תשובה <input type="text" name="kf${i}_a" value="${escLabel(str(obj(f)['a']))}"></label>
</div>${issuesAt(view.issues, ['keyFacts', i])}`,
    )
    .join('');
  const description = str(v['description']);
  const expectations = str(v['expectations']);
  return frame(
    view,
    `${view.followUp === true ? `<p class="note">${esc(FOLLOW_UPS[2])}</p>` : ''}
${form(
  view,
  `${area('ספר לי על העסק בכמה משפטים: במה אתם עוסקים ולמי?', 'description', description, view.issues)}
${followUpUnder(description, FOLLOW_UPS[0])}
${field('מה השם הרשמי של העסק?', 'legalName', str(v['legalName']), view.issues)}
${field('ואיך הלקוחות קוראים לכם?', 'tradeName', str(v['tradeName']), view.issues)}
${field('באיזה תחום העסק?', 'vertical', str(v['vertical']), view.issues)}
${field('כמה אנשים עובדים בעסק?', 'employees', str(v['employees']), view.issues, 'number')}
${area('מה אתה מצפה ממני? מה רוב העבודה שתרצה שאקח ממך?', 'expectations', expectations, view.issues)}
${followUpUnder(expectations, FOLLOW_UPS[1])}
${area('יש דברים שהעסק לא עושה, ושלקוחות שואלים עליהם לפעמים?', 'notDone', strList(v['notDone']).join('\n'), view.issues, 'שורה לכל דבר. זה מה שעוצר אותי מלהבטיח את מה שאין.')}
<fieldset><legend>שאלות שחוזרות אצל לקוחות, ושמותר לי לענות עליהן בלי לבדוק איתך (רשות)</legend>${factRows}</fieldset>
${view.followUp === true ? '<input type="hidden" name="followed" value="1">' : ''}`,
  true,
)}`,
  );
}

// --- steps 2–5 ---------------------------------------------------------------

function step2(view: StepView): string {
  const v = obj(view.value);
  return frame(
    view,
    `<p class="note">${esc(ONLY_YOU_APPROVE_NOTE)}</p>
${form(
  view,
  `${field('מה השם שלך?', 'displayName', str(v['displayName']), view.issues)}
${field('מה התפקיד שלך?', 'role', str(v['role']), view.issues)}
${field('מה מספר הוואטסאפ שלך? (עם קידומת מדינה, לדוגמה ‎+972541234567)', 'whatsapp', str(v['whatsapp']), view.issues)}
${field('מה כתובת המייל שלך?', 'email', str(v['email']), view.issues, 'email')}`,
)}`,
  );
}

const REGISTER_HE = [
  ['formal', 'רשמי'],
  ['professional', 'מקצועי'],
  ['warm', 'חם'],
  ['casual', 'קליל'],
] as const;
const EMOJI_HE = [
  ['never', 'אף פעם'],
  ['sparingly', 'במשורה'],
  ['match_counterparty', 'כמו הצד השני'],
] as const;

function step3(view: StepView): string {
  const v = obj(view.value);
  return frame(
    view,
    form(
      view,
      `<fieldset><legend>איך לדבר עם לקוחות?</legend>${radios('register', REGISTER_HE, str(v['register']) || 'professional')}${issuesAt(view.issues, ['register'])}</fieldset>
${field('איך לחתום על הודעות?', 'signOff', str(v['signOff']), view.issues)}
<fieldset><legend>אימוג׳ים?</legend>${radios('emojiPolicy', EMOJI_HE, str(v['emojiPolicy']) || 'never')}${issuesAt(view.issues, ['emojiPolicy'])}</fieldset>
${area('מילים או הבטחות שאסור לי לומר לעולם?', 'mustNeverSay', strList(v['mustNeverSay']).join('\n'), view.issues, 'שורה לכל ביטוי. זו התאמת מילים. מה שבאמת חשוב לחסום — חסום בשלב 6.')}`,
    ),
  );
}

const WEEKDAY_HE: Readonly<Record<Weekday, string>> = {
  sun: 'א׳',
  mon: 'ב׳',
  tue: 'ג׳',
  wed: 'ד׳',
  thu: 'ה׳',
  fri: 'ו׳',
  sat: 'ש׳',
};

/** Step 4's prefill when the section is unsaved (Task 8 brief). */
export const HOURS_PREFILL = {
  workweek: ['sun', 'mon', 'tue', 'wed', 'thu'],
  open: '',
  close: '',
  quietHours: null,
  timezone: 'Asia/Jerusalem',
} as const;

function step4(view: StepView): string {
  const v = obj(view.value ?? HOURS_PREFILL);
  const days = strList(v['workweek']);
  const quiet = obj(v['quietHours']);
  const dayBoxes = Weekday.options
    .map(
      (d) =>
        `<label style="display:inline-block;margin-inline-end:0.8rem"><input type="checkbox" name="workweek" value="${d}"${days.includes(d) ? ' checked' : ''}> ${esc(WEEKDAY_HE[d])}</label>`,
    )
    .join('');
  return frame(
    view,
    form(
      view,
      `<fieldset><legend>באילו ימים העסק עובד?</legend>${dayBoxes}${issuesAt(view.issues, ['workweek'])}</fieldset>
<fieldset><legend>שעות פעילות</legend>
${field('מ-', 'open', str(v['open']), view.issues, 'time')}
${field('עד', 'close', str(v['close']), view.issues, 'time')}
</fieldset>
<fieldset><legend>שעות שבהן אסור לי לפנות לאף אחד (רשות)</legend>
<label>מ- <input type="time" name="quietFrom" value="${escLabel(str(quiet['from']))}"></label>
<label>עד <input type="time" name="quietTo" value="${escLabel(str(quiet['to']))}"></label>
${issuesAt(view.issues, ['quietHours'])}
</fieldset>
${field('אזור הזמן', 'timezone', str(v['timezone']), view.issues)}`,
    ),
  );
}

const PROVIDER_HE: Readonly<Record<MailProvider, string>> = {
  google: 'Gmail (Google)',
  microsoft: 'Microsoft 365 (Outlook)',
};

function step5(view: StepView): string {
  const v = obj(view.value);
  const mailbox = view.pinnedMailbox
    ? `<p>תיבת המייל של העסק כבר בכללים שחתמת עליהם: <b>${esc(PROVIDER_HE[view.pinnedMailbox])}</b>. אי אפשר לשנות אותה מכאן — ביטול או החלפה נעשים במסך <a href="/connections/mailbox">תיבת המייל</a>.</p>
<input type="hidden" name="mailbox" value="${esc(view.pinnedMailbox)}">`
    : `<fieldset><legend>האם אתה מאשר לי לקרוא את כל המיילים שמגיעים לתיבת העסק, לסווג אותם ולהכין תשובות?</legend>
${radios(
  'mailbox',
  [
    ['none', 'לא'],
    ['google', `כן — ${PROVIDER_HE.google}`],
    ['microsoft', `כן — ${PROVIDER_HE.microsoft}`],
  ],
  str(v['mailbox']) || 'none',
)}
<p class="muted">החיבור עצמו לתיבה נעשה אחרי החתימה, במסך החיבורים.</p>
${issuesAt(view.issues, ['mailbox'])}</fieldset>`;
  return frame(
    view,
    `${form(
      view,
      `${mailbox}
<fieldset><legend>מסמכים שתשלח אליי (Word, Excel, PDF) — לקרוא ולהציע מה לעשות איתם?</legend>
${radios(
  'documents',
  [
    ['no', 'לא'],
    ['yes', 'כן'],
  ],
  v['documents'] === true ? 'yes' : 'no',
)}
<p class="muted">${esc(DOCUMENTS_NOTE)}</p></fieldset>`,
    )}
<p class="note">${esc(WHATSAPP_NOTE)}</p>`,
  );
}

// --- step 6 ------------------------------------------------------------------

const AVAILABILITY_HE: Readonly<Record<Availability, string>> = {
  works: '',
  not_connected: 'לא מחובר',
  not_built: 'עוד לא זמין',
};

function step6(view: StepView): string {
  const v = obj(view.value);
  const rows = INTERVIEW_ROWS.map((row) => {
    const level = str(v[row]) || ROW_DEFAULTS[row];
    const aloneOk = ALONE_ALLOWED.has(row);
    const availability = AVAILABILITY_HE[availabilityOf(row, view.connections ?? [])];
    const cell = (value: string, label: string, disabled = false) =>
      `<label><input type="radio" name="row:${esc(row)}" value="${value}"${level === value ? ' checked' : ''}${disabled ? ' disabled' : ''}> ${esc(label)}</label>`;
    return `<tr>
  <th scope="row">${esc(ACTION_CLASS_HE[row])}${availability === '' ? '' : ` <span class="tag">${esc(availability)}</span>`}
    <div class="muted">מה זה אומר בפועל? ${esc(ROW_EXAMPLES[row])}</div>
    ${row === 'email.reply' ? `<div class="note">${esc(REPLY_ALONE_NOTE)}</div>` : ''}
    ${issuesAt(view.issues, [row])}</th>
  <td>${cell('never', 'אף פעם')}</td>
  <td>${cell('approve', 'אחרי אישורך')}</td>
  <td>${cell('alone', 'לבד', !aloneOk)}${aloneOk ? '' : `<div class="muted">${esc(NEVER_ALONE_NOTE)}</div>`}</td>
</tr>`;
  }).join('');
  return frame(
    view,
    form(
      view,
      `<table class="actions">
<tr><th>פעולה</th><th>אף פעם</th><th>אחרי אישורך</th><th>לבד</th></tr>
${rows}
</table>
<p class="note"><b>${esc(CEILING_NOTE)}</b></p>`,
    ),
  );
}

// --- steps 7–9 ---------------------------------------------------------------

export const MONEY_SKIP_SENTENCE = 'בחרת שאני לא נוגעת בכסף, ולכן אין כאן מה לקבוע — כל התקרות יהיו אפס.';

function money(v: unknown): string {
  return typeof v === 'number' ? minorToShekels(v) : str(v);
}

function step7(view: StepView): string {
  if (moneyUntouched(view.draft ?? {})) {
    return frame(view, `<p>${esc(MONEY_SKIP_SENTENCE)}</p>${form(view, '')}`);
  }
  const v = obj(view.value);
  return frame(
    view,
    form(
      view,
      `${field('הסכום הגבוה ביותר שמותר בפעולה אחת (בשקלים)', 'single', money(v['singleMinor']), view.issues)}${issuesAt(view.issues, ['singleMinor'])}
${field('ביום (בשקלים)', 'daily', money(v['dailyMinor']), view.issues)}${issuesAt(view.issues, ['dailyMinor'])}
${field('בחודש (בשקלים)', 'monthly', money(v['monthlyMinor']), view.issues)}${issuesAt(view.issues, ['monthlyMinor'])}
${field('ההנחה המקסימלית שמותר לי להציע (באחוזים)', 'discount', str(v['maxDiscountPercent']), view.issues)}${issuesAt(view.issues, ['maxDiscountPercent'])}`,
    ),
  );
}

function counterpartyRows(list: string, prefix: string, entries: unknown, issues: readonly SetupIssue[]): string {
  const saved = Array.isArray(entries) ? entries.map(obj) : [];
  return [...saved, ...Array.from({ length: BLANK_ROWS }, () => ({}))]
    .map(
      (e, i) => `<div class="row">
  <label>שם <input type="text" name="${prefix}${i}_label" value="${escLabel(str(obj(e)['label']))}"></label>
  <label>דומיין מייל <input type="text" name="${prefix}${i}_emailDomain" value="${escLabel(str(obj(e)['emailDomain']))}" dir="ltr"></label>
  <label>טלפון <input type="text" name="${prefix}${i}_phone" value="${escLabel(str(obj(e)['phone']))}" dir="ltr"></label>
</div>${issuesAt(issues, [list, i])}`,
    )
    .join('');
}

function step8(view: StepView): string {
  const v = obj(view.value);
  return frame(
    view,
    form(
      view,
      `<fieldset><legend>לקוחות או ספקים קבועים: שם, ודומיין מייל או מספר טלפון</legend>
<p class="muted">בלי זה, כל מענה ללקוח מוכר ייחשב פנייה ראשונה ויבקש את אישורך. דומיין כמו rival.co.il כבר מכסה את כל תתי-הדומיינים שלו — בלי כוכבית.</p>
${counterpartyRows('known', 'known', v['known'], view.issues)}</fieldset>
<fieldset><legend>אנשים או חברות שאסור לי לפנות אליהם לעולם</legend>
${counterpartyRows('doNotContact', 'dnc', v['doNotContact'], view.issues)}</fieldset>`,
      true,
    ),
  );
}

const MODE_CHOICES = [
  ['off', 'כבוי — מכינה טיוטות ולא מוציאה כלום.'],
  ['ask', 'שואלת תמיד — מבצעת, אבל מבקשת את אישורך על כל פעולה.'],
  ['learn', 'לומדת — מתחילה כמו "שואלת תמיד", וכל סוג פעולה שהוכיח את עצמו מפסיק לשאול.'],
] as const;

function step9(view: StepView): string {
  const v = obj(view.value);
  return frame(
    view,
    form(
      view,
      `<fieldset><legend>האם אתה רוצה שאלמד את העסק עם הזמן, ואתחיל לבצע לבד סוגי פעולות שהוכחתי בהם?</legend>
${radios('mode', MODE_CHOICES, str(v['mode']) || 'off')}
<p class="muted">אפשר לשנות את זה בכל רגע במסך „כמה חופש לתת”.</p>${issuesAt(view.issues, ['mode'])}</fieldset>`,
    ),
  );
}

// --- step 10 -----------------------------------------------------------------

function ruleLine(rule: AcceptedRule): string {
  return `${escLabel(describeRule(rule))}${rule.kind === 'guidance' ? ` <span class="tag">${esc(GUIDANCE_TAG)}</span>` : ''}`;
}

/**
 * Each button names an index AND the hash of the rule it was rendered beside.
 * The index alone shifts after any splice — a double click or a stale tab
 * would act on the neighbour — so the route refuses when the server's rule at
 * that index no longer hashes to what the owner saw.
 */
function ruleButton(csrf: string, i: number, rule: AcceptedRule, choice: string, label: string): string {
  return `<form method="post" action="/setup/rule/${i}" style="display:inline">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="ruleHash" value="${esc(canonicalHash(rule))}">
  <button type="submit" name="choice" value="${esc(choice)}">${esc(label)}</button>
</form>`;
}

function step10(view: StepView): string {
  const v = obj(view.value);
  const accepted = Array.isArray(v['accepted']) ? (v['accepted'] as AcceptedRule[]) : [];
  const pending = Array.isArray(v['pending']) ? (v['pending'] as AcceptedRule[]) : [];
  const acceptedHtml =
    accepted.length === 0
      ? ''
      : `<div class="card"><h3>מה כבר הוספת</h3><ul>${accepted
          .map((r, i) => `<li>${ruleLine(r)} ${ruleButton(view.csrf, i, r, 'remove', 'הסר')}</li>`)
          .join('')}</ul></div>`;
  const pendingHtml = pending
    .map(
      (r, i) => `<div class="card">
<p>כתבת: „${escLabel(r.text)}”</p>
<p>הבנתי: ${ruleLine(r)}. נכון?</p>
${ruleButton(view.csrf, i, r, 'accept', 'כן')}
${ruleButton(view.csrf, i, r, 'fix', 'תקן')}
${ruleButton(view.csrf, i, r, 'guidance', 'שמור רק כהנחיה')}
${ruleButton(view.csrf, i, r, 'delete', 'מחק')}
</div>`,
    )
    .join('');
  return frame(
    view,
    `${acceptedHtml}
${pendingHtml}
<form method="post" action="/setup/rule">
  <input type="hidden" name="csrf" value="${esc(view.csrf)}">
  <label>יש עוד משהו שאסור לי לעשות, שלא כיסינו? <span class="muted">(משפט אחד בכל פעם, עד ${RULE_TEXT_MAX} תווים)</span>
    <textarea name="text" rows="3">${escLabel(view.ruleText ?? '')}</textarea>
  </label>
  ${view.ruleError === undefined ? '' : `<p class="error">${esc(view.ruleError)}</p>`}
  <button type="submit">הצע לי איך לרשום את זה</button>
</form>
${form(view, '<p class="muted">אין עוד? אפשר להמשיך לסיכום.</p>')}`,
  );
}

const STEPS: Readonly<Record<number, (view: StepView) => string>> = {
  1: step1,
  2: step2,
  3: step3,
  4: step4,
  5: step5,
  6: step6,
  7: step7,
  8: step8,
  9: step9,
  10: step10,
};

export function renderStep(view: StepView): string {
  const render = STEPS[view.step];
  if (render === undefined) throw new Error(`no setup step ${view.step}`);
  return render(view);
}
