/**
 * The routing decision itself, against a real record.
 *
 * The open questions these tests route against are created through the DOOR,
 * not by inserting rows: the thing being derived is "a question this channel
 * asked and is still waiting on", and that is three facts in two tables
 * (`boss_instructions.answer IS NULL`, `jobs.phase = 'understand'`,
 * `jobs.whatsapp_message_id IS NOT NULL`). A hand-built row could satisfy
 * the predicate while the door's real output did not, which is the shape of
 * test that proves the predicate and nothing else.
 *
 * `now` and `windowMinutes` are injected here rather than waited out. The
 * door-level test that the PRODUCTION default really routes an answer — the
 * positive control over `Date.parse` on a `created_at::text` value — lives in
 * `whatsapp-door.test.ts`, which passes neither.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, getPool } from '../db/pool.js';
import type { Plan } from '../domain/plan.js';
import { pendingQuestions, type InstructionRecord } from '../governance/instructions.js';
import type { PlanOutcome } from '../sdk/planner.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import { createFakeMessenger } from '../whatsapp/fake-messenger.js';
import type { NormalizedInboundMessage } from '../whatsapp/gateway.js';
import { runInstruction } from './instruct.js';
import { runWhatsAppDoor } from './whatsapp-door.js';
import { reportWhatsAppJobs } from './whatsapp-report.js';
import { transition } from './jobs.js';
import {
  ambiguousQuestion,
  claimAsAnswer,
  closureConfirmation,
  decideWhatsAppRoute,
  instructionSnippet,
  retireOpenInstruction,
  routedAsAnswer,
  staleOpenNotice,
  REASON_CLOSED_BY_OWNER,
} from './whatsapp-routing.js';

const BUSINESS = 'test-business';
const PRINCIPAL_NUMBER = '+972500000000';

let nextId = 0;
function textMsg(body: string): NormalizedInboundMessage {
  nextId += 1;
  return {
    providerMessageId: `wamid.routing-${nextId}`,
    senderNumber: PRINCIPAL_NUMBER,
    body,
    mediaKind: null,
    providerTimestamp: new Date().toISOString(),
  };
}

function askingPlan(question: string): Plan {
  return {
    goal: 'לשאול',
    assumptions: [],
    clarifyingQuestion: question,
    estimatedCostMinor: 0,
    steps: [],
  };
}

const asks = (question: string) => async (): Promise<PlanOutcome> => ({
  status: 'planned',
  plan: askingPlan(question),
});

/**
 * Opens one parked question on the WhatsApp channel, the way production does.
 *
 * `questionWindowMinutes: 0` on the door, not on the decision under test:
 * with the window ON, a second message sent while a question is open is
 * ROUTED TO IT rather than opening a second question — which is the rule
 * working, and which means this helper could never accumulate two open
 * questions otherwise. Switching the door's own window off while the fixture
 * is built is what lets each message open its own question; every assertion
 * below then passes its own window to `decideWhatsAppRoute` explicitly.
 */
async function askOverWhatsApp(body: string, question = 'למי בדיוק?'): Promise<void> {
  const gateway = createFakeGateway();
  gateway.enqueue(textMsg(body));
  await runWhatsAppDoor({
    gateway,
    messenger: createFakeMessenger(),
    businessId: BUSINESS,
    planner: asks(question),
    questionWindowMinutes: 0,
  });
}

async function openQuestions(): Promise<InstructionRecord[]> {
  return pendingQuestions({ businessId: BUSINESS, channel: 'whatsapp' });
}

describe('decideWhatsAppRoute', () => {
  beforeEach(async () => {
    await resetDatabase();
    await installCharter(buildCharter(), { businessId: BUSINESS });
  });

  afterAll(async () => {
    await closePool();
  });

  it('routes a message as a new instruction when nothing is open', async () => {
    const route = await decideWhatsAppRoute({ text: 'תשלחי לדנה', businessId: BUSINESS });
    expect(route).toEqual({ kind: 'new', staleOpen: 0 });
  });

  it('routes a message as the answer to the one open question inside the window', async () => {
    await askOverWhatsApp('תשלחי לרונית');
    const route = await decideWhatsAppRoute({
      text: 'רונית כהן',
      businessId: BUSINESS,
      windowMinutes: 30,
    });
    expect(route.kind).toBe('answer');
    if (route.kind !== 'answer') throw new Error('unreachable');
    expect(route.instruction.text).toBe('תשלחי לרונית');
  });

  /**
   * The other half of the window, and the half that makes it a window rather
   * than a flag. Same record, same text, same call — only the elapsed time
   * differs.
   */
  it('routes a message as a new instruction once the open question is older than the window', async () => {
    await askOverWhatsApp('תשלחי לרונית');
    const route = await decideWhatsAppRoute({
      text: 'רונית כהן',
      businessId: BUSINESS,
      windowMinutes: 30,
      now: Date.now() + 31 * 60_000,
    });
    // Not merely "not an answer": the question is still open and the owner
    // is told so, which is the whole point of carrying the count.
    expect(route).toEqual({ kind: 'new', staleOpen: 1 });
  });

  /**
   * **The boundary itself — fix round 1's Minor.** Every other window test
   * sits comfortably inside or outside it (now, or 31 minutes on a 30-minute
   * window), so `<` in place of `<=`, or an off-by-one in the minutes-to-
   * milliseconds arithmetic, would have gone unnoticed in both directions.
   *
   * `now` is computed from the row's OWN stored `created_at`, not from
   * `Date.now()`: the elapsed time has to be exactly the window and exactly
   * one millisecond past it, and anything derived from the test's clock would
   * be off by however long the fixture took to run.
   */
  it('answers at exactly the window and refuses one millisecond past it', async () => {
    await askOverWhatsApp('תשלחי לרונית');
    const open = (await openQuestions())[0];
    if (open === undefined) throw new Error('unreachable');

    const askedMs = Date.parse(open.createdAt);
    // Paired positive check, and the one that matters most in this file: the
    // stored timestamp is readable at all. An unreadable one makes
    // `withinQuestionWindow` return `false` for everything, which would make
    // the "past the window" half below pass for entirely the wrong reason.
    expect(Number.isNaN(askedMs)).toBe(false);
    const windowMinutes = 30;
    const windowMs = windowMinutes * 60_000;

    const atBoundary = await decideWhatsAppRoute({
      text: 'רונית כהן',
      businessId: BUSINESS,
      windowMinutes,
      now: askedMs + windowMs,
    });
    expect(atBoundary.kind).toBe('answer');

    const oneMsPast = await decideWhatsAppRoute({
      text: 'רונית כהן',
      businessId: BUSINESS,
      windowMinutes,
      now: askedMs + windowMs + 1,
    });
    expect(oneMsPast).toEqual({ kind: 'new', staleOpen: 1 });
  });

  /**
   * `0` is a legal setting and means "no message is ever read as an answer".
   * Without the explicit `windowMinutes <= 0` clause a row created in the
   * same millisecond would satisfy `0 <= 0` and be answered under a
   * switched-off window.
   */
  it('reads nothing as an answer when the window is zero', async () => {
    await askOverWhatsApp('תשלחי לרונית');
    const route = await decideWhatsAppRoute({
      text: 'רונית כהן',
      businessId: BUSINESS,
      windowMinutes: 0,
    });
    expect(route).toEqual({ kind: 'new', staleOpen: 1 });
  });

  /**
   * Deciding which question an answer belongs to is the same class of error
   * as deciding which רונית the owner meant, and this repo refuses that one
   * too. A value that could not be read is never a permissive value.
   *
   * **How two answerable questions actually arise, since the routing itself
   * normally prevents it.** With the window on, a message sent while a
   * question is answerable becomes its answer, so a second question never
   * opens beside it. Two answerable at once needs the window to WIDEN over
   * questions that accumulated outside it — raising
   * `WHATSAPP_QUESTION_WINDOW_MINUTES` on a running installation, or
   * running with it at `0` for a while and then turning it on, which is what
   * the fixture reproduces. That makes this branch defensive rather than
   * routine today; it is still the branch that decides what happens the day
   * the setting changes, and the honest answer there is to ask rather than
   * to pick one.
   */
  it('refuses to guess which of two open questions a message answers', async () => {
    await askOverWhatsApp('תשלחי לרונית', 'למי בדיוק?');
    await askOverWhatsApp('תזמיני ספקים', 'איזה ספק?');
    const route = await decideWhatsAppRoute({
      text: 'רונית כהן',
      businessId: BUSINESS,
      windowMinutes: 30,
    });
    expect(route.kind).toBe('ambiguous');
    if (route.kind !== 'ambiguous') throw new Error('unreachable');
    expect(route.open).toHaveLength(2);
  });

  /**
   * The window governs what counts as an ANSWER, never what the owner may
   * close. A question that aged out is still open — his own rule — so a
   * closure word has to be able to reach it, or an aged-out question would be
   * unclosable from the only surface he is using.
   */
  it('reads a closure word as closure even when every open question has aged past the window', async () => {
    await askOverWhatsApp('תשלחי לרונית');
    const route = await decideWhatsAppRoute({
      text: 'סגרנו',
      businessId: BUSINESS,
      windowMinutes: 30,
      now: Date.now() + 99 * 60_000,
    });
    expect(route.kind).toBe('closure');
    if (route.kind !== 'closure') throw new Error('unreachable');
    expect(route.open).toHaveLength(1);
  });

  it('reads a closure word as closure when nothing at all is open', async () => {
    const route = await decideWhatsAppRoute({ text: 'סגרנו', businessId: BUSINESS });
    expect(route).toEqual({ kind: 'closure', open: [] });
  });

  /**
   * A question raised on the DASHBOARD was never put to the owner over
   * WhatsApp. Reading his next WhatsApp message as its answer would swallow a
   * message he had no reason to think was being asked for — which is the
   * defect this task fixes, inverted.
   *
   * The paired positive assertion is what makes this test mean something: the
   * same parked question IS visible to the unnarrowed `pendingQuestions` the
   * dashboard runs, so the narrowing is what excluded it, not a job that
   * failed to park.
   */
  it('ignores a parked question that was never asked over WhatsApp', async () => {
    const outcome = await runInstruction(
      { text: 'תשלחי לרונית' },
      { businessId: BUSINESS, textOrigin: 'typed', planner: asks('למי בדיוק?') },
    );
    expect(outcome.status).toBe('needs_answer');

    expect(await pendingQuestions({ businessId: BUSINESS })).toHaveLength(1);
    expect(await openQuestions()).toHaveLength(0);

    const route = await decideWhatsAppRoute({
      text: 'רונית כהן',
      businessId: BUSINESS,
      windowMinutes: 30,
    });
    expect(route).toEqual({ kind: 'new', staleOpen: 0 });
  });
});

describe('claimAsAnswer', () => {
  beforeEach(async () => {
    await resetDatabase();
    await installCharter(buildCharter(), { businessId: BUSINESS });
  });

  /**
   * One winner, decided in SQL. Two routes reaching the same open question —
   * a dashboard answer racing a WhatsApp message — must not both re-run the
   * planner and both supersede the parked job; the second `transition` would
   * hit `LEGAL_TRANSITIONS`'s empty entry for an already-`failed` job and
   * throw.
   */
  it('lets exactly one caller take an open question', async () => {
    await askOverWhatsApp('תשלחי לרונית');
    const open = (await openQuestions())[0];
    if (open === undefined) throw new Error('unreachable');

    expect(await claimAsAnswer(open, 'רונית כהן', { businessId: BUSINESS })).toBe(true);
    expect(await claimAsAnswer(open, 'רונית לוי', { businessId: BUSINESS })).toBe(false);

    // The first answer stands; the loser overwrote nothing.
    const { rows } = await getPool().query<{ answer: string | null }>(
      'SELECT answer FROM boss_instructions WHERE instruction_id = $1',
      [open.instructionId],
    );
    expect(rows[0]?.answer).toBe('רונית כהן');
    // And the question is no longer open, so nothing routes to it again.
    expect(await openQuestions()).toHaveLength(0);
  });
});

describe('retireOpenInstruction', () => {
  beforeEach(async () => {
    await resetDatabase();
    await installCharter(buildCharter(), { businessId: BUSINESS });
  });

  /**
   * The claim on the opening message is what stops `reportWhatsAppJobs`
   * telling the owner that an instruction he answered, or closed himself,
   * "failed" — `classifyJob` reads a terminal job with no bound plan as
   * `{ outcome: 'failed' }`, and `reportCandidates` only looks at a message
   * whose state is still `handled`/`failed`/`reported_interim`.
   *
   * Asserted on both halves: the phase really moved (so this is not passing
   * because nothing happened), and the message reads `'reported'` (so no
   * report is owed).
   */
  it('marks the opening message reported and moves the parked job', async () => {
    await askOverWhatsApp('תשלחי לרונית');
    const open = (await openQuestions())[0];
    if (open === undefined) throw new Error('unreachable');

    await retireOpenInstruction(open, {
      to: 'closed',
      reason: REASON_CLOSED_BY_OWNER,
      businessId: BUSINESS,
    });

    const jobRow = await getPool().query<{ phase: string; whatsapp_message_id: string | null }>(
      'SELECT phase, whatsapp_message_id FROM jobs WHERE job_id = $1',
      [open.jobId],
    );
    expect(jobRow.rows[0]?.phase).toBe('closed');
    const messageId = jobRow.rows[0]?.whatsapp_message_id;
    expect(messageId).not.toBeNull();

    const msgRow = await getPool().query<{ state: string }>(
      'SELECT state FROM whatsapp_messages WHERE id = $1',
      [messageId],
    );
    expect(msgRow.rows[0]?.state).toBe('reported');
  });

  /**
   * The consequence the claim above exists to prevent, proven through the
   * real report pass rather than asserted in a comment.
   *
   * `classifyJob` reads a terminal job with no bound plan and no step rows
   * as `{ outcome: 'failed' }`, and `reportCandidates` picks up any
   * WhatsApp-opened job in a terminal phase whose opening message still
   * reads `handled`/`failed`/`reported_interim`. A superseded or
   * owner-closed instruction is exactly that shape — so without the claim
   * the owner is told over WhatsApp that the instruction he just answered,
   * or closed himself, "failed".
   *
   * Measured, not assumed: with `claimForReport` removed from
   * `retireOpenInstruction`, this test sends one report naming the retired
   * job.
   */
  it('leaves the report pass with nothing to say about a retired instruction', async () => {
    await askOverWhatsApp('תשלחי לרונית');
    const open = (await openQuestions())[0];
    if (open === undefined) throw new Error('unreachable');

    await retireOpenInstruction(open, {
      to: 'closed',
      reason: REASON_CLOSED_BY_OWNER,
      businessId: BUSINESS,
    });

    const messenger = createFakeMessenger();
    const report = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });

    expect(report.reported).toBe(0);
    expect(report.errored).toEqual([]);
    expect(messenger.sentTexts).toEqual([]);
  });

  /**
   * The paired positive control, and this test is what makes the one above
   * mean something: the report pass DOES speak for a terminal
   * WhatsApp-opened job whose opening message was never claimed. Without
   * this, the silence asserted above would be equally true of a report pass
   * that never reports anything at all — the vacuous shape this repo has
   * been bitten by three times.
   */
  it('still reports a terminal job whose opening message was never claimed', async () => {
    await askOverWhatsApp('תשלחי לרונית');
    const open = (await openQuestions())[0];
    if (open === undefined) throw new Error('unreachable');

    // The same phase move, without the claim.
    await transition(open.jobId, {
      to: 'closed',
      actor: 'human',
      reason: REASON_CLOSED_BY_OWNER,
      businessId: BUSINESS,
    });

    const messenger = createFakeMessenger();
    const report = await reportWhatsAppJobs({ messenger, businessId: BUSINESS });

    expect(report.reported).toBe(1);
    expect(messenger.sentTexts).toHaveLength(1);
  });
});

describe('what the owner reads', () => {
  const record = (text: string): InstructionRecord => ({
    instructionId: 'INS-1',
    businessId: BUSINESS,
    jobId: 'JOB-1',
    text,
    // Typed, because these are the sentences the owner reads about a request
    // he made — the origin rule's effect on them is nil, and stating it
    // keeps the fixture honest rather than letting a default decide.
    textOrigin: 'typed',
    question: 'למי?',
    answer: null,
    createdAt: new Date().toISOString(),
  });

  it('quotes the previous request when it joined one, so a wrong reading is visible', () => {
    expect(routedAsAnswer(record('תשלחי לרונית'))).toContain('תשלחי לרונית');
    expect(routedAsAnswer(record('תשלחי לרונית'))).toContain('לבקשה הקודמת');
  });

  it('names what was closed, never just that something was', () => {
    const text = closureConfirmation([record('תשלחי לרונית'), record('תזמיני ספקים')]);
    expect(text).toContain('תשלחי לרונית');
    expect(text).toContain('תזמיני ספקים');
  });

  /**
   * With two questions open, telling the owner only "answer it on the
   * dashboard" would leave every subsequent WhatsApp message meeting the
   * same refusal with nothing he could type to escape it. The closure word
   * is the exit from WhatsApp itself, and it is quoted from the verb list
   * rather than written out here.
   */
  it('names an exit the owner can take from WhatsApp itself', () => {
    const text = ambiguousQuestion([record('תשלחי לרונית'), record('תזמיני ספקים')]);
    expect(text).toContain('סגרנו');
    expect(text).toContain('דשבורד');
  });

  it('counts stale open questions in the owner\'s own grammar', () => {
    expect(staleOpenNotice(1)).toContain('שאלה אחת פתוחה');
    expect(staleOpenNotice(3)).toContain('3 שאלות פתוחות');
  });

  /**
   * An instruction that arrived as a voice note is a transcription
   * provider's output, and a directionality override in the quoted snippet
   * would make the request being closed read as a different request. Same
   * reason the signing card strips them from a document's `original_name`.
   */
  it('strips directionality controls from a quoted snippet, keeping the text', () => {
    const snippet = instructionSnippet('תשלחי‮לרונית');
    expect(snippet).not.toContain('‮');
    expect(snippet).toContain('תשלחי');
    expect(snippet).toContain('לרונית');
  });

  it('shortens a long request rather than quoting all of it', () => {
    const long = 'א'.repeat(300);
    const snippet = instructionSnippet(long);
    expect(snippet.length).toBeLessThan(long.length);
    expect(snippet).toContain('…');
  });
});
