import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import { config } from '../config.js';
import type { Plan } from '../domain/plan.js';
import type { PlanOutcome, PlanRequest } from '../sdk/planner.js';
import type { NormalizedInboundMessage } from '../whatsapp/gateway.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import { createFakeMessenger } from '../whatsapp/fake-messenger.js';
import { runWhatsAppDoor } from './whatsapp-door.js';

const BUSINESS = 'test-business';
// `buildCharter`'s default principal (`src/test/fixtures.ts`) carries this
// number on the `whatsapp` channel — the one sender this door ever acts on.
const PRINCIPAL_NUMBER = '+972500000000';
const STRANGER_NUMBER = '+972549999999';

async function withCharter(): Promise<void> {
  await installCharter(buildCharter(), { businessId: BUSINESS });
}

let nextId = 0;
function nextProviderMessageId(): string {
  nextId += 1;
  return `wamid.test-${nextId}`;
}

function textMsg(opts: {
  senderNumber: string;
  body: string;
  providerMessageId?: string;
  providerTimestamp?: string;
}): NormalizedInboundMessage {
  return {
    providerMessageId: opts.providerMessageId ?? nextProviderMessageId(),
    senderNumber: opts.senderNumber,
    body: opts.body,
    mediaKind: null,
    providerTimestamp: opts.providerTimestamp ?? new Date().toISOString(),
  };
}

function audioMsg(opts: {
  senderNumber: string;
  seconds?: number;
  providerTimestamp?: string;
}): NormalizedInboundMessage {
  return {
    providerMessageId: nextProviderMessageId(),
    senderNumber: opts.senderNumber,
    body: null,
    mediaKind: 'audio',
    providerTimestamp: opts.providerTimestamp ?? new Date().toISOString(),
    downloadAudio: async () => ({
      bytes: Buffer.from('fake-audio-bytes'),
      mimeType: 'audio/ogg',
      seconds: opts.seconds ?? 10,
    }),
  };
}

/** A minimal, feasible plan — the same shape `instruct.test.ts`'s own `mailPlan` uses. */
function mailPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    goal: 'לשלוח הודעה',
    assumptions: [],
    clarifyingQuestion: null,
    estimatedCostMinor: 0,
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'לשלוח הודעה',
        toolName: 'mail.send',
        input: { to: 'dana@example.com', subject: 'נושא', body: 'גוף ההודעה' },
        dependsOn: [],
        expectedActionClass: 'email.initiate',
      },
    ],
    ...overrides,
  };
}

const plannedWith = (plan: Plan) => async (): Promise<PlanOutcome> => ({ status: 'planned', plan });

/** Proves a branch never reaches the planner at all — see `recordInbound`'s dedupe note below. */
const neverCalled = async (_request: PlanRequest): Promise<PlanOutcome> => {
  throw new Error('planner must not be called for this message');
};

async function stateOf(providerMessageId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ state: string }>(
    'SELECT state FROM whatsapp_messages WHERE business_id = $1 AND provider_message_id = $2',
    [BUSINESS, providerMessageId],
  );
  return rows[0]?.state ?? null;
}

async function messageRow(
  providerMessageId: string,
): Promise<{ jobId: string | null; transcript: string | null; state: string } | null> {
  const { rows } = await getPool().query<{ job_id: string | null; transcript: string | null; state: string }>(
    'SELECT job_id, transcript, state FROM whatsapp_messages WHERE business_id = $1 AND provider_message_id = $2',
    [BUSINESS, providerMessageId],
  );
  const row = rows[0];
  return row ? { jobId: row.job_id, transcript: row.transcript, state: row.state } : null;
}

/** Jobs still in a non-terminal phase — not merely "a row exists". */
async function openJobs(businessId: string): Promise<Array<{ jobId: string }>> {
  const { rows } = await getPool().query<{ job_id: string }>(
    `SELECT job_id FROM jobs WHERE business_id = $1 AND phase NOT IN ('closed', 'failed', 'halted')`,
    [businessId],
  );
  return rows.map((r) => ({ jobId: r.job_id }));
}

/** Every job row regardless of phase — used where "none was ever created" matters. */
async function allJobs(businessId: string): Promise<Array<{ jobId: string }>> {
  const { rows } = await getPool().query<{ job_id: string }>(
    'SELECT job_id FROM jobs WHERE business_id = $1',
    [businessId],
  );
  return rows.map((r) => ({ jobId: r.job_id }));
}

async function jobWhatsAppMessageId(jobId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ whatsapp_message_id: string | null }>(
    'SELECT whatsapp_message_id FROM jobs WHERE job_id = $1',
    [jobId],
  );
  return rows[0]?.whatsapp_message_id ?? null;
}

async function seedInstructionAttempt(businessId: string): Promise<void> {
  await appendAudit(
    {
      actor: 'orchestrator',
      kind: 'whatsapp_instruction',
      charterVersion: 'n/a',
      provenance: 'boss',
      inputHash: canonicalHash({ seeded: true, i: Math.random() }),
      artifacts: [],
      costMinor: null,
      tokens: null,
      reason: 'seed row for test',
    },
    { businessId },
  );
}

describe('runWhatsAppDoor', () => {
  beforeEach(async () => {
    await resetDatabase();
    await withCharter();
  });

  afterAll(async () => {
    await closePool();
  });

  it('turns a message from the principal into an instruction and acknowledges from the outcome', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    const msg = textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לדנה את ההצעה' });
    gateway.enqueue(msg);

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan()),
    });

    expect(result).toEqual({ polled: 1, instructed: 1, recordedOnly: 0, refused: 0 });
    expect(messenger.sentTexts).toHaveLength(1);
    expect(messenger.sentTexts[0]).toContain('קיבלתי');

    const jobs = await openJobs(BUSINESS);
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    if (job === undefined) throw new Error('unreachable');

    const row = await getPool().query<{ phase: string; provenance: string }>(
      'SELECT phase, provenance FROM jobs WHERE job_id = $1',
      [job.jobId],
    );
    expect(row.rows[0]?.phase).toBe('execute');
    expect(row.rows[0]?.provenance).toBe('boss');

    expect(await jobWhatsAppMessageId(job.jobId)).not.toBeNull();
    const stored = await messageRow(msg.providerMessageId);
    // The message settled 'handled' and carries the job it opened.
    expect(stored?.state).toBe('handled');
    expect(stored?.jobId).toBe(job.jobId);
  });

  /** Decision 4. The customer feels no change, and that is the point. */
  it('records a message from anyone else and neither acts nor replies', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg({ senderNumber: STRANGER_NUMBER, body: 'מה המחיר שלכם?' }));

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: neverCalled,
    });

    expect(result.recordedOnly).toBe(1);
    expect(result.instructed).toBe(0);
    expect(messenger.sentTexts).toEqual([]); // no auto-reply, ever
    expect(await openJobs(BUSINESS)).toHaveLength(0);
  });

  it('acknowledges a needs_answer outcome with the question itself', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    const question = 'למי בדיוק את מתכוונת, לדנה מהנהלת חשבונות או לדנה מהשיווק?';
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לדנה הודעה' }));

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan({ clarifyingQuestion: question })),
    });

    expect(messenger.sentTexts).toEqual([question]);
    expect(result.instructed).toBe(1); // a job exists, parked, waiting for the owner
    expect(result.refused).toBe(0);
  });

  it('acknowledges a refused outcome with the reason itself', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'ג׳יבריש לא מובן' }));

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: async () => ({ status: 'unparseable', raw: 'not json', reason: 'bad model output' }),
    });

    expect(result.refused).toBe(1);
    expect(result.instructed).toBe(0);
    expect(messenger.sentTexts).toHaveLength(1);
    expect(messenger.sentTexts[0]).toContain('לא הצלחתי להבין את ההוראה');
    // A job existed — `runInstruction` opens one before it ever reaches the
    // planner — but it was failed out, so it no longer counts as "open".
    expect(await allJobs(BUSINESS)).toHaveLength(1);
    expect(await openJobs(BUSINESS)).toHaveLength(0);
  });

  /**
   * The claim is written BEFORE `runInstruction`. A crash between them loses
   * one instruction rather than sending a second email — the safe direction,
   * and the same choice `markContentIngested` makes.
   */
  it('claims the message before planning, so a crash cannot double-send', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    const providerMessageId = 'wamid.crash-test';
    gateway.enqueue(
      textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לדנה', providerMessageId }),
    );

    const seen: Array<string | null> = [];
    await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: async () => {
        seen.push(await stateOf(providerMessageId));
        throw new Error('boom');
      },
    }).catch(() => {});

    expect(seen).toEqual(['claimed']); // not 'received'
    expect(await stateOf(providerMessageId)).toBe('failed');
  });

  /**
   * §6.3 — a mistranscription is a mistaken instruction, and 500 against
   * 5,000 must be visible before anything happens.
   */
  it('quotes the transcript back when the instruction arrived as audio', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(audioMsg({ senderNumber: PRINCIPAL_NUMBER }));

    const provider = async () => ({ text: 'תשלחי למוטי שאני בדרך' });

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      provider,
      planner: plannedWith(mailPlan()),
    });

    expect(result.instructed).toBe(1);
    expect(messenger.sentTexts[0]).toContain('שמעתי:');
    expect(messenger.sentTexts[0]).toContain('תשלחי למוטי');
  });

  it('tells the owner it could not read a recording rather than staying silent', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(audioMsg({ senderNumber: PRINCIPAL_NUMBER }));

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      provider: async () => {
        throw new Error('upstream 503');
      },
      planner: neverCalled,
    });

    expect(result.refused).toBe(1);
    expect(messenger.sentTexts).toHaveLength(1);
    expect(messenger.sentTexts[0]).not.toBe('');
    expect(await openJobs(BUSINESS)).toHaveLength(0);
  });

  it('tells the owner rather than staying silent when no transcription provider is configured', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(audioMsg({ senderNumber: PRINCIPAL_NUMBER }));

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: neverCalled,
    });

    expect(result.refused).toBe(1);
    expect(messenger.sentTexts).toHaveLength(1);
    expect(messenger.sentTexts[0]).not.toBe('');
  });

  it('stops instructing once the daily instruction cap is reached, and says so', async () => {
    for (let i = 0; i < config.whatsappInstructionsPerDay; i += 1) {
      await seedInstructionAttempt(BUSINESS);
    }

    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לדנה' }));

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: neverCalled, // the cap must stop this before the planner is ever paid for
    });

    expect(result.refused).toBe(1);
    expect(messenger.sentTexts).toHaveLength(1);
    expect(messenger.sentTexts[0]).toContain('מכסת ההוראות');
  });

  it('processes a burst in provider-timestamp order, one instruction each', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();

    const earlier = new Date('2026-10-04T08:00:00.000Z').toISOString();
    const later = new Date('2026-10-04T08:05:00.000Z').toISOString();

    // Enqueued out of chronological order on purpose: the later message first.
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'שנייה (מאוחרת)', providerTimestamp: later }));
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'ראשונה (מוקדמת)', providerTimestamp: earlier }));

    const seenInstructions: string[] = [];
    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: async (request) => {
        seenInstructions.push(request.instruction ?? '');
        return { status: 'planned', plan: mailPlan() };
      },
    });

    expect(result).toEqual({ polled: 2, instructed: 2, recordedOnly: 0, refused: 0 });
    expect(seenInstructions).toEqual(['ראשונה (מוקדמת)', 'שנייה (מאוחרת)']);
  });

  it('throws before touching the queue when no active charter is installed', async () => {
    await resetDatabase(); // undoes `withCharter` from `beforeEach` — no charter installed at all

    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לדנה' }));

    await expect(
      runWhatsAppDoor({ gateway, messenger, businessId: BUSINESS, planner: neverCalled }),
    ).rejects.toThrow();

    // Failed before the first `recordInbound` — nothing was ever written.
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM whatsapp_messages WHERE business_id = $1',
      [BUSINESS],
    );
    expect(rows[0]?.n).toBe('0');
  });
});
