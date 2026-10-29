import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import { config } from '../config.js';
import type { Plan } from '../domain/plan.js';
import type { PlanOutcome, PlanRequest } from '../sdk/planner.js';
import type { NormalizedInboundMessage, WhatsAppGateway } from '../whatsapp/gateway.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import { createFakeMessenger } from '../whatsapp/fake-messenger.js';
import { writeMemory } from '../memory/store.js';
import { createJob, loadJob, transition } from './jobs.js';
import {
  CONFIRM_CANCELLED,
  CONFIRM_EXECUTING,
  CONFIRM_FAILED,
  CONFIRM_UNCLEAR,
  SEVERAL_OPEN_REFUSAL,
  compareInbound,
  runWhatsAppDoor,
} from './whatsapp-door.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { FakeGateway } from '../whatsapp/fake-gateway.js';
import { createBossMessenger, type BossMessenger } from '../whatsapp/messenger.js';
import { QUESTION_TRIAGE, installMailboxCharter, storedMail, stubDrafter } from '../test/mailbox.js';
import { getApproval } from '../governance/approvals.js';
import { saveInstruction } from '../governance/instructions.js';
import {
  createConfirmation,
  loadConfirmation,
  markConfirmationDelivered,
  type ConfirmationOption,
} from '../governance/instruction-confirmations.js';
import {
  WHATSAPP_MESSAGE_MAX_CHARS,
  WHATSAPP_QUESTION_TOO_LONG,
  dashboardConfirmations,
} from './command-confirm.js';
import { bindPlanToJob, planHashOf } from './plan-store.js';
import { raiseMailReply } from './mail-reply.js';
import { presentMailCard } from './whatsapp-mail-card.js';

const BUSINESS = 'test-business';
// `buildCharter`'s default principal (`src/test/fixtures.ts`) carries this
// number on the `whatsapp` channel — the one sender this door ever acts on.
const PRINCIPAL_NUMBER = '+972500000000';
/**
 * What the planner must receive when a message is routed as an answer: the
 * parked instruction, a blank line, then the answer. Written here with an
 * explicit escape rather than inline, so the assertion cannot pass on a
 * literal that merely looks right in a right-to-left editor.
 */
const JOINED_ANSWER = ['תשלחי לרונית', 'רונית כהן'].join('\n\n');
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

/**
 * A plan of reads only — no classified step, so it runs without a
 * confirmation question (boss command, spec §10.4). For tests whose subject
 * is the door itself rather than what a side-effecting plan now waits for.
 */
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
      // Reads only, so the job goes straight to `execute` as before; a
      // side-effecting plan now parks on a confirmation question (see the
      // boss-command tests at the end of this file).
      planner: plannedWith(recallPlan()),
    });

    expect(result).toEqual({ polled: 1, instructed: 1, recordedOnly: 0, refused: 0, closed: 0, mailCardReplies: 0, confirmationReplies: 0, confirmErrored: [], malformedSenderCount: 0 });
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
    // A well-formed stranger's number is NOT a gateway contract violation —
    // fix round B, finding 3's own negative half: this must stay 0 for the
    // ordinary case this test already covers, or the new counter would be
    // indistinguishable noise on every pass with real customer traffic.
    expect(result.malformedSenderCount).toBe(0);
    expect(messenger.sentTexts).toEqual([]); // no auto-reply, ever
    // `allJobs`, not `openJobs` — fix round 1, Important 8. `openJobs` only
    // excludes terminal phases, so it cannot tell "no job was ever created"
    // apart from "a job was created and then failed out" — the one property
    // this test is meant to carry.
    expect(await allJobs(BUSINESS)).toHaveLength(0);
  });

  /**
   * Fix round B, finding 3. A `senderNumber` the gateway hands up in a
   * shape `authorityNumberKey` cannot parse (here: the national form, no
   * `+`) is a GATEWAY CONTRACT VIOLATION — exactly the class of mismatch
   * round A's wrong "bare international form" ledger instruction would
   * have produced for every message from the owner's OWN number. Before
   * this counter existed, this was byte-for-byte indistinguishable from
   * `STRANGER_NUMBER` above: same `recordedOnly`, same silence. Nothing
   * about the message's OWN handling changes — it still settles exactly as
   * a stranger's does (Decision 4: no reply, ever) — only this counter
   * tells the two apart for whoever reads `DoorResult.malformedSenderCount`.
   */
  it('counts a malformed senderNumber apart from an ordinary stranger, without changing how the message is handled', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg({ senderNumber: '0549999999', body: 'מה המחיר שלכם?' }));

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: neverCalled,
    });

    expect(result.recordedOnly).toBe(1); // handled identically to a stranger
    expect(result.malformedSenderCount).toBe(1); // but counted apart
    expect(messenger.sentTexts).toEqual([]); // still no auto-reply, ever
  });

  /**
   * A redelivery of the SAME malformed message must not inflate the count
   * a second time — `recordInbound`'s unique index decides a redelivery is
   * a no-op (`'skipped'`), and the positive check sits AFTER that guard for
   * exactly this reason.
   */
  it('does not count a redelivered malformed message twice', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    const msg = textMsg({ senderNumber: '0549999999', body: 'מה המחיר שלכם?' });
    gateway.enqueue(msg);

    await runWhatsAppDoor({ gateway, messenger, businessId: BUSINESS, planner: neverCalled });

    gateway.enqueue(msg); // identical providerMessageId — a redelivery
    const second = await runWhatsAppDoor({ gateway, messenger, businessId: BUSINESS, planner: neverCalled });

    expect(second.malformedSenderCount).toBe(0);
  });

  // --- Task 12: an answer is routed to its question, not planned afresh. ---

  /**
   * **The defect this task exists for, end to end.** The owner writes
   * "תשלחי לרונית", the assistant asks which רונית, he answers "רונית כהן"
   * — and before this, that answer was handed to the planner as a
   * standalone command while the original request sat in `understand`
   * forever, a phase the report deliberately excludes. He asked, was asked
   * back, answered, and nothing happened, with no error.
   *
   * **This test is also the positive control over the window's clock
   * arithmetic**, and that is why it passes NO `questionWindowMinutes` and no
   * `now`: it runs on `config.whatsappQuestionWindowMinutes` (30) against a
   * `boss_instructions.created_at` that Postgres wrote and
   * `withinQuestionWindow` parsed with `Date.parse`. If that parse ever
   * stopped working — a `created_at::text` rendering V8 declines, the column
   * changing shape — the window would silently reject every question and this
   * routing would quietly never fire again. Every other window assertion
   * injects both values and would stay green through that.
   */
  it('routes the answer to an open question instead of planning it as a new instruction', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    const question = 'לאיזו רונית — רונית כהן או רונית לוי?';

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לרונית' }));
    const first = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan({ clarifyingQuestion: question })),
    });
    expect(first.instructed).toBe(1);
    const parked = (await openJobs(BUSINESS))[0];
    if (parked === undefined) throw new Error('unreachable');

    const seen: string[] = [];
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'רונית כהן' }));
    const second = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: async (request) => {
        seen.push(request.instruction ?? '');
        return { status: 'planned', plan: mailPlan() };
      },
    });

    expect(second.instructed).toBe(1);
    // The planner saw the original request AND the answer, not the answer
    // alone — the single fact the whole task turns on.
    expect(seen).toEqual([JOINED_ANSWER]);

    // Spec §5.4: the acknowledgement says which reading was chosen, quoting
    // the request it joined, so a wrong reading is visible before anything
    // goes out.
    const ack = messenger.sentTexts[1] ?? '';
    expect(ack).toContain('לבקשה הקודמת');
    expect(ack).toContain('תשלחי לרונית');

    // The answer is on the row, so the question is no longer open and the
    // next message is a new instruction again.
    const { rows } = await getPool().query<{ answer: string | null }>(
      'SELECT answer FROM boss_instructions WHERE job_id = $1',
      [parked.jobId],
    );
    expect(rows[0]?.answer).toBe('רונית כהן');

    // The parked job is superseded, naming its replacement, and its opening
    // message is claimed `'reported'` — which is what stops the report pass
    // telling the owner that the instruction he just answered "failed".
    const jobRow = await getPool().query<{ phase: string; whatsapp_message_id: string | null }>(
      'SELECT phase, whatsapp_message_id FROM jobs WHERE job_id = $1',
      [parked.jobId],
    );
    expect(jobRow.rows[0]?.phase).toBe('failed');
    const openingMessage = jobRow.rows[0]?.whatsapp_message_id;
    const openingRow = await getPool().query<{ state: string }>(
      'SELECT state FROM whatsapp_messages WHERE id = $1',
      [openingMessage],
    );
    expect(openingRow.rows[0]?.state).toBe('reported');
  });

  /**
   * The answer re-run passes `identityAsked: true`, exactly as the
   * dashboard's answer route does (spec §7.2) — and this is the one path
   * where that flag is load-bearing rather than incidental.
   *
   * Two contacts named רונית make the FIRST pass stop on the identity
   * question before the planner is ever called (`neverCalled` proves that).
   * The answer "רונית כהן" does not necessarily disambiguate on its own —
   * both contacts still match the token רונית — so without the flag the
   * second pass would ask the very same question again, and the one after
   * that, forever. The flag's deliberate coarseness (`instruct.ts`: it
   * remembers only that a second pass is underway, never which name was
   * ambiguous) is what bounds the loop.
   */
  it('suppresses the identity question on the answer pass, so the same name is not asked about forever', async () => {
    const active = await loadActiveCharter(BUSINESS);
    if (active === null) throw new Error('unreachable');
    const seedJob = await createJob({
      charterVersion: active.charter.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-cohen-beta-log',
        body: { name: 'רונית כהן', company: 'בטא לוגיסטיקה' },
      },
      { businessId: BUSINESS },
    );
    await writeMemory(
      {
        jobId: seedJob.jobId,
        kind: 'entity',
        subjectKey: 'ronit-levi-gamma',
        body: { name: 'רונית לוי', company: 'גמא הרמה' },
      },
      { businessId: BUSINESS },
    );
    // Four in all, so the identity question itself is asked: two or three
    // distinguishable candidates are planned one by one instead (boss
    // command, spec §4.2).
    for (const [key, name, company] of [
      ['ronit-mizrahi-delta', 'רונית מזרחי', 'דלתא דפוס'],
      ['ronit-peretz-omega', 'רונית פרץ', 'אומגה שיווק'],
    ] as const) {
      await writeMemory(
        { jobId: seedJob.jobId, kind: 'entity', subjectKey: key, body: { name, company } },
        { businessId: BUSINESS },
      );
    }

    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לרונית' }));
    const first = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      // The identity question returns before the planner is reached at all.
      planner: neverCalled,
    });
    expect(first.instructed).toBe(1);
    expect(messenger.sentTexts[0]).toContain('רונית כהן'); // the question names both
    expect(messenger.sentTexts[0]).toContain('רונית לוי');

    const seen: string[] = [];
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'רונית כהן' }));
    const second = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: async (request) => {
        seen.push(request.instruction ?? '');
        return { status: 'planned', plan: mailPlan() };
      },
    });

    // The planner really ran on the joined text — the identity question did
    // not fire a second time and send the owner round again.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('תשלחי לרונית');
    expect(seen[0]).toContain('רונית כהן');
    expect(second.instructed).toBe(1);
  });

  /**
   * The owner's own words close an instruction — the other half of his rule
   * ("או שהעוזרת האישית מודיעה על 'בוצע'/'נכשל'"). Nothing is planned,
   * nothing spends a planner call, and nothing later reports the closed
   * instruction as though it finished on its own.
   */
  it('closes the open instruction when the owner says so, and leaves nothing for the report to speak for', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לרונית' }));
    await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan({ clarifyingQuestion: 'לאיזו רונית?' })),
    });
    const parked = (await openJobs(BUSINESS))[0];
    if (parked === undefined) throw new Error('unreachable');

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'סגרנו' }));
    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      // A closure never reaches the planner at all.
      planner: neverCalled,
    });

    expect(result.closed).toBe(1);
    expect(result.instructed).toBe(0);
    expect(result.refused).toBe(0);

    // Told in Hebrew what was closed, not merely that something was.
    const confirmation = messenger.sentTexts[1] ?? '';
    expect(confirmation).toContain('סגרתי');
    expect(confirmation).toContain('תשלחי לרונית');

    const jobRow = await getPool().query<{ phase: string; whatsapp_message_id: string | null }>(
      'SELECT phase, whatsapp_message_id FROM jobs WHERE job_id = $1',
      [parked.jobId],
    );
    expect(jobRow.rows[0]?.phase).toBe('closed');
    const openingRow = await getPool().query<{ state: string }>(
      'SELECT state FROM whatsapp_messages WHERE id = $1',
      [jobRow.rows[0]?.whatsapp_message_id],
    );
    expect(openingRow.rows[0]?.state).toBe('reported');
    expect(await openJobs(BUSINESS)).toHaveLength(0);
  });

  /**
   * **Fix round 1, Important 1, end to end.** `זהו` is a closure word and
   * closure is tested before the answer route, so under a flat token bound
   * "זהו, רונית כהן" closed the question instead of answering it and the
   * answer went nowhere — this task's own defect, re-entered through its own
   * fix.
   *
   * The unit test in `closure-command.test.ts` proves the predicate says
   * `false`; this proves the CONSEQUENCE, which is the thing that was broken:
   * the planner receives the joined text, and the question is answered rather
   * than closed.
   */
  it('answers a question with a message that opens with a closure word, instead of closing it', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לרונית' }));
    await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan({ clarifyingQuestion: 'לאיזו רונית?' })),
    });
    const parked = (await openJobs(BUSINESS))[0];
    if (parked === undefined) throw new Error('unreachable');

    const seen: string[] = [];
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'זהו, רונית כהן' }));
    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: async (request) => {
        seen.push(request.instruction ?? '');
        return { status: 'planned', plan: mailPlan() };
      },
    });

    // Routed as the ANSWER: the planner ran on the joined text, and nothing
    // was closed.
    expect(result.closed).toBe(0);
    expect(result.instructed).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('תשלחי לרונית');
    expect(seen[0]).toContain('זהו, רונית כהן');
    expect(messenger.sentTexts[1]).toContain('לבקשה הקודמת');

    const { rows } = await getPool().query<{ answer: string | null }>(
      'SELECT answer FROM boss_instructions WHERE job_id = $1',
      [parked.jobId],
    );
    expect(rows[0]?.answer).toBe('זהו, רונית כהן');
  });

  /**
   * The other half of Important 1: the verb still closes on its own, which is
   * what it is for. Without this, the fix above could have been "remove זהו
   * from the list" and nothing would have noticed.
   */
  it('still closes on a bare closure word that cannot carry anything after it', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לרונית' }));
    await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan({ clarifyingQuestion: 'לאיזו רונית?' })),
    });

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'זהו' }));
    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: neverCalled,
    });

    expect(result.closed).toBe(1);
    expect(messenger.sentTexts[1]).toContain('סגרתי');
    expect(await openJobs(BUSINESS)).toHaveLength(0);
  });

  /**
   * **Fix round 1, Important 2, end to end.** A cancellation is a real
   * instruction: it must reach the planner, not be answered with "everything
   * is already closed on my side" — a false reassurance about work nobody
   * did. Nothing is open here, so the only two possible readings are closure
   * and instruction.
   *
   * **Three tokens exactly, and that is the point.** A four-token
   * cancellation ("תעזבי את הפגישה עם דנה") is excluded by the token bound
   * alone, so it would pass this test even with `aloneOnly` ignored — a
   * negative test that holds without the code it claims to cover. At three
   * tokens the ONLY thing keeping it out of the closure branch is the
   * per-verb allowance, which is what Important 2 is about.
   */
  it('plans a cancellation instead of reporting that there was nothing to close', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תעזבי את הפגישה' }));

    const seen: string[] = [];
    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: async (request) => {
        seen.push(request.instruction ?? '');
        return { status: 'planned', plan: mailPlan() };
      },
    });

    expect(result.instructed).toBe(1);
    expect(result.closed).toBe(0);
    expect(seen).toEqual(['תעזבי את הפגישה']);
    expect(messenger.sentTexts[0]).not.toContain('הכול כבר סגור');
  });

  it('says so plainly when a closure word finds nothing open, and plans nothing', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'סגרנו' }));

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: neverCalled,
    });

    expect(result.closed).toBe(1);
    expect(messenger.sentTexts[0]).toContain('אין לי כרגע בקשה פתוחה');
    expect(await allJobs(BUSINESS)).toHaveLength(0);
  });

  /**
   * The chosen rule's cost, mitigated: when the re-run on the joined text
   * refuses, the message was probably not an answer. The owner is told so in
   * Hebrew, and the previous request is CLOSED rather than left open —
   * otherwise his next message joins it and refuses again, with nothing he
   * could type to get out.
   */
  it('tells the owner plainly when the joined text cannot be planned, and closes the previous request', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לרונית' }));
    await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan({ clarifyingQuestion: 'לאיזו רונית?' })),
    });
    const parked = (await openJobs(BUSINESS))[0];
    if (parked === undefined) throw new Error('unreachable');

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'משהו אחר לגמרי' }));
    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: async () => ({ status: 'unparseable', raw: 'not json', reason: 'bad model output' }),
    });

    expect(result.refused).toBe(1);
    const told = messenger.sentTexts[1] ?? '';
    expect(told).toContain('לבקשה הקודמת'); // which reading was chosen
    expect(told).toContain('סגרתי את הבקשה הקודמת'); // and what happened to it

    const jobRow = await getPool().query<{ phase: string }>(
      'SELECT phase FROM jobs WHERE job_id = $1',
      [parked.jobId],
    );
    expect(jobRow.rows[0]?.phase).toBe('closed');
    // Nothing is left open, so the next message is read as a new instruction
    // rather than joined to the same request and refused again.
    expect(await openJobs(BUSINESS)).toHaveLength(0);
  });

  /**
   * A second question on the joined text is the other signal that the
   * message was not an answer. Here the previous request IS superseded (a
   * replacement job exists and carries its own question), so the sentence
   * says what to do instead of claiming a close that did not happen.
   */
  it('tells the owner the message may not have been an answer when it is asked again', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לרונית' }));
    await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan({ clarifyingQuestion: 'לאיזו רונית?' })),
    });

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'משהו אחר' }));
    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan({ clarifyingQuestion: 'עדיין לא הבנתי — למי?' })),
    });

    expect(result.instructed).toBe(1);
    const told = messenger.sentTexts[1] ?? '';
    expect(told).toContain('עדיין לא הבנתי'); // the new question itself
    expect(told).toContain('כהוראה נפרדת'); // and the way out
  });

  /**
   * **Fix round 1's Minor: the refusal to guess had no door-level test.** The
   * routing unit test proves the DECISION; this proves what the owner actually
   * gets — the question, nothing planned, no answer claimed, and both open
   * questions still open afterwards, which is the property that makes the
   * refusal a refusal rather than a quiet drop.
   *
   * The two open questions are built with the door's window switched off, for
   * the reason `whatsapp-routing.test.ts`'s own fixture gives: with the window
   * on, the second message would be routed to the first question instead of
   * opening its own.
   */
  it('asks which question a message answers when more than one is open, and plans nothing', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();

    for (const body of ['תשלחי לרונית', 'תזמיני ספקים']) {
      gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body }));
      await runWhatsAppDoor({
        gateway,
        messenger,
        businessId: BUSINESS,
        planner: plannedWith(mailPlan({ clarifyingQuestion: `לגבי ${body}?` })),
        questionWindowMinutes: 0,
      });
    }
    const parkedBefore = await openJobs(BUSINESS);
    expect(parkedBefore).toHaveLength(2);

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'רונית כהן' }));
    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      // Nothing is planned on this branch — no planner call at all.
      planner: neverCalled,
      questionWindowMinutes: 30,
    });

    expect(result.refused).toBe(1);
    expect(result.instructed).toBe(0);
    expect(result.closed).toBe(0);

    const asked = messenger.sentTexts[2] ?? '';
    expect(asked).toContain('יותר משאלה פתוחה אחת');
    expect(asked).toContain('תשלחי לרונית'); // both candidates named
    expect(asked).toContain('תזמיני ספקים');
    expect(asked).toContain('סגרנו'); // the exit from WhatsApp itself

    // Nothing was taken: both questions are still open and still answerable,
    // so the refusal cost the owner nothing but a round trip.
    expect(await openJobs(BUSINESS)).toHaveLength(2);
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM boss_instructions
        WHERE business_id = $1 AND answer IS NOT NULL`,
      [BUSINESS],
    );
    expect(rows[0]?.n).toBe('0');
  });

  /**
   * A question past the window stops consuming messages — and must not
   * therefore stop existing on the one surface the owner reads. He is told
   * it is still waiting, and where to answer it.
   */
  it('reads a message as a new instruction past the window, and says the older question is still waiting', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לרונית' }));
    await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan({ clarifyingQuestion: 'לאיזו רונית?' })),
      questionWindowMinutes: 0,
    });

    const seen: string[] = [];
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תזמיני לי ספקים' }));
    await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: async (request) => {
        seen.push(request.instruction ?? '');
        return { status: 'planned', plan: mailPlan() };
      },
      questionWindowMinutes: 0,
    });

    // Nothing was joined: the planner saw the new message on its own.
    expect(seen).toEqual(['תזמיני לי ספקים']);
    const ack = messenger.sentTexts[1] ?? '';
    expect(ack).toContain('כהוראה חדשה');
    expect(ack).toContain('שאלה אחת פתוחה');
  });

  /**
   * The daily instruction cap gates the planner, and a closure does not use
   * it. Were the cap checked first, a spent day would leave the owner's open
   * work unclosable until tomorrow — the one thing his rule forbids.
   */
  it('lets the owner close open work on a day the instruction cap is already spent', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לרונית' }));
    await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan({ clarifyingQuestion: 'לאיזו רונית?' })),
    });
    const parked = (await openJobs(BUSINESS))[0];
    if (parked === undefined) throw new Error('unreachable');

    for (let i = 0; i < config.whatsappInstructionsPerDay; i += 1) {
      await seedInstructionAttempt(BUSINESS);
    }

    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'סגרנו' }));
    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: neverCalled,
    });

    expect(result.closed).toBe(1);
    expect(result.refused).toBe(0);
    expect(messenger.sentTexts[1]).not.toContain('מכסת ההוראות');
    const jobRow = await getPool().query<{ phase: string }>(
      'SELECT phase FROM jobs WHERE job_id = $1',
      [parked.jobId],
    );
    expect(jobRow.rows[0]?.phase).toBe('closed');
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

    // One message, carrying the question verbatim — `composeAck` returns
    // `runInstruction`'s own sentence unchanged and never paraphrases it.
    //
    // No longer an exact equality: task 12 prefixes every acknowledgement
    // with the reading that was chosen (spec §5.4, "האישור אומר תמיד איזו
    // פרשנות נבחרה"), so that a message read as an answer to an open
    // question — or, here, as a new instruction — is visible as such before
    // anything goes out. Both halves are asserted rather than loosened to
    // one `toContain`.
    expect(messenger.sentTexts).toHaveLength(1);
    expect(messenger.sentTexts[0]).toContain(question);
    expect(messenger.sentTexts[0]).toContain('כהוראה חדשה');
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

  /**
   * The echo is the one thing the owner reads to check what she heard BEFORE
   * anything runs, and a right-to-left override inside a transcript
   * rearranges what he reads while leaving the bytes that will be acted on
   * untouched — so the sentence he approves of can differ from the one about
   * to be planned. Same hazard `escLabel` was written for on the dashboard,
   * same single owner (`util/bidi.ts`).
   *
   * The positive half is load-bearing, not decoration: a strip that ate the
   * whole transcript would satisfy the absence check on its own, and then
   * this test would be asserting that the owner is told nothing.
   */
  it('strips direction overrides from the transcript it quotes back', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(audioMsg({ senderNumber: PRINCIPAL_NUMBER }));

    const provider = async () => ({ text: 'תשלחי למוטי‮000,5 ש"ח' });

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      provider,
      planner: plannedWith(mailPlan()),
    });

    expect(result.instructed).toBe(1);
    expect(messenger.sentTexts).toHaveLength(1);
    expect(messenger.sentTexts[0]).not.toContain('‮');
    expect(messenger.sentTexts[0]).toContain('תשלחי למוטי');
    expect(messenger.sentTexts[0]).toContain('000,5');
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
   * wired through the door. 4 MB mirrors the production byte cap
   * (`MAX_TRANSCRIBABLE_AUDIO_BYTES`, 3 MB in `transcribe.ts` — renamed and
   * re-derived in fix round B, finding 1) the same way `ingest.test.ts`
   * mirrors `MAX_ORIGINAL_BYTES` — not imported, since the constant is
   * module-private, but matched in order of magnitude so this test fails
   * honestly if that constant ever changes without this one being
   * revisited.
   */
  it('tells the owner when the recording exceeds the byte cap, independent of the provider', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    const msg = audioMsg({ senderNumber: PRINCIPAL_NUMBER });
    msg.downloadAudio = async () => ({
      bytes: Buffer.alloc(4 * 1024 * 1024, 0x61),
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

    expect(result).toEqual({ polled: 2, instructed: 2, recordedOnly: 0, refused: 0, closed: 0, mailCardReplies: 0, confirmationReplies: 0, confirmErrored: [], malformedSenderCount: 0 });
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

/**
 * Owner's decision 2 (05/10/2026), through the channel that is the only
 * producer of a transcript in the whole system.
 *
 * This door is the one caller that can ever hand `runInstruction`
 * `textOrigin: 'transcribed'`, so it is the only place the end-to-end
 * property can be measured: a voice note naming an address must not buy that
 * address a standing authorisation, and the owner must hear why in the same
 * message that acknowledges his instruction.
 */
describe('a recording is not typing', () => {
  beforeEach(async () => {
    await resetDatabase();
    await withCharter();
  });

  afterAll(async () => {
    await closePool();
  });

  /** The address the plan addresses, written in the owner's words too. */
  const SPOKEN = 'תשלחי ל-dana@example.com את ההצעה';

  async function grants(): Promise<Array<{ recipients: string[] }>> {
    const { rows } = await getPool().query<{ recipients: string[] }>(
      'SELECT recipients FROM job_authorizations WHERE business_id = $1',
      [BUSINESS],
    );
    return rows;
  }

  async function storedOrigins(): Promise<string[]> {
    const { rows } = await getPool().query<{ text_origin: string }>(
      'SELECT text_origin FROM boss_instructions WHERE business_id = $1 ORDER BY created_at',
      [BUSINESS],
    );
    return rows.map((row) => row.text_origin);
  }

  it('plans a voice note but authorises nobody from it, and the question names the recipient', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(audioMsg({ senderNumber: PRINCIPAL_NUMBER }));

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      // The transcription provider is where these bytes come from. Nobody
      // typed them — which is the whole point: this is a third party's model
      // output, and before the origin rule it satisfied a check whose
      // meaning is "the owner typed this address himself".
      provider: async () => ({ text: SPOKEN }),
      planner: plannedWith(mailPlan()),
    });

    expect(result.instructed).toBe(1);
    expect(await storedOrigins()).toEqual(['transcribed']);
    // No standing authorisation, so the step takes the ordinary approval
    // path and the owner sees a card before anything reaches dana.
    expect(await grants()).toHaveLength(0);

    // One message, as ruling 4 requires — the transcript and the
    // acknowledgement ride together. The acknowledgement of a side-effecting
    // plan is now the confirmation question (boss command, spec §4), which
    // names the recipient and asks for the owner's explicit word — the
    // half of ruling 2 the recording note used to carry.
    expect(messenger.sentTexts).toHaveLength(1);
    const ack = messenger.sentTexts[0] ?? '';
    expect(ack).toContain('שמעתי:');
    expect(ack).toContain('dana@example.com');
    expect(ack).toContain('לאישור');
  });

  it('treats a typed WhatsApp message as the owner own bytes', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: SPOKEN }));

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan()),
    });

    // The paired positive, and the reason it matters: a door that simply
    // declared everything `'transcribed'` would pass the test above and fail
    // this one. A typed WhatsApp message is the owner's keystrokes exactly as
    // the dashboard box is, and his instruction is still his own approval.
    expect(result.instructed).toBe(1);
    expect(await storedOrigins()).toEqual(['typed']);
    expect(await grants()).toEqual([{ recipients: ['dana@example.com'] }]);
    expect(messenger.sentTexts[0] ?? '').not.toContain('הקלטה');
  });

  /**
   * The laundering path, which is why the origin is stored on the row rather
   * than held for the length of one pass.
   *
   * A voice note parks on a clarifying question; the owner answers by TYPING.
   * The re-plan runs over the JOIN of the two (task 12), so if the join were
   * judged by this message alone it would come out `'typed'` — and the
   * address the recording named would be authorised one hop later, by a
   * route that never saw a recording at all.
   */
  it('does not let a typed answer launder the recording it is joined to', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();

    gateway.enqueue(audioMsg({ senderNumber: PRINCIPAL_NUMBER }));
    const first = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      provider: async () => ({ text: SPOKEN }),
      planner: plannedWith(mailPlan({ clarifyingQuestion: 'לאיזו דנה?' })),
    });
    expect(first.instructed).toBe(1);
    expect(await storedOrigins()).toEqual(['transcribed']);

    const seen: string[] = [];
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'דנה מהמשרד' }));
    const second = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: async (request) => {
        seen.push(request.instruction ?? '');
        return { status: 'planned', plan: mailPlan() };
      },
    });

    expect(second.instructed).toBe(1);
    // The join really happened — without this, the assertions below could
    // pass because the answer was planned on its own (which names no address
    // and would authorise nobody for an unrelated reason).
    expect(seen).toEqual([[SPOKEN, 'דנה מהמשרד'].join('\n\n')]);

    // Both instruction rows: the recorded original, and the join that
    // inherits its origin because one half of it was never typed.
    expect(await storedOrigins()).toEqual(['transcribed', 'transcribed']);
    expect(await grants()).toHaveLength(0);
    // The owner is asked before anything reaches dana (spec §4).
    expect(messenger.sentTexts[1] ?? '').toContain('לאישור');
  });
});

/**
 * Boss command (spec 2026-10-28, §4): the WhatsApp door's minimal handling of
 * a side-effecting instruction — the confirmation question is the ack — and
 * spec §10.9's rule that one instruction counts once against the daily cap,
 * however many candidate plans it took.
 */
describe('a side-effecting instruction over WhatsApp', () => {
  beforeEach(async () => {
    await resetDatabase();
    await withCharter();
  });

  afterAll(async () => {
    await closePool();
  });

  async function instructionRowsToday(): Promise<number> {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE business_id = $1 AND kind = 'whatsapp_instruction'`,
      [BUSINESS],
    );
    return Number(rows[0]?.n ?? '0');
  }

  it('acknowledges with the confirmation question and parks the job', async () => {
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    const msg = textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי ל-dana@example.com את ההצעה' });
    gateway.enqueue(msg);

    const result = await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: plannedWith(mailPlan()),
    });

    expect(result.instructed).toBe(1);
    const ack = messenger.sentTexts[0] ?? '';
    expect(ack).toContain('dana@example.com');
    expect(ack).toContain('לאישור');

    const jobs = await openJobs(BUSINESS);
    expect(jobs).toHaveLength(1);
    const { rows } = await getPool().query<{ phase: string; channel: string }>(
      `SELECT j.phase, c.channel FROM jobs j
         JOIN instruction_confirmations c ON c.job_id = j.job_id
        WHERE j.job_id = $1`,
      [jobs[0]?.jobId],
    );
    expect(rows[0]?.phase).toBe('plan');
    expect(rows[0]?.channel).toBe('whatsapp');
    expect((await messageRow(msg.providerMessageId))?.state).toBe('handled');
  });

  it('counts one instruction once against the daily cap, however many candidates were planned', async () => {
    const active = await loadActiveCharter(BUSINESS);
    if (active === null) throw new Error('unreachable');
    const seedJob = await createJob({
      charterVersion: active.charter.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
    });
    for (const [key, name, email] of [
      ['ronit-cohen', 'רונית כהן', 'ronit@beta-log.example'],
      ['ronit-levi', 'רונית לוי', 'ronit.levi@gamma.example'],
    ] as const) {
      await writeMemory(
        { jobId: seedJob.jobId, kind: 'entity', subjectKey: key, body: { name, email } },
        { businessId: BUSINESS },
      );
    }

    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי לרונית את ההצעה' }));

    let calls = 0;
    const base = mailPlan().steps[0];
    if (base === undefined) throw new Error('unreachable');
    await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      planner: async (request) => {
        calls += 1;
        const to = request.resolvedContact?.includes('gamma')
          ? 'ronit.levi@gamma.example'
          : 'ronit@beta-log.example';
        return {
          status: 'planned',
          plan: mailPlan({ steps: [{ ...base, input: { to, subject: 'נושא', body: 'גוף' } }] }),
        };
      },
    });

    // Two planner calls really happened — one per candidate — and still one
    // row against the cap.
    expect(calls).toBe(2);
    expect(await instructionRowsToday()).toBe(1);
    expect(messenger.sentTexts[0] ?? '').toContain('למי התכוונת?');
  });
});

/**
 * Boss command over WhatsApp (spec §4.3, §10.11, Task 5): the confirm reader
 * runs FIRST for a principal's TYPED message — before the mail card and
 * before routing — and refuses to guess when more than one thing is open.
 *
 * A REAL `createBossMessenger` over the fake gateway, not the fake
 * messenger: the mail-card collision needs the outbound row the real one
 * writes (`openMailCards` derives "presented" from it), and every reply is
 * then read off `gateway.sent`.
 */
describe('confirming a held command over WhatsApp', () => {
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

  const PLAN_A = mailPlan();
  const PLAN_B = mailPlan({
    steps: [{ ...(mailPlan().steps[0] as Plan['steps'][number]), input: { to: 'dana.levi@x.example', subject: 'נושא', body: 'גוף' } }],
  });
  const SINGLE: ConfirmationOption = { label: 'לבצע?', planHash: planHashOf(PLAN_A), plan: PLAN_A, contactSource: null };
  const OPTION_A: ConfirmationOption = {
    label: 'דנה חיוט (dana@example.com)',
    planHash: planHashOf(PLAN_A),
    plan: PLAN_A,
    contactSource: 'boss',
    contactName: 'דנה חיוט',
  };
  const OPTION_B: ConfirmationOption = {
    label: 'דנה לוי (dana.levi@x.example)',
    planHash: planHashOf(PLAN_B),
    plan: PLAN_B,
    contactSource: 'boss',
    contactName: 'דנה לוי',
  };

  /** A boss job parked in `plan` on a WhatsApp confirmation — what `runInstruction` leaves. */
  async function held(options: ConfirmationOption[], bind = true): Promise<string> {
    const job = await createJob({ charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS });
    await saveInstruction({ jobId: job.jobId, text: 'תשלחי לדנה', textOrigin: 'typed' }, { businessId: BUSINESS });
    await transition(job.jobId, { to: 'understand', actor: 'orchestrator', reason: 't', businessId: BUSINESS });
    await transition(job.jobId, { to: 'plan', actor: 'orchestrator', reason: 't', businessId: BUSINESS });
    const only = options.length === 1 ? options[0] : undefined;
    if (bind && only !== undefined) await bindPlanToJob(job.jobId, only.plan, { businessId: BUSINESS });
    await createConfirmation(
      { jobId: job.jobId, options, presentedText: 'שאלה', channel: 'whatsapp' },
      { businessId: BUSINESS },
    );
    // What a successful send of the question leaves behind.
    await markConfirmationDelivered(job.jobId, { businessId: BUSINESS });
    return job.jobId;
  }

  /** The owner's typed reply, sent after the question (strictly after, by `offsetMs`). */
  function reply(body: string, offsetMs = 1_000): NormalizedInboundMessage {
    return textMsg({
      senderNumber: PRINCIPAL_NUMBER,
      body,
      providerTimestamp: new Date(Date.now() + offsetMs).toISOString(),
    });
  }

  function pass(planner: (r: PlanRequest) => Promise<PlanOutcome> = neverCalled) {
    return runWhatsAppDoor({ gateway, messenger, businessId: BUSINESS, planner });
  }

  function lastSent(): string {
    return gateway.sent.at(-1)?.body ?? '';
  }

  async function phase(jobId: string): Promise<string | undefined> {
    return (await loadJob(jobId, { businessId: BUSINESS }))?.phase;
  }

  async function confirmationState(jobId: string): Promise<string | undefined> {
    return (await loadConfirmation(jobId, { businessId: BUSINESS }))?.state;
  }

  async function raiseMailCard(): Promise<string> {
    const mail = await storedMail(BUSINESS, {
      providerMessageId: 'PM-1',
      internetMessageId: '<q-1@client.example>',
      threadId: 'TH-1',
    });
    const raised = await raiseMailReply(
      { mail, triage: QUESTION_TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
    await presentMailCard(
      raised.approvalId,
      async (text, jobId) => {
        const sent = await messenger.send({ text, jobId });
        if (!sent.ok) throw new Error(sent.error ?? 'send failed');
      },
      { businessId: BUSINESS },
    );
    return raised.approvalId;
  }

  it('sends the question as the ack of a side-effecting instruction, never the generic one', async () => {
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי ל-dana@example.com את ההצעה' }));
    const result = await pass(plannedWith(mailPlan()));

    expect(result.instructed).toBe(1);
    expect(lastSent()).toContain('dana@example.com');
    expect(lastSent()).toContain('לאישור');
    expect(lastSent()).not.toContain('קיבלתי, אני מטפלת בזה.');
  });

  it('a typed "כן" after the question moves the job to execute and says so', async () => {
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי ל-dana@example.com את ההצעה' }));
    await pass(plannedWith(mailPlan()));
    const jobs = await openJobs(BUSINESS);
    const jobId = jobs[0]?.jobId ?? '';
    expect(await phase(jobId)).toBe('plan');

    const yes = reply('כן');
    gateway.enqueue(yes);
    const result = await pass();

    expect(result.confirmationReplies).toBe(1);
    expect(result.instructed).toBe(0);
    expect(await phase(jobId)).toBe('execute');
    expect(await confirmationState(jobId)).toBe('confirmed');
    expect(lastSent()).toBe(CONFIRM_EXECUTING);
    expect((await messageRow(yes.providerMessageId))?.state).toBe('handled');
  });

  it('stamps the question delivered only after the send succeeded', async () => {
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי ל-dana@example.com את ההצעה' }));
    await pass(plannedWith(mailPlan()));
    const jobId = (await openJobs(BUSINESS))[0]?.jobId ?? '';
    expect((await loadConfirmation(jobId, { businessId: BUSINESS }))?.deliveredAt).toBeInstanceOf(Date);
  });

  it('a question whose send failed is never confirmed by a later "כן" on WhatsApp — the dashboard still lists it', async () => {
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי ל-dana@example.com את ההצעה' }));
    gateway.failNextSend();
    await pass(plannedWith(mailPlan()));
    const jobId = (await openJobs(BUSINESS))[0]?.jobId ?? '';
    expect(await phase(jobId)).toBe('plan');
    expect((await loadConfirmation(jobId, { businessId: BUSINESS }))?.deliveredAt).toBeNull();

    gateway.enqueue(reply('כן'));
    const result = await pass(async () => ({ status: 'planned', plan: recallPlan() }));

    expect(result.confirmationReplies).toBe(0);
    expect(await confirmationState(jobId)).toBe('pending');
    expect(await phase(jobId)).toBe('plan');
    expect((await dashboardConfirmations({ businessId: BUSINESS })).map((c) => c.jobId)).toEqual([jobId]);
  });

  it('a question too long for one WhatsApp message is not sent: a pointer to the dashboard instead, and it stays undelivered', async () => {
    const long = 'א'.repeat(2_500);
    const step = mailPlan().steps[0] as Plan['steps'][number];
    const plan = mailPlan({
      steps: [
        { ...step, id: 's1', input: { to: 'dana@example.com', subject: 'נושא', body: long } },
        { ...step, id: 's2', input: { to: 'dana@example.com', subject: 'נושא 2', body: long } },
      ],
    });
    gateway.enqueue(textMsg({ senderNumber: PRINCIPAL_NUMBER, body: 'תשלחי ל-dana@example.com את ההצעה' }));
    await pass(plannedWith(plan));

    const jobId = (await openJobs(BUSINESS))[0]?.jobId ?? '';
    const stored = await loadConfirmation(jobId, { businessId: BUSINESS });
    expect(stored?.presentedText.length).toBeGreaterThan(WHATSAPP_MESSAGE_MAX_CHARS);
    expect(stored?.deliveredAt).toBeNull();
    expect(lastSent()).toContain(WHATSAPP_QUESTION_TOO_LONG);
    expect(lastSent()).not.toContain(long);
    expect(lastSent().length).toBeLessThanOrEqual(WHATSAPP_MESSAGE_MAX_CHARS);

    gateway.enqueue(reply('כן'));
    await pass(async () => ({ status: 'planned', plan: recallPlan() }));
    expect(await confirmationState(jobId)).toBe('pending');
    expect((await dashboardConfirmations({ businessId: BUSINESS })).map((c) => c.jobId)).toEqual([jobId]);
  });

  it('a typed "כן" dated BEFORE the question was presented never confirms it', async () => {
    const jobId = await held([SINGLE]);
    gateway.enqueue(reply('כן', -5_000));
    await pass(async () => ({ status: 'planned', plan: recallPlan() }));

    expect(await confirmationState(jobId)).toBe('pending');
    expect(await phase(jobId)).toBe('plan');
  });

  it('links the confirm reply to the job it answered', async () => {
    const jobId = await held([SINGLE]);
    gateway.enqueue(reply('כן'));
    await pass();

    const { rows } = await getPool().query<{ job_id: string | null }>(
      `SELECT job_id FROM whatsapp_messages
        WHERE business_id = $1 AND direction = 'outbound' AND body = $2`,
      [BUSINESS, CONFIRM_EXECUTING],
    );
    expect(rows.map((r) => r.job_id)).toEqual([jobId]);
  });

  it('a voice "כן" never confirms: it goes to the door as an instruction and the question stays pending', async () => {
    const jobId = await held([SINGLE]);
    gateway.enqueue({ ...audioMsg({ senderNumber: PRINCIPAL_NUMBER }), providerTimestamp: new Date(Date.now() + 1_000).toISOString() });

    let planned = 0;
    await runWhatsAppDoor({
      gateway,
      messenger,
      businessId: BUSINESS,
      provider: async () => ({ text: 'כן' }),
      planner: async () => {
        planned += 1;
        return { status: 'planned', plan: recallPlan() };
      },
    });

    expect(planned).toBe(1);
    expect(await phase(jobId)).toBe('plan');
    expect(await confirmationState(jobId)).toBe('pending');
  });

  it('a caption "כן" on an image never confirms', async () => {
    const jobId = await held([SINGLE]);
    gateway.enqueue({ ...reply('כן'), mediaKind: 'image' });
    await pass(async () => ({ status: 'planned', plan: recallPlan() }));

    expect(await phase(jobId)).toBe('plan');
    expect(await confirmationState(jobId)).toBe('pending');
  });

  it('a typed "לא" cancels: the job is closed', async () => {
    const jobId = await held([SINGLE]);
    gateway.enqueue(reply('לא'));
    const result = await pass();

    expect(result.confirmationReplies).toBe(1);
    expect(await phase(jobId)).toBe('closed');
    expect(lastSent()).toBe(CONFIRM_CANCELLED);
  });

  it('picks by number when there are several options, and "כן" alone is unclear', async () => {
    const jobId = await held([OPTION_A, OPTION_B]);
    gateway.enqueue(reply('כן'));
    const unclear = await pass();
    expect(unclear.refused).toBe(1);
    expect(lastSent()).toBe(CONFIRM_UNCLEAR);
    expect(await confirmationState(jobId)).toBe('pending');

    gateway.enqueue(reply('2', 2_000));
    await pass();
    expect(await phase(jobId)).toBe('execute');
    const stored = await loadConfirmation(jobId, { businessId: BUSINESS });
    expect(stored?.chosenPlanHash).toBe(OPTION_B.planHash);
  });

  it('a second "כן" for an already-decided question changes nothing', async () => {
    const jobId = await held([SINGLE]);
    gateway.enqueue(reply('כן'));
    await pass();
    expect(await phase(jobId)).toBe('execute');

    // Decided, so no longer open: the second "כן" is not read as an answer
    // to it at all, and nothing moves the job a second time.
    gateway.enqueue(reply('כן', 2_000));
    await pass(async () => ({ status: 'planned', plan: recallPlan() }));
    const { rows } = await getPool().query(
      "SELECT 1 FROM job_steps WHERE job_id = $1 AND to_phase = 'execute'",
      [jobId],
    );
    expect(rows).toHaveLength(1);
  });

  it('tells the owner to retry on the dashboard, and reports it, when applying throws', async () => {
    // A single option with nothing bound: the confirm flips, then the bound
    // hash cannot match and `applyConfirmation` throws.
    const jobId = await held([SINGLE], false);
    gateway.enqueue(reply('כן'));
    const result = await pass();

    expect(lastSent()).toBe(CONFIRM_FAILED);
    expect(result.confirmErrored).toHaveLength(1);
    expect(result.confirmErrored[0]?.jobId).toBe(jobId);
    expect(await phase(jobId)).toBe('plan');
  });

  it('"שלח" with only a confirmation open is not consumed by the confirm reader', async () => {
    const jobId = await held([SINGLE]);
    gateway.enqueue(reply('שלח'));
    let planned = 0;
    await pass(async () => {
      planned += 1;
      return { status: 'planned', plan: recallPlan() };
    });

    expect(planned).toBe(1);
    expect(await confirmationState(jobId)).toBe('pending');
    expect(await phase(jobId)).toBe('plan');
  });

  it('"שלח" with a confirmation and a mail card open reaches the mail card', async () => {
    const jobId = await held([SINGLE]);
    const approvalId = await raiseMailCard();
    gateway.enqueue(reply('שלח'));
    const result = await pass();

    expect(result.mailCardReplies).toBe(1);
    expect((await getApproval(approvalId, { businessId: BUSINESS }))?.state).toBe('approved');
    expect(await confirmationState(jobId)).toBe('pending');
  });

  for (const word of ['כן', 'לא', 'סגרנו']) {
    it(`refuses "${word}" with a confirmation AND a mail card open, and changes nothing`, async () => {
      const jobId = await held([SINGLE]);
      const approvalId = await raiseMailCard();
      const msg = reply(word);
      gateway.enqueue(msg);
      const result = await pass();

      expect(result.refused).toBe(1);
      expect(lastSent()).toBe(SEVERAL_OPEN_REFUSAL);
      expect(await phase(jobId)).toBe('plan');
      expect(await confirmationState(jobId)).toBe('pending');
      expect((await getApproval(approvalId, { businessId: BUSINESS }))?.state).toBe('pending');
      expect((await messageRow(msg.providerMessageId))?.state).toBe('failed');
    });
  }

  for (const word of ['כן', 'לא', 'סגרנו']) {
    it(`refuses "${word}" with a confirmation AND a clarifying question open`, async () => {
      const jobId = await held([SINGLE]);
      // A clarifying question raised on WhatsApp: the instruction is not an
      // answer to the confirmation, so it passes through and parks.
      gateway.enqueue(reply('תשלחי לרונית', 500));
      await pass(plannedWith(mailPlan({ clarifyingQuestion: 'לאיזו רונית?' })));
      const questionJobs = (await openJobs(BUSINESS)).filter((j) => j.jobId !== jobId);
      expect(questionJobs).toHaveLength(1);
      const questionJob = questionJobs[0]?.jobId ?? '';
      expect(await phase(questionJob)).toBe('understand');

      gateway.enqueue(reply(word, 2_000));
      const result = await pass();

      expect(result.refused).toBe(1);
      expect(lastSent()).toBe(SEVERAL_OPEN_REFUSAL);
      expect(await phase(jobId)).toBe('plan');
      expect(await confirmationState(jobId)).toBe('pending');
      expect(await phase(questionJob)).toBe('understand');
    });
  }

  it('refuses "כן" with two confirmations open', async () => {
    const first = await held([SINGLE]);
    const second = await held([OPTION_B]);
    gateway.enqueue(reply('כן'));
    await pass();

    expect(lastSent()).toBe(SEVERAL_OPEN_REFUSAL);
    expect(await confirmationState(first)).toBe('pending');
    expect(await confirmationState(second)).toBe('pending');
  });
});
