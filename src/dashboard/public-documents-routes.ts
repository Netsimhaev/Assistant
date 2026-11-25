/**
 * `/documents/public` — which extracted documents the owner marks as safe to
 * quote to clients and/or suppliers. A document is "the owner's own" only when
 * it came in as an attachment to his instruction (`source = 'instruction'`);
 * anything else (mail, inbox folder, API, unknown) was written by someone else
 * and needs a second, explicit confirmation, re-checked on the server.
 */
import type { ServerResponse } from 'node:http';
import type { BusinessDb } from '../db/pool.js';
import { documentSourceLabel } from '../documents/source-label.js';
import type { DocumentSource } from '../documents/types.js';
import { setPublicFor, type PublicFor } from '../whatsapp/public-documents.js';
import { loadActiveCharter } from '../charter/store.js';
import { localParts } from '../util/local-time.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import { escLabel, escapeHtml as esc, page, renderForbidden } from './views.js';

export const PUBLIC_DOCUMENTS_PATH = '/documents/public';

export const PUBLIC_FOREIGN_WARNING =
  'המסמך הזה הגיע מגורם חיצוני ולא הועלה על ידך. העוזרת תצטט ממנו ללקוחות או לספקים. סמן בבירור שאתה מאשר.';
export const DOCUMENT_LIMIT = 200;
export const PUBLIC_TRUNCATED_NOTICE = 'מוצגים 200 המסמכים האחרונים';
export const PUBLIC_SAVED = 'ההגדרה נשמרה.';

const OWNER_SOURCES: readonly string[] = ['instruction'];
const LABEL: Record<PublicFor, string> = { client: 'לקוחות', supplier: 'ספקים', both: 'לקוחות וספקים' };

export interface PublicDocumentsSession {
  sessionId: string;
  username: string;
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } as const;

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

interface Row {
  document_id: string;
  original_name: string;
  source: string;
  public_for: PublicFor | null;
  created_at: Date;
}

const isForeign = (source: string): boolean => !OWNER_SOURCES.includes(source);

async function render(
  res: ServerResponse,
  status: number,
  db: BusinessDb,
  session: PublicDocumentsSession,
  message?: { error?: string; notice?: string },
): Promise<void> {
  const csrf = esc(issueCsrfToken(session.sessionId));
  const { rows: fetched } = await db.query<Row>(
    `SELECT document_id, original_name, source, public_for, created_at FROM documents
      WHERE business_id = $1 AND status = 'extracted' ORDER BY created_at DESC, document_id LIMIT ${DOCUMENT_LIMIT + 1}`,
    [db.businessId],
  );
  const truncated = fetched.length > DOCUMENT_LIMIT;
  const rows = truncated ? fetched.slice(0, DOCUMENT_LIMIT) : fetched;
  let timeZone = 'UTC';
  try {
    const active = await loadActiveCharter(db);
    if (active !== null) timeZone = active.charter.identity.timezone;
  } catch {
    // an unreadable charter costs the zone, not the page
  }
  const cards = rows
    .map((r) => {
      const foreign = isForeign(r.source);
      const sourceLabel = Object.hasOwn(documentSourceLabel, r.source) ? documentSourceLabel[r.source as DocumentSource] : r.source;
      const options = (['', 'client', 'supplier', 'both'] as const)
        .map(
          (v) =>
            `<option value="${v}"${(r.public_for ?? '') === v ? ' selected' : ''}>${v === '' ? 'לא ציבורי' : esc(LABEL[v])}</option>`,
        )
        .join('');
      return `<div class="card">
<p><strong>${escLabel(r.original_name)}</strong> — ${escLabel(sourceLabel)} — ${esc(localParts(r.created_at, timeZone).date)}</p>
<form method="post" action="${PUBLIC_DOCUMENTS_PATH}">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="documentId" value="${esc(r.document_id)}">
  <label>ציבורי עבור <select name="publicFor">${options}</select></label>
  ${foreign ? `<p class="error">${esc(PUBLIC_FOREIGN_WARNING)}</p><label><input type="checkbox" name="confirmForeign" value="1"> אני מאשר</label>` : ''}
  <button type="submit">שמור</button>
</form>
</div>`;
    })
    .join('');
  html(
    res,
    status,
    page(
      'מסמכים ציבוריים',
      `<nav><a href="/settings/whatsapp-contacts">וואטסאפ לאנשי קשר</a> · <a href="/settings/whatsapp-contacts/topics">נושאים</a></nav>
<h1>מסמכים ציבוריים</h1>
<p>מסמך ציבורי הוא מסמך שמותר לעוזרת לצטט ממנו ללקוחות או לספקים.</p>
${message?.error === undefined ? '' : `<p class="error">${esc(message.error)}</p>`}
${message?.notice === undefined ? '' : `<p>${esc(message.notice)}</p>`}
${truncated ? `<p class="muted">${esc(PUBLIC_TRUNCATED_NOTICE)}</p>` : ''}
${cards === '' ? '<p class="muted">אין מסמכים שנקראו.</p>' : cards}`,
    ),
  );
}

export async function handlePublicDocumentsGet(res: ServerResponse, db: BusinessDb, session: PublicDocumentsSession): Promise<void> {
  await render(res, 200, db, session);
}

export async function handlePublicDocumentsPost(
  res: ServerResponse,
  db: BusinessDb,
  session: PublicDocumentsSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());
  const documentId = form.get('documentId') ?? '';
  const raw = form.get('publicFor') ?? '';
  if (raw !== '' && raw !== 'client' && raw !== 'supplier' && raw !== 'both') {
    return render(res, 400, db, session, { error: 'ערך לא תקין.' });
  }
  const { rows } = await db.query<{ source: string }>(
    `SELECT source FROM documents WHERE business_id = $1 AND document_id = $2 AND status = 'extracted'`,
    [db.businessId, documentId],
  );
  const doc = rows[0];
  if (doc === undefined) return render(res, 404, db, session, { error: 'המסמך לא נמצא.' });
  if (raw !== '' && isForeign(doc.source) && form.get('confirmForeign') !== '1') {
    return render(res, 400, db, session, { error: PUBLIC_FOREIGN_WARNING });
  }
  const ok = await setPublicFor(db, documentId, raw === '' ? null : raw, session.username);
  if (!ok) return render(res, 404, db, session, { error: 'המסמך לא נמצא.' });
  return render(res, 200, db, session, { notice: PUBLIC_SAVED });
}
