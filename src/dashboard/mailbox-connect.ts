/**
 * The dashboard pages for connecting the business mailbox (Gmail / Microsoft
 * 365): `GET /connections/mailbox` (status), `GET /connections/mailbox/sign`
 * (the charter amendment, in Hebrew) and `POST /connections/mailbox/sign`
 * (sign and install it).
 *
 * **The order is SIGN, then CONNECT — and that order is the control.**
 *   1. `/connections/mailbox` → the owner picks Google or Microsoft;
 *   2. `/connections/mailbox/sign` → the owner reads what signing authorises
 *      and signs. The new charter declares the `mailbox` connection, naming
 *      the chosen provider as its subprocessor. Nothing is bound: no grant,
 *      no binding, no cursor;
 *   3. `/oauth/mailbox/start?provider=…` — `handleOAuthStart` refuses a
 *      charter with no `mailbox` connection, and refuses a provider other
 *      than the one the owner signed for (`mailboxProviderMatchesCharter`);
 *   4. the callback writes the grant, the binding and the cursor in one
 *      transaction (`oauth-routes.ts`).
 * So no code path can read mail before the owner signed: the ceremony that
 * produces the only token able to read it cannot start without the
 * signature. The reverse order (connect, then sign) would need the ceremony
 * to start on a connection the charter does not yet declare, which is
 * exactly the check `handleOAuthStart` exists to keep.
 *
 * **What the page shows is what gets signed.** The diff is rendered from
 * `describeMailboxAmendment`, the same split `buildMailboxAmendment` uses;
 * the form carries the active charter version it was rendered against
 * (`base`), and the POST refuses if the active charter moved since — the same
 * "rebuild server-side, compare a handle" shape `POST /erase/confirm` keeps.
 *
 * **The charter is read with `probeActiveCharter`, not `loadActiveCharter`.**
 * These pages are the connections screen and the install path — two of the
 * three callers `probeActiveCharter`'s own docblock admits — and an
 * unreadable charter must be shown as such rather than a 500.
 */
import type { ServerResponse } from 'node:http';
import { appendAudit } from '../audit/log.js';
import {
  MAILBOX_SUBPROCESSOR,
  buildMailboxAmendment,
  describeMailboxAmendment,
} from '../charter/amend-mailbox.js';
import { signCharter } from '../charter/sign.js';
import { installCharter, probeActiveCharter } from '../charter/store.js';
import { withTransaction } from '../db/pool.js';
import type { BusinessCharter } from '../domain/charter.js';
import type { CharterConnection } from '../domain/connection.js';
import { listGrants } from '../governance/oauth-grants.js';
import { MAILBOX_SYSTEM } from '../mail/mailbox.js';
import type { MailProvider } from '../mail/mailbox.js';
import { canonicalHash } from '../util/canonical.js';
import { verifyCsrfToken } from './csrf.js';
import { escLabel, escapeHtml as esc } from './views.js';

export interface MailboxSession {
  sessionId: string;
  username: string;
}

/** Owner-facing provider names. */
const PROVIDER_NAME: Readonly<Record<MailProvider, string>> = {
  google: 'Google (Gmail)',
  microsoft: 'Microsoft 365 (Outlook)',
};

/**
 * What signing authorises, verbatim. Reading and labelling are not tools a
 * plan can name (the charter's `serves` holds `mail.send` only), so this
 * sentence is the owner's only statement of them — it must be on the page.
 */
export const MAILBOX_AUTHORISATION_TEXT =
  'העוזרת תקרא כל מייל שנכנס לתיבה מרגע החיבור, תוסיף לו תווית (חשבוניות / ממתין לתשובה), ותכין טיוטות תשובה. ' +
  'היא לא תמחק, לא תעביר, לא תסמן כנקרא ולא תסמן כספאם. ' +
  'מייל יוצא — כולל תשובות להוראות שלך — יישלח מתיבת העסק במקום משרת השליחה, ורק אחרי אישורך.';

const RESTART_NOTE =
  'שימו לב: תזמון המשימות (ה-scheduler) קורא את התקנון ואת רשימת החיבורים פעם אחת בלבד, בעת ההפעלה שלו. ' +
  'השליחה תעבור לתיבת העסק רק אחרי שהחיבור לספק יושלם והתזמון יופעל מחדש.';

const SEND_GAP_NOTE =
  'מרגע החתימה מייל יוצא לא יישלח עוד דרך שרת השליחה הקודם. עד שהחיבור לספק יושלם והתזמון יופעל מחדש, ' +
  'מייל יוצא לא יישלח כלל.';

export function parseMailProvider(raw: string | null | undefined): MailProvider | null {
  return raw === 'google' || raw === 'microsoft' ? raw : null;
}

/**
 * The provider the SIGNED charter names for its mailbox, or `null` when the
 * mailbox connection names no subprocessor this code knows. Positive match
 * against `MAILBOX_SUBPROCESSOR`, never "anything that is not Google".
 */
export function signedMailboxProvider(connection: CharterConnection): MailProvider | null {
  for (const provider of ['google', 'microsoft'] as const) {
    if (connection.subprocessor === MAILBOX_SUBPROCESSOR[provider]) return provider;
  }
  return null;
}

/**
 * Whether the OAuth ceremony may run for `provider` on this mailbox
 * connection: only for the provider the owner signed for. Mail passing
 * through a provider the signed charter does not name is the change the
 * subprocessor list exists to put in front of the owner.
 */
export function mailboxProviderMatchesCharter(connection: CharterConnection, provider: MailProvider): boolean {
  return signedMailboxProvider(connection) === provider;
}

// --- Rendering --------------------------------------------------------------

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  .muted { opacity: 0.7; font-size: 0.9em; }
  .error { color: #c0392b; font-weight: bold; }
  .card { border: 1px solid #ccc; border-radius: 6px; padding: 0.75rem 1rem; margin: 1rem 0; }
  .choices a { display: inline-block; margin-inline-end: 1rem; }
</style>
</head>
<body>
${body}
<p><a href="/connections">חזרה לחיבורים</a> · <a href="/">לדשבורד</a></p>
</body>
</html>`;
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } as const;

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

/** 303 so the browser follows a POST with a GET. */
function seeOther(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, ...SECURITY_HEADERS });
  res.end();
}

function errorPage(title: string, message: string): string {
  return page(title, `<h1>${esc(title)}</h1><p class="error">${esc(message)}</p>`);
}

const CHARTER_UNREADABLE = 'לא ניתן לקרוא את התקנון הפעיל של העסק — יש לפנות למי שמחזיק את ההתקנה. לא בוצעה כל פעולה.';
const CHARTER_MISSING = 'לא הותקן עדיין תקנון פעיל לעסק הזה, ולכן אין לאן להוסיף את תיבת המייל.';

type CharterRead = { ok: true; charter: BusinessCharter } | { ok: false; message: string };

async function readCharter(businessId: string): Promise<CharterRead> {
  const probe = await probeActiveCharter(businessId);
  if (!probe.ok) {
    console.error('mailbox connect: could not read the active charter:', probe.reason);
    return { ok: false, message: CHARTER_UNREADABLE };
  }
  if (probe.active === null) return { ok: false, message: CHARTER_MISSING };
  return { ok: true, charter: probe.active.charter };
}

function mailboxOf(charter: BusinessCharter): CharterConnection | undefined {
  return charter.connections.find((c) => c.system === MAILBOX_SYSTEM);
}

// --- GET /connections/mailbox ----------------------------------------------

export async function handleMailboxStatus(res: ServerResponse, businessId: string): Promise<void> {
  const read = await readCharter(businessId);
  if (!read.ok) return sendHtml(res, 200, errorPage('תיבת המייל של העסק', read.message));

  const connection = mailboxOf(read.charter);
  if (connection === undefined) {
    return sendHtml(
      res,
      200,
      page(
        'תיבת המייל של העסק',
        `<h1>תיבת המייל של העסק</h1>
<p>מצב: <b>לא מחוברת</b>.</p>
<p>חיבור התיבה מתחיל בחתימה על תוספת לתקנון שמתארת בדיוק מה העוזרת תעשה בה. רק אחרי החתימה אפשר לחבר את התיבה אצל הספק.</p>
<p>באיזה שירות דואר העסק משתמש?</p>
<p class="choices">
  <a href="/connections/mailbox/sign?provider=google">${esc(PROVIDER_NAME.google)}</a>
  <a href="/connections/mailbox/sign?provider=microsoft">${esc(PROVIDER_NAME.microsoft)}</a>
</p>`,
      ),
    );
  }

  const provider = signedMailboxProvider(connection);
  if (provider === null) {
    return sendHtml(
      res,
      200,
      errorPage(
        'תיבת המייל של העסק',
        'התקנון מגדיר תיבת מייל, אבל אינו נוקב בספק שהמסך הזה מכיר — לא ניתן לחבר אותה מכאן.',
      ),
    );
  }

  const grant = (await listGrants(businessId)).find((g) => g.system === MAILBOX_SYSTEM && g.revokedAt === null) ?? null;
  const startLink = `<a href="/oauth/mailbox/start?provider=${provider}">חיבור התיבה אצל ${esc(PROVIDER_NAME[provider])}</a>`;
  let state: string;
  if (grant === null) {
    state = `<p>מצב: <b>נחתם בתקנון — ממתינה לחיבור</b> (${esc(PROVIDER_NAME[provider])}).</p>
<p>${startLink}</p>
<p class="muted">${esc(SEND_GAP_NOTE)}</p>`;
  } else if (grant.needsReauthAt !== null) {
    state = `<p>מצב: <b>דורשת אישור מחדש</b> — הספק דחה את ההרשאה השמורה, ולכן העוזרת אינה קוראת ואינה שולחת מהתיבה.</p>
<p>חשבון: ${escLabel(grant.account)}</p>
<p>${startLink}</p>`;
  } else {
    state = `<p>מצב: <b>פעילה</b> — ${esc(PROVIDER_NAME[provider])}.</p>
<p>חשבון: ${escLabel(grant.account)}</p>`;
  }

  sendHtml(
    res,
    200,
    page(
      'תיבת המייל של העסק',
      `<h1>תיבת המייל של העסק</h1>
${state}
<div class="card"><p>${esc(MAILBOX_AUTHORISATION_TEXT)}</p></div>
<p class="muted">${esc(RESTART_NOTE)}</p>`,
    ),
  );
}

// --- GET /connections/mailbox/sign -----------------------------------------

function connectionList(connections: readonly CharterConnection[]): string {
  // `label` is owner-authored (part of the charter the owner signed), so
  // `esc` alone — the same treatment `connectionRowHtml` gives it.
  return `<ul>${connections.map((c) => `<li>${esc(c.label)} <span class="muted">(${esc(c.system)})</span></li>`).join('')}</ul>`;
}

export function renderMailboxSignPage(options: {
  charter: BusinessCharter;
  provider: MailProvider;
  csrf: string;
}): string {
  const { charter, provider, csrf } = options;
  const diff = describeMailboxAmendment(charter, provider);
  const name = PROVIDER_NAME[provider];

  const dropped =
    diff.dropped.length === 0
      ? ''
      : `<p>החיבורים האלה שימשו רק לשליחת מייל, ולכן יוסרו מהתקנון:</p>${connectionList(diff.dropped)}`;
  const narrowed =
    diff.narrowed.length === 0
      ? ''
      : `<p>החיבורים האלה יישארו, אבל לא ישלחו עוד מייל:</p>${connectionList(diff.narrowed)}`;
  const subprocessor = diff.subprocessorAdded
    ? `<li>${esc(name)} (<code>${esc(MAILBOX_SUBPROCESSOR[provider])}</code>) יתווסף לרשימת הגורמים שמותר להם לעבד את המידע של העסק — המיילים של העסק עוברים דרכו.</li>`
    : `<li>${esc(name)} (<code>${esc(MAILBOX_SUBPROCESSOR[provider])}</code>) כבר מותר בתקנון לעבד את המידע של העסק.</li>`;

  return page(
    'חתימה: הוספת תיבת המייל לתקנון',
    `<h1>הוספת תיבת המייל של העסק לתקנון</h1>
<p>ספק: <b>${esc(name)}</b></p>
<div class="card">
<h2>מה החתימה מתירה</h2>
<p>${esc(MAILBOX_AUTHORISATION_TEXT)}</p>
</div>
<div class="card">
<h2>מה משתנה בתקנון</h2>
<ul>
<li>נוסף חיבור חדש: „תיבת המייל של העסק”, והוא היחיד ששולח מייל יוצא.</li>
${subprocessor}
</ul>
${dropped}
${narrowed}
<p>שאר התקנון נשאר בדיוק כפי שנחתם.</p>
</div>
<p>${esc(SEND_GAP_NOTE)}</p>
<p class="muted">${esc(RESTART_NOTE)}</p>
<p>אחרי החתימה תועבר/י לחבר את התיבה אצל ${esc(name)}.</p>
<form method="post" action="/connections/mailbox/sign">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="provider" value="${esc(provider)}">
  <input type="hidden" name="base" value="${esc(charter.charterVersion)}">
  <button type="submit">חתימה על התוספת לתקנון</button>
</form>`,
  );
}

const ALREADY_DECLARED = 'התקנון כבר מגדיר תיבת מייל לעסק. אין צורך לחתום שוב — אפשר להמשיך לחיבור במסך תיבת המייל.';
const BAD_PROVIDER = 'יש לבחור ספק דואר: google או microsoft. לא בוצעה כל פעולה.';

export async function handleMailboxSignGet(
  res: ServerResponse,
  businessId: string,
  csrf: string,
  query: URLSearchParams,
): Promise<void> {
  const provider = parseMailProvider(query.get('provider'));
  if (provider === null) return sendHtml(res, 400, errorPage('ספק לא תקין', BAD_PROVIDER));
  const read = await readCharter(businessId);
  if (!read.ok) return sendHtml(res, 409, errorPage('לא ניתן לחתום', read.message));
  if (mailboxOf(read.charter) !== undefined) return sendHtml(res, 409, errorPage('כבר נחתם', ALREADY_DECLARED));
  sendHtml(res, 200, renderMailboxSignPage({ charter: read.charter, provider, csrf }));
}

// --- POST /connections/mailbox/sign ----------------------------------------

/**
 * CSRF first, then the provider, then the charter — and the amendment is
 * REBUILT here from the then-active charter, never taken from the form. The
 * form's `base` is only a handle: if it no longer names the active version,
 * the page the owner read is not the change that would be signed, and the
 * POST refuses (409) rather than signing something unseen.
 *
 * Install and its `charter_change` audit row are one transaction: a charter
 * that became active with no record of who signed it in the dashboard is the
 * shape `decideAndSign` and the OAuth callback both refuse.
 */
export async function handleMailboxSignPost(
  res: ServerResponse,
  businessId: string,
  session: MailboxSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, errorPage('הבקשה נדחתה', 'הטופס פג תוקף. רענן/י ונסה/י שוב. לא בוצעה כל פעולה.'));
  }
  const provider = parseMailProvider(form.get('provider'));
  if (provider === null) return sendHtml(res, 400, errorPage('ספק לא תקין', BAD_PROVIDER));

  const read = await readCharter(businessId);
  if (!read.ok) return sendHtml(res, 409, errorPage('לא ניתן לחתום', read.message));
  const active = read.charter;
  if (mailboxOf(active) !== undefined) return sendHtml(res, 409, errorPage('כבר נחתם', ALREADY_DECLARED));
  if (form.get('base') !== active.charterVersion) {
    return sendHtml(
      res,
      409,
      errorPage(
        'התקנון השתנה',
        'התקנון הפעיל השתנה מאז שהדף הוצג, ולכן מה שהוצג אינו מה שהיה נחתם. לא בוצעה כל פעולה — יש לפתוח את דף החתימה מחדש.',
      ),
    );
  }

  const amendment = buildMailboxAmendment(active, new Date(), provider);
  const signed = signCharter(amendment, { signedByPersonId: session.username, method: 'dashboard_click' });

  await withTransaction(async (tx) => {
    await installCharter(signed, { businessId, tx });
    await appendAudit(
      {
        actor: 'human',
        onBehalfOf: session.username,
        kind: 'charter_change',
        charterVersion: signed.charterVersion,
        provenance: 'boss',
        inputHash: canonicalHash({ businessId, contentHash: signed.signature.contentHash }),
        reason:
          `charter amendment signed in the dashboard by ${session.username}: added the "${MAILBOX_SYSTEM}" ` +
          `connection (provider: ${provider}), superseding ${active.charterVersion}`,
      },
      { businessId, tx },
    );
  });

  seeOther(res, '/connections/mailbox');
}

