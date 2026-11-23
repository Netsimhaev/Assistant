import { describe, expect, it } from 'vitest';
import { createFakeGateway } from '../../whatsapp/fake-gateway.js';
import type { WhatsAppGateway } from '../../whatsapp/gateway.js';
import { createWhatsAppContactsAdapter } from './whatsapp-contacts.js';
import type { AdapterCall } from './types.js';

function call(input: unknown, extra: Partial<AdapterCall> = {}): AdapterCall {
  return {
    toolName: 'wa.send_message',
    input,
    credential: null,
    endpoint: null,
    businessId: 'biz-1',
    idempotencyKey: 'idem-1',
    attachments: [],
    signal: new AbortController().signal,
    ...extra,
  };
}

function setup(opts: { number?: string | null; gateway?: WhatsAppGateway } = {}) {
  const gateway = opts.gateway ?? createFakeGateway();
  const recorded: unknown[] = [];
  const adapter = createWhatsAppContactsAdapter({
    gateway,
    conversationNumber: async () => (opts.number === undefined ? '972501234567' : opts.number),
    recordOutbound: async (b, i) => {
      recorded.push({ b, i });
    },
  });
  return { gateway, adapter, recorded };
}

describe('whatsapp-contacts adapter', () => {
  it('sends text to the digits key and records it', async () => {
    const fake = createFakeGateway();
    const { adapter, recorded } = setup({ gateway: fake });
    const r = await adapter.execute(call({ to: '+972 50-123-4567', body: 'שלום' }));
    expect(r.ok).toBe(true);
    expect(fake.sent).toEqual([{ contactId: '972501234567', body: 'שלום', idempotencyKey: 'idem-1' }]);
    expect(recorded).toHaveLength(1);
  });

  it('refuses a bad recipient', async () => {
    const { adapter, gateway } = setup();
    const r = await adapter.execute(call({ to: '0501234567', body: 'x' }));
    expect(r).toMatchObject({ ok: false, code: 'bad_recipient', retryable: false });
    expect((gateway as ReturnType<typeof createFakeGateway>).sent).toHaveLength(0);
  });

  it('refuses a reply whose conversation belongs to another number', async () => {
    const { adapter } = setup({ number: '972509999999' });
    const r = await adapter.execute(call({ to: '+972501234567', body: 'x', conversationId: 'C1' }));
    expect(r).toMatchObject({ ok: false, code: 'reply_recipient_mismatch' });
  });

  it('refuses a reply to an unknown conversation', async () => {
    const { adapter } = setup({ number: null });
    const r = await adapter.execute(call({ to: '+972501234567', body: 'x', conversationId: 'C1' }));
    expect(r).toMatchObject({ ok: false, code: 'reply_recipient_mismatch' });
  });

  it('accepts a matching conversation', async () => {
    const { adapter } = setup();
    expect((await adapter.execute(call({ to: '+972501234567', body: 'x', conversationId: 'C1' }))).ok).toBe(true);
  });

  it('refuses an attachment that was not resolved', async () => {
    const { adapter } = setup();
    const r = await adapter.execute(call({ to: '+972501234567', body: 'x', attachDocumentId: 'D1' }));
    expect(r).toMatchObject({ ok: false, code: 'attachment_missing' });
  });

  it('sends a file with the body as caption', async () => {
    const fake = createFakeGateway();
    const files: unknown[] = [];
    const gateway: WhatsAppGateway = {
      ...fake,
      sendFile: async (i) => {
        files.push(i);
        return { messageId: 'M', state: 'sent' };
      },
    };
    const { adapter } = setup({ gateway });
    const r = await adapter.execute(
      call(
        { to: '+972501234567', body: 'הנה', attachDocumentId: 'D1' },
        { attachments: [{ documentId: 'D1', filename: 'a.pdf', mediaType: 'application/pdf', bytes: Buffer.from('x') }] },
      ),
    );
    expect(r.ok).toBe(true);
    expect(files).toMatchObject([{ contactId: '972501234567', caption: 'הנה', filename: 'a.pdf' }]);
  });

  it('refuses an attachment whose document id is not the one named', async () => {
    const { adapter } = setup();
    const r = await adapter.execute(
      call(
        { to: '+972501234567', body: 'x', attachDocumentId: 'D1' },
        { attachments: [{ documentId: 'D2', filename: 'a.pdf', mediaType: 'application/pdf', bytes: Buffer.from('x') }] },
      ),
    );
    expect(r).toMatchObject({ ok: false, code: 'attachment_missing' });
  });

  it('refuses an attachment present when none was named', async () => {
    const { adapter } = setup();
    const r = await adapter.execute(
      call({ to: '+972501234567', body: 'x' }, { attachments: [{ documentId: 'D1', filename: 'a.pdf', mediaType: 'application/pdf', bytes: Buffer.from('x') }] }),
    );
    expect(r).toMatchObject({ ok: false, code: 'attachment_missing' });
  });

  it('maps a rejected send to whatsapp_rejected, not retryable', async () => {
    const fake = createFakeGateway();
    fake.failNextSend();
    const { adapter } = setup({ gateway: fake });
    expect(await adapter.execute(call({ to: '+972501234567', body: 'x' }))).toMatchObject({
      ok: false,
      code: 'whatsapp_rejected',
      retryable: false,
    });
  });

  it('thrown gateway error is delivery_unknown and not retryable', async () => {
    const fake = createFakeGateway();
    fake.throwNextSend();
    const { adapter } = setup({ gateway: fake });
    expect(await adapter.execute(call({ to: '+972501234567', body: 'x' }))).toMatchObject({
      ok: false,
      code: 'delivery_unknown',
      retryable: false,
    });
  });
});
