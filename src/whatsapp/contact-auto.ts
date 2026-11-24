/**
 * The phase-2 helpers of the contact flow (package 1, auto-reply): classify a
 * conversation, pick the topic, route the tier-2 sources by it, decide whether
 * an auto attempt is allowed at all, and gather the "other people" the exit
 * checks must not see in a draft. Kept out of `contact-flow.ts` so the flow
 * reads as the order of decisions and nothing else.
 *
 * Nothing here grants anything. The classifier's answer only chooses which
 * sources are read and whether an auto attempt is made; the six exit checks
 * decide whether the draft may go out alone, and the gate
 * (`contactReplyCovers`) re-checks everything at send time.
 */
import type { BusinessDb } from '../db/pool.js';
import type { BusinessCharter } from '../domain/charter.js';
import type { PolicyBundle } from '../domain/policy.js';
import { autoReplySigned } from '../charter/amend-whatsapp-auto-reply.js';
import { authorityNumberKey } from '../governance/principal-number.js';
import type { ContactClassifier } from '../sdk/contact-classifier.js';
import { parseClassification, type Classification } from './contact-classification.js';
import { listTopics, loadTopic, topicApplies, type ContactTopic, type Tier2SourceName } from './contact-topics.js';
import { EXIT_REASONS, type ExitCheckInput } from './exit-checks.js';
import { loadContactWaSettings } from './sources/invoice-settings.js';
import { sourceNameOf, type Tier2Source } from './sources/types.js';

export const CLASSIFY_TIMEOUT_MS = 30_000;

/** Invoices stay "always", as in phase 1, so drafts to the owner do not weaken (spec §5.2). */
export const ALWAYS_SOURCES: ReadonlySet<Tier2SourceName> = new Set(['uploaded_invoices', 'sent_invoices', 'accounting_invoices']);

export const UNCLASSIFIED: Classification = { kind: 'unclassified', topicId: null, summary: '', window: null };

/**
 * The classifier's answer, parsed. Any failure — the model failed, threw,
 * timed out, or answered something unreadable — is `unclassified`, never a
 * permissive default. Every topic id the model may name is a live topic of
 * THIS business; the parser drops any other.
 */
export async function classifyConversation(
  db: BusinessDb,
  input: {
    classifier: ContactClassifier;
    bundle: PolicyBundle;
    conversation: { direction: 'inbound' | 'outbound'; body: string }[];
    texts: string[];
    now: Date;
    timeoutMs: number;
    withDeadline: <T>(ms: number, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  },
): Promise<Classification> {
  try {
    const topics = await listTopics(db);
    const out = await input.withDeadline(input.timeoutMs, (signal) =>
      input.classifier({ bundle: input.bundle, topics, conversation: input.conversation, texts: input.texts, signal }),
    );
    if (out.status !== 'classified') return { ...UNCLASSIFIED };
    return parseClassification(out.raw, {
      topicIds: new Set(topics.map((t) => t.topicId)),
      texts: input.texts,
      now: input.now,
    });
  } catch {
    return { ...UNCLASSIFIED };
  }
}

/**
 * The topic that routes the sources: named by the classifier, loaded as it is
 * NOW, not retired, and applying to the contact's kind. Anything else is "no
 * topic" — every source runs and nothing can go out alone.
 */
export async function topicFor(
  db: BusinessDb,
  classification: Classification,
  contactKind: 'client' | 'supplier' | null,
): Promise<ContactTopic | null> {
  if (classification.topicId === null || contactKind === null) return null;
  const topic = await loadTopic(db, classification.topicId);
  if (topic === null || topic.retiredAt !== null || !topicApplies(topic, contactKind)) return null;
  return topic;
}

/**
 * Positive: with no topic every source runs; with a topic a source runs only
 * when it is KNOWN (by its declared name) to be an always-source or one the
 * topic lists. A source that declared no name never runs under a topic.
 */
export function sourceRuns(source: Tier2Source, topic: ContactTopic | null): boolean {
  if (topic === null) return true;
  const name = sourceNameOf(source);
  if (name === null) return false;
  return ALWAYS_SOURCES.has(name) || topic.sources.includes(name);
}

export function namedRuns(name: Tier2SourceName, topic: ContactTopic | null): boolean {
  return topic === null || topic.sources.includes(name);
}

export type AutoGate = { eligible: true } | { eligible: false; reason: string | null };

/**
 * Whether an auto attempt may be made. Without both switches (the signed
 * charter row and the owner's setting) or for anyone but a managed client or
 * supplier, there is no attempt and no extra reason — the card's base reason
 * already says why. With both on, a missing topic or a message that is not a
 * question names the exit reason the owner will read.
 */
export async function autoGate(
  db: BusinessDb,
  input: {
    charter: BusinessCharter;
    managedKind: 'client' | 'supplier' | null | undefined;
    topic: ContactTopic | null;
    classification: Classification;
  },
): Promise<AutoGate> {
  if (input.managedKind === undefined || input.managedKind === null) return { eligible: false, reason: null };
  if (!autoReplySigned(input.charter)) return { eligible: false, reason: null };
  const settings = await loadContactWaSettings(db);
  if (settings.autoReplyEnabled !== true) return { eligible: false, reason: null };
  const t = input.topic;
  if (t === null || t.retiredAt !== null || !t.autoReply || !topicApplies(t, input.managedKind)) {
    return { eligible: false, reason: EXIT_REASONS.topic };
  }
  if (input.classification.kind !== 'question') return { eligible: false, reason: EXIT_REASONS.notQuestion };
  return { eligible: true };
}

function readString(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Every OTHER person the business knows — live memory entities and
 * colleagues — by name, email and phone, so a draft that mentions one fails
 * the exit check. The sender is excluded by subject key, number and email.
 */
export async function loadOtherPeople(
  db: BusinessDb,
  sender: { key: string; subjectKey: string; email: string | null },
): Promise<ExitCheckInput['otherPeople']> {
  const names: string[] = [];
  const emails: string[] = [];
  const phoneKeys: string[] = [];
  const senderEmail = sender.email?.toLowerCase() ?? null;
  const { rows } = await db.query<{ subject_key: string; body: Record<string, unknown> }>(
    `SELECT subject_key, body FROM memories WHERE business_id = $1 AND kind = 'entity' AND retired_at IS NULL`,
    [db.businessId],
  );
  for (const row of rows) {
    if (row.subject_key === sender.subjectKey) continue;
    const body = typeof row.body === 'object' && row.body !== null ? row.body : {};
    const phone = readString(body, 'phone');
    const email = readString(body, 'email');
    if (phone !== null && authorityNumberKey(phone) === sender.key) continue;
    if (email !== null && senderEmail !== null && email.toLowerCase() === senderEmail) continue;
    const name = readString(body, 'name');
    if (name !== null) names.push(name);
    if (email !== null) emails.push(email);
    if (phone !== null) phoneKeys.push(phone);
  }
  const colleagues = await db.query<{ name: string; phone: string }>(
    'SELECT name, phone FROM business_colleagues WHERE business_id = $1',
    [db.businessId],
  );
  for (const c of colleagues.rows) {
    if (authorityNumberKey(c.phone) === sender.key) continue;
    names.push(c.name);
    phoneKeys.push(c.phone);
  }
  return { names, emails, phoneKeys };
}

/** Whether the conversation's current card job is still alive (not failed, not closed). */
export async function hasLiveCard(db: BusinessDb, cardJobId: string | null): Promise<boolean> {
  if (cardJobId === null) return false;
  const { rows } = await db.query<{ phase: string }>(
    'SELECT phase FROM jobs WHERE business_id = $1 AND job_id = $2',
    [db.businessId, cardJobId],
  );
  const phase = rows[0]?.phase;
  return phase !== undefined && phase !== 'failed' && phase !== 'closed';
}
