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
  buildMailboxRevert,
  describeMailboxAmendment,
  signedMailboxProvider,
} from '../charter/amend-mailbox.js';
import { signCharter } from '../charter/sign.js';
import { installCharter, loadCharterVersion, probeActiveCharter } from '../charter/store.js';
import { withTransaction, type Queryable } from '../db/pool.js';
import type { UnsignedCharter } from '../domain/charter.js';
import { loadBindings } from '../orchestrator/bindings.js';
import { oauthCeremonyPreflight } from './oauth-routes.js';
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

const REVERT_NOTE =
  'אם החיבור אצל הספק לא יצליח, הכפתור „בטל את חיבור התיבה” במסך תיבת המייל מחזיר את השליחה לשרת השליחה הקודם.';

const NEEDS_REAUTH_UNREAD_NOTE = 'מיילים שיגיעו עד שהתיבה תחובר מחדש לא ייקראו.';

const SEND_GAP_NOTE =
  'מרגע החתימה מייל יוצא לא יישלח עוד דרך שרת השליחה הקודם. עד שהחיבור לספק יושלם והתזמון יופעל מחדש, ' +
  'מייל יוצא לא יישלח כלל.';

export function parseMailProvider(raw: string | null | undefined): MailProvider | null {
  return raw === 'google' || raw === 'microsoft' ? raw : null;
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

export async function handleMailboxStatus(res: ServerResponse, businessId: string, csrf: string): Promise<void> {
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

  const working = await mailboxIsWorking(businessId);
  const grant = working.grant;
  const startLink = `<a href="/oauth/mailbox/start?provider=${provider}">חיבור התיבה אצל ${esc(PROVIDER_NAME[provider])}</a>`;
  let state: string;
  if (grant === null) {
    state = `<p>מצב: <b>נחתם בתקנון — ממתינה לחיבור</b> (${esc(PROVIDER_NAME[provider])}).</p>
<p>${startLink}</p>
<p class="muted">${esc(SEND_GAP_NOTE)}</p>`;
  } else if (grant.needsReauthAt !== null) {
    state = `<p>מצב: <b>דורשת אישור מחדש</b> — הספק דחה את ההרשאה השמורה, ולכן העוזרת אינה קוראת ואינה שולחת מהתיבה.</p>
<p>חשבון: ${escLabel(grant.account)}</p>
<p>${esc(NEEDS_REAUTH_UNREAD_NOTE)}</p>
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
<p class="muted">${esc(RESTART_NOTE)}</p>
${working.working ? '' : revertForm(read.charter.charterVersion, csrf)}`,
    ),
  );
}

/**
 * The way back is offered only while the mailbox is NOT working: signed but
 * never connected, or its grant needs reauth / was revoked. A working mailbox
 * is the state the owner asked for; undoing it is not a click on this page.
 */
function revertForm(base: string, csrf: string): string {
  return `<div class="card">
<h2>בטל את חיבור התיבה</h2>
<p>התיבה אינה מחוברת כרגע. ביטול מחזיר לתקנון את החיבורים שהיו בו לפני החתימה על תיבת המייל, ומחזיר את השליחה לשרת השליחה הקודם. גם הביטול נחתם בשמך.</p>
<form method="post" action="/connections/mailbox/revert">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="base" value="${esc(base)}">
  <button type="submit">בטל את חיבור התיבה</button>
</form>
</div>`;
}

type GrantSummary = Awaited<ReturnType<typeof listGrants>>[number];

export type MailboxBannerStatus = 'not_connected' | 'needs_reauth' | 'connected';

/** The one status the mail screens show, derived from the same grant `mailboxIsWorking` reads. */
export async function mailboxBannerStatus(businessId: string): Promise<MailboxBannerStatus> {
  const { grant } = await mailboxIsWorking(businessId);
  if (grant === null) return 'not_connected';
  return grant.needsReauthAt !== null ? 'needs_reauth' : 'connected';
}

/** Working = a live binding AND a live grant that does not need reauth. Anything else is "not working". */
async function mailboxIsWorking(businessId: string): Promise<{ working: boolean; grant: GrantSummary | null }> {
  const [bindings, grants] = await Promise.all([loadBindings({ businessId }), listGrants(businessId)]);
  const binding = bindings.find((b) => b.system === MAILBOX_SYSTEM) ?? null;
  const grant = grants.find((g) => g.system === MAILBOX_SYSTEM && g.revokedAt === null) ?? null;
  return { working: binding?.status === 'live' && grant !== null && grant.needsReauthAt === null, grant };
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
<p>${esc(SEND_GAP_NOTE)} ${esc(REVERT_NOTE)}</p>
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

/**
 * Signing moves `mail.send` to the mailbox at once, so a signature the
 * ceremony then cannot complete would stop outgoing mail for nothing. The
 * sign page and the sign POST both ask first.
 */
function preflightRefusal(reason: string): string {
  return errorPage(
    'אי אפשר לחתום עדיין',
    `לא ניתן לחבר כרגע את התיבה אצל הספק, ולכן החתימה לא תתבצע — היא הייתה עוצרת את המייל היוצא בלי שאפשר להשלים את החיבור. ${reason} לא בוצעה כל פעולה.`,
  );
}

class StaleBaseError extends Error {}

/**
 * The stale check that holds: the active pointer is locked (`FOR UPDATE`)
 * inside the install transaction and compared with the version the owner's
 * page was rendered against. A check outside the transaction leaves a window
 * in which another install lands and this one silently supersedes it.
 */
async function lockActiveVersion(tx: Queryable, businessId: string, base: string): Promise<void> {
  const { rows } = await tx.query<{ charter_version: string }>(
    'SELECT charter_version FROM charter_active WHERE business_id = $1 FOR UPDATE',
    [businessId],
  );
  if (rows[0]?.charter_version !== base) throw new StaleBaseError();
}

const STALE_MESSAGE =
  'התקנון הפעיל השתנה מאז שהדף הוצג, ולכן מה שהוצג אינו מה שהיה נחתם. לא בוצעה כל פעולה — יש לפתוח את הדף מחדש.';

/** Sign, install and record one owner-signed charter change, under the locked stale check. */
async function installSigned(
  businessId: string,
  username: string,
  base: string,
  unsigned: UnsignedCharter,
  reason: string,
): Promise<'installed' | 'stale'> {
  const signed = signCharter(unsigned, { signedByPersonId: username, method: 'dashboard_click' });
  try {
    await withTransaction(async (tx) => {
      await lockActiveVersion(tx, businessId, base);
      await installCharter(signed, { businessId, tx });
      await appendAudit(
        {
          actor: 'human',
          onBehalfOf: username,
          kind: 'charter_change',
          charterVersion: signed.charterVersion,
          provenance: 'boss',
          inputHash: canonicalHash({ businessId, contentHash: signed.signature.contentHash }),
          reason,
        },
        { businessId, tx },
      );
    });
  } catch (error) {
    if (error instanceof StaleBaseError) return 'stale';
    throw error;
  }
  return 'installed';
}

const ALREADY_DECLARED = 'התקנון כבר מגדיר תיבת מייל לעסק. אין צורך לחתום שוב — אפשר להמשיך לחיבור במסך תיבת המייל.';
const BAD_PROVIDER = 'יש לבחור ספק דואר: google או microsoft. לא בוצעה כל פעולה.';

export async function handleMailboxSignGet(
  res: ServerResponse,
  businessId: string,
  csrf: string,
  query: URLSearchParams,
  credentialKeyPath: string | undefined,
): Promise<void> {
  const provider = parseMailProvider(query.get('provider'));
  if (provider === null) return sendHtml(res, 400, errorPage('ספק לא תקין', BAD_PROVIDER));
  const read = await readCharter(businessId);
  if (!read.ok) return sendHtml(res, 409, errorPage('לא ניתן לחתום', read.message));
  if (mailboxOf(read.charter) !== undefined) return sendHtml(res, 409, errorPage('כבר נחתם', ALREADY_DECLARED));
  const preflight = await oauthCeremonyPreflight(businessId, provider, credentialKeyPath);
  if (preflight !== null) return sendHtml(res, 409, preflightRefusal(preflight));
  sendHtml(res, 200, renderMailboxSignPage({ charter: read.charter, provider, csrf }));
}

// --- POST /connections/mailbox/sign ----------------------------------------

/**
 * CSRF first, then the provider, then the charter, then the preflight — and
 * the amendment is REBUILT here from the then-active charter, never taken
 * from the form. The form's `base` is only a handle: it is compared with the
 * active pointer under `FOR UPDATE` inside the install transaction
 * (`installSigned`), so the page the owner read is the change that is signed.
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
  credentialKeyPath: string | undefined,
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
  const base = form.get('base');
  if (base !== active.charterVersion) return sendHtml(res, 409, errorPage('התקנון השתנה', STALE_MESSAGE));
  const preflight = await oauthCeremonyPreflight(businessId, provider, credentialKeyPath);
  if (preflight !== null) return sendHtml(res, 409, preflightRefusal(preflight));

  const outcome = await installSigned(
    businessId,
    session.username,
    base,
    buildMailboxAmendment(active, new Date(), provider),
    `charter amendment signed in the dashboard by ${session.username}: added the "${MAILBOX_SYSTEM}" ` +
      `connection (provider: ${provider}), superseding ${active.charterVersion}`,
  );
  if (outcome === 'stale') return sendHtml(res, 409, errorPage('התקנון השתנה', STALE_MESSAGE));
  seeOther(res, '/connections/mailbox');
}

/** How far back the supersedes chain is walked looking for the pre-mailbox version. */
const MAX_CHAIN_WALK = 100;

/**
 * The charter version the mailbox amendment superseded: walk `supersedes`
 * back from the active charter while the version still declares a mailbox.
 * `null` when the chain breaks (a missing or unreadable version) before a
 * mailbox-free version is reached.
 */
async function versionBeforeMailbox(businessId: string, active: BusinessCharter): Promise<BusinessCharter | null> {
  let current = active;
  for (let step = 0; step < MAX_CHAIN_WALK; step += 1) {
    if (mailboxOf(current) === undefined) return current;
    if (current.supersedes === undefined) return null;
    let previous: BusinessCharter | null;
    try {
      previous = await loadCharterVersion(current.supersedes, businessId);
    } catch (error) {
      console.error('mailbox revert: could not read a superseded charter:', error instanceof Error ? error.message : error);
      return null;
    }
    if (previous === null) return null;
    current = previous;
  }
  return null;
}

/**
 * `POST /connections/mailbox/revert` — the way back while the mailbox is not
 * working. A NEW signed amendment (never re-activating the old row) whose
 * `connections` and `subprocessorsAllowed` are the version before the
 * mailbox amendment; installed with its audit row under the same locked
 * stale check as signing. Refused while the mailbox is working.
 */
export async function handleMailboxRevertPost(
  res: ServerResponse,
  businessId: string,
  session: MailboxSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, errorPage('הבקשה נדחתה', 'הטופס פג תוקף. רענן/י ונסה/י שוב. לא בוצעה כל פעולה.'));
  }
  const read = await readCharter(businessId);
  if (!read.ok) return sendHtml(res, 409, errorPage('לא ניתן לבטל', read.message));
  const active = read.charter;
  if (mailboxOf(active) === undefined) {
    return sendHtml(res, 409, errorPage('אין מה לבטל', 'התקנון הפעיל אינו מגדיר תיבת מייל. לא בוצעה כל פעולה.'));
  }
  if ((await mailboxIsWorking(businessId)).working) {
    return sendHtml(
      res,
      409,
      errorPage('התיבה מחוברת', 'תיבת המייל מחוברת ופעילה, ולכן אי אפשר לבטל אותה מכאן. לא בוצעה כל פעולה.'),
    );
  }
  const base = form.get('base');
  if (base !== active.charterVersion) return sendHtml(res, 409, errorPage('התקנון השתנה', STALE_MESSAGE));

  const before = await versionBeforeMailbox(businessId, active);
  if (before === null) {
    return sendHtml(
      res,
      409,
      errorPage(
        'לא ניתן לבטל',
        'לא נמצאה גרסת התקנון שלפני הוספת תיבת המייל, ולכן אין לאן לחזור. יש לפנות למי שמחזיק את ההתקנה. לא בוצעה כל פעולה.',
      ),
    );
  }

  const outcome = await installSigned(
    businessId,
    session.username,
    base,
    buildMailboxRevert(active, before, new Date()),
    `charter amendment signed in the dashboard by ${session.username}: removed the "${MAILBOX_SYSTEM}" ` +
      `connection, restoring the connections of ${before.charterVersion}; superseding ${active.charterVersion}`,
  );
  if (outcome === 'stale') return sendHtml(res, 409, errorPage('התקנון השתנה', STALE_MESSAGE));
  seeOther(res, '/connections/mailbox');
}
