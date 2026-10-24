/**
 * Approve-by-WhatsApp for a mailbox reply card (mailbox spec §5.2 item 7).
 *
 * Every test runs the real door (`runWhatsAppDoor`) against the fake gateway
 * and a REAL `createBossMessenger` over it: the window is derived from the
 * outbound rows the real messenger writes, so a fake messenger that records
 * nothing would make every card look unpresented and every test pass for the
 * wrong reason.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  NOON,
  QUESTION_TRIAGE,
  fakeMailboxClient,
  installMailboxCharter,
  mailboxRuntime,
  storedMail,
  stubDrafter,
} from '../test/mailbox.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { PlanOutcome, PlanRequest } from '../sdk/planner.js';
import type { NormalizedInboundMessage } from '../whatsapp/gateway.js';
import { createFakeGateway, type FakeGateway } from '../whatsapp/fake-gateway.js';
import { createBossMessenger, type BossMessenger } from '../whatsapp/messenger.js';
import { getApproval } from '../governance/approvals.js';
import { MAIL_CARD_INSTRUCTION } from '../mail/whatsapp-notice.js';
import { loadJob } from './jobs.js';
import { raiseMailReply, type RaisedReply } from './mail-reply.js';
import { runDueJobs } from './run-due.js';
import { runWhatsAppDoor } from './whatsapp-door.js';
import {
  EMPTY_REPLACEMENT,
  MAIL_CARD_CLOSED,
  MULTIPLE_MAIL_CARDS_REFUSAL,
  presentMailCard,
} from './whatsapp-mail-card.js';

const BUSINESS = 'test-business';
const PRINCIPAL = '+972500000000';
const STRANGER = '+972549999999';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

let nextId = 0;
function textMsg(senderNumber: string, body: string, providerTimestamp?: string): NormalizedInboundMessage {
  nextId += 1;
  return {
    providerMessageId: `wamid.mail-card-${nextId}`,
    senderNumber,
    body,
    mediaKind: null,
    // The owner answers a moment after the card arrives — never in the same
    // instant (`openMailCards` requires strictly after the presentation).
    providerTimestamp: providerTimestamp ?? new Date(Date.now() + 1_000).toISOString(),
  };
}

function audioMsg(senderNumber: string): NormalizedInboundMessage {
  nextId += 1;
  return {
    providerMessageId: `wamid.mail-card-${nextId}`,
    senderNumber,
    body: null,
    mediaKind: 'audio',
    providerTimestamp: new Date().toISOString(),
    downloadAudio: async () => ({ bytes: Buffer.from('x'), mimeType: 'audio/ogg', seconds: 3 }),
  };
}

/** A planner that records it was reached and declines, so nothing is planned. */
function plannerReached(onCall: () => unknown) {
  return async (_request: PlanRequest): Promise<PlanOutcome> => {
    onCall();
    return { status: 'unparseable', raw: '', reason: 'test' };
  };
}

const neverPlanned = async (_request: PlanRequest): Promise<PlanOutcome> => {
  throw new Error('planner must not be called for a mail-card reply');
};

interface Harness {
  bundle: PolicyBundle;
  gateway: FakeGateway;
  messenger: BossMessenger;
}

async function harness(): Promise<Harness> {
  const bundle = await installMailboxCharter(BUSINESS);
  const gateway = createFakeGateway();
  const messenger = createBossMessenger({ gateway, contactId: PRINCIPAL, businessId: BUSINESS });
  return { bundle, gateway, messenger };
}

async function raiseAndPresent(h: Harness, n = 1): Promise<RaisedReply> {
  const mail = await storedMail(BUSINESS, {
    providerMessageId: `PM-${n}`,
    internetMessageId: `<q-${n}@client.example>`,
    threadId: `TH-${n}`,
  });
  const raised = await raiseMailReply(
    { mail, triage: QUESTION_TRIAGE, bundle: h.bundle, drafter: stubDrafter() },
    { businessId: BUSINESS },
  );
  if (raised === null) throw new Error('expected a card');
  await presentMailCard(
    raised.approvalId,
    async (text, jobId) => {
      const sent = await h.messenger.send({ text, jobId });
      if (!sent.ok) throw new Error(sent.error ?? 'send failed');
    },
    { businessId: BUSINESS },
  );
  return raised;
}

function door(h: Harness, planner: (r: PlanRequest) => Promise<PlanOutcome> = neverPlanned) {
  return runWhatsAppDoor({ gateway: h.gateway, messenger: h.messenger, businessId: BUSINESS, planner });
}

async function approvalsFor(jobId: string) {
  const { rows } = await getPool().query<{
    approval_id: string;
    state: string;
    decided_channel: string | null;
    proposed_input: Record<string, unknown>;
    edited_input: Record<string, unknown> | null;
  }>(
    `SELECT approval_id, state, decided_channel, proposed_input, edited_input
       FROM approval_requests WHERE business_id = $1 AND job_id = $2 ORDER BY created_at`,
    [BUSINESS, jobId],
  );
  return rows;
}

function lastSent(h: Harness): string {
  return h.gateway.sent.at(-1)?.body ?? '';
}

describe('presentMailCard', () => {
  it('sends the card with the full body and the instruction line, recorded against the reply job', async () => {
    const h = await harness();
    const raised = await raiseAndPresent(h);
    expect(h.gateway.sent).toHaveLength(1);
    expect(lastSent(h)).toContain('dana@client.example');
    expect(lastSent(h).endsWith(MAIL_CARD_INSTRUCTION)).toBe(true);
    const { rows } = await getPool().query(
      "SELECT 1 FROM whatsapp_messages WHERE business_id = $1 AND direction = 'outbound' AND job_id = $2",
      [BUSINESS, raised.replyJobId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('approve-by-WhatsApp', () => {
  it('"שלח" within the window approves and the reply job reaches execute', async () => {
    const h = await harness();
    const raised = await raiseAndPresent(h);

    h.gateway.enqueue(textMsg(PRINCIPAL, '‏ שלח ‎'));
    const result = await door(h);

    expect(result.mailCardReplies).toBe(1);
    expect(result.instructed).toBe(0);
    const [only] = await approvalsFor(raised.replyJobId);
    expect(only?.state).toBe('approved');
    expect(only?.decided_channel).toBe('whatsapp');
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('execute');
  });

  it('"שלחי" approves too', async () => {
    const h = await harness();
    const raised = await raiseAndPresent(h);
    h.gateway.enqueue(textMsg(PRINCIPAL, 'שלחי'));
    await door(h);
    expect((await approvalsFor(raised.replyJobId))[0]?.state).toBe('approved');
  });

  it('replacement text creates a new pending approval with the edited body and does not send', async () => {
    const h = await harness();
    const raised = await raiseAndPresent(h);
    const original = await getApproval(raised.approvalId, { businessId: BUSINESS });

    h.gateway.enqueue(textMsg(PRINCIPAL, '‏נוסח: שלום דנה, ההצעה תגיע ביום ראשון.'));
    const result = await door(h);
    expect(result.mailCardReplies).toBe(1);

    const rows = await approvalsFor(raised.replyJobId);
    expect(rows.map((r) => r.state)).toEqual(['cancelled', 'pending']);
    const fresh = rows[1];
    // The proposal is unchanged — it is what the bound plan step carries, so
    // the approval is found by it — and the owner's text rides as the edit.
    expect(fresh?.proposed_input).toEqual(original?.proposedInput);
    expect(fresh?.edited_input).toEqual({
      ...(original?.proposedInput as Record<string, unknown>),
      body: 'שלום דנה, ההצעה תגיע ביום ראשון.',
    });
    expect(fresh?.decided_channel).toBeNull();

    // Re-presented, with the new body, and asking for a second "שלח".
    expect(lastSent(h)).toContain('שלום דנה, ההצעה תגיע ביום ראשון.');
    expect(lastSent(h).endsWith(MAIL_CARD_INSTRUCTION)).toBe(true);

    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('await_approval');
    const mailbox = fakeMailboxClient();
    await runDueJobs({ businessId: BUSINESS, runtime: mailboxRuntime(mailbox.client), now: NOON });
    expect(mailbox.sent).toHaveLength(0);
  });

  it('a second "שלח" after a replacement sends exactly the replacement body', async () => {
    const h = await harness();
    const raised = await raiseAndPresent(h);

    h.gateway.enqueue(textMsg(PRINCIPAL, 'נוסח : נוסח חדש לגמרי'));
    await door(h);
    h.gateway.enqueue(textMsg(PRINCIPAL, 'שלח'));
    await door(h);

    const rows = await approvalsFor(raised.replyJobId);
    expect(rows.map((r) => r.state)).toEqual(['cancelled', 'approved_with_edit']);

    const mailbox = fakeMailboxClient();
    await runDueJobs({ businessId: BUSINESS, runtime: mailboxRuntime(mailbox.client), now: NOON });
    expect(mailbox.sent).toHaveLength(1);
    expect(mailbox.sent[0]?.body).toBe('נוסח חדש לגמרי');
    expect(mailbox.sent[0]?.to).toEqual(['dana@client.example']);
  });

  it('"שלח" with two open mail cards decides nothing', async () => {
    const h = await harness();
    const first = await raiseAndPresent(h, 1);
    const second = await raiseAndPresent(h, 2);

    h.gateway.enqueue(textMsg(PRINCIPAL, 'שלח'));
    const result = await door(h);

    expect(result.mailCardReplies).toBe(0);
    expect(lastSent(h)).toBe(MULTIPLE_MAIL_CARDS_REFUSAL);
    expect(MULTIPLE_MAIL_CARDS_REFUSAL).toBe('יש כמה טיוטות פתוחות — אשרי בדשבורד.');
    expect((await approvalsFor(first.replyJobId)).map((r) => r.state)).toEqual(['pending']);
    expect((await approvalsFor(second.replyJobId)).map((r) => r.state)).toEqual(['pending']);
  });

  it('"שלח" from a non-principal sender does nothing', async () => {
    const h = await harness();
    const raised = await raiseAndPresent(h);
    const before = h.gateway.sent.length;

    h.gateway.enqueue(textMsg(STRANGER, 'שלח'));
    const result = await door(h);

    expect(result.recordedOnly).toBe(1);
    expect(result.mailCardReplies).toBe(0);
    expect(h.gateway.sent).toHaveLength(before);
    expect((await approvalsFor(raised.replyJobId)).map((r) => r.state)).toEqual(['pending']);
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('await_approval');
  });

  it('a voice note inside the window goes to the ordinary door and never approves', async () => {
    const h = await harness();
    const raised = await raiseAndPresent(h);
    let planned = 0;

    h.gateway.enqueue(audioMsg(PRINCIPAL));
    const result = await runWhatsAppDoor({
      gateway: h.gateway,
      messenger: h.messenger,
      businessId: BUSINESS,
      planner: plannerReached(() => (planned += 1)),
      provider: async () => ({ text: 'שלח' }),
    });

    expect(planned).toBe(1);
    expect(result.mailCardReplies).toBe(0);
    expect((await approvalsFor(raised.replyJobId)).map((r) => r.state)).toEqual(['pending']);

    // The card is still open: a typed "שלח" right after approves it.
    h.gateway.enqueue(textMsg(PRINCIPAL, 'שלח'));
    await door(h);
    expect((await approvalsFor(raised.replyJobId)).map((r) => r.state)).toEqual(['approved']);
  });

  it('a plain instruction inside the window reaches the instruction door and the card stays open', async () => {
    const h = await harness();
    const raised = await raiseAndPresent(h);
    let planned = 0;

    h.gateway.enqueue(textMsg(PRINCIPAL, 'תזכירי לי מחר להתקשר לספק'));
    const result = await door(h, plannerReached(() => (planned += 1)));

    expect(planned).toBe(1);
    expect(result.mailCardReplies).toBe(0);
    expect((await approvalsFor(raised.replyJobId)).map((r) => r.state)).toEqual(['pending']);

    h.gateway.enqueue(textMsg(PRINCIPAL, 'שלח'));
    await door(h);
    expect((await approvalsFor(raised.replyJobId)).map((r) => r.state)).toEqual(['approved']);
  });

  it('"נוסח:" with nothing after it is refused and changes nothing', async () => {
    const h = await harness();
    const raised = await raiseAndPresent(h);

    for (const body of ['נוסח:', 'נוסח:   ‏‮ ']) {
      h.gateway.enqueue(textMsg(PRINCIPAL, body));
      const result = await door(h);
      expect(result.refused).toBe(1);
      expect(lastSent(h)).toBe(EMPTY_REPLACEMENT);
    }
    expect((await approvalsFor(raised.replyJobId)).map((r) => r.state)).toEqual(['pending']);
  });

  it('a "שלח" sent before a card was presented never approves that card', async () => {
    const h = await harness();
    const a = await raiseAndPresent(h, 1);
    const beforeB = new Date(Date.now() - 1_000).toISOString();
    // Card A is decided on the dashboard; card B is then presented.
    await getPool().query(
      "UPDATE approval_requests SET state = 'denied', decided_by = 'p', decided_at = now(), input_hash_at_decision = input_hash WHERE job_id = $1",
      [a.replyJobId],
    );
    const b = await raiseAndPresent(h, 2);

    // The owner's "שלח", typed for card A, is only delivered now.
    h.gateway.enqueue(textMsg(PRINCIPAL, 'שלח', beforeB));
    await door(h, plannerReached(() => undefined));

    expect((await approvalsFor(b.replyJobId)).map((r) => r.state)).toEqual(['pending']);
  });

  it('a closure word closes the window without deciding, and the next message is an instruction again', async () => {
    const h = await harness();
    const raised = await raiseAndPresent(h);

    h.gateway.enqueue(textMsg(PRINCIPAL, 'סגרנו'));
    const closed = await door(h);
    expect(closed.closed).toBe(1);
    expect(lastSent(h)).toBe(MAIL_CARD_CLOSED);
    expect(MAIL_CARD_CLOSED).toContain('טיוטת המייל');
    expect((await approvalsFor(raised.replyJobId)).map((r) => r.state)).toEqual(['pending']);

    let planned = 0;
    h.gateway.enqueue(textMsg(PRINCIPAL, 'שלח'));
    await door(h, async () => {
      planned += 1;
      return { status: 'unparseable', raw: '', reason: 'test' };
    });
    expect(planned).toBe(1);
    expect((await approvalsFor(raised.replyJobId)).map((r) => r.state)).toEqual(['pending']);
  });

  it('past the window the card is not consumed: "שלח" goes to the instruction door', async () => {
    const h = await harness();
    const raised = await raiseAndPresent(h);
    await getPool().query(
      "UPDATE whatsapp_messages SET created_at = now() - interval '31 minutes' WHERE business_id = $1 AND direction = 'outbound'",
      [BUSINESS],
    );

    let planned = 0;
    h.gateway.enqueue(textMsg(PRINCIPAL, 'שלח'));
    await door(h, async () => {
      planned += 1;
      return { status: 'unparseable', raw: '', reason: 'test' };
    });
    expect(planned).toBe(1);
    expect((await approvalsFor(raised.replyJobId)).map((r) => r.state)).toEqual(['pending']);
  });

  it('a card never presented on WhatsApp opens no window', async () => {
    const h = await harness();
    const mail = await storedMail(BUSINESS);
    const raised = await raiseMailReply(
      { mail, triage: QUESTION_TRIAGE, bundle: h.bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a card');

    let planned = 0;
    h.gateway.enqueue(textMsg(PRINCIPAL, 'שלח'));
    await door(h, async () => {
      planned += 1;
      return { status: 'unparseable', raw: '', reason: 'test' };
    });
    expect(planned).toBe(1);
    expect((await approvalsFor(raised.replyJobId)).map((r) => r.state)).toEqual(['pending']);
  });
});
