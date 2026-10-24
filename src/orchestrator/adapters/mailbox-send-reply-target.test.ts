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

  it('keeps the gate-approved `to`, never the stored From', async () => {
    await storedMail(BUSINESS, { fromAddress: 'someone-else@client.example' });
    const { client, sent } = fakeMailboxClient();
    await adapterWith(client).execute(call(INSTRUCTED));
    expect(sent.map((r) => r.to)).toEqual([['dana@client.example']]);
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
