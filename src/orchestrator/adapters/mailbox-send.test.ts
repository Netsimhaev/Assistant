import { describe, expect, it } from 'vitest';
import type { MailboxClient, MailboxFailure, OutgoingReply } from '../../mail/providers/types.js';
import { createMailboxSendAdapter } from './mailbox-send.js';
import { createCredentialHandle } from './types.js';
import type { AdapterCall } from './types.js';

function fakeClient(result: { externalId: string | null } | MailboxFailure) {
  const sent: Array<{ token: string; reply: OutgoingReply }> = [];
  const client = {
    sendReply: async (token: string, reply: OutgoingReply) => {
      sent.push({ token, reply });
      return result;
    },
  } as unknown as MailboxClient;
  return { client, sent };
}

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
    idempotencyKey: 'k',
    signal: new AbortController().signal,
  };
}

describe('mailbox send adapter', () => {
  it('sends a reply with threading fields through the fake client', async () => {
    const { client, sent } = fakeClient({ externalId: 'sent-1' });
    const adapter = createMailboxSendAdapter({ system: 'mailbox', provider: 'microsoft', client });
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
    const adapter = createMailboxSendAdapter({ system: 'mailbox', provider: 'google', client });
    const { inReplyTo: _omit, ...rest } = GOOD;
    expect(await adapter.execute(call(rest))).toMatchObject({ ok: false, retryable: false, code: 'not_a_reply' });
    const { providerMessageId: _omit2, ...rest2 } = GOOD;
    expect(await adapter.execute(call(rest2))).toMatchObject({ code: 'not_a_reply' });
    expect(sent).toHaveLength(0);
  });

  it('null credential is credential_unavailable', async () => {
    const { client, sent } = fakeClient({ externalId: 'x' });
    const adapter = createMailboxSendAdapter({ system: 'mailbox', provider: 'google', client });
    expect(await adapter.execute(call(GOOD, null))).toMatchObject({ ok: false, code: 'credential_unavailable' });
    expect(sent).toHaveLength(0);
  });

  it('refuses more than one recipient and sends nothing', async () => {
    const { client, sent } = fakeClient({ externalId: 'x' });
    const adapter = createMailboxSendAdapter({ system: 'mailbox', provider: 'google', client });
    const result = await adapter.execute(call({ ...GOOD, to: ['a@x.com', 'b@x.com'] }));
    expect(result).toMatchObject({ ok: false, retryable: false, code: 'no_recipient' });
    expect(sent).toHaveLength(0);
  });

  it('maps provider failures with honest retryability', async () => {
    const run = async (f: MailboxFailure) =>
      createMailboxSendAdapter({ system: 'mailbox', provider: 'google', client: fakeClient(f).client }).execute(
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

  it('refuses a tool it does not serve', async () => {
    const { client } = fakeClient({ externalId: 'x' });
    const adapter = createMailboxSendAdapter({ system: 'mailbox', provider: 'google', client });
    expect(await adapter.execute({ ...call(GOOD), toolName: 'calendar.read' })).toMatchObject({
      code: 'unsupported_tool',
    });
  });
});
