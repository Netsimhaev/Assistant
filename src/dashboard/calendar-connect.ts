/**
 * The dashboard pages for connecting the business calendar (Google Calendar /
 * Microsoft 365): `GET /connections/calendar` (status), `GET
 * /connections/calendar/sign` (the charter amendment, in Hebrew), `POST
 * /connections/calendar/sign` (sign and install it) and `POST
 * /connections/calendar/revert`.
 *
 * Same ceremony, in the same order, as `mailbox-connect.ts` — and for the same
 * reason: **SIGN, then CONNECT.** The amendment declares the `calendar`
 * connection naming the chosen provider; only then does
 * `/oauth/calendar/start?provider=…` accept the ceremony
 * (`calendarProviderMatchesCharter`). No token able to read or write the
 * calendar can exist before the owner signed.
 *
 * What the page shows is what gets signed: the diff comes from
 * `describeCalendarAmendment`, the POST rebuilds the amendment server-side from
 * the then-active charter, and the form's `base` is only a handle compared
 * under `FOR UPDATE` inside the install transaction (`installSigned`).
 *
 * The way back (`/revert`) is offered, and accepted, only while the calendar is
 * NOT working — a live calendar is the state the owner asked for.
 */
import type { ServerResponse } from 'node:http';
import { CALENDAR_SYSTEM, type CalendarProvider } from '../calendar/calendar.js';
import {
  CALENDAR_SUBPROCESSOR,
  buildCalendarAmendment,
  buildCalendarRevert,
  describeCalendarAmendment,
  signedCalendarProvider,
} from '../charter/amend-calendar.js';
import { loadCharterVersion, probeActiveCharter } from '../charter/store.js';
import type { BusinessCharter } from '../domain/charter.js';
import type { CharterConnection } from '../domain/connection.js';
import { listGrants } from '../governance/oauth-grants.js';
import { loadBindings } from '../orchestrator/bindings.js';
import { verifyCsrfToken } from './csrf.js';
import {
  STALE_MESSAGE,
  errorPage,
  installSigned,
  page,
  seeOther,
  sendHtml,
  type MailboxSession,
} from './mailbox-connect.js';
import { oauthCeremonyPreflight } from './oauth-routes.js';
import { escLabel, escapeHtml as esc } from './views.js';
import type { BusinessDb } from '../db/pool.js';

export type CalendarSession = MailboxSession;

const PROVIDER_NAME: Readonly<Record<CalendarProvider, string>> = {
  google: 'Google Calendar',
  microsoft: 'Microsoft 365 (Outlook)',
};

/**
 * What signing authorises, verbatim. Reading and writing are the connection's
 * `serves` (`calendar.read`, `calendar.write`); this sentence is the owner's
 * statement of what that means, and it must be on the sign page.
 */
export const CALENDAR_AUTHORISATION_TEXT =
  'העוזרת תקרא את כל היומנים שתבחר, כדי לדעת מתי אתה פנוי ותפוס ולענות לך על הלו"ז. ' +
  'היא תקבע, תזיז, תערוך ותבטל פגישות — תמיד אחרי שתאשר. ' +
  'לפני שאתה מאשר היא רק שומרת לך מקום ביומן, בלי להזמין אף אחד. ' +
  'היא לעולם לא מוחקת אירוע שלא היא יצרה בלי לשאול אותך, ולעולם לא כותבת ליומן שלא בחרת כיומן הפגישות.';

/** As `RESTART_NOTE` (mailbox-connect.ts): picked up on the next scheduler pass, no restart. */
export const CALENDAR_RESTART_NOTE =
  'שימו לב: היומן ייכנס לשימוש רק אחרי שהחיבור לספק יושלם. ' +
  'מאותו רגע תזמון המשימות (ה-scheduler) ישתמש בו כבר בסבב הבא שלו — אין צורך להפעיל אותו מחדש.';

const REVERT_NOTE =
  'אם החיבור אצל הספק לא יצליח, הכפתור „בטל את חיבור היומן” במסך היומן מחזיר את התקנון למצב שלפני החתימה.';

const NEEDS_REAUTH_NOTE = 'עד שהיומן יחובר מחדש העוזרת לא תראה את הלו"ז ולא תקבע פגישות.';

const LEGACY_GAP_NOTE =
  'אם בתקנון כבר יש חיבור יומן לקריאה בלבד, הוא יוחלף בחיבור הזה. עד שהחיבור לספק יושלם, היומן לא יהיה זמין לעוזרת.';

const BAD_PROVIDER = 'יש לבחור ספק יומן: google או microsoft. לא בוצעה כל פעולה.';
const ALREADY_DECLARED = 'התקנון כבר מגדיר יומן לעסק. אין צורך לחתום שוב — אפשר להמשיך לחיבור במסך היומן.';
const CHARTER_UNREADABLE = 'לא ניתן לקרוא את התקנון הפעיל של העסק — יש לפנות למי שמחזיק את ההתקנה. לא בוצעה כל פעולה.';
const CHARTER_MISSING = 'לא הותקן עדיין תקנון פעיל לעסק הזה, ולכן אין לאן להוסיף את היומן.';
const CSRF_REFUSAL = 'הטופס פג תוקף. רענן/י ונסה/י שוב. לא בוצעה כל פעולה.';

export function parseCalendarProvider(raw: string | null | undefined): CalendarProvider | null {
  return raw === 'google' || raw === 'microsoft' ? raw : null;
}

type CharterRead = { ok: true; charter: BusinessCharter } | { ok: false; message: string };

async function readCharter(db: BusinessDb): Promise<CharterRead> {
  const probe = await probeActiveCharter(db);
  if (!probe.ok) {
    console.error('calendar connect: could not read the active charter:', probe.reason);
    return { ok: false, message: CHARTER_UNREADABLE };
  }
  if (probe.active === null) return { ok: false, message: CHARTER_MISSING };
  return { ok: true, charter: probe.active.charter };
}

function calendarOf(charter: BusinessCharter): CharterConnection | undefined {
  return charter.connections.find((c) => c.system === CALENDAR_SYSTEM);
}

type GrantSummary = Awaited<ReturnType<typeof listGrants>>[number];

/** Working = a live binding AND a live grant that does not need reauth. */
async function calendarIsWorking(db: BusinessDb): Promise<{ working: boolean; grant: GrantSummary | null }> {
  // One after the other, never `Promise.all`: both run on this request's one
  // connection, and two queries in flight on it interleave.
  const bindings = await loadBindings(db);
  const grants = await listGrants(db);
  const binding = bindings.find((b) => b.system === CALENDAR_SYSTEM) ?? null;
  const grant = grants.find((g) => g.system === CALENDAR_SYSTEM && g.revokedAt === null) ?? null;
  return { working: binding?.status === 'live' && grant !== null && grant.needsReauthAt === null, grant };
}

// --- GET /connections/calendar ----------------------------------------------

export async function handleCalendarStatus(res: ServerResponse, db: BusinessDb, csrf: string): Promise<void> {
  const read = await readCharter(db);
  if (!read.ok) return sendHtml(res, 200, errorPage('יומן העסק', read.message));

  const connection = calendarOf(read.charter);
  if (connection === undefined) {
    return sendHtml(
      res,
      200,
      page(
        'יומן העסק',
        `<h1>יומן העסק</h1>
<p>מצב: <b>לא מחובר</b>.</p>
<p>חיבור היומן מתחיל בחתימה על תוספת לתקנון שמתארת בדיוק מה העוזרת תעשה בו. רק אחרי החתימה אפשר לחבר את היומן אצל הספק.</p>
<p>באיזה שירות היומן של העסק?</p>
<p class="choices">
  <a href="/connections/calendar/sign?provider=google">${esc(PROVIDER_NAME.google)}</a>
  <a href="/connections/calendar/sign?provider=microsoft">${esc(PROVIDER_NAME.microsoft)}</a>
</p>`,
      ),
    );
  }

  const provider = signedCalendarProvider(connection);
  if (provider === null) {
    return sendHtml(
      res,
      200,
      errorPage('יומן העסק', 'התקנון מגדיר יומן, אבל אינו נוקב בספק שהמסך הזה מכיר — לא ניתן לחבר אותו מכאן.'),
    );
  }

  const working = await calendarIsWorking(db);
  const grant = working.grant;
  const startLink = `<a href="/oauth/${CALENDAR_SYSTEM}/start?provider=${provider}">חיבור היומן אצל ${esc(PROVIDER_NAME[provider])}</a>`;
  let state: string;
  if (grant === null) {
    state = `<p>מצב: <b>נחתם בתקנון — ממתין לחיבור</b> (${esc(PROVIDER_NAME[provider])}).</p>
<p>${startLink}</p>`;
  } else if (grant.needsReauthAt !== null) {
    state = `<p>מצב: <b>דורש אישור מחדש</b> — הספק דחה את ההרשאה השמורה, ולכן העוזרת אינה קוראת את היומן ואינה כותבת בו.</p>
<p>חשבון: ${escLabel(grant.account)}</p>
<p>${esc(NEEDS_REAUTH_NOTE)}</p>
<p>${startLink}</p>`;
  } else if (!working.working) {
    state = `<p>מצב: <b>ההרשאה קיימת אך החיבור אינו פעיל</b> (${esc(PROVIDER_NAME[provider])}).</p>
<p>חשבון: ${escLabel(grant.account)}</p>
<p>${startLink}</p>`;
  } else {
    state = `<p>מצב: <b>פעיל</b> — ${esc(PROVIDER_NAME[provider])}.</p>
<p>חשבון: ${escLabel(grant.account)}</p>
<p><a href="/meetings/settings">הגדרות הפגישות</a></p>`;
  }

  sendHtml(
    res,
    200,
    page(
      'יומן העסק',
      `<h1>יומן העסק</h1>
${state}
<div class="card"><p>${esc(CALENDAR_AUTHORISATION_TEXT)}</p></div>
<p class="muted">${esc(CALENDAR_RESTART_NOTE)}</p>
${working.working ? '' : revertForm(read.charter.charterVersion, csrf)}`,
    ),
  );
}

/** The way back, offered only while the calendar is NOT working. */
function revertForm(base: string, csrf: string): string {
  return `<div class="card">
<h2>בטל את חיבור היומן</h2>
<p>היומן אינו מחובר כרגע. ביטול מחזיר לתקנון את החיבורים שהיו בו לפני החתימה על היומן. גם הביטול נחתם בשמך.</p>
<form method="post" action="/connections/calendar/revert">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="base" value="${esc(base)}">
  <button type="submit">בטל את חיבור היומן</button>
</form>
</div>`;
}

// --- GET /connections/calendar/sign -----------------------------------------

function connectionList(connections: readonly string[]): string {
  return `<ul>${connections.map((system) => `<li>${esc(system)}</li>`).join('')}</ul>`;
}

export function renderCalendarSignPage(options: {
  charter: BusinessCharter;
  provider: CalendarProvider;
  csrf: string;
}): string {
  const { charter, provider, csrf } = options;
  const diff = describeCalendarAmendment(charter, provider);
  const name = PROVIDER_NAME[provider];

  const dropped =
    diff.dropped.length === 0
      ? ''
      : `<p>החיבורים האלה שימשו רק ליומן, ולכן יוסרו מהתקנון:</p>${connectionList(diff.dropped)}`;
  const narrowed =
    diff.narrowed.length === 0
      ? ''
      : `<p>החיבורים האלה יישארו, אבל לא ישרתו עוד את היומן:</p>${connectionList(diff.narrowed)}`;
  const subprocessor = diff.subprocessorAdded
    ? `<li>${esc(name)} (<code>${esc(CALENDAR_SUBPROCESSOR[provider])}</code>) יתווסף לרשימת הגורמים שמותר להם לעבד את המידע של העסק — פרטי הפגישות עוברים דרכו.</li>`
    : `<li>${esc(name)} (<code>${esc(CALENDAR_SUBPROCESSOR[provider])}</code>) כבר מותר בתקנון לעבד את המידע של העסק.</li>`;

  return page(
    'חתימה: הוספת היומן לתקנון',
    `<h1>הוספת יומן העסק לתקנון</h1>
<p>ספק: <b>${esc(name)}</b></p>
<div class="card">
<h2>מה החתימה מתירה</h2>
<p>${esc(CALENDAR_AUTHORISATION_TEXT)}</p>
</div>
<div class="card">
<h2>מה משתנה בתקנון</h2>
<ul>
<li>נוסף חיבור חדש: „יומן העסק”, לקריאה ולכתיבה של פגישות.</li>
${subprocessor}
</ul>
${dropped}
${narrowed}
<p>שאר התקנון נשאר בדיוק כפי שנחתם.</p>
</div>
<p>${esc(LEGACY_GAP_NOTE)} ${esc(REVERT_NOTE)}</p>
<p class="muted">${esc(CALENDAR_RESTART_NOTE)}</p>
<p>אחרי החתימה תועבר/י לחבר את היומן אצל ${esc(name)}.</p>
<form method="post" action="/connections/calendar/sign">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="provider" value="${esc(provider)}">
  <input type="hidden" name="base" value="${esc(charter.charterVersion)}">
  <button type="submit">חתימה על התוספת לתקנון</button>
</form>`,
  );
}

const PREFLIGHT_TITLE = 'אי אפשר לחתום עדיין';

/** Why a sign that would add the calendar is refused: the ceremony could not be completed afterwards. */
function preflightRefusal(reason: string): string {
  return errorPage(
    PREFLIGHT_TITLE,
    `לא ניתן לחבר כרגע את היומן אצל הספק, ולכן החתימה לא תתבצע — היא הייתה משאירה את העסק בלי חיבור יומן שאפשר להשלים. ${reason} לא בוצעה כל פעולה.`,
  );
}

export async function handleCalendarSignGet(
  res: ServerResponse,
  db: BusinessDb,
  csrf: string,
  query: URLSearchParams,
  credentialKeyPath: string | undefined,
): Promise<void> {
  const provider = parseCalendarProvider(query.get('provider'));
  if (provider === null) return sendHtml(res, 400, errorPage('ספק לא תקין', BAD_PROVIDER));
  const read = await readCharter(db);
  if (!read.ok) return sendHtml(res, 409, errorPage('לא ניתן לחתום', read.message));
  if (calendarOf(read.charter) !== undefined) return sendHtml(res, 409, errorPage('כבר נחתם', ALREADY_DECLARED));
  const preflight = await oauthCeremonyPreflight(db, provider, credentialKeyPath);
  if (preflight !== null) return sendHtml(res, 409, preflightRefusal(preflight));
  sendHtml(res, 200, renderCalendarSignPage({ charter: read.charter, provider, csrf }));
}

// --- POST /connections/calendar/sign ----------------------------------------

/** CSRF, provider, charter, stale handle, preflight — then the amendment is REBUILT here, never taken from the form. */
export async function handleCalendarSignPost(
  res: ServerResponse,
  db: BusinessDb,
  session: CalendarSession,
  form: URLSearchParams,
  credentialKeyPath: string | undefined,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, errorPage('הבקשה נדחתה', CSRF_REFUSAL));
  }
  const provider = parseCalendarProvider(form.get('provider'));
  if (provider === null) return sendHtml(res, 400, errorPage('ספק לא תקין', BAD_PROVIDER));

  const read = await readCharter(db);
  if (!read.ok) return sendHtml(res, 409, errorPage('לא ניתן לחתום', read.message));
  const active = read.charter;
  if (calendarOf(active) !== undefined) return sendHtml(res, 409, errorPage('כבר נחתם', ALREADY_DECLARED));
  const base = form.get('base');
  if (base !== active.charterVersion) return sendHtml(res, 409, errorPage('התקנון השתנה', STALE_MESSAGE));
  const preflight = await oauthCeremonyPreflight(db, provider, credentialKeyPath);
  if (preflight !== null) return sendHtml(res, 409, preflightRefusal(preflight));

  const outcome = await installSigned(
    db,
    session.username,
    base,
    buildCalendarAmendment(active, new Date(), provider),
    `charter amendment signed in the dashboard by ${session.username}: added the "${CALENDAR_SYSTEM}" ` +
      `connection (provider: ${provider}), superseding ${active.charterVersion}`,
  );
  if (outcome === 'stale') return sendHtml(res, 409, errorPage('התקנון השתנה', STALE_MESSAGE));
  seeOther(res, '/connections/calendar');
}

// --- POST /connections/calendar/revert --------------------------------------

const MAX_CHAIN_WALK = 100;

/** The charter version the calendar amendment superseded: walk `supersedes` back while a calendar is still declared. */
async function versionBeforeCalendar(db: BusinessDb, active: BusinessCharter): Promise<BusinessCharter | null> {
  let current = active;
  for (let step = 0; step < MAX_CHAIN_WALK; step += 1) {
    if (calendarOf(current) === undefined) return current;
    if (current.supersedes === undefined) return null;
    let previous: BusinessCharter | null;
    try {
      const supersedes = current.supersedes;
      previous = await loadCharterVersion(db, supersedes);
    } catch (error) {
      console.error('calendar revert: could not read a superseded charter:', error instanceof Error ? error.message : error);
      return null;
    }
    if (previous === null) return null;
    current = previous;
  }
  return null;
}

/**
 * A NEW signed amendment (never re-activating an old row) that gives back only
 * the calendar tools the amendment took (`buildCalendarRevert`). Refused while
 * the calendar is working.
 */
export async function handleCalendarRevertPost(
  res: ServerResponse,
  db: BusinessDb,
  session: CalendarSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, errorPage('הבקשה נדחתה', CSRF_REFUSAL));
  }
  const read = await readCharter(db);
  if (!read.ok) return sendHtml(res, 409, errorPage('לא ניתן לבטל', read.message));
  const active = read.charter;
  if (calendarOf(active) === undefined) {
    return sendHtml(res, 409, errorPage('אין מה לבטל', 'התקנון הפעיל אינו מגדיר יומן. לא בוצעה כל פעולה.'));
  }
  if ((await calendarIsWorking(db)).working) {
    return sendHtml(
      res,
      409,
      errorPage('היומן מחובר', 'היומן מחובר ופעיל, ולכן אי אפשר לבטל אותו מכאן. לא בוצעה כל פעולה.'),
    );
  }
  const base = form.get('base');
  if (base !== active.charterVersion) return sendHtml(res, 409, errorPage('התקנון השתנה', STALE_MESSAGE));

  const before = await versionBeforeCalendar(db, active);
  if (before === null) {
    return sendHtml(
      res,
      409,
      errorPage(
        'לא ניתן לבטל',
        'לא נמצאה גרסת התקנון שלפני הוספת היומן, ולכן אין לאן לחזור. יש לפנות למי שמחזיק את ההתקנה. לא בוצעה כל פעולה.',
      ),
    );
  }

  const outcome = await installSigned(
    db,
    session.username,
    base,
    buildCalendarRevert(active, new Date(), before),
    `charter amendment signed in the dashboard by ${session.username}: removed the "${CALENDAR_SYSTEM}" ` +
      `connection, restoring the calendar tools of ${before.charterVersion}; superseding ${active.charterVersion}`,
  );
  if (outcome === 'stale') return sendHtml(res, 409, errorPage('התקנון השתנה', STALE_MESSAGE));
  seeOther(res, '/connections/calendar');
}
