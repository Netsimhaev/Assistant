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

const esc = escapeHtml;

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
<div><span class="muted">${esc(viewer.displayName)}${viewer.isHead ? ' (מנהל ראשי)' : ''}</span>
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

/** The signed-in landing page. The business list replaces its body (Task 9). */
export function renderHome(viewer: PanelViewer): string {
  return page('פאנל המנהל', `<h1>שלום, ${esc(viewer.displayName)}</h1>\n<p class="muted">רשימת העסקים תופיע כאן.</p>`, viewer);
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

export function renderTooLarge(): string {
  return page('הבקשה גדולה מדי', '<h1>הבקשה גדולה מדי</h1>');
}
