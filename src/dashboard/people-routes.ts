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
import type { ServerResponse } from 'node:http';
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
export const PERSON_NOT_FOUND = 'לא מצאתי את האדם הזה — אולי הוא כבר הוסר. רענן את העמוד.';

/** `POST /settings/people/<colleague|contact>/<add|edit|remove>`. */
export const PEOPLE_ACTION_PATH = /^\/settings\/people\/(colleague|contact)\/(add|edit|remove)$/;

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
function personFrom(form: URLSearchParams): { ok: true; entry: PersonEntry } | { ok: false; error: string } {
  const parsed = PersonEntry.safeParse({
    name: form.get('name') ?? '',
    role: form.get('role') ?? '',
    phone: form.get('phone') ?? '',
  });
  if (parsed.success) return { ok: true, entry: parsed.data };
  // The phone's own issue is already Hebrew (`InternationalPhone`); the
  // name/role issues are zod's English defaults, replaced here.
  const phoneIssue = parsed.error.issues.find((i) => i.path[0] === 'phone' && i.code === 'custom');
  return { ok: false, error: phoneIssue?.message ?? PERSON_FIELDS_REQUIRED };
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
  <button type="submit">שמור</button>
</form>
<form method="post" action="${PEOPLE_SETTINGS_PATH}/contact/remove">
  ${hidden}<input type="hidden" name="key" value="${esc(c.subjectKey)}">
  <button type="submit">הסר</button>
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

  const person = personFrom(form);
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
