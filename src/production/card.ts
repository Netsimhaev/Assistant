/**
 * The document card (document production §4, §8.1, §8.4, §10, C3, C17): what
 * the owner sees when a production finishes, and the ONE place an approval
 * becomes a send.
 *
 * **Approval is a confirmed boss command, not a new mechanism (§8.1, C3).**
 * When a card is built, one delivery plan is built per option it shows — a
 * `mail.send` with the produced file attached, or a `doc.save` — and stored on
 * the card with its `planHashOf`. Pressing one (`approveDocumentCard`) creates
 * the delivery job in ONE transaction, under the card's row lock: a `boss`
 * job (a literal), a `boss_instructions` row with the production's own
 * instruction text and origin, the chosen plan bound, an
 * `instruction_confirmations` row created and confirmed with that plan's
 * hash, the move `plan → execute`, and the card's `delivery_job_id`. The
 * plan is REBUILT in the server from the production and the version and its
 * hash compared with the one the owner pressed and the one stored — any
 * disagreement is `card_stale`, no job. `runDueJobs` then runs the job under
 * `confirmedCommandCovers`, unchanged: the gate is not touched, and no new
 * exemption exists. What that buys and costs is the boss command's own
 * ruling (D15): a document approved at night leaves at night.
 *
 * **`approveDocumentCard` is the only writer of `delivery_job_id`**, and only
 * on the job it just created (carry (a)); nothing exposes the column to a
 * plan or a tool. That column is what lets a step carry attachments or save a
 * file at all, and only for that card's version (`deliveryVersionOf`).
 *
 * **What the send carries.** Recipients are the production's destination,
 * already filtered by `authorisedRecipients` when it was queued. The subject
 * and body are planner-written from the owner's instruction (the
 * destination's own fields) — or, when the planner gave none, a fixed Hebrew
 * default (`מצורף <סוג>: <כותרת>`). Either way they are shown verbatim on the
 * card through the step echo and bound by the approval hash: the owner
 * approves exactly those bytes, and a change is a different plan. The
 * attachment ref is built from the version row: `canonicalAttachmentName`,
 * its sha256 and size.
 *
 * **A version that did not pass the checks (`failed_checks`, §7.3, C6)** is
 * offered for saving only, with the warning in the option itself; never for
 * sending. `approveDocumentCard` re-checks it: a send plan is accepted only
 * on a `ready` production.
 *
 * **Every delivery job is recorded for good** in `document_deliveries`
 * (migration 055), in the approval's transaction. `delivery_job_id` is the
 * card's CURRENT delivery — what the attachment and save gates read — and is
 * overwritten when a returned card is approved again; the record is what
 * keeps every delivery job, current or not, out of the command re-ask and
 * out of curation.
 *
 * **Notifications** go to the channels the owner chose
 * (`document_settings`): the screen sends nothing; email is the alert seam
 * with the file attached; WhatsApp is `BossMessenger.sendFile`, which takes
 * no recipient. A channel chosen with no seam is `skipped_not_connected`; a
 * send that fails is `failed` — recorded, never thrown (040/047's states).
 *
 * **At least once, never twice.** The production loop may call
 * `onProductionFinished` more than once for one production. A card is
 * inserted `ON CONFLICT (version_id) DO NOTHING`, and only the call that
 * inserted it notifies; a production that ends with no version claims
 * `work.notified` before its one failure notice. The cost: a crash between
 * the insert and the sends leaves a card the owner sees on the screen only.
 *
 * **A failed delivery returns the card, not a command question (C17).**
 * `reaskFailedCommands` skips delivery jobs; `reraiseFailedDeliveries` moves
 * a card whose delivery job failed from `approved`/`saved` to `failed_send`
 * — the one-time claim — and sends it again with "השליחה הקודמת לא הושלמה"
 * (and "ייתכן שהמייל כבר יצא" when a step row is `unknown`). A `failed_send`
 * card can be approved again: a new delivery job, a new confirmation. The
 * crash gap, stated: the claim commits before the sends, so a crash between
 * them leaves a `failed_send` card the owner sees on the screen only — never
 * a second notice.
 *
 * **"בקשי תיקון" (§8.4)** supersedes the card and its version and opens a new
 * production on a new `boss` job whose instruction is the original plus
 * `\n\nתיקון: ` plus the fix; `typed` only if both halves were typed;
 * recipients re-checked on the joined text. It counts toward
 * `DOCUMENTS_PER_DAY` and is refused up front past it.
 */
import { ulid } from 'ulid';
import { z } from 'zod';
import { loadActiveCharter } from '../charter/store.js';
import { config } from '../config.js';
import { transaction, type BusinessDb } from '../db/pool.js';
import { FORMAT_MEDIA_TYPE, formatAttachmentSize, type AttachmentRef } from '../domain/attachment-ref.js';
import { DocumentCardState } from '../domain/document-spec.js';
import { documentKindLabel } from '../domain/labels.js';
import { Plan } from '../domain/plan.js';
import { loadDocumentSettings } from '../governance/document-settings.js';
import { confirmChoice, createConfirmation } from '../governance/instruction-confirmations.js';
import { MAX_INSTRUCTION_CHARS, saveInstruction } from '../governance/instructions.js';
import {
  authorisedRecipients,
  EMAIL_SHAPE,
  type InstructionTextOrigin,
} from '../governance/typed-recipients.js';
import { emailDomainProblem } from '../domain/charter.js';
import { renderStepEcho } from '../orchestrator/command-echo.js';
import { WHATSAPP_MESSAGE_MAX_CHARS } from '../orchestrator/command-confirm.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { PRODUCTION_TOOLS_MISSING_REASON } from './render-error.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { bindPlanToJob, planHashOf } from '../orchestrator/plan-store.js';
import { toOneLine } from '../util/bidi.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { canonicalAttachmentName, loadVersionFile, readVersionBytes } from './attachments.js';
import { productionCapReason } from './loop.js';
import { UNAUTHORISED_ADDRESS_NOTE } from './produce-input.js';
import {
  createProduction,
  loadProduction,
  loadVersion,
  productionsToday,
  type DocumentVersion,
  type Production,
  type ProductionDestination,
} from './store.js';

// ---------------------------------------------------------------- shapes

export const CardState = DocumentCardState;
export type CardState = DocumentCardState;

/** A card the owner may still act on: fresh, or returned after a failed delivery. */
const ACTIONABLE: readonly CardState[] = ['open', 'failed_send'];

export const DeliveryOption = z
  .object({
    option: z.enum(['send', 'save']),
    /** Fixed Hebrew, built in code — never model output. */
    label: z.string().min(1),
    planHash: z.string().min(1),
    plan: Plan,
  })
  .strict();
export type DeliveryOption = z.infer<typeof DeliveryOption>;

export type ChannelState = 'skipped_not_connected' | 'failed' | 'sent';

export interface DocumentCard {
  cardId: string;
  businessId: string;
  versionId: string;
  state: CardState;
  deliveryPlans: DeliveryOption[];
  whatsappState: string | null;
  emailState: string | null;
  whatsappDeliveredAt: Date | null;
  seenAt: Date | null;
  createdAt: Date;
  decidedAt: Date | null;
  deliveryJobId: string | null;
}

interface CardRow {
  card_id: string;
  business_id: string;
  version_id: string;
  state: string;
  delivery_plans: unknown;
  whatsapp_state: string | null;
  email_state: string | null;
  whatsapp_delivered_at: Date | null;
  seen_at: Date | null;
  created_at: Date;
  decided_at: Date | null;
  delivery_job_id: string | null;
}

/** Parsed back, not cast: stored plans that no longer read as plans are nothing to approve. */
function toCard(row: CardRow): DocumentCard {
  return {
    cardId: row.card_id,
    businessId: row.business_id,
    versionId: row.version_id,
    state: CardState.parse(row.state),
    deliveryPlans: z.array(DeliveryOption).parse(row.delivery_plans),
    whatsappState: row.whatsapp_state,
    emailState: row.email_state,
    whatsappDeliveredAt: row.whatsapp_delivered_at,
    seenAt: row.seen_at,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    deliveryJobId: row.delivery_job_id,
  };
}

export async function loadDocumentCard(
  db: BusinessDb,
  cardId: string,
): Promise<DocumentCard | null> {
  const { rows } = await db.query<CardRow>(
    'SELECT * FROM document_cards WHERE business_id = $1 AND card_id = $2',
    [db.businessId, cardId],
  );
  const row = rows[0];
  return row === undefined ? null : toCard(row);
}

export async function loadCardForVersion(
  db: BusinessDb,
  versionId: string,
): Promise<DocumentCard | null> {
  const { rows } = await db.query<CardRow>(
    'SELECT * FROM document_cards WHERE business_id = $1 AND version_id = $2',
    [db.businessId, versionId],
  );
  const row = rows[0];
  return row === undefined ? null : toCard(row);
}

// ---------------------------------------------------------------- delivery plans

/** Agents per delivery step — fixed in code, the agents whose allowlists hold the tools. */
const SEND_AGENT = 'comms.email';
const SAVE_AGENT = 'prod.docs';

export const SAVE_OPTION_LABEL = 'שמרי במחשב בלבד';
/** The save option of a version that did not pass the checks — the warning rides in the option itself. */
export const SAVE_UNCHECKED_OPTION_LABEL = 'שמרי במחשב בלבד (המסמך לא עבר את הבדיקות — לבדוק לפני שימוש)';

export function sendOptionLabel(to: readonly string[]): string {
  return `שלחי ל-${to.map(toOneLine).join(', ')}`;
}

/** The fixed subject when the owner gave none: `מצורף <סוג>: <כותרת>`. */
export function defaultDeliverySubject(version: DocumentVersion): string {
  return toOneLine(`מצורף ${documentKindLabel[version.spec.kind]}: ${version.spec.title}`).slice(0, 200);
}

function attachmentRefOf(production: Production, version: DocumentVersion): AttachmentRef {
  return {
    producedVersionId: version.versionId,
    sha256: version.sha256,
    filename: canonicalAttachmentName({ spec: version.spec, format: production.format }),
    sizeBytes: version.sizeBytes,
  };
}

/**
 * One delivery plan per option the card shows — deterministic in the
 * production and the version alone, so the server can rebuild it on approval
 * and compare hashes. `send` only on a `ready` production whose destination
 * is a send with at least one authorised recipient; `save` always (the folder
 * the owner named, or none) — labelled with the warning when the version did
 * not pass the checks (C6).
 */
export function buildDeliveryOptions(
  production: Production,
  version: DocumentVersion,
  stage: 'ready' | 'failed_checks',
): DeliveryOption[] {
  const ref = attachmentRefOf(production, version);
  const options: DeliveryOption[] = [];
  const destination: ProductionDestination = production.destination;

  if (stage === 'ready' && destination.mode === 'send' && destination.to.length > 0) {
    const subject = destination.subject !== undefined ? toOneLine(destination.subject) : defaultDeliverySubject(version);
    const body = destination.body ?? `${defaultDeliverySubject(version)}.`;
    const plan = Plan.parse({
      goal: 'מסירת מסמך שאושר',
      steps: [
        {
          id: 'deliver',
          agent: SEND_AGENT,
          intent: 'send the approved document',
          toolName: 'mail.send',
          input: { to: [...destination.to], subject, body, attachments: [ref] },
          expectedActionClass: 'email.initiate',
        },
      ],
    });
    options.push({ option: 'send', label: sendOptionLabel(destination.to), planHash: planHashOf(plan), plan });
  }

  const savePlan = Plan.parse({
    goal: 'שמירת מסמך שאושר',
    steps: [
      {
        id: 'deliver',
        agent: SAVE_AGENT,
        intent: 'save the approved document',
        toolName: 'doc.save',
        input: {
          producedVersionId: ref.producedVersionId,
          sha256: ref.sha256,
          folder: destination.mode === 'save' ? destination.folder : null,
          filename: ref.filename,
        },
        expectedActionClass: 'artifact.write',
      },
    ],
  });
  options.push({
    option: 'save',
    label: stage === 'ready' ? SAVE_OPTION_LABEL : SAVE_UNCHECKED_OPTION_LABEL,
    planHash: planHashOf(savePlan),
    plan: savePlan,
  });
  return options;
}

// ---------------------------------------------------------------- the card text

export const RETRY_PREFIX = 'השליחה הקודמת לא הושלמה';
/** The returned card's first line when the failed delivery was a SAVE, not a send. */
export const SAVE_RETRY_PREFIX = 'השמירה הקודמת לא הושלמה';
/** A save option pressed while no base folder is set (document settings) — refused before any job. */
export const SAVE_NO_BASE_FOLDER_HE = 'לא הוגדרה תיקיית בסיס לשמירה — אפשר להגדיר אותה בהגדרות המסמכים ואז לאשר שוב.';
/**
 * The line every card notice ends with: a fresh id per notice, never stored.
 * The email seam's idempotency key is derived from the content
 * (`documentCardAlertKey`), and two notices of the same card — a re-raise
 * after a second failed delivery — are otherwise byte-identical: the mail
 * server would drop the second as a duplicate while the send reports ok.
 */
export const NOTICE_ID_LABEL = 'מזהה הודעה';
export const MAY_HAVE_SENT_LINE = 'ייתכן שהמייל כבר יצא';
/**
 * The WhatsApp caption when the card is longer than one WhatsApp message
 * (`WHATSAPP_MESSAGE_MAX_CHARS`) — never a truncated card, the
 * command-confirm pattern. Such a card is answered on the dashboard only:
 * `whatsapp_delivered_at` is not stamped for it.
 */
export const CARD_TOO_LONG_FOR_WHATSAPP =
  'כרטיס המסמך ארוך מדי להודעת וואטסאפ אחת — אפשר לקרוא אותו ולאשר אותו רק בדשבורד.';

export interface CardTextInput {
  cardId: string;
  production: Production;
  version: DocumentVersion;
  options: readonly DeliveryOption[];
  stage: 'ready' | 'failed_checks';
  currency: string;
  dashboardBaseUrl?: string;
  prefix?: readonly string[];
}

/** What the owner reads on email and WhatsApp. Deterministic; no model. */
export function renderCardText(input: CardTextInput): string {
  const { production, version } = input;
  const kind = documentKindLabel[version.spec.kind];
  const title = toOneLine(version.spec.title);
  const lines: string[] = [...(input.prefix ?? [])];
  lines.push(
    input.stage === 'ready'
      ? `המסמך מוכן לבדיקתך: ${kind} — ${title}`
      : `המסמך לא עבר את הבדיקות: ${kind} — ${title}`,
  );
  const ref = attachmentRefOf(production, version);
  lines.push(`קובץ: ${ref.filename} · ${formatAttachmentSize(ref.sizeBytes)} · ${ref.sha256.slice(0, 12)}`);
  if (input.stage === 'failed_checks') {
    for (const finding of production.findings) lines.push(`• ${finding.he} — ${toOneLine(finding.where)}`);
  }
  for (const note of production.work.notes) lines.push(`• ${note}`);
  if (input.options.length > 0) {
    lines.push('', 'אפשרויות:');
    input.options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option.label}`);
      for (const step of option.plan.steps) {
        for (const echo of renderStepEcho(step, input.currency).split('\n')) lines.push(`    ${echo}`);
      }
    });
    lines.push(`${input.options.length + 1}. בקשי תיקון`);
  } else {
    lines.push('', 'אפשר לבקש תיקון.');
  }
  const where =
    input.dashboardBaseUrl === undefined ? 'בדשבורד' : `${input.dashboardBaseUrl.replace(/\/+$/, '')}/documents`;
  lines.push('', `לאישור, לתיקון או להורדה: ${where}`, `מזהה כרטיס: ${input.cardId}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- notifications

export interface CardSeams {
  sendAlert?: (subject: string, body: string) => Promise<{ ok: boolean; error?: string }>;
  sendAlertWithAttachment?: (
    subject: string,
    body: string,
    attachment: { filename: string; mediaType: string; bytes: Buffer },
  ) => Promise<{ ok: boolean; error?: string }>;
  messenger?: BossMessenger;
  dashboardBaseUrl?: string;
  /**
   * Where produced files live — the card's file is read from under it.
   * Threaded from the scheduler like the production loop's; the public entry
   * points (`createDocumentCard`, `reraiseFailedDeliveries`,
   * `addTypedRecipient`) alone fall back to `config.documentRoot`.
   */
  documentRoot?: string;
}

export interface CardNotice {
  email: ChannelState | null;
  whatsapp: ChannelState | null;
}

async function settle(run: () => Promise<{ ok: boolean }>): Promise<ChannelState> {
  try {
    return (await run()).ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Send the card on the owner's chosen channels and record each channel's state. Never throws for a send. */
async function notifyCard(
  db: BusinessDb,
  card: { cardId: string },
  production: Production,
  version: DocumentVersion,
  text: string,
  seams: CardSeams,
  documentRoot: string,
): Promise<CardNotice> {
  const settings = await loadDocumentSettings({ businessId: db.businessId, db });
  const notice: CardNotice = { email: null, whatsapp: null };
  // A fresh id per notice (I2) — see `NOTICE_ID_LABEL`.
  text = `${text}\n${NOTICE_ID_LABEL}: ${ulid()}`;
  const subject = `מסמך לבדיקתך: ${toOneLine(version.spec.title)}`.slice(0, 200);

  let bytes: Buffer | null = null;
  const fileOnce = async (): Promise<Buffer | null> => {
    if (bytes !== null) return bytes;
    const file = await loadVersionFile(db, version.versionId);
    if (file === null) return null;
    const read = await readVersionBytes(file, { sha256: version.sha256, sizeBytes: version.sizeBytes }, documentRoot);
    bytes = read.ok ? read.bytes : null;
    return bytes;
  };
  const attachment = (b: Buffer) => ({
    filename: canonicalAttachmentName({ spec: version.spec, format: production.format }),
    mediaType: FORMAT_MEDIA_TYPE[production.format],
    bytes: b,
  });

  if (settings.toEmail) {
    const send = seams.sendAlertWithAttachment;
    notice.email =
      send === undefined
        ? 'skipped_not_connected'
        : await settle(async () => {
            const b = await fileOnce();
            return b === null ? { ok: false } : send(subject, text, attachment(b));
          });
  }
  let whatsappAnswerable = false;
  if (settings.toWhatsApp) {
    const sendFile = seams.messenger?.sendFile?.bind(seams.messenger);
    const tooLong = text.length > WHATSAPP_MESSAGE_MAX_CHARS;
    notice.whatsapp =
      sendFile === undefined
        ? 'skipped_not_connected'
        : await settle(async () => {
            const b = await fileOnce();
            if (b === null) return { ok: false };
            const a = attachment(b);
            return sendFile({ ...a, caption: tooLong ? CARD_TOO_LONG_FOR_WHATSAPP : text, jobId: null });
          });
    whatsappAnswerable = notice.whatsapp === 'sent' && !tooLong;
  }

  await db.query(
    `UPDATE document_cards
        SET email_state = COALESCE($3, email_state),
            whatsapp_state = COALESCE($4, whatsapp_state),
            whatsapp_delivered_at = CASE WHEN $5::boolean THEN now() ELSE whatsapp_delivered_at END
      WHERE business_id = $1 AND card_id = $2`,
    [db.businessId, card.cardId, notice.email, notice.whatsapp, whatsappAnswerable],
  );
  return notice;
}

/**
 * The card cannot be rendered — the charter is unreadable or missing, so
 * its amounts would be shown in a guessed currency. Nothing is sent; each
 * channel the owner chose records `failed`, and the card itself stays on
 * the dashboard. Never throws for a send: it runs after the card row
 * committed.
 */
async function recordNoticeFailure(db: BusinessDb, card: { cardId: string }): Promise<CardNotice> {
  const settings = await loadDocumentSettings({ businessId: db.businessId, db });
  const notice: CardNotice = {
    email: settings.toEmail ? 'failed' : null,
    whatsapp: settings.toWhatsApp ? 'failed' : null,
  };
  await db.query(
    `UPDATE document_cards
        SET email_state = COALESCE($3, email_state),
            whatsapp_state = COALESCE($4, whatsapp_state)
      WHERE business_id = $1 AND card_id = $2`,
    [db.businessId, card.cardId, notice.email, notice.whatsapp],
  );
  return notice;
}

/** The active charter's currency, or `null` when the charter is missing or unreadable. */
async function charterCurrency(db: BusinessDb): Promise<string | null> {
  try {
    const active = await loadActiveCharter(db);
    return active === null ? null : active.bundle.ceilings.currency;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- creation

export type CreateCardOptions = CardSeams;

export type CreateCardResult =
  | { status: 'created'; cardId: string; notice: CardNotice }
  | { status: 'exists'; cardId: string };

/**
 * The card for one finished version. Idempotent on `version_id`: a second
 * call (the loop's at-least-once `onFinished`) finds the card and does
 * nothing — only the call that inserted it notifies.
 */
export async function createDocumentCard(
  db: BusinessDb,
  versionId: string,
  options: CreateCardOptions = {},
): Promise<CreateCardResult> {
  const businessId = db.businessId;
  const version = await loadVersion(db, versionId);
  if (version === null) throw new Error(`createDocumentCard: no version ${versionId} in ${businessId}`);
  const production = await loadProduction(db, version.productionId);
  if (production === null) throw new Error(`createDocumentCard: no production for ${versionId}`);
  if (production.stage !== 'ready' && production.stage !== 'failed_checks') {
    throw new Error(`createDocumentCard: production ${production.productionId} is ${production.stage}`);
  }
  const stage = production.stage;
  const optionsBuilt = buildDeliveryOptions(production, version, stage);
  const cardId = `DC-${versionId.replace(/^DV-/, '')}`;

  const inserted = await db.query<{ card_id: string }>(
    `INSERT INTO document_cards (card_id, business_id, version_id, state, delivery_plans)
     VALUES ($1, $2, $3, 'open', $4::jsonb)
     ON CONFLICT (version_id) DO NOTHING
     RETURNING card_id`,
    [cardId, businessId, versionId, JSON.stringify(optionsBuilt)],
  );
  if (inserted.rows.length === 0) {
    const existing = await loadCardForVersion(db, versionId);
    return { status: 'exists', cardId: existing?.cardId ?? cardId };
  }

  const currency = await charterCurrency(db);
  if (currency === null) {
    return { status: 'created', cardId, notice: await recordNoticeFailure(db, { cardId }) };
  }
  const text = renderCardText({
    cardId,
    production,
    version,
    options: optionsBuilt,
    stage,
    currency,
    ...(options.dashboardBaseUrl !== undefined ? { dashboardBaseUrl: options.dashboardBaseUrl } : {}),
  });
  const notice = await notifyCard(
    db,
    { cardId },
    production,
    version,
    text,
    options,
    options.documentRoot ?? config.documentRoot,
  );
  return { status: 'created', cardId, notice };
}

export function productionFailedText(reason: string, productionId: string): string {
  return `הפקת המסמך נכשלה: ${reason}\nמזהה הפקה: ${productionId}`;
}

/**
 * The production loop's `onFinished` (ruling R4): a card for a version, or —
 * when the production ended with none — one failure notice, claimed once on
 * `work.notified`. Email through `sendAlert`, WhatsApp through `send`, by
 * the owner's channel choice; the screen shows the production's state.
 */
export async function onProductionFinished(
  db: BusinessDb,
  finished: { productionId: string; versionId: string | null; stage: 'ready' | 'failed_checks' | 'failed'; reason: string | null },
  options: CreateCardOptions = {},
): Promise<void> {
  if (finished.versionId !== null && finished.stage !== 'failed') {
    await createDocumentCard(db, finished.versionId, options);
    return;
  }

  const claimed = await db.query(
    `UPDATE document_productions
        SET work = work || '{"notified": true}'::jsonb
      WHERE business_id = $1 AND production_id = $2
        AND COALESCE((work->>'notified')::boolean, false) = false
      RETURNING production_id`,
    [db.businessId, finished.productionId],
  );
  if (claimed.rows.length === 0) return;

  const production = await loadProduction(db, finished.productionId);
  const reason =
    finished.reason ??
    (production?.findings.map((f) => f.he).join('; ') || 'המסמך לא עבר את הבדיקות');
  const text = productionFailedText(reason, finished.productionId);
  const settings = await loadDocumentSettings({ businessId: db.businessId, db });
  if (settings.toEmail && options.sendAlert !== undefined) {
    await settle(() => options.sendAlert!('הפקת מסמך נכשלה', text));
  }
  if (settings.toWhatsApp && options.messenger !== undefined) {
    await settle(() => options.messenger!.send({ text, jobId: production?.originJobId ?? null }));
  }
}

// ---------------------------------------------------------------- approval

export type ApproveOutcome =
  | { status: 'approved'; jobId: string; option: 'send' | 'save' }
  | { status: 'card_stale' }
  | { status: 'not_open'; state: CardState }
  /** A WhatsApp answer the card was not open for: not delivered there, answered before delivery, or past the window. */
  | { status: 'not_answerable' }
  /** A save option while no base folder is set (`SAVE_NO_BASE_FOLDER_HE`) — not stale: the card is fine, the settings are not. */
  | { status: 'no_base_folder'; reason: string }
  | { status: 'not_found' };

/**
 * Whether a WhatsApp message sent at `inboundAt` can answer a card delivered
 * at `deliveredAt`: delivered, strictly after the delivery, and the delivery
 * inside the question window. The same rule the door applies before it
 * claims the message — re-checked under the card's row lock, because the
 * delivery stamp can move in between (a typed address withdraws it, C12).
 */
export function whatsappAnswerable(
  deliveredAt: Date | null,
  inboundAt: Date | undefined,
  options: { now?: number; windowMinutes?: number } = {},
): boolean {
  if (deliveredAt === null || inboundAt === undefined) return false;
  const windowMinutes = options.windowMinutes ?? config.whatsappQuestionWindowMinutes;
  if (windowMinutes <= 0) return false;
  const delivered = deliveredAt.getTime();
  const inbound = inboundAt.getTime();
  if (Number.isNaN(delivered) || Number.isNaN(inbound)) return false;
  if (!(inbound > delivered)) return false;
  return (options.now ?? Date.now()) - delivered <= windowMinutes * 60_000;
}

interface LockedCard {
  card: DocumentCard;
  production: Production;
  version: DocumentVersion;
}

async function lockCard(tx: BusinessDb, cardId: string): Promise<LockedCard | null> {
  const { rows } = await tx.query<CardRow>(
    'SELECT * FROM document_cards WHERE business_id = $1 AND card_id = $2 FOR UPDATE',
    [tx.businessId, cardId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const card = toCard(row);
  const version = await loadVersion(tx, card.versionId);
  if (version === null) return null;
  const production = await loadProduction(tx, version.productionId);
  if (production === null) return null;
  return { card, production, version };
}

/**
 * The owner pressed one option. See the module docblock: one transaction,
 * under the card's row lock, so a double approve creates one job and a
 * concurrent fix request and approval cannot both win.
 */
export async function approveDocumentCard(
  db: BusinessDb,
  cardId: string,
  planHash: string,
  actor: 'dashboard' | 'whatsapp',
  options: {
    /**
     * When the WhatsApp answer was sent (provider timestamp). Required for
     * `actor: 'whatsapp'` — absent, the answer is refused: the time gate is
     * re-checked here, under the card's lock (`whatsappAnswerable`).
     */
    whatsappInboundAt?: Date;
    windowMinutes?: number;
  } = {},
): Promise<ApproveOutcome> {
  const businessId = db.businessId;
  return transaction(db, async (tx) => {
    const locked = await lockCard(tx, cardId);
    if (locked === null) return { status: 'not_found' };
    const { card, production, version } = locked;
    if (!ACTIONABLE.includes(card.state)) return { status: 'not_open', state: card.state };
    if (
      actor === 'whatsapp' &&
      !whatsappAnswerable(card.whatsappDeliveredAt, options.whatsappInboundAt, {
        ...(options.windowMinutes !== undefined ? { windowMinutes: options.windowMinutes } : {}),
      })
    ) {
      return { status: 'not_answerable' };
    }
    if (version.supersededAt !== null) return { status: 'card_stale' };
    if (production.stage !== 'ready' && production.stage !== 'failed_checks') return { status: 'card_stale' };
    const stage = production.stage;

    // The plan the owner pressed must be the plan stored on the card AND the
    // plan the server builds now from the same production and version.
    const stored = card.deliveryPlans.find((option) => option.planHash === planHash);
    const rebuilt = buildDeliveryOptions(production, version, stage).find((option) => option.planHash === planHash);
    if (stored === undefined || rebuilt === undefined || planHashOf(stored.plan) !== planHash) {
      return { status: 'card_stale' };
    }
    // Defence in depth (C6): a send only ever on a version that passed.
    if (rebuilt.option === 'send' && stage !== 'ready') return { status: 'card_stale' };
    // A save with nowhere to save to would only fail in `doc.save`
    // (`save_no_base_folder`) and come back as a returned card; refuse it here.
    if (rebuilt.option === 'save') {
      const settings = await loadDocumentSettings({ businessId, db: tx });
      if (settings.baseFolder === null) return { status: 'no_base_folder', reason: SAVE_NO_BASE_FOLDER_HE };
    }

    const active = await loadActiveCharter(tx);
    if (active === null) throw new Error(`approveDocumentCard: no active charter for ${businessId}`);

    const job = await createJob(tx, {
      charterVersion: active.charter.charterVersion,
      // A literal, as at the instruction door: the owner pressed it.
      provenance: 'boss',
      title: toOneLine(`מסירת מסמך: ${version.spec.title}`).slice(0, 80),
    });
    await saveInstruction(
      { jobId: job.jobId, text: production.instructionText, textOrigin: production.textOrigin },
      { businessId, db: tx },
    );
    for (const to of ['understand', 'plan'] as const) {
      await transition(tx, job.jobId, { to, actor: 'human', reason: `document card ${cardId}` });
    }
    const binding = await bindPlanToJob(tx, job.jobId, rebuilt.plan);
    if (binding.status !== 'stored' || binding.planHash !== planHash) {
      throw new Error(`approveDocumentCard: job ${job.jobId} could not be bound to ${planHash}`);
    }
    const presentedText = renderCardText({
      cardId,
      production,
      version,
      options: card.deliveryPlans,
      stage,
      currency: active.bundle.ceilings.currency,
    });
    await createConfirmation(
      {
        jobId: job.jobId,
        options: [{ label: rebuilt.label, planHash, plan: rebuilt.plan, contactSource: null }],
        presentedText,
        channel: actor,
      },
      { businessId, db: tx },
    );
    if (!(await confirmChoice(job.jobId, planHash, `owner:${actor}`, { businessId, db: tx }))) {
      throw new Error(`approveDocumentCard: confirmation for ${job.jobId} could not be confirmed`);
    }
    await transition(tx, job.jobId, {
      to: 'execute',
      actor: 'human',
      reason: `document card ${cardId}: approved`,
      expectFrom: 'plan',
    });
    // The only writer of `delivery_job_id` (carry (a)), on the job just made.
    await tx.query(
      `UPDATE document_cards
          SET state = $3, delivery_job_id = $4, decided_at = now()
        WHERE business_id = $1 AND card_id = $2`,
      [businessId, cardId, rebuilt.option === 'send' ? 'approved' : 'saved', job.jobId],
    );
    // The durable record of every delivery job (migration 055).
    await tx.query(
      `INSERT INTO document_deliveries (job_id, business_id, card_id, version_id) VALUES ($1, $2, $3, $4)`,
      [job.jobId, businessId, cardId, version.versionId],
    );
    return { status: 'approved', jobId: job.jobId, option: rebuilt.option };
  });
}

// ---------------------------------------------------------------- a typed address (C12)

export const TYPED_ADDRESS_INVALID_HE = 'הכתובת אינה כתובת מייל תקינה.';
export const TYPED_ADDRESS_NOT_APPLICABLE_HE =
  'אפשר להוסיף כתובת רק לכרטיס פתוח של מסמך שעבר את הבדיקות ונועד לשליחה, ושאין בו עדיין נמען.';

/** Anything that renders invisibly or reorders text: an address carrying one is not the address shown. */
const INVISIBLE_IN_ADDRESS = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2069}\u{feff}]/u;

/**
 * The address the owner typed on the card is a valid single address, or a
 * Hebrew refusal. Shape: `EMAIL_SHAPE`, a domain `emailDomainProblem`
 * accepts, nothing invisible, at most 320 characters.
 */
export function typedAddressProblem(raw: string): string | null {
  const address = raw.trim();
  if (address.length === 0 || address.length > 320) return TYPED_ADDRESS_INVALID_HE;
  if (INVISIBLE_IN_ADDRESS.test(address)) return TYPED_ADDRESS_INVALID_HE;
  if (!EMAIL_SHAPE.test(address)) return TYPED_ADDRESS_INVALID_HE;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  if (emailDomainProblem(domain) !== null) return TYPED_ADDRESS_INVALID_HE;
  return null;
}

/**
 * What became of the re-send after a typed address — recorded, never thrown:
 * the address is saved either way. `skipped_no_seams`: no notification seam
 * here (the dashboard process), channel states left as they were;
 * `skipped_charter_unreadable`: no currency to show amounts in, so no card is
 * rendered at all; `failed`: the render or the sends threw.
 */
export type TypedAddressResend = 'sent' | 'skipped_no_seams' | 'skipped_charter_unreadable' | 'failed';

export type TypedAddressOutcome =
  | { status: 'added'; planHash: string; resend: TypedAddressResend }
  | { status: 'refused'; reason: string }
  | { status: 'not_open'; state: CardState }
  | { status: 'not_found' };

/**
 * C12: a card whose production was meant to be SENT but has no authorised
 * recipient shows an address field instead of "שלחי". What the owner types
 * there is his own keystrokes on the dashboard — the authority C12 rules it
 * is — and it becomes the production's recipient; the card's options are
 * then rebuilt by `buildDeliveryOptions`, the SAME builder approval rebuilds
 * from, so the new send option is approved exactly like any other (the
 * plan hash pressed must equal the hash stored AND the hash rebuilt).
 *
 * Nothing is approved here, and nothing is sent: the owner still presses the
 * new "שלחי ל…" button, which shows the full echo first. One address only;
 * only on an open card of a `ready` production whose destination is a send
 * with no recipient left after `authorisedRecipients`; under the card's row
 * lock, so it cannot race an approval or a fix.
 */
export async function addTypedRecipient(
  db: BusinessDb,
  cardId: string,
  typed: string,
  options: CardSeams = {},
): Promise<TypedAddressOutcome> {
  const businessId = db.businessId;
  const problem = typedAddressProblem(typed);
  if (problem !== null) return { status: 'refused', reason: problem };
  const address = typed.trim();

  const outcome = await transaction<TypedAddressOutcome | { status: 'saved'; planHash: string }>(db, async (tx) => {
    const locked = await lockCard(tx, cardId);
    if (locked === null) return { status: 'not_found' };
    const { card, production, version } = locked;
    if (!ACTIONABLE.includes(card.state)) return { status: 'not_open', state: card.state };
    if (
      version.supersededAt !== null ||
      production.stage !== 'ready' ||
      production.destination.mode !== 'send' ||
      production.destination.to.length > 0
    ) {
      return { status: 'refused', reason: TYPED_ADDRESS_NOT_APPLICABLE_HE };
    }
    const destination: ProductionDestination = { ...production.destination, to: [address] };
    await tx.query(
      `UPDATE document_productions SET destination = $3::jsonb, updated_at = now()
        WHERE business_id = $1 AND production_id = $2`,
      [businessId, production.productionId, JSON.stringify(destination)],
    );
    const rebuilt = buildDeliveryOptions({ ...production, destination }, version, 'ready');
    // The WhatsApp delivery is withdrawn with the old options: the message
    // the owner has there does not show this address, so no answer to it may
    // approve the option that sends to it.
    await tx.query(
      `UPDATE document_cards SET delivery_plans = $3::jsonb, whatsapp_delivered_at = NULL
        WHERE business_id = $1 AND card_id = $2`,
      [businessId, cardId, JSON.stringify(rebuilt)],
    );
    const send = rebuilt.find((option) => option.option === 'send');
    if (send === undefined) throw new Error(`addTypedRecipient: no send option rebuilt for ${cardId}`);
    return { status: 'saved', planHash: send.planHash };
  });
  if (outcome.status !== 'saved') return outcome;
  return { status: 'added', planHash: outcome.planHash, resend: await resendAfterTypedAddress(db, cardId, options) };
}

/**
 * The card as it now stands goes out again on the owner's channels; only
 * that delivery, which shows the address, can be answered on WhatsApp. Runs
 * after the address is committed, so nothing here can undo it: every
 * failure is a recorded outcome, never a throw. With no seam at all nothing
 * is written — a process that cannot notify must not overwrite the states a
 * process that could recorded. With no readable charter no card is rendered
 * — amounts are never shown in a guessed currency.
 */
async function resendAfterTypedAddress(
  db: BusinessDb,
  cardId: string,
  options: CardSeams,
): Promise<TypedAddressResend> {
  if (options.sendAlertWithAttachment === undefined && options.messenger?.sendFile === undefined) {
    return 'skipped_no_seams';
  }
  try {
    let active: Awaited<ReturnType<typeof loadActiveCharter>>;
    try {
      active = await loadActiveCharter(db);
    } catch {
      return 'skipped_charter_unreadable';
    }
    if (active === null) return 'skipped_charter_unreadable';
    const card = await loadDocumentCard(db, cardId);
    const version = card === null ? null : await loadVersion(db, card.versionId);
    const production = version === null ? null : await loadProduction(db, version.productionId);
    if (card === null || version === null || production === null) return 'failed';
    const text = renderCardText({
      cardId,
      production,
      version,
      options: card.deliveryPlans,
      stage: 'ready',
      currency: active.bundle.ceilings.currency,
      ...(options.dashboardBaseUrl !== undefined ? { dashboardBaseUrl: options.dashboardBaseUrl } : {}),
    });
    await notifyCard(db, card, production, version, text, options, options.documentRoot ?? config.documentRoot);
    return 'sent';
  } catch (err) {
    console.error(
      `addTypedRecipient: card ${cardId} saved, re-send failed:`,
      err instanceof Error ? err.message : err,
    );
    return 'failed';
  }
}

// ---------------------------------------------------------------- request a fix

export const FIX_SEPARATOR = '\n\nתיקון: ';
export const FIX_EMPTY_HE = 'כתבי מה לתקן.';
export const FIX_TOO_LONG_HE = `ההוראה עם התיקון ארוכה מ-${MAX_INSTRUCTION_CHARS} תווים.`;

export type FixOutcome =
  | { status: 'opened'; productionId: string; jobId: string }
  | { status: 'refused'; reason: string }
  | { status: 'not_open'; state: CardState }
  | { status: 'not_found' };

export async function requestFix(
  db: BusinessDb,
  cardId: string,
  text: string,
  actor: 'dashboard' | 'whatsapp',
  textOrigin: InstructionTextOrigin,
  options: {
    /**
     * `runtime.production` — required, though it may be `undefined`: a fix is
     * a new production, and a server that cannot produce refuses it up front
     * instead of superseding the card for a production that can only fail.
     */
    production: Runtime['production'] | undefined;
    perDay?: number;
    now?: Date;
  },
): Promise<FixOutcome> {
  const businessId = db.businessId;
  const fix = text.trim();
  if (fix === '') return { status: 'refused', reason: FIX_EMPTY_HE };
  const tools = options.production;
  if (!(tools?.available === true && tools.sofficePath !== null && tools.chromiumPath !== null)) {
    return { status: 'refused', reason: PRODUCTION_TOOLS_MISSING_REASON };
  }

  return transaction(db, async (tx) => {
    const locked = await lockCard(tx, cardId);
    if (locked === null) return { status: 'not_found' };
    const { card, production, version } = locked;
    if (!ACTIONABLE.includes(card.state)) return { status: 'not_open', state: card.state };

    const instruction = `${production.instructionText}${FIX_SEPARATOR}${fix}`;
    if (instruction.length > MAX_INSTRUCTION_CHARS) return { status: 'refused', reason: FIX_TOO_LONG_HE };
    // Typed only when both halves were typed (the rule for clarifying answers).
    const origin: InstructionTextOrigin =
      production.textOrigin === 'typed' && textOrigin === 'typed' ? 'typed' : 'transcribed';

    const active = await loadActiveCharter(tx);
    if (active === null) throw new Error(`requestFix: no active charter for ${businessId}`);
    const perDay = options.perDay ?? config.documentsPerDay;
    if ((await productionsToday(tx, active.charter.identity.timezone, options.now)) >= perDay) {
      return { status: 'refused', reason: productionCapReason(perDay) };
    }

    // Recipients re-checked on the joined text and its joined origin.
    const notes = production.work.notes.filter((note) => !note.startsWith(UNAUTHORISED_ADDRESS_NOTE));
    let destination: ProductionDestination = production.destination;
    if (destination.mode === 'send') {
      const authorised = authorisedRecipients({
        instruction,
        textOrigin: origin,
        actionClass: 'email.initiate',
        candidates: destination.to,
        known: active.bundle.knownCounterparties,
      });
      for (const address of destination.to) {
        if (!authorised.includes(address)) notes.push(`${UNAUTHORISED_ADDRESS_NOTE}: ${toOneLine(address)}`);
      }
      destination = { ...destination, to: authorised };
    }

    const job = await createJob(tx, {
      charterVersion: active.charter.charterVersion,
      provenance: 'boss',
      title: toOneLine(`תיקון מסמך: ${version.spec.title}`).slice(0, 80),
    });
    await saveInstruction({ jobId: job.jobId, text: instruction, textOrigin: origin }, { businessId, db: tx });
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await transition(tx, job.jobId, { to, actor: 'human', reason: `document card ${cardId}: fix (${actor})` });
    }
    const productionId = await createProduction(
      tx,
      {
        originJobId: job.jobId,
        instructionText: instruction,
        textOrigin: origin,
        format: production.format,
        language: production.language,
        kind: production.kind,
        destination,
        sourceDocumentIds: production.sourceDocumentIds,
        notes,
        // The fix is the same request: the owner's own sources stay his.
        ownerSourceIds: production.work.ownerSourceIds,
      },
    );
    // Parked like `doc.produce` parks: the production loop closes it.
    await transition(tx, job.jobId, {
      to: 'followup',
      actor: 'orchestrator',
      reason: `doc.produce: production ${productionId} queued (fix of ${cardId})`,
      wakeAt: null,
    });
    await tx.query(
      `UPDATE document_cards SET state = 'superseded', decided_at = now() WHERE business_id = $1 AND card_id = $2`,
      [businessId, cardId],
    );
    await tx.query(
      `UPDATE document_versions SET superseded_at = now() WHERE version_id = $1 AND superseded_at IS NULL`,
      [version.versionId],
    );
    return { status: 'opened', productionId, jobId: job.jobId };
  });
}

// ---------------------------------------------------------------- a failed delivery returns the card

export interface ReraiseResult {
  reraised: { cardId: string; jobId: string; mayHaveSent: boolean }[];
  errored: { cardId: string; error: string }[];
}

/**
 * C17: a card whose delivery job failed comes back to the owner once per
 * failure. The claim is the conditional move `approved|saved → failed_send`
 * on that very job; only the call that made it sends.
 */
export async function reraiseFailedDeliveries(db: BusinessDb, options: CardSeams = {}): Promise<ReraiseResult> {
  const businessId = db.businessId;
  const result: ReraiseResult = { reraised: [], errored: [] };
  const { rows } = await db.query<{ card_id: string; delivery_job_id: string; state: string; may_have_sent: boolean }>(
    `SELECT c.card_id, c.delivery_job_id, c.state,
            EXISTS (SELECT 1 FROM job_step_results r
                     WHERE r.business_id = c.business_id AND r.job_id = c.delivery_job_id
                       AND r.status = 'unknown') AS may_have_sent
       FROM document_cards c
       JOIN jobs j ON j.business_id = c.business_id AND j.job_id = c.delivery_job_id
      WHERE c.business_id = $1 AND c.state IN ('approved', 'saved') AND j.phase = 'failed'
      ORDER BY c.card_id`,
    [businessId],
  );
  for (const row of rows) {
    try {
      const claimed = await db.query(
        `UPDATE document_cards SET state = 'failed_send'
          WHERE business_id = $1 AND card_id = $2 AND delivery_job_id = $3 AND state IN ('approved', 'saved')
          RETURNING card_id`,
        [businessId, row.card_id, row.delivery_job_id],
      );
      if (claimed.rows.length === 0) continue;
      const card = await loadDocumentCard(db, row.card_id);
      if (card === null) continue;
      const version = await loadVersion(db, card.versionId);
      const production = version === null ? null : await loadProduction(db, version.productionId);
      if (version === null || production === null) continue;
      const currency = await charterCurrency(db);
      if (currency === null) {
        // The claim already moved the card to `failed_send`: it stays on the
        // dashboard, and the owner's channels record the notice as failed.
        await recordNoticeFailure(db, card);
        result.errored.push({ cardId: card.cardId, error: 'charter_unreadable' });
        continue;
      }
      // A failed SAVE is told as a save (`saved` was the state the claim
      // moved from); a send keeps the may-have-sent line after a timeout.
      const prefix =
        row.state === 'saved'
          ? [SAVE_RETRY_PREFIX]
          : row.may_have_sent
            ? [RETRY_PREFIX, MAY_HAVE_SENT_LINE]
            : [RETRY_PREFIX];
      const text = renderCardText({
        cardId: card.cardId,
        production,
        version,
        options: card.deliveryPlans,
        stage: production.stage === 'failed_checks' ? 'failed_checks' : 'ready',
        currency,
        prefix,
        ...(options.dashboardBaseUrl !== undefined ? { dashboardBaseUrl: options.dashboardBaseUrl } : {}),
      });
      await notifyCard(db, card, production, version, text, options, options.documentRoot ?? config.documentRoot);
      result.reraised.push({ cardId: card.cardId, jobId: row.delivery_job_id, mayHaveSent: row.may_have_sent });
    } catch (err) {
      result.errored.push({ cardId: row.card_id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
