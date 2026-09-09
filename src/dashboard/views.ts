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
import type { IntentName } from '../domain/reading.js';
import type { ReadingSummary } from './readings-list.js';
import { isDocumentDecisionIntent } from './signable-intents.js';
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

/**
 * Unicode's bidirectional formatting controls, removed from a value before it
 * is escaped and rendered.
 *
 * `escapeHtml` neutralises markup and nothing else, which is correct for
 * every other field on these pages. It is not enough for a document's
 * `original_name`: that string is stored verbatim from whoever sent the file
 * (by design — it is inert as a path), and it is the label the owner reads
 * when deciding whether to sign. On an RTL page a right-to-left override can
 * make `invoice‮gpj.exe` render as `invoiceexe.jpg`, so a name that
 * *looks* like the document the owner is expecting can be a different one.
 * Stripping the controls does not make the name trustworthy — nothing can —
 * which is why the sign form shows a prefix of the file's own hash beside it.
 *
 * `esc` itself is deliberately left alone: many call sites depend on it, and
 * a display field is the only place where dropping characters is the right
 * trade.
 *
 * The set: U+061C ALM, U+200E/U+200F LRM/RLM, U+202A-U+202E (the embedding
 * and override family), U+2066-U+2069 (the isolate family).
 */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

function escLabel(value: string): string {
  return esc(value.replace(BIDI_CONTROLS, ''));
}

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
<p><a href="/instruct">מה לעשות</a> · <a href="/readings">מה קראתי</a></p>
${list}`,
  );
}

const STANCE_LABEL: Record<string, string> = {
  act: 'מציעה לפעול',
  advise_against: 'ממליצה שלא',
  ask: 'יש לי שאלה',
  no_action: 'אין מה לעשות',
};

/**
 * What the assistant read, and what it concluded — every reading, whether or
 * not its proposal carries an action.
 *
 * Read-only. No form, no button that decides anything: deciding lives on the
 * approval card, which carries expiry, decision, signing and audit. A second
 * screen that decided would be a second path to the same table.
 *
 * `escLabel` on the filename for the same reason the approval card uses it:
 * `original_name` is stored verbatim from whoever sent the file, and bidi
 * control characters make a name render as something other than what it is.
 */
export function renderReadings(rows: ReadingSummary[], csrf: string): string {
  const items = rows
    .map((r) => {
      const stance = r.stance === null ? '' : (STANCE_LABEL[r.stance] ?? r.stance);
      const reasons = r.reasons.map((t) => `<li>${esc(t)}</li>`).join('');
      // M2: three cases, not two. A missing card because the stance proposed
      // nothing is an ordinary outcome; a missing card for a proposal that
      // DID propose something is a gap the owner should be told about
      // instead of being assured there was nothing to approve.
      const link =
        r.approvalId !== null
          ? `<a href="/a/${esc(r.approvalId)}">לכרטיס האישור</a>`
          : r.hasAction
            ? '<span class="muted">הוצעה פעולה, אך לא נוצר עבורה כרטיס אישור.</span>'
            : '<span class="muted">אין כרטיס — אין פעולה לאשר</span>';
      return `
        <article class="card">
          <h3>${escLabel(r.originalName)} <span class="hash">${esc(r.sha256.slice(0, HASH_PREFIX_LENGTH))}</span></h3>
          <p class="when">${esc(r.readAt)}</p>
          <p>${esc(r.summary)}</p>
          ${stance === '' ? '' : `<p class="stance"><strong>${esc(stance)}</strong>${r.headline === null ? '' : ` — ${esc(r.headline)}`}</p>`}
          ${reasons === '' ? '' : `<ul>${reasons}</ul>`}
          <p>${link}</p>
        </article>`;
    })
    .join('');

  return page(
    'מה קראתי',
    `<header>
  <h1>מה קראתי</h1>
  ${logoutForm(csrf)}
</header>
<p><a href="/">&rarr; חזרה לרשימה</a></p>
<p class="muted">כל מסמך שנקלט ונקרא, ומה שהוסק ממנו. המסך הזה מציג בלבד — הכרעה נעשית בכרטיס האישור.</p>
${rows.length === 0 ? '<p>עדיין לא נקרא אף מסמך.</p>' : items}`,
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
 * How much of `documents.sha256` the card shows. Twelve hex characters is
 * 48 bits — far past what anyone will collide by accident among one
 * business's documents, and short enough that the owner can actually compare
 * it against a hash they were sent.
 */
const HASH_PREFIX_LENGTH = 12;

/**
 * The document behind this card, shown for what it is.
 *
 * Rendered whenever a document resolves, whether or not the card may be
 * signed. A card raised about a document should say which document — and
 * before this the only place that information appeared was inside the sign
 * form, so removing the form on a non-signable card would have taken the
 * document off the page along with it.
 *
 * `originalName` is a sender-chosen string, and the one field on these pages
 * that goes through `escLabel` rather than `esc`: it is the label the owner
 * reads, and `esc` alone leaves bidi overrides intact (see `escLabel`).
 * Beside it goes a prefix of `documents.sha256` — the re-hash at signing time
 * proves the bytes did not change, but without this nothing on the card is
 * derived from those bytes at all, so the owner is told "unchanged" about a
 * document identified only by a name its sender chose.
 */
function documentBlock(document: DocumentRecord): string {
  return `<div class="card">
  <h3>המסמך שהבקשה נוגעת אליו</h3>
  <p>${escLabel(document.originalName)}</p>
  <p class="muted">טביעת האצבע של הקובץ (12 התווים הראשונים): <code>${esc(document.sha256.slice(0, HASH_PREFIX_LENGTH))}</code></p>
</div>`;
}

/**
 * A third form, posting to `/a/:id/sign`.
 *
 * Rendered only when a document resolves **and** the proposal's intent is one
 * of `DOCUMENT_DECISION_INTENTS` — an allowlist, defaulting to no form. See
 * `signable-intents.ts` for why each member is on it and why the other nine
 * are not; the short version is that this form's own text asserts the document
 * was accepted as binding, and the row it writes cannot be undone, so it may
 * not ride along on a card whose real subject is an email.
 *
 * `documentId` travels as a hidden field so the route can refuse a sign
 * whose form named a different document than the one it is about to verify
 * and stamp — the card resolves the document once when it renders, and the
 * POST resolves it again; without this, the two resolutions could disagree.
 *
 * `noteValue` mirrors the approve form's own reasoning: a refusal that
 * resets what the owner typed is losing their work by half.
 *
 * `signError` is deliberately NOT a parameter here. Three of the route's sign
 * refusals — the approval is already decided, no document is behind it at
 * all, or the proposal is not a document decision — have no form to render a
 * message inside, so an error block living in here would silently vanish
 * exactly on those (a regression caught in round-2 review: the "no document"
 * case used to render, misplaced, in the approve form — after this file's
 * first pass it rendered nowhere at all). `renderApprovalCard` renders
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
    <p class="muted">חתימה מאשרת את הבקשה וקובעת שהמסמך "${escLabel(document.originalName)}" נתקבל כמחייב.</p>
    <label>הערה (רשות)<textarea name="note" rows="2">${esc(noteValue)}</textarea></label>
    <button type="submit">חתום ואשר</button>
  </form>`;
}

export function renderApprovalCard(options: {
  approval: ApprovalRequest;
  csrf: string;
  document?: DocumentRecord;
  /**
   * The intent of the proposal action behind `document`, when one resolved.
   *
   * Only a member of `DOCUMENT_DECISION_INTENTS` gets the sign form. Absent,
   * `null`, or a value the enum does not know all mean no form — which is the
   * whole point of writing this as an allowlist: the safe answer is the
   * default, not a case somebody has to remember to handle.
   */
  documentIntent?: IntentName | null;
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
${options.document ? documentBlock(options.document) : ''}
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
  ${options.document && isDocumentDecisionIntent(options.documentIntent ?? null) ? signForm(approval.approvalId, options.csrf, options.document, noteValue) : ''}
</div>`,
  );
}

/**
 * The instruction box.
 *
 * One field and one button. The note under it is not decoration: an
 * instruction is its own approval, and the owner should know that before they
 * type, not discover it afterwards.
 *
 * `grantNote` is `runInstruction`'s explanation for exactly one situation: a
 * plan spanning more than one action class, which authorises nothing at all
 * (see `grantForPlan` in `instruct.ts`). Without showing it, the owner is
 * bounced to the pending list and later meets an approval card for something
 * they believed the instruction already covered, with no sentence anywhere
 * saying why the shortcut did not apply — so it renders beside the error, not
 * folded into it, since the two can never occur together (a `grantNote` only
 * ever accompanies a `planned` outcome, an `error` only ever a `refused` one).
 *
 * The clarifying question goes through `escLabel`, not `esc`: it is
 * model-composed text reaching an RTL page, the same category `escLabel` was
 * written for (see its own docblock). Every instruction is owner-typed today,
 * so the exposure is low, but it is the second model-authored string to reach
 * a screen and the cheap decision is to treat it that way from the start.
 */
export function renderInstruct(options: {
  csrf: string;
  error?: string;
  pending?: { jobId: string; question: string } | null;
  grantNote?: string | null;
}): string {
  const error =
    options.error === undefined ? '' : `<p class="error">${esc(options.error)}</p>`;

  const grantNote =
    options.grantNote == null ? '' : `<p class="muted">${esc(options.grantNote)}</p>`;

  const pending =
    options.pending == null
      ? ''
      : `<article class="card">
           <h3>שאלה לפני שאמשיך</h3>
           <p>${escLabel(options.pending.question)}</p>
           <form method="POST" action="/instruct/${esc(options.pending.jobId)}/answer">
             <input type="hidden" name="csrf" value="${esc(options.csrf)}">
             <textarea name="answer" rows="2" required></textarea>
             <button>לענות ולהמשיך</button>
           </form>
         </article>`;

  return page(
    'מה לעשות',
    `<h1>מה לעשות</h1>
     ${error}
     ${grantNote}
     ${pending}
     <form method="POST" action="/instruct">
       <input type="hidden" name="csrf" value="${esc(options.csrf)}">
       <textarea name="text" rows="4" maxlength="4000" required
                 placeholder="למשל: תשלחי לדנה dana@example.com את ההצעה"></textarea>
       <button>שלח</button>
     </form>
     <p class="muted">
       מה שתכתוב כאן נרשם כהוראה שלך, ואני נשענת עליה במקום לשאול שוב על אותו דבר.
       בשלב הנוכחי זה עדיין לא חוסך לך שאלות בפועל: כל פעולה שיוצאת החוצה עוצרת
       לאישור שלך ממילא, עד שתעלה את רמת האוטונומיה של אותו סוג פעולה.
       פעולה שנוגעת בכסף, חתימה על חוזה, או נמען שלא נקבת בכתובתו — יעצרו וישאלו תמיד.
     </p>
     <p><a href="/">לכרטיסי האישור</a> · <a href="/readings">מה קראתי</a></p>
     ${logoutForm(options.csrf)}`,
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
