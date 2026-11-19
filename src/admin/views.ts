/**
 * The operator panel's server-rendered HTML. Same discipline as the owner
 * dashboard's views: no client framework, and every interpolated value goes
 * through `escapeHtml` — the one escaping helper, from `src/util/html.ts`
 * (the panel does not import the dashboard's views).
 *
 * The panel never displays business content (spec; global constraints):
 * states, counts, and what a technician typed. Nothing on these screens
 * comes from mail, memory, jobs or instructions.
 */
import { escapeHtml } from '../util/html.js';
import { stripBidiControls } from '../util/bidi.js';
import { formatMinor } from '../util/money.js';
import type { StaffAction, StaffActionRow } from '../tenancy/activity-log.js';
import type { StaffListing } from '../tenancy/staff.js';
import type {
  ExternalSystemPanelState,
  ExternalSystemPanelStatus,
  PanelBusinessDetail,
  PanelBusinessRow,
  PanelSetupData,
} from '../tenancy/panel-reads.js';

const esc = escapeHtml;
/** A staff name is typed text: bidi controls are stripped before escaping (final review M5). */
const escLabel = (value: string): string => esc(stripBidiControls(value));

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 56rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; gap: 1rem; flex-wrap: wrap; }
  header .brand { font-weight: bold; }
  nav a { margin-inline-end: 1rem; }
  .card { border: 1px solid #8884; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem; }
  .muted { opacity: 0.7; font-size: 0.9em; }
  .error { color: #c0392b; font-weight: bold; }
  label { display: block; margin-top: 0.75rem; }
  input[type="text"], input[type="email"], input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.4rem; margin-top: 0.2rem; }
  button { margin-top: 1rem; padding: 0.5rem 1.2rem; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: start; padding: 0.4rem 0.6rem; border-bottom: 1px solid #8884; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 1rem; }
  dd { margin: 0; }
`;

/** Who is signed in, for the header: their name and the CSRF token of the logout form. */
export interface PanelViewer {
  displayName: string;
  isHead: boolean;
  csrf: string;
}

/**
 * A complete panel page. With a `viewer`, the header carries the nav
 * (`עסקים · צוות · יומן פעולות`) and a logout button; without one (the
 * sign-in screens) only the header line.
 */
export function page(title: string, body: string, viewer?: PanelViewer): string {
  const nav =
    viewer === undefined
      ? ''
      : `<nav><a href="/">עסקים</a> · <a href="/staff">צוות</a> · <a href="/log">יומן פעולות</a></nav>
<div><span class="muted">${escLabel(viewer.displayName)}${viewer.isHead ? ' (מנהל ראשי)' : ''}</span>
<form method="post" action="/logout" style="display:inline">
  <input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
  <button type="submit">התנתקות</button>
</form></div>`;
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><div class="brand">פאנל המנהל</div>${nav}</header>
${body}
</body>
</html>`;
}

/** A wrong password, an unknown address, a removed member — one message for all. */
export const PANEL_LOGIN_FAILED = 'כתובת מייל או סיסמה שגויים.';
export const PANEL_LOGIN_LOCKED = 'החשבון נעול זמנית לאחר ניסיונות כושלים. נסה שוב בעוד כמה דקות.';
export const TOTP_ENROL_INSTRUCTION =
  'סרוק את הקוד באפליקציית Google Authenticator והקלד את הקוד בן שש הספרות שמופיע בה.';
export const TOTP_BAD_CODE = 'הקוד שגוי או שפג תוקפו. נסה שוב עם הקוד שמופיע עכשיו באפליקציה.';
export const TOTP_LOCKED = 'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.';
/** An invite link that is unknown, used or expired — one message for all three. */
export const JOIN_LINK_INVALID = 'הקישור אינו תקף. בקש קישור חדש מהמנהל הראשי.';
export const JOIN_LOGIN_MISMATCH = 'כתובת המייל אינה תואמת את הקישור.';
export const JOIN_PASSWORDS_DIFFER = 'הסיסמאות אינן תואמות.';

function errorBlock(error: string | undefined): string {
  return error ? `<p class="error">${esc(error)}</p>` : '';
}

function logoutOnly(csrf: string): string {
  return `<form method="post" action="/logout">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <button type="submit">התנתקות</button>
</form>`;
}

export function renderLogin(options: { error?: string } = {}): string {
  return page(
    'כניסה לפאנל',
    `<h1>כניסת צוות</h1>
${errorBlock(options.error)}
<div class="card">
<form method="post" action="/login">
  <label>כתובת מייל<input type="email" name="email" autocomplete="username" required></label>
  <label>סיסמה<input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">כניסה</button>
</form>
</div>`,
  );
}

function codeForm(action: string, csrf: string): string {
  return `<form method="post" action="${esc(action)}">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <label>קוד בן שש ספרות<input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>
  <button type="submit">אישור</button>
</form>`;
}

/**
 * Connecting Google Authenticator. `qr` is the SVG this server generated
 * from the otpauth URI — never anything a user typed. Absent after a wrong
 * code, so showing the page again does not mint a secret the app never saw.
 */
export function renderTotpEnrol(options: { csrf: string; qr?: string; secretBase32?: string; error?: string }): string {
  const shown =
    options.qr !== undefined && options.secretBase32 !== undefined
      ? `<div class="card totp-qr">${options.qr}</div>
<p class="muted">או הקלד את המפתח ידנית:</p>
<p><code class="totp-secret">${esc(options.secretBase32.match(/.{1,4}/g)?.join(' ') ?? options.secretBase32)}</code></p>`
      : '<p class="muted">אם עוד לא סרקת את הקוד, <a href="/2fa/enrol">הצג קוד חדש</a>.</p>';
  return page(
    'חיבור Google Authenticator',
    `<h1>חיבור Google Authenticator</h1>
<p>${esc(TOTP_ENROL_INSTRUCTION)}</p>
${errorBlock(options.error)}
${shown}
${codeForm('/2fa/enrol', options.csrf)}
${logoutOnly(options.csrf)}`,
  );
}

export function renderTotpVerify(options: { csrf: string; error?: string }): string {
  return page(
    'אימות דו-שלבי',
    `<h1>אימות דו-שלבי</h1>
<p>הקלד את הקוד בן שש הספרות שמופיע עכשיו באפליקציית Google Authenticator.</p>
${errorBlock(options.error)}
${codeForm('/2fa', options.csrf)}
${logoutOnly(options.csrf)}`,
  );
}

/** The staff invite form, served before any session exists. Without `form`, the link is not usable. */
export function renderJoin(options: { form?: { action: string; csrf: string }; error?: string }): string {
  const formBlock = options.form
    ? `<p>הקלד את כתובת המייל שאליה נשלח הקישור, ובחר סיסמה. בשלב הבא תחבר את Google Authenticator.</p>
<div class="card">
<form method="post" action="${esc(options.form.action)}">
  <input type="hidden" name="csrf" value="${esc(options.form.csrf)}">
  <label>כתובת מייל<input type="email" name="email" autocomplete="username" required></label>
  <label>סיסמה<input type="password" name="password" autocomplete="new-password" required></label>
  <label>הקלד את הסיסמה שוב<input type="password" name="confirm" autocomplete="new-password" required></label>
  <button type="submit">שמירה</button>
</form>
</div>`
    : '';
  return page('הצטרפות לצוות', `<h1>הצטרפות לצוות</h1>\n${errorBlock(options.error)}\n${formBlock}`);
}

// ---------------------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------------------

/** The copy shown beside a freshly issued owner invite, verbatim. */
export const INVITE_LINK_COPY = 'העתק את הקישור ושלח אותו לבעל העסק. הקישור תקף ל-72 שעות ולשימוש אחד.';

/** Suspended wins over setting up: a suspended business does nothing either way. */
export function businessStateLabel(row: Pick<PanelBusinessRow, 'status' | 'setupState'>): string {
  if (row.status === 'suspended') return '⏸ מושעה';
  return row.setupState === 'setting_up' ? '🟡 בהקמה' : '🟢 פעיל';
}

function systemsCell(systems: string[]): string {
  return systems.length === 0 ? '—' : esc(systems.join(', '));
}

export function renderBusinessList(viewer: PanelViewer, rows: PanelBusinessRow[]): string {
  const body =
    rows.length === 0
      ? '<p class="muted">עדיין אין עסקים.</p>'
      : `<table>
<thead><tr><th>עסק</th><th>מצב</th><th>חיבורים בסיסיים</th><th>מערכות</th></tr></thead>
<tbody>
${rows
  .map(
    (r) => `<tr><td><a href="/businesses/${esc(r.businessId)}">${esc(r.displayName)}</a> <span class="muted">${esc(r.businessId)}</span></td><td>${esc(businessStateLabel(r))}</td><td>${r.basicDone}/${r.basicTotal}</td><td>${systemsCell(r.systems)}</td></tr>`,
  )
  .join('\n')}
</tbody>
</table>`;
  return page(
    'עסקים',
    `<h1>עסקים</h1>
<p><a class="button" href="/businesses/new">+ פתיחת עסק חדש</a></p>
${body}`,
    viewer,
  );
}

/** What the technician typed into the open-a-business form, echoed back on a refusal. */
export interface NewBusinessValues {
  id: string;
  name: string;
  email: string;
  address: string;
}

export function renderNewBusiness(viewer: PanelViewer, options: { values?: NewBusinessValues; error?: string } = {}): string {
  const v = options.values ?? { id: '', name: '', email: '', address: '' };
  return page(
    'פתיחת עסק חדש',
    `<h1>פתיחת עסק חדש</h1>
${errorBlock(options.error)}
<div class="card">
<form method="post" action="/businesses/new">
  <input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
  <label>מזהה<input type="text" name="id" value="${esc(v.id)}" required dir="ltr"></label>
  <p class="muted">אותיות אנגליות קטנות, ספרות ומקפים, באורך 3 עד 63. לא ניתן לשנות אחר כך.</p>
  <label>שם העסק<input type="text" name="name" value="${esc(v.name)}" required></label>
  <label>מייל הכניסה של בעל העסק<input type="email" name="email" value="${esc(v.email)}" required dir="ltr"></label>
  <label>כתובת (לא חובה)<input type="text" name="address" value="${esc(v.address)}"></label>
  <button type="submit">פתיחת העסק</button>
</form>
</div>`,
    viewer,
  );
}

/**
 * The one page that ever shows an invite link. It is the response to the POST
 * that issued it; nothing stores the raw token, so no later page can show it
 * again.
 */
export function renderInviteIssued(
  viewer: PanelViewer,
  options: { businessId: string; heading: string; link: string; warning?: string },
): string {
  return page(
    options.heading,
    `<h1>${esc(options.heading)}</h1>
${options.warning ? `<p class="error">${esc(options.warning)}</p>` : ''}
<div class="card">
<p>${esc(INVITE_LINK_COPY)}</p>
<p><code dir="ltr" class="invite-link">${esc(options.link)}</code></p>
</div>
<p><a href="/businesses/${esc(options.businessId)}">לדף העסק</a></p>`,
    viewer,
  );
}

/** The business was created but its invite was not issued: say so, and where to fix it. */
export function renderOpenedWithoutInvite(viewer: PanelViewer, businessId: string): string {
  return page(
    'העסק נפתח — הקישור לא הונפק',
    `<h1>העסק נפתח, אבל הקישור לבעל העסק לא הונפק</h1>
<p class="error">משהו השתבש בהנפקת הקישור. אם הוזנה כתובת, גם היא לא נשמרה.</p>
<p>פתח את דף העסק ושלח משם הזמנה חדשה.</p>
<p><a href="/businesses/${esc(businessId)}">לדף העסק</a></p>`,
    viewer,
  );
}

function tick(done: boolean): string {
  return done ? '✓' : '—';
}

/** "Last activity", in Israel time, or a dash. */
function formatWhen(at: Date | null): string {
  if (at === null) return '—';
  return at.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' });
}

/** The copy beside a freshly issued owner reset link, verbatim. */
export const RESET_LINK_COPY =
  'העתק את הקישור ושלח אותו לבעל העסק. הקישור מאפשר לבחור סיסמה חדשה, תקף ל-72 שעות ולשימוש אחד.';

/** The one page that ever shows a reset link — the response to the POST that issued it. */
export function renderResetIssued(viewer: PanelViewer, options: { businessId: string; link: string }): string {
  return page(
    'קישור לאיפוס סיסמה',
    `<h1>קישור לאיפוס סיסמה של בעל העסק</h1>
<div class="card">
<p>${esc(RESET_LINK_COPY)}</p>
<p><code dir="ltr" class="invite-link">${esc(options.link)}</code></p>
</div>
<p><a href="/businesses/${esc(options.businessId)}">לדף העסק</a></p>`,
    viewer,
  );
}

/** An upload refused before its form could be read (too large, unreadable): the reason and a way back. */
export function renderUploadRefused(viewer: PanelViewer, businessId: string, message: string): string {
  return page(
    'ההעלאה נדחתה',
    `<h1>ההעלאה נדחתה</h1>
${errorBlock(message)}
<p><a href="/businesses/${esc(businessId)}">לדף העסק</a></p>`,
    viewer,
  );
}

/** Up to how many empty rows each repeatable group offers below the saved ones (no script on the panel). */
const BLANK_PERSON_ROWS = 3;

function personTable(prefix: 'contact' | 'colleague', rows: PanelSetupData['contacts']): string {
  const filled = rows.map(
    (r) =>
      `<tr><td><input type="text" name="${prefix}_name" value="${esc(r.name)}"></td><td><input type="text" name="${prefix}_role" value="${esc(r.role)}"></td><td><input type="text" name="${prefix}_phone" value="${esc(r.phone)}" dir="ltr"></td></tr>`,
  );
  const blank = Array.from(
    { length: BLANK_PERSON_ROWS },
    () =>
      `<tr><td><input type="text" name="${prefix}_name"></td><td><input type="text" name="${prefix}_role"></td><td><input type="text" name="${prefix}_phone" dir="ltr" placeholder="+972..."></td></tr>`,
  );
  return `<table>
<thead><tr><th>שם</th><th>תפקיד</th><th>טלפון</th></tr></thead>
<tbody>
${[...filled, ...blank].join('\n')}
</tbody>
</table>`;
}

/**
 * The technician's setup package. Before handover: a form with the saved
 * values (the data the technician typed). After it: counts only — from the
 * first signature on, the owner decides who the assistant knows.
 */
function setupSection(viewer: PanelViewer, d: PanelBusinessDetail, setup: PanelSetupData | 'locked'): string {
  const id = esc(d.businessId);
  if (setup === 'locked') {
    return `<section class="card">
<h2>פרטי הקמה</h2>
<dl>
<dt>מספר הוואטסאפ של בעל העסק</dt>
<dd>${d.bossNumberSet ? 'מוגדר' : 'חסר'}</dd>
<dt>אנשי קשר שאושרו</dt>
<dd>${d.contactsConfirmed}</dd>
<dt>עמיתים שאושרו</dt>
<dd>${d.colleaguesConfirmed}</dd>
</dl>
<p class="muted">העסק נחתם — מעכשיו בעל העסק מעדכן את הפרטים האלה.</p>
</section>`;
  }
  return `<section class="card">
<h2>פרטי הקמה</h2>
<form method="post" action="/businesses/${id}/setup">
  <input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
  <label>מספר הוואטסאפ של בעל העסק<input type="text" name="boss" value="${esc(setup.bossWhatsapp ?? '')}" dir="ltr" placeholder="+972..."></label>
  <h3>אנשי קשר</h3>
  ${personTable('contact', setup.contacts)}
  <h3>עמיתים</h3>
  ${personTable('colleague', setup.colleagues)}
  <p class="muted">שורה ריקה לא נשמרת. לשורות נוספות — שמור, והטופס יציג שורות ריקות חדשות.</p>
  <button type="submit">שמירת פרטי ההקמה</button>
</form>
</section>`;
}

export interface BusinessPageExtras {
  /**
   * What the technician typed, while the business has not signed; `'locked'`
   * once it has (then only set/missing and counts are shown).
   */
  setup: PanelSetupData | 'locked';
  /** The owner dashboard's public base URL, for the mailbox row's link. */
  dashboardBaseUrl: string;
  /** The active charter's currency, or `null` without a (readable) charter. */
  currency: string | null;
  /** A refusal or note to show at the top (an invite or status action). */
  error?: string;
}

export function renderBusinessPage(viewer: PanelViewer, d: PanelBusinessDetail, extras: BusinessPageExtras): string {
  const id = esc(d.businessId);
  const unsigned = extras.setup !== 'locked';
  const addressLine =
    extras.setup === 'locked'
      ? d.addressSet
        ? 'מוגדרת'
        : 'חסרה'
      : extras.setup.address === null
        ? 'חסרה'
        : esc(extras.setup.address);
  const csrfField = `<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">`;
  // Address and logo are the technician's to set only until the owner signs.
  const profileForms = !unsigned
    ? ''
    : `<form method="post" action="/businesses/${id}/profile">
  ${csrfField}
  <label>כתובת<input type="text" name="address" value="${esc(extras.setup === 'locked' ? '' : (extras.setup.address ?? ''))}"></label>
  <button type="submit">שמירת הכתובת</button>
</form>
<form method="post" action="/businesses/${id}/logo" enctype="multipart/form-data">
  ${csrfField}
  <label>לוגו (PNG או JPEG, עד 1MB)<input type="file" name="logo" accept="image/png,image/jpeg"></label>
  <button type="submit">העלאת הלוגו</button>
</form>`;
  const ownerActions = !d.ownerExists
    ? ''
    : `<form method="post" action="/businesses/${id}/reset-link">
  ${csrfField}
  <button type="submit">קישור לאיפוס סיסמה</button>
</form>
<form method="post" action="/businesses/${id}/totp-reset">
  ${csrfField}
  <button type="submit">איפוס Google Authenticator של בעל העסק</button>
  <p class="muted">בעל העסק ינותק מכל המכשירים ויחבר את האפליקציה מחדש בכניסה הבאה.</p>
</form>`;
  const whatsappForm = `<form method="post" action="/businesses/${id}/whatsapp">
  ${csrfField}
  <label>מזהה החשבון<input type="text" name="instanceId" autocomplete="off" dir="ltr" required></label>
  <label>אסימון<input type="password" name="token" autocomplete="off" dir="ltr" required></label>
  <button type="submit">שמירה</button>
</form>`;
  const connectionsLink = `${extras.dashboardBaseUrl.replace(/\/+$/, '')}/connections`;
  const owner = d.ownerExists
    ? `בעל העסק נכנס · Google Authenticator ${d.ownerEnrolled ? 'מחובר' : 'עדיין לא מחובר'}`
    : 'בעל העסק עדיין לא נכנס';
  const inviteForm = d.ownerExists
    ? ''
    : `<form method="post" action="/businesses/${id}/invite">
  <input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
  <label>מייל הכניסה של בעל העסק<input type="email" name="email" required dir="ltr"></label>
  <button type="submit">שליחת הזמנה חדשה</button>
  <p class="muted">הזמנה חדשה מבטלת כל הזמנה קודמת שעוד לא נוצלה.</p>
</form>`;
  const statusForm =
    d.status === 'active'
      ? `<form method="post" action="/businesses/${id}/suspend"><input type="hidden" name="csrf" value="${esc(viewer.csrf)}"><button type="submit">השעיית העסק</button></form>`
      : `<form method="post" action="/businesses/${id}/resume"><input type="hidden" name="csrf" value="${esc(viewer.csrf)}"><button type="submit">החזרת העסק לפעילות</button></form>`;
  const people = d.contactsPending + d.colleaguesPending + d.contactsConfirmed + d.colleaguesConfirmed;
  const s = d.snapshot;
  const cost = extras.currency === null ? '—' : esc(formatMinor(s.spendTodayMinor, extras.currency));
  return page(
    d.displayName,
    `<h1>${esc(d.displayName)} <span class="muted">${id}</span></h1>
<p>${esc(businessStateLabel(d))}</p>
${errorBlock(extras.error)}
<section class="card">
<h2>1 · פתיחת עסק</h2>
<dl>
<dt>שם העסק</dt>
<dd>${esc(d.displayName)}</dd>
<dt>כתובת</dt>
<dd>${addressLine}</dd>
<dt>לוגו</dt>
<dd>${d.logoSet ? 'הועלה' : 'חסר'}</dd>
<dt>בעל העסק</dt>
<dd>${esc(owner)}</dd>
</dl>
${profileForms}
${inviteForm}
${ownerActions}
</section>
<section class="card">
<h2>2 · חיבורים בסיסיים (נדרשים כדי להתחיל לעבוד)</h2>
<table>
<tr><td>וואטסאפ</td><td>${d.whatsappSaved ? '✓ שמור' : '—'}</td></tr>
<tr><td>מספר הוואטסאפ של בעל העסק</td><td>${tick(d.bossNumberSet)}</td></tr>
<tr><td>תיבת המייל</td><td>${d.mailboxConnected ? 'מחובר' : 'לא מחובר'} · <span class="muted">${esc(`שלח לבעל העסק את הקישור: ${connectionsLink}`)}</span></td></tr>
<tr><td>אנשי קשר ועמיתים</td><td>${tick(people > 0)}</td></tr>
</table>
<p class="muted">${d.basicDone}/${d.basicTotal}</p>
<h3>וואטסאפ</h3>
${whatsappForm}
</section>
${setupSection(viewer, d, extras.setup)}
<section class="card">
<h2>3 · חיבור למערכות (פותח עבודה מלאה)</h2>
${renderExternalStatusTable(d.businessId, d.externalSystems)}
<p><a href="/businesses/${id}/external">ניהול מערכות חיצוניות</a></p>
</section>
<section class="card">
<h2>תמונת מצב</h2>
<dl>
<dt>משימות ב-7 ימים</dt>
<dd>${s.jobsLast7Days}</dd>
<dt>אישורים ממתינים</dt>
<dd>${s.pendingApprovals}</dd>
<dt>עלות היום</dt>
<dd>${cost}</dd>
<dt>פעילות אחרונה</dt>
<dd>${esc(formatWhen(s.lastActivityAt))}</dd>
<dt>כשלים ב-7 ימים</dt>
<dd>${s.failedLast7Days}</dd>
</dl>
</section>
<section class="card">
${statusForm}
</section>`,
    viewer,
  );
}

// ---------------------------------------------------------------------------
// External systems (Stage D) — status only
// ---------------------------------------------------------------------------

/** One Hebrew label per state; a new state is a compile error until it is named here. */
export const EXTERNAL_STATE_LABELS: Record<ExternalSystemPanelState, string> = {
  draft: 'טיוטה',
  awaiting_signature: 'ממתין לחתימה',
  signed: 'חתום',
  unsigned_changes: 'שינויים לא חתומים',
};

/** `✓ שמור` / `חסר`, or `—` where the definition does not need the secret. */
export function secretCell(saved: boolean | null): string {
  return saved === null ? '—' : saved ? '✓ שמור' : 'חסר';
}

/**
 * Per system: its id, its state and which secrets are saved — flags from
 * `businessDetailForPanel`, never a label or anything a system returned.
 */
export function renderExternalStatusTable(businessId: string, systems: ExternalSystemPanelStatus[]): string {
  if (systems.length === 0) return '<p class="muted">עדיין לא הוגדרה מערכת.</p>';
  const rows = systems
    .map(
      (s) =>
        `<tr><td dir="ltr"><a href="/businesses/${esc(businessId)}/external/${esc(s.systemId)}">${esc(s.systemId)}</a></td><td>${esc(EXTERNAL_STATE_LABELS[s.state])}</td><td>${secretCell(s.keySaved)}</td><td>${secretCell(s.hookSaved)}</td><td>${secretCell(s.verifySaved)}</td></tr>`,
    )
    .join('\n');
  return `<table>
<thead><tr><th>מערכת</th><th>מצב</th><th>סוד</th><th>חתימת התראות</th><th>אסימון אימות</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

export function renderForbidden(): string {
  return page('הבקשה נדחתה', '<h1>הבקשה נדחתה</h1><p>הטופס פג תוקף. רענן את העמוד ונסה שוב.</p>');
}

export function renderNotFound(): string {
  return page('לא נמצא', '<h1>לא נמצא</h1>');
}

export function renderServerError(): string {
  return page('שגיאה', '<h1>שגיאה</h1><p>משהו השתבש. נסה שוב בעוד רגע.</p>');
}

export function renderTooLarge(message?: string): string {
  const detail = message === undefined ? '' : `<p class="error">${esc(message)}</p>`;
  return page('הבקשה גדולה מדי', `<h1>הבקשה גדולה מדי</h1>${detail}`);
}

// ---------------------------------------------------------------------------
// Staff management and the activity log
// ---------------------------------------------------------------------------

export const STAFF_NOT_HEAD = 'רק מנהל ראשי יכול לנהל את הצוות.';
export const STAFF_NOT_FOUND = 'איש הצוות לא נמצא או כבר הוסר.';
export const STAFF_LINK_COPY =
  'העתק את הקישור ושלח אותו לאיש הצוות. הקישור תקף ל-72 שעות ולשימוש אחד ולא יוצג שוב.';

/** One Hebrew label per action kind; a new kind is a compile error until it is named here. */
export const STAFF_ACTION_LABELS: Record<StaffAction, string> = {
  business_open: 'פתיחת עסק',
  business_suspend: 'השעיית עסק',
  business_resume: 'חידוש עסק',
  whatsapp_saved: 'שמירת חיבור וואטסאפ',
  setup_package_saved: 'שמירת חבילת הקמה',
  profile_saved: 'שמירת פרופיל העסק',
  logo_saved: 'שמירת לוגו',
  invite_issued: 'הנפקת הזמנה לבעל עסק',
  reset_issued: 'הנפקת קישור איפוס לבעל עסק',
  totp_reset: 'איפוס Authenticator',
  staff_invited: 'הזמנת איש צוות',
  staff_removed: 'הסרת איש צוות',
  staff_link_reissued: 'הנפקת קישור סיסמה לאיש צוות',
  external_draft_saved: 'שמירת טיוטת מערכת חיצונית',
  external_draft_deleted: 'מחיקת טיוטת מערכת חיצונית',
  external_secret_saved: 'שמירת סוד של מערכת חיצונית',
};

export interface StaffPageOptions {
  error?: string;
  /** The just-issued invite link: shown on the response to the POST that made it, never again. */
  inviteLink?: string;
  values?: { name: string; email: string };
}

export function renderStaffPage(viewer: PanelViewer, staff: StaffListing[], options: StaffPageOptions = {}): string {
  const form = (action: string, label: string): string =>
    `<form method="post" action="${esc(action)}" style="display:inline"><input type="hidden" name="csrf" value="${esc(viewer.csrf)}"><button type="submit">${esc(label)}</button></form>`;
  const rows = staff
    .map((s) => {
      const actions =
        viewer.isHead && !s.removed
          ? `${form(`/staff/${s.staffId}/reset-factor`, 'איפוס Authenticator')} ${form(`/staff/${s.staffId}/remove`, 'הסרה')}`
          : '';
      return `<tr><td>${escLabel(s.displayName)}</td><td dir="ltr">${esc(s.login)}</td><td>${s.isHead ? 'מנהל ראשי' : 'צוות'}</td><td>${s.enrolled ? '✓' : '—'}</td><td>${s.removed ? 'הוסר' : ''}</td><td>${actions}</td></tr>`;
    })
    .join('\n');
  const link =
    options.inviteLink === undefined
      ? ''
      : `<div class="card"><p>${esc(STAFF_LINK_COPY)}</p><p><code dir="ltr" class="invite-link">${esc(options.inviteLink)}</code></p></div>`;
  const v = options.values ?? { name: '', email: '' };
  const add = viewer.isHead
    ? `<div class="card"><h2>הוספת איש צוות</h2>
<form method="post" action="/staff/invite">
  <input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
  <label>שם<input type="text" name="name" value="${esc(v.name)}" required></label>
  <label>כתובת מייל<input type="email" name="email" value="${esc(v.email)}" required dir="ltr"></label>
  <button type="submit">הוספה</button>
</form></div>`
    : '';
  return page(
    'צוות',
    `<h1>צוות</h1>
${errorBlock(options.error)}
${link}
<table>
<thead><tr><th>שם</th><th>כניסה</th><th>תפקיד</th><th>Authenticator</th><th>מצב</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
${add}`,
    viewer,
  );
}

export function renderStaffRefused(viewer: PanelViewer): string {
  return page('אין הרשאה', `<h1>אין הרשאה</h1><p class="error">${esc(STAFF_NOT_HEAD)}</p>`, viewer);
}

export function renderActivityLog(viewer: PanelViewer, rows: StaffActionRow[]): string {
  const body =
    rows.length === 0
      ? '<p class="muted">עדיין אין פעולות.</p>'
      : `<table>
<thead><tr><th>זמן</th><th>איש צוות</th><th>פעולה</th><th>עסק</th></tr></thead>
<tbody>
${rows
  .map(
    (r) =>
      `<tr><td>${esc(formatWhen(r.at))}</td><td>${escLabel(r.staffDisplayName)}</td><td>${esc(STAFF_ACTION_LABELS[r.action])}</td><td>${r.businessId === null ? '—' : esc(r.businessId)}</td></tr>`,
  )
  .join('\n')}
</tbody>
</table>`;
  return page('יומן פעולות', `<h1>יומן פעולות</h1>\n${body}`, viewer);
}
