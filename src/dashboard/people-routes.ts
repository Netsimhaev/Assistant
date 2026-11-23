/**
 * `/settings/people` — the owner's colleagues and contacts (admin-panel spec).
 * After the first signature only the owner changes these; the panel's charter
 * lock is the technician's, not the owner's.
 *
 * Colleagues are `business_colleagues` rows (`colleagues.ts`). Contacts are
 * the entity memories the setup or this screen wrote (`settings-contacts.ts`,
 * which owns the positive source filter and the `boss` job each write runs
 * under). Nothing here makes anyone "known" to the charter or lets anyone give
 * instructions — the intro says so, and points at "edit the rules" for the
 * one thing that does change the gate.
 *
 * Every POST is behind the session (the router) and CSRF (here, before any
 * read of the fields). Names and roles are rendered with `escLabel`: they may
 * have been typed by a technician, and a bidi control in them changes what the
 * owner reads.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestDocument, MAX_ORIGINAL_BYTES } from '../documents/ingest.js';
import { authorityNumberKey } from '../governance/principal-number.js';
import { readBoundedMultipart } from './multipart.js';
import { addColleague, listColleagues, removeColleague, updateColleague } from '../business/colleagues.js';
import {
  addManagedContact,
  ContactPhoneTakenError,
  listManagedContacts,
  removeManagedContact,
  updateManagedContact,
} from '../business/settings-contacts.js';
import { PERSON_FIELD_MAX_CHARS, PersonEntry } from '../business/setup-package.js';
import type { BusinessDb } from '../db/pool.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import { escLabel, escapeHtml as esc, page, renderForbidden } from './views.js';

export const PEOPLE_SETTINGS_PATH = '/settings/people';

export const PEOPLE_INTRO =
  'העוזרת מכירה את האנשים כאן ויודעת מה התפקיד שלהם. הוראות היא מקבלת רק ממך. כדי שאיש קשר ייחשב "מוכר" (מענה בלי כרטיס אישור), הוסף אותו ב"ערוך את הכללים".';

export const PERSON_FIELDS_REQUIRED = `שם ותפקיד הם שדות חובה (עד ${PERSON_FIELD_MAX_CHARS} תווים).`;
export const PERSON_EMAIL_INVALID = 'כתובת המייל אינה תקינה.';
export const PERSON_EXTERNAL_IDS_INVALID = 'המזהים במערכות חיצוניות אינם תקינים (עד חמישה, בצורה מזהה_מערכת=מזהה).';
export const PERSON_NOT_FOUND = 'לא מצאתי את האדם הזה — אולי הוא כבר הוסר. רענן את העמוד.';

/** `POST /settings/people/<colleague|contact>/<add|edit|remove>`. */
export const PEOPLE_ACTION_PATH = /^\/settings\/people\/(colleague|contact)\/(add|edit|remove)$/;

/** `POST /settings/people/contact/invoice` — attach an invoice file to a managed contact. */
export const PEOPLE_INVOICE_PATH = '/settings/people/contact/invoice';

export const INVOICE_FILE_MISSING = 'לא נבחר קובץ.';
export const INVOICE_TOO_LARGE = 'הקובץ גדול מדי.';
export const INVOICE_UPLOAD_MALFORMED = 'לא הצלחתי לקרוא את הטופס.';

export interface PeopleSession {
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

/** The fields of one person, parsed; or the Hebrew reason they are refused. */
function personFrom(
  form: URLSearchParams,
  withContactFields: boolean,
): { ok: true; entry: PersonEntry } | { ok: false; error: string } {
  const kind = withContactFields ? (form.get('kind') ?? '') : '';
  const email = withContactFields ? (form.get('email') ?? '').trim() : '';
  const externalIds = withContactFields ? parseExternalIds(form.get('externalIds') ?? '') : {};
  const parsed = PersonEntry.safeParse({
    name: form.get('name') ?? '',
    role: form.get('role') ?? '',
    phone: form.get('phone') ?? '',
    ...(kind === '' ? {} : { kind }),
    ...(email === '' ? {} : { email }),
    ...(Object.keys(externalIds).length === 0 ? {} : { externalIds }),
  });
  if (parsed.success) return { ok: true, entry: parsed.data };
  if (parsed.error.issues.some((i) => i.path[0] === 'externalIds')) {
    return { ok: false, error: PERSON_EXTERNAL_IDS_INVALID };
  }
  if (parsed.error.issues.some((i) => i.path[0] === 'email')) return { ok: false, error: PERSON_EMAIL_INVALID };
  // The phone's own issue is already Hebrew (`InternationalPhone`); the
  // name/role issues are zod's English defaults, replaced here.
  const phoneIssue = parsed.error.issues.find((i) => i.path[0] === 'phone' && i.code === 'custom');
  return { ok: false, error: phoneIssue?.message ?? PERSON_FIELDS_REQUIRED };
}

/** One `system=id` per line; whatever `PersonEntry` refuses is reported by `personFrom`. */
function parseExternalIds(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key !== '' && value !== '') out[key] = value;
  }
  return out;
}

function contactInputs(values: { kind: string | null; email: string | null; externalIds: Record<string, string> }): string {
  const idLines = Object.entries(values.externalIds)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const opt = (v: string, label: string) => `<option value="${v}"${values.kind === v || (v === '' && values.kind === null) ? ' selected' : ''}>${label}</option>`;
  return `<label>סוג <select name="kind">${opt('', '—')}${opt('client', 'לקוח')}${opt('supplier', 'ספק')}</select></label>
  <label>מייל <input type="email" name="email" value="${esc(values.email ?? '')}" maxlength="254" dir="ltr"></label>
  <label>מזהים במערכות חיצוניות (שורה לכל מערכת: מזהה_מערכת=מזהה) <textarea name="externalIds" rows="2" dir="ltr">${esc(idLines)}</textarea></label>`;
}

function personInputs(values: { name: string; role: string; phone: string }): string {
  return `<label>שם <input type="text" name="name" value="${escLabel(values.name)}" maxlength="${PERSON_FIELD_MAX_CHARS}"></label>
  <label>תפקיד <input type="text" name="role" value="${escLabel(values.role)}" maxlength="${PERSON_FIELD_MAX_CHARS}"></label>
  <label>טלפון (בינלאומי, למשל +972501234567) <input type="text" name="phone" value="${esc(values.phone)}" dir="ltr"></label>`;
}

const EMPTY = { name: '', role: '', phone: '' };

async function renderPeople(
  res: ServerResponse,
  status: number,
  db: BusinessDb,
  session: PeopleSession,
  error?: string,
): Promise<void> {
  const csrf = esc(issueCsrfToken(session.sessionId));
  const hidden = `<input type="hidden" name="csrf" value="${csrf}">`;
  const colleagues = await listColleagues(db);
  const contacts = await listManagedContacts(db);

  const colleagueRows = colleagues
    .map(
      (c) => `<div class="card">
<p><strong>${escLabel(c.name)}</strong> — ${escLabel(c.role)} <span dir="ltr">${esc(c.phone)}</span></p>
<form method="post" action="${PEOPLE_SETTINGS_PATH}/colleague/edit">
  ${hidden}<input type="hidden" name="id" value="${esc(c.colleagueId)}">
  ${personInputs(c)}
  <button type="submit">שמור</button>
</form>
<form method="post" action="${PEOPLE_SETTINGS_PATH}/colleague/remove">
  ${hidden}<input type="hidden" name="id" value="${esc(c.colleagueId)}">
  <button type="submit">הסר</button>
</form>
</div>`,
    )
    .join('');

  const contactRows = contacts
    .map(
      (c) => `<div class="card">
<p><strong>${escLabel(c.name)}</strong> — ${escLabel(c.role)} <span dir="ltr">${esc(c.phone)}</span></p>
<form method="post" action="${PEOPLE_SETTINGS_PATH}/contact/edit">
  ${hidden}<input type="hidden" name="key" value="${esc(c.subjectKey)}">
  ${personInputs(c)}
  ${contactInputs(c)}
  <button type="submit">שמור</button>
</form>
<form method="post" action="${PEOPLE_SETTINGS_PATH}/contact/remove">
  ${hidden}<input type="hidden" name="key" value="${esc(c.subjectKey)}">
  <button type="submit">הסר</button>
</form>
<form method="post" action="${PEOPLE_INVOICE_PATH}" enctype="multipart/form-data">
  ${hidden}<input type="hidden" name="key" value="${esc(c.subjectKey)}">
  <label>צרף חשבונית <input type="file" name="invoice"></label>
  <button type="submit">צרף</button>
</form>
</div>`,
    )
    .join('');

  html(
    res,
    status,
    page(
      'אנשים',
      `<nav><a href="/">לכרטיסי האישור</a> · <a href="/settings/profile">פרטי העסק</a> · <a href="/setup/edit">ערוך את הכללים</a></nav>
<h1>אנשים</h1>
<p>${esc(PEOPLE_INTRO)}</p>
${error === undefined ? '' : `<p class="error">${esc(error)}</p>`}
<h2>קולגות</h2>
<p class="muted">אנשים שעובדים איתך. הודעה מהם נרשמת ולא נענית.</p>
${colleagueRows === '' ? '<p class="muted">אין קולגות.</p>' : colleagueRows}
<div class="card">
<h3>הוסף קולגה</h3>
<form method="post" action="${PEOPLE_SETTINGS_PATH}/colleague/add">
  ${hidden}
  ${personInputs(EMPTY)}
  <button type="submit">הוסף</button>
</form>
</div>
<h2>אנשי קשר</h2>
${contactRows === '' ? '<p class="muted">אין אנשי קשר.</p>' : contactRows}
<div class="card">
<h3>הוסף איש קשר</h3>
<form method="post" action="${PEOPLE_SETTINGS_PATH}/contact/add">
  ${hidden}
  ${personInputs(EMPTY)}
  ${contactInputs({ kind: null, email: null, externalIds: {} })}
  <button type="submit">הוסף</button>
</form>
</div>`,
    ),
  );
}

/** `GET /settings/people`. */
export async function handlePeopleGet(res: ServerResponse, db: BusinessDb, session: PeopleSession): Promise<void> {
  await renderPeople(res, 200, db, session);
}

/** `POST /settings/people/<list>/<action>`. */
export async function handlePeopleAction(
  res: ServerResponse,
  db: BusinessDb,
  session: PeopleSession,
  list: 'colleague' | 'contact',
  action: 'add' | 'edit' | 'remove',
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());

  if (action === 'remove') {
    const removed =
      list === 'colleague'
        ? await removeColleague(db, form.get('id') ?? '')
        : await removeManagedContact(db, form.get('key') ?? '');
    if (!removed) return renderPeople(res, 404, db, session, PERSON_NOT_FOUND);
    return seeOther(res, PEOPLE_SETTINGS_PATH);
  }

  const person = personFrom(form, list === 'contact');
  if (!person.ok) return renderPeople(res, 400, db, session, person.error);

  try {
    if (action === 'add') {
      if (list === 'colleague') await addColleague(db, person.entry);
      else await addManagedContact(db, person.entry);
      return seeOther(res, PEOPLE_SETTINGS_PATH);
    }
  } catch (err) {
    if (err instanceof ContactPhoneTakenError) return renderPeople(res, 400, db, session, err.message);
    throw err;
  }

  let updated: boolean;
  try {
    updated =
      list === 'colleague'
        ? await updateColleague(db, form.get('id') ?? '', person.entry)
        : await updateManagedContact(db, form.get('key') ?? '', person.entry);
  } catch (err) {
    if (err instanceof ContactPhoneTakenError) return renderPeople(res, 400, db, session, err.message);
    throw err;
  }
  if (!updated) return renderPeople(res, 404, db, session, PERSON_NOT_FOUND);
  seeOther(res, PEOPLE_SETTINGS_PATH);
}

/**
 * `POST /settings/people/contact/invoice` — ingest one file and assign it to
 * a managed contact as an owner-uploaded invoice. CSRF is checked after the
 * bounded read (the token is a form field) and before anything is written;
 * only a key that `listManagedContacts` returns is accepted.
 */
export async function handlePeopleInvoicePost(
  req: IncomingMessage,
  res: ServerResponse,
  db: BusinessDb,
  session: PeopleSession,
  documentRoot: string | undefined,
): Promise<void> {
  const parsed = await readBoundedMultipart(req, MAX_ORIGINAL_BYTES);
  if (!parsed.ok) {
    if (parsed.code === 'over_cap') res.setHeader('Connection', 'close');
    const tooLarge = parsed.code === 'over_cap' || parsed.code === 'file_too_large';
    return renderPeople(res, tooLarge ? 413 : 400, db, session, tooLarge ? INVOICE_TOO_LARGE : INVOICE_UPLOAD_MALFORMED);
  }
  if (!verifyCsrfToken(session.sessionId, parsed.fields.get('csrf'))) return html(res, 403, renderForbidden());

  const key = parsed.fields.get('key') ?? '';
  const contact = (await listManagedContacts(db)).find((c) => c.subjectKey === key);
  const contactKey = contact === undefined ? null : authorityNumberKey(contact.phone);
  if (contact === undefined || contactKey === null) return renderPeople(res, 404, db, session, PERSON_NOT_FOUND);
  const file = parsed.file;
  if (file === null || file.bytes.length === 0) return renderPeople(res, 400, db, session, INVOICE_FILE_MISSING);

  const dir = await mkdtemp(join(tmpdir(), 'people-invoice-'));
  try {
    const path = join(dir, 'upload');
    await writeFile(path, file.bytes, { flag: 'wx' });
    const record = await ingestDocument(
      db,
      { path, source: 'instruction', originalName: file.filename },
      { ...(documentRoot !== undefined ? { documentRoot } : {}) },
    );
    if (record.status === 'rejected' || (record.status === 'stored' && record.reason !== null)) {
      return renderPeople(res, 400, db, session, `הקובץ לא נקלט: ${record.reason ?? 'הקובץ נדחה בקליטה.'}`);
    }
    await db.query(
      `INSERT INTO contact_documents (business_id, document_id, contact_key, kind, assigned_by)
       VALUES ($1, $2, $3, 'invoice', 'owner_upload')
       ON CONFLICT DO NOTHING`,
      [db.businessId, record.documentId, contactKey],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  seeOther(res, PEOPLE_SETTINGS_PATH);
}
