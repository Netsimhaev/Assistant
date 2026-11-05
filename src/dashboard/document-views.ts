/**
 * The document screens (document production §4, §8.1, D13): the list of
 * cards, one card, and the settings page. Pure rendering; the handlers in
 * `document-routes.ts` read and decide.
 *
 * Everything a card carries can originate in text a stranger wrote — a
 * source document's name, a spec title the drafter wrote from it, a check's
 * detail quoting the spec, the echo of a plan step — so every such string
 * goes through `escLabel` (bidi controls stripped before escaping), and the
 * echo keeps its line structure in a `pre-wrap` block, its continuation
 * margin being what stops a value's line from passing for a line of the card.
 *
 * The buttons are positive: a "שלחי ל…" button exists only for a `send`
 * option the card actually holds, and the card holds one only for a
 * production that passed both checks (`buildDeliveryOptions`). A card that
 * did not pass shows "לא עבר בדיקה", its findings, and a save option carrying
 * the warning — never a send.
 */
import { documentCardStateLabel, documentKindLabel, trustLevelLabel } from '../domain/labels.js';
import type { DocumentKind } from '../domain/document-spec.js';
import type { CardState, DeliveryOption } from '../production/card.js';
import { escLabel, escapeHtml as esc, page } from './views.js';

const STYLE = `<style>
  nav a { margin-inline-end: 0.6rem; }
  .doc { border: 1px solid #8884; border-radius: 0.5rem; padding: 0.6rem 0.9rem; margin-bottom: 0.7rem; }
  .doc.new { border-color: #2e7d32; }
  .failed { color: #c0392b; font-weight: bold; }
  .ok { color: #2e7d32; }
  .echo { white-space: pre-wrap; word-break: break-word; background: #8881; padding: 0.5rem; border-radius: 0.4rem; }
  .preview img { max-width: 100%; border: 1px solid #8884; }
  section { margin-top: 1rem; }
</style>`;

function nav(): string {
  return `<nav><a href="/">לכרטיסי האישור</a><a href="/documents">מסמכים</a><a href="/documents/settings">הגדרות מסמכים</a><a href="/instruct">מה לעשות</a></nav>`;
}

function logoutForm(csrf: string): string {
  return `<form method="post" action="/logout" style="display:inline">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <button type="submit">התנתקות</button>
</form>`;
}

function fmtDateTime(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('he-IL', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

// ---------------------------------------------------------------- the list

export interface DocumentListRow {
  cardId: string;
  state: CardState;
  kind: DocumentKind;
  title: string;
  createdAt: Date;
  failedChecks: boolean;
  /** Not seen before this page load. */
  isNew: boolean;
}

export function renderDocumentList(options: {
  rows: readonly DocumentListRow[];
  timeZone: string;
  csrf: string;
  truncated: boolean;
}): string {
  const items =
    options.rows.length === 0
      ? '<p class="muted">אין עדיין מסמכים.</p>'
      : options.rows
          .map(
            (row) => `<div class="doc${row.isNew ? ' new' : ''}">
  <a href="/documents/${encodeURIComponent(row.cardId)}"><strong>${esc(documentKindLabel[row.kind])} — ${escLabel(row.title)}</strong></a>
  ${row.isNew ? '<span class="badge">חדש</span>' : ''}
  <div class="muted">${esc(documentCardStateLabel[row.state])}${row.failedChecks ? ' · <span class="failed">לא עבר בדיקה</span>' : ''} · ${esc(fmtDateTime(row.createdAt, options.timeZone))}</div>
</div>`,
          )
          .join('\n');
  const cut = options.truncated ? `<p class="muted">מוצגים ${options.rows.length} הכרטיסים האחרונים.</p>` : '';
  return page(
    'מסמכים',
    `${STYLE}${nav()}<h1>מסמכים</h1>${cut}${items}${logoutForm(options.csrf)}`,
  );
}

// ---------------------------------------------------------------- one card

export interface CheckView {
  /** `null` = the check did not run (or its result is not stored). */
  passed: boolean | null;
  findings: readonly { he: string; where: string; detail?: string }[];
}

export interface SourceView {
  label: string;
  /** A `TrustLevel` id; shown through `trustLevelLabel`. */
  provenance: string;
}

export interface OptionView {
  option: DeliveryOption;
  /** `renderStepEcho` of each step, joined. */
  echo: string;
  /** False for a save option while no base folder is set — the settings link replaces the button. */
  pressable: boolean;
}

export interface DocumentCardView {
  cardId: string;
  state: CardState;
  actionable: boolean;
  kind: DocumentKind;
  title: string;
  failedChecks: boolean;
  file: { name: string; size: string; shaPrefix: string };
  hasPreview: boolean;
  check1: CheckView;
  check2: CheckView;
  findings: readonly { he: string; where: string }[];
  notes: readonly string[];
  sources: readonly SourceView[];
  options: readonly OptionView[];
  /** C12: the production was asked to be sent, and no recipient was authorised. */
  needsAddress: boolean;
  csrf: string;
  error?: string;
}

function checkSection(title: string, check: CheckView): string {
  const verdict =
    check.passed === null
      ? '<span class="muted">לא רצה</span>'
      : check.passed
        ? '<span class="ok">עברה</span>'
        : '<span class="failed">נכשלה</span>';
  const findings =
    check.findings.length === 0
      ? check.passed === true
        ? '<p class="muted">לא נמצאו בעיות.</p>'
        : ''
      : `<ul>${check.findings
          .map(
            (f) =>
              `<li>${escLabel(f.he)} — ${escLabel(f.where)}${f.detail !== undefined ? ` <span class="muted">(${escLabel(f.detail)})</span>` : ''}</li>`,
          )
          .join('')}</ul>`;
  return `<section><h3>${esc(title)}: ${verdict}</h3>${findings}</section>`;
}

export function renderDocumentCard(view: DocumentCardView): string {
  const id = encodeURIComponent(view.cardId);
  const csrfField = `<input type="hidden" name="csrf" value="${esc(view.csrf)}">`;
  const error = view.error === undefined ? '' : `<p class="error">${escLabel(view.error)}</p>`;
  const heading = view.failedChecks ? '<p class="failed">לא עבר בדיקה</p>' : '';

  const preview = view.hasPreview
    ? `<section class="preview"><h3>תצוגה מקדימה</h3><img src="/documents/${id}/preview" alt="העמוד הראשון"></section>`
    : '<section><p class="muted">אין תצוגה מקדימה.</p></section>';

  const findings =
    view.findings.length === 0
      ? ''
      : `<section><h3>הבעיות שנמצאו</h3><ul>${view.findings
          .map((f) => `<li>${escLabel(f.he)} — ${escLabel(f.where)}</li>`)
          .join('')}</ul></section>`;
  const notes =
    view.notes.length === 0
      ? ''
      : `<section><h3>הערות</h3><ul>${view.notes.map((n) => `<li>${escLabel(n)}</li>`).join('')}</ul></section>`;
  const sources =
    view.sources.length === 0
      ? '<section><h3>מאיפה הגיע כל נתון</h3><p class="muted">לא נעשה שימוש במסמך מקור או בזיכרון — רק בהוראה שלך.</p></section>'
      : `<section><h3>מאיפה הגיע כל נתון</h3><ul>${view.sources
          .map((s) => `<li>${escLabel(s.label)} — <span class="muted">${esc(trustLevelLabel(s.provenance))}</span></li>`)
          .join('')}</ul></section>`;

  const options = view.options
    .map((o) => {
      const button = !view.actionable
        ? ''
        : o.pressable
          ? `<form method="post" action="/documents/${id}/approve">${csrfField}
  <input type="hidden" name="planHash" value="${esc(o.option.planHash)}">
  <button type="submit">${escLabel(o.option.label)}</button>
</form>`
          : '<p class="muted">כדי לשמור במחשב צריך קודם להגדיר תיקיית בסיס — <a href="/documents/settings">בהגדרות המסמכים</a>.</p>';
      return `<div class="doc"><strong>${escLabel(o.option.label)}</strong>
  <div class="echo">${escLabel(o.echo)}</div>
  ${button}
</div>`;
    })
    .join('\n');

  const address =
    view.needsAddress && view.actionable
      ? `<section><h3>למי לשלוח?</h3>
  <p class="muted">לא נמצא נמען שאפשר לשלוח אליו בלי שתקלידי אותו. הכתובת שתקלידי כאן תוצג כאפשרות שליחה חדשה, ותאשרי אותה בנפרד.</p>
  <form method="post" action="/documents/${id}/address">${csrfField}
    <input type="email" name="to" maxlength="320" required placeholder="name@example.com">
    <button type="submit">הוסיפי כתובת</button>
  </form></section>`
      : '';

  const fix = view.actionable
    ? `<section><h3>בקשי תיקון</h3>
  <form method="post" action="/documents/${id}/fix">${csrfField}
    <textarea name="text" rows="3" maxlength="4000" required placeholder="מה לשנות?"></textarea>
    <button type="submit">בקשי תיקון</button>
  </form></section>`
    : `<p class="muted">${esc(documentCardStateLabel[view.state])}</p>`;

  return page(
    'כרטיס מסמך',
    `${STYLE}${nav()}
<h1>${esc(documentKindLabel[view.kind])} — ${escLabel(view.title)}</h1>
${heading}${error}
<p>קובץ: ${escLabel(view.file.name)} · ${esc(view.file.size)} · <code>${esc(view.file.shaPrefix)}</code> · <a href="/documents/${id}/download">הורדה</a></p>
${checkSection('בדיקה ראשונה', view.check1)}
${checkSection('בדיקה שנייה', view.check2)}
${findings}${notes}${sources}${preview}
<section><h3>מה לעשות עם המסמך</h3>${options}</section>
${address}${fix}
${logoutForm(view.csrf)}`,
  );
}

// ---------------------------------------------------------------- settings

export function renderDocumentSettings(options: {
  csrf: string;
  toWhatsApp: boolean;
  toEmail: boolean;
  toScreen: boolean;
  baseFolder: string | null;
  error?: string;
  saved?: boolean;
}): string {
  const checked = (on: boolean): string => (on ? ' checked' : '');
  const error = options.error === undefined ? '' : `<p class="error">${esc(options.error)}</p>`;
  const saved = options.saved === true ? '<p class="ok">נשמר.</p>' : '';
  return page(
    'הגדרות מסמכים',
    `${STYLE}${nav()}<h1>הגדרות מסמכים</h1>${error}${saved}
<form method="post" action="/documents/settings">
  <input type="hidden" name="csrf" value="${esc(options.csrf)}">
  <fieldset><legend>איפה לקבל מסמך מוכן לבדיקה (לפחות אחד)</legend>
    <label><input type="checkbox" name="toScreen"${checked(options.toScreen)}> בדשבורד</label>
    <label><input type="checkbox" name="toEmail"${checked(options.toEmail)}> במייל</label>
    <label><input type="checkbox" name="toWhatsApp"${checked(options.toWhatsApp)}> בוואטסאפ</label>
  </fieldset>
  <label>תיקיית הבסיס לשמירת מסמכים (נתיב מלא; ריק = אין שמירה במחשב)
    <input type="text" name="baseFolder" maxlength="1000" value="${esc(options.baseFolder ?? '')}" dir="ltr">
  </label>
  <button type="submit">שמירה</button>
</form>
${logoutForm(options.csrf)}`,
  );
}
