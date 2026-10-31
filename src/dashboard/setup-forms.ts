/**
 * The setup interview's form bodies → interview sections (spec §5).
 *
 * Two stages, kept apart on purpose:
 *   1. `candidateFromForm` turns the posted fields into the section's SHAPE
 *      without judging it — a number that does not parse stays the string the
 *      owner typed, a counterparty row with a label and nothing else stays a
 *      row. That candidate is what the step re-renders with when validation
 *      fails, so the owner sees exactly what they typed next to the error.
 *   2. `validateSection` runs the section's own schema (the one `saveSection`
 *      backstops with) plus the few requirements the schema leaves to the
 *      form — fields the charter needs non-empty — and returns issues with a
 *      PATH and a HEBREW message.
 *
 * **Every message the owner reads is Hebrew, and a custom message is shown
 * as written.** Refinements the interview owns (the counterparty "domain or
 * phone", the phone shape, the time zone) and the charter's own
 * `emailDomainProblem` carry their message verbatim — the spec requires the
 * domain check to say exactly what the charter would. A zod built-in issue
 * ("expected number", a regex miss) carries English internals, so it is
 * replaced by a fixed Hebrew line naming the field.
 *
 * Nothing here trusts the form for anything server-side: step 5's provider is
 * pinned by the route when the base charter already has a mailbox, and step
 * 10's rules never come from the form at all.
 */
import { ActionClass } from '../domain/action.js';
import { Weekday } from '../domain/charter.js';
import {
  INTERVIEW_SECTIONS,
  InterviewAnswers,
  type InterviewAnswersDraft,
} from '../charter/interview/answers.js';
import { ALONE_ALLOWED, INTERVIEW_ROWS, MONEY_ROWS, ROW_DEFAULTS } from '../charter/interview/rows.js';

export type SectionName = keyof InterviewAnswers;

export interface SetupIssue {
  path: readonly (string | number)[];
  message: string;
}

/** Blank rows offered on a repeating list (key facts, counterparties), beyond what is saved. */
export const BLANK_ROWS = 3;
/** Hard cap on rows read from one repeating list — a form is not a bulk import. */
export const MAX_LIST_ROWS = 50;

/** Hebrew names of the fields, by the last string segment of an issue path. */
const FIELD_HE: Readonly<Record<string, string>> = {
  description: 'תיאור העסק',
  legalName: 'השם הרשמי',
  tradeName: 'השם שהלקוחות מכירים',
  vertical: 'התחום',
  employees: 'מספר העובדים',
  expectations: 'מה מצופה ממני',
  notDone: 'דברים שהעסק לא עושה',
  keyFacts: 'שאלות חוזרות',
  q: 'השאלה',
  a: 'התשובה',
  displayName: 'השם שלך',
  role: 'התפקיד',
  whatsapp: 'מספר הוואטסאפ',
  email: 'כתובת המייל',
  register: 'סגנון הדיבור',
  signOff: 'החתימה',
  emojiPolicy: 'אימוג׳ים',
  mustNeverSay: 'מילים אסורות',
  workweek: 'ימי העבודה',
  open: 'שעת הפתיחה',
  close: 'שעת הסגירה',
  quietHours: 'שעות השקט',
  from: 'תחילת שעות השקט',
  to: 'סוף שעות השקט',
  timezone: 'אזור הזמן',
  mailbox: 'תיבת המייל',
  documents: 'קריאת מסמכים',
  singleMinor: 'הסכום לפעולה אחת',
  dailyMinor: 'הסכום ליום',
  monthlyMinor: 'הסכום לחודש',
  maxDiscountPercent: 'ההנחה המקסימלית',
  label: 'השם',
  emailDomain: 'הדומיין',
  phone: 'הטלפון',
  mode: 'רמת החופש',
};

function fieldName(path: readonly PropertyKey[]): string {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const seg = path[i];
    if (typeof seg === 'string' && Object.hasOwn(FIELD_HE, seg)) return FIELD_HE[seg] ?? seg;
  }
  return 'אחד השדות';
}

/** A message the interview or the charter wrote for the owner — shown as written. */
function isOwnerMessage(issue: { code: string }): boolean {
  return issue.code === 'custom';
}

function toPath(path: readonly PropertyKey[]): (string | number)[] {
  return path.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number');
}

// --- reading the form --------------------------------------------------------

/**
 * One text field, trimmed. Stored as the owner typed it — direction controls
 * included; every screen that shows it back renders it through `escLabel`.
 */
function text(form: URLSearchParams, name: string): string {
  return (form.get(name) ?? '').trim();
}

/** One-per-line list; blank lines dropped. */
function lines(form: URLSearchParams, name: string): string[] {
  return text(form, name)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_LIST_ROWS);
}

function intOrRaw(raw: string): number | string {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : raw;
}

/** Whole shekels or shekels with agorot ("1500" / "1500.50") → minor units; anything else stays raw. */
export function shekelsToMinor(raw: string): number | string {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(raw.replace(/,/g, ''));
  if (m === null) return raw;
  const agorot = (m[2] ?? '').padEnd(2, '0');
  return Number(m[1]) * 100 + Number(agorot);
}

export function minorToShekels(minor: number): string {
  const whole = Math.floor(minor / 100);
  const rest = minor % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0')}`;
}

function indexedRows(form: URLSearchParams, prefix: string, fields: readonly string[]): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (let i = 0; i < MAX_LIST_ROWS; i += 1) {
    const row = Object.fromEntries(fields.map((f) => [f, text(form, `${prefix}${i}_${f}`)]));
    if (fields.every((f) => form.get(`${prefix}${i}_${f}`) === null)) continue;
    if (fields.every((f) => row[f] === '')) continue;
    out.push(row);
  }
  return out;
}

function counterpartyRows(form: URLSearchParams, prefix: string): Record<string, string>[] {
  return indexedRows(form, prefix, ['label', 'emailDomain', 'phone']).map((r) => ({
    label: r['label'] ?? '',
    ...(r['emailDomain'] !== '' ? { emailDomain: r['emailDomain'] ?? '' } : {}),
    ...(r['phone'] !== '' ? { phone: r['phone'] ?? '' } : {}),
  }));
}

/** The levels the action table would hold: saved answers over the row defaults. */
export function effectiveLevels(draft: InterviewAnswersDraft): Record<string, string> {
  return { ...ROW_DEFAULTS, ...(draft.actions ?? {}) };
}

/** Step 7 is skipped when every money row is "never" (spec §5 step 7). */
export function moneyUntouched(draft: InterviewAnswersDraft): boolean {
  const levels = effectiveLevels(draft);
  return [...MONEY_ROWS].every((row) => levels[row] === 'never');
}

export const ZERO_MONEY = { singleMinor: 0, dailyMinor: 0, monthlyMinor: 0, maxDiscountPercent: 0 } as const;

/**
 * The posted fields → the section's shape, unjudged. `draft` is the saved
 * draft, for the two sections whose candidate depends on it (step 7's skip;
 * step 10's rules, which come from the server, never the form).
 */
export function candidateFromForm(
  section: SectionName,
  form: URLSearchParams,
  draft: InterviewAnswersDraft,
): unknown {
  switch (section) {
    case 'business':
      return {
        description: text(form, 'description'),
        legalName: text(form, 'legalName'),
        tradeName: text(form, 'tradeName'),
        vertical: text(form, 'vertical'),
        employees: intOrRaw(text(form, 'employees')),
        expectations: text(form, 'expectations'),
        notDone: lines(form, 'notDone'),
        keyFacts: indexedRows(form, 'kf', ['q', 'a']).map((r) => ({ q: r['q'] ?? '', a: r['a'] ?? '' })),
      };
    case 'principal': {
      const whatsapp = text(form, 'whatsapp');
      const email = text(form, 'email');
      return {
        displayName: text(form, 'displayName'),
        role: text(form, 'role'),
        whatsapp: whatsapp === '' ? null : whatsapp,
        email: email === '' ? null : email,
      };
    }
    case 'voice':
      return {
        register: text(form, 'register'),
        signOff: text(form, 'signOff'),
        emojiPolicy: text(form, 'emojiPolicy'),
        mustNeverSay: lines(form, 'mustNeverSay'),
      };
    case 'hours': {
      const from = text(form, 'quietFrom');
      const to = text(form, 'quietTo');
      return {
        workweek: Weekday.options.filter((d) => form.getAll('workweek').includes(d)),
        open: text(form, 'open'),
        close: text(form, 'close'),
        quietHours: from === '' && to === '' ? null : { from, to },
        timezone: text(form, 'timezone'),
      };
    }
    case 'reading':
      return {
        mailbox: text(form, 'mailbox'),
        documents: text(form, 'documents') === 'yes',
      };
    case 'actions':
      return Object.fromEntries(
        INTERVIEW_ROWS.flatMap((row) => {
          const v = text(form, `row:${row}`);
          return v === '' ? [] : [[row, v]];
        }),
      );
    case 'money':
      if (moneyUntouched(draft)) return { ...ZERO_MONEY };
      return {
        singleMinor: shekelsToMinor(text(form, 'single')),
        dailyMinor: shekelsToMinor(text(form, 'daily')),
        monthlyMinor: shekelsToMinor(text(form, 'monthly')),
        maxDiscountPercent: /^\d{1,3}(\.\d+)?$/.test(text(form, 'discount'))
          ? Number(text(form, 'discount'))
          : text(form, 'discount'),
      };
    case 'counterparties':
      return { known: counterpartyRows(form, 'known'), doNotContact: counterpartyRows(form, 'dnc') };
    case 'autonomy':
      return { mode: text(form, 'mode') };
    case 'extra':
      return draft.extra ?? { accepted: [], pending: [] };
  }
}

// --- validating --------------------------------------------------------------

const REQUIRED: Partial<Record<SectionName, readonly string[]>> = {
  business: ['description', 'legalName', 'tradeName', 'vertical'],
  principal: ['displayName', 'role'],
};

function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** What the schema leaves to the form: fields the charter needs non-empty, and rules about the table. */
function formIssues(section: SectionName, candidate: unknown): SetupIssue[] {
  const c = obj(candidate);
  const out: SetupIssue[] = [];
  for (const field of REQUIRED[section] ?? []) {
    if (c[field] === '') out.push({ path: [field], message: `${fieldName([field])}: יש למלא את השדה.` });
  }
  if (section === 'business' && Array.isArray(c['keyFacts'])) {
    c['keyFacts'].forEach((raw, i) => {
      const f = obj(raw);
      if (f['q'] === '' || f['a'] === '') {
        out.push({ path: ['keyFacts', i], message: 'יש למלא גם את השאלה וגם את התשובה (או להשאיר את שתיהן ריקות).' });
      }
    });
  }
  if (section === 'hours') {
    const q = c['quietHours'];
    if (q !== null && (obj(q)['from'] === '' || obj(q)['to'] === '')) {
      out.push({ path: ['quietHours'], message: 'שעות השקט: יש למלא גם התחלה וגם סוף, או להשאיר את שתיהן ריקות.' });
    }
  }
  if (section === 'actions') {
    for (const [row, level] of Object.entries(c)) {
      const cls = ActionClass.safeParse(row);
      if (level === 'alone' && (!cls.success || !(ALONE_ALLOWED as ReadonlySet<string>).has(cls.data))) {
        out.push({ path: [row], message: `„לבד” אינו אפשרי בשורה הזו — לעולם לא לבד, זה גבול של המערכת.` });
      }
    }
  }
  if (section === 'extra' && Array.isArray(obj(c)['pending']) && (obj(c)['pending'] as unknown[]).length > 0) {
    out.push({ path: ['pending'], message: 'יש הצעות שעדיין לא החלטת עליהן — יש לבחור לכל אחת לפני שממשיכים.' });
  }
  return out;
}

/** Issues of one section, Hebrew, with paths. Empty when the candidate may be saved. */
export function validateSection(section: SectionName, candidate: unknown): SetupIssue[] {
  const issues = formIssues(section, candidate);
  const parsed = InterviewAnswers.shape[section].safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = toPath(issue.path);
      // A required field already reported once by the form's own check.
      if (issues.some((i) => i.path.join('.') === path.join('.'))) continue;
      issues.push({
        path,
        message: isOwnerMessage(issue) ? issue.message : `${fieldName(issue.path)}: הערך חסר או אינו תקין.`,
      });
    }
  }
  return issues;
}

/** The first step whose section is not saved; `null` when all ten are. */
export function firstUnsavedStep(draft: InterviewAnswersDraft | null): number | null {
  const index = INTERVIEW_SECTIONS.findIndex((s) => draft?.[s] === undefined);
  return index === -1 ? null : index + 1;
}

/** Word count of an open answer, for step 1's fixed follow-ups. */
export function wordCount(value: string): number {
  return value.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Below this many words an open answer earns a follow-up line (spec §5 step 1). */
export const FOLLOW_UP_UNDER_WORDS = 8;

/**
 * The fixed follow-ups of step 1 — written here, never by a model (spec §8.4).
 * [0] under the business description, [1] under "what do you expect of me",
 * [2] at the top of the step when the owner is sent back to expand.
 */
export const FOLLOW_UPS = [
  'תוכל לתת דוגמה ליום רגיל בעסק — מי פונה אליכם ומה הוא בדרך כלל מבקש?',
  'תוכל לתת דוגמה לדבר אחד שהיית שמח שלא תצטרך לעשות בעצמך השבוע?',
  'כמה משפטים נוספים יעזרו לי לענות ללקוחות שלך כמו שאתה היית עונה. אפשר להוסיף, או להמשיך כמו שזה.',
] as const;

/** Step 1 asks once for more when an open answer is short; the second submit goes through. */
export function needsFollowUp(candidate: unknown): boolean {
  const c = obj(candidate);
  return ['description', 'expectations'].some((f) => {
    const v = c[f];
    return typeof v === 'string' && wordCount(v) < FOLLOW_UP_UNDER_WORDS;
  });
}
