import { describe, expect, it } from 'vitest';
import { createSmtpTransport } from './transport.js';
import { createCredentialHandle } from '../orchestrator/adapters/types.js';
import type { MailSendContext } from '../orchestrator/adapters/mail.js';

function context(over: Partial<MailSendContext> = {}): MailSendContext {
  return {
    endpoint: null,
    credential: createCredentialHandle('K', 'pw'),
    idempotencyKey: 'test-idempotency-key',
    signal: new AbortController().signal,
    ...over,
  };
}

// The host below is never actually dialed by any test in this file: every
// case here is rejected by validation that runs before `createSmtpTransport`
// ever calls out to `nodemailer.createTransport`, so nothing here attempts a
// real connection.
const transport = createSmtpTransport({
  host: 'smtp.invalid.example',
  port: 587,
  secure: false,
  from: 'assistant@example.com',
});

describe('createSmtpTransport', () => {
  it('rejects a CRLF-injected subject before opening any connection', async () => {
    await expect(
      transport.send(
        { to: ['a@b.com'], subject: 'שלום\r\nBcc: attacker@evil.com', body: 'גוף' },
        context(),
      ),
    ).rejects.toThrow(/CR\/LF|שורה חדשה/);
  });

  it('rejects a bare-LF-injected subject the same way as a full CRLF', async () => {
    await expect(
      transport.send(
        { to: ['a@b.com'], subject: 'שלום\nBcc: attacker@evil.com', body: 'גוף' },
        context(),
      ),
    ).rejects.toThrow(/CR\/LF|שורה חדשה/);
  });

  it('rejects a CRLF-injected recipient before opening any connection', async () => {
    await expect(
      transport.send(
        { to: ['a@b.com\r\nBcc:attacker@evil.com'], subject: 'נושא', body: 'גוף' },
        context(),
      ),
    ).rejects.toThrow(/CR\/LF|שורה חדשה/);
  });

  it('checks every recipient, not just the first', async () => {
    await expect(
      transport.send(
        { to: ['clean@b.com', 'also-clean@c.com', 'x\r\ny@d.com'], subject: 'נושא', body: 'גוף' },
        context(),
      ),
    ).rejects.toThrow(/CR\/LF|שורה חדשה/);
  });

  it('refuses to send once the caller already gave up (an aborted signal)', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.send(
        { to: ['a@b.com'], subject: 'נושא נקי', body: 'גוף' },
        context({ signal: controller.signal }),
      ),
    ).rejects.toThrow();
  });
});
