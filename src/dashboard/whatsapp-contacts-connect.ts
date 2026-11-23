/**
 * The dashboard pages for connecting WhatsApp to clients and suppliers
 * (phase 1): `GET /connections/whatsapp-contacts` (status + sign page),
 * `POST …/sign` and `POST …/revert`.
 *
 * Same ceremony as `calendar-connect.ts`: the amendment is REBUILT here from
 * the then-active charter, the form's `base` is only a handle compared under
 * `FOR UPDATE` in `installSigned`, and the live `connection_bindings` row is
 * written in the SAME transaction (no OAuth: the gateway credentials are the
 * business's own GREEN-API secrets). Revert only reduces authority, so it is
 * allowed at any time; it sets the binding to `disconnected`.
 */
import type { ServerResponse } from 'node:http';
import {
  WHATSAPP_CONTACTS_SUBPROCESSOR,
  WHATSAPP_CONTACTS_SYSTEM,
  buildWhatsAppContactsAmendment,
  buildWhatsAppContactsRevert,
  declaresWhatsAppContacts,
  whatsAppContactsSubprocessorAdded,
} from '../charter/amend-whatsapp-contacts.js';
import { probeActiveCharter } from '../charter/store.js';
import type { BusinessCharter } from '../domain/charter.js';
import { transaction, type BusinessDb } from '../db/pool.js';
import { listSecretRefs } from '../governance/credential-store.js';
import { loadBindings, upsertBinding } from '../orchestrator/bindings.js';
import { GREEN_API_INSTANCE_ID_REF, GREEN_API_TOKEN_REF } from '../orchestrator/runtime.js';
import { verifyCsrfToken } from './csrf.js';
import { STALE_MESSAGE, errorPage, installSigned, page, seeOther, sendHtml, type MailboxSession } from './mailbox-connect.js';
import { escapeHtml as esc } from './views.js';

export type WhatsAppContactsSession = MailboxSession;

/** What signing authorises, verbatim — phase 1 only. */
export const WHATSAPP_CONTACTS_AUTHORISATION_TEXT =
  'העוזרת תוכל לשלוח הודעות וואטסאפ ללקוחות ולספקים רק אחרי שאישרת כל הודעה, או בהוראה ישירה שלך.';

const CHARTER_UNREADABLE = 'לא ניתן לקרוא את התקנון הפעיל של העסק — יש לפנות למי שמחזיק את ההתקנה. לא בוצעה כל פעולה.';
const CHARTER_MISSING = 'לא הותקן עדיין תקנון פעיל לעסק הזה.';
const CSRF_REFUSAL = 'הטופס פג תוקף. רענן/י ונסה/י שוב. לא בוצעה כל פעולה.';
const ALREADY = 'התקנון כבר מגדיר חיבור וואטסאפ ללקוחות ולספקים. לא בוצעה כל פעולה.';
const TITLE = 'וואטסאפ ללקוחות ולספקים';

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly html: string,
  ) {
    super('refusal');
  }
}

type CharterRead = { ok: true; charter: BusinessCharter } | { ok: false; message: string };

async function readCharter(db: BusinessDb): Promise<CharterRead> {
  const probe = await probeActiveCharter(db);
  if (!probe.ok) {
    console.error('whatsapp-contacts connect: could not read the active charter:', probe.reason);
    return { ok: false, message: CHARTER_UNREADABLE };
  }
  if (probe.active === null) return { ok: false, message: CHARTER_MISSING };
  return { ok: true, charter: probe.active.charter };
}

export async function handleWhatsAppContactsStatus(res: ServerResponse, db: BusinessDb, csrf: string): Promise<void> {
  const read = await readCharter(db);
  if (!read.ok) return sendHtml(res, 200, errorPage(TITLE, read.message));
  const charter = read.charter;

  if (!declaresWhatsAppContacts(charter)) {
    const subprocessor = whatsAppContactsSubprocessorAdded(charter)
      ? `<li>ספק הוואטסאפ (<code>${esc(WHATSAPP_CONTACTS_SUBPROCESSOR)}</code>) יתווסף לרשימת הגורמים שמותר להם לעבד את המידע של העסק — תוכן ההודעות עובר דרכו.</li>`
      : `<li>ספק הוואטסאפ (<code>${esc(WHATSAPP_CONTACTS_SUBPROCESSOR)}</code>) כבר מותר בתקנון לעבד את המידע של העסק.</li>`;
    return sendHtml(
      res,
      200,
      page(
        TITLE,
        `<h1>${esc(TITLE)}</h1>
<p>מצב: <b>לא מחובר</b>.</p>
<div class="card">
<h2>מה החתימה מתירה</h2>
<p>${esc(WHATSAPP_CONTACTS_AUTHORISATION_TEXT)}</p>
</div>
<div class="card">
<h2>מה משתנה בתקנון</h2>
<ul>
<li>נוסף חיבור חדש: „${esc(TITLE)}”, לשליחת הודעות.</li>
${subprocessor}
</ul>
<p>שאר התקנון נשאר בדיוק כפי שנחתם.</p>
</div>
<form method="post" action="/connections/whatsapp-contacts/sign">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="base" value="${esc(charter.charterVersion)}">
  <button type="submit">חתימה על התוספת לתקנון</button>
</form>`,
      ),
    );
  }

  const bindings = await loadBindings(db);
  const refs = new Set((await listSecretRefs(db)).map((r) => r.ref));
  const hasSecrets = refs.has(GREEN_API_INSTANCE_ID_REF) && refs.has(GREEN_API_TOKEN_REF);
  const live = bindings.find((b) => b.system === WHATSAPP_CONTACTS_SYSTEM)?.status === 'live';
  sendHtml(
    res,
    200,
    page(
      TITLE,
      `<h1>${esc(TITLE)}</h1>
<p>מצב: <b>${live && hasSecrets ? 'פעיל' : live ? 'חתום — ממתין לחיבור וואטסאפ' : 'נחתם בתקנון — החיבור אינו פעיל'}</b>.</p>
<div class="card"><p>${esc(WHATSAPP_CONTACTS_AUTHORISATION_TEXT)}</p></div>
<div class="card">
<h2>בטל את החיבור</h2>
<p>ביטול מסיר את החיבור מהתקנון. גם הביטול נחתם בשמך.</p>
<form method="post" action="/connections/whatsapp-contacts/revert">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="base" value="${esc(charter.charterVersion)}">
  <button type="submit">בטל את החיבור</button>
</form>
</div>`,
    ),
  );
}

export async function handleWhatsAppContactsSignPost(
  res: ServerResponse,
  db: BusinessDb,
  session: WhatsAppContactsSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, errorPage('הבקשה נדחתה', CSRF_REFUSAL));
  }
  const read = await readCharter(db);
  if (!read.ok) return sendHtml(res, 409, errorPage('לא ניתן לחתום', read.message));
  const active = read.charter;
  if (declaresWhatsAppContacts(active)) return sendHtml(res, 409, errorPage('כבר נחתם', ALREADY));
  const base = form.get('base');
  if (base !== active.charterVersion) return sendHtml(res, 409, errorPage('התקנון השתנה', STALE_MESSAGE));

  try {
    await transaction(db, async (tx) => {
      const unsigned = buildWhatsAppContactsAmendment(active, new Date());
      const outcome = await installSigned(
        tx,
        session.username,
        base,
        unsigned,
        `charter amendment signed in the dashboard by ${session.username}: added the "${WHATSAPP_CONTACTS_SYSTEM}" ` +
          `connection, superseding ${active.charterVersion}`,
      );
      if (outcome === 'stale') throw new Refusal(409, errorPage('התקנון השתנה', STALE_MESSAGE));
      await upsertBinding(
        tx,
        { system: WHATSAPP_CONTACTS_SYSTEM, status: 'live', endpoint: null, credentialRef: null, provider: null, lastOkAt: null, lastError: null },
        { charterVersion: unsigned.charterVersion, by: session.username },
      );
    });
  } catch (error) {
    if (error instanceof Refusal) return sendHtml(res, error.status, error.html);
    throw error;
  }
  seeOther(res, '/connections/whatsapp-contacts');
}

export async function handleWhatsAppContactsRevertPost(
  res: ServerResponse,
  db: BusinessDb,
  session: WhatsAppContactsSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, errorPage('הבקשה נדחתה', CSRF_REFUSAL));
  }
  const read = await readCharter(db);
  if (!read.ok) return sendHtml(res, 409, errorPage('לא ניתן לבטל', read.message));
  const active = read.charter;
  if (!declaresWhatsAppContacts(active)) {
    return sendHtml(res, 409, errorPage('אין מה לבטל', 'התקנון הפעיל אינו מגדיר חיבור וואטסאפ ללקוחות. לא בוצעה כל פעולה.'));
  }
  const base = form.get('base');
  if (base !== active.charterVersion) return sendHtml(res, 409, errorPage('התקנון השתנה', STALE_MESSAGE));

  try {
    await transaction(db, async (tx) => {
      const unsigned = buildWhatsAppContactsRevert(active, new Date());
      const outcome = await installSigned(
        tx,
        session.username,
        base,
        unsigned,
        `charter amendment signed in the dashboard by ${session.username}: removed the "${WHATSAPP_CONTACTS_SYSTEM}" ` +
          `connection; superseding ${active.charterVersion}`,
      );
      if (outcome === 'stale') throw new Refusal(409, errorPage('התקנון השתנה', STALE_MESSAGE));
      await upsertBinding(
        tx,
        { system: WHATSAPP_CONTACTS_SYSTEM, status: 'disconnected', endpoint: null, credentialRef: null, provider: null, lastOkAt: null, lastError: null },
        { charterVersion: unsigned.charterVersion, by: session.username },
      );
    });
  } catch (error) {
    if (error instanceof Refusal) return sendHtml(res, error.status, error.html);
    throw error;
  }
  seeOther(res, '/connections/whatsapp-contacts');
}
