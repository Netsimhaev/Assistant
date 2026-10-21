import { describe, expect, it } from 'vitest';
import { createGmailClient } from './gmail.js';
import type { MailboxHttp } from './types.js';

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
    expect(await c.addLabel('tok', 'm', 'x', 'y', signal)).toMatchObject({ failure: 'auth' });
    const net = fake(() => ({ status: 0, body: null }));
    expect(await createGmailClient(net.http).ensureLabels('tok', ['a'], signal)).toMatchObject({ failure: 'transient' });
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
});
