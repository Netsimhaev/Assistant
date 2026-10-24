import { describe, expect, it } from 'vitest';
import { createGraphClient } from './graph.js';
import { MailboxCursorError, type MailboxHttp } from './types.js';

type Req = Parameters<MailboxHttp['request']>[0];

function fake(handler: (r: Req) => { status: number; body: unknown }): { http: MailboxHttp; calls: Req[] } {
  const calls: Req[] = [];
  return {
    calls,
    http: {
      async request(r) {
        calls.push(r);
        return handler(r);
      },
    },
  };
}

const signal = new AbortController().signal;

function graphMessage(extra: Record<string, unknown> = {}) {
  return {
    id: 'g1',
    conversationId: 'c1',
    internetMessageId: '<abc@example.com>',
    subject: 'חשבונית',
    receivedDateTime: '2026-10-21T08:00:00Z',
    from: { emailAddress: { name: 'Dana Cohen', address: 'Dana@Example.com' } },
    replyTo: [],
    toRecipients: [{ emailAddress: { address: 'Me@Biz.co.il' } }],
    body: { contentType: 'html', content: '<p>שלום &amp; תודה</p>' },
    hasAttachments: true,
    ...extra,
  };
}

const DELTA = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc';

function listRoutes(msg: unknown) {
  return (r: Req) => {
    if (r.url.includes('/attachments')) {
      return {
        status: 200,
        body: { value: [{ id: 'at1', name: 'inv.pdf', contentType: 'application/pdf', size: 99 }] },
      };
    }
    if (/\/me\/messages\/g1\?/.test(r.url)) return { status: 200, body: msg };
    return { status: 200, body: { value: [{ id: 'g1' }], '@odata.deltaLink': `${DELTA}2` } };
  };
}

describe('graph client', () => {
  it('listSince maps a full message with an HTML-only body to text', async () => {
    const { http } = fake(listRoutes(graphMessage()));
    const r = await createGraphClient(http).listSince('tok', DELTA, signal);
    if ('failure' in r) throw new Error('unexpected failure');
    expect(r.nextCursor).toBe(`${DELTA}2`);
    const m = r.messages[0]!;
    expect(m.providerMessageId).toBe('g1');
    expect(m.threadId).toBe('c1');
    expect(m.internetMessageId).toBe('<abc@example.com>');
    expect(m.fromAddress).toBe('dana@example.com');
    expect(m.fromName).toBe('Dana Cohen');
    expect(m.toAddresses).toEqual(['me@biz.co.il']);
    expect(m.bodyText).toBe('שלום & תודה');
    expect(m.replyTo).toBeNull();
    expect(m.references).toBeNull();
    expect(m.receivedAt).toBe('2026-10-21T08:00:00.000Z');
    expect(m.attachments).toEqual([{ attachmentId: 'at1', filename: 'inv.pdf', mediaType: 'application/pdf', size: 99 }]);
    expect(m.headerFlags).toEqual({ listUnsubscribe: false, autoSubmitted: false, bulkPrecedence: false });
  });

  it('listSince reads List-Unsubscribe and Auto-Submitted into headerFlags', async () => {
    const msg = graphMessage({
      hasAttachments: false,
      replyTo: [{ emailAddress: { address: 'Help@X.com' } }],
      internetMessageHeaders: [
        { name: 'List-Unsubscribe', value: '<mailto:u@x.com>' },
        { name: 'Auto-Submitted', value: 'auto-replied' },
        { name: 'Precedence', value: 'bulk' },
        { name: 'References', value: '<r1@x.com>' },
      ],
    });
    const { http } = fake(listRoutes(msg));
    const r = await createGraphClient(http).listSince('tok', DELTA, signal);
    if ('failure' in r) throw new Error('unexpected failure');
    expect(r.messages[0]?.headerFlags).toEqual({ listUnsubscribe: true, autoSubmitted: true, bulkPrecedence: true });
    expect(r.messages[0]?.references).toBe('<r1@x.com>');
    expect(r.messages[0]?.replyTo).toBe('help@x.com');
  });

  it('listSince skips removed entries and follows nextLink', async () => {
    let n = 0;
    const { http } = fake(() => {
      n++;
      if (n === 1) return { status: 200, body: { value: [{ id: 'x', '@removed': { reason: 'deleted' } }], '@odata.nextLink': 'https://graph.microsoft.com/next' } };
      if (n === 2) return { status: 200, body: { value: [{ id: 'g1' }, { id: 'g1' }], '@odata.deltaLink': 'D2' } };
      return { status: 200, body: graphMessage({ hasAttachments: false }) };
    });
    const r = await createGraphClient(http).listSince('tok', DELTA, signal);
    if ('failure' in r) throw new Error('unexpected failure');
    expect(r.messages).toHaveLength(1);
    expect(r.nextCursor).toBe('D2');
  });

  it('addLabel preserves existing categories', async () => {
    const { http, calls } = fake((r) =>
      r.method === 'GET' ? { status: 200, body: { categories: ['Red'] } } : { status: 200, body: {} },
    );
    const r = await createGraphClient(http).addLabel('tok', 'g1', 'חשבוניות', 'cat1', signal);
    expect(r).toBe(true);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('/me/messages/g1');
    expect(patch.body).toEqual({ categories: ['Red', 'חשבוניות'] });
  });

  it('sendReply is a single POST to /reply with explicit recipients and no draft calls', async () => {
    const { http, calls } = fake(() => ({ status: 202, body: null }));
    const r = await createGraphClient(http).sendReply(
      'tok',
      {
        to: ['dana@example.com'],
        subject: 'Re: חשבונית',
        body: 'תודה',
        inReplyTo: '<abc@example.com>',
        references: null,
        threadId: 'c1',
        providerMessageId: 'g1',
      },
      signal,
    );
    expect(r).toEqual({ externalId: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toMatch(/\/me\/messages\/g1\/reply$/);
    expect(calls[0]?.body).toEqual({
      message: { toRecipients: [{ emailAddress: { address: 'dana@example.com' } }], ccRecipients: [] },
      comment: 'תודה',
    });
    expect(calls.some((c) => /createReply|\/send$/.test(c.url) || c.method === 'PATCH')).toBe(false);
  });

  it('sendReply without providerMessageId is rejected', async () => {
    const { http } = fake(() => ({ status: 200, body: {} }));
    const r = await createGraphClient(http).sendReply(
      'tok',
      { to: ['a@b.com'], subject: 's', body: 'b', inReplyTo: '<x>', references: null, threadId: 'c', providerMessageId: '' },
      signal,
    );
    expect(r).toMatchObject({ failure: 'rejected' });
  });

  it('401 maps to auth failure', async () => {
    const { http } = fake(() => ({ status: 401, body: { error: { message: 'expired' } } }));
    const c = createGraphClient(http);
    expect(await c.listSince('tok', DELTA, signal)).toMatchObject({ failure: 'auth', status: 401 });
    expect(await c.addLabel('tok', 'g', 'חשבוניות', 'y', signal)).toMatchObject({ failure: 'auth' });
    await expect(c.initialCursor('tok', signal)).rejects.toBeInstanceOf(MailboxCursorError);
  });

  it('initialCursor returns a deltaLink and no messages', async () => {
    let n = 0;
    const { http, calls } = fake(() => {
      n++;
      if (n === 1) return { status: 200, body: { value: [graphMessage()], '@odata.nextLink': 'https://graph.microsoft.com/page2' } };
      return { status: 200, body: { value: [graphMessage()], '@odata.deltaLink': 'DELTA-FINAL' } };
    });
    const cursor = await createGraphClient(http).initialCursor('tok', signal);
    expect(cursor).toBe('DELTA-FINAL');
    expect(calls[0]?.url).toContain('mailFolders/inbox/messages/delta');
    const first = decodeURIComponent(calls[0]?.url ?? '');
    expect(first).toMatch(/\$filter=receivedDateTime ge \d{4}-\d{2}-\d{2}T/);
    expect(first).toContain('$select=id');
    expect(first).not.toContain('body');
    expect(calls[0]?.headers).toEqual({ Prefer: 'odata.maxpagesize=50' });
    expect(calls).toHaveLength(2);
  });

  it('410 and syncStateNotFound map to cursor_expired', async () => {
    const gone = fake(() => ({ status: 410, body: null }));
    expect(await createGraphClient(gone.http).listSince('tok', DELTA, signal)).toMatchObject({ failure: 'cursor_expired' });
    const sync = fake(() => ({ status: 400, body: { error: { code: 'syncStateNotFound', message: 'x' } } }));
    expect(await createGraphClient(sync.http).listSince('tok', DELTA, signal)).toMatchObject({ failure: 'cursor_expired' });
  });

  it('addLabel and ensureLabels accept only the closed label set, with zero HTTP calls otherwise', async () => {
    const { http, calls } = fake(() => ({ status: 200, body: {} }));
    const c = createGraphClient(http);
    expect(await c.addLabel('tok', 'g1', 'SPAM', 'x', signal)).toMatchObject({ failure: 'rejected' });
    expect(await c.addLabel('tok', 'g1', 'Junk', 'x', signal)).toMatchObject({ failure: 'rejected' });
    expect(await c.ensureLabels('tok', ['Red'], signal)).toMatchObject({ failure: 'rejected' });
    expect(calls).toHaveLength(0);
  });

  it('sendReply refuses a recipient that is not a plain address, with no HTTP call', async () => {
    const { http, calls } = fake(() => ({ status: 202, body: null }));
    const r = await createGraphClient(http).sendReply(
      'tok',
      { to: ['a@b.com\r\nBcc: v@y.com'], subject: 's', body: 'b', inReplyTo: '<x>', references: null, threadId: 'c', providerMessageId: 'g1' },
      signal,
    );
    expect(r).toMatchObject({ failure: 'rejected' });
    expect(calls).toHaveLength(0);
  });

  it('sendNew is one POST to /me/sendMail, saved to Sent, with no draft and no reply endpoint (R21)', async () => {
    const { http, calls } = fake(() => ({ status: 202, body: null }));
    const r = await createGraphClient(http).sendNew(
      'tok',
      { to: ['dana@example.com', 'avi@example.org'], subject: 'הצעת מחיר', body: 'שלום' },
      signal,
    );
    expect(r).toEqual({ externalId: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toMatch(/\/me\/sendMail$/);
    expect(calls[0]?.body).toEqual({
      message: {
        subject: 'הצעת מחיר',
        body: { contentType: 'Text', content: 'שלום' },
        toRecipients: [
          { emailAddress: { address: 'dana@example.com' } },
          { emailAddress: { address: 'avi@example.org' } },
        ],
        ccRecipients: [],
      },
      saveToSentItems: true,
    });
    expect(calls.some((c) => /createReply|\/messages(\/|$)|\/reply/.test(c.url) || c.method === 'PATCH')).toBe(false);
  });

  const refused: Array<[string, { to?: string[]; subject?: string }]> = [
    ['a recipient with CRLF', { to: ['a@b.com\r\nBcc: v@y.com'] }],
    ['no recipients', { to: [] }],
    ['a subject with CR/LF', { subject: 'hi\r\nBcc: v@y.com' }],
  ];
  for (const [label, patch] of refused) {
    it(`sendNew refuses ${label}, with no HTTP call`, async () => {
      const { http, calls } = fake(() => ({ status: 202, body: null }));
      const r = await createGraphClient(http).sendNew(
        'tok',
        { to: ['dana@example.com'], subject: 's', body: 'b', ...patch },
        signal,
      );
      expect(r).toMatchObject({ failure: 'rejected' });
      expect(calls).toHaveLength(0);
    });
  }

  it('ensureLabels creates only missing categories', async () => {
    const { http, calls } = fake((r) =>
      r.method === 'GET'
        ? { status: 200, body: { value: [{ id: 'c1', displayName: 'חשבוניות' }] } }
        : { status: 201, body: { id: 'c2', displayName: 'ממתין לתשובה' } },
    );
    const map = await createGraphClient(http).ensureLabels('tok', ['חשבוניות', 'ממתין לתשובה'], signal);
    expect(map).toEqual({ חשבוניות: 'c1', 'ממתין לתשובה': 'c2' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});
