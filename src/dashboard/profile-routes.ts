/**
 * `/settings/profile` — the business's address and logo, the owner's to
 * change after the first signature (admin-panel spec). No charter lock: that
 * lock is the technician's, in the panel.
 *
 * The logo upload is the one bounded multipart read both servers share
 * (`readBoundedMultipart`), capped at `LOGO_MAX_BYTES`; `saveLogo` judges the
 * bytes and takes its own per-business lock. CSRF travels as a form field of
 * the multipart body and is checked before the file is looked at.
 *
 * `handleLogoGet` is the one place the stored logo is served — for this page
 * and for the interview's step 1 (`/setup/logo`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LOGO_MAX_BYTES } from '../business/logo.js';
import { ADDRESS_MAX_CHARS, ProfileValidationError, loadProfile, readLogo, saveAddress, saveLogo } from '../business/profile.js';
import type { BusinessDb } from '../db/pool.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import { readBoundedMultipart } from './multipart.js';
import { escLabel, escapeHtml as esc, page, renderForbidden } from './views.js';

export const PROFILE_SETTINGS_PATH = '/settings/profile';
export const PROFILE_LOGO_PATH = '/settings/profile/logo';

export const LOGO_NOT_IMAGE = 'הקובץ אינו תמונת PNG או JPEG.';
export const LOGO_TOO_LARGE = 'הקובץ גדול מ-1MB.';
export const LOGO_MISSING = 'לא נבחר קובץ.';
export const UPLOAD_MALFORMED = 'לא הצלחתי לקרוא את הטופס.';

export interface ProfileSession {
  sessionId: string;
  username: string;
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } as const;

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

function seeOther(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, ...SECURITY_HEADERS });
  res.end();
}

/** Who wrote the row, as `business_profiles.updated_by` records it. */
function updatedBy(session: ProfileSession): string {
  return `owner:${session.username}`;
}

async function renderProfile(
  res: ServerResponse,
  status: number,
  db: BusinessDb,
  session: ProfileSession,
  extra: { address?: string; error?: string } = {},
): Promise<void> {
  const profile = await loadProfile(db);
  const csrf = esc(issueCsrfToken(session.sessionId));
  const address = extra.address ?? profile.address ?? '';
  const logo =
    profile.logo === null
      ? '<p class="muted">אין לוגו.</p>'
      : `<p><img src="${PROFILE_LOGO_PATH}" alt="הלוגו של העסק" style="max-width:12rem;max-height:8rem"></p>`;
  html(
    res,
    status,
    page(
      'פרטי העסק',
      `<nav><a href="/">לכרטיסי האישור</a> · <a href="/settings/people">אנשים</a> · <a href="/settings/description">תיאור העסק</a></nav>
<h1>פרטי העסק</h1>
${extra.error === undefined ? '' : `<p class="error">${esc(extra.error)}</p>`}
<div class="card">
<form method="post" action="${PROFILE_SETTINGS_PATH}">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>כתובת העסק <span class="muted">(עד ${ADDRESS_MAX_CHARS} תווים)</span>
    <input type="text" name="address" value="${escLabel(address)}" maxlength="${ADDRESS_MAX_CHARS}">
  </label>
  <button type="submit">שמור את הכתובת</button>
</form>
</div>
<div class="card">
<h3>לוגו</h3>
${logo}
<form method="post" action="${PROFILE_LOGO_PATH}" enctype="multipart/form-data">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>לוגו (PNG או JPEG, עד 1MB)<input type="file" name="logo" accept="image/png,image/jpeg"></label>
  <button type="submit">העלה לוגו</button>
</form>
</div>`,
    ),
  );
}

/** `GET /settings/profile`. */
export async function handleProfileGet(res: ServerResponse, db: BusinessDb, session: ProfileSession): Promise<void> {
  await renderProfile(res, 200, db, session);
}

/** `POST /settings/profile` — the address. */
export async function handleAddressPost(
  res: ServerResponse,
  db: BusinessDb,
  session: ProfileSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());
  const address = form.get('address') ?? '';
  try {
    await saveAddress(db, address, updatedBy(session));
  } catch (err) {
    if (err instanceof ProfileValidationError) return renderProfile(res, 400, db, session, { address, error: err.message });
    throw err;
  }
  seeOther(res, PROFILE_SETTINGS_PATH);
}

/** `POST /settings/profile/logo` — a multipart upload of one file. */
export async function handleLogoPost(
  req: IncomingMessage,
  res: ServerResponse,
  db: BusinessDb,
  session: ProfileSession,
  documentRoot: string,
): Promise<void> {
  const parsed = await readBoundedMultipart(req, LOGO_MAX_BYTES);
  if (!parsed.ok) {
    // Refused before the CSRF field could be read: the refusal page shows no business data.
    if (parsed.code === 'over_cap') res.setHeader('Connection', 'close');
    const tooLarge = parsed.code === 'over_cap' || parsed.code === 'file_too_large';
    return html(res, tooLarge ? 413 : 400, page('פרטי העסק', `<p class="error">${esc(tooLarge ? LOGO_TOO_LARGE : UPLOAD_MALFORMED)}</p>
<p><a href="${PROFILE_SETTINGS_PATH}">חזרה לפרטי העסק</a></p>`));
  }
  if (!verifyCsrfToken(session.sessionId, parsed.fields.get('csrf'))) return html(res, 403, renderForbidden());
  const file = parsed.file;
  if (file === null || file.bytes.length === 0) return renderProfile(res, 400, db, session, { error: LOGO_MISSING });
  const outcome = await saveLogo(db, file.bytes, documentRoot, updatedBy(session));
  if (outcome === 'not_image') return renderProfile(res, 400, db, session, { error: LOGO_NOT_IMAGE });
  if (outcome === 'too_large') return renderProfile(res, 413, db, session, { error: LOGO_TOO_LARGE });
  seeOther(res, PROFILE_SETTINGS_PATH);
}

/**
 * `GET /settings/profile/logo` and `GET /setup/logo` — the stored logo.
 * `readLogo` re-hashes the file and refuses a mismatch; the type is the
 * sniffed one, never guessed, and `nosniff` keeps the browser to it.
 */
export async function handleLogoGet(res: ServerResponse, db: BusinessDb, documentRoot: string): Promise<void> {
  const logo = await readLogo(db, documentRoot);
  if (logo === null) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('אין לוגו');
    return;
  }
  res.writeHead(200, {
    'Content-Type': logo.mediaType,
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': String(logo.bytes.length),
    ...SECURITY_HEADERS,
  });
  res.end(logo.bytes);
}
