import { describe, expect, it } from 'vitest';
import type { MailboxClient, MailboxFailure, OutgoingMessage, OutgoingReply } from '../../mail/providers/types.js';
import { createMailboxSendAdapter } from './mailbox-send.js';
import { createCredentialHandle } from './types.js';
import type { AdapterCall } from './types.js';

function fakeClient(result: { externalId: string | null } | MailboxFailure) {
  const sent: Array<{ token: string; reply: OutgoingReply }> = [];
  const sentNew: Array<{ token: string; message: OutgoingMessage }> = [];
  const client = {
    sendReply: async (token: string, reply: OutgoingReply) => {
      sent.push({ token, reply });
      return result;
    },
    sendNew: async (token: string, message: OutgoingMessage) => {
      sentNew.push({ token, message });
      return result;
    },
  } as unknown as MailboxClient;
  return { client, sent, sentNew };
}

/** No stored mail: these tests never reach the instruction-reply lookup's success path. */
const noTargets = async () => null;

/** The stored mail GOOD answers — every reply is checked against one (fix round 1). */
const goodTarget = async () => ({
  threadId: 'T1',
  providerMessageId: 'M1',
  references: '<a@b>',
  fromAddress: 'dana@client.example',
});

const NEW_MAIL = { to: 'dana@client.example', subject: 'הצעת מחיר', body: 'מצורפת הצעה' };

const GOOD = {
  to: 'dana@client.example',
  subject: 'Re: הצעה',
  body: 'תודה',
  inReplyTo: '<a@b>',
  references: '<a@b>',
  threadId: 'T1',
  providerMessageId: 'M1',
};

function call(
  input: unknown,
  credential: AdapterCall['credential'] = createCredentialHandle('OAUTH_MAILBOX', 'tok'),
): AdapterCall {
  return {
    toolName: 'mail.send',
    input,
    credential,
    endpoint: null,
    businessId: 'test-business',
    idempotencyKey: 'k',
    signal: new AbortController().signal,
  };
}

describe('mailbox send adapter', () => {
  it('sends a reply with threading fields through the fake client', async () => {
    const { client, sent } = fakeClient({ externalId: 'sent-1' });
    const adapter = createMailboxSendAdapter({ replyTargets: goodTarget, system: 'mailbox', provider: 'microsoft', client });
    expect(adapter.channel).toBe('api');
    expect(adapter.serves).toEqual(['mail.send']);
    const result = await adapter.execute(call(GOOD));
    expect(result).toMatchObject({ ok: true, externalId: 'sent-1' });
    expect(sent).toEqual([
      {
        token: 'tok',
        reply: {
          to: ['dana@client.example'],
          subject: 'Re: הצעה',
          body: 'תודה',
          inReplyTo: '<a@b>',
          references: '<a@b>',
          threadId: 'T1',
          providerMessageId: 'M1',
        },
      },
    ]);
  });

  it('refuses a payload without inReplyTo as not_a_reply', async () => {
    const { client, sent } = fakeClient({ externalId: 'x' });
    const adapter = createMailboxSendAdapter({ replyTargets: noTargets, system: 'mailbox', provider: 'google', client });
    const { inReplyTo: _omit, ...rest } = GOOD;
    expect(await adapter.execute(call(rest))).toMatchObject({ ok: false, retryable: false, code: 'not_a_reply' });
    // With inReplyTo present, a missing id is resolved from the stored mail
    // (`mailbox-send-reply-target.test.ts`); none stored here, so the refusal
    // is reply_target_unknown — never a new mail.
    const { providerMessageId: _omit2, ...rest2 } = GOOD;
    expect(await adapter.execute(call(rest2))).toMatchObject({ code: 'reply_target_unknown' });
    expect(sent).toHaveLength(0);
  });

  it('null credential is credential_unavailable', async () => {
    const { client, sent } = fakeClient({ externalId: 'x' });
    const adapter = createMailboxSendAdapter({ replyTargets: noTargets, system: 'mailbox', provider: 'google', client });
    expect(await adapter.execute(call(GOOD, null))).toMatchObject({ ok: false, code: 'credential_unavailable' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a reply to anyone but the stored From, including a second recipient, and sends nothing', async () => {
    const { client, sent } = fakeClient({ externalId: 'x' });
    const adapter = createMailboxSendAdapter({ replyTargets: goodTarget, system: 'mailbox', provider: 'google', client });
    const result = await adapter.execute(call({ ...GOOD, to: ['dana@client.example', 'b@x.com'] }));
    expect(result).toMatchObject({ ok: false, retryable: false, code: 'reply_recipient_mismatch' });
    const result2 = await adapter.execute(call({ ...GOOD, to: 'b@x.com' }));
    expect(result2).toMatchObject({ ok: false, retryable: false, code: 'reply_recipient_mismatch' });
    expect(sent).toHaveLength(0);
  });

  it('maps provider failures with honest retryability', async () => {
    const run = async (f: MailboxFailure) =>
      createMailboxSendAdapter({ replyTargets: goodTarget, system: 'mailbox', provider: 'google', client: fakeClient(f).client }).execute(
        call(GOOD),
      );
    expect(await run({ failure: 'auth', status: 401, message: 'm' })).toMatchObject({
      retryable: true,
      code: 'auth_failed',
    });
    expect(await run({ failure: 'transient', status: 503, message: 'm' })).toMatchObject({
      retryable: true,
      code: 'transient',
    });
    expect(await run({ failure: 'transient', status: 429, message: 'm' })).toMatchObject({ retryable: true });
    // Network drop on the POST: the provider may have accepted it.
    expect(await run({ failure: 'transient', status: 0, message: 'm' })).toMatchObject({
      retryable: false,
      code: 'delivery_unknown',
    });
    expect(await run({ failure: 'rejected', status: 400, message: 'm' })).toMatchObject({
      retryable: false,
      code: 'send_rejected',
    });
    expect(await run({ failure: 'cursor_expired', status: 410, message: 'm' })).toMatchObject({
      retryable: false,
      code: 'send_rejected',
    });
  });

  it('sends a payload with no threading field as a NEW message, not a reply (R21)', async () => {
    const { client, sent, sentNew } = fakeClient({ externalId: 'new-1' });
    const adapter = createMailboxSendAdapter({ replyTargets: noTargets, system: 'mailbox', provider: 'google', client });
    const result = await adapter.execute(call(NEW_MAIL));
    expect(result).toMatchObject({ ok: true, externalId: 'new-1' });
    expect(sent).toHaveLength(0);
    expect(sentNew).toEqual([
      { token: 'tok', message: { to: ['dana@client.example'], subject: 'הצעת מחיר', body: 'מצורפת הצעה' } },
    ]);
  });

  it('a new message may go to several recipients', async () => {
    const { client, sentNew } = fakeClient({ externalId: 'new-1' });
    const adapter = createMailboxSendAdapter({ replyTargets: noTargets, system: 'mailbox', provider: 'microsoft', client });
    const result = await adapter.execute(call({ ...NEW_MAIL, to: ['a@x.com', 'b@y.com'] }));
    expect(result).toMatchObject({ ok: true });
    expect(sentNew[0]?.message.to).toEqual(['a@x.com', 'b@y.com']);
  });

  it('null or empty threading fields read as absent, so the payload is a new message', async () => {
    const { client, sent, sentNew } = fakeClient({ externalId: 'new-1' });
    const adapter = createMailboxSendAdapter({ replyTargets: noTargets, system: 'mailbox', provider: 'google', client });
    const result = await adapter.execute(
      call({ ...NEW_MAIL, inReplyTo: null, threadId: null, providerMessageId: '' }),
    );
    expect(result).toMatchObject({ ok: true });
    expect(sentNew).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('SOME but not all threading fields is refused, never sent as new', async () => {
    const { client, sent, sentNew } = fakeClient({ externalId: 'x' });
    let lookups = 0;
    const adapter = createMailboxSendAdapter({
      replyTargets: async () => {
        lookups += 1;
        return null;
      },
      system: 'mailbox',
      provider: 'google',
      client,
    });
    for (const partial of [
      { threadId: 'T1' },
      { providerMessageId: 'M1' },
      // A non-string value is not "absent".
      { threadId: 42 },
      { inReplyTo: '<a@b>', threadId: 42 },
      { inReplyTo: 42, threadId: 'T1', providerMessageId: 'M1' },
    ]) {
      expect(await adapter.execute(call({ ...NEW_MAIL, ...partial }))).toMatchObject({
        ok: false,
        retryable: false,
        code: 'not_a_reply',
      });
    }
    // Nothing to resolve from, or a malformed field: refused before any lookup.
    expect(lookups).toBe(0);
    // An inReplyTo with missing ids is an instruction reply: looked up, and
    // with no stored mail refused as reply_target_unknown — still never new.
    for (const partial of [{ inReplyTo: '<a@b>' }, { inReplyTo: '<a@b>', threadId: 'T1' }]) {
      expect(await adapter.execute(call({ ...NEW_MAIL, ...partial }))).toMatchObject({
        ok: false,
        retryable: false,
        code: 'reply_target_unknown',
      });
    }
    expect(lookups).toBe(2);
    expect(sent).toHaveLength(0);
    expect(sentNew).toHaveLength(0);
  });

  it('a lookup that throws is a retryable refusal, never a throw and never a send', async () => {
    const { client, sent, sentNew } = fakeClient({ externalId: 'x' });
    const adapter = createMailboxSendAdapter({
      replyTargets: async () => {
        throw new Error('db down');
      },
      system: 'mailbox',
      provider: 'google',
      client,
    });
    const failed = await adapter.execute(call({ ...NEW_MAIL, inReplyTo: '<a@b>' }));
    expect(failed).toMatchObject({ ok: false, retryable: true, code: 'reply_target_lookup_failed' });
    // A fixed sentence, never the raw database error.
    expect(failed).not.toMatchObject({ message: expect.stringContaining('db down') });
    expect(sent).toHaveLength(0);
    expect(sentNew).toHaveLength(0);
  });

  it('a new message with no readable recipient or no subject/body sends nothing', async () => {
    const { client, sentNew } = fakeClient({ externalId: 'x' });
    const adapter = createMailboxSendAdapter({ replyTargets: noTargets, system: 'mailbox', provider: 'google', client });
    expect(await adapter.execute(call({ ...NEW_MAIL, to: 'not an address' }))).toMatchObject({
      ok: false,
      code: 'no_recipient',
    });
    expect(await adapter.execute(call({ ...NEW_MAIL, subject: '' }))).toMatchObject({
      ok: false,
      code: 'message_incomplete',
    });
    expect(sentNew).toHaveLength(0);
  });

  it('a new message maps provider failures exactly like a reply', async () => {
    const run = async (f: MailboxFailure) =>
      createMailboxSendAdapter({ replyTargets: noTargets, system: 'mailbox', provider: 'google', client: fakeClient(f).client }).execute(
        call(NEW_MAIL),
      );
    expect(await run({ failure: 'transient', status: 0, message: 'm' })).toMatchObject({
      retryable: false,
      code: 'delivery_unknown',
    });
    expect(await run({ failure: 'transient', status: 503, message: 'm' })).toMatchObject({
      retryable: true,
      code: 'transient',
    });
    expect(await run({ failure: 'rejected', status: 400, message: 'm' })).toMatchObject({ code: 'send_rejected' });
  });

  it('refuses a tool it does not serve', async () => {
    const { client } = fakeClient({ externalId: 'x' });
    const adapter = createMailboxSendAdapter({ replyTargets: noTargets, system: 'mailbox', provider: 'google', client });
    expect(await adapter.execute({ ...call(GOOD), toolName: 'calendar.read' })).toMatchObject({
      code: 'unsupported_tool',
    });
  });
});
