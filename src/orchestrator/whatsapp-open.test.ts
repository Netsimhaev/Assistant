/**
 * `openOnWhatsApp` counts contact cards (ruling R10b), and every reader's
 * collision rule includes them: with a contact card and a mail card both open,
 * "שלח" decides neither.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import {
  QUESTION_TRIAGE,
  installMailboxCharter,
  storedMail,
  stubDrafter,
} from '../test/mailbox.js';
import { raiseContactCard, presentContactCard, handleContactCardMessage } from '../whatsapp/contact-card.js';
import { openOrAppend } from '../whatsapp/contact-conversations.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import type { NormalizedInboundMessage } from '../whatsapp/gateway.js';
import { createBossMessenger } from '../whatsapp/messenger.js';
import { recordInbound } from '../whatsapp/store.js';
import { raiseMailReply } from './mail-reply.js';
import { openOnWhatsApp } from './whatsapp-open.js';
import { handleMailCardMessage, presentMailCard } from './whatsapp-mail-card.js';

const BUSINESS = 'test-business';
const PRINCIPAL = '+972500000000';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

async function setup() {
  const bundle = await installMailboxCharter(BUSINESS);
  const gateway = createFakeGateway();
  const messenger = createBossMessenger({ gateway, contactId: PRINCIPAL.slice(1), businessId: BUSINESS });
  const send = async (text: string, jobId: string | null) => (await messenger.send({ text, jobId })).ok;

  // A mail reply card...
  const mail = await storedMail(BUSINESS, {
    providerMessageId: 'PM-1',
    internetMessageId: '<q-1@client.example>',
    threadId: 'TH-1',
  });
  const raisedMail = await withBusiness(BUSINESS, (db) =>
    raiseMailReply(db, { mail, triage: QUESTION_TRIAGE, bundle, drafter: stubDrafter() }),
  );
  if (raisedMail?.approvalId == null) throw new Error('expected a mail card');
  await withBusiness(BUSINESS, (db) =>
    presentMailCard(db, raisedMail.approvalId!, async (text, jobId) => {
      await messenger.send({ text, jobId });
    }),
  );

  // ...and a contact card.
  const { conversation } = await withBusiness(BUSINESS, (db) =>
    openOrAppend(db, { key: '972501110001', subjectKey: null, kind: 'supplier', inboundAt: new Date() }),
  );
  const raisedContact = await withBusiness(BUSINESS, (db) =>
    raiseContactCard(db, {
      conversation,
      draft: { body: 'שלום, נחזור אליך.', attachDocumentId: null },
      reasonHe: 'מחיר',
      sourcesHe: [],
      bundle,
      contactLabel: 'ספק',
    }),
  );
  await withBusiness(BUSINESS, (db) => presentContactCard(db, raisedContact.approvalId, send));

  const providerTimestamp = new Date(Date.now() + 2_000).toISOString();
  const stored = await withBusiness(BUSINESS, (db) =>
    recordInbound(db, {
      providerMessageId: 'wamid.owner-open',
      senderNumber: PRINCIPAL,
      senderKind: 'principal',
      body: 'שלח',
      mediaKind: null,
      providerTimestamp,
    }),
  );
  if (stored === null) throw new Error('duplicate');
  const msg: NormalizedInboundMessage = {
    providerMessageId: 'wamid.owner-open',
    senderNumber: PRINCIPAL,
    body: 'שלח',
    mediaKind: null,
    providerTimestamp,
  };
  return { messenger, mailJobId: raisedMail.replyJobId, contact: raisedContact, stored, msg };
}

describe('openOnWhatsApp', () => {
  it('counts an open contact card, with the mail card beside it', async () => {
    const s = await setup();
    const open = await withBusiness(BUSINESS, (db) =>
      openOnWhatsApp(db, { excludeMessageId: s.stored.id, inboundAt: s.msg.providerTimestamp }),
    );
    expect(open.contactCards).toHaveLength(1);
    expect(open.contactCards[0]?.approval.approvalId).toBe(s.contact.approvalId);
    expect(open.mailCards).toHaveLength(1);
  });

  it('"שלח" with a contact card and a mail card open is refused by both readers, nothing decided', async () => {
    const s = await setup();
    const open = await withBusiness(BUSINESS, (db) =>
      openOnWhatsApp(db, { excludeMessageId: s.stored.id, inboundAt: s.msg.providerTimestamp }),
    );

    const contactOutcome = await withBusiness(BUSINESS, (db) =>
      handleContactCardMessage(db, {
        msg: s.msg,
        storedId: s.stored.id,
        cards: open.contactCards,
        messenger: s.messenger,
        othersOpen: open.mailCards.length,
      }),
    );
    expect(contactOutcome).toBe('refused');

    // A fresh inbound row for the second reader (the first was settled).
    const providerTimestamp = new Date(Date.now() + 3_000).toISOString();
    const second = await withBusiness(BUSINESS, (db) =>
      recordInbound(db, {
        providerMessageId: 'wamid.owner-open-2',
        senderNumber: PRINCIPAL,
        senderKind: 'principal',
        body: 'שלח',
        mediaKind: null,
        providerTimestamp,
      }),
    );
    if (second === null) throw new Error('duplicate');
    const mailOutcome = await withBusiness(BUSINESS, (db) =>
      handleMailCardMessage(db, {
        msg: { ...s.msg, providerMessageId: 'wamid.owner-open-2', providerTimestamp },
        storedId: second.id,
        cards: open.mailCards,
        messenger: s.messenger,
        othersOpen: open.contactCards.length,
      }),
    );
    expect(mailOutcome).toBe('refused');

    const { rows } = await testDb().query<{ state: string }>(
      `SELECT state FROM approval_requests WHERE business_id = $1 ORDER BY created_at`,
      [BUSINESS],
    );
    expect(rows.map((r) => r.state)).toEqual(['pending', 'pending']);
  });
});
