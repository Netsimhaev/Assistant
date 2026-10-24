/**
 * An instruction-door reply through the mailbox adapter.
 *
 * The planner writes a reply as `mail.send` with `inReplyTo` and nothing
 * else — it never sees a provider thread id. After the mailbox amendment this
 * adapter is the only one serving `mail.send`, so without resolving the two
 * missing threading fields from the business's own stored mail, every reply
 * the owner instructed failed `not_a_reply`. Real DB: the lookup is the
 * business-scoped `replyTargetFor`, the same one `buildRuntime` wires.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../../db/pool.js';
import { replyTargetFor } from '../../mail/inbox-store.js';
import { resetDatabase } from '../../test/db.js';
import { fakeMailboxClient, storedMail } from '../../test/mailbox.js';
import { createMailboxSendAdapter } from './mailbox-send.js';
import { createCredentialHandle } from './types.js';
import type { AdapterCall } from './types.js';

const BUSINESS = 'test-business';
const OTHER = 'other-business';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

/** Exactly what the instruction door's planner writes for "answer Dana". */
const INSTRUCTED = {
  to: 'dana@client.example',
  subject: 'Re: מתי תגיע ההצעה?',
  body: 'ההצעה תגיע מחר.',
  inReplyTo: '<q-1@client.example>',
};

function call(input: unknown, businessId: string = BUSINESS): AdapterCall {
  return {
    toolName: 'mail.send',
    input,
    credential: createCredentialHandle('OAUTH_MAILBOX', 'tok'),
    endpoint: null,
    businessId,
    idempotencyKey: 'k',
    signal: new AbortController().signal,
  };
}

function adapterWith(client: ReturnType<typeof fakeMailboxClient>['client']) {
  return createMailboxSendAdapter({ system: 'mailbox', provider: 'google', client, replyTargets: replyTargetFor });
}

describe('mailbox adapter resolves an instruction reply from the stored mail', () => {
  it('sends a threaded reply with the stored thread and provider ids, to the approved `to`', async () => {
    await storedMail(BUSINESS);
    const { client, sent, sentNew } = fakeMailboxClient();
    const result = await adapterWith(client).execute(call(INSTRUCTED));

    expect(result).toMatchObject({ ok: true, externalId: 'SENT-1' });
    expect(sentNew).toHaveLength(0);
    expect(sent).toEqual([
      {
        to: ['dana@client.example'],
        subject: 'Re: מתי תגיע ההצעה?',
        body: 'ההצעה תגיע מחר.',
        inReplyTo: '<q-1@client.example>',
        // Like a card reply: the stored References header when the payload has none.
        references: '<q-0@client.example>',
        threadId: 'TH-1',
        providerMessageId: 'PM-1',
      },
    ]);
  });

  it('sends when `to` is the stored From, compared case-insensitively', async () => {
    await storedMail(BUSINESS, { fromAddress: 'Dana@Client.Example' });
    const { client, sent } = fakeMailboxClient();
    const result = await adapterWith(client).execute(call(INSTRUCTED));
    expect(result).toMatchObject({ ok: true });
    expect(sent.map((r) => r.to)).toEqual([['dana@client.example']]);
  });

  it('refuses reply_recipient_mismatch when `to` is anyone but the stored From — zero sends', async () => {
    // On Microsoft the reply quotes the original: a "reply" to Y would forward
    // the stranger's mail to Y, priced as email.reply.
    await storedMail(BUSINESS, { fromAddress: 'someone-else@client.example' });
    const { client, sent, sentNew } = fakeMailboxClient();
    const result = await adapterWith(client).execute(call(INSTRUCTED));
    expect(result).toEqual({
      ok: false,
      retryable: false,
      code: 'reply_recipient_mismatch',
      message: 'תשובה בתוך שיחה נשלחת רק לשולח המקורי',
    });
    expect(sent).toHaveLength(0);
    expect(sentNew).toHaveLength(0);
  });

  it('never answers the Reply-To address, even when it differs from From', async () => {
    await storedMail(BUSINESS, { replyTo: 'collector@elsewhere.example' });
    const { client, sent } = fakeMailboxClient();
    const result = await adapterWith(client).execute(call({ ...INSTRUCTED, to: 'collector@elsewhere.example' }));
    expect(result).toMatchObject({ ok: false, code: 'reply_recipient_mismatch' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a second recipient beside the stored From', async () => {
    await storedMail(BUSINESS);
    const { client, sent } = fakeMailboxClient();
    const result = await adapterWith(client).execute(
      call({ ...INSTRUCTED, to: ['dana@client.example', 'y@else.example'] }),
    );
    expect(result).toMatchObject({ ok: false, code: 'reply_recipient_mismatch' });
    expect(sent).toHaveLength(0);
  });

  it('refuses reply_target_unknown when no stored mail carries that Message-ID — and sends nothing', async () => {
    await storedMail(BUSINESS, { internetMessageId: '<other@client.example>' });
    const { client, sent, sentNew } = fakeMailboxClient();
    const result = await adapterWith(client).execute(call(INSTRUCTED));

    expect(result).toEqual({
      ok: false,
      retryable: false,
      code: 'reply_target_unknown',
      message: 'לא נמצא המייל שאליו מבקשים לענות בתיבת העסק',
    });
    expect(sent).toHaveLength(0);
    expect(sentNew).toHaveLength(0);
  });

  it("never uses another business's stored mail with the same Message-ID", async () => {
    await storedMail(OTHER);
    const { client, sent, sentNew } = fakeMailboxClient();
    const result = await adapterWith(client).execute(call(INSTRUCTED, BUSINESS));

    expect(result).toMatchObject({ ok: false, code: 'reply_target_unknown' });
    expect(sent).toHaveLength(0);
    expect(sentNew).toHaveLength(0);

    // Control: the same call for the business that owns the mail resolves —
    // so the refusal above is the scoping, not a lookup that never works.
    const ok = await adapterWith(client).execute(call(INSTRUCTED, OTHER));
    expect(ok).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it('refuses not_a_reply when a supplied threadId disagrees with the stored mail', async () => {
    await storedMail(BUSINESS);
    const { client, sent, sentNew } = fakeMailboxClient();
    const result = await adapterWith(client).execute(call({ ...INSTRUCTED, threadId: 'TH-WRONG' }));
    expect(result).toMatchObject({ ok: false, retryable: false, code: 'not_a_reply' });

    const result2 = await adapterWith(client).execute(call({ ...INSTRUCTED, providerMessageId: 'PM-WRONG' }));
    expect(result2).toMatchObject({ ok: false, retryable: false, code: 'not_a_reply' });
    expect(sent).toHaveLength(0);
    expect(sentNew).toHaveLength(0);
  });

  it('a supplied threadId that agrees with the stored mail completes the rest', async () => {
    await storedMail(BUSINESS);
    const { client, sent } = fakeMailboxClient();
    const result = await adapterWith(client).execute(call({ ...INSTRUCTED, threadId: 'TH-1' }));
    expect(result).toMatchObject({ ok: true });
    expect(sent[0]).toMatchObject({ threadId: 'TH-1', providerMessageId: 'PM-1' });
  });

  it('a card reply (all three fields, built from the stored mail) still sends', async () => {
    const mail = await storedMail(BUSINESS);
    const { client, sent } = fakeMailboxClient();
    const card = {
      to: [mail.fromAddress],
      subject: 'Re: מתי תגיע ההצעה?',
      body: 'מחר.',
      inReplyTo: mail.internetMessageId,
      references: mail.references,
      threadId: mail.threadId,
      providerMessageId: mail.providerMessageId,
    };
    expect(await adapterWith(client).execute(call(card))).toMatchObject({ ok: true });
    expect(sent[0]).toMatchObject({ threadId: 'TH-1', providerMessageId: 'PM-1', to: ['dana@client.example'] });
  });

  it('all three fields are still checked: an unknown inReplyTo is reply_target_unknown', async () => {
    await storedMail(BUSINESS);
    const { client, sent } = fakeMailboxClient();
    const result = await adapterWith(client).execute(
      call({ ...INSTRUCTED, inReplyTo: '<unknown@x>', threadId: 'TH-1', providerMessageId: 'PM-1' }),
    );
    expect(result).toMatchObject({ ok: false, code: 'reply_target_unknown' });
    expect(sent).toHaveLength(0);
  });

  it('all three fields are still checked: a providerMessageId naming another message is not_a_reply', async () => {
    // A planner-written step cannot reply-quote an arbitrary mailbox message.
    await storedMail(BUSINESS);
    await storedMail(BUSINESS, { providerMessageId: 'PM-SECRET', threadId: 'TH-SECRET', internetMessageId: '<s@x>' });
    const { client, sent } = fakeMailboxClient();
    const result = await adapterWith(client).execute(
      call({ ...INSTRUCTED, threadId: 'TH-SECRET', providerMessageId: 'PM-SECRET' }),
    );
    expect(result).toMatchObject({ ok: false, code: 'not_a_reply' });
    expect(sent).toHaveLength(0);
  });

  describe('two stored rows sharing one Message-ID', () => {
    // Different provider ids — or a stranger reusing a real conversation's
    // Message-ID. The row a payload names by providerMessageId is the row it
    // is checked against, not whichever arrived first.
    async function twoRows() {
      const first = await storedMail(BUSINESS);
      const second = await storedMail(BUSINESS, {
        providerMessageId: 'PM-2',
        threadId: 'TH-2',
        fromAddress: 'avi@other.example',
        receivedAt: '2026-10-21T08:30:00.000Z',
      });
      return { first, second };
    }

    it('a card raised from the second row sends to the second row’s From, on its thread', async () => {
      const { second } = await twoRows();
      const { client, sent } = fakeMailboxClient();
      const card = {
        to: [second.fromAddress],
        subject: 'Re: מתי תגיע ההצעה?',
        body: 'מחר.',
        inReplyTo: second.internetMessageId,
        references: second.references,
        threadId: second.threadId,
        providerMessageId: second.providerMessageId,
      };
      expect(await adapterWith(client).execute(call(card))).toMatchObject({ ok: true });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: ['avi@other.example'], threadId: 'TH-2', providerMessageId: 'PM-2' });
    });

    it('naming the second row but addressing the first row’s From is refused', async () => {
      const { first, second } = await twoRows();
      const { client, sent, sentNew } = fakeMailboxClient();
      const result = await adapterWith(client).execute(
        call({ ...INSTRUCTED, to: first.fromAddress, threadId: second.threadId, providerMessageId: second.providerMessageId }),
      );
      expect(result).toMatchObject({ ok: false, code: 'reply_recipient_mismatch' });
      expect(sent).toHaveLength(0);
      expect(sentNew).toHaveLength(0);
    });

    it('with no providerMessageId supplied, the earliest row still resolves', async () => {
      await twoRows();
      const { client, sent } = fakeMailboxClient();
      expect(await adapterWith(client).execute(call(INSTRUCTED))).toMatchObject({ ok: true });
      expect(sent[0]).toMatchObject({ to: ['dana@client.example'], threadId: 'TH-1', providerMessageId: 'PM-1' });
    });

    it('the second row’s providerMessageId with the first row’s threadId is not_a_reply', async () => {
      const { first, second } = await twoRows();
      const { client, sent } = fakeMailboxClient();
      const result = await adapterWith(client).execute(
        call({ ...INSTRUCTED, to: second.fromAddress, threadId: first.threadId, providerMessageId: second.providerMessageId }),
      );
      expect(result).toMatchObject({ ok: false, code: 'not_a_reply' });
      expect(sent).toHaveLength(0);
    });
  });

  it('threading fields without an inReplyTo are still not_a_reply — there is nothing to resolve from', async () => {
    await storedMail(BUSINESS);
    const { client, sent, sentNew } = fakeMailboxClient();
    const { inReplyTo: _omit, ...rest } = INSTRUCTED;
    const result = await adapterWith(client).execute(call({ ...rest, threadId: 'TH-1' }));
    expect(result).toMatchObject({ ok: false, code: 'not_a_reply' });
    expect(sent).toHaveLength(0);
    expect(sentNew).toHaveLength(0);
  });
});
