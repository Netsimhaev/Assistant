import { describe, expect, it } from 'vitest';
import { createSmtpTransport } from './transport.js';
import type { SmtpConfig } from './transport.js';
import { createCredentialHandle } from '../orchestrator/adapters/types.js';
import type { MailMessage, MailSendContext } from '../orchestrator/adapters/mail.js';

function aContext(over: Partial<MailSendContext> = {}): MailSendContext {
  return {
    endpoint: null,
    credential: createCredentialHandle('K', 'pw'),
    idempotencyKey: 'test-idempotency-key',
    signal: new AbortController().signal,
    ...over,
  };
}

function aMessage(): MailMessage {
  return { to: ['a@b.com'], subject: 'נושא נקי', body: 'גוף' };
}

/** The minimal `{ sendMail }` shape every fake transporter in this file needs. */
function fakeTransporter(): { sendMail: () => Promise<{ messageId: string }> } {
  return { sendMail: () => Promise.resolve({ messageId: 'stub-message-id' }) };
}

/**
 * `SmtpConfig` without `auth` — there is no such field any more. Defined once
 * so every test constructs a valid config and the compiler catches every
 * construction site the shape change affects, per the account this module's
 * own docblock keeps.
 */
function configWithoutAuth(over: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: 'smtp.invalid.example',
    port: 587,
    secure: false,
    from: 'assistant@example.com',
    user: 'assistant',
    ...over,
  };
}

// The host below is never actually dialed by any test in this file: every
// case here is rejected by validation that runs before `createSmtpTransport`
// ever calls out to `nodemailer.createTransport`, so nothing here attempts a
// real connection.
const transport = createSmtpTransport(configWithoutAuth());

describe('createSmtpTransport', () => {
  it('rejects a CRLF-injected subject before opening any connection', async () => {
    await expect(
      transport.send(
        { to: ['a@b.com'], subject: 'שלום\r\nBcc: attacker@evil.com', body: 'גוף' },
        aContext(),
      ),
    ).rejects.toThrow(/CR\/LF|שורה חדשה/);
  });

  it('rejects a bare-LF-injected subject the same way as a full CRLF', async () => {
    await expect(
      transport.send(
        { to: ['a@b.com'], subject: 'שלום\nBcc: attacker@evil.com', body: 'גוף' },
        aContext(),
      ),
    ).rejects.toThrow(/CR\/LF|שורה חדשה/);
  });

  it('rejects a CRLF-injected recipient before opening any connection', async () => {
    await expect(
      transport.send(
        { to: ['a@b.com\r\nBcc:attacker@evil.com'], subject: 'נושא', body: 'גוף' },
        aContext(),
      ),
    ).rejects.toThrow(/CR\/LF|שורה חדשה/);
  });

  it('checks every recipient, not just the first', async () => {
    await expect(
      transport.send(
        { to: ['clean@b.com', 'also-clean@c.com', 'x\r\ny@d.com'], subject: 'נושא', body: 'גוף' },
        aContext(),
      ),
    ).rejects.toThrow(/CR\/LF|שורה חדשה/);
  });

  it('refuses to send once the caller already gave up (an aborted signal)', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.send(
        { to: ['a@b.com'], subject: 'נושא נקי', body: 'גוף' },
        aContext({ signal: controller.signal }),
      ),
    ).rejects.toThrow();
  });

  it('authenticates with the credential handed to this send, not with anything the transport holds', async () => {
    // The positive half first: without this, the negative assertions below
    // would pass on a transport that authenticated with nothing at all.
    const captured: Array<{ user?: string; pass?: string }> = [];
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: (opts) => {
      captured.push(opts.auth);
      return fakeTransporter();
    } }));
    await transport.send(aMessage(), aContext({ credential: createCredentialHandle('OFFICE_MAIL', 'סוד-אמיתי-1') }));
    expect(captured[0]?.pass).toBe('סוד-אמיתי-1');
    expect(captured[0]?.user).toBe(configWithoutAuth().user);
  });

  it('uses the second send\'s credential, not the first — nothing is cached', async () => {
    const captured: string[] = [];
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: (opts) => {
      captured.push(opts.auth.pass);
      return fakeTransporter();
    } }));
    await transport.send(aMessage(), aContext({ credential: createCredentialHandle('A', 'ראשון') }));
    await transport.send(aMessage(), aContext({ credential: createCredentialHandle('A', 'שני') }));
    expect(captured).toEqual(['ראשון', 'שני']);
  });

  it('refuses a send whose credential carries an empty value, before opening a socket', async () => {
    let opened = false;
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: () => { opened = true; return fakeTransporter(); } }));
    await expect(
      transport.send(aMessage(), aContext({ credential: createCredentialHandle('OFFICE_MAIL', '') })),
    ).rejects.toThrow(/credential/i);
    // The point of refusing early: an empty password is not an anonymous
    // send, it is a misconfiguration, and it must cost nothing external.
    expect(opened).toBe(false);
  });

  it('keeps the secret out of the error a failed authentication produces', async () => {
    const secret = 'סוד-שאסור-לו-להופיע';
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: () => ({
      sendMail: () => Promise.reject(new Error('535 Authentication credentials invalid')),
    }) }));
    const err = await transport
      .send(aMessage(), aContext({ credential: createCredentialHandle('OFFICE_MAIL', secret) }))
      .catch((e: unknown) => e);
    expect(String(err)).toContain('535');
    expect(String(err)).not.toContain(secret);
    // And the handle itself must not serialise the value into anything.
    expect(JSON.stringify({ c: createCredentialHandle('OFFICE_MAIL', secret) })).not.toContain(secret);
  });

  it('never enables nodemailer\'s debug or logger options', async () => {
    // Both print the SMTP dialogue, and the AUTH exchange is inside it.
    const captured: Array<Record<string, unknown>> = [];
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: (opts) => {
      captured.push(opts as unknown as Record<string, unknown>);
      return fakeTransporter();
    } }));
    await transport.send(aMessage(), aContext());
    // The positive half first: without this, an aborted or otherwise
    // short-circuited send that never reaches `createTransport` at all would
    // leave `captured` empty and pass the two assertions below vacuously.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.['debug']).toBeUndefined();
    expect(captured[0]?.['logger']).toBeUndefined();
  });

  it('drops a failed send\'s extra fields, keeping only the message', async () => {
    const sentinel = 'SENTINEL-COMMAND-AUTH-LOGIN';
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: () => ({
      sendMail: () => {
        const error = new Error('535 Authentication credentials invalid') as Error & { command?: string };
        error.command = sentinel;
        return Promise.reject(error);
      },
    }) }));
    const err = await transport.send(aMessage(), aContext()).catch((e: unknown) => e);
    // The positive half first: the message — what an operator actually
    // needs — must survive the rethrow.
    expect((err as Error).message).toContain('535');
    // Then the negative, checked against the thrown object itself rather
    // than its stringified form: `String(Object.assign(new Error('x'), {
    // command: 'y' }))` is `"Error: x"` regardless of whether `command`
    // survived, so a string assertion here could never go red. `command`
    // (which can itself be the AUTH line) must not be an own property of
    // what was thrown, and neither must anything else the library attached
    // — the point is that nothing survives, not just this one field.
    expect((err as { command?: unknown }).command).toBeUndefined();
    expect(Object.keys(err as object)).toEqual([]);
  });
});

describe('createSmtpTransport construction', () => {
  // Round 1 finding: an omitted `auth` used to fall back to a per-call
  // credential the notifier never actually supplies, so a misconfigured
  // deployment authenticated with an empty string only once a real SMTP
  // server rejected it — deep inside a send the gate was already waiting
  // on. The username is still validated here, at construction; the password
  // is no longer part of this config at all (see the next describe block's
  // "refuses a send whose credential carries an empty value" test above),
  // so only the username check remains here.
  it('refuses to build a transport with an empty username', () => {
    expect(() =>
      createSmtpTransport(configWithoutAuth({ user: '' })),
    ).toThrow(/user/i);
  });

  it('builds successfully with a non-empty account', () => {
    expect(() => createSmtpTransport(configWithoutAuth())).not.toThrow();
  });
});
