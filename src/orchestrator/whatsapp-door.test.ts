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
import type { NormalizedInboundMessage, WhatsAppGateway } from '../whatsapp/gateway.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import { createFakeMessenger } from '../whatsapp/fake-messenger.js';
import { compareInbound, runWhatsAppDoor } from './whatsapp-door.js';

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

/** Proves the byte cap refuses BEFORE the paid transcription provider is ever called. */
const neverCalledProvider = async (): Promise<{ text: string }> => {
  throw new Error('transcription provider must not be called for this message');
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
    // `allJobs`, not `openJobs` — fix round 1, Important 8. `openJobs` only
    // excludes terminal phases, so it cannot tell "no job was ever created"
    // apart from "a job was created and then failed out" — the one property
    // this test is meant to carry.
    expect(await allJobs(BUSINESS)).toHaveLength(0);
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
   * Fix round 1, Critical 1 + Important 6. Before the fix,
   * `recordWhatsAppInstructionAttempt` was called with no `businessId`
   * argument at all, so the write silently fell back to `config.businessId`
   * while the daily-cap *read* correctly used `ctx.businessId` — the cap
   * never filled for any business this door was explicitly given, and
   * `audit_log` (append-only) accumulated rows under the wrong business
   * forever. No test caught it, because the cap test below seeds its own
   * rows directly rather than ever observing the door write one. This test
   * closes both gaps at once, exactly as the review suggested: it asserts a
   * `whatsapp_instruction` row exists under the business the door was given
   * — which also pins "every outcome, including `refused`, counts" — and
   * that none landed under `config.businessId` instead.
   */
  it('writes the instruction audit row under the business it was given, never the default', async () => {
    // Sanity: if these were ever equal, the two counts below could not tell
    // a misattributed row apart from a correctly-attributed one.
    expect(config.businessId).not.toBe(BUSINESS);

    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'ג׳יבריש לא מובן' }));

    await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: async () => ({ status: 'unparseable', raw: 'not json', reason: 'bad model output' }),
    });

    const underGivenBusiness = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE business_id = $1 AND kind = 'whatsapp_instruction'`,
      [BUSINESS],
    );
    expect(underGivenBusiness.rows[0]?.n).toBe('1');

    const underDefaultBusiness = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE business_id = $1 AND kind = 'whatsapp_instruction'`,
      [config.businessId],
    );
    expect(underDefaultBusiness.rows[0]?.n).toBe('0');
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
    // Fix round 1, Important 6: without `toHaveLength(1)`, a two-message
    // split (transcript first, ack second) would satisfy both `toContain`
    // checks below just as well, leaving ruling 4's "one message, never two"
    // completely unlocked.
    expect(messenger.sentTexts).toHaveLength(1);
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

  /**
   * Fix round 1, Important 2–4. `transcribeInbound` awaits
   * `msg.downloadAudio()` outside its own try (`transcribe.ts`'s own
   * docblock calls this out), so a failed download throws all the way out of
   * `transcribeInbound` — the realistic trigger the review identified, not a
   * contrived one. Before this fix round, the door's `catch` settled the row
   * `'failed'` but told the owner nothing and returned `'skipped'`, which
   * counts toward none of `DoorResult`'s three buckets: a pass that destroyed
   * every instruction this way was indistinguishable from a pass of pure
   * redeliveries. Now it notifies (because the sender was already
   * established as the principal before this throw), settles `'failed'`,
   * and counts as `'refused'`.
   */
  it('tells the owner and settles failed when downloading the recording itself throws', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    const msg = audioMsg({ senderNumber: PRINCIPAL_NUMBER });
    msg.downloadAudio = async () => {
      throw new Error('network died mid-download');
    };
    gateway.enqueue(msg);

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      provider: async () => ({ text: 'should never be reached' }),
      planner: neverCalled,
    });

    expect(result.refused).toBe(1);
    expect(messenger.sentTexts).toHaveLength(1);
    expect(messenger.sentTexts[0]).not.toBe('');
    expect(await stateOf(msg.providerMessageId)).toBe('failed');
  });

  /**
   * Fix round A, finding 5 — `transcribeInbound`'s `'too_large'` outcome,
   * wired through the door. 21 MB mirrors the production byte cap
   * (`MAX_AUDIO_DOWNLOAD_BYTES`, 20 MB in `transcribe.ts`) the same way
   * `ingest.test.ts` mirrors `MAX_ORIGINAL_BYTES` — not imported, since the
   * constant is module-private, but matched in order of magnitude so this
   * test fails honestly if that constant ever changes without this one
   * being revisited.
   */
  it('tells the owner when the recording exceeds the byte cap, independent of the provider', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    const msg = audioMsg({ senderNumber: PRINCIPAL_NUMBER });
    msg.downloadAudio = async () => ({
      bytes: Buffer.alloc(21 * 1024 * 1024, 0x61),
      mimeType: 'audio/ogg',
      seconds: 10,
    });
    gateway.enqueue(msg);

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      provider: neverCalledProvider,
      planner: neverCalled,
    });

    expect(result.refused).toBe(1);
    expect(messenger.sentTexts).toHaveLength(1);
    expect(messenger.sentTexts[0]).toContain('גדולה מדי');
    expect(await stateOf(msg.providerMessageId)).toBe('failed');
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
    // Fix round 1, Minor 12: `not.toBe('')` cannot tell this branch apart
    // from the transcription-FAILED branch, which also sends a non-empty
    // Hebrew sentence. `'לתמלל'` ("to transcribe") appears only in the
    // no-transcriber sentence, never in `CANNOT_UNDERSTAND`
    // (`transcribe.ts`), so this actually pins which branch ran.
    expect(messenger.sentTexts[0]).toContain('לתמלל');
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

  /**
   * Fix round 2, item 1. Unit-tested directly against the exported
   * `compareInbound`, not driven through `runWhatsAppDoor` — a
   * `providerTimestamp` unreadable enough to make `getTime()` return `NaN`
   * is typically one `recordInbound`'s `TIMESTAMPTZ` column rejects outright
   * (confirmed: routing this case through the full door throws inside
   * `recordInbound` and the message never reaches the planner at all, which
   * would test the wrong thing — DB rejection, not sort order).
   *
   * An earlier version of `compareInbound` returned `0` for any pair where
   * either side's timestamp failed to parse — not a genuine total order,
   * since the `NaN` side then ties with *every* message it is compared
   * against, readable or not, rather than occupying one consistent place.
   * That is non-transitive: the coordinator's worked counter-example is
   * `a = (NaN, id "b")`, `b = (t 100, id "a")`, `c = (t 1, id "c")`, whose
   * pairwise comparisons form a cycle (`c < b`, `b < a`, `a < c`).
   * `Array.prototype.sort` has no obligation to behave predictably under a
   * comparator that is not a total order — and empirically does not, for
   * this exact triple: **array order matters**. `[a, b, c]` happens to come
   * out correct under the buggy comparator anyway (confirmed by running it);
   * `[a, c, b]` does not (confirmed the same way — it comes out
   * `a, c, b`, unreadable *first*, the opposite of what fix round 2
   * requires). The array below is `[a, c, b]` for exactly that reason: a
   * comparator that merely "doesn't crash" on an arbitrarily-chosen input
   * order is not evidence of anything, and a prior version of this test
   * (fix round 2's own first draft) used `[a, b, c]` and passed even with the
   * bug still in place.
   */
  it('sorts a message with an unreadable timestamp after every readable one, never interleaved', () => {
    const a: NormalizedInboundMessage = {
      providerMessageId: 'b',
      senderNumber: PRINCIPAL_NUMBER,
      body: 'a (unreadable timestamp)',
      mediaKind: null,
      providerTimestamp: 'not-a-real-timestamp',
    };
    const b: NormalizedInboundMessage = {
      providerMessageId: 'a',
      senderNumber: PRINCIPAL_NUMBER,
      body: 'b (t=100)',
      mediaKind: null,
      providerTimestamp: new Date(100).toISOString(),
    };
    const c: NormalizedInboundMessage = {
      providerMessageId: 'c',
      senderNumber: PRINCIPAL_NUMBER,
      body: 'c (t=1)',
      mediaKind: null,
      providerTimestamp: new Date(1).toISOString(),
    };

    // Input order [a, c, b] — not [a, b, c] — see this test's own docblock
    // for why the order itself had to be chosen empirically.
    const ordered = [a, c, b].sort(compareInbound).map((m) => m.body);

    // Readable timestamps chronologically first (c before b), the
    // unreadable one strictly last — a genuine total order, not merely "a
    // comparator that happened not to crash" on this input.
    expect(ordered).toEqual(['c (t=1)', 'b (t=100)', 'a (unreadable timestamp)']);
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

  /**
   * Fix round A, finding 3. `gateway.pollOnce()` is the FIRST thing this
   * door does on every pass, inside `schedulerPass`'s one sequential await
   * chain — a wedged provider here freezes the entire pass, not just the
   * WhatsApp loops. `pollTimeoutMs` stands in for `POLL_TIMEOUT_MS` (60s in
   * production) so this proves the race without waiting out a real
   * 60-second timer, the same pattern `transcribeInbound`'s `timeoutMs`
   * already uses for its own 60s default.
   */
  it('gives up on a gateway.pollOnce() that never settles, within the deadline, instead of hanging forever', async () => {
    const messenger = createFakeMessenger();
    const hangingGateway: WhatsAppGateway = {
      async canSendFreeform() {
        return true;
      },
      async sendMessage() {
        return { messageId: 'x', state: 'sent' };
      },
      async health() {
        return { state: 'connected', since: new Date().toISOString() };
      },
      onInbound() {
        // Never actually registered against — `pollOnce` never resolves to
        // let anything drive it.
      },
      pollOnce(): Promise<number> {
        return new Promise(() => {
          /* deliberately never settles */
        });
      },
    };

    await expect(
      runWhatsAppDoor({
        gateway: hangingGateway,
        messenger,
        businessId: BUSINESS,
        planner: neverCalled,
        pollTimeoutMs: 25,
      }),
    ).rejects.toThrow(/did not finish within/);
  });
});
