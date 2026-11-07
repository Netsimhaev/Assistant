# Calendar Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant reads the business calendar (Google or Microsoft 365, several calendars, one account), answers schedule questions in the approved WhatsApp format, books, moves, cancels and edits meetings through one boss confirmation, and tracks each client's confirmation status with reminders and decline alerts.

**Architecture:** A provider-neutral `CalendarClient` (Google + Graph) under `src/calendar/` is used two ways. **Reads** run in deterministic code: the snapshot, the free-time search, the schedule answer and the response sync. **Writes** run only through a new calendar adapter behind `runPlan` and the existing boss-command machinery (`instruction_confirmations` + `confirmedCommandCovers`, unchanged). A meeting door in `src/meetings/` builds the plan in code, from a structured request extracted from the owner's text or taken from the dashboard form. The one gate bypass is the attendee-less placeholder (`src/meetings/holds.ts`). A scheduler sweep (`src/meetings/sync.ts`) moves meeting rows through their life, reads attendee responses, and sends reminders and alerts.

**Tech Stack:** TypeScript (NodeNext, ESM, `.js` imports), zod, pg, vitest against real Postgres, `@anthropic-ai/claude-agent-sdk` (extractor only).

**Spec:** `docs/superpowers/specs/2026-11-07-calendar-scheduling-design.md`. Read it in full before Task 1; section refs below (§n, Mn) point into it.

## Global Constraints

- `src/policy/engine.ts` is not modified. No new gate exemption. Every write except holds goes `runPlan` → gate → `confirmedCommandCovers` (spec §7).
- One calendar account per business (M22). The system name is `calendar` (`CALENDAR_SYSTEM`). It is never the `mailbox` system (M10).
- Every change to a meeting is asked first, including the owner's own events with no attendee (§13 call 12).
- A move goes only into free time and never displaces a settled client unless the owner named that client in the instruction (M4).
- Busy: every event in every read calendar, except provider-marked free (`transparency: 'transparent'` / `showAs: 'free'`) and events the owner himself declined (§6.2). Holds count as busy.
- The fixed gap expands every busy interval before and after (M7). No maps, no travel time.
- Reminder wait: 24h, or 2h when the meeting starts in under 24h (M18). One reminder per meeting slot.
- Hebrew to people, English in code. Text from the calendar reaches the owner only through `stripBidiControls` + `toOneLine` (`src/util/bidi.ts`).
- Time zone: always `charter.identity.timezone`, never the process zone.
- New tables holding a client's name, email, phone or notes are wired to erasure (`erasure-plan.ts` + executor) and seeded in `erasure-invariants.test.ts`.
- Write retries: a 401 or a timeout on a write is never blindly retried (spec §12).
- Run tests on your own DB when the hook may be running (CLAUDE.md, "הרצת מבחנים במקביל ל-hook").
- After any edit to `policy/classify.ts`, `charter/capabilities.ts`, `domain/*` enums or migrations: run `/security-review` on the diff.

## Review Focus

1. **An all-day event and a meeting across midnight / a DST switch.** The owner expects an all-day busy event to block that whole local day, and 23:30–00:30 to block both days. → `free-time.test.ts` (Task 6): `blocks the whole local day for a busy all-day event` and `splits an event that crosses local midnight`. Plus `keeps local work hours across the October DST change` (Asia/Jerusalem, 2026-10-25).
2. **The same client name matches two meetings in the range.** He expects a question, not a guess. → `door.test.ts` (Task 11): `asks which meeting when two events match the client name`.
3. **The slot is taken between the question and the "yes".** He expects nothing written and a new offer. → `calendar-adapter.test.ts` (Task 3): `refuses a create or move whose interval became busy, with slot_taken`.
4. **A recurring event's single occurrence is moved.** Only that occurrence may move. → `google.test.ts` and `graph.test.ts` (Task 2): `lists recurring events as single occurrences with their own ids`, and the move test uses an occurrence id.
5. **A client-organized meeting or a read-only calendar.** He expects "can't move this, change it with the client", never a failed write. → `plan.test.ts` (Task 10): `refuses to plan a move of an event the owner does not organize` and `refuses an event in a calendar without write access`.

---

## File Structure

```
src/calendar/
  calendar.ts            CALENDAR_SYSTEM, CalendarProvider, provider names
  types.ts               CalendarEvent, EventWrite, CalendarClient, CalendarHttp, CalendarFailure
  providers/google.ts    createGoogleCalendarClient
  providers/graph.ts     createGraphCalendarClient
  client-for.ts          calendarClientFor(provider), resolveCalendarAccess(...)
src/orchestrator/adapters/calendar.ts     createCalendarAdapter (calendar.read + calendar.write)
src/charter/amend-calendar.ts             buildCalendarAmendment / describe / revert
src/dashboard/calendar-connect.ts         sign page, preflight, status
src/meetings/
  settings.ts            MeetingSettings load/save
  snapshot.ts            loadCalendarRange
  free-time.ts           busyIntervals, workWindows, findSlots  (pure)
  query.ts               parseScheduleQuery, renderSchedule      (pure)
  request.ts             MeetingRequest schema + isMeetingInstruction gate
  holds.ts               createHold / releaseHold / sweepHolds   (the one bypass)
  plan.ts                buildMeetingPlan                        (pure over a snapshot)
  store.ts               meetings rows
  door.ts                runMeetingOperation, answerScheduleQuery
  sync.ts                syncMeetings (scheduler sweep)
  reminder.ts            openClientReminder
src/sdk/meeting-extractor.ts              runMeetingExtractor
src/dashboard/meeting-routes.ts           /meetings, /meetings/settings, form, mark
src/db/migrations/061_meetings.sql
```

The existing `google-calendar.ts` adapter stays for legacy read-only connections (`office-calendar`). The new adapter serves only the `calendar` system.

---

## Part A: Foundation

### Task 1: `calendar.update` action class and schema 1.3

**Files:**
- Modify: `src/domain/action.ts` (ActionClass enum after `calendar.move`; reversibility `'reversible'`; NEVER_FULLY_AUTONOMOUS `false`; addressee `'person'`)
- Modify: `src/domain/labels.ts` (`'calendar.update': 'עריכת פגישה'`)
- Modify: `src/policy/classify.ts` (`refineActionClass` case `calendar.create`; `REFINEMENT_RULES` text)
- Modify: `src/charter/interview/rows.ts` (INTERVIEW_ROWS after `calendar.move`; `ROW_EXAMPLES`: `'למשל: העוזרת משנה מיקום או הערות של פגישה קיימת.'`; `REFINES_FROM` key `'calendar.update': 'calendar.create'`; NOT in `ALONE_ALLOWED`)
- Modify: `src/governance/typed-recipients.ts` (`TYPED_RECIPIENT_CLASSES` gains it)
- Modify: `src/domain/charter.ts` (`CURRENT_SCHEMA_VERSION = '1.3'`, docblock line: "1.3 — calendar.update")
- Modify: `src/charter/schema-version.test.ts` (frozen list)
- Modify: `src/test/fixtures.ts` (`autonomyBase['calendar.update'] = 'approve_required'`)
- Test: `src/policy/classify.test.ts`

**Interfaces:**
- Produces: `ActionClass` member `'calendar.update'`. `refineActionClass('calendar.write', input)` returns `create` for `operation` ∈ {absent, null, `'create'`}, `calendar.move` for `'move'`, `calendar.update` for `'update'`, and `calendar.cancel` for `'cancel'` and **every other value** (unknown still maps to the strictest).

- [ ] **Step 1: Failing tests** in `classify.test.ts`:

```ts
it('refines calendar.write operation update to calendar.update', () => {
  expect(refineActionClass('calendar.create', { operation: 'update' })).toBe('calendar.update');
});
it('still refines an unknown calendar operation to calendar.cancel', () => {
  expect(refineActionClass('calendar.create', { operation: 'reschedule' })).toBe('calendar.cancel');
  expect(refineActionClass('calendar.create', { operation: 'cancel' })).toBe('calendar.cancel');
});
```

Update the frozen list in `schema-version.test.ts` to include `'calendar.update'` and version `'1.3'`.

- [ ] **Step 2:** `npx vitest run src/policy/classify.test.ts src/charter/schema-version.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Add the member and fill every `Record<ActionClass, …>`. Use `npm run typecheck` to find each one; the values are fixed in Files above. Update `refineActionClass` and the `REFINEMENT_RULES` sentence for `calendar.write`: "`update` הופך אותו ל-`calendar.update`, `cancel` וכל ערך אחר ל-`calendar.cancel`".
- [ ] **Step 4:** `npm run typecheck && npx vitest run src/policy src/charter src/domain src/governance`. Expected: PASS. The `ingest-table.test.ts` invariant on `REFINEMENT_RULES` must stay green.
- [ ] **Step 5:** Re-sign the dev charter with the interview or existing script, so `npm run scheduler` still loads (note in the commit message). Run `/security-review`.
- [ ] **Step 6: Commit** `feat(policy): calendar.update action class, charter schema 1.3`.

### Task 2: Provider calendar clients

**Files:**
- Create: `src/calendar/calendar.ts`, `src/calendar/types.ts`, `src/calendar/providers/google.ts`, `src/calendar/providers/graph.ts`, `src/calendar/client-for.ts`
- Test: `src/calendar/providers/google.test.ts`, `src/calendar/providers/graph.test.ts`

**Interfaces:**
- Produces:

```ts
// calendar.ts
export const CALENDAR_SYSTEM = 'calendar';
export type CalendarProvider = 'google' | 'microsoft';

// types.ts
export type AttendeeResponse = 'accepted' | 'declined' | 'tentative' | 'needs_action';
export interface CalendarInfo { calendarId: string; name: string; primary: boolean; canWrite: boolean }
export interface CalendarEvent {
  calendarId: string; eventId: string; title: string;
  start: string; end: string;          // ISO instants; all-day events: local-midnight instants in the charter zone
  allDay: boolean; location: string | null; description: string | null;
  organizerIsSelf: boolean; busy: boolean; selfDeclined: boolean;
  attendees: { email: string; response: AttendeeResponse }[];
}
export interface EventWrite {
  title: string; start: string; end: string;
  location: string | null; description: string | null; attendees: string[];
}
export type CalendarFailure = { failure: 'auth' | 'transient' | 'rejected' | 'not_found'; status: number; message: string };
export interface CalendarHttp { request(i: { method: 'GET'|'POST'|'PATCH'|'DELETE'; url: string; accessToken: string; body?: unknown; headers?: Record<string,string>; signal: AbortSignal }): Promise<{ status: number; body: unknown }> }
export interface CalendarClient {
  listCalendars(token: string, signal: AbortSignal): Promise<CalendarInfo[] | CalendarFailure>;
  listEvents(token: string, q: { calendarId: string; fromIso: string; toIso: string; timeZone: string; maxEvents: number }, signal: AbortSignal): Promise<{ events: CalendarEvent[]; truncated: boolean } | CalendarFailure>;
  getEvent(token: string, calendarId: string, eventId: string, timeZone: string, signal: AbortSignal): Promise<CalendarEvent | CalendarFailure>;
  createEvent(token: string, calendarId: string, write: EventWrite, idempotencyKey: string, signal: AbortSignal): Promise<{ eventId: string } | CalendarFailure>;
  updateEvent(token: string, calendarId: string, eventId: string, patch: Partial<EventWrite>, signal: AbortSignal): Promise<{ eventId: string } | CalendarFailure>;
  deleteEvent(token: string, calendarId: string, eventId: string, signal: AbortSignal): Promise<{ eventId: string } | CalendarFailure>;
}
export function isCalendarFailure(v: unknown): v is CalendarFailure;

// client-for.ts
export function calendarClientFor(provider: CalendarProvider, http?: CalendarHttp): CalendarClient;
export interface CalendarAccess { client: CalendarClient; token: string; provider: CalendarProvider }
export async function resolveCalendarAccess(o: { businessId: string; runtime: Pick<Runtime, 'credentials'>; client?: CalendarClient }): Promise<CalendarAccess | { unavailable: 'not_connected' | 'needs_reauth' | 'credential_error' }>;
```

Provider rules:
- **Google:** `singleEvents=true`, `orderBy=startTime`, follow `nextPageToken` until `maxEvents`, then set `truncated`. `busy = transparency !== 'transparent'`. `selfDeclined` = an attendee with `self: true` and `responseStatus: 'declined'`. Create sets `id` = `'a' + base32hex(sha256(idempotencyKey))` lowercased and cut to 40 chars. A 409 on that id counts as success (`{eventId}`): replay. All writes send `?sendUpdates=all`.
- **Graph:** `/me/calendars`, then `/me/calendars/{id}/calendarView?startDateTime&endDateTime` with `Prefer: outlook.timezone="<tz>"`, following `@odata.nextLink`. `busy = showAs !== 'free'`. Create sets `transactionId` = the first 36 hex chars of `sha256(idempotencyKey)`.
- Status mapping in both: 401/403 → `auth`, 404/410 → `not_found`, 429/5xx/network → `transient`, other 4xx → `rejected`.
- `resolveCalendarAccess` reads the `CALENDAR_SYSTEM` binding (`loadBindings`), the grant status (`listGrants`), and `runtime.credentials.resolve(binding.credentialRef, businessId)`. The same order as `pollMailbox` steps 1–2.

- [ ] **Step 1: Failing tests**, one recording `CalendarHttp` per provider:
  - `lists recurring events as single occurrences with their own ids` (google: request carries `singleEvents=true`; two items returned → two events with distinct `eventId`)
  - `follows pagination until maxEvents and marks truncated` (3 pages, `maxEvents: 5` → 5 events, `truncated: true`)
  - `marks transparent / showAs free events as not busy` and `marks events the owner declined as selfDeclined`
  - `maps all-day events to local-midnight instants in the given zone` (`date: '2026-11-12'`, zone `Asia/Jerusalem` → `start: '2026-11-11T22:00:00.000Z'`, `allDay: true`)
  - `derives a deterministic event id from the idempotency key and treats 409 as replay` (google), `sends the idempotency key as transactionId` (graph)
  - `maps 401 to auth, 404 to not_found, 503 to transient, 400 to rejected`
- [ ] **Step 2:** Run. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement both clients and `client-for.ts`. Default `CalendarHttp` is `fetch` with `signal`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(calendar): Google and Microsoft calendar clients`.

### Task 3: Calendar adapter (read + write)

**Files:**
- Create: `src/orchestrator/adapters/calendar.ts`
- Test: `src/orchestrator/adapters/calendar-adapter.test.ts`

**Interfaces:**
- Consumes: `CalendarClient` (Task 2).
- Produces:

```ts
export const CALENDAR_SERVED_TOOLS = ['calendar.read', 'calendar.write'] as const;
export const CalendarWriteInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), calendarId: z.string().min(1), holdEventId: z.string().min(1).nullable(),
             title: z.string().min(1), start: IsoInstant, end: IsoInstant, location: z.string().nullable(),
             description: z.string().nullable(), attendees: z.array(z.string().email()) }).strict(),
  z.object({ operation: z.literal('move'), calendarId, eventId, start, end }).strict(),
  z.object({ operation: z.literal('update'), calendarId, eventId,
             location: z.string().nullable().optional(), description: z.string().nullable().optional(),
             attendees: z.array(z.string().email()).optional() }).strict(),
  z.object({ operation: z.literal('cancel'), calendarId, eventId }).strict(),
]);
export function createCalendarAdapter(o: { system: string; provider: CalendarProvider; timeZone: () => Promise<string>; client?: CalendarClient }): ExternalAdapter;
```

Behaviour:
- Keep the skeleton of `google-calendar.ts`: serves check, abort check, credential null, `safeParse` → `invalid_input`.
- `calendar.read` input: `{ calendarId, fromIso, toIso }` → `{ events }` (narrowed `CalendarEvent[]`).
- **Pre-write re-check** (§6.3) for `create` and `move`: list events in `[start, end)` across that calendar. Any busy event other than the one being moved or converted (`eventId` / `holdEventId`) → `{ ok:false, retryable:false, code:'slot_taken', message:'המועד נתפס בינתיים — לא נכתב דבר' }`.
- `create` with `holdEventId` → `updateEvent(holdEventId, {title, location, description, attendees, start, end})`. Without it → `createEvent(…, call.idempotencyKey)`.
- Failure mapping: `auth` → `retryable:false, code:'calendar_auth'` (**never** retryable on writes; on `calendar.read` retryable as today). `transient` → `retryable:true`, but on a write only if the provider answered (status ≥ 500/429). A throw from `http` on a write → `retryable:false, code:'delivery_unknown'`. `not_found` → `event_not_found`. `rejected` → `calendar_rejected`.
- `externalId` = the event id.

- [ ] **Step 1: Failing tests:** `refuses a create or move whose interval became busy, with slot_taken`; `converts a hold by id instead of creating a second event`; `creates with the call idempotency key when there is no hold`; `does not mark a 401 on a write retryable`; `marks a thrown write delivery_unknown and not retryable`; `ignores the moved event itself in the re-check`; `refuses a payload with an unknown field` (strict).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Add `'slot_taken'`, `'calendar_auth'`, `'event_not_found'` and `'calendar_rejected'` to `FAILURE_REASON_HE` (WhatsApp report map) with Hebrew sentences. The test that the map covers known codes must pass.
- [ ] **Step 6: Commit** `feat(calendar): read/write calendar adapter with pre-write re-check`.

### Task 4: Charter amendment, OAuth profiles, runtime wiring

**Files:**
- Create: `src/charter/amend-calendar.ts`, test `src/charter/amend-calendar.test.ts`
- Modify: `src/dashboard/oauth-profiles.ts`, `src/dashboard/oauth-routes.ts` (accept `CALENDAR_SYSTEM` with the provider signed in the charter, like the mailbox branch), `src/orchestrator/oauth-eligibility.ts`, `src/orchestrator/runtime.ts`
- Test: `src/dashboard/oauth-profiles.test.ts`, `src/orchestrator/runtime.test.ts`

**Interfaces:**
- Produces:

```ts
export const CALENDAR_SUBPROCESSOR: Readonly<Record<CalendarProvider, string>>; // same strings as MAILBOX_SUBPROCESSOR
export const CALENDAR_CONNECTION_LABEL = 'יומן העסק';
export function calendarConnection(p: CalendarProvider): CharterConnection; // system 'calendar', channel 'api', serves ['calendar.read','calendar.write']
export function describeCalendarAmendment(active, p): { dropped: string[]; narrowed: string[]; subprocessorAdded: boolean };
export function buildCalendarAmendment(active, now: Date, p): UnsignedCharter; // version `${v}.cal-${ulid()}`
export function buildCalendarRevert(active, now: Date, previous: BusinessCharter): UnsignedCharter;
export function signedCalendarProvider(c: CharterConnection): CalendarProvider | null;
export class CalendarAlreadyDeclaredError extends Error {}
```

- The amendment removes `calendar.read`/`calendar.write`/`calendar.propose_slots` from every other connection, drops a connection left serving nothing (`office-calendar`), adds the calendar connection, and adds the subprocessor. Every other field is copied byte for byte (test: deep-equal of everything except `connections`, `data.subprocessorsAllowed`, version fields).
- Profiles: Google `['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly']`. Microsoft `['offline_access','User.Read','Calendars.ReadWrite']`, `revokeUrl: null`. `oauthProfileFor` gets a branch checked **before** the legacy `calendar.read` branch: `connection.system === CALENDAR_SYSTEM && serves.includes('calendar.write')`.
- Runtime: for the binding whose system is `CALENDAR_SYSTEM` and whose provider is set, register `createCalendarAdapter({system, provider, timeZone})`. The legacy loop skips `CALENDAR_SYSTEM`. Overrides seam: `calendarClient?: (p) => CalendarClient`.

- [ ] **Step 1: Failing tests:** `drops office-calendar and adds one calendar connection serving read and write`; `copies every other charter field unchanged`; `refuses a second calendar connection`; `revert restores the replaced connections`; `picks the read-write calendar profile per provider`; `still gives the legacy read-only profile to office-calendar`; `registers the calendar adapter for the calendar binding only`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `src/charter/capabilities.test.ts` (no dead `serves`: `sched.meetings` already owns both tools). Expected: PASS.
- [ ] **Step 5: Commit** `feat(calendar): calendar connection amendment, OAuth profiles, runtime`.

### Task 5: Calendar connect screen, migration, meeting settings

**Files:**
- Create: `src/db/migrations/061_meetings.sql`, `src/dashboard/calendar-connect.ts`, `src/meetings/settings.ts`, `src/dashboard/meeting-routes.ts` (settings routes only in this task)
- Modify: `src/dashboard/server.ts` (routes), `src/dashboard/views.ts` (connections screen link), `docs/10-user-settings.md`, `docs/חיבור יומן -לקוח.md` (rewrite for the end client: what she can now do, what never; no technical terms, commands or paths)
- Test: `src/meetings/settings.test.ts`, `src/dashboard/calendar-connect.test.ts`, `src/dashboard/meeting-routes.test.ts`

**Migration 061** (one file, three tables):

```sql
CREATE TABLE meeting_settings (
  business_id text PRIMARY KEY,
  location_kind text NOT NULL CHECK (location_kind IN ('travel','fixed','mixed')),
  fixed_address text,
  gap_minutes int NOT NULL DEFAULT 30 CHECK (gap_minutes BETWEEN 0 AND 240),
  default_duration_minutes int NOT NULL DEFAULT 60 CHECK (default_duration_minutes BETWEEN 5 AND 600),
  work_start time, work_end time,              -- NULL: charter businessHours, else 09:00-18:00
  read_calendar_ids text[] NOT NULL DEFAULT '{}', -- '{}' = all calendars in the account
  write_calendar_id text,                       -- NULL = the primary calendar
  reminder_hours int NOT NULL DEFAULT 24, reminder_hours_soon int NOT NULL DEFAULT 2,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (location_kind <> 'fixed' OR fixed_address IS NOT NULL),
  CHECK ((work_start IS NULL) = (work_end IS NULL) AND (work_start IS NULL OR work_start < work_end)));
CREATE TABLE meetings (
  meeting_id text PRIMARY KEY, business_id text NOT NULL, job_id text NOT NULL, step_id text NOT NULL,
  calendar_id text NOT NULL, event_id text,           -- NULL until the step completes (create without hold)
  operation text NOT NULL CHECK (operation IN ('create','move','update','cancel')),
  client_name text NOT NULL, client_email text, client_email_verified boolean NOT NULL DEFAULT false,
  client_phone text, internal_note text, start_at timestamptz, end_at timestamptz,
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','active','abandoned','done')),
  response text NOT NULL DEFAULT 'needs_action' CHECK (response IN ('needs_action','accepted','declined','tentative','not_updated')),
  response_at timestamptz, reminder_claimed_at timestamptz, reminder_job_id text,
  declined_notified_at timestamptz, unanswered_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, job_id, step_id));
CREATE TABLE meeting_holds (
  hold_id text PRIMARY KEY, business_id text NOT NULL, job_id text NOT NULL,
  calendar_id text NOT NULL, event_id text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held','converted','released')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (business_id, event_id));
```

**Interfaces:**
- Produces:

```ts
export interface MeetingSettings { locationKind: 'travel'|'fixed'|'mixed'|null; fixedAddress: string|null; gapMinutes: number; defaultDurationMinutes: number; workStart: string|null; workEnd: string|null; readCalendarIds: string[]; writeCalendarId: string|null; reminderHours: number; reminderHoursSoon: number }
export const MEETING_DEFAULTS: Readonly<MeetingSettings>; // locationKind null until set (§10 "חובה בהקמה")
export async function loadMeetingSettings(o: { businessId: string; db?: Queryable }): Promise<MeetingSettings>;
export async function saveMeetingSettings(s: MeetingSettings, o: { businessId: string }): Promise<{ ok: true } | { ok: false; reason: string }>; // Hebrew reasons, before touching the DB
```

- Calendar connect: `GET/POST /calendar/sign?provider=` mirrors `mailbox-connect.ts`. Copy the preflight (master key + `GOOGLE_OAUTH_CLIENT_*` / `MICROSOFT_OAUTH_CLIENT_*`), the revert button shown only while the grant is not live, and `RESTART_NOTE`. `CALENDAR_AUTHORISATION_TEXT`, verbatim on the sign page: "העוזרת תקרא את כל היומנים שתבחר, כדי לדעת מתי אתה פנוי ותפוס ולענות לך על הלו"ז. היא תקבע, תזיז, תערוך ותבטל פגישות — תמיד אחרי שתאשר. לפני שאתה מאשר היא רק שומרת לך מקום ביומן, בלי להזמין אף אחד. היא לעולם לא מוחקת אירוע שלא היא יצרה בלי לשאול אותך, ולעולם לא כותבת ליומן שלא בחרת כיומן הפגישות."
- `/meetings/settings`: lists calendars via `resolveCalendarAccess` + `listCalendars` (checkboxes = read set, radio = write calendar, write radio disabled where `canWrite` false). When unavailable it shows "היומן לא מחובר" and still saves the other fields. CSRF + session like `ledger-routes.ts`.

- [ ] **Step 1: Failing tests:** `refuses fixed location without an address, in Hebrew`; `refuses work_end before work_start`; `refuses a write calendar not in the read set`; `loads defaults for a business without a row`; `sign page shows the authorisation text and refuses without preflight`; `settings page disables write for a read-only calendar`.
- [ ] **Step 2:** `TEST_DATABASE_URL=… npm run migrate:test`, then run. Expected: FAIL.
- [ ] **Step 3:** Implement. Document every setting in `docs/10-user-settings.md` with its default and the line "אף הגדרה כאן אינה מרחיבה סמכות".
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(meetings): calendar connect screen, meeting settings, migration 061`.

---

## Part B: Reading

### Task 6: Snapshot and free time

**Files:**
- Create: `src/meetings/snapshot.ts`, `src/meetings/free-time.ts`
- Test: `src/meetings/free-time.test.ts`, `src/meetings/snapshot.test.ts`

**Interfaces:**
- Produces:

```ts
// snapshot.ts
export const SNAPSHOT_MAX_EVENTS = 500;
export interface CalendarSnapshot { fromIso: string; toIso: string; events: CalendarEvent[]; calendars: CalendarInfo[]; truncated: boolean; holds: { start: string; end: string; eventId: string }[] }
export async function loadCalendarRange(o: { access: CalendarAccess; businessId: string; settings: MeetingSettings; timeZone: string; fromIso: string; toIso: string; signal: AbortSignal }): Promise<CalendarSnapshot | CalendarFailure>;
// free-time.ts (pure)
export interface Interval { start: number; end: number } // epoch ms
export function busyIntervals(s: CalendarSnapshot, gapMinutes: number, ignoreEventIds?: ReadonlySet<string>): Interval[];
export function workWindows(o: { fromDate: string; toDate: string; timeZone: string; operations: CharterOperations; workStart: string|null; workEnd: string|null; fromTime?: string|null; toTime?: string|null }): Interval[];
export function freeIntervals(work: Interval[], busy: Interval[]): Interval[];
export function findSlots(free: Interval[], durationMinutes: number, limit: number, notBefore: number): Interval[];
```

Rules: read set `[]` means every calendar. Holds from `meeting_holds` (state `held`) are merged as busy events, and their calendar events are not double-counted. Work windows: charter `workweek` days minus `holidays`. Hours come from `workStart/workEnd`, else charter `businessHours` for that weekday, else 09:00–18:00. The gap pads each busy interval on both sides. Slots start at the window start or at the end of a padded busy interval, rounded up to 15 minutes. Results are sorted earliest first, never before `notBefore`.

- [ ] **Step 1: Failing tests** (pure, no DB): `blocks the whole local day for a busy all-day event`; `does not block for an all-day event marked free`; `splits an event that crosses local midnight`; `pads every busy interval by the gap on both sides`; `keeps local work hours across the October DST change`; `skips charter holidays and non-workweek days`; `returns the earliest slot first and rounds to 15 minutes`; `ignores the event being moved`; `counts held placeholders as busy` (snapshot test with a `meeting_holds` row).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement with `localToInstant`/`localParts` from `src/util/local-time.ts`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(meetings): calendar snapshot and free-time search`.

### Task 7: Schedule answer (WhatsApp format A + "פנוי")

**Files:**
- Create: `src/meetings/query.ts`, `src/meetings/door.ts` (`answerScheduleQuery` only in this task)
- Modify: `src/orchestrator/instruct.ts` (new outcome + early route), `src/orchestrator/whatsapp-door.ts` (`composeAck`, job-less outcome), `src/dashboard/server.ts` (render), `src/whatsapp/store.ts` (status union)
- Test: `src/meetings/query.test.ts`, `src/orchestrator/instruct-schedule.test.ts`

**Interfaces:**
- Produces:

```ts
export type QueryRange = { fromDate: string; toDate: string }; // local YYYY-MM-DD, inclusive
export function parseScheduleQuery(text: string, now: Date, timeZone: string): QueryRange | 'unrecognized_range' | null; // null = not a schedule question
export function renderSchedule(o: { range: QueryRange; snapshot: CalendarSnapshot; responses: ReadonlyMap<string, MeetingResponse>; free: ReadonlyMap<string, Interval[]>; timeZone: string; maxChars: number }): string;
export async function answerScheduleQuery(o: { text: string; businessId: string; timeZone: string; operations: CharterOperations; runtime: Pick<Runtime,'credentials'>; now?: Date; client?: CalendarClient }): Promise<{ answered: string } | null>;
// instruct.ts InstructionOutcome gains:
| { status: 'answered'; text: string }   // no job, no instruction row
```

- Detection: the text starts with or contains `מה יש לי`, `מה הלו"ז`/`לוז`, or `מה ביומן`, plus a range word. Ranges: `היום`, `מחר`, `מחרתיים`, `השבוע` (today → Saturday), `שבוע הבא` (next Sunday → Saturday), a weekday name with or without `ב`/`ביום` (the next occurrence, today included), `DD/MM`. Detected question without a recognized range → `'unrecognized_range'` → `answered: 'לאיזה טווח? למשל "מחר", "השבוע" או "יום שלישי".'`
- `runInstruction`: after the charter load, **before** `createJob`, call `answerScheduleQuery`. A non-null result → `{status:'answered', text}`. A calendar that is not connected → `answered: 'היומן לא מחובר — אפשר לחבר אותו במסך החיבורים.'`
- Rendering, exactly the approved layout: per day `*יום ה' 12/11 — 3 פגישות*` (or `— אין פגישות`), blank line, then per event `*HH:MM–HH:MM · <title>*` + `  ✅ אישר` / `  ⏳ ממתין לתשובה` / `  ❌ דחה` / `  ⚠️ לא עודכן` (only for events with a `meetings` row or external attendees), then `📍 <location or —>`, then `📝 <description first line or —>`, blank line, and last `פנוי: 12:30–15:00, אחרי 16:00` (work-window free intervals; `אחרי HH:MM` when free runs to the window end; `פנוי: —` when none). All-day: `*כל היום · <title>*`. Each text field goes through `toOneLine(stripBidiControls(x))`. Over `maxChars` (4,000): cut at a day boundary and append `המשך בדשבורד.` A truncated snapshot appends `⚠️ ביומן יותר אירועים ממה שנקרא — ייתכן שחסרים.`

- [ ] **Step 1: Failing tests** in `query.test.ts`: `parses מחר, השבוע, שבוע הבא, ביום שלישי and 12/11 in Asia/Jerusalem`; `returns null for a non-schedule instruction`; `returns unrecognized_range for "מה יש לי בקרוב"`; `renders format A with the פנוי line` (golden string, the spec §7.1 example); `renders אחרי HH:MM when free runs to close`; `cuts at a day boundary over the limit`; `strips bidi controls from titles and locations`. In `instruct-schedule.test.ts`: `answers a schedule question without creating a job or instruction row` (count `jobs` and `boss_instructions` before and after, injected client).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. WhatsApp door: `composeAck` returns `outcome.text` for `answered`, and the jobId is `null` for it as for `refused`.
- [ ] **Step 4:** Run the whole suite slice `src/orchestrator src/meetings src/dashboard`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(meetings): schedule answers in WhatsApp format A`.

---

## Part C: Writing

### Task 8: Meeting request and extractor

**Files:**
- Create: `src/meetings/request.ts`, `src/sdk/meeting-extractor.ts`, `src/sdk/run-meeting-extract.ts` (live script, `npm run sdk:meeting-extract -- "<text>"`, writes nothing)
- Modify: `package.json` (script)
- Test: `src/meetings/request.test.ts`, `src/sdk/meeting-extractor.test.ts`

**Interfaces:**
- Produces:

```ts
const Client = z.object({ name: z.string().min(1).max(120), email: z.string().email().nullable(), phone: z.string().max(40).nullable() }).strict();
const Window = z.object({ fromDate: IsoDate, toDate: IsoDate, fromTime: TimeOfDay.nullable(), toTime: TimeOfDay.nullable() }).strict();
export const MeetingOp = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), client: Client, location: z.string().max(300).nullable(), clientNotes: z.string().max(1000).nullable(), internalNote: z.string().max(1000).nullable(), window: Window, durationMinutes: z.number().int().min(5).max(600).nullable() }).strict(),
  z.object({ kind: z.literal('move'), clientName: z.string().min(1), onDate: IsoDate.nullable(), window: Window }).strict(),
  z.object({ kind: z.literal('cancel'), clientName: z.string().min(1), onDate: IsoDate.nullable() }).strict(),
  z.object({ kind: z.literal('edit'), clientName: z.string().min(1), onDate: IsoDate.nullable(), location: z.string().max(300).nullable().optional(), clientNotes: z.string().max(1000).nullable().optional() }).strict(),
]);
export const MeetingRequest = z.object({ ops: z.array(MeetingOp).min(1).max(8) }).strict();
export function isMeetingInstruction(text: string): boolean; // positive word list
export function verifyTypedEmails(req: MeetingRequest, instructionText: string): MeetingRequest; // email kept only if appearsVerbatimIn(text)
export type MeetingExtractor = (i: { text: string; today: string; timeZone: string; signal: AbortSignal }) => Promise<{ status: 'extracted'; request: MeetingRequest } | { status: 'not_meeting' } | { status: 'failed'; reason: string }>;
export const runMeetingExtractor: MeetingExtractor;
```

- `isMeetingInstruction`: the text contains one of `תקבעי`, `קבעי`, `לקבוע`, `תזיזי`, `להזיז`, `תבטלי`, `לבטל`, `תעדכני`, `תשני`, together with `פגישה` or a time/date word. Anything else → the general planner as today.
- Extractor: Sonnet, `tools: []`, `env: { PATH }`, one turn, `refuseUnderTest` (copy the guard from `planner.ts`). The owner text is the trusted channel and is **not** fenced (as in `doc-drafter.ts`). Output is parsed by `extractJsonObjects` (`src/util/json-extract.ts`) + `MeetingRequest.safeParse`. A parse failure → `failed`.

- [ ] **Step 1: Failing tests:** `accepts create, move, cancel and edit ops and rejects an unknown field`; `drops an email that does not appear verbatim in the instruction`; `isMeetingInstruction is true for "תקבעי פגישה עם דני מחר" and false for "תשלחי לדני מייל"`; `refuses to run under NODE_ENV=test`; `parses a fenced JSON reply into a MeetingRequest` (extracted pure parser `parseExtractorReply`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(meetings): meeting request schema and extractor`.

### Task 9: Holds (the one bypass)

**Files:**
- Create: `src/meetings/holds.ts`
- Test: `src/meetings/holds.test.ts`, `src/meetings/holds-invariants.test.ts`

**Interfaces:**
- Produces:

```ts
export const HOLD_TITLE_PREFIX = '⏳ ממתין לאישור — ';
export async function createHold(o: { access: CalendarAccess; businessId: string; jobId: string; calendarId: string; start: string; end: string; clientName: string; signal: AbortSignal }): Promise<{ holdId: string; eventId: string } | CalendarFailure>;
export async function releaseHold(o: { access: CalendarAccess; businessId: string; holdId: string; signal: AbortSignal }): Promise<'released' | 'already' | CalendarFailure>;
export async function markHoldConverted(o: { businessId: string; eventId: string; db?: Queryable }): Promise<void>;
export async function sweepHolds(o: { businessId: string; runtime: Pick<Runtime,'credentials'>; client?: CalendarClient }): Promise<{ released: number; failed: number }>;
```

- `createHold` calls `client.createEvent` with `attendees: []`, `location: null`, `description: 'שמירת מקום של העוזרת — ממתינה לאישור שלך.'` and idempotency key `hold:<jobId>`. It inserts the `meeting_holds` row and appends `audit_log` (`kind 'calendar_hold'`, `inputHash` over `{calendarId, start, end}`, no name).
- `releaseHold` deletes only an event id found in `meeting_holds` with state `held`, then marks it `released` and audits.
- `sweepHolds` releases holds whose job is `closed`/`failed`, or whose job has no pending/confirmed `instruction_confirmations` row and is not in `execute`/`verify`/`remember`. It also releases holds older than `WHATSAPP_QUESTION_WINDOW_MINUTES + 15`.
- **Invariant test** (reads `holds.ts` as text): the file contains no `attendees:` other than `attendees: []`, and calls only `createEvent` and `deleteEvent` on the client. A grep check confirms no other production file imports `createHold`/`releaseHold` except `src/meetings/door.ts` and `src/meetings/sync.ts`.

- [ ] **Step 1: Failing tests:** `creates an attendee-less hold and records it without the client name in audit`; `release deletes only a hold it created`; `refuses to release an event id with no held row`; `sweep releases holds of closed jobs and expired questions but not of executing jobs`; the two invariant tests.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Add the holds bypass to the list of documented gate bypasses in CLAUDE.md (one paragraph: why it is safe, M23). Run `/security-review`.
- [ ] **Step 6: Commit** `feat(meetings): attendee-less holds as a documented gate bypass`.

### Task 10: Meeting plan builder and question summary

**Files:**
- Create: `src/meetings/plan.ts`, `src/meetings/store.ts`
- Modify: `src/orchestrator/command-echo.ts` (Hebrew labels for calendar fields)
- Test: `src/meetings/plan.test.ts`, `src/meetings/store.test.ts`, `src/orchestrator/command-echo.test.ts`

**Interfaces:**
- Consumes: `MeetingRequest` (Task 8), `CalendarSnapshot`/`findSlots` (Task 6), `CalendarWriteInput` (Task 3).
- Produces:

```ts
export interface ResolvedClient { name: string; email: string | null; emailVerified: boolean; phone: string | null }
export type PlannedChange =
  | { op: 'create'; client: ResolvedClient; calendarId: string; start: string; end: string; location: string|null; clientNotes: string|null; internalNote: string|null; needsHold: true }
  | { op: 'move'|'update'|'cancel'; event: CalendarEvent; client: ResolvedClient; start?: string; end?: string; location?: string|null; clientNotes?: string|null };
export type MeetingPlanResult =
  | { kind: 'plan'; plan: Plan; changes: PlannedChange[]; summary: string }
  | { kind: 'no_slot'; opIndex: number; dayListing: string; alternatives: Interval[] }
  | { kind: 'ambiguous'; clientName: string; candidates: CalendarEvent[] }
  | { kind: 'not_found'; clientName: string }
  | { kind: 'refused'; reason: string };   // Hebrew: organizer / read-only / conflict
export function buildMeetingPlan(o: { request: MeetingRequest; snapshot: CalendarSnapshot; settings: MeetingSettings; operations: CharterOperations; timeZone: string; now: Date; resolveClient: (name: string) => ResolvedClient; holdEventIds: ReadonlyMap<number, string> }): MeetingPlanResult;
export function renderMeetingSummary(changes: PlannedChange[], timeZone: string): string;
// store.ts
export async function recordProposedMeetings(o: { businessId: string; jobId: string; plan: Plan; changes: PlannedChange[]; db?: Queryable }): Promise<void>;
```

Rules:
- One `PlanStep` per change: `agent: 'sched.meetings'`, `toolName: 'calendar.write'`, ids `m1…mn`, `expectedActionClass` from `refineActionClass` (`create`→`calendar.create`, `move`, `update`, `cancel`), and an input exactly matching `CalendarWriteInput`. Create: `holdEventId` from `holdEventIds`, `title = client.name`, `description` = client notes + `\nטלפון: <phone>` when a phone exists, `attendees` = `[email]` when one exists, else `[]`. **The internal note is never in any step input** (test).
- Event match for move/cancel/edit: events in the snapshot whose title contains the client name, or whose attendee email equals the resolved email (case-insensitive), on `onDate` when given. Zero → `not_found`, two or more → `ambiguous`.
- Refusals: `!event.organizerIsSelf && attendees.length>0` → `'את הפגישה הזו קבע <name> — את המועד צריך לשנות מולו.'`. The event's calendar is not `canWrite` → `'היומן הזה לקריאה בלבד — אי אפשר לשנות בו פגישות.'`.
- Final-schedule check (§7.5): apply all changes to the snapshot in memory. Any two busy intervals overlapping after gap padding → `refused` naming both titles. Displacing a settled client happens only by an explicit `move` op in the same request.
- Order: cancels, then moves and updates that vacate earlier, then creates. Set `dependsOn` so a step that fills a vacated interval depends on the step that vacates it.
- `no_slot`: no `findSlots` result inside the window → the day listing (Task 7 renderer, that window's days) plus up to 3 alternatives after the window (§7.3).
- `renderMeetingSummary`: one block per change, e.g. `קביעה: דני כהן — יום ג' 17/11, 10:00–11:00, הרצל 5 רמת גן`, `הזזה: רונית לוי — מיום ה' 12/11 11:30 ליום א' 15/11 09:00`, `עריכה: … מיקום: לפני "X" → אחרי "Y"`. Then per client either `תצא הזמנה/עדכון אל dani@x.co` (with `(מהזיכרון — לא אומת)` when `!emailVerified`), or `⚠️ ל<name> אין כתובת מייל — הוא לא יקבל עדכון. תצטרך לעדכן אותו בעצמך.`
- `command-echo.ts`: add labels `operation`→"פעולה", `calendarId`→"יומן", `eventId`→"אירוע", `holdEventId`→"שמירת מקום", `title`→"כותרת", `start`→"התחלה", `end`→"סיום", `location`→"מיקום", `description`→"פרטים ללקוח", `attendees`→"משתתפים". The values are still shown whole.

- [ ] **Step 1: Failing tests:** `builds one calendar.write create step with the hold id and the client as attendee`; `never puts the internal note in a step input`; `marks an email from memory unverified in the summary`; `asks which meeting when two events match` → `ambiguous`; `refuses to plan a move of an event the owner does not organize`; `refuses an event in a calendar without write access`; `refuses a reshuffle whose final schedule overlaps, naming both`; `orders a vacate-then-fill reshuffle with dependsOn`; `returns no_slot with three alternatives after the window`; `every step input parses with CalendarWriteInput and refines to its expectedActionClass`; `records proposed meeting rows keyed by job and step` (store, DB); `labels calendar fields in the step echo`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(meetings): deterministic meeting plan builder and summary`.

### Task 11: Meeting door wired into the instruction door

**Files:**
- Modify: `src/meetings/door.ts` (`runMeetingOperation`), `src/orchestrator/instruct.ts` (branch after `understand`, before contact resolution; export `DoorContext` type and `finishSingle` as `finishSinglePlan`)
- Test: `src/meetings/door.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 8, 9, 10; `finishSingle(door, { plan, label, contactSource, identityNote })`.
- Produces:

```ts
export async function runMeetingOperation(door: DoorContext, o: { request?: MeetingRequest; extractor?: MeetingExtractor; runtime: Pick<Runtime,'credentials'>; client?: CalendarClient; now?: Date }): Promise<InstructionOutcome | null>; // null = not a meeting instruction → general planner continues
```

Flow:
1. `request` given (dashboard form) or `isMeetingInstruction(text)` → extract. `not_meeting` → `null`. `failed` → fail the job, `refused: 'לא הצלחתי להבין את בקשת הפגישה — אפשר לנסח שוב או להשתמש בטופס במסך הפגישות.'`
2. `resolveCalendarAccess`. Unavailable → fail the job, refused with the not-connected sentence. `settings.locationKind === null` → refused: `'צריך קודם להגדיר את הגדרות הפגישות.'`
3. Snapshot covering every op window, each `onDate`, and the next 14 days when a window is open-ended.
4. `buildMeetingPlan` with `holdEventIds` empty (dry run). On `no_slot` / `ambiguous` / `not_found` → `recordQuestion` + return `needs_answer` with the Hebrew question: `no_slot` = `'<day listing>\n\nהחלון מלא. אפשר: להזיז מישהו ("תזיזי את X"), לבקש מועדים אחרים — הפנויים הקרובים: <3 alternatives> — או לתת מועד אחר.'`; `ambiguous` = a numbered list of candidates with day/time/location; `not_found` = `'לא מצאתי פגישה עם <name> בטווח.'`. On `refused` → fail the job and return `refused`.
5. For each create change: `createHold`. A failure releases the holds already made, fails the job, and refuses. Then rebuild with the real `holdEventIds`.
6. `recordProposedMeetings`, then `finishSingle(door, { plan, label: summary first line, contactSource: …, identityNote: null })`. The plan has classified steps, so it parks on one confirmation. Prepend `renderMeetingSummary` to the question text by passing it as the extra echo (`renderConfirmationQuestion`'s `ledgerEchoes` slot becomes `extraEchoes: (string|null)[]` — rename in both callers).
7. **"תני אחר"**: the text matches `/^(תני|תציעי)\s+(מועד\s+)?אחר/`, and this channel holds a pending meeting confirmation from the last window → `cancelConfirmation` on it, `releaseHold`, then re-run the stored request with the previous slot added as busy. Keep the previous instruction text, passing `excludeIntervals` into `buildMeetingPlan` (add an optional `exclude: Interval[]` there).

- [ ] **Step 1: Failing tests** (injected extractor + recording calendar client, real DB): `books a new meeting: hold created, one confirmation, plan bound`; `on yes the job runs and the hold is converted, not duplicated` (drive `applyConfirmation` + `runDueJobs` with a recording adapter; assert one `updateEvent` on the hold id and zero `createEvent` beyond the hold); `on no the hold is released by the sweep`; `asks which meeting when two events match the client name`; `answers no_slot with the day listing and alternatives`; `refuses when the calendar is not connected, without creating a hold`; `תני אחר releases the hold and offers the next slot`; `returns null for a non-meeting instruction so the general planner runs`; `a confirmed meeting runs under confirmedCommandCovers with the dial off` (intent row ends with `confirmed_command_exemption`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/meetings src/orchestrator`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(meetings): meeting door with holds and one boss confirmation`.

### Task 12: Meetings screen

**Files:**
- Modify: `src/dashboard/meeting-routes.ts`, `src/dashboard/server.ts`, `src/dashboard/views.ts` (nav link "פגישות")
- Test: `src/dashboard/meeting-routes.test.ts`

**Interfaces:**
- Consumes: `runInstruction` with `request` passthrough. Add `meetingRequest?: MeetingRequest` to `RunInstructionOptions`, forwarded to `runMeetingOperation` (the extractor is skipped).
- Produces routes: `GET /meetings`, `POST /meetings/new`, `POST /meetings/:meetingId/mark` (`response=accepted|declined`).

- `POST /meetings/new` builds `MeetingRequest` from the fields (name, email, phone, location, client notes, internal note, from/to date, from/to time, duration). It synthesizes the instruction text deterministically, e.g. `קביעת פגישה: <name>, <email>, <phone>, <location>, <window>` (so `appearsVerbatimIn` holds for the typed email), and calls `runInstruction(text, { textOrigin: 'typed', channel: 'dashboard', meetingRequest })`. It renders the outcome like `/instruct`.
- `GET /meetings`: pending meeting confirmations first (reuse the `/instruct` confirmation card renderer). Then tomorrow: time, client, location and response icon, from `loadCalendarRange` + `meetings` rows. Then, for each `meetings` row in `needs_action` with a `client_email`, mails from that address received after `updated_at` (`mail_messages`, same business), with subject (`escLabel`) and mark buttons. Then the new-meeting form.
- `mark` sets `response`, `response_at = now()`, and audits (`meeting_response_marked`, no name).

- [ ] **Step 1: Failing tests:** `the form books through the instruction door with the typed email verified`; `shows tomorrow with response icons`; `shows a client's mail reply with mark buttons and marking sets the response`; `mark refuses another business's meeting`; `every POST requires CSRF`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(meetings): meetings screen with form, tomorrow and mail replies`.

---

## Part D: Client sync

### Task 13: Meetings sync, reminders and alerts

**Files:**
- Create: `src/meetings/sync.ts`, `src/meetings/reminder.ts`
- Modify: `src/orchestrator/scheduler.ts` (call after `closeVerifiedJobs`, before the ledger pass; result field `meetings: MeetingSyncResult | null`, error field)
- Test: `src/meetings/sync.test.ts`, `src/meetings/reminder.test.ts`, `src/orchestrator/scheduler-meetings.test.ts`

**Interfaces:**
- Produces:

```ts
export interface MeetingSyncResult { activated: number; abandoned: number; responsesChanged: number; declinedAlerts: number; remindersOpened: number; unansweredAlerts: number; holdsReleased: number }
export async function syncMeetings(o: { businessId: string; runtime: Runtime; now?: Date; sendAlert?: …; messenger?: …; dashboardBaseUrl?: string; client?: CalendarClient }): Promise<MeetingSyncResult>;
export async function openClientReminder(o: { businessId: string; meetingId: string; db?: Queryable }): Promise<{ jobId: string } | { skipped: 'no_mailbox' | 'no_email' | 'already' }>;
```

Sweep, in order:
1. `proposed` rows: step `completed` in `job_step_results` → `active`, with `event_id` = the step's `external_id`, and `markHoldConverted`. Otherwise `response` = `not_updated` when there is no email. A job `failed`/`closed` without a completed step → `abandoned`. For `move`/`update`/`cancel` on activation: earlier `active` rows with the same `event_id` → `done`, and the new row starts `needs_action` (§8.1 reset). A `cancel` row goes straight to `done`.
2. `active` rows with an email, start in the future, response `needs_action`/`tentative`: `getEvent` → attendee response for `client_email` → update on change (`response_at`).
3. Newly `declined` and `declined_notified_at` null → owner alert `❌ <name> דחה את <day> <HH:MM>. כתבי לי מועד חדש או "תציעי מועדים".`, through the owner's action-update channels (`loadActionUpdateSettings`; email via `sendAlert`, WhatsApp via `messenger`; each bounded by `deliver`). Stamp it.
4. Still `needs_action`, `reminder_claimed_at` null, and wait elapsed (24h, or 2h when start − now < 24h, measured from `updated_at`) → claim it (`UPDATE … WHERE reminder_claimed_at IS NULL RETURNING`), `openClientReminder`, owner alert `⏳ <name> עדיין לא אישר את <day> <HH:MM> — הכנתי תזכורת לאישורך.` (or `… — אין לו כתובת/אין תיבת מייל מחוברת, כדאי לעדכן אותו בעצמך.`).
5. `sweepHolds`.
- `openClientReminder`: in the pattern of `openNudge` (`src/ledger/nudge.ts`). `createJob({ provenance: 'boss' })` as a literal, **no** `boss_instructions` row, plan with one `mail.send` step (no `inReplyTo`, `expectedActionClass: 'email.initiate'`). Deterministic body: `שלום <name>,\nרצינו לוודא שהפגישה ב<day> <date> בשעה <HH:MM>, <location>, מתאימה לך. אפשר לאשר בהזמנת היומן או להשיב למייל הזה.\nמזהה תזכורת: <meetingId>` (the id defeats content-derived dedup). Bind the plan, transition to `execute`. The gate then raises the owner's approval card under today's charter. Skip when the charter has no connection serving `mail.send`.
- `promote.ts`: reminder jobs carry no `boss_instructions`, so a failed reminder counts toward `failureCount` like a ledger nudge. Accepted, already listed in CLAUDE.md known issues for nudges; add one line there.

- [ ] **Step 1: Failing tests:** `activates a proposed meeting when its step completed and converts the hold`; `abandons a proposed meeting whose job failed`; `resets the response to needs_action after a move`; `reads an attendee response change from the calendar`; `alerts the owner once on decline`; `opens one reminder after 24h, and after 2h when the meeting is under a day away`; `does not open a second reminder for the same meeting` (two passes); `reminder job has no boss_instructions row and is not covered by the confirmed-command exemption`; `marks a client without email not_updated and never reminds`; `scheduler pass runs the sweep and reports it` (scheduler-meetings test).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(meetings): response sync, client reminders and owner alerts`.

### Task 14: Erasure wiring

**Files:**
- Modify: `src/governance/erasure-plan.ts`, the executor (`src/governance/erasure.ts`), `src/governance/erasure-invariants.test.ts`, `src/dashboard/` erasure preview view
- Test: `src/governance/erasure-plan.test.ts`

Rules:
- `meetings` is a delete target by `job_id` **and** a discovery source of its own (`client_name`, `client_email`, `client_phone`, `internal_note` via `ILIKE` with `likeLiteral` + `LIKE_ESCAPE`, the shared constants). Every found row adds its `job_id` and `reminder_job_id` to `jobIds`. Write the predicate as one exported constant shared by `countItems` and the executor (the existing pattern, e.g. `ACTION_UPDATES_ERASED_PREDICATE`).
- `meeting_holds` holds no content. Delete it by `job_id`.
- Calendar events at Google/Microsoft are never deleted. The preview lists them under "נשארים ביומן שלך" (`plan.calendarEventsKept: {calendarId, eventId, start}[]` from erased `meetings` rows with `event_id`), and they are included in `planFingerprint` (sorted).
- The table count in CLAUDE.md goes 32 → 34. The spec-store count goes 21 → 22 (meetings counted as one store).

- [ ] **Step 1: Failing tests:** seed `meetings` with the PROBE in `client_name`, `client_email`, `internal_note` in `erasure-invariants.test.ts` (the scan must find zero after erasure); `discovers a contact only named in a meeting internal note`; `deletes meeting_holds with the job`; `lists calendar events kept and fingerprints them sorted`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `src/governance`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(erasure): wire meetings and holds; calendar events kept`.

### Task 15: Documentation and final verification

**Files:**
- Modify: `CLAUDE.md` (a section "### יומן ופגישות" in the house style: the bypass, writes only through confirmed commands, the busy rule, sync, erasure counts; update the "פקודות" block with `npm run sdk:meeting-extract`; known issues: nothing run against real providers, Google `calendar.events` verification, Microsoft admin consent, no revoke endpoint, reminder failures count toward demotion)
- Modify: `docs/11-pre-launch-checks.md` (one ☐ line each: OAuth ceremony on Google and on Microsoft; re-consent of an existing read-only connection; full read of a busy real calendar with recurring and all-day events; create, move, edit and cancel with the invite reaching a real client inbox; deterministic id/`transactionId` replay against the real API; attendee response read back; hold created and released; live extractor on 10 real instructions; WhatsApp schedule message on a real phone)
- Modify: `docs/09-roadmap.md` (calendar row, plus M21 recorded as a binding requirement of the future client-WhatsApp project: moved/edited-meeting summary to the client on WhatsApp, reminder on WhatsApp, positive reply = accepted, negative = declined; and multi-account calendars as a follow-up per M22), `docs/08-risks.md` (the hold bypass)

- [ ] **Step 1:** `npm run typecheck`. Expected: no errors.
- [ ] **Step 2:** `npm test` on your own DB. Expected: all pass (the hook's count +N, one skipped).
- [ ] **Step 3:** `/security-review` on the whole branch diff. Fix findings, rerun Step 2.
- [ ] **Step 4: Commit** `docs(calendar): CLAUDE.md, pre-launch checks, roadmap, risks`.
