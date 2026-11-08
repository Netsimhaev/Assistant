/**
 * The structured form of an owner's free-text meeting instruction. The model
 * only DESCRIBES what the owner asked (`MeetingRequest`); the plan for the
 * meeting is built in code from it. Every email in it is re-checked against
 * the text the owner actually typed (`verifyTypedEmails`) by the caller.
 */
import { z } from 'zod';
import { IsoDate, TimeOfDay } from '../domain/charter.js';
import { appearsVerbatimIn } from '../governance/typed-recipients.js';

const Client = z
  .object({
    name: z.string().min(1).max(120),
    email: z.string().email().nullable(),
    phone: z.string().max(40).nullable(),
  })
  .strict();

const Window = z
  .object({
    fromDate: IsoDate,
    toDate: IsoDate,
    fromTime: TimeOfDay.nullable(),
    toTime: TimeOfDay.nullable(),
  })
  .strict();

export const MeetingOp = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('create'),
      client: Client,
      location: z.string().max(300).nullable(),
      clientNotes: z.string().max(1000).nullable(),
      internalNote: z.string().max(1000).nullable(),
      window: Window,
      durationMinutes: z.number().int().min(5).max(600).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('move'),
      clientName: z.string().min(1),
      onDate: IsoDate.nullable(),
      window: Window,
    })
    .strict(),
  z
    .object({ kind: z.literal('cancel'), clientName: z.string().min(1), onDate: IsoDate.nullable() })
    .strict(),
  z
    .object({
      kind: z.literal('edit'),
      clientName: z.string().min(1),
      onDate: IsoDate.nullable(),
      location: z.string().max(300).nullable().optional(),
      clientNotes: z.string().max(1000).nullable().optional(),
    })
    .strict(),
]);
export type MeetingOp = z.infer<typeof MeetingOp>;

export const MeetingRequest = z.object({ ops: z.array(MeetingOp).min(1).max(8) }).strict();
export type MeetingRequest = z.infer<typeof MeetingRequest>;

/** Action verbs: base, feminine/plural imperative and infinitive forms. Positive list. */
const ACTION_VERBS: ReadonlySet<string> = new Set([
  'תקבעי', 'קבעי', 'תקבע', 'קבע', 'לקבוע', 'תקבעו', 'קבעו',
  'תזיזי', 'הזיזי', 'תזיז', 'הזז', 'להזיז', 'תזיזו', 'הזיזו',
  'תבטלי', 'בטלי', 'תבטל', 'בטל', 'לבטל', 'תבטלו', 'בטלו',
  'תעדכני', 'עדכני', 'תעדכן', 'עדכן', 'לעדכן', 'תעדכנו', 'עדכנו',
  'תשני', 'תשנה', 'לשנות', 'תשנו',
]);

const MEETING_WORDS: ReadonlySet<string> = new Set(['פגישה', 'פגישות', 'פגישת', 'שיחה', 'ישיבה', 'תור', 'תורים', 'אירוע']);

const TIME_WORDS: ReadonlySet<string> = new Set([
  'היום', 'מחר', 'מחרתיים', 'אתמול', 'שעה', 'שבוע', 'חודש', 'בוקר', 'צהריים', 'ערב',
  'ראשון', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת', 'יום',
]);

const PREFIXES = 'בלמהוכש';

function tokensOf(text: string): string[] {
  return (text.match(/[\p{L}\p{N}:/]+/gu) ?? []).map((t) => t.replace(/[֑-ׇ]/g, ''));
}

function hasVerb(tokens: string[]): boolean {
  return tokens.some((t) => ACTION_VERBS.has(t) || (t.startsWith('ו') && ACTION_VERBS.has(t.slice(1))));
}

function isMeetingOrTimeWord(token: string): boolean {
  const variants = new Set<string>([token]);
  // One or two stacked Hebrew prefixes (ב, ל, מ, ה, ו...) on a word.
  if (token.length > 2 && PREFIXES.includes(token[0] as string)) variants.add(token.slice(1));
  if (token.length > 3 && PREFIXES.includes(token[0] as string) && PREFIXES.includes(token[1] as string)) {
    variants.add(token.slice(2));
  }
  for (const v of variants) {
    if (MEETING_WORDS.has(v) || TIME_WORDS.has(v)) return true;
  }
  return /^\d{1,2}:\d{2}$/.test(token) || /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(token);
}

/**
 * Deterministic gate in front of the extractor: an action verb together with
 * "meeting" or a time/date word. A schedule QUESTION carries no action verb,
 * so it never fires here (it is answered earlier by `parseScheduleQuery`).
 */
export function isMeetingInstruction(text: string): boolean {
  const tokens = tokensOf(text);
  return hasVerb(tokens) && tokens.some(isMeetingOrTimeWord);
}

/**
 * The text names a meeting outright (פגישה, תור, אירוע...), not only a time
 * word. The meeting door refuses such an instruction on a missing calendar or
 * missing settings WITHOUT paying for an extraction; one that carries only a
 * time word ("תעדכני את דני מחר") may not be a meeting at all, so it is still
 * extracted and, when it is not one, goes to the general planner as before.
 */
export function namesMeeting(text: string): boolean {
  return tokensOf(text).some((token) => {
    const variants = new Set<string>([token]);
    if (token.length > 2 && PREFIXES.includes(token[0] as string)) variants.add(token.slice(1));
    if (token.length > 3 && PREFIXES.includes(token[0] as string) && PREFIXES.includes(token[1] as string)) {
      variants.add(token.slice(2));
    }
    return [...variants].some((v) => MEETING_WORDS.has(v));
  });
}

/**
 * An email the model returned survives only if the owner typed it. A model can
 * only hallucinate or lift an address from memory/documents; the typed text is
 * the one trusted channel.
 */
export function verifyTypedEmails(req: MeetingRequest, instructionText: string): MeetingRequest {
  return {
    ops: req.ops.map((op) => {
      if (op.kind !== 'create' || op.client.email === null) return op;
      if (appearsVerbatimIn(op.client.email, instructionText)) return op;
      return { ...op, client: { ...op.client, email: null } };
    }),
  };
}
