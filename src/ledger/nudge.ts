/**
 * "תוצאה" — a follow-up (nudge) to a ledger counterparty, opened as an
 * ordinary job that passes the UNCHANGED gate (`evaluateToolCall`), and the
 * observation of what became of it.
 *
 * **The nudge job carries no exemption, by construction.** It is created with
 * `provenance: 'boss'` (the item was born from an owner instruction) and
 * NOTHING else: no `boss_instructions` row — so `confirmedCommandCovers`,
 * which joins on one, can never carry it — no `grantAuthorization`, no
 * approval. Its one step is `mail.send` with `{ to, subject, body }` only: no
 * `inReplyTo`/`threadId`/`providerMessageId`, so `refineActionClass` reads it
 * as `email.initiate` (spec §11.3), which the charter holds at
 * `approve_required`. Under the dial's `ask`/`learn` it becomes a card; under
 * `off` it is refused at stage 8, and the refusal comes back to the owner as a
 * reminder carrying the draft.
 *
 * **The recipient is only the item's verified address.** Never a mail's
 * From/Reply-To, never an unconfirmed address (§7.2, §11.5).
 *
 * **The ledger is written here by deterministic code, never by the job**
 * (§11.4). The nudge job writes nothing to the ledger; `observeNudges` reads
 * its outcome and moves the counters.
 *
 * **Every move is conditional.** The slot is claimed `ON CONFLICT DO NOTHING`
 * before anything is drafted; the in-flight link is set `WHERE nudge_job_id
 * IS NULL` and cleared `WHERE nudge_job_id = $job`, so a second observation
 * — or a second scheduler — counts nothing twice.
 */
import { monotonicFactory } from 'ulid';
import type { ActiveCharter } from '../charter/store.js';
import { loadActiveCharter } from '../charter/store.js';
import { transaction, type BusinessDb } from '../db/pool.js';
import type { LedgerFamily, LedgerItem } from '../domain/ledger.js';
import { Plan } from '../domain/plan.js';
import { canTransition, JobPhase } from '../domain/job.js';
import { cancelPendingApproval } from '../governance/approvals.js';
import { createJob, PhaseMovedError, transition } from '../orchestrator/jobs.js';
import { bindPlanToJob, loadPlanBody } from '../orchestrator/plan-store.js';
import { isGateDenialCode, leadingCode } from '../orchestrator/whatsapp-report.js';
import type { NudgeDrafter } from '../sdk/nudge-drafter.js';
import { toOneLine } from '../util/bidi.js';
import { localParts, localToInstant } from '../util/local-time.js';
import { renderReminder } from './render.js';
import type { DueSlot } from './schedule.js';
import { loadLedgerItem, moveLedgerStatus } from './store.js';
import { capFor, loadRuntimeSettings } from '../tenancy/runtime-settings.js';

const ulid = monotonicFactory();

/** A reminder row this module claimed, for the pass to deliver to the owner. */
export interface ClaimedReminder {
  reminderId: string;
  item: LedgerItem;
  subject: string;
  body: string;
}

export type OpenNudgeOutcome =
  /** A nudge job was opened and handed to the gate. */
  | 'opened'
  /** The daily cap is reached; the slot is left unclaimed for a later pass. */
  | 'capped'
  /** No verified address; the owner was reminded instead. */
  | 'no_address'
  /** `maxNudgesPerThread` reached; the item moved to `stuck` and the owner was told. */
  | 'stuck'
  /** A nudge for this item is still in flight; nothing claimed. */
  | 'in_flight'
  /** The slot (or the item) was taken by another pass; nothing done. */
  | 'claimed_elsewhere'
  /** The drafter failed; the owner was reminded instead. */
  | 'draft_failed'
  /** Opening the job failed before it was linked; the owner was reminded with the draft. */
  | 'open_failed';

export interface OpenNudgeResult {
  outcome: OpenNudgeOutcome;
  /** A claimed owner reminder to deliver, when the outcome is a fallback or `stuck`. */
  reminder: ClaimedReminder | null;
}

export const NO_ADDRESS_REASON = 'אין כתובת מאושרת';
export const DRAFT_FAILED_REASON = 'הניסוח נכשל';
export const OPEN_FAILED_REASON = 'פתיחת הנדנוד נכשלה';
export const GATE_REFUSED_REASON = 'העוזרת לא מורשית לשלוח את זה עדיין';
export const SEND_FAILED_REASON = 'השליחה נכשלה';

/** The subject of a nudge mail, per family; the item's reference is appended. */
const NUDGE_SUBJECT: Readonly<Record<LedgerFamily, string>> = Object.freeze({
  money_in: 'תזכורת לגבי תשלום',
  money_out: 'לגבי התשלום',
  meetings: 'לגבי הפגישה',
  warm_leads: 'המשך לשיחתנו',
  awaiting_reply: 'ממתינים לתשובתך',
  projects: 'עדכון לגבי העבודה',
});

export function nudgeSubject(item: LedgerItem): string {
  const reference = item.reference === null ? '' : toOneLine(item.reference);
  return reference === '' ? NUDGE_SUBJECT[item.family] : `${NUDGE_SUBJECT[item.family]} — ${reference}`;
}

function dueText(item: LedgerItem, timeZone: string): string | null {
  if (item.dueAt === null) return null;
  const p = localParts(item.dueAt, timeZone);
  const [y, m, d] = p.date.split('-');
  const date = `${d}/${m}/${y}`;
  return item.dueIsDateOnly ? date : `${date} ${p.time}`;
}

/** Thrown inside a transaction only to roll it back; never escapes this module. */
class Rollback extends Error {}

async function claimSlot(tx: BusinessDb, businessId: string, itemId: string, slot: string, body: string, now: Date) {
  const inserted = await tx.query<{ reminder_id: string }>(
    `INSERT INTO ledger_reminders (reminder_id, business_id, item_id, slot, kind, body, created_at)
     VALUES ($1, $2, $3, $4, 'nudge', $5, $6)
     ON CONFLICT (business_id, item_id, slot) DO NOTHING
     RETURNING reminder_id`,
    [`LR-${ulid()}`, businessId, itemId, slot, body, now],
  );
  return inserted.rows[0]?.reminder_id ?? null;
}

async function insertEvent(
  tx: BusinessDb,
  businessId: string,
  itemId: string,
  kind: 'nudged' | 'nudge_fallback' | 'updated',
  jobId: string | null,
  note: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO ledger_events (event_id, business_id, item_id, kind, job_id, note, by_whom, at)
     VALUES ($1, $2, $3, $4, $5, $6, 'system', clock_timestamp())`,
    [`LE-${ulid()}`, businessId, itemId, kind, jobId, note],
  );
}

interface RenderCtx {
  timeZone: string;
  currency: string;
  now: Date;
}

/** The owner reminder for a nudge that did not go out. Reasons are fixed code strings. */
function fallbackText(item: LedgerItem, reason: string, draft: string | null, r: RenderCtx) {
  if (draft !== null) {
    return renderReminder(item, 'nudge', { ...r, draft, draftReason: reason });
  }
  const plain = renderReminder(item, 'nudge', r);
  return { subject: plain.subject, body: `${plain.body}\n(${reason} — לא נשלח נדנוד)` };
}

function stuckText(item: LedgerItem, count: number): { subject: string; body: string } {
  const desc = toOneLine(item.description);
  return { subject: `תקוע: ${desc}`, body: `${desc} — נדנדתי ${count} פעמים ואין תשובה. עובר אליך.` };
}

/**
 * Nudges counted against today's cap, the day beginning at local midnight in
 * the charter zone: `nudged` events today, plus nudge jobs opened today that
 * are still in flight (not yet observed, so not yet a `nudged` event).
 */
async function nudgesToday(db: BusinessDb, businessId: string, now: Date, timeZone: string): Promise<number> {
  const start = localToInstant(localParts(now, timeZone).date, '00:00', timeZone);
  const { rows } = await db.query<{ n: string }>(
    `SELECT (
       (SELECT count(*) FROM ledger_events
         WHERE business_id = $1 AND kind = 'nudged' AND at >= $2)
       +
       (SELECT count(*) FROM ledger_items i
          JOIN jobs j ON j.job_id = i.nudge_job_id AND j.business_id = i.business_id
         WHERE i.business_id = $1 AND j.created_at >= $2)
     )::text AS n`,
    [businessId, start],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function openNudge(
  db: BusinessDb,
  item: LedgerItem,
  slot: DueSlot,
  o: {
    active: ActiveCharter;
    drafter: NudgeDrafter;
    now?: Date;
  },
): Promise<OpenNudgeResult> {
  const businessId = db.businessId;
  const { active } = o;
  const now = o.now ?? new Date();
  const r: RenderCtx = { timeZone: active.charter.identity.timezone, currency: active.bundle.ceilings.currency, now };

  const { rows } = await db.query<{ status: string; nudge_job_id: string | null; nudge_count: number }>(
    `SELECT status, nudge_job_id, nudge_count FROM ledger_items WHERE business_id = $1 AND item_id = $2`,
    [businessId, item.itemId],
  );
  const current = rows[0];
  if (current === undefined || current.status !== 'open') return { outcome: 'claimed_elsewhere', reminder: null };
  if (current.nudge_job_id !== null) return { outcome: 'in_flight', reminder: null };

  // No verified address: the owner is reminded, nothing is drafted.
  const to = item.counterpartyEmailVerified && item.counterpartyEmail !== null ? item.counterpartyEmail : null;
  if (to === null) {
    const text = fallbackText(item, NO_ADDRESS_REASON, null, r);
    const reminderId = await transaction(db, async (tx) => {
      const id = await claimSlot(tx, businessId, item.itemId, slot.slot, text.body, now);
      if (id !== null) await insertEvent(tx, businessId, item.itemId, 'nudge_fallback', null, 'no_address');
      return id;
    });
    if (reminderId === null) return { outcome: 'claimed_elsewhere', reminder: null };
    return { outcome: 'no_address', reminder: { reminderId, item, ...text } };
  }

  // At the charter's cap: stuck, and the owner takes it over.
  const max = active.charter.autonomy.maxNudgesPerThread;
  if (current.nudge_count >= max) {
    const text = stuckText(item, current.nudge_count);
    let reminderId: string | null = null;
    try {
      reminderId = await transaction(db, async (tx) => {
        const moved = await moveLedgerStatus(
          tx,
          item.itemId,
          ['open'],
          'stuck',
          { kind: 'stuck', by: 'system', note: `nudges ${current.nudge_count}/${max}` },
        );
        if (!moved) throw new Rollback();
        const id = await claimSlot(tx, businessId, item.itemId, slot.slot, text.body, now);
        if (id === null) throw new Rollback();
        return id;
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    if (reminderId === null) return { outcome: 'claimed_elsewhere', reminder: null };
    return { outcome: 'stuck', reminder: { reminderId, item, ...text } };
  }

  // Daily cap: leave the slot unclaimed; a later pass retries it.
  if ((await nudgesToday(db, businessId, now, r.timeZone)) >= capFor(await loadRuntimeSettings(db), 'ledgerNudgesPerDay')) {
    return { outcome: 'capped', reminder: null };
  }

  // Claim before drafting: a racing pass finds the slot taken and drafts nothing.
  const reminderId = await transaction(db, (tx) => claimSlot(tx, businessId, item.itemId, slot.slot, '', now));
  if (reminderId === null) return { outcome: 'claimed_elsewhere', reminder: null };

  const fallback = async (reason: string, draft: string | null, outcome: OpenNudgeOutcome, note: string) => {
    const text = fallbackText(item, reason, draft, r);
    await transaction(db, async (tx) => {
      await tx.query(`UPDATE ledger_reminders SET body = $3 WHERE reminder_id = $1 AND business_id = $2`, [
        reminderId,
        businessId,
        text.body,
      ]);
      await insertEvent(tx, businessId, item.itemId, 'nudge_fallback', null, note);
    });
    return { outcome, reminder: { reminderId, item, ...text } };
  };

  let draft: string;
  try {
    const drafted = await o.drafter({
      bundle: active.bundle,
      family: item.family,
      description: item.description,
      reference: item.reference,
      dueText: dueText(item, r.timeZone),
      counterpartyName: item.counterpartyName,
      nudgeNumber: current.nudge_count + 1,
    });
    if (drafted.status !== 'drafted') return fallback(DRAFT_FAILED_REASON, null, 'draft_failed', 'draft_failed');
    draft = drafted.body;
  } catch {
    return fallback(DRAFT_FAILED_REASON, null, 'draft_failed', 'draft_failed');
  }

  const plan = Plan.parse({
    goal: `פולואפ: ${toOneLine(item.description).slice(0, 80)}`,
    steps: [
      {
        id: 'nudge',
        agent: 'comms.email',
        intent: 'follow_up',
        toolName: 'mail.send',
        // `{ to, subject, body }` only: no threading field, so the gate reads
        // `email.initiate` (spec §11.3).
        input: { to, subject: nudgeSubject(item), body: draft },
        dependsOn: [],
        expectedActionClass: 'email.initiate',
      },
    ],
  });

  let jobId: string | null = null;
  let linked = false;
  try {
    const job = await createJob(db, {
      charterVersion: active.bundle.charterVersion,
      // A literal, not a parameter: the item was born from an owner
      // instruction. No boss_instructions row is written for this job, ever.
      provenance: 'boss',
      title: `פולואפ: ${toOneLine(item.description).slice(0, 80)}`,
    });
    jobId = job.jobId;
    for (const to2 of ['understand', 'plan'] as const) {
      await transition(db, job.jobId, {
        to: to2,
        actor: 'orchestrator',
        reason: 'ledger nudge: following up on a ledger item',
      });
    }
    const bound = await bindPlanToJob(db, job.jobId, plan);
    if (bound.status === 'conflict') throw new Error(`ledger nudge: plan conflict on fresh job ${job.jobId}`);

    const link = await transaction(db, async (tx) => {
      const set = await tx.query(
        `UPDATE ledger_items SET nudge_job_id = $3, updated_at = now()
          WHERE business_id = $1 AND item_id = $2 AND nudge_job_id IS NULL AND status = 'open'`,
        [businessId, item.itemId, job.jobId],
      );
      // The claim row's body is NOT set to the draft (spec F-I3): a body on
      // a row no channel carried read as "a draft that did not go out" while
      // the nudge was in flight or already sent. The draft lives in the
      // job's plan; the screen reads the follow-up from the nudge's record.
      return (set.rowCount ?? 0) > 0;
    });
    if (!link) {
      await transition(db, job.jobId, { to: 'closed', actor: 'orchestrator', reason: 'ledger nudge: item moved on' });
      return { outcome: 'claimed_elsewhere', reminder: null };
    }
    linked = true;
    await transition(db, job.jobId, { to: 'execute', actor: 'orchestrator', reason: 'ledger nudge: to the gate' });
    return { outcome: 'opened', reminder: null };
  } catch (err) {
    if (jobId !== null) {
      const openedJobId = jobId;
      try {
        await transition(db, openedJobId, {
          to: 'failed',
          actor: 'orchestrator',
          reason: `ledger_nudge_open_failed — ${err instanceof Error ? err.message : String(err)}`,
        });
      } catch {
        // Already terminal or unreachable; observeNudges reads whatever it is.
      }
    }
    // A linked job is observed (and its failure reminded) by observeNudges.
    if (linked) return { outcome: 'opened', reminder: null };
    return fallback(OPEN_FAILED_REASON, draft, 'open_failed', 'open_failed');
  }
}

/** Phases in which a nudge job has not sent anything yet (F-I1). */
const NOT_YET_SENT_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>([
  'intake',
  'understand',
  'plan',
  'await_approval',
  'followup',
  'execute',
]);

/** Phases a linked nudge job only passes through inside `openNudge` (T10). */
const STALLABLE_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>(['intake', 'understand', 'plan']);

/** A linked nudge job still in a `STALLABLE_PHASES` phase after this long crashed mid-open. */
const STALLED_AFTER_MS = 15 * 60 * 1000;

export interface ObservedNudges {
  /** Items whose nudge went out (counted). */
  sent: string[];
  /** Items whose nudge did not go out and came back to the owner. */
  fallback: { itemId: string; draft: string; reason: string }[];
  /** Owner reminders claimed for the fallbacks, for the caller to deliver. */
  reminders: ClaimedReminder[];
}

/**
 * Read the outcome of every nudge job in flight.
 *
 * | phase | action |
 * |---|---|
 * | `closed`, step performed | `nudge_count += 1`, a `nudged` event, link cleared |
 * | item no longer `open`, job not yet sent (`intake`…`execute`, `await_approval`, `followup`) | pending card cancelled, job closed (or failed), an `updated`/`nudge_cancelled` event, link cleared — never counted |
 * | `closed`, not performed (the owner denied the card) | an `updated`/`nudge_denied` event naming the job (erasure reaches it), link cleared |
 * | `intake`/`understand`/`plan` older than 15 minutes (crash mid-open) | failed, then as `failed` below |
 * | `failed` / `halted` | a `nudge_fallback` event, an owner reminder with the draft and the reason, link cleared |
 * | anything else (`execute`, `await_approval`, `followup`, …) | nothing: still in flight, a card is the owner's |
 *
 * Idempotent: every clear is `WHERE nudge_job_id = $job`, and the counter,
 * the event and the reminder claim ride in the same transaction as the clear.
 */
export async function observeNudges(db: BusinessDb, o: { now?: Date } = {}): Promise<ObservedNudges> {
  const businessId = db.businessId;
  const now = o.now ?? new Date();
  const out: ObservedNudges = { sent: [], fallback: [], reminders: [] };

  const { rows } = await db.query<{
    item_id: string;
    item_status: string;
    job_id: string;
    phase: string;
    created_at: Date;
  }>(
    `SELECT i.item_id, i.status AS item_status, j.job_id, j.phase, j.created_at
       FROM ledger_items i
       JOIN jobs j ON j.job_id = i.nudge_job_id AND j.business_id = i.business_id
      WHERE i.business_id = $1 AND i.nudge_job_id IS NOT NULL
      ORDER BY i.item_id`,
    [businessId],
  );
  if (rows.length === 0) return out;

  const active = await loadActiveCharter(db);
  const r: RenderCtx | null =
    active === null ? null : { timeZone: active.charter.identity.timezone, currency: active.bundle.ceilings.currency, now };

  for (const row of rows) {
    const phase = JobPhase.parse(row.phase);

    // F-I1: the item moved on (evidence, done, cancelled) while its nudge had
    // not yet been sent. A pending card for it would let the owner approve —
    // and the job send — a follow-up about something already settled. The
    // card is withdrawn, the job stopped (closed where the phase allows it,
    // failed from `execute`), the link cleared, and the stop recorded. Never
    // counted as nudged. `verify`/`remember`/`update` are past the send and
    // are left to close and be counted like any sent nudge.
    if (row.item_status !== 'open' && NOT_YET_SENT_PHASES.has(phase)) {
      const { rows: cards } = await db.query<{ approval_id: string }>(
        `SELECT approval_id FROM approval_requests
          WHERE business_id = $1 AND job_id = $2 AND state = 'pending'`,
        [businessId, row.job_id],
      );
      for (const card of cards) await cancelPendingApproval(db, card.approval_id);
      try {
        await transition(db, row.job_id, {
          to: canTransition(phase, 'closed') ? 'closed' : 'failed',
          actor: 'orchestrator',
          reason: 'ledger nudge: item no longer open — nudge cancelled',
          expectFrom: phase,
        });
      } catch (err) {
        if (err instanceof PhaseMovedError) continue;
        throw err;
      }
      await transaction(db, async (tx) => {
        const cleared = await tx.query(
          `UPDATE ledger_items SET nudge_job_id = NULL, updated_at = now()
            WHERE business_id = $1 AND item_id = $2 AND nudge_job_id = $3`,
          [businessId, row.item_id, row.job_id],
        );
        if ((cleared.rowCount ?? 0) > 0) {
          await insertEvent(tx, businessId, row.item_id, 'updated', row.job_id, 'nudge_cancelled');
        }
      });
      continue;
    }

    // T10: a crash between linking the job and moving it to `execute` leaves
    // it in an early phase that nothing runs, and `openNudge` reads the link
    // as "in flight" forever — the item's nudges would silently stop. Past
    // `STALLED_AFTER_MS` it is failed (conditionally) and takes the normal
    // failed fallback below.
    let observedPhase: string = row.phase;
    if (STALLABLE_PHASES.has(phase) && row.created_at.getTime() < now.getTime() - STALLED_AFTER_MS) {
      try {
        await transition(db, row.job_id, {
          to: 'failed',
          actor: 'orchestrator',
          reason: 'ledger_nudge_stalled — the linked nudge job never reached execute',
          expectFrom: phase,
        });
        observedPhase = 'failed';
      } catch (err) {
        if (err instanceof PhaseMovedError) continue;
        throw err;
      }
    }

    if (observedPhase === 'closed') {
      const performed = await db.query(
        `SELECT 1 FROM job_step_results
          WHERE business_id = $1 AND job_id = $2 AND status = 'completed' AND performed = true`,
        [businessId, row.job_id],
      );
      const wasSent = (performed.rowCount ?? 0) > 0;
      const counted = await transaction(db, async (tx) => {
        const cleared = await tx.query(
          `UPDATE ledger_items
              SET nudge_job_id = NULL, updated_at = now()${wasSent ? ', nudge_count = nudge_count + 1' : ''}
            WHERE business_id = $1 AND item_id = $2 AND nudge_job_id = $3`,
          [businessId, row.item_id, row.job_id],
        );
        if ((cleared.rowCount ?? 0) === 0) return false;
        if (wasSent) await insertEvent(tx, businessId, row.item_id, 'nudged', row.job_id, null);
        // M1: the owner denied the card. The event names the job so that
        // erasure's event→job closure still reaches it once the link is gone.
        else await insertEvent(tx, businessId, row.item_id, 'updated', row.job_id, 'nudge_denied');
        return true;
      });
      if (counted && wasSent) out.sent.push(row.item_id);
      continue;
    }
    if (observedPhase !== 'failed' && observedPhase !== 'halted') continue;

    const last = await db.query<{ reason: string }>(
      `SELECT reason FROM job_steps WHERE job_id = $1 AND business_id = $2 ORDER BY at DESC, id DESC LIMIT 1`,
      [row.job_id, db.businessId],
    );
    const code = leadingCode(last.rows[0]?.reason ?? '');
    const reason = code !== null && isGateDenialCode(code) ? GATE_REFUSED_REASON : SEND_FAILED_REASON;
    let draft = '';
    try {
      const body = (await loadPlanBody(db, row.job_id))?.plan.steps[0]?.input['body'];
      if (typeof body === 'string') draft = body;
    } catch {
      // An unreadable stored plan: the owner is still told, without the draft.
    }
    const item = await loadLedgerItem(db, row.item_id);
    if (item === null) continue;
    const text = r === null ? null : fallbackText(item, reason, draft === '' ? null : draft, r);

    const reminderId = await transaction(db, async (tx) => {
      const cleared = await tx.query(
        `UPDATE ledger_items SET nudge_job_id = NULL, updated_at = now()
          WHERE business_id = $1 AND item_id = $2 AND nudge_job_id = $3`,
        [businessId, row.item_id, row.job_id],
      );
      if ((cleared.rowCount ?? 0) === 0) return undefined;
      await insertEvent(tx, businessId, row.item_id, 'nudge_fallback', row.job_id, code);
      // A closed item (evidence, done, cancelled) needs no reminder.
      if (text === null || item.status !== 'open') return null;
      return claimSlot(tx, businessId, row.item_id, `nudge_fallback:${row.job_id}`, text.body, now);
    });
    if (reminderId === undefined) continue;
    out.fallback.push({ itemId: row.item_id, draft, reason });
    if (reminderId !== null && text !== null) out.reminders.push({ reminderId, item, ...text });
  }
  return out;
}
