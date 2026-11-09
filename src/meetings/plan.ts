/**
 * The deterministic meeting plan builder (calendar scheduling, spec §7.2–§7.5, §9).
 *
 * The model at most EXTRACTS a `MeetingRequest`; everything here is code: it
 * finds the events a move / cancel / edit names, finds free time, applies every
 * change to the snapshot in memory, checks the final schedule, and emits a
 * `Plan` of `calendar.write` steps whose inputs are the exact bytes that will
 * run. Pure: no database, no provider, no clock beyond `now`.
 *
 * Three rules shape it:
 *   - **The internal note never reaches a step input.** It is the owner's own
 *     note ("לא לשכוח לגבות חוב"); every step input is visible to the client.
 *     It travels only on the `PlannedChange`, for the `meetings` row.
 *   - **A move goes only into free time.** Every slot is searched against the
 *     schedule as it stands after the changes placed before it, so a settled
 *     client is displaced only by an explicit `move` op in the same request.
 *   - **The final schedule is checked as a whole (§7.5).** After all changes are
 *     applied, every interval this plan places is checked against every other
 *     busy interval, keyed by calendar AND event id. The sequential search
 *     ignores the moved event by id only (`busyIntervals`' `ignoreEventIds`),
 *     so an unrelated event in another calendar that shares that id would be
 *     ignored too — the final check is what refuses that plan.
 *
 * Holds: the meeting door (`door.ts`) builds ONCE with `holdEventIds` empty,
 * places a hold at each planned create slot, then substitutes the hold ids into
 * exactly those create step inputs with `withHoldIds` — nothing is recomputed,
 * so the slot the owner is asked about is the slot that was held. The hold
 * events named in `holdEventIds` (still accepted) are ignored as busy time.
 *
 * `exclude` (optional): intervals treated as busy, unpadded — the slots the
 * owner already turned down with "תני אחר".
 */
import { HOLD_TITLE_PREFIX } from '../calendar/calendar.js';
import type { CalendarEvent } from '../calendar/types.js';
import type { Plan, PlanStep } from '../domain/plan.js';
import { CalendarWriteInput } from '../orchestrator/adapters/calendar.js';
import { refineActionClass } from '../policy/classify.js';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import { localParts } from '../util/local-time.js';
import {
  busyIntervals,
  findSlots,
  freeIntervals,
  workWindows,
  type CharterOperations,
  type Interval,
} from './free-time.js';
import { hhmm, localDayLabel, renderSchedule } from './query.js';
import type { MeetingOp, MeetingRequest } from './request.js';
import type { MeetingSettings } from './settings.js';
import type { CalendarSnapshot } from './snapshot.js';

export interface ResolvedClient {
  name: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  /** The phone appeared verbatim in the owner's instruction (the caller decides, like `emailVerified`). */
  phoneVerified: boolean;
}

export type PlannedChange =
  | {
      op: 'create';
      client: ResolvedClient;
      calendarId: string;
      start: string;
      end: string;
      location: string | null;
      clientNotes: string | null;
      internalNote: string | null;
      needsHold: true;
    }
  | {
      op: 'move' | 'update' | 'cancel';
      event: CalendarEvent;
      client: ResolvedClient;
      start?: string;
      end?: string;
      location?: string | null;
      clientNotes?: string | null;
    };

export type MeetingPlanResult =
  | { kind: 'plan'; plan: Plan; changes: PlannedChange[]; summary: string }
  | { kind: 'no_slot'; opIndex: number; dayListing: string; alternatives: Interval[] }
  | { kind: 'ambiguous'; clientName: string; candidates: CalendarEvent[] }
  | { kind: 'not_found'; clientName: string }
  | { kind: 'refused'; reason: string };

export const READ_ONLY_CALENDAR_REFUSAL = 'היומן הזה לקריאה בלבד — אי אפשר לשנות בו פגישות.';
export const NO_WRITE_CALENDAR_REFUSAL = 'לא נמצא יומן לקביעת פגישות — צריך לבחור יומן בהגדרות הפגישות.';
export const TRUNCATED_REFUSAL = 'ביומן יותר אירועים ממה שנקרא — אי אפשר לוודא שהמועד פנוי.';
export const DUPLICATE_TARGET_REFUSAL = 'אותה פגישה מופיעה בבקשה יותר מפעם אחת באופן סותר — צריך לנסח מחדש.';
export const NOTHING_TO_EDIT_REFUSAL = 'לא צוין מה לשנות בפגישה.';
export const INVALID_STEP_REFUSAL = 'פרטי הפגישה אינם תקינים — לא ניתן להכין אותה.';

export function organizerRefusal(name: string): string {
  return `את הפגישה הזו קבע ${name} — את המועד צריך לשנות מולו.`;
}

export function conflictRefusal(a: string, b: string): string {
  return `הלו"ז הסופי מתנגש: "${a}" ו-"${b}" חופפות או צמודות מדי.`;
}

const MIN_MS = 60_000;
const DAY_LISTING_MAX_CHARS = 3000;
const MAX_ALTERNATIVES = 3;
const KEY_SEP = '\u0000';

function clean(value: string | null | undefined): string {
  return value === null || value === undefined ? '' : toOneLine(stripBidiControls(value));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

function eventKey(e: { calendarId: string; eventId: string }): string {
  return `${e.calendarId}${KEY_SEP}${e.eventId}`;
}

/** `clientNotes` and a phone line, each when present; `null` when both are empty. */
function composeDescription(notes: string | null, phone: string | null): string | null {
  const parts: string[] = [];
  if (notes !== null && notes.trim() !== '') parts.push(notes);
  if (phone !== null && phone.trim() !== '') parts.push(`טלפון: ${phone}`);
  return parts.length === 0 ? null : parts.join('\n');
}

const PHONE_LINE = /^טלפון: .+$/u;

/**
 * An edit of the client notes keeps the event's trailing `טלפון: …` line (the
 * one a create wrote), after the new notes. `null` when nothing is left.
 */
export function editedDescription(current: string | null, notes: string | null): string | null {
  const lines = (current ?? '').split(/\r\n|[\r\n]|\p{Zl}|\p{Zp}/u);
  let last = '';
  while (lines.length > 0 && last === '') last = (lines.pop() ?? '').trim();
  const phoneLine = PHONE_LINE.test(last) ? last : null;
  const parts: string[] = [];
  if (notes !== null && notes.trim() !== '') parts.push(notes);
  if (phoneLine !== null) parts.push(phoneLine);
  return parts.length === 0 ? null : parts.join('\n');
}

function isHoldEvent(e: CalendarEvent): boolean {
  return e.title.startsWith(HOLD_TITLE_PREFIX);
}

function matchEvents(
  snapshot: CalendarSnapshot,
  name: string,
  email: string | null,
  onDate: string | null,
  timeZone: string,
): CalendarEvent[] {
  const needle = name.trim().toLowerCase();
  const mail = email?.trim().toLowerCase() ?? '';
  return snapshot.events.filter((e) => {
    if (isHoldEvent(e)) return false;
    const start = Date.parse(e.start);
    if (!Number.isFinite(start)) return false;
    if (onDate !== null && localParts(new Date(start), timeZone).date !== onDate) return false;
    const byTitle = needle !== '' && e.title.toLowerCase().includes(needle);
    const byMail = mail !== '' && e.attendees.some((a) => a.email.trim().toLowerCase() === mail);
    return byTitle || byMail;
  });
}

interface Search {
  operations: CharterOperations;
  settings: MeetingSettings;
  timeZone: string;
  now: Date;
}

function windowWork(s: Search, w: { fromDate: string; toDate: string; fromTime: string | null; toTime: string | null }): Interval[] {
  return workWindows({
    fromDate: w.fromDate,
    toDate: w.toDate,
    timeZone: s.timeZone,
    operations: s.operations,
    workStart: s.settings.workStart,
    workEnd: s.settings.workEnd,
    fromTime: w.fromTime,
    toTime: w.toTime,
  });
}

/** The day listing of a full window (Task 7 renderer) with each work day's free time. */
function dayListing(
  s: Search,
  snapshot: CalendarSnapshot,
  busy: Interval[],
  window: { fromDate: string; toDate: string },
): string {
  const free = new Map<string, Interval[]>();
  const windowEnds = new Map<string, number>();
  for (let d = window.fromDate, i = 0; d <= window.toDate && i < 62; d = addDays(d, 1), i += 1) {
    const work = windowWork(s, { fromDate: d, toDate: d, fromTime: null, toTime: null });
    if (work.length === 0) continue;
    free.set(d, freeIntervals(work, busy));
    const last = work[work.length - 1];
    if (last !== undefined) windowEnds.set(d, last.end);
  }
  return renderSchedule({
    range: { fromDate: window.fromDate, toDate: window.toDate },
    snapshot,
    responses: new Map(),
    free,
    timeZone: s.timeZone,
    maxChars: DAY_LISTING_MAX_CHARS,
    windowEnds,
  });
}

/** Up to three slots after the window, inside the snapshot's range only (time outside it was never read). */
function alternativesAfter(s: Search, snapshot: CalendarSnapshot, busy: Interval[], toDate: string, durationMin: number): Interval[] {
  const snapshotEnd = Date.parse(snapshot.toIso);
  if (!Number.isFinite(snapshotEnd)) return [];
  const lastDate = localParts(new Date(snapshotEnd), s.timeZone).date;
  const fromDate = addDays(toDate, 1);
  if (fromDate > lastDate) return [];
  const work = windowWork(s, { fromDate, toDate: lastDate, fromTime: null, toTime: null });
  const free = freeIntervals(work, busy).map((f) => ({ start: f.start, end: Math.min(f.end, snapshotEnd) }));
  return findSlots(free, durationMin, MAX_ALTERNATIVES, s.now.getTime(), durationMin + s.settings.gapMinutes);
}

type CreateChange = Extract<PlannedChange, { op: 'create' }>;
type ExistingChange = Extract<PlannedChange, { event: CalendarEvent }>;

type Staged =
  | { op: 'create'; opIndex: number; change: CreateChange; holdEventId: string | null }
  | { op: 'move'; opIndex: number; change: ExistingChange; vacated: Interval }
  | { op: 'cancel'; opIndex: number; change: ExistingChange; vacated: Interval }
  | { op: 'update'; opIndex: number; change: ExistingChange };

export function buildMeetingPlan(o: {
  request: MeetingRequest;
  snapshot: CalendarSnapshot;
  settings: MeetingSettings;
  operations: CharterOperations;
  timeZone: string;
  now: Date;
  resolveClient: (name: string) => ResolvedClient;
  holdEventIds: ReadonlyMap<number, string>;
  exclude?: readonly Interval[];
  /**
   * The owner's pick when a name matches several events (an answer to the
   * "which meeting" question, by number). Called with the candidates in the
   * same order the question listed them; a returned event must be one of
   * them — anything else, or `null`, keeps the question.
   */
  choose?: (clientName: string, candidates: readonly CalendarEvent[]) => CalendarEvent | null;
}): MeetingPlanResult {
  const { snapshot, settings, timeZone } = o;
  const search: Search = { operations: o.operations, settings, timeZone, now: o.now };
  const gap = settings.gapMinutes;
  const holdIds = new Set(o.holdEventIds.values());
  const calendars = new Map(snapshot.calendars.map((c) => [c.calendarId, c]));
  const ops = o.request.ops;
  const excluded: Interval[] = (o.exclude ?? []).map((i) => ({ start: i.start, end: i.end }));

  if (snapshot.truncated && ops.some((op) => op.kind === 'create' || op.kind === 'move')) {
    return { kind: 'refused', reason: TRUNCATED_REFUSAL };
  }

  // 1. Resolve every target event, in request order; the first failure answers.
  const targets = new Map<number, { event: CalendarEvent; client: ResolvedClient }>();
  for (const [index, op] of ops.entries()) {
    if (op.kind === 'create') continue;
    const client = o.resolveClient(op.clientName);
    const found = matchEvents(snapshot, op.clientName, client.email, op.onDate, timeZone);
    if (found.length === 0) return { kind: 'not_found', clientName: op.clientName };
    let event = found[0] as CalendarEvent;
    if (found.length > 1) {
      const picked = o.choose?.(op.clientName, found) ?? null;
      if (picked === null || !found.includes(picked)) {
        return { kind: 'ambiguous', clientName: op.clientName, candidates: found };
      }
      event = picked;
    }
    if (!event.organizerIsSelf && event.attendees.length > 0) {
      return { kind: 'refused', reason: organizerRefusal(clean(op.clientName)) };
    }
    if (calendars.get(event.calendarId)?.canWrite !== true) {
      return { kind: 'refused', reason: READ_ONLY_CALENDAR_REFUSAL };
    }
    targets.set(index, { event, client });
  }

  // An event a cancel names cannot also be moved or edited, nor moved twice.
  const uses = new Map<string, MeetingOp['kind'][]>();
  for (const [index, t] of targets) {
    const key = eventKey(t.event);
    uses.set(key, [...(uses.get(key) ?? []), (ops[index] as MeetingOp).kind]);
  }
  for (const kinds of uses.values()) {
    if (kinds.length > 1 && (kinds.includes('cancel') || kinds.filter((k) => k === 'move').length > 1)) {
      return { kind: 'refused', reason: DUPLICATE_TARGET_REFUSAL };
    }
  }

  // 2. The working schedule: copies of the snapshot's events, mutated in place.
  const state: CalendarEvent[] = snapshot.events.map((e) => ({ ...e }));
  const original = new Map<CalendarEvent, CalendarEvent>();
  snapshot.events.forEach((e, i) => original.set(e, state[i] as CalendarEvent));
  const placed = new Set<CalendarEvent>();
  const working = (): CalendarSnapshot => ({ ...snapshot, events: state });

  const staged: Staged[] = [];

  // 2a. Cancels vacate first.
  for (const [index, op] of ops.entries()) {
    if (op.kind !== 'cancel') continue;
    const t = targets.get(index) as { event: CalendarEvent; client: ResolvedClient };
    const copy = original.get(t.event) as CalendarEvent;
    state.splice(state.indexOf(copy), 1);
    staged.push({
      op: 'cancel',
      opIndex: index,
      change: { op: 'cancel', event: t.event, client: t.client },
      vacated: { start: Date.parse(t.event.start), end: Date.parse(t.event.end) },
    });
  }

  // 2b. Moves and updates, in request order. A move keeps its duration.
  for (const [index, op] of ops.entries()) {
    if (op.kind !== 'move' && op.kind !== 'edit') continue;
    const t = targets.get(index) as { event: CalendarEvent; client: ResolvedClient };
    if (op.kind === 'edit') {
      const change: ExistingChange = { op: 'update', event: t.event, client: t.client };
      let touched = false;
      if (op.location !== undefined) {
        change.location = op.location;
        touched = true;
      }
      if (op.clientNotes !== undefined) {
        change.clientNotes = op.clientNotes;
        touched = true;
      }
      if (!touched) return { kind: 'refused', reason: NOTHING_TO_EDIT_REFUSAL };
      staged.push({ op: 'update', opIndex: index, change });
      continue;
    }
    const copy = original.get(t.event) as CalendarEvent;
    const durationMin = Math.round((Date.parse(t.event.end) - Date.parse(t.event.start)) / MIN_MS);
    const ignore = new Set([...holdIds, t.event.eventId]);
    const busy = [...busyIntervals(working(), gap, ignore), ...excluded];
    const slot = findSlots(freeIntervals(windowWork(search, op.window), busy), durationMin, 1, o.now.getTime())[0];
    if (slot === undefined) {
      return {
        kind: 'no_slot',
        opIndex: index,
        dayListing: dayListing(search, working(), busy, op.window),
        alternatives: alternativesAfter(search, snapshot, busy, op.window.toDate, durationMin),
      };
    }
    const vacated = { start: Date.parse(copy.start), end: Date.parse(copy.end) };
    copy.start = iso(slot.start);
    copy.end = iso(slot.end);
    placed.add(copy);
    staged.push({
      op: 'move',
      opIndex: index,
      change: { op: 'move', event: t.event, client: t.client, start: copy.start, end: copy.end },
      vacated,
    });
  }

  // 2c. Creates fill last.
  for (const [index, op] of ops.entries()) {
    if (op.kind !== 'create') continue;
    const calendarId = settings.writeCalendarId ?? snapshot.calendars.find((c) => c.primary)?.calendarId ?? null;
    if (calendarId === null) return { kind: 'refused', reason: NO_WRITE_CALENDAR_REFUSAL };
    if (calendars.get(calendarId)?.canWrite !== true) return { kind: 'refused', reason: READ_ONLY_CALENDAR_REFUSAL };

    const durationMin = op.durationMinutes ?? settings.defaultDurationMinutes;
    const busy = [...busyIntervals(working(), gap, holdIds), ...excluded];
    const slot = findSlots(freeIntervals(windowWork(search, op.window), busy), durationMin, 1, o.now.getTime())[0];
    if (slot === undefined) {
      return {
        kind: 'no_slot',
        opIndex: index,
        dayListing: dayListing(search, working(), busy, op.window),
        alternatives: alternativesAfter(search, snapshot, busy, op.window.toDate, durationMin),
      };
    }

    // Verification is the caller's (`resolveClient`): typed text AND verbatim
    // (CLAUDE.md "תמלול אינו הקלדה"). A value this plan uses is verified only
    // when it is the very value `resolveClient` vouched for; nothing here
    // marks a request value verified on its own say-so.
    const resolved = o.resolveClient(op.client.name);
    const email = op.client.email ?? resolved.email;
    const phone = op.client.phone ?? resolved.phone;
    const client: ResolvedClient = {
      name: op.client.name,
      email,
      emailVerified:
        email !== null &&
        resolved.email !== null &&
        email.trim().toLowerCase() === resolved.email.trim().toLowerCase() &&
        resolved.emailVerified,
      phone,
      phoneVerified: phone !== null && resolved.phone !== null && phone === resolved.phone && resolved.phoneVerified,
    };
    const location = op.location ?? (settings.locationKind === 'fixed' ? settings.fixedAddress : null);
    const synthetic: CalendarEvent = {
      calendarId,
      eventId: `planned:${index}`,
      title: op.client.name,
      start: iso(slot.start),
      end: iso(slot.end),
      allDay: false,
      location,
      description: null,
      organizerIsSelf: true,
      busy: true,
      selfDeclined: false,
      transactionId: null,
      attendees: [],
    };
    state.push(synthetic);
    placed.add(synthetic);
    staged.push({
      op: 'create',
      opIndex: index,
      holdEventId: o.holdEventIds.get(index) ?? null,
      change: {
        op: 'create',
        client,
        calendarId,
        start: synthetic.start,
        end: synthetic.end,
        location,
        clientNotes: op.clientNotes,
        internalNote: op.internalNote,
        needsHold: true,
      },
    });
  }

  // 3. The final schedule, as a whole.
  const conflict = finalConflict(state, snapshot.holds, holdIds, placed, gap);
  if (conflict !== null) return { kind: 'refused', reason: conflictRefusal(conflict[0], conflict[1]) };

  // 4. Steps, in execution order: cancels, moves and updates, creates.
  const steps: PlanStep[] = [];
  const vacators: { stepId: string; interval: Interval }[] = [];
  const pad = gap * MIN_MS;
  for (const [i, s] of staged.entries()) {
    const id = `m${i + 1}`;
    const input = stepInput(s);
    const parsed = CalendarWriteInput.safeParse(input);
    if (!parsed.success) return { kind: 'refused', reason: INVALID_STEP_REFUSAL };

    const dependsOn: string[] = [];
    const fills = s.op === 'create' ? s.change : s.op === 'move' ? s.change : null;
    if (fills?.start !== undefined && fills.end !== undefined) {
      const a = Date.parse(fills.start);
      const b = Date.parse(fills.end);
      for (const v of vacators) {
        if (a < v.interval.end + pad && v.interval.start < b + pad) dependsOn.push(v.stepId);
      }
    }
    if (s.op === 'cancel' || s.op === 'move') vacators.push({ stepId: id, interval: s.vacated });

    steps.push({
      id,
      agent: 'sched.meetings',
      intent: `meeting.${s.op}`,
      toolName: 'calendar.write',
      input,
      dependsOn,
      expectedActionClass: refineActionClass('calendar.create', input),
    });
  }

  const changes = staged.map((s) => s.change);
  const summary = renderMeetingSummary(changes, timeZone);
  const plan: Plan = {
    goal: summary.split('\n')[0] || 'שינוי פגישות',
    assumptions: [],
    clarifyingQuestion: null,
    steps,
    estimatedCostMinor: 0,
  };
  return { kind: 'plan', plan, changes, summary };
}

/**
 * Substitute a placed hold's event id into each named create step's input —
 * and nothing else: every other byte of the plan stays as built, so the slot
 * the owner is asked about is exactly the slot that was held. Each changed
 * input is re-validated with `CalendarWriteInput`. Throws on a step id the plan
 * does not have, on a step that is not a create, or on an input that no longer
 * validates: a hold id that cannot be placed is a plan that must not be offered.
 */
export function withHoldIds(plan: Plan, holdByStepId: ReadonlyMap<string, string>): Plan {
  const known = new Set(plan.steps.map((step) => step.id));
  for (const stepId of holdByStepId.keys()) {
    if (!known.has(stepId)) throw new Error(`withHoldIds: plan has no step ${stepId}`);
  }
  const steps = plan.steps.map((step) => {
    const hold = holdByStepId.get(step.id);
    if (hold === undefined) return step;
    if (step.toolName !== 'calendar.write' || step.input['operation'] !== 'create') {
      throw new Error(`withHoldIds: step ${step.id} is not a calendar create`);
    }
    const input: Record<string, unknown> = { ...step.input, holdEventId: hold };
    if (!CalendarWriteInput.safeParse(input).success) {
      throw new Error(`withHoldIds: step ${step.id} does not validate with its hold id`);
    }
    return { ...step, input };
  });
  return { ...plan, steps };
}

/** The exact `calendar.write` bytes of one change. Never carries the internal note. */
function stepInput(s: Staged): Record<string, unknown> {
  switch (s.op) {
    case 'create': {
      const c = s.change;
      return {
        operation: 'create',
        calendarId: c.calendarId,
        holdEventId: s.holdEventId,
        title: c.client.name,
        start: c.start,
        end: c.end,
        location: c.location,
        description: composeDescription(c.clientNotes, c.client.phone),
        attendees: c.client.email === null ? [] : [c.client.email],
      };
    }
    case 'move':
      return {
        operation: 'move',
        calendarId: s.change.event.calendarId,
        eventId: s.change.event.eventId,
        start: s.change.start,
        end: s.change.end,
      };
    case 'update': {
      const input: Record<string, unknown> = {
        operation: 'update',
        calendarId: s.change.event.calendarId,
        eventId: s.change.event.eventId,
      };
      if (s.change.location !== undefined) input['location'] = s.change.location;
      if (s.change.clientNotes !== undefined) {
        input['description'] = editedDescription(s.change.event.description, s.change.clientNotes);
      }
      return input;
    }
    case 'cancel':
      return { operation: 'cancel', calendarId: s.change.event.calendarId, eventId: s.change.event.eventId };
  }
}

/**
 * The first pair of busy intervals that overlap — or sit closer than the gap —
 * where at least one was placed by this plan. Keyed by calendar and event id.
 * A pre-existing overlap between two untouched events is the owner's own and
 * does not block an unrelated change.
 */
function finalConflict(
  events: CalendarEvent[],
  holds: CalendarSnapshot['holds'],
  holdIds: ReadonlySet<string>,
  placed: ReadonlySet<CalendarEvent>,
  gapMinutes: number,
): [string, string] | null {
  const pad = gapMinutes * MIN_MS;
  const items: { title: string; start: number; end: number; placed: boolean }[] = [];
  const listed = new Set<string>();
  for (const e of events) {
    listed.add(e.eventId);
    const isPlaced = placed.has(e);
    if (!isPlaced && (!e.busy || e.selfDeclined || holdIds.has(e.eventId))) continue;
    const start = Date.parse(e.start);
    const end = Date.parse(e.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    items.push({ title: clean(e.title) || '(ללא כותרת)', start, end, placed: isPlaced });
  }
  for (const h of holds) {
    if (listed.has(h.eventId) || holdIds.has(h.eventId)) continue;
    const start = Date.parse(h.start);
    const end = Date.parse(h.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    items.push({ title: clean(HOLD_TITLE_PREFIX.trim()), start, end, placed: false });
  }
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i] as (typeof items)[number];
      const b = items[j] as (typeof items)[number];
      if (!a.placed && !b.placed) continue;
      if (a.start < b.end + pad && b.start < a.end + pad) return [a.title, b.title];
    }
  }
  return null;
}

// --- Summary ------------------------------------------------------------------

function whenRange(start: string, end: string, timeZone: string): string {
  const a = Date.parse(start);
  const b = Date.parse(end);
  return `${localDayLabel(a, timeZone)}, ${hhmm(a, timeZone)}–${hhmm(b, timeZone)}`;
}

function whenPoint(start: string, timeZone: string): string {
  const a = Date.parse(start);
  return `${localDayLabel(a, timeZone)} ${hhmm(a, timeZone)}`;
}

const SUMMARY_MARGIN = '    ';
const SUMMARY_BREAKS = /\r\n|[^\P{Cc}\t]|\p{Zl}|\p{Zp}/u;

/**
 * A client-visible value, quoted, every line cleaned; a multi-line value keeps
 * its lines, each continuation indented so none starts at column 0. Empty → `(ריק)`.
 */
function quoted(v: string | null | undefined): string {
  const lines = (v ?? '').split(SUMMARY_BREAKS).map((line) => clean(line));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  while (lines.length > 0 && lines[0] === '') lines.shift();
  return lines.length === 0 ? '(ריק)' : `"${lines.join(`\n${SUMMARY_MARGIN}`)}"`;
}

function beforeAfter(label: string, before: string | null, after: string | null): string {
  return `${label}: לפני ${quoted(before)} → אחרי ${quoted(after)}`;
}

const UNVERIFIED_MARKER = ' (מהזיכרון — לא אומת)';

function changeBlock(c: PlannedChange, timeZone: string): string {
  const name = clean(c.client.name);
  switch (c.op) {
    case 'create': {
      const location = clean(c.location);
      const head = `קביעה: ${name} — ${whenRange(c.start, c.end, timeZone)}${location === '' ? '' : `, ${location}`}`;
      // Every field the client will see, word for word: the invite's description.
      const description = composeDescription(c.clientNotes, c.client.phone);
      if (description === null) return head;
      const hasPhone = c.client.phone !== null && c.client.phone.trim() !== '';
      // The phone line is always the description's last, so the marker follows the closing quote.
      const marker = hasPhone && !c.client.phoneVerified ? UNVERIFIED_MARKER : '';
      return `${head}\n${SUMMARY_MARGIN}פרטים ללקוח: ${quoted(description)}${marker}`;
    }
    case 'move':
      return `הזזה: ${name} — מ${whenPoint(c.event.start, timeZone)} ל${whenPoint(c.start ?? c.event.start, timeZone)}`;
    case 'cancel':
      return `ביטול: ${name} — ${whenRange(c.event.start, c.event.end, timeZone)}`;
    case 'update': {
      const lines = [`עריכה: ${name} — ${whenPoint(c.event.start, timeZone)}`];
      if (c.location !== undefined) lines.push(beforeAfter('מיקום', c.event.location, c.location));
      if (c.clientNotes !== undefined) {
        lines.push(beforeAfter('פרטים ללקוח', c.event.description, editedDescription(c.event.description, c.clientNotes)));
      }
      return lines.join('\n');
    }
  }
}

/** Who hears about one change: the invited client (create) or the event's attendees (any other). */
function noticeLine(c: PlannedChange): string {
  const name = clean(c.client.name);
  const noMail = `⚠️ ל${name} אין כתובת מייל — הוא לא יקבל עדכון. תצטרך לעדכן אותו בעצמך.`;
  if (c.op === 'create') {
    if (c.client.email === null) return noMail;
    const marker = c.client.emailVerified ? '' : UNVERIFIED_MARKER;
    return `תצא הזמנה אל ${clean(c.client.email)}${marker}`;
  }
  const emails = c.event.attendees.map((a) => clean(a.email)).filter((e) => e !== '');
  if (emails.length === 0) return noMail;
  const verb = c.op === 'cancel' ? 'תצא הודעת ביטול אל' : 'יצא עדכון אל';
  return `${verb} ${emails.join(', ')}`;
}

/** One block per change, then who will be notified of each (spec §9). Charter zone. */
export function renderMeetingSummary(changes: PlannedChange[], timeZone: string): string {
  const blocks = changes.map((c) => changeBlock(c, timeZone));
  const notices: string[] = [];
  for (const c of changes) {
    const line = noticeLine(c);
    if (!notices.includes(line)) notices.push(line);
  }
  return [...blocks, '', ...notices].join('\n');
}
