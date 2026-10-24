import { describe, expect, it } from 'vitest';
import { createGmailClient } from './gmail.js';
import { MailboxCursorError, type MailboxHttp, type OutgoingReply } from './types.js';

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

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const signal = new AbortController().signal;

function message(headers: Array<[string, string]>, html = '<p>שלום &amp; תודה</p>') {
  return {
    id: 'm1',
    threadId: 't1',
    internalDate: String(Date.UTC(2026, 9, 21, 8, 0, 0)),
    payload: {
      mimeType: 'multipart/mixed',
      headers: headers.map(([name, value]) => ({ name, value })),
      parts: [
        { mimeType: 'text/html', body: { data: b64u(html) } },
        { mimeType: 'application/pdf', filename: 'inv.pdf', body: { attachmentId: 'a1', size: 1234 } },
      ],
    },
  };
}

const BASE_HEADERS: Array<[string, string]> = [
  ['From', '"Dana Cohen" <Dana@Example.com>'],
  ['To', 'me@biz.co.il, other@biz.co.il'],
  ['Subject', '=?UTF-8?Q?=D7=97=D7=A9=D7=91=D7=95=D7=A0=D7=99=D7=AA?='],
  ['Message-ID', '<abc@example.com>'],
];

function gmailRoutes(msg: unknown) {
  return (r: Req) => {
    if (r.url.includes('/history')) {
      return {
        status: 200,
        body: { historyId: '200', history: [{ messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] }] },
      };
    }
    if (r.url.includes('/messages/m1')) return { status: 200, body: msg };
    return { status: 404, body: {} };
  };
}

describe('gmail client', () => {
  it('listSince maps a full message with an HTML-only body to text', async () => {
    const { http, calls } = fake(gmailRoutes(message(BASE_HEADERS)));
    const r = await createGmailClient(http).listSince('tok', '100', signal);
    if ('failure' in r) throw new Error('unexpected failure');
    expect(r.nextCursor).toBe('200');
    expect(calls[0]?.url).toContain('startHistoryId=100');
    expect(calls[0]?.url).toContain('historyTypes=messageAdded');
    expect(calls[0]?.url).toContain('labelId=INBOX');
    const m = r.messages[0]!;
    expect(m.providerMessageId).toBe('m1');
    expect(m.threadId).toBe('t1');
    expect(m.fromAddress).toBe('dana@example.com');
    expect(m.fromName).toBe('Dana Cohen');
    expect(m.toAddresses).toEqual(['me@biz.co.il', 'other@biz.co.il']);
    expect(m.subject).toBe('חשבונית');
    expect(m.internetMessageId).toBe('<abc@example.com>');
    expect(m.references).toBeNull();
    expect(m.replyTo).toBeNull();
    expect(m.bodyText).toBe('שלום & תודה');
    expect(m.attachments).toEqual([{ attachmentId: 'a1', filename: 'inv.pdf', mediaType: 'application/pdf', size: 1234 }]);
    expect(m.receivedAt).toBe('2026-10-21T08:00:00.000Z');
    expect(m.headerFlags).toEqual({ listUnsubscribe: false, autoSubmitted: false, bulkPrecedence: false });
  });

  it('listSince reads List-Unsubscribe and Auto-Submitted into headerFlags', async () => {
    const hs: Array<[string, string]> = [
      ...BASE_HEADERS,
      ['List-Unsubscribe', '<mailto:u@x.com>'],
      ['Auto-Submitted', 'auto-generated'],
      ['Precedence', 'bulk'],
      ['Reply-To', 'Support <Help@X.com>'],
    ];
    const { http } = fake(gmailRoutes(message(hs)));
    const r = await createGmailClient(http).listSince('tok', '100', signal);
    if ('failure' in r) throw new Error('unexpected failure');
    expect(r.messages[0]?.headerFlags).toEqual({ listUnsubscribe: true, autoSubmitted: true, bulkPrecedence: true });
    expect(r.messages[0]?.replyTo).toBe('help@x.com');
    const no = fake(gmailRoutes(message([...BASE_HEADERS, ['Auto-Submitted', 'no']])));
    const r2 = await createGmailClient(no.http).listSince('tok', '100', signal);
    if ('failure' in r2) throw new Error('unexpected failure');
    expect(r2.messages[0]?.headerFlags.autoSubmitted).toBe(false);
  });

  it('addLabel sends addLabelIds and no removeLabelIds', async () => {
    const { http, calls } = fake(() => ({ status: 200, body: {} }));
    const r = await createGmailClient(http).addLabel('tok', 'm1', 'חשבוניות', 'Label_1', signal);
    expect(r).toBe(true);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/messages/m1/modify');
    expect(calls[0]?.body).toEqual({ addLabelIds: ['Label_1'] });
  });

  it('sendReply carries In-Reply-To, References and threadId', async () => {
    const { http, calls } = fake(() => ({ status: 200, body: { id: 'sent1' } }));
    const r = await createGmailClient(http).sendReply(
      'tok',
      {
        to: ['dana@example.com'],
        subject: 'Re: חשבונית',
        body: 'תודה רבה',
        inReplyTo: '<abc@example.com>',
        references: '<first@example.com>',
        threadId: 't1',
        providerMessageId: 'm1',
      },
      signal,
    );
    expect(r).toEqual({ externalId: 'sent1' });
    const body = calls[0]?.body as { raw: string; threadId: string };
    expect(body.threadId).toBe('t1');
    const raw = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(raw).toContain('To: dana@example.com');
    expect(raw).toContain('In-Reply-To: <abc@example.com>');
    expect(raw).toContain('References: <first@example.com> <abc@example.com>');
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(raw).toContain('Content-Transfer-Encoding: base64');
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    const payload = raw.split('\r\n\r\n')[1]!;
    expect(Buffer.from(payload.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('תודה רבה');
  });

  it('401 maps to auth failure', async () => {
    const { http } = fake(() => ({ status: 401, body: { error: { message: 'bad token' } } }));
    const c = createGmailClient(http);
    expect(await c.listSince('tok', '1', signal)).toMatchObject({ failure: 'auth', status: 401 });
    expect(await c.addLabel('tok', 'm', 'חשבוניות', 'Label_1', signal)).toMatchObject({ failure: 'auth' });
    const net = fake(() => ({ status: 0, body: null }));
    expect(await createGmailClient(net.http).ensureLabels('tok', ['חשבוניות'], signal)).toMatchObject({ failure: 'transient' });
  });

  it('initialCursor reads the profile historyId; ensureLabels creates only missing labels', async () => {
    const { http, calls } = fake((r) => {
      if (r.url.endsWith('/profile')) return { status: 200, body: { historyId: '77' } };
      if (r.method === 'GET') return { status: 200, body: { labels: [{ id: 'L1', name: 'חשבוניות' }] } };
      return { status: 200, body: { id: 'L2', name: 'ממתין לתשובה' } };
    });
    const c = createGmailClient(http);
    expect(await c.initialCursor('tok', signal)).toBe('77');
    const map = await c.ensureLabels('tok', ['חשבוניות', 'ממתין לתשובה'], signal);
    expect(map).toEqual({ חשבוניות: 'L1', 'ממתין לתשובה': 'L2' });
    expect(calls.filter((x) => x.method === 'POST')).toHaveLength(1);
  });

  it('a From with an encoded CR/LF inside the angle brackets yields no address (no header injection)', async () => {
    const evil = '"X" <=?UTF-8?Q?a@b.com=0D=0ABcc:_victim@y.com?=>';
    const { http } = fake(gmailRoutes(message([...BASE_HEADERS.filter(([n]) => n !== 'From'), ['From', evil]])));
    const r = await createGmailClient(http).listSince('tok', '100', signal);
    if ('failure' in r) throw new Error('unexpected failure');
    expect(r.messages[0]?.fromAddress).toBe('');
    expect(r.messages[0]?.fromAddress).not.toMatch(/[\r\n]/);
  });

  describe('sendReply refuses header-breaking values without any HTTP call', () => {
    const ok: OutgoingReply = {
      to: ['dana@example.com'],
      subject: 'Re: x',
      body: 'b',
      inReplyTo: '<abc@example.com>',
      references: null,
      threadId: 't1',
      providerMessageId: 'm1',
    };
    const cases: Array<[string, Partial<OutgoingReply>]> = [
      ['to with CRLF', { to: ['a@b.com\r\nBcc: v@y.com'] }],
      ['to not an address', { to: ['not an address'] }],
      ['inReplyTo with LF', { inReplyTo: '<a>\nBcc: v@y.com' }],
      ['references with CR', { references: '<a>\rX: y' }],
    ];
    for (const [label, patch] of cases) {
      it(label, async () => {
        const { http, calls } = fake(() => ({ status: 200, body: { id: 'x' } }));
        const r = await createGmailClient(http).sendReply('tok', { ...ok, ...patch }, signal);
        expect(r).toMatchObject({ failure: 'rejected' });
        expect(calls).toHaveLength(0);
      });
    }
  });

  it('history 404 maps to cursor_expired', async () => {
    const { http } = fake(() => ({ status: 404, body: { error: { message: 'startHistoryId too old' } } }));
    expect(await createGmailClient(http).listSince('tok', '1', signal)).toMatchObject({ failure: 'cursor_expired' });
  });

  it('hitting the history page cap fails transient instead of advancing the cursor', async () => {
    const { http } = fake((r) =>
      r.url.includes('/history') ? { status: 200, body: { historyId: '999', nextPageToken: 'more' } } : { status: 404, body: {} },
    );
    expect(await createGmailClient(http).listSince('tok', '1', signal)).toMatchObject({ failure: 'transient' });
  });

  it('addLabel only accepts our label names and user-label ids, with zero HTTP calls otherwise', async () => {
    const { http, calls } = fake(() => ({ status: 200, body: {} }));
    const c = createGmailClient(http);
    expect(await c.addLabel('tok', 'm1', 'SPAM', 'SPAM', signal)).toMatchObject({ failure: 'rejected' });
    expect(await c.addLabel('tok', 'm1', 'חשבוניות', 'TRASH', signal)).toMatchObject({ failure: 'rejected' });
    expect(await c.addLabel('tok', 'm1', 'UNREAD', 'Label_1', signal)).toMatchObject({ failure: 'rejected' });
    expect(calls).toHaveLength(0);
    expect(await c.ensureLabels('tok', ['SPAM'], signal)).toMatchObject({ failure: 'rejected' });
    expect(calls).toHaveLength(0);
  });

  it('decodes a windows-1255 body by its declared charset', async () => {
    const msg = {
      id: 'm1',
      threadId: 't1',
      internalDate: '1',
      payload: {
        mimeType: 'text/plain',
        headers: [
          ...BASE_HEADERS.map(([name, value]) => ({ name, value })),
          { name: 'Content-Type', value: 'text/plain; charset=windows-1255' },
        ],
        body: { data: Buffer.from([0xf9, 0xec, 0xe5, 0xed]).toString('base64url') },
      },
    };
    const { http } = fake(gmailRoutes(msg));
    const r = await createGmailClient(http).listSince('tok', '100', signal);
    if ('failure' in r) throw new Error('unexpected failure');
    expect(r.messages[0]?.bodyText).toBe('שלום');
  });

  it('a named part with inline data is not appended to the body', async () => {
    const msg = {
      id: 'm1',
      threadId: 't1',
      internalDate: '1',
      payload: {
        mimeType: 'multipart/mixed',
        headers: BASE_HEADERS.map(([name, value]) => ({ name, value })),
        parts: [
          { mimeType: 'text/plain', body: { data: b64u('real body') } },
          { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64u('attached text') } },
        ],
      },
    };
    const { http } = fake(gmailRoutes(msg));
    const r = await createGmailClient(http).listSince('tok', '100', signal);
    if ('failure' in r) throw new Error('unexpected failure');
    expect(r.messages[0]?.bodyText).toBe('real body');
  });

  it('initialCursor surfaces a thrown HTTP error as MailboxCursorError', async () => {
    const http: MailboxHttp = {
      async request() {
        throw new Error('boom');
      },
    };
    await expect(createGmailClient(http).initialCursor('tok', signal)).rejects.toBeInstanceOf(MailboxCursorError);
  });
});

describe('gmail sendNew (R21: a new message, not a reply)', () => {
  it('posts messages/send with no threadId and no threading headers', async () => {
    const { http, calls } = fake(() => ({ status: 200, body: { id: 'new1' } }));
    const r = await createGmailClient(http).sendNew(
      'tok',
      { to: ['dana@example.com', 'avi@example.org'], subject: 'הצעת מחיר', body: 'שלום' },
      signal,
    );
    expect(r).toEqual({ externalId: 'new1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toMatch(/\/messages\/send$/);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['raw']);
    const raw = Buffer.from(body['raw'] as string, 'base64url').toString('utf8');
    expect(raw).toContain('To: dana@example.com, avi@example.org');
    expect(raw).not.toMatch(/In-Reply-To|References/i);
    const payload = raw.split('\r\n\r\n')[1]!;
    expect(Buffer.from(payload.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('שלום');
    // No draft is ever created.
    expect(calls.some((c) => /drafts/.test(c.url))).toBe(false);
  });

  const ok = { to: ['dana@example.com'], subject: 'x', body: 'b' };
  const cases: Array<[string, Partial<typeof ok>]> = [
    ['to with CRLF', { to: ['a@b.com\r\nBcc: v@y.com'] }],
    ['one of several recipients not an address', { to: ['a@b.com', 'not an address'] }],
    ['no recipients', { to: [] }],
  ];
  for (const [label, patch] of cases) {
    it(`refuses ${label} without any HTTP call`, async () => {
      const { http, calls } = fake(() => ({ status: 200, body: { id: 'x' } }));
      const r = await createGmailClient(http).sendNew('tok', { ...ok, ...patch }, signal);
      expect(r).toMatchObject({ failure: 'rejected' });
      expect(calls).toHaveLength(0);
    });
  }

  it('a subject carrying CR/LF never opens a second header', async () => {
    const { http, calls } = fake(() => ({ status: 200, body: { id: 'x' } }));
    await createGmailClient(http).sendNew('tok', { ...ok, subject: 'hi\r\nBcc: v@y.com' }, signal);
    const raw = Buffer.from((calls[0]?.body as { raw: string }).raw, 'base64url').toString('utf8');
    const headerBlock = raw.split('\r\n\r\n')[0]!;
    expect(headerBlock.split('\r\n').some((l) => /^bcc:/i.test(l))).toBe(false);
  });
});

describe('gmail subject encoding', () => {
  it('a subject carrying CR/LF is encoded into one word, never a second header', async () => {
    const { http, calls } = fake(() => ({ status: 200, body: { id: 'x' } }));
    await createGmailClient(http).sendReply(
      'tok',
      { to: ['a@b.com'], subject: 'hi\r\nBcc: v@y.com', body: 'b', inReplyTo: '<x>', references: null, threadId: 't', providerMessageId: 'm' },
      signal,
    );
    const raw = Buffer.from((calls[0]?.body as { raw: string }).raw, 'base64url').toString('utf8');
    const headerBlock = raw.split('\r\n\r\n')[0]!;
    expect(headerBlock.split('\r\n').some((l) => /^bcc:/i.test(l))).toBe(false);
  });
});
