/**
 * Shadow mode: one update to the owner per action the assistant performed on
 * her own — owner ruling H3 (26/10).
 *
 * **One step, one update, never batched.** Every performed step that ran with
 * no card behind it (`listAutonomousActions`) and whose job the owner did not
 * himself instruct (`fromInstruction`) gets its own `action_updates` row and
 * its own send on each channel he picked. A digest of "she did seven things"
 * is what the daily digest already is; this is the opposite promise — he
 * hears about each one as it happens.
 *
 * **Steps from jobs the owner instructed are excluded.** He asked for them;
 * telling him she did what he asked is noise that teaches him to ignore the
 * update that matters. `fromInstruction` is read from `boss_instructions`
 * under THIS business (`autonomous-actions.ts`).
 *
 * **Insert first, then send, then record the states.** The row is the record
 * whether or not delivery works (spec §5.4), and `INSERT ... ON CONFLICT DO
 * NOTHING RETURNING` against `UNIQUE (business_id, job_id, step_id)` is what
 * makes the send happen at most once per step: only a row THIS pass inserted
 * is sent, so a second pass — or a second scheduler racing this one — finds
 * the row already there and sends nothing. The accepted cost: a crash between
 * the insert and the state update leaves a row whose chosen channels read
 * NULL, i.e. "not chosen", although they were chosen and may or may not have
 * gone out. It is never re-sent. The row is still the record, and the screen
 * still shows it — the opposite order (send, then insert) would leave a
 * window in which the owner was told something no record exists of, the same
 * reasoning `runDigests` (`digest-run.ts`) and `trip()` already follow.
 *
 * **Channel states follow 040's meaning exactly.** A channel the owner did not
 * choose stays NULL. A chosen channel with no seam (no `sendAlert`, no
 * messenger) is `skipped_not_connected` — recorded, never silenced. A send
 * that returns `!ok`, throws, or does not settle within the deadline is
 * `failed`. A successful one is `sent`. The screen has no state column:
 * `seen_at` stays NULL until the owner opens it. Each send is raced against
 * `withDeadline` (`governance/notify.ts`), because a hanging relay must cost
 * the scheduler pass seconds, not the pass itself; and each channel is caught
 * on its own, so one dead channel costs neither the other nor the row.
 *
 * **Sends are sequential.** One update after another, email then WhatsApp,
 * so a hanging relay costs up to `NOTIFY_TIMEOUT_MS` per chosen channel per
 * update in this pass — bounded, never unbounded, but it adds up on a pass
 * with many new updates.
 *
 * **Nothing older than a day is backfilled.** The first pass after deploy
 * would otherwise find every autonomous step the installation ever ran and
 * flood the owner with history. The bound is on `completedAt` against the
 * injectable `now`, so a test can move the clock instead of seeding the past.
 *
 * **`body` is stored without the link and as plain text.** Erasure
 * (`erasure-plan.ts`) discovers `action_updates` rows by recipient, subject
 * and body content; plain text is what its `LIKE` can find. The link is
 * added only to what is sent.
 */
import { ulid } from 'ulid';
import { getPool, type Queryable } from '../db/pool.js';
import { actionClassLabel } from '../domain/labels.js';
import { loadActionUpdateSettings } from '../governance/action-update-settings.js';
import { NOTIFY_TIMEOUT_MS, withDeadline } from '../governance/notify.js';
import { listAutonomousActions, type AutonomousAction } from '../dashboard/autonomous-actions.js';
import { stripBidiControls } from '../util/bidi.js';
import type { BossMessenger } from '../whatsapp/messenger.js';

export interface ActionUpdatesResult {
  /** Rows this pass inserted — one per newly reported step. */
  written: number;
  emailFailed: number;
  whatsappFailed: number;
  /** Chosen channels with no seam to send through, summed over both channels. */
  skippedNotConnected: number;
}

type ChannelState = 'sent' | 'failed' | 'skipped_not_connected';

/** How far back a step may have completed and still be reported. */
export const ACTION_UPDATE_BACKFILL_MS = 24 * 60 * 60 * 1000;

/**
 * Plain text, for one line of a message: bidi controls stripped (the
 * recipient, subject and title can carry a stranger's bytes) and every line
 * break or other control character folded to a space, so a subject cannot
 * forge a line of its own in the update.
 */
function oneLine(value: string): string {
  return stripBidiControls(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
}

function present(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = oneLine(value);
  return cleaned.length > 0 ? cleaned : null;
}

/** The owner-facing Hebrew text of one update. `link` null → no link line. */
export function renderActionUpdate(a: AutonomousAction, link: string | null): string {
  const lines = [`העוזרת ביצעה פעולה בעצמה: ${actionClassLabel(a.actionClass)}`];
  const recipient = present(a.recipient);
  const subject = present(a.subject);
  const title = present(a.jobTitle);
  if (recipient !== null) lines.push(`נמען: ${recipient}`);
  if (subject !== null) lines.push(`נושא: ${subject}`);
  if (title !== null) lines.push(`משימה: ${title}`);
  if (link !== null) {
    lines.push('', 'לצפייה בפעולות שביצעה בעצמה ולסימון טעות:', link);
  }
  return lines.join('\n');
}

function emailSubject(a: AutonomousAction): string {
  const about = present(a.recipient) ?? present(a.jobTitle);
  const label = actionClassLabel(a.actionClass);
  return about === null ? `עדכון: ${label}` : `עדכון: ${label} — ${about}`;
}

async function deliver(
  send: () => Promise<{ ok: boolean }>,
  timeoutMs: number,
): Promise<ChannelState> {
  try {
    const result = await withDeadline(send(), timeoutMs);
    return result.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

export async function dispatchActionUpdates(options: {
  businessId: string;
  now?: Date;
  sendAlert?: (subject: string, body: string) => Promise<{ ok: boolean; error?: string }>;
  messenger?: BossMessenger;
  dashboardBaseUrl?: string;
  db?: Queryable;
  /** Test seam: the per-send deadline. Defaults to `NOTIFY_TIMEOUT_MS`. */
  timeoutMs?: number;
}): Promise<ActionUpdatesResult> {
  const { businessId } = options;
  const db = options.db ?? getPool();
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  const link =
    options.dashboardBaseUrl !== undefined && options.dashboardBaseUrl.length > 0
      ? `${options.dashboardBaseUrl.replace(/\/+$/, '')}/autonomy/actions`
      : null;

  const result: ActionUpdatesResult = {
    written: 0,
    emailFailed: 0,
    whatsappFailed: 0,
    skippedNotConnected: 0,
  };

  const settings = await loadActionUpdateSettings({ businessId, db });
  // The bound is in SQL, not a filter afterwards: `listAutonomousActions`
  // throws on a stored plan that does not parse, and an unbounded read would
  // let one such row anywhere in history stop every update on every pass.
  const since = new Date(now.getTime() - ACTION_UPDATE_BACKFILL_MS);
  const due = (await listAutonomousActions({ businessId, db, since }))
    .filter((a) => !a.fromInstruction)
    // `listAutonomousActions` is newest first; the owner hears them in the
    // order they happened.
    .reverse();

  for (const a of due) {
    const body = renderActionUpdate(a, null);
    const inserted = await db.query<{ update_id: string }>(
      `INSERT INTO action_updates
         (update_id, business_id, job_id, step_id, action_class, recipient, subject, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (business_id, job_id, step_id) DO NOTHING
       RETURNING update_id`,
      [ulid(), businessId, a.jobId, a.stepId, a.actionClass, a.recipient, a.subject, body],
    );
    const updateId = inserted.rows[0]?.update_id;
    // Already reported by an earlier pass: no second send.
    if (updateId === undefined) continue;
    result.written += 1;

    // The SENT text carries this update's own id; the stored `body` does not
    // need it. Both outbound seams derive their idempotency key from the
    // content (`sendAlert`: hash of subject + body, which becomes the
    // Message-ID; the messenger: job id + text + minute). Two replies to the
    // same recipient under the same subject and job title would otherwise
    // be byte-identical, the mail server would drop the second as a
    // duplicate while `sendAlert` reported `ok` — the exact silence the
    // bridge alert already paid for (`runtime.ts`), and a broken H3.
    const text = [renderActionUpdate(a, link), '', `מזהה עדכון: ${updateId}`].join('\n');

    let emailState: ChannelState | null = null;
    if (settings.toEmail) {
      const sendAlert = options.sendAlert;
      emailState =
        sendAlert === undefined
          ? 'skipped_not_connected'
          : await deliver(() => sendAlert(emailSubject(a), text), timeoutMs);
    }

    let whatsappState: ChannelState | null = null;
    if (settings.toWhatsApp) {
      const messenger = options.messenger;
      // `jobId` is the step's own job, so erasure — which reaches
      // `whatsapp_messages` by `job_id` membership — reaches this text too.
      whatsappState =
        messenger === undefined
          ? 'skipped_not_connected'
          : await deliver(() => messenger.send({ text, jobId: a.jobId }), timeoutMs);
    }

    if (emailState === 'failed') result.emailFailed += 1;
    if (whatsappState === 'failed') result.whatsappFailed += 1;
    if (emailState === 'skipped_not_connected') result.skippedNotConnected += 1;
    if (whatsappState === 'skipped_not_connected') result.skippedNotConnected += 1;

    await db.query(
      `UPDATE action_updates SET email_state = $3, whatsapp_state = $4
        WHERE update_id = $1 AND business_id = $2`,
      [updateId, businessId, emailState, whatsappState],
    );
  }

  return result;
}
