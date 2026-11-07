/**
 * Handlers for `/meetings/settings` (settings routes only; the meeting
 * screens come in a later task).
 *
 * The page lists the account's calendars through `resolveCalendarAccess` +
 * `listCalendars`: checkboxes are the READ set, radios the WRITE calendar, the
 * write radio disabled where the provider says the calendar is read-only.
 * When the calendar is not connected (or cannot be listed) the page says so
 * and still saves the other fields — and, because the calendar inputs are not
 * rendered then, the stored read/write selection is carried over untouched
 * rather than wiped by a form that never offered it.
 *
 * Calendar names are text a provider (or someone who shared a calendar with
 * the owner) wrote, so each goes through `toOneLine` + `escLabel` before it
 * reaches the page. Every POST verifies CSRF first; every refusal is a Hebrew
 * sentence and nothing is written. No setting here widens authority.
 */
import type { ServerResponse } from 'node:http';
import { resolveCalendarAccess, type CalendarAccess } from '../calendar/client-for.js';
import type { CalendarClient, CalendarInfo } from '../calendar/types.js';
import { MasterKeyError, loadMasterKey, verifyKeyState } from '../governance/master-key.js';
import { storedCredentials } from '../governance/credential-store.js';
import { googleTokenHttp } from '../orchestrator/adapters/google-token-http.js';
import { microsoftTokenHttp } from '../orchestrator/adapters/microsoft-token-http.js';
import { providerTokenHttp } from '../orchestrator/adapters/provider-token-http.js';
import type { CredentialSource } from '../orchestrator/credentials.js';
import { oauthCredentials } from '../orchestrator/oauth-token.js';
import {
  loadMeetingSettings,
  saveMeetingSettings,
  type LocationKind,
  type MeetingSettings,
} from '../meetings/settings.js';
import { toOneLine } from '../util/bidi.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import { escLabel, escapeHtml as esc, page, renderForbidden } from './views.js';

export interface MeetingSession {
  sessionId: string;
  username: string;
}

/** What the settings page needs from `createServer`'s options. */
export interface MeetingRouteOptions {
  credentialKeyPath: string | undefined;
  /** Test seam: the credential source the calendar token is resolved through. Absent: the real one, built from the master key. */
  calendarCredentials?: CredentialSource;
  /** Test seam: the calendar client. Absent: the real one for the bound provider. */
  calendarClient?: CalendarClient;
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

const LIST_TIMEOUT_MS = 10_000;

const NOT_CONNECTED = 'היומן לא מחובר';
const LIST_FAILED = 'היומן מחובר, אבל לא הצלחתי לקרוא עכשיו את רשימת היומנים';
const NEEDS_REAUTH = 'היומן דורש אישור מחדש';
const CREDENTIAL_ERROR = 'לא הצלחתי לפתוח את ההרשאה השמורה ליומן — אם זה חוזר, חבר את היומן מחדש.';

type Calendars =
  | { listed: true; calendars: CalendarInfo[] }
  | { listed: false; reason: string };

/** The real credential source, built from the master key the way `buildRuntime` builds it; `null` when no usable key. */
async function realCredentials(credentialKeyPath: string | undefined): Promise<CredentialSource | null> {
  if (credentialKeyPath === undefined || credentialKeyPath.length === 0) return null;
  try {
    const key = await loadMasterKey(credentialKeyPath);
    await verifyKeyState(key);
    return oauthCredentials({
      key,
      fallback: storedCredentials(key),
      http: providerTokenHttp({
        google: googleTokenHttp({ credentials: storedCredentials(key) }),
        microsoft: microsoftTokenHttp({ credentials: storedCredentials(key) }),
      }),
    });
  } catch (error) {
    if (!(error instanceof MasterKeyError)) {
      console.error('meeting settings: could not build the credential source:', error instanceof Error ? error.message : error);
    }
    return null;
  }
}

async function listAccountCalendars(businessId: string, options: MeetingRouteOptions): Promise<Calendars> {
  const credentials = options.calendarCredentials ?? (await realCredentials(options.credentialKeyPath));
  if (credentials === null) return { listed: false, reason: NOT_CONNECTED };
  const access = await resolveCalendarAccess({
    businessId,
    runtime: { credentials },
    ...(options.calendarClient !== undefined ? { client: options.calendarClient } : {}),
  });
  if ('unavailable' in access) {
    return { listed: false, reason: access.unavailable === 'needs_reauth' ? NEEDS_REAUTH : access.unavailable === 'credential_error' ? CREDENTIAL_ERROR : NOT_CONNECTED };
  }
  return listWith(access);
}

async function listWith(access: CalendarAccess): Promise<Calendars> {
  try {
    const result = await access.client.listCalendars(access.token, AbortSignal.timeout(LIST_TIMEOUT_MS));
    if (!Array.isArray(result)) return { listed: false, reason: LIST_FAILED };
    return { listed: true, calendars: result };
  } catch {
    return { listed: false, reason: LIST_FAILED };
  }
}

// --- Rendering ---------------------------------------------------------------

const LOCATION_LABEL: Readonly<Record<LocationKind, string>> = {
  travel: 'אני נוסע ללקוחות',
  fixed: 'הלקוחות באים למקום קבוע',
  mixed: 'גם וגם',
};

function calendarName(info: CalendarInfo): string {
  return escLabel(toOneLine(info.name)) || esc(info.calendarId);
}

function calendarsSection(calendars: Calendars, s: MeetingSettings): string {
  if (!calendars.listed) {
    return `<h2>יומנים</h2>
<p class="error" role="status">${esc(calendars.reason)}</p>
<p class="muted">עד שהיומן יחובר אי אפשר לבחור יומנים. שאר ההגדרות נשמרות כרגיל, והבחירה הקודמת (אם הייתה) נשארת. <a href="/connections/calendar">למסך היומן</a></p>`;
  }
  const rows = calendars.calendars
    .map((c) => {
      // An empty stored set means "every calendar": nothing is ticked, so saving the page
      // as it stands keeps it empty instead of freezing today's list.
      const readChecked = s.readCalendarIds.includes(c.calendarId);
      const writeChecked = s.writeCalendarId === c.calendarId || (s.writeCalendarId === null && c.primary);
      return `<tr>
  <td><label style="margin:0"><input type="checkbox" name="read" value="${esc(c.calendarId)}"${readChecked ? ' checked' : ''}> ${calendarName(c)}${c.primary ? ' (ראשי)' : ''}</label></td>
  <td><label style="margin:0"><input type="radio" name="write" value="${esc(c.calendarId)}"${writeChecked ? ' checked' : ''}${c.canWrite ? '' : ' disabled'}> ${c.canWrite ? 'כאן' : 'לקריאה בלבד'}</label></td>
</tr>`;
    })
    .join('\n');
  return `<h2>יומנים</h2>
<input type="hidden" name="calendarsListed" value="1">
<p class="muted">סמן את היומנים שהעוזרת תקרא כדי לדעת מתי אתה תפוס. אם לא תסמן אף אחד — כל היומנים בחשבון. בעמודה השנייה בחר את יומן הפגישות: רק בו העוזרת תכתוב. אי אפשר לבחור יומן שהוא לקריאה בלבד.</p>
<table>
<tr><th>לקרוא</th><th>יומן הפגישות</th></tr>
${rows}
</table>`;
}

function radio(name: string, value: string, checked: boolean, label: string): string {
  return `<label style="margin:0"><input type="radio" name="${name}" value="${esc(value)}"${checked ? ' checked' : ''}> ${esc(label)}</label>`;
}

function numberField(name: string, label: string, value: number, hint?: string): string {
  return `<label>${esc(label)}${hint !== undefined ? ` <span class="muted">(${esc(hint)})</span>` : ''}<br><input type="number" name="${name}" value="${esc(String(value))}" min="0" step="1"></label>`;
}

interface FormValues {
  settings: MeetingSettings;
}

function renderSettings(input: { values: FormValues; calendars: Calendars; csrf: string; error?: string; saved?: boolean }): string {
  const s = input.values.settings;
  const body = `<header>
  <h1>הגדרות הפגישות</h1>
  <form method="post" action="/logout" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(input.csrf)}">
    <button type="submit">התנתקות</button>
  </form>
</header>
<nav><a href="/">לכרטיסי האישור</a> · <a href="/connections/calendar">יומן העסק</a></nav>
${input.error !== undefined ? `<p class="error" role="alert">${esc(input.error)}</p>` : ''}
${input.saved === true ? '<p role="status"><b>ההגדרות נשמרו.</b></p>' : ''}
<p class="muted">ההגדרות כאן קובעות אילו שעות העוזרת מציעה ומתי היא מזכירה — הן אינן נותנות לה סמכות. כל פגישה שהיא קובעת, מזיזה או מבטלת עוברת אישור שלך.</p>
<form method="post" action="/meetings/settings">
  <input type="hidden" name="csrf" value="${esc(input.csrf)}">
  <h2>איפה נערכות הפגישות <span class="muted">(חובה)</span></h2>
  <div>${(['travel', 'fixed', 'mixed'] as const).map((k) => radio('locationKind', k, s.locationKind === k, LOCATION_LABEL[k])).join('<br>')}</div>
  <label>כתובת המקום הקבוע <span class="muted">(חובה כשהלקוחות באים אליך)</span><br><input type="text" name="fixedAddress" value="${esc(s.fixedAddress ?? '')}" maxlength="300"></label>
  <h2>זמנים</h2>
  ${numberField('gapMinutes', 'רווח בין פגישות, בדקות', s.gapMinutes, '0 עד 240')}
  ${numberField('defaultDurationMinutes', 'משך פגישה רגיל, בדקות', s.defaultDurationMinutes, '5 עד 600')}
  <label>תחילת יום העבודה <input type="time" name="workStart" value="${esc(s.workStart ?? '')}"></label>
  <label>סוף יום העבודה <input type="time" name="workEnd" value="${esc(s.workEnd ?? '')}"></label>
  <p class="muted">אם משאירים ריק: שעות הפעילות שבתקנון, ואם אין — 09:00 עד 18:00.</p>
  ${calendarsSection(input.calendars, s)}
  <h2>תזכורות ללקוח</h2>
  ${numberField('reminderHours', 'כמה שעות לפני הפגישה לשלוח תזכורת', s.reminderHours, 'לפחות 1')}
  ${numberField('reminderHoursSoon', 'כשהפגישה בתוך פחות מ-24 שעות — כמה שעות לפניה', s.reminderHoursSoon, 'לפחות 1')}
  <div><button type="submit">שמירה</button></div>
</form>`;
  return page('הגדרות הפגישות', body);
}

// --- GET ---------------------------------------------------------------------

export async function handleMeetingSettingsGet(
  res: ServerResponse,
  businessId: string,
  session: MeetingSession,
  query: URLSearchParams,
  options: MeetingRouteOptions,
): Promise<void> {
  const [settings, calendars] = await Promise.all([
    loadMeetingSettings({ businessId }),
    listAccountCalendars(businessId, options),
  ]);
  html(
    res,
    200,
    renderSettings({
      values: { settings },
      calendars,
      csrf: issueCsrfToken(session.sessionId),
      saved: query.get('saved') === '1',
    }),
  );
}

// --- POST --------------------------------------------------------------------

/** A whole number or NaN — never a partial parse of "12abc". */
function wholeNumber(raw: string | null): number {
  const s = (raw ?? '').trim();
  return /^\d{1,6}$/.test(s) ? Number(s) : Number.NaN;
}

function timeOrNull(raw: string | null): string | null {
  const s = (raw ?? '').trim();
  return s === '' ? null : s;
}

const BAD_NUMBER = 'יש להזין מספרים שלמים בשדות הזמן והתזכורות';
const PRIMARY_NOT_READ = 'יומן הפגישות הראשי חייב להיות בין היומנים שהעוזרת קוראת — סמן אותו, או בחר יומן פגישות אחר';
const UNKNOWN_CALENDAR = 'אחד היומנים שנבחרו אינו קיים בחשבון — רענן את הדף ובחר שוב';
const READ_ONLY_CALENDAR = 'אי אפשר לכתוב ביומן שהוא לקריאה בלבד — בחר יומן פגישות אחר';
const LIST_LOST = 'לא הצלחתי לקרוא עכשיו את רשימת היומנים, ולכן לא שמרתי דבר — נסה שוב בעוד רגע';

export async function handleMeetingSettingsPost(
  res: ServerResponse,
  businessId: string,
  session: MeetingSession,
  form: URLSearchParams,
  options: MeetingRouteOptions,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());

  const stored = await loadMeetingSettings({ businessId });
  const kindRaw = form.get('locationKind');
  const listedInForm = form.get('calendarsListed') === '1';

  const submitted: MeetingSettings = {
    locationKind: kindRaw === 'travel' || kindRaw === 'fixed' || kindRaw === 'mixed' ? kindRaw : null,
    fixedAddress: (form.get('fixedAddress') ?? '').trim() === '' ? null : (form.get('fixedAddress') ?? '').trim(),
    gapMinutes: wholeNumber(form.get('gapMinutes')),
    defaultDurationMinutes: wholeNumber(form.get('defaultDurationMinutes')),
    workStart: timeOrNull(form.get('workStart')),
    workEnd: timeOrNull(form.get('workEnd')),
    // The calendar inputs exist only when the account's calendars were listed;
    // otherwise what is stored stays.
    readCalendarIds: listedInForm ? [...new Set(form.getAll('read'))] : stored.readCalendarIds,
    writeCalendarId: listedInForm ? ((form.get('write') ?? '') === '' ? null : (form.get('write') as string)) : stored.writeCalendarId,
    reminderHours: wholeNumber(form.get('reminderHours')),
    reminderHoursSoon: wholeNumber(form.get('reminderHoursSoon')),
  };

  let fetched: Calendars | null = null;
  const refuse = async (message: string): Promise<void> => {
    const calendars = fetched ?? (await listAccountCalendars(businessId, options));
    html(
      res,
      400,
      renderSettings({ values: { settings: submitted }, calendars, csrf: issueCsrfToken(session.sessionId), error: message }),
    );
  };

  if (
    Number.isNaN(submitted.gapMinutes) ||
    Number.isNaN(submitted.defaultDurationMinutes) ||
    Number.isNaN(submitted.reminderHours) ||
    Number.isNaN(submitted.reminderHoursSoon)
  ) {
    return refuse(BAD_NUMBER);
  }

  // Calendar choices are checked against the account's own list whenever the
  // form offered them: a crafted id, or a read-only write calendar, is refused.
  if (listedInForm) {
    const calendars = await listAccountCalendars(businessId, options);
    fetched = calendars;
    if (!calendars.listed) return refuse(LIST_LOST);
    const byId = new Map(calendars.calendars.map((c) => [c.calendarId, c] as const));
    if (submitted.readCalendarIds.some((id) => !byId.has(id))) return refuse(UNKNOWN_CALENDAR);
    if (submitted.writeCalendarId !== null) {
      const target = byId.get(submitted.writeCalendarId);
      if (target === undefined) return refuse(UNKNOWN_CALENDAR);
      if (!target.canWrite) return refuse(READ_ONLY_CALENDAR);
    } else {
      const primary = calendars.calendars.find((c) => c.primary);
      if (primary !== undefined && submitted.readCalendarIds.length > 0 && !submitted.readCalendarIds.includes(primary.calendarId)) {
        return refuse(PRIMARY_NOT_READ);
      }
    }
  }

  const result = await saveMeetingSettings(submitted, { businessId });
  if (!result.ok) return refuse(result.reason);
  seeOther(res, '/meetings/settings?saved=1');
}
