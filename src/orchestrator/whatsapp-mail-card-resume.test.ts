/**
 * Fix round 1, minor 6: `decide` has committed and the owner's "שלח" is
 * recorded, but moving the job on (`resumeAfterDecision`) throws. The owner
 * must still be told what happened and the message must still be settled —
 * not left with the generic "something went wrong" that invites him to send
 * "שלח" again at a card that is already decided.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./resume.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resume.js')>();
  return {
    ...actual,
    resumeAfterDecision: async () => {
      throw new Error('test: resume failed');
    },
  };
});

import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { QUESTION_TRIAGE, installMailboxCharter, storedMail, stubDrafter } from '../test/mailbox.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import { createBossMessenger } from '../whatsapp/messenger.js';
import { raiseMailReply } from './mail-reply.js';
import { runWhatsAppDoor } from './whatsapp-door.js';
import { DECIDED_RESUME_FAILED, presentMailCard } from './whatsapp-mail-card.js';

const BUSINESS = 'test-business';
const PRINCIPAL = '+972500000000';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('approve-by-WhatsApp when the resume fails', () => {
  it('still acknowledges the decision and settles the message', async () => {
    const bundle = await installMailboxCharter(BUSINESS);
    const gateway = createFakeGateway();
    const messenger = createBossMessenger({ gateway, contactId: PRINCIPAL, businessId: BUSINESS });
    const mail = await storedMail(BUSINESS);
    const raised = await raiseMailReply(
      { mail, triage: QUESTION_TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a card');
    await presentMailCard(
      raised.approvalId,
      async (text, jobId) => void (await messenger.send({ text, jobId })),
      { businessId: BUSINESS },
    );

    gateway.enqueue({
      providerMessageId: 'wamid.resume-1',
      senderNumber: PRINCIPAL,
      body: 'שלח',
      mediaKind: null,
      providerTimestamp: new Date(Date.now() + 1_000).toISOString(),
    });
    const result = await runWhatsAppDoor({ gateway, messenger, businessId: BUSINESS });

    expect(result.mailCardReplies).toBe(1);
    expect(gateway.sent.at(-1)?.body).toBe(DECIDED_RESUME_FAILED);
    const { rows } = await getPool().query<{ state: string }>(
      "SELECT state FROM approval_requests WHERE business_id = $1 AND job_id = $2",
      [BUSINESS, raised.replyJobId],
    );
    expect(rows.map((r) => r.state)).toEqual(['approved']);
    const { rows: inbound } = await getPool().query<{ state: string }>(
      "SELECT state FROM whatsapp_messages WHERE business_id = $1 AND provider_message_id = 'wamid.resume-1'",
      [BUSINESS],
    );
    expect(inbound[0]?.state).toBe('handled');
  });
});
