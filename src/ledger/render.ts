/**
 * What the planner is shown of the ledger, what the owner is told was
 * understood, and the reminder texts. All pure: no DB, no model.
 */
import type { Weekday } from '../domain/charter.js';
import { LedgerFamily, type LedgerItem } from '../domain/ledger.js';
import { ledgerFamilyLabel } from '../domain/labels.js';
import type { PlanStep } from '../domain/plan.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { InstructionTextOrigin } from '../governance/typed-recipients.js';
import { counterpartyEmailIsVerified, normalisedCounterpartyEmail } from './ledger-input.js';
import { markInvisibleControls, toOneLine } from '../util/bidi.js';
import { localParts } from '../util/local-time.js';
import { formatMinor } from '../util/money.js';
import type { SlotKind } from './schedule.js';

export const LEDGER_BLOCK_MAX_ITEMS = 50;

const WEEKDAY_HE: Readonly<Record<Weekday, string>> = {
  sun: 'יום ראשון',
  mon: 'יום שני',
  tue: 'יום שלישי',
  wed: 'יום רביעי',
  thu: 'יום חמישי',
  fri: 'יום שישי',
  sat: 'שבת',
};

/** `YYYY-MM-DD` to `DD/MM/YYYY`. */
function dmy(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}
function dm(date: string): string {
  const [, m, d] = date.split('-');
  return `${d}/${m}`;
}

/** The block rendered LAST in the planner prompt, after the memory block. */
export function renderLedgerBlock(o: { now: Date; timeZone: string; items: LedgerItem[] }): string {
  const t = localParts(o.now, o.timeZone);
  const lines = [
    '# הפנקס',
    `היום: ${WEEKDAY_HE[t.weekday]} ${dmy(t.date)}, ${t.time} (${o.timeZone})`,
  ];
  for (const it of o.items.slice(0, LEDGER_BLOCK_MAX_ITEMS)) {
    let due = 'ללא מועד';
    if (it.dueAt !== null) {
      const p = localParts(it.dueAt, o.timeZone);
      due = `מועד ${it.dueIsDateOnly ? dm(p.date) : `${dm(p.date)} ${p.time}`}`;
    }
    lines.push(
      `- [${toOneLine(it.itemId)}] ${ledgerFamilyLabel[it.family]} · ${toOneLine(it.description)} · ${due} · ${
        it.importance === 'critical' ? 'קריטי' : 'רגיל'
      }`,
    );
  }
  return lines.join('\n');
}

export interface LedgerEchoOptions {
  timeZone: string;
  currency: string;
  /** The stored instruction text, to decide whether a step's address was typed. */
  instructionText: string;
  textOrigin: InstructionTextOrigin;
  /** The charter's known counterparties: an address it knows is verified, as the handler decides. */
  knownCounterparties: PolicyBundle['knownCounterparties'];
  /** Descriptions of the items the plan's `ledger.update` steps name (F-I4c). */
  itemDescriptions?: ReadonlyMap<string, string>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function dueText(input: Record<string, unknown>): string | null {
  const date = str(input['dueDate']);
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = str(input['dueTime']);
  return `מועד ${time === null ? dm(date) : `${dm(date)} ${toOneLine(time)}`}`;
}

/**
 * Null when the plan has no ledger step. Rendered from the plan BEFORE the
 * steps run, so it speaks in the future tense ("ארשום" / "אעדכן"); the door
 * validated every ledger step up front with the handlers' own rules
 * (`ledger-input.ts`), so it does not promise what a step would refuse.
 */
export function renderLedgerEcho(steps: readonly PlanStep[], o: LedgerEchoOptions): string | null {
  const lines: string[] = [];
  for (const s of steps) {
    if (s.toolName === 'ledger.add') {
      const family = LedgerFamily.safeParse(s.input['family']);
      const description = str(s.input['description']);
      const parts = [
        family.success ? ledgerFamilyLabel[family.data] : 'ללא סוג',
        description === null ? '' : toOneLine(description),
      ];
      const due = dueText(s.input);
      if (due !== null) parts.push(due);
      if (typeof s.input['amountMinor'] === 'number') parts.push(formatMinor(s.input['amountMinor'], o.currency));
      if (s.input['critical'] === true) parts.push('קריטי');
      let line = `ארשום: ${parts.filter((p) => p !== '').join(' · ')}`;
      const email = normalisedCounterpartyEmail(str(s.input['counterpartyEmail']) ?? undefined);
      if (
        email !== null &&
        !counterpartyEmailIsVerified(email, { text: o.instructionText, textOrigin: o.textOrigin }, o.knownCounterparties)
      ) {
        line += ' (כתובת לא מאומתת — לא אפנה אליה לפני שתאשר)';
      }
      lines.push(line);
      const proposed = s.input['proposedStages'];
      if (Array.isArray(proposed) && proposed.length > 0) {
        const titles = proposed.filter((x): x is string => typeof x === 'string').map(toOneLine);
        lines.push(
          `הצעה לשלבים: ${titles.map((t, i) => `${i + 1}. ${t}`).join(' ')} — לשמירה: בדשבורד, או 'שמרי שלבים' בהודעת הפנקס הבאה`,
        );
      }
    } else if (s.toolName === 'ledger.update') {
      const itemId = str(s.input['itemId']) ?? '';
      const current = o.itemDescriptions?.get(itemId);
      const parts = [
        current === undefined ? `[${toOneLine(itemId)}]` : `'${toOneLine(current)}' [${toOneLine(itemId)}]`,
      ];
      const description = str(s.input['description']);
      if (description !== null) parts.push(toOneLine(description));
      const due = dueText(s.input);
      if (due !== null) parts.push(due);
      if (typeof s.input['amountMinor'] === 'number') parts.push(formatMinor(s.input['amountMinor'], o.currency));
      if (s.input['critical'] === true) parts.push('קריטי');
      if (s.input['critical'] === false) parts.push('רגיל');
      if (Array.isArray(s.input['stagesDone']) && s.input['stagesDone'].length > 0) {
        parts.push(`שלבים שבוצעו: ${s.input['stagesDone'].filter((n): n is number => typeof n === 'number').join(', ')}`);
      }
      const note = str(s.input['note']);
      if (note !== null) parts.push(toOneLine(note));
      lines.push(`אעדכן: ${parts.join(' · ')}`);
    }
  }
  return lines.length === 0 ? null : lines.join('\n');
}

// ---------------------------------------------------------------- reminders

/**
 * The owner-facing text of one reminder. Pure and deterministic: no model,
 * no DB. Every value that came from the item (and therefore possibly from an
 * instruction or a stranger's mail) goes through `toOneLine`, which strips
 * bidi controls and folds line breaks, so a description cannot forge a line —
 * least of all a `מזהה תזכורת:` line — of its own. The only multi-line value
 * is an unsent draft (Task 10's fallback), which keeps its lines because it
 * is a message body: every line break a renderer may honour is normalised to
 * `\n` and invisible controls are marked (`⟦U+…⟧`), not removed.
 *
 * `now` is required (`pace` needs it): this module never reads the clock.
 */
export interface ReminderRenderOptions {
  timeZone: string;
  currency: string;
  now: Date;
  /** An unsent nudge draft to show the owner (Task 10 fallback). */
  draft?: string;
  /** Why the draft was not sent; shown in parentheses. */
  draftReason?: string;
}

const REMINDER_SUBJECT: Readonly<Record<SlotKind, string>> = Object.freeze({
  before: 'תזכורת',
  due: 'תזכורת',
  overdue: 'עבר המועד',
  held_check: 'האם הפגישה התקיימה',
  checkin: 'מעקב עבודה',
  pace: 'קצב עבודה',
  nudge: 'לחזור',
});

/**
 * The one positive set of line breaks, the same as the command echo's
 * (`orchestrator/command-echo.ts`): CRLF, CR, LF, VT, FF, FS/GS/RS, NEL, LS, PS.
 * Many renderers break on all of them, so splitting on `\n` alone would let a
 * U+2028 or a lone CR open a line that is not indented.
 */
const LINE_BREAKS = /\r\n|[\r\n\u000B\u000C\u001C\u001D\u001E\u0085\u2028\u2029]/g;

/** Fixed, visible (non-whitespace) margin on every continuation line of a batch entry. */
const CONTINUATION_GUTTER = '    │ ';

/** Multi-line text as lines: every break normalised, invisible controls marked, not removed. */
function textLines(text: string): string[] {
  return text.split(LINE_BREAKS).map(markInvisibleControls);
}

/**
 * The head of the draft section of a fallback reminder. The dashboard finds
 * an unsent draft by it (the lines after the head line are the draft).
 */
export const UNSENT_DRAFT_MARK = 'הכנתי טיוטה, אבל לא שלחתי';

const CRITICAL_BODY_PREFIX = '⚠️ קריטי — ';
const CRITICAL_SUBJECT_PREFIX = '⚠️ ';

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / (24 * 60 * 60 * 1000);
}

function dueLabel(item: LedgerItem, timeZone: string): string {
  if (item.dueAt === null) return 'ללא מועד';
  const p = localParts(item.dueAt, timeZone);
  return item.dueIsDateOnly ? dm(p.date) : `${dm(p.date)} ${p.time}`;
}

function nonEmptyOneLine(v: string | null): string | null {
  if (v === null) return null;
  const s = toOneLine(v);
  return s === '' ? null : s;
}

export function renderReminder(
  item: LedgerItem,
  kind: SlotKind,
  o: ReminderRenderOptions,
): { subject: string; body: string } {
  const desc = toOneLine(item.description);
  const family = ledgerFamilyLabel[item.family];
  const amount = item.amountMinor === null ? '' : ` · ${formatMinor(item.amountMinor, o.currency)}`;
  let text: string;
  switch (kind) {
    case 'before':
    case 'due':
      text = `תזכורת: ${desc} — ${family} · ${dueLabel(item, o.timeZone)}${amount}`;
      break;
    case 'overdue':
      text = `עבר המועד: ${desc} — ${family} · ${dueLabel(item, o.timeZone)}${amount}`;
      break;
    case 'held_check':
      text =
        item.dueAt === null
          ? `הפגישה ${desc} — התקיימה?`
          : `הפגישה ${desc} ב-${localParts(item.dueAt, o.timeZone).time} — התקיימה?`;
      break;
    case 'checkin': {
      const done = item.stages.filter((s) => s.done).map((s) => toOneLine(s.title));
      const missing = item.stages.filter((s) => !s.done).map((s) => toOneLine(s.title));
      const parts: string[] = [];
      if (done.length > 0) parts.push(`הושלם: ${done.join(', ')}`);
      if (missing.length > 0) parts.push(`חסר: ${missing.join(', ')}`, `נעצרת ב: ${missing[0] ?? ''}`);
      text = parts.length === 0 ? `איפה עומד ${desc}?` : `איפה עומד ${desc}? ${parts.join(' · ')}`;
      break;
    }
    case 'pace': {
      const total = item.stages.length;
      const doneCount = item.stages.filter((s) => s.done).length;
      if (item.dueAt === null) {
        text = `${desc}: הושלמו ${doneCount} מתוך ${total} שלבים`;
      } else {
        const today = localParts(o.now, o.timeZone).date;
        const target = localParts(item.dueAt, o.timeZone).date;
        const left = Math.max(0, dayNumber(target) - dayNumber(today));
        text = `${desc}: נשארו ${left} ימים לתאריך היעד, הושלמו ${doneCount} מתוך ${total} שלבים`;
      }
      break;
    }
    case 'nudge':
      text = `הגיע הזמן לחזור ל${nonEmptyOneLine(item.counterpartyName) ?? desc}`;
      break;
  }

  const critical = item.importance === 'critical';
  let body = critical ? `${CRITICAL_BODY_PREFIX}${text}` : text;
  if (o.draft !== undefined) {
    const reason = nonEmptyOneLine(o.draftReason ?? null);
    const head = reason === null ? `${UNSENT_DRAFT_MARK}:` : `${UNSENT_DRAFT_MARK} (${reason}):`;
    body += `\n\n${head}\n${textLines(o.draft).join('\n')}`;
  }
  const subject = `${critical ? CRITICAL_SUBJECT_PREFIX : ''}${REMINDER_SUBJECT[kind]}: ${desc}`;
  return { subject, body };
}

/** The facts an evidence notice is told from. Sender and subject are a stranger's. */
export interface EvidenceNoticeFacts {
  description: string;
  from: string;
  subject: string;
}

/**
 * The owner's notice that an item was closed by a mail. Every value goes
 * through `toOneLine`: the sender and subject are attacker-controlled.
 *
 * On WhatsApp the notice is an entry of the pass's ONE numbered batch (spec
 * I5), so it names its real number `n` in that batch; by email there is no
 * number to answer and it points at the dashboard.
 */
export function renderEvidenceNotice(f: EvidenceNoticeFacts, channel: 'email' | 'whatsapp', n?: number): string {
  const how = channel === 'whatsapp' ? `השיבי '${n ?? 1} פתחי'` : 'אפשר לפתוח מחדש בדשבורד';
  return `סגרתי '${toOneLine(f.description)}' — הגיע מייל מ-${toOneLine(f.from)}: ${toOneLine(f.subject)}. אם זה לא נכון, ${how}.`;
}

/** The last line of every ledger WhatsApp batch: the commands it answers to. */
export const LEDGER_BATCH_FOOTER =
  'השיבי במספר ומילה: בוצע · בטלי · דחי מחר · דחי ל-DD/MM · פתחי · התקיימה · לא התקיימה · שמרי שלבים · אשרי כתובת';

/**
 * One numbered WhatsApp message. `n` is 1-based and matches the batch row's
 * `items[n-1]`.
 *
 * An entry can carry model or stranger text (Task 10's draft, Task 9's
 * evidence notice). It is split on EVERY line break a renderer may honour
 * (`LINE_BREAKS`, not just `\n`), each line has its invisible controls marked,
 * and every continuation line starts with the fixed, visible gutter `    │ `
 * (the command echo's margin). So no line but a real entry's first line can
 * read as a numbered entry, and no entry can forge the footer.
 */
export function renderWhatsAppBatch(entries: { n: number; text: string }[]): string {
  const lines = ['תזכורות מהפנקס:'];
  for (const e of entries) {
    const [first = '', ...rest] = textLines(e.text);
    lines.push('', `${e.n}. ${first}`, ...rest.map((l) => `${CONTINUATION_GUTTER}${l}`));
  }
  lines.push('', LEDGER_BATCH_FOOTER);
  return lines.join('\n');
}
