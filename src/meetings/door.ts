/**
 * The instruction door's calendar entry (calendar scheduling, spec §7). Two
 * entries:
 *   - `answerScheduleQuery` — called by `runInstruction` after the charter load
 *     and BEFORE `createJob`, so a question about the schedule opens no job and
 *     stores no instruction row: it is a read, answered in the channel it came in.
 *   - `runMeetingOperation` — called after the job reached `understand`, before
 *     contact resolution: a meeting change, planned in code and parked on one
 *     boss confirmation (see its docblock).
 */
import { resolveCalendarAccess, type CalendarAccess } from '../calendar/client-for.js';
import { isCalendarFailure, type CalendarClient, type CalendarEvent } from '../calendar/types.js';
import { config } from '../config.js';
import type { BusinessDb } from '../db/pool.js';
import type { Plan } from '../domain/plan.js';
import type { ConfirmationOption } from '../governance/instruction-confirmations.js';
import { cancelConfirmation, loadConfirmation } from '../governance/instruction-confirmations.js';
import { loadInstructionForJob, recordQuestion } from '../governance/instructions.js';
import { appearsVerbatimIn, type InstructionTextOrigin } from '../governance/typed-recipients.js';
import { listContacts, type Contact } from '../memory/contacts.js';
import { resolveContacts } from '../memory/contact-resolver.js';
import { finishSinglePlan, type DoorContext, type InstructionOutcome } from '../orchestrator/instruct.js';
import { PhaseMovedError, transition } from '../orchestrator/jobs.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { runMeetingExtractor, type ExtractorOutcome, type MeetingExtractor } from '../sdk/meeting-extractor.js';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import { localParts, localToInstant } from '../util/local-time.js';
import { busyIntervals, freeIntervals, workWindows, type CharterOperations, type Interval } from './free-time.js';
import { createHold, releaseHold } from './holds.js';
import { buildMeetingPlan, withHoldIds, type ResolvedClient } from './plan.js';
import {
  hhmm,
  localDayLabel,
  loadMeetingResponses,
  parseScheduleQuery,
  renderSchedule,
  UNRECOGNIZED_RANGE_REPLY,
} from './query.js';
import { isMeetingInstruction, namesMeeting, verifyTypedEmails, type MeetingRequest } from './request.js';
import { loadMeetingSettings, type MeetingSettings } from './settings.js';
import { loadCalendarRange } from './snapshot.js';
import { recordProposedMeetings } from './store.js';

export const WHATSAPP_MAX_CHARS = 4_000;
export const CALENDAR_NOT_CONNECTED_REPLY = 'היומן לא מחובר — אפשר לחבר אותו במסך החיבורים.';
export const CALENDAR_NEEDS_REAUTH_REPLY = 'היומן דורש אישור מחדש — אפשר לחבר אותו מחדש במסך החיבורים.';
export const CALENDAR_CREDENTIAL_REPLY = 'לא הצלחתי לפתוח את ההרשאה השמורה ליומן — אם זה חוזר, חבר את היומן מחדש.';
export const CALENDAR_READ_FAILED_REPLY = 'לא הצלחתי לקרוא את היומן עכשיו — אפשר לנסות שוב עוד מעט.';

const READ_TIMEOUT_MS = 20_000;

function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

export async function answerScheduleQuery(db: BusinessDb, o: {
  text: string;
  timeZone: string;
  operations: CharterOperations;
  runtime: Pick<Runtime, 'credentials'>;
  now?: Date;
  client?: CalendarClient;
}): Promise<{ answered: string } | null> {
  const now = o.now ?? new Date();
  const range = parseScheduleQuery(o.text, now, o.timeZone);
  if (range === null) return null;
  if (range === 'unrecognized_range') return { answered: UNRECOGNIZED_RANGE_REPLY };

  const access = await resolveCalendarAccess(db, {
    runtime: o.runtime,
    ...(o.client !== undefined ? { client: o.client } : {}),
  });
  if ('unavailable' in access) {
    return {
      answered:
        access.unavailable === 'needs_reauth'
          ? CALENDAR_NEEDS_REAUTH_REPLY
          : access.unavailable === 'credential_error'
            ? CALENDAR_CREDENTIAL_REPLY
            : CALENDAR_NOT_CONNECTED_REPLY,
    };
  }

  const settings = await loadMeetingSettings(db);
  // A day either side: an event just outside the range still pads the edge of a work window.
  const fromMs = localToInstant(addDays(range.fromDate, -1), '00:00', o.timeZone).getTime();
  const toMs = localToInstant(addDays(range.toDate, 2), '00:00', o.timeZone).getTime();

  let snapshot;
  try {
    snapshot = await loadCalendarRange(db, {
      access,
      settings,
      timeZone: o.timeZone,
      fromIso: new Date(fromMs).toISOString(),
      toIso: new Date(toMs).toISOString(),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    return { answered: CALENDAR_READ_FAILED_REPLY };
  }
  if (isCalendarFailure(snapshot)) {
    return { answered: snapshot.failure === 'auth' ? CALENDAR_NEEDS_REAUTH_REPLY : CALENDAR_READ_FAILED_REPLY };
  }

  const windows = workWindows({
    fromDate: range.fromDate,
    toDate: range.toDate,
    timeZone: o.timeZone,
    operations: o.operations,
    workStart: settings.workStart,
    workEnd: settings.workEnd,
  });
  // The part of today that has already gone is not free.
  const busy: Interval[] = [...busyIntervals(snapshot, settings.gapMinutes), { start: 0, end: now.getTime() }];
  const free = new Map<string, Interval[]>();
  const windowEnds = new Map<string, number>();
  for (const w of windows) {
    const date = localParts(new Date(w.start), o.timeZone).date;
    free.set(date, freeIntervals([w], busy));
    windowEnds.set(date, w.end);
  }

  const responses = await loadMeetingResponses(
    db,
    snapshot.events.map((e) => e.eventId),
  );
  return {
    answered: renderSchedule({
      range,
      snapshot,
      responses,
      free,
      windowEnds,
      timeZone: o.timeZone,
      maxChars: WHATSAPP_MAX_CHARS,
    }),
  };
}

// --- Meeting operations (spec §7.2–§7.5) -------------------------------------

export const MEETING_NOT_UNDERSTOOD_REPLY =
  'לא הצלחתי להבין את בקשת הפגישה — אפשר לנסח שוב או להשתמש בטופס במסך הפגישות.';
export const MEETING_SETTINGS_REQUIRED_REPLY = 'צריך קודם להגדיר את הגדרות הפגישות.';
export const HOLD_FAILED_REPLY = 'לא הצלחתי לשמור את המועד ביומן — אפשר לנסות שוב עוד מעט.';
export const MEETING_PREPARE_FAILED_REPLY = 'לא הצלחתי להכין את הפגישה לאישור — אפשר לנסות שוב.';
export const OTHER_SLOT_FAILED_REPLY = 'לא הצלחתי להכין מועד אחר — אפשר לנסח את בקשת הפגישה מחדש.';
export const ALREADY_CONFIRMED_REPLY = 'הפגישה כבר אושרה — אם צריך לשנות אותה, כתבי לי שוב.';
export const MEETING_SETTINGS_READ_FAILED_REPLY = 'לא הצלחתי לקרוא את הגדרות הפגישות — אפשר לנסות שוב עוד מעט.';
const NO_ALTERNATIVES = 'לא מצאתי בשבועיים הקרובים';
/** `decided_by` of a question turned down by "תני אחר", followed by the turning-down job's id. */
const OTHER_SLOT_DECIDED_BY = 'meeting-door:other-slot:';

/** "תני אחר" / "תציעי מועד אחר": the owner turns down the slot in the open meeting question. */
export const OTHER_SLOT_PATTERN = /^(תני|תציעי)\s+(מועד\s+)?אחר/u;

/**
 * Markers kept in a meeting plan's `assumptions` so a later "תני אחר" can re-run
 * it with no state table: the job whose stored instruction is the original
 * meeting text, and every slot already turned down. Part of the plan's bytes
 * (and hash); never rendered to anyone.
 */
const SOURCE_MARKER = 'meeting-source:';
const EXCLUDE_MARKER = 'meeting-exclude:';

const EXTRACT_TIMEOUT_MS = 60_000;
const HOLD_TIMEOUT_MS = 20_000;
/** Past the last date a request names: room for the "next free" alternatives (spec §7.3). */
const ALTERNATIVE_DAYS = 14;

type Unavailable = 'not_connected' | 'needs_reauth' | 'credential_error';
type CreateOp = Extract<MeetingRequest['ops'][number], { kind: 'create' }>;

function clean(value: string | null | undefined): string {
  return value === null || value === undefined ? '' : toOneLine(stripBidiControls(value));
}

function norm(name: string): string {
  return clean(name).trim().toLowerCase();
}

function unavailableReply(kind: Unavailable): string {
  return kind === 'needs_reauth'
    ? CALENDAR_NEEDS_REAUTH_REPLY
    : kind === 'credential_error'
      ? CALENDAR_CREDENTIAL_REPLY
      : CALENDAR_NOT_CONNECTED_REPLY;
}

async function failMeetingJob(door: DoorContext, audit: string, reason: string): Promise<InstructionOutcome> {
  await transition(door.db, door.jobId, {
    to: 'failed',
    actor: 'orchestrator',
    reason: `meeting door: ${audit}`,
  });
  return { status: 'refused', reason };
}

async function askMeetingQuestion(door: DoorContext, question: string): Promise<InstructionOutcome> {
  try {
    await recordQuestion(door.db, door.instruction.instructionId, question);
  } catch {
    // Best effort, exactly as the instruction door's own questions are.
  }
  return {
    status: 'needs_answer',
    jobId: door.jobId,
    instructionId: door.instruction.instructionId,
    question,
    instructionText: door.instruction.text,
    identityNote: null,
  };
}

/** The extractor, with a throw read as `failed`: an SDK failure is never a guess. */
async function extractSafely(
  extractor: MeetingExtractor,
  text: string,
  now: Date,
  timeZone: string,
): Promise<ExtractorOutcome> {
  try {
    return await extractor({
      text,
      today: localParts(now, timeZone).date,
      timeZone,
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * An email or phone the model returned survives only if it appears in the
 * text the owner gave (`verifyTypedEmails`, and its twin for phones here): a
 * phone left in the request is shown as the owner's own (`phoneVerified`).
 */
function verifyTyped(request: MeetingRequest, text: string): MeetingRequest {
  const emailsChecked = verifyTypedEmails(request, text);
  return {
    ops: emailsChecked.ops.map((op) => {
      if (op.kind !== 'create' || op.client.phone === null) return op;
      if (appearsVerbatimIn(op.client.phone, text)) return op;
      return { ...op, client: { ...op.client, phone: null } };
    }),
  };
}

/** Every date the request names, plus today; a day before and the alternatives after. */
function snapshotRange(request: MeetingRequest, today: string, timeZone: string): { fromIso: string; toIso: string } {
  const dates: string[] = [today];
  for (const op of request.ops) {
    if (op.kind === 'create' || op.kind === 'move') dates.push(op.window.fromDate, op.window.toDate);
    if (op.kind !== 'create' && op.onDate !== null) dates.push(op.onDate);
  }
  dates.sort();
  const first = dates[0] as string;
  const last = dates[dates.length - 1] as string;
  return {
    fromIso: localToInstant(addDays(first, -1), '00:00', timeZone).toISOString(),
    toIso: localToInstant(addDays(last, ALTERNATIVE_DAYS + 1), '00:00', timeZone).toISOString(),
  };
}

function slotText(start: number, end: number, timeZone: string): string {
  return `${localDayLabel(start, timeZone)} ${hhmm(start, timeZone)}–${hhmm(end, timeZone)}`;
}

function noSlotQuestion(dayListing: string, alternatives: Interval[], timeZone: string): string {
  const alts =
    alternatives.length === 0
      ? NO_ALTERNATIVES
      : alternatives.map((a) => slotText(a.start, a.end, timeZone)).join(', ');
  return `${dayListing}\n\nהחלון מלא. אפשר: להזיז מישהו ("תזיזי את X"), לבקש מועדים אחרים — הפנויים הקרובים: ${alts} — או לתת מועד אחר.`;
}

/** Calendar text (title, location) reaches the owner only cleaned and on one line. */
function ambiguousQuestion(name: string, candidates: CalendarEvent[], timeZone: string): string {
  const lines = candidates.map((e, i) => {
    const start = Date.parse(e.start);
    const end = Date.parse(e.end);
    const when = Number.isFinite(start) && Number.isFinite(end) ? slotText(start, end, timeZone) : '(מועד לא ידוע)';
    const title = clean(e.title) || '(ללא כותרת)';
    const location = clean(e.location);
    return `${i + 1}. ${when} · ${title}${location === '' ? '' : ` · 📍 ${location}`}`;
  });
  return [`יש כמה פגישות עם ${clean(name)} — לאיזו הכוונה?`, ...lines].join('\n');
}

/** Same reading as the instruction door's: `boss` only when every contact involved is the owner's word. */
function contactSourceOf(involved: readonly Contact[]): ConfirmationOption['contactSource'] {
  if (involved.length === 0) return null;
  return involved.every((c) => c.provenance === 'boss') ? 'boss' : 'unverified';
}

/** The create / move slots of a plan: what "תני אחר" turns down. */
function slotsOf(plan: Plan): Interval[] {
  const out: Interval[] = [];
  for (const step of plan.steps) {
    const op = step.input['operation'];
    if (op !== 'create' && op !== 'move') continue;
    const start = Date.parse(String(step.input['start']));
    const end = Date.parse(String(step.input['end']));
    if (Number.isFinite(start) && Number.isFinite(end)) out.push({ start, end });
  }
  return out;
}

function markersOf(plan: Plan): { sourceJobId: string | null; exclude: Interval[] } {
  let sourceJobId: string | null = null;
  const exclude: Interval[] = [];
  for (const a of plan.assumptions) {
    if (a.startsWith(SOURCE_MARKER)) sourceJobId = a.slice(SOURCE_MARKER.length);
    if (a.startsWith(EXCLUDE_MARKER)) {
      const [s, e] = a.slice(EXCLUDE_MARKER.length).split('/');
      const start = Date.parse(s ?? '');
      const end = Date.parse(e ?? '');
      if (Number.isFinite(start) && Number.isFinite(end)) exclude.push({ start, end });
    }
  }
  return { sourceJobId, exclude };
}

/**
 * The latest pending meeting question in this channel, inside the question
 * window: a job still parked in `plan`, born at the instruction door, with
 * `meetings` rows of its own. Never this instruction's own job. A WhatsApp
 * question counts only once it was DELIVERED (`delivered_at`, stamped after an
 * `ok` send) — one the owner never received is not the slot he turned down.
 */
async function pendingMeetingQuestion(door: DoorContext): Promise<{ jobId: string; plan: Plan } | null> {
  const windowMinutes = config.whatsappQuestionWindowMinutes;
  if (windowMinutes <= 0) return null;
  const { rows } = await door.db.query<{ job_id: string }>(
    `SELECT c.job_id
       FROM instruction_confirmations c
       JOIN jobs j ON j.business_id = c.business_id AND j.job_id = c.job_id AND j.phase = 'plan'
      WHERE c.business_id = $1 AND c.channel = $2 AND c.state = 'pending' AND c.job_id <> $3
        AND (
          (c.channel = 'whatsapp' AND c.delivered_at IS NOT NULL
             AND c.delivered_at > now() - make_interval(mins => $4))
          OR (c.channel <> 'whatsapp' AND c.presented_at > now() - make_interval(mins => $4))
        )
        AND EXISTS (SELECT 1 FROM boss_instructions b WHERE b.business_id = c.business_id AND b.job_id = c.job_id)
        AND EXISTS (SELECT 1 FROM meetings m WHERE m.business_id = c.business_id AND m.job_id = c.job_id)
      ORDER BY c.presented_at DESC
      LIMIT 1`,
    [door.db.businessId, door.channel, door.jobId, windowMinutes],
  );
  const jobId = rows[0]?.job_id;
  if (jobId === undefined) return null;
  const confirmation = await loadConfirmation(door.db, jobId);
  const option = confirmation?.options[0];
  if (confirmation === null || option === undefined || confirmation.options.length !== 1) return null;
  return { jobId, plan: option.plan };
}

/**
 * The meeting question a "תני אחר" job turned down — found through the
 * `decided_by` that job wrote on it (`OTHER_SLOT_DECIDED_BY` + its job id), an
 * existing column, so an answer to a question that "תני אחר" itself raised
 * (no_slot after the re-search) still knows the original text and every slot
 * already turned down.
 */
async function turnedDownBy(door: DoorContext, jobId: string): Promise<{ jobId: string; plan: Plan } | null> {
  const { rows } = await door.db.query<{ job_id: string }>(
    `SELECT job_id FROM instruction_confirmations
      WHERE business_id = $1 AND state = 'cancelled' AND decided_by = $2
      ORDER BY decided_at DESC
      LIMIT 1`,
    [door.db.businessId, `${OTHER_SLOT_DECIDED_BY}${jobId}`],
  );
  const turnedDown = rows[0]?.job_id;
  if (turnedDown === undefined) return null;
  const confirmation = await loadConfirmation(door.db, turnedDown);
  const option = confirmation?.options[0];
  if (confirmation === null || option === undefined || confirmation.options.length !== 1) return null;
  return { jobId: turnedDown, plan: option.plan };
}

/** "2", "מספר 2", "2." — a pick from the numbered "which meeting" question. */
function pickedNumber(answer: string): number | null {
  const m = /^\s*(?:מספר\s*)?(\d{1,2})\s*\.?\s*$/u.exec(stripBidiControls(answer));
  if (m === null) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}

/** Best effort: a hold this misses is released by `sweepHolds` once its job is closed or failed. */
async function releaseHoldIds(db: BusinessDb, access: CalendarAccess, holdIds: readonly string[]): Promise<void> {
  for (const holdId of holdIds) {
    try {
      await releaseHold(db, { access, holdId, signal: AbortSignal.timeout(HOLD_TIMEOUT_MS) });
    } catch {
      // swept later
    }
  }
}

async function releaseJobHolds(db: BusinessDb, access: CalendarAccess, jobId: string): Promise<void> {
  const { rows } = await db.query<{ hold_id: string }>(
    `SELECT hold_id FROM meeting_holds WHERE business_id = $1 AND job_id = $2 AND state = 'held'`,
    [db.businessId, jobId],
  );
  await releaseHoldIds(db, access, rows.map((r) => r.hold_id));
}

/** The proposal never reached the owner: its rows stop reading as proposed. */
async function abandonProposed(door: DoorContext): Promise<void> {
  try {
    await door.db.query(
      `UPDATE meetings SET state = 'abandoned', updated_at = now()
        WHERE business_id = $1 AND job_id = $2 AND state = 'proposed'`,
      [door.db.businessId, door.jobId],
    );
  } catch {
    // best effort
  }
}

/**
 * The instruction door's meeting branch (spec §7.2–§7.5). Called by
 * `runInstruction` after the job reached `understand`, only when the caller
 * passed calendar access. `null`: not a meeting instruction, and the general
 * planner continues.
 *
 * The plan is built in code (`buildMeetingPlan`) ONCE; a hold is placed at each
 * planned create slot (the one documented gate bypass, `holds.ts`), the hold
 * ids are substituted into exactly those create inputs (`withHoldIds`), and the
 * plan parks on ONE boss confirmation through the instruction door's own
 * `finishSingle` — so every write runs later through `runPlan` → the gate →
 * `confirmedCommandCovers`, with no new exemption. Any failure after a hold
 * was placed releases every hold this call placed.
 *
 * "תני אחר": the open meeting question in this channel is cancelled — only if
 * it is still pending; one the owner confirmed meanwhile is left alone — its
 * holds released, and the ORIGINAL meeting text (the job named by the plan's
 * source marker, else the turned-down job itself) is extracted again with every
 * slot already turned down treated as busy.
 *
 * Answer pass (`answerTo`): the joined text (parked instruction + answer) is
 * extracted; a bare number picks that candidate of a "which meeting" question;
 * an answer to a question "תני אחר" raised re-reads the original text joined
 * with the answer, keeping every turned-down slot excluded.
 *
 * Verification (CLAUDE.md "תמלול אינו הקלדה"): an email or phone is verified
 * only when the text it came from was TYPED and it appears there verbatim.
 */
export async function runMeetingOperation(
  door: DoorContext,
  o: {
    request?: MeetingRequest;
    extractor?: MeetingExtractor;
    runtime: Pick<Runtime, 'credentials'>;
    client?: CalendarClient;
    now?: Date;
    answerTo?: { jobId: string; answer: string };
  },
): Promise<InstructionOutcome | null> {
  const now = o.now ?? new Date();
  const extractor = o.extractor ?? runMeetingExtractor;
  const ownText = stripBidiControls(door.instruction.text).trim();

  let request: MeetingRequest;
  /** The text the request was read from — the one typed emails and phones are checked against. */
  let sourceText = door.instruction.text;
  /** Where `sourceText`'s bytes came from: verification needs typed AND verbatim. */
  let sourceOrigin: InstructionTextOrigin = door.textOrigin;
  let sourceJobId = door.jobId;
  let exclude: Interval[] = [];
  let access: CalendarAccess | null = null;
  let choose: ((clientName: string, candidates: readonly CalendarEvent[]) => CalendarEvent | null) | undefined;

  const resolveAccess = (): Promise<CalendarAccess | { unavailable: Unavailable }> =>
    resolveCalendarAccess(door.db, {
      runtime: o.runtime,
      ...(o.client !== undefined ? { client: o.client } : {}),
    });

  /** Calendar access (reused when already resolved) and the meeting settings, or the refusal. */
  type Readiness =
    | { access: CalendarAccess; settings: MeetingSettings }
    | { refusal: { audit: string; reply: string } };
  const readiness = async (known: CalendarAccess | null = null): Promise<Readiness> => {
    let resolvedAccess = known;
    if (resolvedAccess === null) {
      const resolved = await resolveAccess();
      if ('unavailable' in resolved) {
        return { refusal: { audit: `calendar ${resolved.unavailable}`, reply: unavailableReply(resolved.unavailable) } };
      }
      resolvedAccess = resolved;
    }
    let loaded: MeetingSettings;
    try {
      loaded = await loadMeetingSettings(door.db);
    } catch (err) {
      return {
        refusal: {
          audit: `meeting settings read threw (${err instanceof Error ? err.message : String(err)})`,
          reply: MEETING_SETTINGS_READ_FAILED_REPLY,
        },
      };
    }
    if (loaded.locationKind === null) {
      return { refusal: { audit: 'meeting settings not set', reply: MEETING_SETTINGS_REQUIRED_REPLY } };
    }
    return { access: resolvedAccess, settings: loaded };
  };
  let preloaded: MeetingSettings | null = null;

  if (o.answerTo !== undefined) {
    const n = pickedNumber(o.answerTo.answer);
    if (n !== null) choose = (_name, candidates) => candidates[n - 1] ?? null;
  }
  const parked =
    o.answerTo !== undefined ? await loadInstructionForJob(door.db, o.answerTo.jobId) : null;

  if (o.request !== undefined) {
    // The dashboard's meeting form: every field was typed by the owner into the
    // form, so the door's `textOrigin` is 'typed' by construction, and the
    // caller (Task 12) synthesizes the instruction text with each field
    // verbatim — so the same `appearsVerbatimIn` check still runs on it.
    request = verifyTyped(o.request, door.instruction.text);
  } else if (o.answerTo !== undefined && parked !== null && OTHER_SLOT_PATTERN.test(stripBidiControls(parked.text).trim())) {
    // An answer to a question a "תני אחר" raised: back to the original text, the
    // turned-down slots still excluded.
    const prior = await turnedDownBy(door, o.answerTo.jobId);
    if (prior === null) return null;
    const markers = markersOf(prior.plan);
    sourceJobId = markers.sourceJobId ?? prior.jobId;
    exclude = [...markers.exclude, ...slotsOf(prior.plan)];
    const source = await loadInstructionForJob(door.db, sourceJobId);
    if (source === null) return failMeetingJob(door, 'source instruction not found', OTHER_SLOT_FAILED_REPLY);
    sourceText = `${source.text}\n\n${o.answerTo.answer}`;
    sourceOrigin = source.textOrigin === 'typed' && door.textOrigin === 'typed' ? 'typed' : 'transcribed';
    const extracted = await extractSafely(extractor, sourceText, now, door.timeZone);
    if (extracted.status === 'not_meeting') return null;
    if (extracted.status === 'failed') {
      return failMeetingJob(door, `extraction failed (${extracted.reason})`, MEETING_NOT_UNDERSTOOD_REPLY);
    }
    request = verifyTyped(extracted.request, sourceText);
  } else if (o.answerTo === undefined && OTHER_SLOT_PATTERN.test(ownText)) {
    const previous = await pendingMeetingQuestion(door);
    if (previous === null) return null;
    const resolved = await resolveAccess();
    if ('unavailable' in resolved) {
      return failMeetingJob(door, `calendar ${resolved.unavailable}`, unavailableReply(resolved.unavailable));
    }
    access = resolved;

    // The question is turned down first — only if it is still pending. One the
    // owner confirmed meanwhile (the dashboard, a second channel) is about to
    // run: its job and its hold are not ours to touch.
    const cancelled = await cancelConfirmation(door.db, previous.jobId, `${OTHER_SLOT_DECIDED_BY}${door.jobId}`);
    if (!cancelled) return failMeetingJob(door, 'the turned-down question was already decided', ALREADY_CONFIRMED_REPLY);
    try {
      await transition(door.db, previous.jobId, {
        to: 'closed',
        actor: 'human',
        reason: 'meeting door: the owner asked for another slot',
        expectFrom: 'plan',
      });
    } catch (err) {
      // Moved on by someone else (the settle sweep closes a cancelled question too).
      if (!(err instanceof PhaseMovedError)) throw err;
    }
    await releaseJobHolds(door.db, access, previous.jobId);

    const markers = markersOf(previous.plan);
    sourceJobId = markers.sourceJobId ?? previous.jobId;
    exclude = [...markers.exclude, ...slotsOf(previous.plan)];
    const source = await loadInstructionForJob(door.db, sourceJobId);
    if (source === null) return failMeetingJob(door, 'source instruction not found', OTHER_SLOT_FAILED_REPLY);
    sourceText = source.text;
    // The SOURCE instruction's origin, not this message's: "תני אחר" typed under a
    // voice-note request does not make the recorded address typed.
    sourceOrigin = source.textOrigin;
    const extracted = await extractSafely(extractor, sourceText, now, door.timeZone);
    if (extracted.status !== 'extracted') {
      return failMeetingJob(door, `re-extraction ${extracted.status}`, OTHER_SLOT_FAILED_REPLY);
    }
    request = verifyTyped(extracted.request, sourceText);
  } else {
    if (!isMeetingInstruction(door.instruction.text)) return null;
    // The cheap checks before the billed extraction: a text that names a
    // meeting outright, with no calendar or no settings, is refused without a
    // model call. One with only a time word may not be a meeting, so it is
    // still extracted — a `not_meeting` goes on to the general planner.
    const ready = await readiness();
    if ('refusal' in ready && namesMeeting(door.instruction.text)) {
      return failMeetingJob(door, ready.refusal.audit, ready.refusal.reply);
    }
    const extracted = await extractSafely(extractor, door.instruction.text, now, door.timeZone);
    if (extracted.status === 'not_meeting') return null;
    if (extracted.status === 'failed') {
      return failMeetingJob(door, `extraction failed (${extracted.reason})`, MEETING_NOT_UNDERSTOOD_REPLY);
    }
    if ('refusal' in ready) return failMeetingJob(door, ready.refusal.audit, ready.refusal.reply);
    access = ready.access;
    preloaded = ready.settings;
    request = verifyTyped(extracted.request, door.instruction.text);
  }

  let settings: MeetingSettings;
  if (access === null || preloaded === null) {
    const ready = await readiness(access);
    if ('refusal' in ready) return failMeetingJob(door, ready.refusal.audit, ready.refusal.reply);
    access = ready.access;
    settings = ready.settings;
  } else {
    settings = preloaded;
  }
  const calendar: CalendarAccess = access;

  const range = snapshotRange(request, localParts(now, door.timeZone).date, door.timeZone);
  let snapshot: Awaited<ReturnType<typeof loadCalendarRange>>;
  try {
    snapshot = await loadCalendarRange(door.db, {
      access: calendar,
      settings,
      timeZone: door.timeZone,
      fromIso: range.fromIso,
      toIso: range.toIso,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    return failMeetingJob(door, 'calendar read threw', CALENDAR_READ_FAILED_REPLY);
  }
  if (isCalendarFailure(snapshot)) {
    return failMeetingJob(
      door,
      `calendar read ${snapshot.failure}`,
      snapshot.failure === 'auth' ? CALENDAR_NEEDS_REAUTH_REPLY : CALENDAR_READ_FAILED_REPLY,
    );
  }

  // A failed contact read degrades to no memory, like the instruction door's.
  let contacts: Contact[] = [];
  try {
    contacts = await listContacts(door.db);
  } catch {
    contacts = [];
  }
  const used: Contact[] = [];
  const typedClients = request.ops.filter((op): op is CreateOp => op.kind === 'create');
  const resolveClient = (name: string): ResolvedClient => {
    const key = norm(name);
    const typed = typedClients.find((op) => norm(op.client.name) === key);
    let email: string | null = null;
    let emailVerified = false;
    let phone: string | null = null;
    let phoneVerified = false;
    // Verified only when the text was TYPED and the value appears in it
    // verbatim (CLAUDE.md "תמלול אינו הקלדה"): a transcription is a model's
    // output, and an address that appears only there is shown unverified.
    const typedText = sourceOrigin === 'typed';
    if (typed !== undefined && typed.client.email !== null) {
      email = typed.client.email;
      emailVerified = typedText && appearsVerbatimIn(email, sourceText);
    }
    if (typed !== undefined && typed.client.phone !== null) {
      phone = typed.client.phone;
      phoneVerified = typedText && appearsVerbatimIn(phone, sourceText);
    }
    if (email === null) {
      const subjects = resolveContacts(name, contacts).subjects;
      const matched = contacts.filter((c) => c.subjectKeys.some((k) => subjects.includes(k)));
      const only = matched[0];
      if (matched.length === 1 && only !== undefined && only.email !== null) {
        email = only.email;
        emailVerified = false;
        if (!used.includes(only)) used.push(only);
      }
    }
    return { name, email, emailVerified, phone, phoneVerified };
  };

  const result = buildMeetingPlan({
    request,
    snapshot,
    settings,
    operations: door.operations,
    timeZone: door.timeZone,
    now,
    resolveClient,
    holdEventIds: new Map(),
    exclude,
    ...(choose !== undefined ? { choose } : {}),
  });

  switch (result.kind) {
    case 'no_slot':
      return askMeetingQuestion(door, noSlotQuestion(result.dayListing, result.alternatives, door.timeZone));
    case 'ambiguous':
      return askMeetingQuestion(door, ambiguousQuestion(result.clientName, result.candidates, door.timeZone));
    case 'not_found':
      return askMeetingQuestion(door, `לא מצאתי פגישה עם ${clean(result.clientName)} בטווח.`);
    case 'refused':
      return failMeetingJob(door, 'plan refused', result.reason);
    case 'plan':
      break;
  }

  const assumptions: string[] = [];
  if (sourceJobId !== door.jobId) assumptions.push(`${SOURCE_MARKER}${sourceJobId}`);
  for (const i of exclude) {
    assumptions.push(`${EXCLUDE_MARKER}${new Date(i.start).toISOString()}/${new Date(i.end).toISOString()}`);
  }
  const built: Plan = { ...result.plan, assumptions };

  // Holds at exactly the planned create slots, in the write calendar the plan
  // chose (`settings.writeCalendarId ?? the snapshot's primary calendar`).
  const placed: string[] = [];
  const holdByStepId = new Map<string, string>();
  for (const [i, change] of result.changes.entries()) {
    if (change.op !== 'create') continue;
    const step = built.steps[i];
    let hold: Awaited<ReturnType<typeof createHold>> | null = null;
    if (step !== undefined) {
      try {
        hold = await createHold(door.db, {
          access: calendar,
          jobId: door.jobId,
          calendarId: change.calendarId,
          start: change.start,
          end: change.end,
          clientName: change.client.name,
          signal: AbortSignal.timeout(HOLD_TIMEOUT_MS),
        });
      } catch {
        hold = null;
      }
    }
    if (step === undefined || hold === null || isCalendarFailure(hold)) {
      await releaseHoldIds(door.db, calendar, placed);
      return failMeetingJob(door, 'hold could not be placed', HOLD_FAILED_REPLY);
    }
    placed.push(hold.holdId);
    holdByStepId.set(step.id, hold.eventId);
  }

  const undo = async (audit: string): Promise<InstructionOutcome> => {
    await releaseHoldIds(door.db, calendar, placed);
    await abandonProposed(door);
    return failMeetingJob(door, audit, MEETING_PREPARE_FAILED_REPLY);
  };

  let plan: Plan;
  try {
    plan = withHoldIds(built, holdByStepId);
    await recordProposedMeetings(door.db, { jobId: door.jobId, plan, changes: result.changes });
  } catch (err) {
    return undo(`could not record the proposal (${err instanceof Error ? err.message : String(err)})`);
  }

  let outcome: InstructionOutcome;
  try {
    outcome = await finishSinglePlan(door, {
      plan,
      label: result.summary.split('\n')[0] || 'שינוי פגישות',
      contactSource: contactSourceOf(used),
      identityNote: null,
      extraEcho: result.summary,
    });
  } catch (err) {
    return undo(`could not park the confirmation (${err instanceof Error ? err.message : String(err)})`);
  }
  if (outcome.status === 'refused') {
    // `finishSingle` already failed the job; the holds and rows are ours to undo.
    await releaseHoldIds(door.db, calendar, placed);
    await abandonProposed(door);
  }
  return outcome;
}
