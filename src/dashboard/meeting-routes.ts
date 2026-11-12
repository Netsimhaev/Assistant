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
import { appendAudit } from '../audit/log.js';
import { resolveCalendarAccess, type CalendarAccess } from '../calendar/client-for.js';
import { isCalendarFailure, type CalendarClient, type CalendarInfo } from '../calendar/types.js';
import { loadActiveCharter } from '../charter/store.js';
import { transaction, type BusinessDb } from '../db/pool.js';
import { MAX_INSTRUCTION_CHARS } from '../governance/instructions.js';
import { MasterKeyError, loadMasterKey, verifyKeyState } from '../governance/master-key.js';
import { storedCredentials } from '../governance/credential-store.js';
import { googleTokenHttp } from '../orchestrator/adapters/google-token-http.js';
import { microsoftTokenHttp } from '../orchestrator/adapters/microsoft-token-http.js';
import { platformSecrets } from '../tenancy/platform-credentials.js';
import { providerTokenHttp } from '../orchestrator/adapters/provider-token-http.js';
import type { CredentialSource } from '../orchestrator/credentials.js';
import { oauthCredentials } from '../orchestrator/oauth-token.js';
import {
  loadMeetingSettings,
  saveMeetingSettings,
  type LocationKind,
  type MeetingSettings,
} from '../meetings/settings.js';
import {
  CALENDAR_CREDENTIAL_REPLY,
  CALENDAR_NEEDS_REAUTH_REPLY,
  CALENDAR_NOT_CONNECTED_REPLY,
  CALENDAR_READ_FAILED_REPLY,
} from '../meetings/door.js';
import {
  eventResponseLabel,
  hhmm,
  loadMeetingResponses,
  localDayLabel,
  TRUNCATED_SNAPSHOT_WARNING,
} from '../meetings/query.js';
import { MeetingRequest as MeetingRequestSchema, type MeetingRequest } from '../meetings/request.js';
import { loadCalendarRange } from '../meetings/snapshot.js';
import { dashboardConfirmations } from '../orchestrator/command-confirm.js';
import { runInstruction } from '../orchestrator/instruct.js';
import { toOneLine } from '../util/bidi.js';
import { canonicalHash } from '../util/canonical.js';
import { localParts, localToInstant } from '../util/local-time.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import { confirmationCard, escLabel, escapeHtml as esc, page, renderForbidden, renderNotFound } from './views.js';

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

/** The real credential source, built from the master key the way `buildServerRuntime` builds it; `null` when no usable key. */
async function realCredentials(db: BusinessDb, credentialKeyPath: string | undefined): Promise<CredentialSource | null> {
  if (credentialKeyPath === undefined || credentialKeyPath.length === 0) return null;
  try {
    const key = await loadMasterKey(credentialKeyPath);
    // On this request's connection: a second acquire while it is held is
    // hold-and-wait (Task 10 fix round 2).
    await verifyKeyState(key, db);
    return oauthCredentials({
      key,
      fallback: storedCredentials(key),
      http: providerTokenHttp({
        google: googleTokenHttp({ clients: platformSecrets(key) }),
        microsoft: microsoftTokenHttp({ clients: platformSecrets(key) }),
      }),
    });
  } catch (error) {
    if (!(error instanceof MasterKeyError)) {
      console.error('meeting settings: could not build the credential source:', error instanceof Error ? error.message : error);
    }
    return null;
  }
}

/**
 * Calendar access for the instruction door's schedule answer: the same credential
 * source and client seams the settings page uses. `undefined` when no usable
 * credential source exists (no master key) — the door then does not route
 * schedule questions, exactly as when nothing is connected.
 */
export async function calendarWiring(
  db: BusinessDb,
  options: MeetingRouteOptions,
): Promise<{ runtime: { credentials: CredentialSource }; client?: CalendarClient } | undefined> {
  const credentials = options.calendarCredentials ?? (await realCredentials(db, options.credentialKeyPath));
  if (credentials === null) return undefined;
  return { runtime: { credentials }, ...(options.calendarClient !== undefined ? { client: options.calendarClient } : {}) };
}

async function listAccountCalendars(db: BusinessDb, options: MeetingRouteOptions): Promise<Calendars> {
  const credentials = options.calendarCredentials ?? (await realCredentials(db, options.credentialKeyPath));
  if (credentials === null) return { listed: false, reason: NOT_CONNECTED };
  const access = await resolveCalendarAccess(db, {
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
  <p class="muted">הזמנה שהלקוח לא ענה עליה: העוזרת מחכה כאן לתשובה, ורק אז שולחת לו תזכורת אחת. הזמן נמדד מרגע שההזמנה נשלחה, לא לפני הפגישה.</p>
  ${numberField('reminderHours', 'כמה שעות לחכות לתשובת הלקוח לפני תזכורת', s.reminderHours, 'לפחות 1')}
  ${numberField('reminderHoursSoon', 'כשהפגישה בעוד פחות מ-24 שעות — כמה שעות לחכות לתשובה', s.reminderHoursSoon, 'לפחות 1')}
  <div><button type="submit">שמירה</button></div>
</form>`;
  return page('הגדרות הפגישות', body);
}

// --- GET ---------------------------------------------------------------------

export async function handleMeetingSettingsGet(
  res: ServerResponse,
  db: BusinessDb,
  session: MeetingSession,
  query: URLSearchParams,
  options: MeetingRouteOptions,
): Promise<void> {
  // Sequential, never `Promise.all`: both read on this request's one
  // connection, and two queries in flight on it interleave.
  const settings = await loadMeetingSettings(db);
  const calendars = await listAccountCalendars(db, options);
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
  db: BusinessDb,
  session: MeetingSession,
  form: URLSearchParams,
  options: MeetingRouteOptions,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());

  const stored = await loadMeetingSettings(db);
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
    const calendars = fetched ?? (await listAccountCalendars(db, options));
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
    const calendars = await listAccountCalendars(db, options);
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

  const result = await saveMeetingSettings(db, submitted);
  if (!result.ok) return refuse(result.reason);
  seeOther(res, '/meetings/settings?saved=1');
}

// =============================================================================
// The meetings screen: `/meetings`, `/meetings/new`, `/meetings/:id/mark`
// =============================================================================
//
// Four blocks, in this order: meeting questions waiting on the owner (the same
// confirmation cards `/instruct` shows, posting to the same confirm route),
// tomorrow's meetings with each client's response, a client's mail that arrived
// after the invitation (so the owner can mark "אישר"/"דחה" himself — the
// assistant never flips a response from a stranger's free text, spec §8.2),
// and the new-meeting form.
//
// The form books through the instruction door: it builds the `MeetingRequest`
// itself (no model extraction) and a deterministic instruction text carrying the
// typed email and phone verbatim, so the door's `appearsVerbatimIn` check
// verifies them against the text the owner typed. Client notes and the internal
// note live only in the structured request — they may be long, and the 4,000
// character cap must not refuse a valid form.

const RESPONSE_PAIR = ['accepted', 'declined'] as const;
type MarkableResponse = (typeof RESPONSE_PAIR)[number];

const MAX_NAME = 120;
const MAX_PHONE = 40;
const MAX_LOCATION = 300;
const MAX_NOTE = 1000;
const MAX_EMAIL = 254;
const REPLIES_PER_MEETING = 3;
const REPLIES_TOTAL = 100;
const DAY_READ_TIMEOUT_MS = 20_000;

export interface MeetingFormValues {
  name: string;
  email: string;
  phone: string;
  location: string;
  clientNotes: string;
  internalNote: string;
  fromDate: string;
  toDate: string;
  fromTime: string;
  toTime: string;
  duration: string;
}

const EMPTY_FORM: MeetingFormValues = {
  name: '',
  email: '',
  phone: '',
  location: '',
  clientNotes: '',
  internalNote: '',
  fromDate: '',
  toDate: '',
  fromTime: '',
  toTime: '',
  duration: '',
};

function formValuesFrom(form: URLSearchParams): MeetingFormValues {
  const get = (k: keyof MeetingFormValues): string => (form.get(k) ?? '').trim();
  return {
    name: get('name'),
    email: get('email'),
    phone: get('phone'),
    location: get('location'),
    clientNotes: get('clientNotes'),
    internalNote: get('internalNote'),
    fromDate: get('fromDate'),
    toDate: get('toDate'),
    fromTime: get('fromTime'),
    toTime: get('toTime'),
    duration: get('duration'),
  };
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_SHAPE_FORM = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;

/** A Hebrew problem with the form, or the request and the instruction text built from it. */
function buildMeeting(v: MeetingFormValues): { error: string } | { request: MeetingRequest; text: string } {
  if (v.name === '') return { error: 'חובה למלא את שם הלקוח.' };
  if (v.name.length > MAX_NAME) return { error: `שם הלקוח ארוך מ-${MAX_NAME} תווים.` };
  if (v.email !== '' && (v.email.length > MAX_EMAIL || !EMAIL_SHAPE_FORM.test(v.email))) {
    return { error: 'כתובת המייל אינה תקינה.' };
  }
  if (v.phone.length > MAX_PHONE) return { error: `הטלפון ארוך מ-${MAX_PHONE} תווים.` };
  if (v.location.length > MAX_LOCATION) return { error: `המיקום ארוך מ-${MAX_LOCATION} תווים.` };
  if (v.clientNotes.length > MAX_NOTE) return { error: `ההערות ללקוח ארוכות מ-${MAX_NOTE} תווים.` };
  if (v.internalNote.length > MAX_NOTE) return { error: `ההערה הפנימית ארוכה מ-${MAX_NOTE} תווים.` };
  if (!isRealDate(v.fromDate)) return { error: 'חובה לבחור תאריך התחלה תקין.' };
  const toDate = v.toDate === '' ? v.fromDate : v.toDate;
  if (!isRealDate(toDate)) return { error: 'תאריך הסיום אינו תקין.' };
  if (v.fromDate > toDate) return { error: 'תאריך ההתחלה חייב להיות לפני תאריך הסיום או שווה לו.' };
  if (v.fromTime !== '' && !TIME_SHAPE.test(v.fromTime)) return { error: 'שעת ההתחלה אינה תקינה (HH:MM).' };
  if (v.toTime !== '' && !TIME_SHAPE.test(v.toTime)) return { error: 'שעת הסיום אינה תקינה (HH:MM).' };
  if (v.fromTime !== '' && v.toTime !== '' && v.fromTime >= v.toTime) {
    return { error: 'שעת ההתחלה חייבת להיות לפני שעת הסיום.' };
  }
  let duration: number | null = null;
  if (v.duration !== '') {
    duration = /^\d{1,4}$/.test(v.duration) ? Number(v.duration) : Number.NaN;
    if (!Number.isInteger(duration) || duration < 5 || duration > 600) {
      return { error: 'משך הפגישה חייב להיות בין 5 ל-600 דקות.' };
    }
  }

  // One line per field: a newline typed into the name must not forge a field.
  const name = toOneLine(v.name);
  const location = toOneLine(v.location);
  const phone = toOneLine(v.phone);
  const window =
    `${v.fromDate}${toDate === v.fromDate ? '' : ` עד ${toDate}`}` +
    (v.fromTime !== '' || v.toTime !== '' ? ` ${v.fromTime || '..'}–${v.toTime || '..'}` : '');
  const text = [
    'קביעת פגישה',
    `שם: ${name}`,
    ...(v.email !== '' ? [`אימייל: ${v.email}`] : []),
    ...(phone !== '' ? [`טלפון: ${phone}`] : []),
    ...(location !== '' ? [`מיקום: ${location}`] : []),
    `חלון: ${window}`,
    ...(duration !== null ? [`משך: ${duration} דקות`] : []),
  ].join('\n');

  const request: MeetingRequest = {
    ops: [
      {
        kind: 'create',
        client: { name, email: v.email === '' ? null : v.email, phone: phone === '' ? null : phone },
        location: location === '' ? null : location,
        clientNotes: v.clientNotes === '' ? null : v.clientNotes,
        internalNote: v.internalNote === '' ? null : v.internalNote,
        window: {
          fromDate: v.fromDate,
          toDate,
          fromTime: v.fromTime === '' ? null : v.fromTime,
          toTime: v.toTime === '' ? null : v.toTime,
        },
        durationMinutes: duration,
      },
    ],
  };
  if (!MeetingRequestSchema.safeParse(request).success) return { error: 'הפרטים שהוזנו אינם תקינים.' };
  return { request, text };
}

// --- Data ---------------------------------------------------------------------

interface TomorrowRow {
  time: string;
  client: string;
  location: string;
  label: string;
}

type Tomorrow =
  | { ok: true; dayLabel: string; rows: TomorrowRow[]; truncated: boolean }
  | { ok: false; reason: string };

function addDaysIso(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

async function charterZone(db: BusinessDb): Promise<{ timeZone: string; charterVersion: string }> {
  try {
    const active = await loadActiveCharter(db);
    if (active !== null) return { timeZone: active.charter.identity.timezone, charterVersion: active.charter.charterVersion };
  } catch {
    // an unreadable charter costs the zone, not the page
  }
  return { timeZone: 'UTC', charterVersion: 'unknown' };
}

async function loadTomorrow(db: BusinessDb, timeZone: string, options: MeetingRouteOptions): Promise<Tomorrow> {
  const businessId = db.businessId;
  const wiring = await calendarWiring(db, options);
  if (wiring === undefined) return { ok: false, reason: CALENDAR_NOT_CONNECTED_REPLY };
  const access = await resolveCalendarAccess(db, {
    runtime: wiring.runtime,
    ...(wiring.client !== undefined ? { client: wiring.client } : {}),
  });
  if ('unavailable' in access) {
    return {
      ok: false,
      reason:
        access.unavailable === 'needs_reauth'
          ? CALENDAR_NEEDS_REAUTH_REPLY
          : access.unavailable === 'credential_error'
            ? CALENDAR_CREDENTIAL_REPLY
            : CALENDAR_NOT_CONNECTED_REPLY,
    };
  }

  const tomorrow = addDaysIso(localParts(new Date(), timeZone).date, 1);
  const dayStart = localToInstant(tomorrow, '00:00', timeZone).getTime();
  const dayEnd = localToInstant(addDaysIso(tomorrow, 1), '00:00', timeZone).getTime();
  const settings = await loadMeetingSettings(db);
  let snapshot;
  try {
    snapshot = await loadCalendarRange(db, {
      access,
      settings,
      timeZone,
      fromIso: new Date(dayStart).toISOString(),
      toIso: new Date(dayEnd).toISOString(),
      signal: AbortSignal.timeout(DAY_READ_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: CALENDAR_READ_FAILED_REPLY };
  }
  if (isCalendarFailure(snapshot)) {
    return { ok: false, reason: snapshot.failure === 'auth' ? CALENDAR_NEEDS_REAUTH_REPLY : CALENDAR_READ_FAILED_REPLY };
  }

  const events = snapshot.events
    .filter((e) => {
      const s = Date.parse(e.start);
      const en = Date.parse(e.end);
      return Number.isFinite(s) && Number.isFinite(en) && s < dayEnd && (en > dayStart || s >= dayStart);
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title));

  const responses = await loadMeetingResponses(
    db,
    events.map((e) => e.eventId),
  );
  const { rows: names } = await db.query<{ event_id: string; client_name: string }>(
    `SELECT DISTINCT ON (event_id) event_id, client_name FROM meetings
      WHERE business_id = $1 AND event_id = ANY($2::text[]) AND state IN ('proposed','active')
      ORDER BY event_id, updated_at DESC`,
    [businessId, events.map((e) => e.eventId)],
  );
  const clientOf = new Map(names.map((r) => [r.event_id, r.client_name] as const));

  return {
    ok: true,
    dayLabel: localDayLabel(dayStart + 12 * 3_600_000, timeZone),
    truncated: snapshot.truncated,
    rows: events.map((e) => ({
      time: e.allDay ? 'כל היום' : `${hhmm(Date.parse(e.start), timeZone)}–${hhmm(Date.parse(e.end), timeZone)}`,
      client: toOneLine(clientOf.get(e.eventId) ?? e.title) || '(ללא כותרת)',
      location: toOneLine(e.location ?? ''),
      label: eventResponseLabel(e, responses),
    })),
  };
}

async function pendingMeetingConfirmations(db: BusinessDb, csrf: string): Promise<string> {
  const businessId = db.businessId;
  const confirmations = await dashboardConfirmations(db);
  if (confirmations.length === 0) return '';
  const { rows } = await db.query<{ job_id: string }>(
    `SELECT DISTINCT job_id FROM meetings WHERE business_id = $1 AND job_id = ANY($2::text[]) AND state = 'proposed'`,
    [businessId, confirmations.map((c) => c.jobId)],
  );
  const meetingJobs = new Set(rows.map((r) => r.job_id));
  const cards = confirmations
    .filter((c) => meetingJobs.has(c.jobId))
    .map((c) =>
      confirmationCard(
        { jobId: c.jobId, question: c.presentedText, options: c.options.map((o) => ({ label: o.label, planHash: o.planHash })) },
        csrf,
      ),
    );
  return cards.length === 0 ? '' : `<h2>פגישות שממתינות לאישורך</h2>\n${cards.join('\n')}`;
}

interface ReplyMeeting {
  meetingId: string;
  clientName: string;
  startAt: Date | null;
  mails: { subject: string; receivedAt: Date }[];
}

/** Meetings still waiting on the client, with the mail from the client's address that arrived after the last change. */
async function loadMailReplies(db: BusinessDb): Promise<ReplyMeeting[]> {
  const businessId = db.businessId;
  // `from_address` is the bare address the mailbox stored; compared case-insensitively.
  const { rows } = await db.query<{
    meeting_id: string;
    client_name: string;
    start_at: Date | null;
    subject: string;
    received_at: Date;
  }>(
    `SELECT m.meeting_id, m.client_name, m.start_at, mm.subject, mm.received_at
       FROM meetings m
       JOIN mail_messages mm
         ON mm.business_id = m.business_id
        AND lower(mm.from_address) = lower(m.client_email)
        AND mm.received_at > m.updated_at
      WHERE m.business_id = $1 AND m.state = 'active' AND m.response = 'needs_action'
        AND m.client_email IS NOT NULL
      ORDER BY m.start_at NULLS LAST, m.meeting_id, mm.received_at DESC
      LIMIT $2`,
    [businessId, REPLIES_TOTAL],
  );
  const out: ReplyMeeting[] = [];
  for (const r of rows) {
    let entry = out.find((m) => m.meetingId === r.meeting_id);
    if (entry === undefined) {
      entry = { meetingId: r.meeting_id, clientName: r.client_name, startAt: r.start_at, mails: [] };
      out.push(entry);
    }
    if (entry.mails.length < REPLIES_PER_MEETING) entry.mails.push({ subject: r.subject, receivedAt: r.received_at });
  }
  return out;
}

// --- Rendering ------------------------------------------------------------------

/** Text a client or a provider wrote: one line, bidi controls stripped, escaped. */
function label(value: string): string {
  return escLabel(toOneLine(value));
}

function tomorrowSection(t: Tomorrow): string {
  if (!t.ok) return `<h2>מחר</h2>\n<p class="error" role="status">${esc(t.reason)}</p>`;
  if (t.rows.length === 0) return `<h2>מחר — ${esc(t.dayLabel)}</h2>\n<p class="muted">אין פגישות.</p>`;
  const rows = t.rows
    .map(
      (r) =>
        `<tr><td>${esc(r.time)}</td><td>${label(r.client)}</td><td>${r.location === '' ? '—' : label(r.location)}</td><td>${r.label === '' ? '' : esc(r.label)}</td></tr>`,
    )
    .join('\n');
  return `<h2>מחר — ${esc(t.dayLabel)}</h2>
${t.truncated ? `<p class="error" role="status">${esc(TRUNCATED_SNAPSHOT_WARNING)}</p>` : ''}
<table>
<tr><th>שעה</th><th>לקוח</th><th>מיקום</th><th>תשובה</th></tr>
${rows}
</table>`;
}

function repliesSection(replies: ReplyMeeting[], csrf: string, timeZone: string): string {
  if (replies.length === 0) return '';
  const cards = replies
    .map((m) => {
      const when =
        m.startAt === null ? '' : ` · ${esc(localDayLabel(m.startAt.getTime(), timeZone))} ${esc(hhmm(m.startAt.getTime(), timeZone))}`;
      const mails = m.mails
        .map((x) => `<li>${esc(localDayLabel(x.receivedAt.getTime(), timeZone))}: ${label(x.subject)}</li>`)
        .join('');
      const action = `/meetings/${esc(m.meetingId)}/mark`;
      const button = (response: MarkableResponse, text: string): string =>
        `<form method="post" action="${action}" style="display:inline">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="response" value="${response}">
  <button type="submit">${text}</button>
</form>`;
      return `<article class="card">
  <p><b>${label(m.clientName)}</b>${when} — ⏳ ממתין לתשובה</p>
  <p class="muted">הלקוח כתב לתיבה אחרי ההזמנה. העוזרת לא מסיקה תשובה מתוך הטקסט — את התשובה תסמן אתה.</p>
  <ul>${mails}</ul>
  ${button('accepted', 'אישר')} ${button('declined', 'דחה')}
</article>`;
    })
    .join('\n');
  return `<h2>לקוחות שכתבו</h2>\n${cards}`;
}

function field(name: string, text: string, value: string, extra = ''): string {
  return `<label>${esc(text)}<br><input type="text" name="${name}" value="${esc(value)}"${extra}></label>`;
}

function formSection(v: MeetingFormValues, csrf: string): string {
  return `<h2>פגישה חדשה</h2>
<form method="post" action="/meetings/new">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  ${field('name', 'שם הלקוח (חובה)', v.name, ` maxlength="${MAX_NAME}" required`)}
  ${field('email', 'מייל', v.email, ` maxlength="${MAX_EMAIL}" dir="ltr"`)}
  ${field('phone', 'טלפון', v.phone, ` maxlength="${MAX_PHONE}" dir="ltr"`)}
  ${field('location', 'מיקום', v.location, ` maxlength="${MAX_LOCATION}"`)}
  <label>הערות ללקוח <span class="muted">(הלקוח יראה אותן בהזמנה)</span><br><textarea name="clientNotes" rows="2" maxlength="${MAX_NOTE}">${esc(v.clientNotes)}</textarea></label>
  <label>הערה פנימית <span class="muted">(נשמרת אצלנו בלבד)</span><br><textarea name="internalNote" rows="2" maxlength="${MAX_NOTE}">${esc(v.internalNote)}</textarea></label>
  <label>מתאריך <input type="date" name="fromDate" value="${esc(v.fromDate)}" required></label>
  <label>עד תאריך <input type="date" name="toDate" value="${esc(v.toDate)}"></label>
  <label>משעה <input type="time" name="fromTime" value="${esc(v.fromTime)}"></label>
  <label>עד שעה <input type="time" name="toTime" value="${esc(v.toTime)}"></label>
  <label>משך בדקות <span class="muted">(5 עד 600; ריק — ברירת המחדל מההגדרות)</span> <input type="number" name="duration" value="${esc(v.duration)}" min="5" max="600" step="1"></label>
  <div><button type="submit">הכיני לאישור</button></div>
</form>
<p class="muted">הטופס לא קובע דבר ביומן: העוזרת מחפשת מועד פנוי בחלון, שומרת אותו כהחזקה זמנית ושואלת אותך פעם אחת.</p>`;
}

function renderMeetingsPage(o: {
  csrf: string;
  confirmations: string;
  tomorrow: Tomorrow;
  replies: ReplyMeeting[];
  timeZone: string;
  form: MeetingFormValues;
  error?: string;
}): string {
  const body = `<header>
  <h1>פגישות</h1>
  <form method="post" action="/logout" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(o.csrf)}">
    <button type="submit">התנתקות</button>
  </form>
</header>
<nav><a href="/">לכרטיסי האישור</a> · <a href="/instruct">מה לעשות</a> · <a href="/meetings/settings">הגדרות הפגישות</a> · <a href="/connections/calendar">יומן העסק</a></nav>
${o.error !== undefined ? `<p class="error" role="alert">${esc(o.error)}</p>` : ''}
${o.confirmations}
${tomorrowSection(o.tomorrow)}
${repliesSection(o.replies, o.csrf, o.timeZone)}
${formSection(o.form, o.csrf)}`;
  return page('פגישות', body);
}

async function sendMeetingsPage(
  res: ServerResponse,
  status: number,
  db: BusinessDb,
  session: MeetingSession,
  options: MeetingRouteOptions,
  extra: { form?: MeetingFormValues; error?: string } = {},
): Promise<void> {
  const csrf = issueCsrfToken(session.sessionId);
  const { timeZone } = await charterZone(db);
  // Sequential, never `Promise.all`: all three read on this request's one
  // connection, and two queries in flight on it interleave.
  const confirmations = await pendingMeetingConfirmations(db, csrf);
  const tomorrow = await loadTomorrow(db, timeZone, options);
  const replies = await loadMailReplies(db);
  html(
    res,
    status,
    renderMeetingsPage({
      csrf,
      confirmations,
      tomorrow,
      replies,
      timeZone,
      form: extra.form ?? EMPTY_FORM,
      ...(extra.error !== undefined ? { error: extra.error } : {}),
    }),
  );
}

// --- Routes ---------------------------------------------------------------------

export async function handleMeetingsGet(
  res: ServerResponse,
  db: BusinessDb,
  session: MeetingSession,
  options: MeetingRouteOptions,
): Promise<void> {
  await sendMeetingsPage(res, 200, db, session, options);
}

/**
 * The new-meeting form, through the instruction door. Validation first (a
 * Hebrew sentence and the entered values back on the form); then
 * `runInstruction` with the structured request and `textOrigin: 'typed'` —
 * every field was typed into this form by the owner's session.
 */
export async function handleMeetingNewPost(
  res: ServerResponse,
  db: BusinessDb,
  session: MeetingSession,
  form: URLSearchParams,
  options: MeetingRouteOptions,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());
  const values = formValuesFrom(form);
  const refuse = (error: string): Promise<void> => sendMeetingsPage(res, 400, db, session, options, { form: values, error });

  const built = buildMeeting(values);
  if ('error' in built) return refuse(built.error);
  if (built.text.length > MAX_INSTRUCTION_CHARS) return refuse(`ההוראה שנבנתה מהטופס ארוכה מ-${MAX_INSTRUCTION_CHARS} תווים.`);

  // Without a calendar the door would not route the meeting and the text would
  // fall to the general planner: refuse here instead.
  const calendar = await calendarWiring(db, options);
  if (calendar === undefined) return refuse(CALENDAR_NOT_CONNECTED_REPLY);

  const outcome = await runInstruction(db, { text: built.text }, { textOrigin: 'typed', channel: 'dashboard', calendar, meetingRequest: built.request });
  if (outcome.status === 'refused') return refuse(outcome.reason);
  // The question is listed at the top of the GET (PRG: a refresh must not book twice).
  if (outcome.status === 'needs_confirmation') return seeOther(res, '/meetings');
  if (outcome.status === 'needs_answer') return seeOther(res, '/instruct');
  return seeOther(res, '/');
}

/**
 * The owner marks a client's answer from the mail he read. Only `accepted` /
 * `declined`, only for a meeting of this business in `active`. The audit row
 * uses the existing kind `tool_call` (AuditKind is a closed enum) with reason
 * `meeting_response_marked:<response>` — no client name, no address.
 */
export async function handleMeetingMarkPost(
  res: ServerResponse,
  db: BusinessDb,
  session: MeetingSession,
  meetingId: string,
  form: URLSearchParams,
  options: MeetingRouteOptions,
): Promise<void> {
  const businessId = db.businessId;
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());
  const response = RESPONSE_PAIR.find((r) => r === form.get('response'));
  if (response === undefined) {
    return sendMeetingsPage(res, 400, db, session, options, { error: 'התשובה שנבחרה אינה מוכרת.' });
  }
  const { charterVersion } = await charterZone(db);
  const marked = await transaction(db, async (tx) => {
    const { rows } = await tx.query<{ meeting_id: string }>(
      `UPDATE meetings SET response = $3, response_at = now(), updated_at = now()
        WHERE business_id = $1 AND meeting_id = $2 AND state = 'active'
        RETURNING meeting_id`,
      [businessId, meetingId, response],
    );
    if (rows.length === 0) return false;
    await appendAudit(
      tx,
      {
        jobId: null,
        actor: 'human',
        kind: 'tool_call',
        reason: `meeting_response_marked:${response}`,
        inputHash: canonicalHash({ event: 'meeting_response_marked', meetingId, response }),
        provenance: 'boss',
        charterVersion,
        envelopeId: null,
        onBehalfOf: null,
        actionClass: null,
        risk: null,
        outputHash: null,
        artifacts: [],
        costMinor: null,
        tokens: null,
      },
    );
    return true;
  });
  if (!marked) return html(res, 404, renderNotFound());
  seeOther(res, '/meetings');
}
