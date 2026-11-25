/**
 * A learned suggestion answered on WhatsApp ("כן" / "לא") — the sixth kind
 * counted in `openOnWhatsApp`. The reader runs only when no boss-command
 * confirmation reads the message, and refuses when anything else is open, so
 * "כן" can never answer the wrong thing.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import type { Plan } from '../domain/plan.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { PlanOutcome } from '../sdk/planner.js';
import type { NormalizedInboundMessage } from '../whatsapp/gateway.js';
import { createFakeGateway, type FakeGateway } from '../whatsapp/fake-gateway.js';
import { createBossMessenger, type BossMessenger } from '../whatsapp/messenger.js';
import { installMailboxCharter } from '../test/mailbox.js';
import { saveInstruction } from '../governance/instructions.js';
import {
  createConfirmation,
  loadConfirmation,
  markConfirmationDelivered,
  type ConfirmationOption,
} from '../governance/instruction-confirmations.js';
import { listTopics } from '../whatsapp/contact-topics.js';
import {
  insertSuggestion,
  loadSuggestion,
  markSuggestionDelivered,
  shapeHashFor,
} from '../whatsapp/contact-suggestions.js';
import { SUGGESTION_APPLIED, SUGGESTION_REJECTED } from '../whatsapp/suggestion-whatsapp.js';
import { presentContactCard, raiseContactCard } from '../whatsapp/contact-card.js';
import { openOrAppend } from '../whatsapp/contact-conversations.js';
import { createJob, transition } from './jobs.js';
import { bindPlanToJob, planHashOf } from './plan-store.js';
import { SEVERAL_OPEN_REFUSAL, runWhatsAppDoor } from './whatsapp-door.js';

const BUSINESS = 'test-business';
const PRINCIPAL_NUMBER = '+972500000000';

let nextId = 0;
function msg(body: string | null, offsetMs = 1_000, mediaKind: NormalizedInboundMessage['mediaKind'] = null): NormalizedInboundMessage {
  nextId += 1;
  return {
    providerMessageId: `wamid.sugg-${nextId}`,
    senderNumber: PRINCIPAL_NUMBER,
    body,
    mediaKind,
    providerTimestamp: new Date(Date.now() + offsetMs).toISOString(),
    ...(mediaKind === 'audio'
      ? { downloadAudio: async () => ({ bytes: Buffer.from('x'), mimeType: 'audio/ogg', seconds: 3 }) }
      : {}),
  } as NormalizedInboundMessage;
}

function recallPlan(): Plan {
  return {
    goal: 'להיזכר',
    assumptions: [],
    clarifyingQuestion: null,
    estimatedCostMinor: 0,
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'להיזכר',
        toolName: 'memory.recall',
        input: { subjectKey: 'dana@example.com' },
        dependsOn: [],
        expectedActionClass: null,
      },
    ],
  };
}
const planner = async (): Promise<PlanOutcome> => ({ status: 'planned', plan: recallPlan() });

let bundle: PolicyBundle;
let gateway: FakeGateway;
let messenger: BossMessenger;

beforeEach(async () => {
  await resetDatabase();
  bundle = await installMailboxCharter(BUSINESS);
  gateway = createFakeGateway();
  messenger = createBossMessenger({ gateway, contactId: PRINCIPAL_NUMBER, businessId: BUSINESS });
});
afterAll(async () => {
  await closePool();
});

const pass = () => withBusiness(BUSINESS, (db) => runWhatsAppDoor(db, { gateway, messenger, planner }));
const lastSent = () => gateway.sent.at(-1)?.body ?? '';

async function suggestion(name = 'משלוחים', delivered: Date | null = new Date()): Promise<string> {
  const s = await withBusiness(BUSINESS, (db) =>
    insertSuggestion(
      db,
      'new_topic',
      { name, description: '', appliesTo: 'client', sources: [], decisionIds: ['1', '2', '3', '4', '5'] },
      shapeHashFor({ kind: 'new_topic', name }),
    ),
  );
  if (s === null) throw new Error('not inserted');
  if (delivered !== null) await withBusiness(BUSINESS, (db) => markSuggestionDelivered(db, s.suggestionId, delivered));
  return s.suggestionId;
}

const stateOf = async (id: string) => (await withBusiness(BUSINESS, (db) => loadSuggestion(db, id)))?.state;
const topicCount = async () => (await withBusiness(BUSINESS, (db) => listTopics(db))).length;

async function heldConfirmation(): Promise<string> {
  const plan: Plan = {
    ...recallPlan(),
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'לשלוח',
        toolName: 'mail.send',
        input: { to: 'dana@example.com', subject: 'נושא', body: 'גוף' },
        dependsOn: [],
        expectedActionClass: 'email.initiate',
      },
    ],
  };
  const option: ConfirmationOption = { label: 'לבצע?', planHash: planHashOf(plan), plan, contactSource: null };
  const job = await withBusiness(BUSINESS, (db) => createJob(db, { charterVersion: bundle.charterVersion, provenance: 'boss' }));
  await withBusiness(BUSINESS, (db) => saveInstruction(db, { jobId: job.jobId, text: 'תשלחי לדנה', textOrigin: 'typed' }));
  await withBusiness(BUSINESS, (db) => transition(db, job.jobId, { to: 'understand', actor: 'orchestrator', reason: 't' }));
  await withBusiness(BUSINESS, (db) => transition(db, job.jobId, { to: 'plan', actor: 'orchestrator', reason: 't' }));
  await withBusiness(BUSINESS, (db) => bindPlanToJob(db, job.jobId, plan));
  await withBusiness(BUSINESS, (db) => createConfirmation(db, { jobId: job.jobId, options: [option], presentedText: 'שאלה', channel: 'whatsapp' }));
  await withBusiness(BUSINESS, (db) => markConfirmationDelivered(db, job.jobId));
  return job.jobId;
}

async function openContactCard(): Promise<void> {
  const { conversation } = await withBusiness(BUSINESS, (db) =>
    openOrAppend(db, { key: '972501110001', subjectKey: null, kind: 'client', inboundAt: new Date() }),
  );
  const { approvalId } = await withBusiness(BUSINESS, (db) =>
    raiseContactCard(db, {
      conversation,
      draft: { body: 'שלום', attachDocumentId: null },
      reasonHe: 'דורש אישור',
      sourcesHe: [],
      bundle,
      contactLabel: 'דנה',
    }),
  );
  const presented = await withBusiness(BUSINESS, (db) =>
    presentContactCard(db, approvalId, async (text, jobId) => (await messenger.send({ text, jobId })).ok),
  );
  if (!presented) throw new Error('card not presented');
}

describe('a suggestion answered on WhatsApp', () => {
  it('"כן" typed after delivery inside the window applies it', async () => {
    const id = await suggestion();
    const yes = msg('כן');
    gateway.enqueue(yes);
    const result = await pass();
    expect(result.suggestionReplies).toBe(1);
    expect(result.instructed).toBe(0);
    expect(await stateOf(id)).toBe('accepted');
    expect(await topicCount()).toBe(1);
    expect(lastSent()).toBe(SUGGESTION_APPLIED);
  });

  it('"לא" rejects it and changes nothing', async () => {
    const id = await suggestion();
    gateway.enqueue(msg('לא.'));
    const result = await pass();
    expect(result.suggestionReplies).toBe(1);
    expect(await stateOf(id)).toBe('rejected');
    expect(await topicCount()).toBe(0);
    expect(lastSent()).toBe(SUGGESTION_REJECTED);
  });

  it('a voice note is never an answer — passthrough, nothing applied', async () => {
    const id = await suggestion();
    gateway.enqueue(msg(null, 1_000, 'audio'));
    const result = await pass();
    expect(result.suggestionReplies).toBe(0);
    expect(await stateOf(id)).toBe('open');
    expect(await topicCount()).toBe(0);
  });

  it('"כן" sent before the suggestion was delivered is passthrough', async () => {
    const id = await suggestion('משלוחים', new Date(Date.now() + 60_000));
    gateway.enqueue(msg('כן', 1_000));
    const result = await pass();
    expect(result.suggestionReplies).toBe(0);
    expect(result.instructed).toBe(1);
    expect(await stateOf(id)).toBe('open');
    expect(await topicCount()).toBe(0);
  });

  it('"כן" on an undelivered suggestion is passthrough', async () => {
    const id = await suggestion('משלוחים', null);
    gateway.enqueue(msg('כן'));
    const result = await pass();
    expect(result.suggestionReplies).toBe(0);
    expect(await stateOf(id)).toBe('open');
  });

  it('"כן תודה" is passthrough', async () => {
    const id = await suggestion();
    gateway.enqueue(msg('כן תודה'));
    const result = await pass();
    expect(result.suggestionReplies).toBe(0);
    expect(result.instructed).toBe(1);
    expect(await stateOf(id)).toBe('open');
  });

  it('"כן" with a command confirmation open → SEVERAL_OPEN_REFUSAL, neither applied', async () => {
    const id = await suggestion();
    const jobId = await heldConfirmation();
    gateway.enqueue(msg('כן'));
    const result = await pass();
    expect(lastSent()).toBe(SEVERAL_OPEN_REFUSAL);
    expect(result.suggestionReplies).toBe(0);
    expect(result.confirmationReplies).toBe(0);
    expect(await stateOf(id)).toBe('open');
    expect(await topicCount()).toBe(0);
    expect((await withBusiness(BUSINESS, (db) => loadConfirmation(db, jobId)))?.state).toBe('pending');
  });

  it('"כן" with a contact card open → refused, nothing applied', async () => {
    const id = await suggestion();
    await openContactCard();
    gateway.enqueue(msg('כן', 2_000));
    const result = await pass();
    expect(lastSent()).toBe(SEVERAL_OPEN_REFUSAL);
    expect(result.suggestionReplies).toBe(0);
    expect(await stateOf(id)).toBe('open');
    expect(await topicCount()).toBe(0);
  });

  it('"כן" with two suggestions delivered → refused, neither applied', async () => {
    const a = await suggestion('משלוחים');
    const b = await suggestion('החזרות');
    gateway.enqueue(msg('כן'));
    await pass();
    expect(lastSent()).toBe(SEVERAL_OPEN_REFUSAL);
    expect(await stateOf(a)).toBe('open');
    expect(await stateOf(b)).toBe('open');
  });

  it('"שלח" with a contact card AND a suggestion open → refused (suggestions count against the card)', async () => {
    const id = await suggestion();
    await openContactCard();
    gateway.enqueue(msg('שלח', 2_000));
    await pass();
    expect(lastSent()).toBe(SEVERAL_OPEN_REFUSAL);
    expect(await stateOf(id)).toBe('open');
    const { rows } = await testDb().query<{ state: string }>(
      `SELECT state FROM approval_requests WHERE business_id = $1 AND proposed_tool = 'wa.send_message'`,
      [BUSINESS],
    );
    expect(rows.map((r) => r.state)).toEqual(['pending']);
  });

  it('a redelivered "כן" decides once', async () => {
    const id = await suggestion();
    const yes = msg('כן');
    gateway.enqueue(yes);
    gateway.enqueue({ ...yes });
    await pass();
    expect(await stateOf(id)).toBe('accepted');
    expect(await topicCount()).toBe(1);
  });
});
