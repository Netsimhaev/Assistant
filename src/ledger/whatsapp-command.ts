/**
 * Owner commands on ledger items — "2 בוצע", "3 דחי מחר", "1 פתחי".
 *
 * Three parts, and the split is the point:
 *
 * - **`readLedgerCommand` is a pure reader of fixed words, never a model.**
 *   An optional leading number (`/^[1-9]\d*$/`) and one command phrase, after
 *   the same normalisation `command-confirm.ts` uses (bidi stripped, trimmed,
 *   trailing punctuation dropped). Anything else is `null`.
 *
 * - **`applyLedgerCommand` is the ONE applier**, shared by the WhatsApp door
 *   and the dashboard buttons. Every status change is conditional
 *   (`moveLedgerStatus`, or an `UPDATE ... WHERE status = ANY(...)` here), and
 *   a move that finds the row already moved is `'lost_race'` — never an error
 *   and never applied twice.
 *
 * - **`handleLedgerWhatsApp` resolves the number against the numbered batch
 *   the owner actually received**: the latest `ledger_whatsapp_batches` row
 *   with `sent_at` set and strictly before the provider's timestamp on the
 *   inbound message — the comparison `openConfirmations` makes for
 *   `delivered_at`. A batch whose send failed (`sent_at` NULL) was never seen
 *   and cannot be addressed. The message is claimed before anything applies,
 *   so a redelivered copy applies once.
 *
 * **Disjointness from every other WhatsApp answer, and the three phrases that
 * break it.** The spec's words include `בטלי` (a member of `CANCEL_WORDS`),
 * `לא התקיימה` (first token `לא`, which `readConfirmation` reads as a cancel
 * whatever follows) and `אשרי כתובת` (first token `אשרי`, a confirm word).
 * The door reads NUMBERED ledger commands before the confirmation reader and
 * bare ones after it (ruling R5 as amended), and a bare `בטלי` read as a
 * ledger command anywhere would compete with the owner's "cancel" for an open
 * boss-command question. Those three phrases
 * are therefore commands ONLY with a leading number (`LEDGER_NUMBER_REQUIRED_WORDS`):
 * bare, they read `null` and go on to the confirmation reader exactly as
 * before. `2 בטלי` is never a valid confirmation answer (a number plus words
 * reads `unclear` there), so the numbered form takes nothing from it. The
 * batch footer (`render.ts`) already tells the owner "השיבי במספר ומילה".
 * Cost: on a one-item batch the owner types "1 בטלי", not "בטלי".
 */
import { monotonicFactory } from 'ulid';
import { transaction, type BusinessDb } from '../db/pool.js';
import { ledgerStatusLabel } from '../domain/labels.js';
import type { LedgerItem, LedgerStatus } from '../domain/ledger.js';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import { localParts, localToInstant } from '../util/local-time.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { claimMessage, settleMessage } from '../whatsapp/store.js';
import { loadLedgerSettings } from './settings.js';
import { loadLedgerItem, moveLedgerStatus } from './store.js';

const ulid = monotonicFactory();

type SimpleKind = 'done' | 'cancel' | 'reopen' | 'held' | 'not_held' | 'save_stages' | 'confirm_address';

export type LedgerCommand =
  | { kind: SimpleKind; n: number | null }
  | { kind: 'snooze'; n: number | null; to: 'tomorrow' | { date: string } };

const SIMPLE_PHRASES: Readonly<Record<string, SimpleKind>> = Object.freeze({
  בוצע: 'done',
  בטלי: 'cancel',
  פתחי: 'reopen',
  התקיימה: 'held',
  'לא התקיימה': 'not_held',
  'שמרי שלבים': 'save_stages',
  'אשרי כתובת': 'confirm_address',
});

/** Every command phrase (the snooze verb counted once as `דחי`). */
export const LEDGER_COMMAND_WORDS: readonly string[] = [
  'בוצע',
  'בטלי',
  'דחי',
  'פתחי',
  'התקיימה',
  'לא התקיימה',
  'שמרי שלבים',
  'אשרי כתובת',
];

/**
 * Phrases whose first token answers something else on WhatsApp (a cancel or
 * a confirm word) — commands only with a leading number. See the module
 * docblock; the test derives the colliding set from the exported foreign
 * lists and requires it to equal this one.
 */
export const LEDGER_NUMBER_REQUIRED_WORDS: readonly string[] = ['בטלי', 'לא התקיימה', 'אשרי כתובת'];

/** Phrases that are commands with or without a number. */
export const LEDGER_BARE_WORDS: readonly string[] = LEDGER_COMMAND_WORDS.filter(
  (w) => !LEDGER_NUMBER_REQUIRED_WORDS.includes(w),
);

/** As `command-confirm.ts`'s `normaliseToken`: trailing punctuation off, Latin case-folded. */
function normaliseToken(token: string): string {
  return token.replace(/[)'"»,.;:!?…]+$/, '').toLocaleLowerCase();
}

function tokensOf(text: string): string[] {
  return stripBidiControls(text)
    .trim()
    .split(/\s+/)
    .map(normaliseToken)
    .filter((t) => t !== '');
}

function isRealDate(y: number, m: number, d: number): boolean {
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function isoDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The next DD/MM on or after today in `timeZone`; `null` when the day never exists. */
function nextOccurrence(day: number, month: number, o: { now: Date; timeZone: string }): string | null {
  const today = localParts(o.now, o.timeZone).date;
  const thisYear = Number(today.slice(0, 4));
  // Eight years covers 29/02 across any century gap that matters here.
  for (let y = thisYear; y <= thisYear + 8; y += 1) {
    if (!isRealDate(y, month, day)) continue;
    const candidate = isoDate(y, month, day);
    if (candidate >= today) return candidate;
  }
  return null;
}

const SNOOZE_DATE = /^ל-?(\d{1,2})\/(\d{1,2})$/;

export function readLedgerCommand(text: string, o: { now: Date; timeZone: string }): LedgerCommand | null {
  const tokens = tokensOf(text);
  let n: number | null = null;
  const first = tokens[0];
  if (first !== undefined && /^\d+$/.test(first)) {
    if (!/^[1-9]\d*$/.test(first)) return null;
    n = Number(first);
    if (!Number.isSafeInteger(n)) return null;
    tokens.shift();
  }
  if (tokens.length === 0) return null;
  const phrase = tokens.join(' ');

  if (tokens[0] === 'דחי') {
    if (tokens.length !== 2) return null;
    const arg = tokens[1] ?? '';
    if (arg === 'מחר') return { kind: 'snooze', n, to: 'tomorrow' };
    const m = SNOOZE_DATE.exec(arg);
    if (m === null) return null;
    const day = Number(m[1]);
    const month = Number(m[2]);
    const date = nextOccurrence(day, month, o);
    return date === null ? null : { kind: 'snooze', n, to: { date } };
  }

  if (!Object.hasOwn(SIMPLE_PHRASES, phrase)) return null;
  const kind = SIMPLE_PHRASES[phrase];
  if (kind === undefined) return null;
  if (n === null && LEDGER_NUMBER_REQUIRED_WORDS.includes(phrase)) return null;
  return { kind, n };
}

export type LedgerApplyOutcome = 'applied' | 'not_applicable' | 'lost_race';

export interface ApplyLedgerOptions {
  by: string;
  now: Date;
  timeZone: string;
}

interface ApplyOpts extends ApplyLedgerOptions {
  db: BusinessDb;
}

async function insertEvent(
  tx: BusinessDb,
  businessId: string,
  itemId: string,
  kind: string,
  by: string,
  note: string | null = null,
): Promise<void> {
  await tx.query(
    `INSERT INTO ledger_events (event_id, business_id, item_id, kind, note, by_whom, at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
    [`LE-${ulid()}`, businessId, itemId, kind, note, by],
  );
}

const DONE_FROM: LedgerStatus[] = ['open', 'stuck', 'closed_by_evidence'];
const CANCEL_FROM: LedgerStatus[] = ['open', 'stuck', 'closed_by_evidence', 'done'];
const REOPEN_FROM: LedgerStatus[] = ['closed_by_evidence', 'done', 'cancelled', 'stuck'];
/** A snooze revives a stuck or evidence-closed item; done/cancelled are revived only by `פתחי`. */
const SNOOZE_FROM: LedgerStatus[] = ['open', 'stuck', 'closed_by_evidence'];

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A move from exactly the statuses given; `not_applicable` when the item is not in one of them now. */
async function move(
  item: LedgerItem,
  from: LedgerStatus[],
  to: LedgerStatus,
  kind: 'done' | 'cancelled' | 'reopened' | 'held',
  o: ApplyOpts,
): Promise<LedgerApplyOutcome> {
  if (!from.includes(item.status)) return 'not_applicable';
  const moved = await moveLedgerStatus(o.db, item.itemId, from, to, { kind, by: o.by });
  return moved ? 'applied' : 'lost_race';
}

async function snooze(
  item: LedgerItem,
  to: 'tomorrow' | { date: string },
  o: ApplyOpts,
): Promise<LedgerApplyOutcome> {
  if (!SNOOZE_FROM.includes(item.status)) return 'not_applicable';
  const today = localParts(o.now, o.timeZone).date;
  const date = to === 'tomorrow' ? addDays(today, 1) : to.date;
  // A timed item keeps its hour; a date-only one lands on the daily hour —
  // the rule `ledger.update` applies when the owner moves a date.
  const keptTime = item.dueAt !== null && !item.dueIsDateOnly ? localParts(item.dueAt, o.timeZone).time : null;
  let time = keptTime;
  if (time === null) {
    const settings = await loadLedgerSettings(o.db);
    time = `${String(settings.dailyHour).padStart(2, '0')}:00`;
  }
  const dueAt = localToInstant(date, time, o.timeZone);
  const reopening = item.status !== 'open';

  return transaction(o.db, async (tx) => {
    const res = await tx.query(
      `UPDATE ledger_items
          SET due_at = $3, due_is_date_only = $4, nudge_count = 0,
              status = 'open', closed_at = NULL, updated_at = now()
              ${reopening ? ', evidence_after = now()' : ''}
        WHERE business_id = $1 AND item_id = $2 AND status = ANY($5)`,
      [tx.businessId, item.itemId, dueAt, keptTime === null, [item.status]],
    );
    if ((res.rowCount ?? 0) === 0) return 'lost_race';
    await insertEvent(tx, tx.businessId, item.itemId, 'snoozed', o.by, date);
    if (reopening) await insertEvent(tx, tx.businessId, item.itemId, 'reopened', o.by);
    return 'applied';
  });
}

/** One conditional UPDATE plus its event; zero rows → `lost_race` (the precondition was read true). */
async function conditional(
  item: LedgerItem,
  setAndWhere: { set: string; where: string },
  kind: string,
  o: ApplyOpts,
): Promise<LedgerApplyOutcome> {
  return transaction(o.db, async (tx) => {
    const res = await tx.query(
      `UPDATE ledger_items SET ${setAndWhere.set}, updated_at = now()
        WHERE business_id = $1 AND item_id = $2 AND ${setAndWhere.where}`,
      [tx.businessId, item.itemId],
    );
    if ((res.rowCount ?? 0) === 0) return 'lost_race';
    await insertEvent(tx, tx.businessId, item.itemId, kind, o.by);
    return 'applied';
  });
}

/**
 * Apply one owner command to one item. The single applier for WhatsApp and
 * the dashboard. Reads the item first (business-scoped — another business's
 * item is `not_applicable`), decides applicability on that read, and then
 * writes conditionally, so a concurrent change between the two is
 * `'lost_race'` and nothing is written.
 */
export async function applyLedgerCommand(
  db: BusinessDb,
  itemId: string,
  cmd: LedgerCommand,
  options: ApplyLedgerOptions,
): Promise<LedgerApplyOutcome> {
  const o: ApplyOpts = { ...options, db };
  const item = await loadLedgerItem(db, itemId);
  if (item === null) return 'not_applicable';

  switch (cmd.kind) {
    case 'done':
      return move(item, DONE_FROM, 'done', 'done', o);
    case 'cancel':
      return move(item, CANCEL_FROM, 'cancelled', 'cancelled', o);
    case 'reopen':
      return move(item, REOPEN_FROM, 'open', 'reopened', o);
    case 'held':
      if (item.family !== 'meetings') return 'not_applicable';
      return move(item, DONE_FROM, 'done', 'held', o);
    case 'not_held':
      if (item.family !== 'meetings' || item.status !== 'open') return 'not_applicable';
      return conditional(item, { set: 'status = status', where: `status = 'open'` }, 'not_held', o);
    case 'snooze':
      return snooze(item, cmd.to, o);
    case 'save_stages':
      if (item.proposedStages === null) return 'not_applicable';
      return conditional(
        item,
        { set: 'stages = proposed_stages, proposed_stages = NULL', where: 'proposed_stages IS NOT NULL' },
        'stages_saved',
        o,
      );
    case 'confirm_address':
      if (item.counterpartyEmail === null) return 'not_applicable';
      return conditional(
        item,
        { set: 'counterparty_email_verified = true', where: 'counterparty_email IS NOT NULL' },
        'address_confirmed',
        o,
      );
  }
}

export const LEDGER_NUMBER_NEEDED = 'בהודעה האחרונה של הפנקס יש כמה שורות — השיבי במספר ומילה, למשל "2 בוצע".';
export const LEDGER_LOST_RACE = 'השורה השתנתה בינתיים — לא עדכנתי. אפשר לנסות שוב.';

function notFound(n: number | null): string {
  return n === null ? 'לא מצאתי הודעה של הפנקס לענות עליה' : `לא מצאתי את מספר ${n} בהודעה האחרונה של הפנקס`;
}

function itemLine(item: LedgerItem): string {
  return `${toOneLine(item.description)} — ${ledgerStatusLabel[item.status]}`;
}

/**
 * The owner's typed WhatsApp message, if it is a ledger command. Returns
 * `'passthrough'` — claiming and settling nothing — when it is not one.
 *
 * `accept` splits the grammar for the door (default `'any'`): `'numbered'`
 * takes only commands with a leading number, `'bare'` only those without.
 * The door reads numbered commands before a boss-command question and bare
 * ones after it, because a bare word ("פתחי") can be a contact name the
 * question picks by.
 *
 * A bare command in a business that has never had a ledger batch delivered
 * also passes through, unclaimed: an install that does not use the ledger
 * keeps its words ("בוצע", "פתחי") for the instruction door. Once any batch
 * was delivered, a bare word with no eligible batch is refused, as a
 * numbered one always is.
 * Otherwise the message is claimed first (`'skipped'` when another runner or
 * an earlier delivery already has it), resolved against the latest batch
 * delivered before it, applied, and answered in Hebrew.
 */
export async function handleLedgerWhatsApp(db: BusinessDb, input: {
  text: string;
  messageId: string;
  inboundAt: Date;
  by: string;
  now: Date;
  timeZone: string;
  messenger: BossMessenger;
  accept?: 'numbered' | 'bare' | 'any';
}): Promise<'passthrough' | 'applied' | 'refused' | 'skipped'> {
  const cmd = readLedgerCommand(input.text, { now: input.now, timeZone: input.timeZone });
  if (cmd === null) return 'passthrough';
  const accept = input.accept ?? 'any';
  if (accept === 'numbered' && cmd.n === null) return 'passthrough';
  if (accept === 'bare' && cmd.n !== null) return 'passthrough';
  const businessId = db.businessId;

  if (cmd.n === null) {
    const { rows } = await db.query(
      `SELECT 1 FROM ledger_whatsapp_batches WHERE business_id = $1 AND sent_at IS NOT NULL LIMIT 1`,
      [businessId],
    );
    if (rows.length === 0) return 'passthrough';
  }

  const claimed = await claimMessage(db, input.messageId);
  if (!claimed) return 'skipped';

  // The message is claimed, so it MUST be settled even when the reply cannot
  // be sent: a claimed-but-unsettled row is one nothing ever revisits. The
  // command (if any) already applied; a lost reply does not undo it.
  const answer = async (text: string, state: 'handled' | 'failed'): Promise<void> => {
    try {
      await input.messenger.send({ text, jobId: null });
    } catch {
      // the reply is lost; the settlement below still records the outcome
    }
    await settleMessage(db, input.messageId, state, {});
  };

  let items: string[] | null = null;
  if (!Number.isNaN(input.inboundAt.getTime())) {
    const { rows } = await db.query<{ items: string[] }>(
      `SELECT items FROM ledger_whatsapp_batches
        WHERE business_id = $1 AND sent_at IS NOT NULL AND sent_at < $2
        ORDER BY sent_at DESC, batch_id DESC
        LIMIT 1`,
      [businessId, input.inboundAt],
    );
    items = rows[0]?.items ?? null;
  }

  if (items === null) {
    await answer(notFound(cmd.n), 'failed');
    return 'refused';
  }
  let itemId: string | undefined;
  if (cmd.n === null) {
    if (items.length !== 1) {
      await answer(LEDGER_NUMBER_NEEDED, 'failed');
      return 'refused';
    }
    itemId = items[0];
  } else {
    itemId = items[cmd.n - 1];
  }
  // '' is the placeholder an erasure leaves in place of an erased id
  // (`LEDGER_WHATSAPP_BATCHES_SCRUB_SET`), so the other numbers keep their
  // items. It resolves to nothing, said explicitly rather than left to
  // `loadLedgerItem('')` returning null further down.
  if (itemId === undefined || itemId === '') {
    await answer(notFound(cmd.n), 'failed');
    return 'refused';
  }

  const outcome = await applyLedgerCommand(db, itemId, cmd, {
    by: input.by,
    now: input.now,
    timeZone: input.timeZone,
  });
  const after = await loadLedgerItem(db, itemId);
  if (outcome === 'lost_race') {
    await answer(LEDGER_LOST_RACE, 'failed');
    return 'refused';
  }
  if (after === null) {
    await answer(notFound(cmd.n), 'failed');
    return 'refused';
  }
  if (outcome === 'not_applicable') {
    await answer(`לא עדכנתי: ${itemLine(after)}`, 'failed');
    return 'refused';
  }
  const n = cmd.n ?? 1;
  const followUp = cmd.kind === 'not_held' ? `\nלקבוע מועד חדש? השיבי '${n} דחי ל-DD/MM'` : '';
  await answer(`עודכן: ${itemLine(after)}${followUp}`, 'handled');
  return 'applied';
}
