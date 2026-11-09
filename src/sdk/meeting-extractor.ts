/**
 * Turns the owner's free-text meeting instruction into a `MeetingRequest`.
 * The model only describes; it has no tools, and the plan is built in code.
 * The owner's text is the trusted channel and is not fenced. The CALLER
 * applies `verifyTypedEmails` to a successful result.
 */
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { MeetingRequest } from '../meetings/request.js';
import { linkedAbortController } from '../util/abort.js';
import { extractJsonObjects } from '../util/json-extract.js';

export const MEETING_EXTRACTOR_MODEL = 'sonnet';

export type ExtractorOutcome =
  | { status: 'extracted'; request: MeetingRequest }
  | { status: 'not_meeting' }
  | { status: 'failed'; reason: string };

export type MeetingExtractor = (i: {
  text: string;
  today: string;
  timeZone: string;
  signal: AbortSignal;
}) => Promise<ExtractorOutcome>;

const SHAPE = `{"ops":[
  {"kind":"create","client":{"name":string,"email":string|null,"phone":string|null},"location":string|null,"clientNotes":string|null,"internalNote":string|null,"window":{"fromDate":"YYYY-MM-DD","toDate":"YYYY-MM-DD","fromTime":"HH:MM"|null,"toTime":"HH:MM"|null},"durationMinutes":integer|null},
  {"kind":"move","clientName":string,"onDate":"YYYY-MM-DD"|null,"window":{"fromDate":"YYYY-MM-DD","toDate":"YYYY-MM-DD","fromTime":"HH:MM"|null,"toTime":"HH:MM"|null}},
  {"kind":"cancel","clientName":string,"onDate":"YYYY-MM-DD"|null},
  {"kind":"edit","clientName":string,"onDate":"YYYY-MM-DD"|null,"location":string|null,"clientNotes":string|null}
]}`;

const WEEKDAYS: ReadonlyArray<{ he: string; en: string }> = [
  { he: 'ראשון', en: 'Sunday' },
  { he: 'שני', en: 'Monday' },
  { he: 'שלישי', en: 'Tuesday' },
  { he: 'רביעי', en: 'Wednesday' },
  { he: 'חמישי', en: 'Thursday' },
  { he: 'שישי', en: 'Friday' },
  { he: 'שבת', en: 'Saturday' },
];

/**
 * The weekday of a local `YYYY-MM-DD` date. Computed in code because a model
 * given a bare date gets the weekday wrong often enough that "ביום שלישי"
 * would keep landing on the wrong day. A date-only string has no zone, so the
 * UTC weekday of its midnight is its weekday everywhere. `null` when unreadable.
 */
export function weekdayOf(date: string): { he: string; en: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return WEEKDAYS[new Date(ms).getUTCDay()] ?? null;
}

export function buildExtractorSystemPrompt(today: string, timeZone: string): string {
  const weekday = weekdayOf(today);
  const todayLine =
    weekday === null
      ? `Today's local date is ${today}.`
      : `Today's local date is ${today}, which is ${weekday.en} (יום ${weekday.he}).`;
  return [
    "You turn a business owner's free-text instruction (usually Hebrew) about meetings into one JSON object. You have no tools and you only describe the request; you never act.",
    `${todayLine} The time zone is ${timeZone}. The week starts on Sunday (יום ראשון) and ends on Saturday (שבת). Resolve relative words (היום, מחר, מחרתיים, "ביום שלישי", "בשבוע הבא") to concrete dates using today and its weekday.`,
    `Reply with exactly this JSON shape and nothing else (up to 8 ops):\n${SHAPE}`,
    'Rules:',
    '- Dates are YYYY-MM-DD. Times are HH:MM in 24-hour form.',
    '- For create and move, "window" is the range the owner allowed for the meeting. A single day means fromDate = toDate. Put times in fromTime/toTime only if the owner stated them (an exact time: fromTime = that time, toTime = null).',
    '- "onDate" is the date the existing meeting is currently on, if the owner said it.',
    '- Any field the owner did not state is null. Never guess.',
    '- NEVER invent an email address or phone number that is not written in the text.',
    '- Respond with one JSON object only, no prose, no code fences.',
    '- If the text is not about creating, moving, cancelling or editing a meeting, respond with exactly {"notMeeting": true}.',
  ].join('\n');
}

export function buildExtractorCall(
  text: string,
  today: string,
  timeZone: string,
): { prompt: string; options: Options } {
  return {
    prompt: text,
    options: {
      systemPrompt: buildExtractorSystemPrompt(today, timeZone),
      tools: [],
      model: MEETING_EXTRACTOR_MODEL,
      settingSources: [],
      env: process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] },
      permissionMode: 'default',
      maxTurns: 1,
    },
  };
}

/** Pure: model text -> outcome. A parse failure is `failed`, never a guess. */
export function parseExtractorReply(text: string): ExtractorOutcome {
  const candidates = extractJsonObjects(text);
  if (candidates.length === 0) return { status: 'failed', reason: 'no JSON object in reply' };
  let notMeeting = false;
  let firstProblem = 'reply did not match the meeting request shape';
  for (const candidate of candidates) {
    const parsed = MeetingRequest.safeParse(candidate);
    if (parsed.success) return { status: 'extracted', request: parsed.data };
    const rec = candidate as Record<string, unknown> | null;
    if (rec !== null && typeof rec === 'object' && rec['notMeeting'] === true) notMeeting = true;
    else firstProblem = parsed.error.issues[0]?.message ?? firstProblem;
  }
  return notMeeting ? { status: 'not_meeting' } : { status: 'failed', reason: firstProblem };
}

function refuseUnderTest(): void {
  if (!config.isTest) return;
  throw new Error(
    'runMeetingExtractor: refusing to run under NODE_ENV=test — this is a live, billed call to the Agent SDK. Inject a MeetingExtractor stub instead.',
  );
}

export const runMeetingExtractor: MeetingExtractor = async ({ text, today, timeZone, signal }) => {
  refuseUnderTest();
  const { prompt, options } = buildExtractorCall(text, today, timeZone);
  const abortController = linkedAbortController(signal);
  let raw = '';
  let failure: string | null = null;
  for await (const message of query({ prompt, options: { ...options, abortController } })) {
    if (message.type !== 'result') continue;
    if (message.subtype === 'success') raw = message.result;
    else failure = `model call ended with ${message.subtype}`;
  }
  if (raw === '' && failure !== null) return { status: 'failed', reason: failure };
  return parseExtractorReply(raw);
};
