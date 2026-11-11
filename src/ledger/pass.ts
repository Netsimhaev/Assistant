/**
 * The ledger reminder pass: find each open item's due reminder slots, claim
 * each slot once, and tell the owner — one email per reminder, one numbered
 * WhatsApp message per pass, and the screen.
 *
 * Modelled on `dispatchActionUpdates` (`orchestrator/action-updates.ts`), and
 * for the same reasons:
 *
 * **Claim before send.** `INSERT ... ON CONFLICT (business_id, item_id, slot)
 * DO NOTHING RETURNING` — only a row THIS pass inserted is sent, so a second
 * pass, or a second scheduler racing this one, finds the slot already claimed
 * and sends nothing (counted as `skipped`). The claim and its `reminded` event
 * are one transaction. Accepted cost: a crash between the claim and the state
 * update leaves a row whose chosen channels read NULL; it is never re-sent.
 *
 * **Channel states follow 040/047.** Not chosen → NULL. Chosen with no seam →
 * `skipped_not_connected`. A send that returns `!ok`, throws, or does not
 * settle within the deadline (`withDeadline`) → `failed`. Otherwise `sent`.
 * Each channel is caught on its own. The screen has no state column:
 * `seen_at` stays NULL until `/ledger` is opened.
 *
 * **The texts are deterministic** (`renderReminder`, no model) and the SENT
 * text carries `מזהה תזכורת: <id>`: both seams derive their idempotency key
 * from the content, and two reminders that read the same would otherwise be
 * dropped as duplicates downstream. The stored `body` carries neither the id
 * nor the link, so erasure's `LIKE` finds it as plain text.
 *
 * **WhatsApp is one numbered batch per pass** (`sendLedgerBatch`), evidence
 * notices handed in by the caller first (`evidenceNotices`): the batch
 * row is written first with the item ids in display order, and `sent_at` is
 * stamped only when the send returned `ok` — a batch that may never have
 * arrived must not be answerable by "2 בוצע".
 *
 * **Nudges in `act` mode go to `openNudge`** (`ledger/nudge.ts`): a job
 * through the unchanged gate. A `remind`-mode nudge is an ordinary owner
 * reminder. The pass starts with `observeNudges`, so one stage call both
 * reads the outcome of the nudges in flight and opens the next ones; every
 * nudge that could not go out (and every item that reached the nudge cap)
 * comes back to the owner through the same delivery as any reminder. With no
 * `drafter` injected an act-mode nudge slot is left unclaimed, exactly as
 * before the nudge stage existed.
 *
 * **Day boundaries and the times in every text are in the charter zone**,
 * never the process's or the DB session's.
 */
import { monotonicFactory } from 'ulid';
import { loadActiveCharter, type ActiveCharter } from '../charter/store.js';
import { transaction, type BusinessDb } from '../db/pool.js';
import type { LedgerItem } from '../domain/ledger.js';
import { NOTIFY_TIMEOUT_MS, withDeadline } from '../governance/notify.js';
import type { NudgeDrafter } from '../sdk/nudge-drafter.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { observeNudges, openNudge, type ClaimedReminder } from './nudge.js';
import type { EvidenceNotice } from './evidence.js';
import { renderEvidenceNotice, renderReminder, renderWhatsAppBatch } from './render.js';
import { dueSlots, type DueSlot } from './schedule.js';
import { loadLedgerSettings, type LedgerSettings } from './settings.js';
import { listLedgerItems } from './store.js';

const ulid = monotonicFactory();

export interface LedgerPassResult {
  /** Reminder slots this pass claimed. */
  reminded: number;
  /** Nudge jobs opened (act mode). */
  nudgesOpened: number;
  /** Nudges that came back to the owner (no address, failed draft, refused or failed send). */
  nudgeFallbacks: number;
  /** Items moved to `stuck` at the charter's nudge cap. */
  stuck: number;
  /** Per reminder whose email failed. */
  emailFailed: number;
  /** Per reminder in a WhatsApp batch whose send failed. */
  whatsappFailed: number;
  /** Chosen channels with no seam, summed per reminder over both channels. */
  skippedNotConnected: number;
  /** Due slots already claimed (by an earlier or a racing pass). */
  skipped: number;
  errored: { itemId: string; error: string }[];
}

export type LedgerChannelState = 'sent' | 'failed' | 'skipped_not_connected';

/** The drafter for act-mode nudges; injected so tests never reach the billed one. */
export type LedgerPassDrafter = NudgeDrafter;

export interface LedgerPassOptions {
  now?: Date;
  sendAlert?: (subject: string, body: string) => Promise<{ ok: boolean; error?: string }>;
  messenger?: BossMessenger;
  dashboardBaseUrl?: string;
  drafter?: LedgerPassDrafter;
  /** Per-send deadline. Defaults to `NOTIFY_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * This pass's evidence closures (`closeLedgerByEvidence`'s `notices`). They
   * go FIRST in the pass's single WhatsApp batch, each naming its real number
   * there — one batch per pass, so no number the owner holds is re-pointed.
   */
  evidenceNotices?: readonly EvidenceNotice[];
}

function emptyResult(): LedgerPassResult {
  return {
    reminded: 0,
    nudgesOpened: 0,
    nudgeFallbacks: 0,
    stuck: 0,
    emailFailed: 0,
    whatsappFailed: 0,
    skippedNotConnected: 0,
    skipped: 0,
    errored: [],
  };
}

export async function deliver(send: () => Promise<{ ok: boolean }>, timeoutMs: number): Promise<'sent' | 'failed'> {
  try {
    const result = await withDeadline(send(), timeoutMs);
    return result.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Write one numbered batch and send it. Numbering is 1-based in the order
 * given; the row's `items[n-1]` is entry `n`. `sent_at` is stamped only on
 * `ok`. No entries → nothing written, `'empty'`. No messenger → nothing
 * written (nothing was sent, so nothing may be answered), `'skipped_not_connected'`.
 *
 * The pass's single batch carries the evidence notices too (spec I5).
 */
export async function sendLedgerBatch(
  db: BusinessDb,
  entries: { itemId: string; text: string }[],
  o: { messenger?: BossMessenger; timeoutMs?: number },
): Promise<{ state: LedgerChannelState | 'empty'; batchId: string | null }> {
  if (entries.length === 0) return { state: 'empty', batchId: null };
  const messenger = o.messenger;
  if (messenger === undefined) return { state: 'skipped_not_connected', batchId: null };
  const batchId = `LB-${ulid()}`;
  await db.query(
    `INSERT INTO ledger_whatsapp_batches (batch_id, business_id, items) VALUES ($1, $2, $3)`,
    [batchId, db.businessId, entries.map((e) => e.itemId)],
  );
  const text = renderWhatsAppBatch(entries.map((e, i) => ({ n: i + 1, text: e.text })));
  const state = await deliver(() => messenger.send({ text, jobId: null }), o.timeoutMs ?? NOTIFY_TIMEOUT_MS);
  if (state === 'sent') {
    await db.query(
      `UPDATE ledger_whatsapp_batches SET sent_at = now() WHERE batch_id = $1 AND business_id = $2`,
      [batchId, db.businessId],
    );
  }
  return { state, batchId };
}

/**
 * A `nudge` slot whose family mode is `act`: open a nudge job through the
 * gate (`openNudge`) and count the outcome. A fallback or `stuck` reminder is
 * returned for the pass to deliver like any other reminder. No drafter: the
 * slot is left unclaimed and nothing is counted.
 */
async function handleActNudge(
  db: BusinessDb,
  item: LedgerItem,
  slot: DueSlot,
  ctx: { result: LedgerPassResult; options: LedgerPassOptions; active: ActiveCharter; now: Date },
): Promise<ClaimedReminder | null> {
  const drafter = ctx.options.drafter;
  if (drafter === undefined) return null;
  const opened = await openNudge(db, item, slot, {
    active: ctx.active,
    drafter,
    now: ctx.now,
  });
  switch (opened.outcome) {
    case 'opened':
      ctx.result.nudgesOpened += 1;
      break;
    case 'no_address':
    case 'draft_failed':
    case 'open_failed':
      ctx.result.nudgeFallbacks += 1;
      break;
    case 'stuck':
      ctx.result.stuck += 1;
      break;
    case 'capped':
    case 'in_flight':
    case 'claimed_elsewhere':
      ctx.result.skipped += 1;
      break;
  }
  return opened.reminder;
}

/**
 * The latest nudge per item: a `nudged` or `nudge_fallback` event, or a
 * claimed `nudge` reminder row. A remind-mode nudge leaves only the row, and
 * without it the cadence would restart from `created_at` — one nudge ever.
 */
async function lastNudges(db: BusinessDb, businessId: string): Promise<Map<string, Date>> {
  const { rows } = await db.query<{ item_id: string; last_at: Date }>(
    `SELECT item_id, max(at) AS last_at FROM (
       SELECT item_id, at FROM ledger_events
        WHERE business_id = $1 AND kind IN ('nudged', 'nudge_fallback')
       UNION ALL
       SELECT item_id, created_at AS at FROM ledger_reminders
        WHERE business_id = $1 AND kind = 'nudge'
     ) n GROUP BY item_id`,
    [businessId],
  );
  return new Map(rows.map((r) => [r.item_id, r.last_at]));
}

interface Claimed {
  reminderId: string;
  item: LedgerItem;
  body: string;
  subject: string;
}

async function claim(
  db: BusinessDb,
  businessId: string,
  item: LedgerItem,
  slot: DueSlot,
  rendered: { subject: string; body: string },
  now: Date,
): Promise<string | null> {
  return transaction(db, async (tx) => {
    const inserted = await tx.query<{ reminder_id: string }>(
      `INSERT INTO ledger_reminders (reminder_id, business_id, item_id, slot, kind, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, item_id, slot) DO NOTHING
       RETURNING reminder_id`,
      [`LR-${ulid()}`, businessId, item.itemId, slot.slot, slot.kind, rendered.body, now],
    );
    const reminderId = inserted.rows[0]?.reminder_id;
    if (reminderId === undefined) return null;
    await tx.query(
      `INSERT INTO ledger_events (event_id, business_id, item_id, kind, note, by_whom, at)
       VALUES ($1, $2, $3, 'reminded', $4, 'system', clock_timestamp())`,
      [`LE-${ulid()}`, businessId, item.itemId, `${slot.kind} ${reminderId}`],
    );
    return reminderId;
  });
}

export async function runLedgerPass(db: BusinessDb, options: LedgerPassOptions = {}): Promise<LedgerPassResult> {
  const businessId = db.businessId;
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  const result = emptyResult();

  const active = await loadActiveCharter(db);
  if (active === null) return result;
  const timeZone = active.charter.identity.timezone;
  const workweek = active.charter.operations.workweek;
  const holidays = active.charter.operations.holidays.map((h) => h.date);
  const currency = active.bundle.ceilings.currency;
  const link =
    options.dashboardBaseUrl !== undefined && options.dashboardBaseUrl.length > 0
      ? `${options.dashboardBaseUrl.replace(/\/+$/, '')}/ledger`
      : null;

  const settings: LedgerSettings = await loadLedgerSettings(db);
  const batch: Claimed[] = [];

  /** Email one claimed reminder now; queue it for the pass's WhatsApp batch. */
  const dispatch = async (
    reminderId: string,
    item: LedgerItem,
    rendered: { subject: string; body: string },
  ): Promise<void> => {
    let emailState: LedgerChannelState | null = null;
    if (settings.toEmail) {
      const sendAlert = options.sendAlert;
      if (sendAlert === undefined) {
        emailState = 'skipped_not_connected';
      } else {
        const text = [rendered.body, '', ...(link === null ? [] : [`לפנקס: ${link}`]), `מזהה תזכורת: ${reminderId}`].join(
          '\n',
        );
        emailState = await deliver(() => sendAlert(rendered.subject, text), timeoutMs);
      }
    }
    if (emailState === 'failed') result.emailFailed += 1;
    if (emailState === 'skipped_not_connected') result.skippedNotConnected += 1;
    await db.query(`UPDATE ledger_reminders SET email_state = $3 WHERE reminder_id = $1 AND business_id = $2`, [
      reminderId,
      businessId,
      emailState,
    ]);
    if (settings.toWhatsApp) batch.push({ reminderId, item, body: rendered.body, subject: rendered.subject });
  };

  // First the outcome of the nudges already in flight, so a refused one is
  // told this pass and its `nudge_fallback` resumes the cadence (R4).
  try {
    const observed = await observeNudges(db, { now });
    result.nudgeFallbacks += observed.fallback.length;
    for (const r of observed.reminders) await dispatch(r.reminderId, r.item, r);
  } catch (err) {
    result.errored.push({ itemId: 'observe_nudges', error: err instanceof Error ? err.message : String(err) });
  }

  const items = await listLedgerItems(db, { statuses: ['open'] });
  const lastNudge = await lastNudges(db, businessId);

  for (const item of items) {
    try {
      const slots = dueSlots(item, settings, {
        now,
        timeZone,
        workweek,
        holidays,
        lastNudgeAt: lastNudge.get(item.itemId) ?? null,
      });
      for (const slot of slots) {
        if (slot.kind === 'nudge' && settings.modes[item.family] === 'act') {
          const reminder = await handleActNudge(db, item, slot, { result, options, active, now });
          if (reminder !== null) await dispatch(reminder.reminderId, reminder.item, reminder);
          continue;
        }
        const rendered = renderReminder(item, slot.kind, { timeZone, currency, now });
        const reminderId = await claim(db, businessId, item, slot, rendered, now);
        if (reminderId === null) {
          result.skipped += 1;
          continue;
        }
        result.reminded += 1;
        await dispatch(reminderId, item, rendered);
      }
    } catch (err) {
      result.errored.push({ itemId: item.itemId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const notices = options.evidenceNotices ?? [];
  if (settings.toWhatsApp && batch.length + notices.length > 0) {
    // Notices first: their numbers are 1..k, and each text names its own.
    const entries = [
      ...notices.map((n, i) => ({
        itemId: n.itemId,
        reminderId: n.reminderId,
        text: `${renderEvidenceNotice(n, 'whatsapp', i + 1)}\nמזהה תזכורת: ${n.reminderId}`,
      })),
      ...batch.map((c) => ({ itemId: c.item.itemId, reminderId: c.reminderId, text: `${c.body}\nמזהה תזכורת: ${c.reminderId}` })),
    ];
    let state: LedgerChannelState;
    try {
      const sent = await sendLedgerBatch(
        db,
        entries.map((e) => ({ itemId: e.itemId, text: e.text })),
        {
          timeoutMs,
          ...(options.messenger !== undefined ? { messenger: options.messenger } : {}),
        },
      );
      state = sent.state === 'empty' ? 'failed' : sent.state;
    } catch {
      state = 'failed';
    }
    if (state === 'failed') result.whatsappFailed += entries.length;
    if (state === 'skipped_not_connected') result.skippedNotConnected += entries.length;
    await db.query(
      `UPDATE ledger_reminders SET whatsapp_state = $3 WHERE reminder_id = ANY($1) AND business_id = $2`,
      [entries.map((e) => e.reminderId), businessId, state],
    );
  }

  return result;
}
