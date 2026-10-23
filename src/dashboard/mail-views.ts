/**
 * Mail screens: the searchable list, the invoices grouped by supplier, and a
 * single mail. Pure rendering — the handlers in `mail-handlers.ts` do the
 * reading.
 *
 * Everything a mail sender controls (names, subjects, bodies, file names)
 * is escaped, and the names and subjects additionally lose their bidi
 * controls through `escLabel`: the owner reads these labels to decide what
 * to do, and a right-to-left override can make one say something else.
 * Timestamps are formatted in the charter's time zone by `Intl`, never by
 * slicing `timestamptz::text` (which is in the DB session's zone).
 */
import type { InvoiceRow, MailRow } from '../mail/inbox-store.js';
import { ATTACHMENT_DOC_TYPE_LABELS, AttachmentDocType } from '../domain/mail-triage.js';
import type { MailCategory } from '../mail/mailbox.js';
import { stripBidiControls } from '../util/bidi.js';
import { escLabel, escapeHtml as esc, page } from './views.js';
import type { MailboxBannerStatus } from './mailbox-connect.js';

export const CATEGORY_LABEL: Record<MailCategory, string> = {
  invoice: 'חשבונית',
  question: 'שאלה',
  document: 'מסמך',
  other: 'אחר',
};

/**
 * One table for every error code a mail row can carry. A code the table does
 * not know is shown as a generic note — never as the raw code, which is an
 * identifier and not Hebrew for humans.
 */
const ERROR_NOTE: Record<string, string> = {
  attachment_failed: 'לא הצלחנו לקרוא את הקובץ המצורף',
  attachment_too_large: 'הקובץ המצורף גדול מדי ולא נקרא',
  notify_failed: 'לא הצלחנו להתריע לך על המייל',
  no_sender: 'אין כתובת שולח — לא ניתן להשיב',
  no_message_id: 'חסר מזהה הודעה — לא ניתן להשיב בשרשור',
  no_reply_gist: 'לא נוסחה טיוטת תשובה',
  unrecordable: 'לא ניתן היה לשמור את המייל',
  reraise_failed: 'לא הצלחנו להעלות מחדש את כרטיס התשובה',
  reply_failed: 'לא הצלחנו להכין תשובה',
  curation_failed: 'לא הצלחנו לזכור מהמייל',
  label_failed: 'לא הצלחנו לסמן את המייל בתיבה',
  job_close_failed: 'לא הצלחנו לסגור את הטיפול במייל',
  record_failed: 'לא הצלחנו לרשום את המייל',
};
const ERROR_NOTE_GENERIC = 'אירעה תקלה בטיפול במייל';

export function errorNote(code: string): string {
  const key = code.split(':')[0] ?? code;
  return Object.hasOwn(ERROR_NOTE, key) ? (ERROR_NOTE[key] as string) : ERROR_NOTE_GENERIC;
}

export interface MailFilters {
  q: string;
  from: string;
  to: string;
  sender: string;
  category: string;
}

/** Hebrew word for a stored type; a value outside the closed set gives `''`, never the raw value. */
export function docTypeLabel(value: unknown): string {
  const parsed = AttachmentDocType.safeParse(value);
  return parsed.success ? ATTACHMENT_DOC_TYPE_LABELS[parsed.data] : '';
}

export interface DocumentFilters {
  type: string;
  sender: string;
  from: string;
  to: string;
}

export interface DocumentRow {
  mailId: string;
  receivedAt: string;
  fromName: string | null;
  fromAddress: string;
  filename: string;
  docType: string | null;
  summary: string | null;
  scanned: boolean;
  documentId: string | null;
}

export interface InvoiceFilters {
  supplier: string;
  number: string;
  from: string;
  to: string;
  file: string;
}

/** `DD/MM/YYYY HH:MM` in `timeZone`. */
export function formatWhen(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

const SNIPPET_RADIUS = 60;

/**
 * The text excerpt around the first occurrence of `query`, escaped FIRST and
 * only then wrapped in `<mark>`. Escaping afterwards would let a body that
 * contains markup become markup. The match runs over the escaped text with
 * the escaped query, and an entity (`&amp;`) is consumed whole by a second
 * alternative so a query like `amp` never marks the inside of one.
 */
export function highlightSnippet(text: string, query: string, radius = SNIPPET_RADIUS): string {
  const collapsed = stripBidiControls(text).replace(/\s+/g, ' ').trim();
  const q = stripBidiControls(query).replace(/\s+/g, ' ').trim();
  if (q === '') return esc(collapsed.slice(0, radius * 2));
  const at = collapsed.toLowerCase().indexOf(q.toLowerCase());
  let slice = collapsed;
  if (at >= 0) {
    const start = Math.max(0, at - radius);
    const end = Math.min(collapsed.length, at + q.length + radius);
    slice = `${start > 0 ? '…' : ''}${collapsed.slice(start, end)}${end < collapsed.length ? '…' : ''}`;
  } else {
    slice = collapsed.slice(0, radius * 2);
  }
  const escaped = esc(slice);
  const escapedQuery = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escapedQuery})|(&(?:#?[a-z0-9]+);)`, 'gi');
  return escaped.replace(re, (m, hit: string | undefined) => (hit === undefined ? m : `<mark>${m}</mark>`));
}

function senderCell(mail: MailRow): string {
  const name = mail.fromName !== null && mail.fromName !== '' ? `${escLabel(mail.fromName)}<br>` : '';
  return `${name}<span class="muted">${escLabel(mail.fromAddress)}</span>`;
}

function didCell(mail: MailRow): string {
  const notes: string[] = [];
  if (mail.state === 'over_cap') notes.push('לא נקרא — התקרה היומית נגמרה');
  else if (mail.state === 'received' || mail.state === 'claimed') notes.push('ממתין לקריאה');
  else if (mail.state === 'failed') notes.push('הטיפול במייל נכשל');
  if (mail.replyJobId !== null) notes.push('הוכנה טיוטת תשובה');
  if (mail.notifiedAt !== null) notes.push('נשלחה לך התראה');
  const items = notes.map((n) => esc(n));
  if (mail.labelsApplied.length > 0) items.push(`סומן: ${mail.labelsApplied.map((l) => escLabel(l)).join(', ')}`);
  if (mail.error !== null) items.push(`<span class="error">${esc(errorNote(mail.error))}</span>`);
  return items.join('<br>');
}

function categoriesCell(mail: MailRow): string {
  return mail.categories.map((c) => esc(CATEGORY_LABEL[c] ?? c)).join(', ');
}

function mailboxBanner(status: MailboxBannerStatus): string {
  if (status === 'not_connected') {
    return '<p class="card"><b>תיבת מייל לא מחוברת</b> · <a href="/connections/mailbox">לחיבור התיבה</a></p>';
  }
  if (status === 'needs_reauth') {
    return '<p class="card error">התיבה מנותקת — יש להתחבר מחדש · <a href="/connections/mailbox">לחיבור מחדש</a></p>';
  }
  return '';
}

const GAP_BANNER = 'חלק מהמיילים שהגיעו בזמן שהתיבה הייתה מנותקת לא נקראו';
const CURSOR_PROBLEM_BANNER = 'יש תקלה בקריאת התיבה — הפרטים במסך החיבור';

/** The 📎 download links for every linked attachment whose document may be served. */
function attachmentLinks(mail: MailRow, downloadable: ReadonlySet<string>): string {
  return mail.attachments
    .filter((a) => a.documentId !== undefined && downloadable.has(a.documentId))
    .map((a) => `<a href="/documents/${esc(encodeURIComponent(a.documentId as string))}/file">📎 ${escLabel(a.filename)}</a>`)
    .join('<br>');
}

export function renderMailList(options: {
  rows: readonly MailRow[];
  filters: MailFilters;
  mailboxStatus: MailboxBannerStatus;
  gapAt: string | null;
  cursorProblem: boolean;
  downloadable: ReadonlySet<string>;
  timeZone: string;
  csrf: string;
}): string {
  const { rows, filters, mailboxStatus, gapAt, cursorProblem, downloadable, timeZone } = options;
  const categoryOptions = [
    `<option value=""${filters.category === '' ? ' selected' : ''}>כל הסיווגים</option>`,
    ...(Object.keys(CATEGORY_LABEL) as MailCategory[]).map(
      (c) => `<option value="${c}"${filters.category === c ? ' selected' : ''}>${esc(CATEGORY_LABEL[c])}</option>`,
    ),
  ].join('');
  const body = rows
    .map((m) => {
      const source =
        filters.q !== '' && m.bodyText.toLowerCase().includes(filters.q.toLowerCase())
          ? m.bodyText
          : filters.q !== '' && (m.summary ?? '').toLowerCase().includes(filters.q.toLowerCase())
            ? (m.summary as string)
            : (m.summary ?? m.subject);
      const links = attachmentLinks(m, downloadable);
      return `<tr>
  <td>${esc(formatWhen(m.receivedAt, timeZone))}</td>
  <td>${senderCell(m)}</td>
  <td><a href="/mail/${esc(encodeURIComponent(m.mailId))}"><b>${escLabel(m.subject)}</b></a><br>${highlightSnippet(source, filters.q)}${links === '' ? '' : `<br>${links}`}</td>
  <td>${categoriesCell(m)}</td>
  <td>${didCell(m)}</td>
</tr>`;
    })
    .join('\n');
  return page(
    'מיילים',
    `<h1>מיילים</h1>
<p><a href="/">לכרטיסי האישור</a> · <a href="/mail/invoices">חשבוניות לפי ספק</a> · <a href="/mail/documents">מסמכים מצורפים</a></p>
${mailboxBanner(mailboxStatus)}
${gapAt !== null ? `<p class="card error">${esc(GAP_BANNER)} (בתאריך ${esc(formatWhen(gapAt, timeZone).slice(0, 10))})</p>` : ''}
${cursorProblem ? `<p class="card error">${esc(CURSOR_PROBLEM_BANNER)}</p>` : ''}
<form method="get" action="/mail" class="card">
  <label>חיפוש טקסט <input type="text" name="q" value="${esc(filters.q)}"></label>
  <label>ממי <input type="text" name="sender" value="${esc(filters.sender)}"></label>
  <label>מתאריך <input type="date" name="from" value="${esc(filters.from)}"></label>
  <label>עד תאריך <input type="date" name="to" value="${esc(filters.to)}"></label>
  <label>סיווג <select name="category">${categoryOptions}</select></label>
  <button type="submit">חיפוש</button>
</form>
${
  rows.length === 0
    ? '<p class="muted">לא נמצאו מיילים.</p>'
    : `<table style="width:100%;border-collapse:collapse" border="1" cellpadding="6">
<thead><tr><th>מתי</th><th>ממי</th><th>תקציר / הקטע שנמצא</th><th>סיווג</th><th>מה העוזרת עשתה</th></tr></thead>
<tbody>
${body}
</tbody></table>`
}`,
  );
}

export interface InvoiceGroup {
  supplierAddress: string;
  supplierName: string | null;
  invoices: InvoiceRow[];
}

/** Group by supplier address; the name shown is the last seen. Newest first inside and between groups. */
export function groupInvoices(rows: readonly InvoiceRow[]): InvoiceGroup[] {
  const sorted = [...rows].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const groups = new Map<string, InvoiceGroup>();
  for (const inv of sorted) {
    const key = inv.supplierAddress.toLowerCase();
    let g = groups.get(key);
    if (g === undefined) {
      g = { supplierAddress: inv.supplierAddress, supplierName: inv.supplierName, invoices: [] };
      groups.set(key, g);
    } else if (g.supplierName === null && inv.supplierName !== null) {
      g.supplierName = inv.supplierName;
    }
    g.invoices.push(inv);
  }
  return [...groups.values()];
}

export function renderInvoices(options: {
  groups: readonly InvoiceGroup[];
  filters: InvoiceFilters;
  timeZone: string;
  csrf: string;
}): string {
  const { groups, filters, timeZone } = options;
  const sections = groups
    .map((g) => {
      const rows = g.invoices
        .map((i) => {
          const download =
            i.documentId !== null
              ? `<a href="/documents/${esc(encodeURIComponent(i.documentId))}/file">הורד</a>`
              : '<span class="muted">אין קובץ</span>';
          return `<tr>
  <td>${esc(formatWhen(i.receivedAt, timeZone))}</td>
  <td>${i.invoiceNumber === null ? '—' : escLabel(i.invoiceNumber)} <span class="muted">(לא מאומת)</span></td>
  <td>${i.amountText === null ? '—' : escLabel(i.amountText)} <span class="muted">(לא מאומת)</span></td>
  <td>${i.fileName === null ? '—' : escLabel(i.fileName)}</td>
  <td>${download} · <a href="/mail/${esc(encodeURIComponent(i.mailId))}">מייל מקורי</a></td>
</tr>`;
        })
        .join('\n');
      const title = g.supplierName !== null && g.supplierName !== '' ? `${escLabel(g.supplierName)} ` : '';
      return `<section class="card">
<h2>${title}<span class="muted">${escLabel(g.supplierAddress)}</span></h2>
<table style="width:100%;border-collapse:collapse" border="1" cellpadding="6">
<thead><tr><th>מתי</th><th>מספר חשבונית</th><th>סכום</th><th>קובץ</th><th></th></tr></thead>
<tbody>
${rows}
</tbody></table>
</section>`;
    })
    .join('\n');
  return page(
    'חשבוניות לפי ספק',
    `<h1>חשבוניות לפי ספק</h1>
<p><a href="/mail">מיילים</a></p>
<p class="muted">המספר והסכום נקראו מהמסמך על ידי העוזרת ואינם מאומתים.</p>
<form method="get" action="/mail/invoices" class="card">
  <label>ספק <input type="text" name="supplier" value="${esc(filters.supplier)}"></label>
  <label>מספר חשבונית <input type="text" name="number" value="${esc(filters.number)}"></label>
  <label>שם קובץ <input type="text" name="file" value="${esc(filters.file)}"></label>
  <label>מתאריך <input type="date" name="from" value="${esc(filters.from)}"></label>
  <label>עד תאריך <input type="date" name="to" value="${esc(filters.to)}"></label>
  <button type="submit">סינון</button>
</form>
${groups.length === 0 ? '<p class="muted">לא נמצאו חשבוניות.</p>' : sections}`,
  );
}

export function renderMailDetail(options: {
  mail: MailRow;
  timeZone: string;
  cardApprovalId: string | null;
  documents: readonly { documentId: string; fileName: string | null }[];
  downloadable: ReadonlySet<string>;
}): string {
  const { mail, timeZone, cardApprovalId, documents, downloadable } = options;
  const cats = categoriesCell(mail);
  const linkedIds = new Set(mail.attachments.map((a) => a.documentId).filter((d): d is string => d !== undefined));
  const docLinks = documents
    .filter((d) => !linkedIds.has(d.documentId))
    .map(
      (d) =>
        `<li>${d.fileName === null ? 'מסמך' : escLabel(d.fileName)} · <a href="/documents/${esc(encodeURIComponent(d.documentId))}/file">הורד</a></li>`,
    )
    .join('');
  const attachments = mail.attachments
    .map((a) => {
      const link =
        a.documentId !== undefined && downloadable.has(a.documentId)
          ? ` · <a href="/documents/${esc(encodeURIComponent(a.documentId))}/file">הורד</a>`
          : '';
      const type = docTypeLabel(a.docType);
      const extra = [
        type === '' ? '' : ` · <b>${esc(type)}</b>`,
        a.scanned === true ? ' · <span class="muted">קובץ סרוק — לא נקרא</span>' : '',
        a.summary !== undefined && a.summary !== '' ? `<br><span class="muted">${escLabel(a.summary)}</span>` : '',
      ].join('');
      return `<li>${escLabel(a.filename)}${link}${extra}</li>`;
    })
    .join('');
  const body =
    mail.bodyText === ''
      ? '<p class="muted">גוף המייל אינו שמור (עבר זמן השמירה, או שלא נקרא).</p>'
      : `<pre>${esc(stripBidiControls(mail.bodyText))}</pre>`;
  return page(
    'מייל',
    `<h1>${escLabel(mail.subject)}</h1>
<p><a href="/mail">חזרה לרשימה</a></p>
<div class="card">
  <div>מתי: ${esc(formatWhen(mail.receivedAt, timeZone))}</div>
  <div>מאת: ${mail.fromName !== null && mail.fromName !== '' ? `${escLabel(mail.fromName)} ` : ''}&lt;${escLabel(mail.fromAddress)}&gt;</div>
  <div>אל: ${mail.toAddresses.map((a) => escLabel(a)).join(', ')}</div>
  ${mail.replyTo !== null ? `<div>כתובת להשבה: ${escLabel(mail.replyTo)}</div>` : ''}
  ${cats !== '' ? `<div>סיווג: ${cats}</div>` : ''}
  ${mail.summary !== null ? `<div>תקציר: ${escLabel(mail.summary)}</div>` : ''}
  <div>מה העוזרת עשתה: ${didCell(mail) || '—'}</div>
  ${cardApprovalId !== null ? `<div><a href="/a/${esc(encodeURIComponent(cardApprovalId))}">כרטיס התשובה</a></div>` : ''}
</div>
${body}
${mail.bodyTruncated ? '<p class="muted">הגוף נחתך בשמירה.</p>' : ''}
${attachments !== '' ? `<h2>קבצים מצורפים</h2><ul>${attachments}</ul>` : ''}
${docLinks !== '' ? `<h2>מסמכים שנשמרו</h2><ul>${docLinks}</ul>` : ''}`,
  );
}

export function renderMailDocuments(options: {
  rows: readonly DocumentRow[];
  filters: DocumentFilters;
  downloadable: ReadonlySet<string>;
  timeZone: string;
  /** More rows matched than were fetched; the screen says so instead of looking complete. */
  truncated?: boolean;
  limit?: number;
}): string {
  const { rows, filters, downloadable, timeZone } = options;
  const cutNote =
    options.truncated === true
      ? `<p class="muted">מוצגים ${options.limit ?? rows.length} האחרונים — אפשר לצמצם בסינון.</p>`
      : '';
  const typeOptions = [
    `<option value=""${filters.type === '' ? ' selected' : ''}>כל הסוגים</option>`,
    ...AttachmentDocType.options.map(
      (t) => `<option value="${t}"${filters.type === t ? ' selected' : ''}>${esc(ATTACHMENT_DOC_TYPE_LABELS[t])}</option>`,
    ),
  ].join('');
  const body = rows
    .map((r) => {
      const sender = r.fromName !== null && r.fromName !== '' ? `${escLabel(r.fromName)}<br>` : '';
      const download =
        r.documentId !== null && downloadable.has(r.documentId)
          ? `<a href="/documents/${esc(encodeURIComponent(r.documentId))}/file">הורד</a>`
          : '<span class="muted">אין קובץ</span>';
      const summary = r.scanned
        ? '<span class="muted">קובץ סרוק — לא נקרא</span>'
        : r.summary !== null && r.summary !== ''
          ? escLabel(r.summary)
          : '—';
      return `<tr>
  <td>${esc(formatWhen(r.receivedAt, timeZone))}</td>
  <td>${sender}<span class="muted">${escLabel(r.fromAddress)}</span></td>
  <td>${escLabel(r.filename)}</td>
  <td>${esc(docTypeLabel(r.docType) || '—')}</td>
  <td>${summary}</td>
  <td>${download}</td>
  <td><a href="/mail/${esc(encodeURIComponent(r.mailId))}">מייל מקורי</a></td>
</tr>`;
    })
    .join('\n');
  return page(
    'מסמכים מצורפים',
    `<h1>מסמכים מצורפים</h1>
<p><a href="/mail">מיילים</a> · <a href="/mail/invoices">חשבוניות לפי ספק</a></p>
<p class="muted">הסוג והסיכום נקראו מהמסמך על ידי העוזרת ואינם מאומתים.</p>
<form method="get" action="/mail/documents" class="card">
  <label>סוג <select name="type">${typeOptions}</select></label>
  <label>ממי <input type="text" name="sender" value="${esc(filters.sender)}"></label>
  <label>מתאריך <input type="date" name="from" value="${esc(filters.from)}"></label>
  <label>עד תאריך <input type="date" name="to" value="${esc(filters.to)}"></label>
  <button type="submit">סינון</button>
</form>
${
  rows.length === 0
    ? '<p class="muted">לא נמצאו מסמכים.</p>'
    : `<table style="width:100%;border-collapse:collapse" border="1" cellpadding="6">
<thead><tr><th>תאריך</th><th>שולח</th><th>שם קובץ</th><th>סוג</th><th>סיכום</th><th>הורדה</th><th>מייל מקורי</th></tr></thead>
<tbody>
${body}
</tbody></table>`
}
${cutNote}`,
  );
}
