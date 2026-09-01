/**
 * Server-rendered HTML. No client framework, no build step — every screen is
 * a template literal returned as a complete document.
 *
 * `escapeHtml` is the one place any value coming from anywhere other than
 * this file's own literal strings is allowed to reach the page. Approval
 * payloads are attacker-influenced content — an email body, a supplier's
 * product name, a document a stranger sent — and this module is where that
 * text reaches a browser. Every interpolated value goes through it, without
 * exception; nothing here is "safe enough" to skip it, including values that
 * happen to come from a closed enum today, because a card is exactly the
 * kind of file where "this one's always safe" quietly stops being true.
 */
import type { ApprovalRequest } from '../governance/approvals.js';
import type { DocumentRecord } from '../documents/types.js';
import { formatMinor } from '../util/money.js';

/** The one escaping helper. Stringifies first (so numbers, booleans, `null` are safe to pass too), then escapes. */
export function escapeHtml(value: unknown): string {
  const str =
    typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const esc = escapeHtml;

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; gap: 1rem; flex-wrap: wrap; }
  .card { border: 1px solid #8884; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem; }
  .muted { opacity: 0.7; font-size: 0.9em; }
  .error { color: #c0392b; font-weight: bold; }
  pre { white-space: pre-wrap; word-break: break-word; background: #8881; padding: 0.75rem; border-radius: 0.4rem; }
  label { display: block; margin-top: 0.75rem; }
  input[type="text"], input[type="password"], textarea { width: 100%; box-sizing: border-box; padding: 0.4rem; margin-top: 0.2rem; }
  button { margin-top: 1rem; padding: 0.5rem 1.2rem; cursor: pointer; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-start; }
  .row form { flex: 1 1 16rem; }
  .edit-form textarea[name="input"] { font-family: ui-monospace, monospace; font-size: 0.9em; }
  .band-routine { color: #2e7d32; }
  .band-sensitive { color: #ef6c00; }
  .band-anomalous, .band-blocked { color: #c0392b; }
`;

function page(title: string, body: string): string {
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
${body}
</body>
</html>`;
}

function logoutForm(csrf: string): string {
  return `<form method="post" action="/logout" style="display:inline">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <button type="submit">התנתקות</button>
</form>`;
}

export function renderLogin(options: { error?: string } = {}): string {
  const errorBlock = options.error ? `<p class="error">${esc(options.error)}</p>` : '';
  return page(
    'התחברות',
    `<h1>עוזרת אישית — כניסה</h1>
${errorBlock}
<div class="card">
<h2>סיסמה</h2>
<form method="post" action="/login">
  <label>שם משתמש<input type="text" name="username" autocomplete="username" required></label>
  <label>סיסמה<input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">כניסה</button>
</form>
</div>
<div class="card">
<h2>קוד שחזור</h2>
<p class="muted">איבדת את הסיסמה? קוד שחזור חד-פעמי נכנס כאן במקומה, ומחייב קביעת סיסמה חדשה מיד.</p>
<form method="post" action="/login">
  <label>שם משתמש<input type="text" name="username" autocomplete="username" required></label>
  <label>קוד שחזור<input type="text" name="code" autocomplete="off" required></label>
  <button type="submit">כניסה עם קוד</button>
</form>
</div>`,
  );
}

/**
 * `requireCurrent` is false on exactly one path: the forced change right
 * after a recovery-code login, where by definition the owner does not have a
 * current password to type. Everywhere else the field is mandatory — see
 * `verifyCurrentPassword` for why.
 */
export function renderPasswordChange(options: {
  csrf: string;
  requireCurrent: boolean;
  error?: string;
}): string {
  const errorBlock = options.error ? `<p class="error">${esc(options.error)}</p>` : '';
  const intro = options.requireCurrent
    ? '<p class="muted">להחלפת הסיסמה יש להזין את הסיסמה הנוכחית.</p>'
    : '<p class="muted">הכניסה בוצעה עם קוד שחזור. יש לקבוע סיסמה חדשה לפני שאפשר להמשיך.</p>';
  const currentField = options.requireCurrent
    ? '<label>סיסמה נוכחית<input type="password" name="current" autocomplete="current-password" required></label>'
    : '';
  return page(
    'קביעת סיסמה חדשה',
    `<h1>${options.requireCurrent ? 'החלפת סיסמה' : 'נדרשת סיסמה חדשה'}</h1>
${intro}
${errorBlock}
<form method="post" action="/password">
  <input type="hidden" name="csrf" value="${esc(options.csrf)}">
  ${currentField}
  <label>סיסמה חדשה<input type="password" name="password" autocomplete="new-password" required></label>
  <label>אימות סיסמה<input type="password" name="confirm" autocomplete="new-password" required></label>
  <button type="submit">קביעת סיסמה</button>
</form>`,
  );
}

function bandLabel(band: string): string {
  const labels: Record<string, string> = {
    routine: 'שגרתי',
    sensitive: 'רגיש',
    anomalous: 'חריג',
    blocked: 'חסום',
  };
  return labels[band] ?? band;
}

function summaryRow(approval: ApprovalRequest): string {
  const amount = formatMinor(approval.risk.dimensions.money.amountMinor, 'ILS');
  return `<div class="card">
  <div class="row" style="justify-content:space-between">
    <strong><a href="/a/${esc(approval.approvalId)}">${esc(approval.summary)}</a></strong>
    <span class="band-${esc(approval.risk.band)}">${esc(bandLabel(approval.risk.band))}</span>
  </div>
  <div class="muted">${esc(approval.actionClass)} · ${esc(amount)} · פג תוקף ${esc(approval.expiresAt)}</div>
</div>`;
}

export function renderPendingList(options: {
  approvals: ApprovalRequest[];
  remainingCodes: number;
  csrf: string;
}): string {
  const list =
    options.approvals.length === 0
      ? '<p class="muted">אין בקשות ממתינות.</p>'
      : options.approvals.map(summaryRow).join('\n');

  return page(
    'בקשות ממתינות',
    `<header>
  <h1>בקשות ממתינות</h1>
  ${logoutForm(options.csrf)}
</header>
<p class="muted">קודי שחזור שנותרו: ${esc(options.remainingCodes)}</p>
${list}`,
  );
}

/**
 * `editValue` is the raw text to put back in the textarea — used only when a
 * submitted edit failed to parse, so the owner sees exactly what they typed
 * (not the reformatted original) alongside the error. Absent, it defaults to
 * the stored payload pretty-printed. Either way it goes through `esc()`
 * before it reaches a `<textarea>`: element content has different escaping
 * needs than an attribute value, but the one escaper here handles both —
 * what matters is that nothing skips it.
 *
 * `noteValue` mirrors the same reasoning: a 400 that resets the note the
 * owner already typed, right next to the payload it took such care to
 * preserve, is losing their work by half.
 */
/**
 * A third form, posting to `/a/:id/sign`, appears only when `document` is
 * supplied — the same rule the route follows when deciding whether to accept
 * a POST there at all. `originalName` is a sender-chosen string, so it goes
 * through `esc` like everything else in this file.
 *
 * `documentId` travels as a hidden field so the route can refuse a sign
 * whose form named a different document than the one it is about to verify
 * and stamp — the card resolves the document once when it renders, and the
 * POST resolves it again; without this, the two resolutions could disagree.
 *
 * `noteValue` mirrors the approve form's own reasoning: a refusal that
 * resets what the owner typed is losing their work by half.
 *
 * `signError` is deliberately NOT a parameter here. Two of the route's sign
 * refusals — the approval is already decided, or no document is behind it
 * at all — have no `document` to render this form with, so an error block
 * living inside `signForm` would silently vanish exactly on those two
 * refusals (a regression caught in round-2 review: the "no document" case
 * used to render, misplaced, in the approve form — after this file's first
 * pass it rendered nowhere at all). `renderApprovalCard` renders
 * `signError` itself, unconditionally, before deciding whether `signForm`
 * exists.
 */
function signForm(
  approvalId: string,
  csrf: string,
  document: DocumentRecord,
  noteValue: string,
): string {
  return `<form method="post" action="/a/${esc(approvalId)}/sign">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="documentId" value="${esc(document.documentId)}">
    <p class="muted">חתימה מאשרת את הבקשה וקובעת שהמסמך "${esc(document.originalName)}" נתקבל כמחייב.</p>
    <label>הערה (רשות)<textarea name="note" rows="2">${esc(noteValue)}</textarea></label>
    <button type="submit">חתום ואשר</button>
  </form>`;
}

export function renderApprovalCard(options: {
  approval: ApprovalRequest;
  csrf: string;
  document?: DocumentRecord;
  editValue?: string;
  noteValue?: string;
  error?: string;
  /**
   * A refusal that belongs to the sign action, not the approve form (see
   * `signForm`'s docblock). Rendered at card level, unconditionally — NOT
   * inside `signForm`, because two of the route's sign refusals (already
   * decided; no document at all) have no document to render that form with,
   * and this text must still reach the owner when they don't.
   */
  signError?: string;
}): string {
  const { approval } = options;
  const editValue = options.editValue ?? JSON.stringify(approval.proposedInput, null, 2);
  const noteValue = options.noteValue ?? '';
  const errorBlock = options.error ? `<p class="error">${esc(options.error)}</p>` : '';
  const signErrorBlock = options.signError ? `<p class="error">${esc(options.signError)}</p>` : '';
  const risk = approval.risk;

  return page(
    approval.summary,
    `<header>
  <h1>בקשה לאישור</h1>
  ${logoutForm(options.csrf)}
</header>
<p><a href="/">&rarr; חזרה לרשימה</a></p>
<div class="card">
  <h2>${esc(approval.summary)}</h2>
  <p>${esc(approval.detail)}</p>
  <table>
    <tr><td class="muted">כלי</td><td>${esc(approval.proposedTool)}</td></tr>
    <tr><td class="muted">סוג פעולה</td><td>${esc(approval.actionClass)}</td></tr>
    <tr><td class="muted">סיכון</td><td class="band-${esc(risk.band)}">${esc(bandLabel(risk.band))} (${esc(risk.total)}) — ${esc(risk.explanation)}</td></tr>
    <tr><td class="muted">סכום</td><td>${esc(formatMinor(risk.dimensions.money.amountMinor, 'ILS'))}</td></tr>
    <tr><td class="muted">נוצר</td><td>${esc(approval.createdAt)}</td></tr>
    <tr><td class="muted">פג תוקף</td><td>${esc(approval.expiresAt)}</td></tr>
  </table>
</div>
${signErrorBlock}
<div class="row">
  <form method="post" action="/a/${esc(approval.approvalId)}/approve" class="edit-form">
    <input type="hidden" name="csrf" value="${esc(options.csrf)}">
    <label>תוכן מוצע (ניתן לעריכה לפני אישור)
      <textarea name="input" rows="12" spellcheck="false">${esc(editValue)}</textarea>
    </label>
    <p class="muted">עריכת התוכן לפני האישור מריצה את הגרסה הערוכה. השארה כפי שהיא מאשרת את מה שתוכנן. שים לב: חלק מהערכים (כגון פרטי התחברות) מוסתרים לפני שהפעולה יוצאת החוצה, גם אם הם מוצגים כאן במלואם — עריכה שלהם לא תשפיע על מה שבפועל יישלח.</p>
    ${errorBlock}
    <label>הערה (רשות)<textarea name="note" rows="2">${esc(noteValue)}</textarea></label>
    <button type="submit">אישור</button>
  </form>
  <form method="post" action="/a/${esc(approval.approvalId)}/deny">
    <input type="hidden" name="csrf" value="${esc(options.csrf)}">
    <label>הערה (רשות)<textarea name="note" rows="2"></textarea></label>
    <button type="submit">דחייה</button>
  </form>
  ${options.document ? signForm(approval.approvalId, options.csrf, options.document, noteValue) : ''}
</div>`,
  );
}

export function renderNotFound(): string {
  return page('לא נמצא', '<h1>404</h1><p>הדף המבוקש אינו קיים.</p>');
}

export function renderForbidden(): string {
  return page('אסור', '<h1>403</h1><p>הבקשה נדחתה.</p>');
}

export function renderServerError(): string {
  return page('שגיאה', '<h1>500</h1><p>אירעה שגיאה. נסה שוב.</p>');
}
