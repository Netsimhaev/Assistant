/**
 * The contact flow: what the WhatsApp door does with a message from someone
 * who is not the owner, once the business has signed the `whatsapp-contacts`
 * connection.
 *
 *   - A colleague, or a number that does not parse (a group id, a bare-digit
 *     form): recorded and settled — nothing is answered, nothing is drafted.
 *   - A managed contact (client/supplier the owner vouched for) or an unknown
 *     number: the message joins the number's one live conversation, the fixed
 *     holding reply goes out once (`sendHoldingReply`, the one documented gate
 *     bypass), and the owner gets ONE card with a drafted reply.
 *
 * **Nothing reaches the contact from here except the holding reply.** The
 * drafted text rides an `unknown_external` job's approval card; only the
 * owner's "שלח" moves it, through the gate (`approvedReplyCovers`).
 *
 * **One draft per conversation per door pass (Review Focus 1).** The door
 * collects every contact message of the pass and hands them in together;
 * a burst of five messages is one conversation, one holding reply, one model
 * run over all five, and one live card.
 *
 * **What the model sees, by sender.** A contact: its own tier-2 sources
 * (keyed by the sender's identity only — never by what the message says),
 * tier-3 internal documents through the quarantined researcher, and the last
 * ten messages of the number. An unknown number: the conversation only — no
 * tier-2 call, no researcher. Every call runs under its own deadline, and any
 * failure (or a source that returned someone else's data) still raises a
 * card, with the reason in Hebrew.
 *
 * **Caps before money.** The business's `contactWaReadsPerDay` (model runs,
 * counted from `contact_draft` audit rows) and 30 messages per contact per
 * day; over either, the card is raised with no draft and no model call.
 *
 * **A card that is already approved and being sent is never replaced
 * (ruling R11a).** The new message stays on the conversation, settles with
 * the current card's job, and the owner gets one short note naming the
 * contact and the message — no re-draft.
 *
 * **Media.** A voice note from a contact or an unknown number is transcribed
 * under the shared non-owner transcription cap when a provider is wired. An
 * image or a document cannot be read here: the inbound message carries no
 * download seam for them (`NormalizedInboundMessage` has `downloadAudio`
 * only), so the card says a file arrived unread.
 */
import { withBusiness, type BusinessDb } from '../db/pool.js';
import type { BusinessCharter } from '../domain/charter.js';
import type { PolicyBundle } from '../domain/policy.js';
import { appendAudit } from '../audit/log.js';
import { checkKillSwitch } from '../governance/killswitch.js';
import { descriptionFragment } from '../business/description-store.js';
import { profileFragment } from '../business/profile.js';
import type { NotifyTarget } from '../orchestrator/proposal-approval.js';
import type { ContactClassifier } from '../sdk/contact-classifier.js';
import type { ContactDraftOutcome, ContactDrafter } from '../sdk/contact-drafter.js';
import { loadResearchIndex, type ContactResearcher } from '../sdk/contact-researcher.js';
import { capFor, loadRuntimeSettings } from '../tenancy/runtime-settings.js';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import { canonicalHash } from '../util/canonical.js';
import type { CardContext } from './card-context.js';
import { CLASSIFY_TIMEOUT_MS, autoGate, classifyConversation, hasLiveCard, loadOtherPeople, namedRuns, sourceRuns, topicFor } from './contact-auto.js';
import type { Classification } from './contact-classification.js';
import type { ContactTopic } from './contact-topics.js';
import { exitChecks } from './exit-checks.js';
import { publicSourceItems } from './sources/public-source.js';
import {
  ContactCardBusyError,
  cardTakeoverBlocked,
  loadAttachmentInfo,
  presentContactCard,
  raiseContactCard,
} from './contact-card.js';
import { loadConversation, openOrAppend, recentMessages, type ContactConversation } from './contact-conversations.js';
import type { ResolvedSender } from './contact-identity.js';
import type { NormalizedInboundMessage, WhatsAppGateway } from './gateway.js';
import { sendHoldingReply } from './holding-reply.js';
import type { BossMessenger } from './messenger.js';
import type { SenderIds, SourceItem, Tier2Source } from './sources/types.js';
import { claimMessage, settleMessage } from './store.js';
import { transcribeInbound, type TranscriptionProvider } from './transcribe.js';

/** Audit reason prefix of one model run over a conversation; the suffix is the message count. */
export const CONTACT_DRAFT_REASON = 'contact_draft';
/** Messages per contact per day a model may process (constant, spec). */
export const CONTACT_MESSAGES_PER_CONTACT_PER_DAY = 30;
export const TIER2_TIMEOUT_MS = 30_000;
export const RESEARCH_TIMEOUT_MS = 60_000;
export const DRAFT_TIMEOUT_MS = 60_000;

export const REASON_CAPPED = 'הגיעה התקרה היומית — לא נוסחה הצעה';
export const REASON_CONTACT = 'תשובה ללקוח או לספק בוואטסאפ יוצאת רק באישורך';
export const REASON_UNKNOWN = 'השולח אינו מוכר — ההצעה נוסחה מתוך השיחה בלבד';
export const REASON_OWNERSHIP = 'מקור מידע החזיר נתונים שאינם של איש הקשר — לא נוסחה הצעה';
export const REASON_SOURCES_STOPPED = 'המקורות לא נבדקו כי העוזרת עצורה (מתג העצירה פעיל)';
export const REASON_SOURCE_FAILED = 'מקור מידע לא ענה בזמן או נכשל — הוא לא נכלל';
export const REASON_RESEARCH_FAILED = 'החיפוש במסמכים הפנימיים נכשל — הוא לא נכלל';
export const REASON_DRAFT_FAILED = 'ניסוח ההצעה נכשל — לא נוסחה הצעה';
export const REASON_ATTACHMENT_DROPPED = 'הטיוטה ביקשה לצרף קובץ שאינו מהמקורות של איש הקשר — הקובץ לא צורף';
export const REASON_MEDIA_UNREAD = 'התקבלו קובץ או תמונה שלא נקראו';
export const REASON_AUDIO_UNREAD = 'הקלטה קולית לא תומללה';
export const INTERNAL_DOCS_SOURCE = 'מסמכים פנימיים';

/** Ruling R11a: told to the owner when a new message lands on a card already approved and being sent. */
export function busyNote(label: string, text: string): string {
  return (
    `הודעה חדשה מ-${label}: "${text}"\n` +
    'התשובה הקודמת כבר אושרה ונשלחת, ולכן לא נוסחה טיוטה להודעה החדשה — צריך לענות עליה בנפרד.'
  );
}

const NOTE_TEXT_MAX = 300;

export interface ContactFlowDeps {
  gateway: WhatsAppGateway;
  messenger: BossMessenger;
  bundle: PolicyBundle;
  charter: BusinessCharter;
  businessName: string;
  researcher: ContactResearcher;
  drafter: ContactDrafter;
  /** The quarantined classifier (phase 2); its answer routes sources and gates the auto attempt. */
  classifier: ContactClassifier;
  /**
   * The sender's tier-2 sources. A source built with `namedSource` declares
   * its kind and is routed by the topic; one without a name runs only when
   * there is no topic.
   */
  sources: Tier2Source[];
  /** Busy/free for the window the classifier read; runs only when the topic lists it (or there is none). */
  calendarSource: Tier2Source;
  transcribe?: TranscriptionProvider;
  notify?: NotifyTarget;
  now: () => Date;
  /** Test seams; production leaves them unset. */
  tier2TimeoutMs?: number;
  classifyTimeoutMs?: number;
  researchTimeoutMs?: number;
  draftTimeoutMs?: number;
}

export interface ContactMessageInput {
  msg: NormalizedInboundMessage;
  storedId: string;
  sender: Exclude<ResolvedSender, { kind: 'principal' }>;
}

/**
 * `carded` — a card was raised for the message's conversation; `capped` — a
 * card without a draft (over a cap); `busy` — the conversation's card is
 * already approved and being sent (R11a); `recordedOnly` — a colleague or an
 * unparsable number; `skipped` — another runner claimed the message;
 * `failed` — something threw, the message settled `failed`.
 */
export type ContactOutcome = 'recordedOnly' | 'carded' | 'capped' | 'busy' | 'skipped' | 'failed';

class DeadlineError extends Error {}

/** Race `run` against a timer that also aborts its signal — a signal alone binds nothing. */
async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineError(`deadline of ${ms}ms passed`));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface Admitted {
  input: ContactMessageInput;
  index: number;
  /** What the contact said: the body, or the transcript of a voice note. */
  text: string;
  transcript: string | null;
}

interface Group {
  conversation: ContactConversation;
  sender: Extract<ResolvedSender, { kind: 'contact' | 'unknown' }> & { key: string };
  items: Admitted[];
  notes: Set<string>;
}

async function saveTranscript(db: BusinessDb, id: string, transcript: string): Promise<void> {
  await db.query(
    'UPDATE whatsapp_messages SET transcript = $1 WHERE id = $2 AND business_id = $3',
    [transcript, id, db.businessId],
  );
}

/** One message's text, transcribing a voice note when allowed. Notes what could not be read. */
async function readMessage(
  db: BusinessDb,
  deps: ContactFlowDeps,
  input: ContactMessageInput,
  notes: Set<string>,
): Promise<{ text: string; transcript: string | null }> {
  const { msg } = input;
  if (msg.mediaKind === 'audio') {
    if (deps.transcribe === undefined) {
      notes.add(REASON_AUDIO_UNREAD);
      return { text: msg.body ?? '', transcript: null };
    }
    const kind = input.sender.kind === 'contact' ? 'contact' : 'unknown';
    const t = await transcribeInbound(db, msg, kind, { provider: deps.transcribe });
    if (t.status !== 'transcribed') {
      notes.add(REASON_AUDIO_UNREAD);
      return { text: msg.body ?? '', transcript: null };
    }
    await saveTranscript(db, input.storedId, t.text);
    return { text: t.text, transcript: t.text };
  }
  if (msg.mediaKind !== null) notes.add(REASON_MEDIA_UNREAD);
  return { text: msg.body ?? '', transcript: null };
}

/** Model runs over contact conversations today (business cap). */
async function draftsToday(db: BusinessDb): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log
      WHERE business_id = $1 AND kind = 'tool_call' AND reason LIKE $2 AND at >= date_trunc('day', now())`,
    [db.businessId, `${CONTACT_DRAFT_REASON}:%`],
  );
  return Number(rows[0]?.n ?? '0');
}

/** Messages of this number a model processed today (per-contact cap). */
async function messagesProcessedToday(db: BusinessDb, key: string): Promise<number> {
  const { rows } = await db.query<{ n: string | null }>(
    `SELECT sum(split_part(reason, ':', 2)::int)::text AS n FROM audit_log
      WHERE business_id = $1 AND kind = 'tool_call' AND reason LIKE $2 AND input_hash = $3
        AND at >= date_trunc('day', now())`,
    [db.businessId, `${CONTACT_DRAFT_REASON}:%`, canonicalHash({ key })],
  );
  return Number(rows[0]?.n ?? '0');
}

/** Counts only: a hash of the number (the per-contact cap's key) and how many messages were read. */
async function recordDraftRun(db: BusinessDb, bundle: PolicyBundle, key: string, messages: number): Promise<void> {
  await appendAudit(db, {
    actor: 'comms.whatsapp',
    kind: 'tool_call',
    charterVersion: bundle.charterVersion,
    provenance: 'unknown_external',
    inputHash: canonicalHash({ key }),
    reason: `${CONTACT_DRAFT_REASON}:${messages}`,
  });
}

interface Gathered {
  /** Tier-1/2 items only (sources and public documents) — never researcher findings. */
  tier12: SourceItem[];
  /** A source that threw, timed out or reported `failed`, or the kill switch stopped them all. */
  failed: boolean;
  ownershipViolation: boolean;
  notes: string[];
}

/**
 * The sender's tier-2 sources and the public documents of its kind, routed by
 * the topic. Contacts only: an unknown number gets none. Every source — the
 * phase-1 invoices and the new calendar, ledger, meetings, external and
 * public — runs behind the business kill switch, sequentially, each on a
 * connection of its OWN: a source past its deadline is abandoned, not stopped
 * (the signal is advisory), and a call still running on the flow's connection
 * could land its writes inside the card's takeover transaction — or
 * interleave BEGIN/COMMIT with it. On its own connection an abandoned call
 * can only touch that connection. The accounting read and the sent-mail
 * search run outside the gate, so they honour the kill switch the way the
 * daily external scan does: the same agent and the same outbound reading
 * (scope all, outbound or operations stops them).
 */
async function gatherSources(
  db: BusinessDb,
  deps: ContactFlowDeps,
  group: Group,
  topic: ContactTopic | null,
  window: Classification['window'],
): Promise<Gathered> {
  const out: Gathered = { tier12: [], failed: false, ownershipViolation: false, notes: [] };
  if (group.sender.kind !== 'contact') return out;
  const c = group.sender.contact;
  const ids: SenderIds = { key: group.sender.key, email: c.email, subjectKey: c.subjectKey, externalIds: c.externalIds };

  if ((await checkKillSwitch(db, 'ops.systems', true)).blocked) {
    out.notes.push(REASON_SOURCES_STOPPED);
    out.failed = true;
    return out;
  }
  const ctx = { window, timeZone: deps.charter.identity.timezone, currency: deps.charter.money.currency };
  const run = deps.sources.filter((s) => sourceRuns(s, topic));
  if (namedRuns('calendar_busy', topic)) run.push(deps.calendarSource);

  for (const source of run) {
    try {
      const res = await withDeadline(deps.tier2TimeoutMs ?? TIER2_TIMEOUT_MS, (signal) =>
        withBusiness(db.businessId, (own) => source(own, ids, signal, ctx)),
      );
      if (res.ownershipViolation) return { tier12: [], failed: out.failed, ownershipViolation: true, notes: [REASON_OWNERSHIP] };
      if (res.failed === true) {
        out.failed = true;
        if (!out.notes.includes(REASON_SOURCE_FAILED)) out.notes.push(REASON_SOURCE_FAILED);
      }
      out.tier12.push(...res.items);
    } catch {
      out.failed = true;
      if (!out.notes.includes(REASON_SOURCE_FAILED)) out.notes.push(REASON_SOURCE_FAILED);
    }
  }

  if (c.kind !== null && namedRuns('public', topic)) {
    const kind = c.kind;
    try {
      const items = await withDeadline(deps.tier2TimeoutMs ?? TIER2_TIMEOUT_MS, () =>
        withBusiness(db.businessId, (own) => publicSourceItems(own, kind)),
      );
      out.tier12.push(...items);
    } catch {
      out.failed = true;
      if (!out.notes.includes(REASON_SOURCE_FAILED)) out.notes.push(REASON_SOURCE_FAILED);
    }
  }
  return out;
}

interface Researched {
  tier3: { text: string }[];
  internalDocumentIds: string[];
  notes: string[];
}

/** Tier 3, through the quarantined researcher. Contacts only; never on the auto attempt. */
async function research(db: BusinessDb, deps: ContactFlowDeps, group: Group): Promise<Researched> {
  if (group.sender.kind !== 'contact') return { tier3: [], internalDocumentIds: [], notes: [] };
  const question = group.items.map((i) => i.text).filter((t) => t.trim() !== '').join('\n');
  try {
    // Own connection, for the reason the sources have one: the gate hook
    // writes its decisions on the researcher's `db`.
    const outcome = await withDeadline(deps.researchTimeoutMs ?? RESEARCH_TIMEOUT_MS, (signal) =>
      withBusiness(db.businessId, async (own) =>
        deps.researcher({
          bundle: deps.bundle,
          question,
          businessId: own.businessId,
          signal,
          db: own,
          jobId: null,
          index: await loadResearchIndex(own),
        }),
      ),
    );
    if (outcome.status === 'found') {
      return {
        tier3: outcome.findings.map((f) => ({ text: f.text })),
        internalDocumentIds: [...new Set(outcome.findings.map((f) => f.documentId).filter((d): d is string => d !== null))],
        notes: [],
      };
    }
    return { tier3: [], internalDocumentIds: [], notes: outcome.status === 'failed' ? [REASON_RESEARCH_FAILED] : [] };
  } catch {
    return { tier3: [], internalDocumentIds: [], notes: [REASON_RESEARCH_FAILED] };
  }
}

/** One drafter run. A failure, a throw or a timeout is `failed` — never thrown. */
async function runDraft(
  db: BusinessDb,
  deps: ContactFlowDeps,
  group: Group,
  tier2: SourceItem[],
  tier3: { text: string }[],
  instruction: 'report_state' | undefined,
): Promise<ContactDraftOutcome> {
  try {
    const conversation = (await recentMessages(db, group.sender.key, 10)).map((m) => ({ direction: m.direction, body: m.body }));
    const description = await descriptionFragment(db);
    const profile = await profileFragment(db);
    return await withDeadline(deps.draftTimeoutMs ?? DRAFT_TIMEOUT_MS, async (signal) =>
      deps.drafter({
        signal,
        bundle: deps.bundle,
        businessName: deps.businessName,
        contactKind: group.conversation.contactKind,
        conversation,
        tier2,
        tier3,
        ...(instruction !== undefined ? { instruction } : {}),
        ...description,
        ...profile,
      }),
    );
  } catch {
    return { status: 'failed', reason: 'threw or timed out' };
  }
}

function sourcesHeOf(tier12: SourceItem[], tier3Used: boolean): string[] {
  const he = [...new Set(tier12.map((s) => s.label))];
  if (tier3Used) he.push(INTERNAL_DOCS_SOURCE);
  return he;
}

function sourceNamesOf(tier12: SourceItem[]): string[] {
  return [...new Set(tier12.map((s) => s.source))];
}

function labelOf(group: Group): string {
  const number = `+${group.sender.key}`;
  const name = group.sender.kind === 'contact' ? toOneLine(stripBidiControls(group.sender.contact.name)).trim() : '';
  return name === '' ? number : `${name} (${number})`;
}

async function settleAll(db: BusinessDb, group: Group, state: 'handled' | 'failed', jobId: string | null): Promise<void> {
  for (const item of group.items) {
    await settleMessage(db, item.input.storedId, state, {
      ...(item.transcript !== null ? { transcript: item.transcript } : {}),
      ...(jobId !== null ? { jobId } : {}),
    });
  }
}

/** R11a: keep the message on the conversation, settle with the current card, tell the owner once. */
async function handleBusy(db: BusinessDb, deps: ContactFlowDeps, group: Group): Promise<void> {
  const current = await loadConversation(db, group.conversation.conversationId);
  // Settled first: the messages are on the conversation either way, and a
  // note that fails must not mark them failed.
  await settleAll(db, group, 'handled', current?.cardJobId ?? null);
  const last = group.items[group.items.length - 1];
  const text = toOneLine(stripBidiControls(last?.text ?? '')).slice(0, NOTE_TEXT_MAX);
  try {
    await deps.messenger.send({ text: busyNote(labelOf(group), text), jobId: null });
  } catch {
    // `BossMessenger.send` does not throw by contract; nothing to undo if it did.
  }
}

interface CardInput {
  body: string;
  attachDocumentId: string | null;
  sourcesHe: string[];
  reasons: string[];
  context: Omit<CardContext, 'jobId' | 'auto'>;
}

/** The card path's tail: holding reply, the card, its presentation, the messages settled. */
async function raiseCard(db: BusinessDb, deps: ContactFlowDeps, group: Group, card: CardInput): Promise<'raised' | 'busy'> {
  // Once per conversation; `sendHoldingReply` itself enforces the per-number
  // daily limit, freshness, quiet hours and the kill switch. Card path only:
  // an auto reply goes out without "בודקת ומעדכנת" (spec §5.6).
  await sendHoldingReply(db, { gateway: deps.gateway, bundle: deps.bundle, now: deps.now() }, group.conversation.conversationId);
  let raised: { jobId: string; approvalId: string };
  try {
    raised = await raiseContactCard(
      db,
      {
        conversation: group.conversation,
        draft: { body: card.body, attachDocumentId: card.attachDocumentId },
        reasonHe: card.reasons.join('; '),
        sourcesHe: card.sourcesHe,
        bundle: deps.bundle,
        contactLabel: group.sender.kind === 'contact' ? group.sender.contact.name : '',
        mode: 'card',
        context: card.context,
      },
      deps.notify !== undefined ? { notify: deps.notify } : {},
    );
  } catch (error) {
    if (!(error instanceof ContactCardBusyError)) throw error;
    await handleBusy(db, deps, group);
    return 'busy';
  }
  await presentContactCard(db, raised.approvalId, async (text, jobId) => (await deps.messenger.send({ text, jobId })).ok);
  await settleAll(db, group, 'handled', raised.jobId);
  return 'raised';
}

/**
 * The order of decisions for one conversation (phase 2, package 1):
 *
 *   1. busy — a card that cannot be replaced (approved and unsent, or an auto
 *      job still running: its phase is neither `await_approval`, `failed` nor
 *      `closed`) gets no model call at all (R11a);
 *   2. caps — over either, a card with no classifier and no draft;
 *   3. the classifier (counted in the same draft run);
 *   4. courtesy with no live card — recorded only: no holding reply, no draft;
 *   5. sources, contacts only, routed by the topic;
 *   6. an auto attempt only when every switch holds: the drafter WITHOUT the
 *      researcher, then the six exit checks. Pass → the auto card job (no
 *      approval, no holding reply). Fail, or not eligible → the card path:
 *      holding reply, researcher, and a fresh draft with tier 3.
 *
 * The auto outcome is reported as `carded`: it IS a card job, one the owner
 * is not asked about.
 */
async function processGroup(
  db: BusinessDb,
  deps: ContactFlowDeps,
  group: Group,
): Promise<'carded' | 'capped' | 'busy' | 'recordedOnly'> {
  // Before any money: a card that cannot be replaced gets no draft.
  if (await cardTakeoverBlocked(db, group.conversation.conversationId)) {
    await handleBusy(db, deps, group);
    return 'busy';
  }

  const base = group.sender.kind === 'contact' ? REASON_CONTACT : REASON_UNKNOWN;
  const settings = await loadRuntimeSettings(db);
  const businessCap = capFor(settings, 'contactWaReadsPerDay');
  const capped =
    businessCap <= 0 ||
    (await draftsToday(db)) >= businessCap ||
    (await messagesProcessedToday(db, group.sender.key)) + group.items.length > CONTACT_MESSAGES_PER_CONTACT_PER_DAY;
  if (capped) {
    const r = await raiseCard(db, deps, group, {
      body: '',
      attachDocumentId: null,
      sourcesHe: [],
      reasons: [base, ...group.notes, REASON_CAPPED],
      context: { kind: 'unclassified', topicId: null, summary: '', sourceNames: [], internalDocumentIds: [] },
    });
    return r === 'busy' ? 'busy' : 'capped';
  }

  const texts = group.items.map((i) => i.text);
  const history = await recentMessages(db, group.sender.key, 10)
    .then((ms) => ms.map((m) => ({ direction: m.direction, body: m.body })))
    .catch(() => []);
  const classification = await classifyConversation(db, {
    classifier: deps.classifier,
    bundle: deps.bundle,
    conversation: history,
    texts,
    now: deps.now(),
    timeoutMs: deps.classifyTimeoutMs ?? CLASSIFY_TIMEOUT_MS,
    withDeadline,
  });
  await recordDraftRun(db, deps.bundle, group.sender.key, group.items.length);

  if (classification.kind === 'courtesy') {
    const current = await loadConversation(db, group.conversation.conversationId);
    if (!(await hasLiveCard(db, current?.cardJobId ?? null))) {
      await settleAll(db, group, 'handled', null);
      return 'recordedOnly';
    }
  }

  const managedKind = group.sender.kind === 'contact' ? group.sender.contact.kind : undefined;
  const topic = group.sender.kind === 'contact' ? await topicFor(db, classification, managedKind ?? null) : null;
  const gathered = await gatherSources(db, deps, group, topic, classification.window);
  const contextBase = {
    kind: classification.kind,
    topicId: topic?.topicId ?? null,
    summary: classification.summary,
    sourceNames: sourceNamesOf(gathered.tier12),
  };

  if (gathered.ownershipViolation) {
    const r = await raiseCard(db, deps, group, {
      body: '',
      attachDocumentId: null,
      sourcesHe: [],
      reasons: [base, ...group.notes, REASON_OWNERSHIP],
      context: { ...contextBase, sourceNames: [], internalDocumentIds: [] },
    });
    return r === 'busy' ? 'busy' : 'carded';
  }

  const reasons = [base, ...group.notes, ...gathered.notes];
  const gate = await autoGate(db, { charter: deps.charter, managedKind, topic, classification });
  if (!gate.eligible && gate.reason !== null) reasons.push(gate.reason);

  if (gate.eligible && group.sender.kind === 'contact' && topic !== null) {
    const contact = group.sender.contact;
    const attempt = await runDraft(db, deps, group, gathered.tier12, [], 'report_state');
    if (attempt.status === 'drafted') {
      const check = exitChecks({
        draft: attempt.body,
        // The drafter's own choice, unfiltered: an attachment outside tier 1/2
        // must fail the check, not be silently dropped into a pass.
        attachDocumentId: attempt.attachDocumentId,
        classification,
        topic,
        sender: { kind: contact.kind, managed: true, colleague: false, name: contact.name },
        tier12: gathered.tier12,
        tier3Used: false,
        sourceFailed: gathered.failed,
        ownershipViolation: false,
        otherPeople: await loadOtherPeople(db, { key: group.sender.key, subjectKey: contact.subjectKey, email: contact.email }),
      });
      if (check.ok) {
        try {
          const raised = await raiseContactCard(db, {
            conversation: group.conversation,
            draft: { body: attempt.body, attachDocumentId: attempt.attachDocumentId },
            reasonHe: reasons.join('; '),
            sourcesHe: sourcesHeOf(gathered.tier12, false),
            bundle: deps.bundle,
            contactLabel: contact.name,
            mode: 'auto',
            context: { ...contextBase, internalDocumentIds: [] },
          });
          await settleAll(db, group, 'handled', raised.jobId);
          return 'carded';
        } catch (error) {
          if (!(error instanceof ContactCardBusyError)) throw error;
          await handleBusy(db, deps, group);
          return 'busy';
        }
      }
      reasons.push(check.reason);
    }
  }

  // The card path: tier 3 joins, and the draft is written again (without the
  // report-state instruction) when the first one was the auto attempt.
  const researched = await research(db, deps, group);
  reasons.push(...researched.notes);
  const draft = await runDraft(db, deps, group, gathered.tier12, researched.tier3, undefined);
  const sourcesHe = sourcesHeOf(gathered.tier12, researched.tier3.length > 0);
  const context = { ...contextBase, internalDocumentIds: researched.internalDocumentIds };
  if (draft.status !== 'drafted') {
    const r = await raiseCard(db, deps, group, {
      body: '', attachDocumentId: null, sourcesHe, reasons: [...reasons, REASON_DRAFT_FAILED], context,
    });
    return r === 'busy' ? 'busy' : 'carded';
  }
  // Ruling R11c: an attachment only from documents tier 1/2 returned in THIS run.
  let attach = draft.attachDocumentId;
  if (attach !== null) {
    const allowed = new Set(gathered.tier12.map((s) => s.documentId).filter((d): d is string => d !== null));
    if (!allowed.has(attach) || (await loadAttachmentInfo(db, attach)) === null) {
      attach = null;
      reasons.push(REASON_ATTACHMENT_DROPPED);
    }
  }
  const r = await raiseCard(db, deps, group, { body: draft.body, attachDocumentId: attach, sourcesHe, reasons, context });
  return r === 'busy' ? 'busy' : 'carded';
}

/**
 * Every contact message of one door pass. Returns one outcome per input, in
 * input order. Never throws: a failure settles the messages it touched
 * `failed`.
 */
export async function handleContactMessages(
  db: BusinessDb,
  deps: ContactFlowDeps,
  inputs: readonly ContactMessageInput[],
): Promise<ContactOutcome[]> {
  const outcomes: ContactOutcome[] = inputs.map(() => 'failed');
  const groups = new Map<string, Group>();

  for (const [index, input] of inputs.entries()) {
    const { sender } = input;
    try {
      if (sender.kind === 'colleague' || sender.key === null) {
        // Recorded for the conversation screen; never answered, never drafted.
        await settleMessage(db, input.storedId, 'handled', {});
        outcomes[index] = 'recordedOnly';
        continue;
      }
      if (!(await claimMessage(db, input.storedId))) {
        outcomes[index] = 'skipped';
        continue;
      }
      const notes = new Set<string>();
      const { text, transcript } = await readMessage(db, deps, input, notes);
      const inbound = new Date(input.msg.providerTimestamp);
      const { conversation } = await openOrAppend(db, {
        key: sender.key,
        subjectKey: sender.kind === 'contact' ? sender.contact.subjectKey : null,
        kind: sender.kind === 'contact' ? (sender.contact.kind ?? 'unknown') : 'unknown',
        inboundAt: Number.isNaN(inbound.getTime()) ? deps.now() : inbound,
      });
      let group = groups.get(conversation.conversationId);
      if (group === undefined) {
        group = { conversation, sender: { ...sender, key: sender.key }, items: [], notes: new Set() };
        groups.set(conversation.conversationId, group);
      }
      for (const n of notes) group.notes.add(n);
      group.items.push({ input, index, text, transcript });
    } catch {
      await settleMessage(db, input.storedId, 'failed', {}).catch(() => undefined);
      outcomes[index] = 'failed';
    }
  }

  for (const group of groups.values()) {
    let outcome: ContactOutcome;
    try {
      outcome = await processGroup(db, deps, group);
    } catch {
      for (const item of group.items) {
        await settleMessage(db, item.input.storedId, 'failed', {}).catch(() => undefined);
      }
      outcome = 'failed';
    }
    for (const item of group.items) outcomes[item.index] = outcome;
  }
  return outcomes;
}

/** One message — the single-message form of `handleContactMessages`. */
export async function handleContactMessage(
  db: BusinessDb,
  deps: ContactFlowDeps,
  input: ContactMessageInput,
): Promise<ContactOutcome> {
  const [outcome] = await handleContactMessages(db, deps, [input]);
  return outcome ?? 'failed';
}
