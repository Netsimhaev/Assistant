/**
 * The setup interview's screens: the frame every step shares (step list on
 * the side, the step in the main area, a destination tag), the summary and
 * sign page, and the refusal pages. Pure rendering — no DB, no session.
 *
 * Every value the owner typed, and every line derived from one (summary
 * lines, rule descriptions), goes through `escLabel`: escaped AND stripped of
 * bidirectional controls, so a name cannot render as something it is not on
 * the very page the owner signs from. Fixed copy goes through `esc`.
 *
 * The step bodies live in `setup-step-views.ts`; this file is the frame.
 */
import type { CharterSummary, SummaryCounterparty, SummaryPrincipal } from '../charter/interview/summary.js';
import {
  AUTHORITY_NOTE,
  AUTONOMY_MODE_INTERVIEW_HE,
  BOSS_COMMAND_NOTE,
  GUIDANCE_TAG,
  NO_CHANGES_NOTE,
} from '../charter/interview/summary.js';
import type { AutonomyMode } from '../governance/autonomy-mode.js';
import { MAIL_PROVIDER_NAME } from '../mail/mailbox.js';
import { MAILBOX_AUTHORISATION_TEXT, RESTART_NOTE } from './mailbox-connect.js';
import type { InterviewAnswersDraft } from '../charter/interview/answers.js';
import { INTERVIEW_SECTIONS } from '../charter/interview/answers.js';
import type { SetupIssue } from './setup-forms.js';
import { escLabel, escapeHtml as esc, page } from './views.js';

export const STEP_COUNT = INTERVIEW_SECTIONS.length;

/** Step titles (spec §5), step n at index n - 1. */
export const STEP_TITLES: readonly string[] = [
  'היכרות עם העסק',
  'מי בעסק',
  'איך אני מדברת',
  'שעות',
  'מה מותר לי לקרוא',
  'מה מותר לי לעשות',
  'כסף',
  'אנשים וחברות',
  'לימוד ועצמאות',
  'עוד משהו שאסור?',
];

/** "Why I ask" — one sentence per step. */
export const STEP_WHY: readonly string[] = [
  'כדי לענות ללקוחות כמו שאתה היית עונה, אני צריכה להכיר את העסק.',
  'כדי לדעת ממי אני מקבלת הוראות ולמי אני פונה כשצריך אישור.',
  'כדי שכל הודעה שאני כותבת תישמע כמו העסק שלך.',
  'כדי שלא אפנה לאף אחד בשעות שאסור, ואדע מתי העסק פתוח.',
  'כדי לקרוא רק את מה שאישרת לי לקרוא.',
  'כדי לדעת מה מותר לי לעשות לבד, מה רק אחרי שתאשר, ומה לעולם לא.',
  'כדי שלא אחרוג מסכום שקבעת, גם אם מישהו יבקש.',
  'כדי לזהות לקוחות קבועים, ולא לפנות למי שאסור.',
  'כדי לדעת כמה מהמקסימום שקבעת אני משתמשת בפועל.',
  'כדי לא לפספס גבול שחשוב לך ולא כיסינו.',
];

export const TAG_GUIDANCE = 'אזכור את זה כהנחיה';
export const TAG_CHARTER = 'ייכנס לכללים שתחתום עליהם';
const TAG_DIAL = 'ייקבע כרמת החופש מיד אחרי החתימה — לא חלק מהכללים';
const TAG_RULE_OR_GUIDANCE = 'כלל או הנחיה — לפי מה שתבחר לכל משפט';

/** Where each step's answer goes, step n at index n - 1. */
export const STEP_TAGS: readonly string[] = [
  TAG_GUIDANCE,
  TAG_CHARTER,
  TAG_CHARTER,
  TAG_CHARTER,
  TAG_CHARTER,
  TAG_CHARTER,
  TAG_CHARTER,
  TAG_CHARTER,
  TAG_DIAL,
  TAG_RULE_OR_GUIDANCE,
];

export const UNREADABLE_NOTICE =
  'התקנון הקיים אינו קריא — יש למלא את הראיון מחדש. החתימה תחליף אותו.';

const SETUP_STYLE = `<style>
  body { max-width: 64rem; }
  .setup { display: grid; grid-template-columns: 14rem 1fr; gap: 2rem; }
  .setup nav ol { padding-inline-start: 1.2rem; }
  .setup nav li { margin-bottom: 0.3rem; }
  .setup nav .current { font-weight: bold; }
  .tag { display: inline-block; border: 1px solid #8886; border-radius: 1rem; padding: 0 0.6rem; font-size: 0.85em; }
  .note { border-inline-start: 3px solid #8888; padding-inline-start: 0.6rem; }
  table.actions { border-collapse: collapse; width: 100%; }
  table.actions td, table.actions th { border-bottom: 1px solid #8884; padding: 0.4rem; vertical-align: top; }
  .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; }
  input[type="number"], input[type="time"] { padding: 0.3rem; }
  fieldset { border: 1px solid #8884; border-radius: 0.4rem; margin-top: 0.75rem; }
  @media (max-width: 40rem) { .setup { grid-template-columns: 1fr; } }
</style>`;

function stepList(draft: InterviewAnswersDraft | null, current: number | 'summary'): string {
  const items = STEP_TITLES.map((title, i) => {
    const n = i + 1;
    const section = INTERVIEW_SECTIONS[i];
    const saved = section !== undefined && draft?.[section] !== undefined;
    const cls = current === n ? ' class="current"' : '';
    return `<li${cls}><a href="/setup/step/${n}">${esc(title)}</a>${saved ? ' <span aria-label="נשמר">✓</span>' : ''}</li>`;
  }).join('');
  const summaryCls = current === 'summary' ? ' class="current"' : '';
  return `<nav aria-label="שלבי ההגדרה"><ol>${items}</ol><p${summaryCls}><a href="/setup/summary">סיכום וחתימה</a></p></nav>`;
}

/** The frame: step list on the side, the content in the main area. */
export function setupPage(options: {
  title: string;
  draft: InterviewAnswersDraft | null;
  current: number | 'summary';
  body: string;
}): string {
  return page(
    options.title,
    `${SETUP_STYLE}
<header><h1>הגדרת העוזרת</h1></header>
<div class="setup">
${stepList(options.draft, options.current)}
<main>${options.body}</main>
</div>`,
  );
}

/** Every issue at the top, as a list the owner can read before scrolling. */
export function issuesBox(issues: readonly SetupIssue[]): string {
  if (issues.length === 0) return '';
  return `<div class="card" role="alert"><p class="error">לא נשמר — יש לתקן:</p><ul>${issues
    .map((i) => `<li class="error">${escLabel(i.message)}</li>`)
    .join('')}</ul></div>`;
}

/** The issues whose path starts with `prefix`, rendered next to the field. */
export function issuesAt(issues: readonly SetupIssue[], prefix: readonly (string | number)[]): string {
  const hits = issues.filter((i) => prefix.every((seg, k) => i.path[k] === seg));
  return hits.map((i) => `<span class="error">${escLabel(i.message)}</span>`).join(' ');
}

function bulletList(items: readonly string[], empty: string): string {
  if (items.length === 0) return `<p class="muted">${esc(empty)}</p>`;
  return `<ul>${items.map((t) => `<li>${escLabel(t)}</li>`).join('')}</ul>`;
}

function lineList(lines: readonly { label: string; levelHe: string }[], empty: string): string {
  if (lines.length === 0) return `<p class="muted">${esc(empty)}</p>`;
  return `<ul>${lines.map((l) => `<li>${escLabel(l.label)} <span class="muted">(${escLabel(l.levelHe)})</span></li>`).join('')}</ul>`;
}

/** "Whose instructions I take" — every channel the charter names, typed values through `escLabel`. */
function principalCard(principal: SummaryPrincipal | null): string {
  const body =
    principal === null
      ? '<p class="muted">לא הוגדר בעלים.</p>'
      : `<ul><li>שם: ${escLabel(principal.displayName)}</li>
<li>וואטסאפ: ${principal.whatsapp === null ? 'לא הוגדר' : `<bdi>${escLabel(principal.whatsapp)}</bdi>`}</li>
<li>מייל: ${principal.email === null ? 'לא הוגדר' : `<bdi>${escLabel(principal.email)}</bdi>`}</li></ul>`;
  return `<div class="card"><h2>ממי אני מקבלת הוראות</h2>${body}</div>`;
}

/** "Known customers and suppliers" — each with the domain/phone that makes a recipient count as known. */
function knownCard(known: readonly SummaryCounterparty[]): string {
  const items = known.map((c) => {
    const handles = [c.emailDomain, c.phone].filter((h): h is string => h !== null);
    const tail = handles.length === 0 ? '' : ` — ${handles.map((h) => `<bdi>${escLabel(h)}</bdi>`).join(', ')}`;
    return `<li>${escLabel(c.label)}${tail}</li>`;
  });
  const body = items.length === 0 ? '<p class="muted">אין.</p>' : `<ul>${items.join('')}</ul>`;
  return `<div class="card"><h2>לקוחות וספקים מוכרים</h2>${body}</div>`;
}

/**
 * A mailbox this signature adds: the same two statements the connections
 * screen's own mailbox sign page carries (`mailbox-connect.ts`) — what
 * reading and labelling it authorises, and that the scheduler must restart.
 */
function mailboxCard(summary: CharterSummary): string {
  if (summary.mailboxAdded === null) return '';
  return `<div class="card"><h2>תיבת המייל של העסק — ${esc(MAIL_PROVIDER_NAME[summary.mailboxAdded])}</h2>
<p>${esc(MAILBOX_AUTHORISATION_TEXT)}</p>
<p class="muted">${esc(RESTART_NOTE)}</p></div>`;
}

/**
 * The summary and the sign form. Everything here comes from `summarizeCharter`
 * of the UNSIGNED charter the frozen draft builds — the same object whose hash
 * rides in `shownHash`, so what is read is what is signed.
 */
export function renderSummary(options: {
  draft: InterviewAnswersDraft;
  summary: CharterSummary;
  shownHash: string;
  csrf: string;
  /** Who the rules bind, from the same unsigned charter — names the owner typed. */
  business: { legalName: string; tradeName: string; principal: string | null };
  /** The dial applied right after signing (step 9) — not part of the rules, but bound by the hash. */
  mode: AutonomyMode;
}): string {
  const { summary, business } = options;
  const changes =
    summary.changes === null
      ? ''
      : `<div class="card"><h2>מה משתנה לעומת הכללים הנוכחיים</h2>${bulletList(summary.changes, NO_CHANGES_NOTE)}</div>`;
  const preserved =
    summary.preserved.length === 0
      ? ''
      : `<div class="card"><h2>כללים קיימים שלא נשאלו כאן ונשארים</h2>${bulletList(summary.preserved, '')}</div>`;
  const defaults =
    summary.defaultsChosen.length === 0
      ? ''
      : `<div class="card"><h2>מה קבעתי בשבילך בלי לשאול</h2>${bulletList(summary.defaultsChosen, '')}</div>`;
  const guidance = summary.guidance.length === 0
    ? `<p class="muted">אין הנחיות.</p>`
    : `<ul>${summary.guidance.map((g) => `<li>${escLabel(g)} <span class="tag">${esc(GUIDANCE_TAG)}</span></li>`).join('')}</ul>`;
  const back = STEP_TITLES.map((t, i) => `<a href="/setup/step/${i + 1}">חזור לשלב ${i + 1}: ${esc(t)}</a>`).join(' · ');

  return setupPage({
    title: 'סיכום וחתימה',
    draft: options.draft,
    current: 'summary',
    body: `<h2>סיכום — מה אני יכולה ומה לא</h2>
<p>הכללים של <b>${escLabel(business.tradeName)}</b> (${escLabel(business.legalName)})${
      business.principal === null ? '' : `, בחתימת ${escLabel(business.principal)}`
    }.</p>
${changes}
${principalCard(summary.principal)}
<div class="columns">
  <div class="card"><h3>מה אני יכולה לעשות</h3>${lineList(summary.can, 'אין.')}</div>
  <div class="card"><h3>מותר, אבל עוד לא פועל</h3>${lineList(summary.notYetWorking, 'אין.')}</div>
  <div class="card"><h3>מה אני לא יכולה לעשות</h3>${lineList(summary.cannot, 'אין.')}</div>
  <div class="card"><h3>דברים שאני לא יודעת לעשות בכלל</h3>${bulletList(summary.cannotAtAll, 'אין.')}</div>
</div>
<div class="card"><h2>גבולות</h2>${bulletList(summary.limits, 'לא נקבעו גבולות נוספים.')}</div>
${knownCard(summary.knownCounterparties)}
${mailboxCard(summary)}
<p class="note">רמת החופש אחרי החתימה: <b>${esc(AUTONOMY_MODE_INTERVIEW_HE[options.mode])}</b> — לא חלק מהכללים; אפשר לשנות בכל רגע במסך „כמה חופש לתת”.</p>
<div class="card"><h2>מה ידוע לי על העסק</h2>${guidance}</div>
${defaults}
${preserved}
<p class="note"><b>${esc(BOSS_COMMAND_NOTE)}</b></p>
<p class="note">${esc(AUTHORITY_NOTE)}</p>
<form method="post" action="/setup/sign">
  <input type="hidden" name="csrf" value="${esc(options.csrf)}">
  <input type="hidden" name="shownHash" value="${esc(options.shownHash)}">
  <button type="submit">חתום והתחל</button>
</form>
<p class="muted">${back}</p>`,
  });
}

/** A refusal page: what happened, and the way back to the summary. */
export function renderSetupRefusal(title: string, message: string, back: { href: string; label: string }): string {
  return page(
    title,
    `<h1>${esc(title)}</h1><p class="error">${esc(message)}</p><p><a href="${esc(back.href)}">${esc(back.label)}</a></p>`,
  );
}
