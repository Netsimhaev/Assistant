import { describe, expect, it } from 'vitest';
import { createSmtpTransport } from './transport.js';
import type { SmtpConfig } from './transport.js';
import { createCredentialHandle } from '../orchestrator/adapters/types.js';
import type { AdapterCall } from '../orchestrator/adapters/types.js';
import { createMailAdapter } from '../orchestrator/adapters/mail.js';
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
    // A bare `rejects.toThrow()` here used to pass either way: delete the
    // pre-connection check in `send` and `raceAbort` rejects too, one layer
    // later — but only *after* `createTransport` has already been called,
    // which for the module-level `transport` above means really dialing
    // `smtp.invalid.example:587`, the exact thing this file's own comment
    // promises no test does. So this asserts both halves the way the
    // empty-credential test below does: the message that names the
    // pre-connection refusal, and that nothing was opened.
    let opened = false;
    const transport = createSmtpTransport(
      configWithoutAuth({ createTransport: () => { opened = true; return fakeTransporter(); } }),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.send(
        { to: ['a@b.com'], subject: 'נושא נקי', body: 'גוף' },
        aContext({ signal: controller.signal }),
      ),
    ).rejects.toThrow(/לפני שהחיבור נפתח/);
    expect(opened).toBe(false);
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
    // Round-2 finding: this test could not fail. It rejected with a bare
    // `new Error('535 …')`, so the secret was never in `message`, never in
    // `command`, never anywhere reachable — and `String(err)` is a projection
    // that drops own properties anyway (see the next test's comment). It
    // stayed green with the rethrow reverted to `throw error;`.
    //
    // Now the rejected error *carries* the secret, in the two fields a real
    // SMTP client puts server- and command-derived text in: `response` (the
    // relay's own reply, which nodemailer also folds into `message`) and
    // `command`. The assertions are on the thrown object's own properties.
    const secret = 'סוד-שאסור-לו-להופיע';
    const hostile = Object.assign(new Error('535 Authentication credentials invalid'), {
      response: `535 rejected auth for assistant with ${secret}`,
      command: `AUTH PLAIN ${secret}`,
    });
    // The positive half, first and explicitly: the value really is in the
    // input this rethrow is handed. Without this the assertions below would
    // hold for a fake that carried nothing at all — the exact vacuity that
    // put this test on the fix list.
    expect(hostile.response).toContain(secret);
    expect(hostile.command).toContain(secret);

    const transport = createSmtpTransport(configWithoutAuth({ createTransport: () => ({
      sendMail: () => Promise.reject(hostile),
    }) }));
    const err = await transport
      .send(aMessage(), aContext({ credential: createCredentialHandle('OFFICE_MAIL', secret) }))
      .catch((e: unknown) => e);

    // What an operator needs survives.
    expect((err as Error).message).toContain('535');
    // What the far end wrote does not: `response` is not carried at all, and
    // `command` is carried only when it equals the one sentinel the
    // classifier reads — so a command field stuffed with a credential is
    // dropped rather than sanitised.
    expect((err as { response?: unknown }).response).toBeUndefined();
    expect((err as { command?: unknown }).command).toBeUndefined();
    // Nothing that did survive contains it — message and every own property.
    for (const value of [(err as Error).message, ...Object.values(err as object)]) {
      expect(String(value)).not.toContain(secret);
    }
    // And the handle itself must not serialise the value into anything.
    expect(JSON.stringify({ c: createCredentialHandle('OFFICE_MAIL', secret) })).not.toContain(secret);
  });

  it('carries only DATA as the command, never another command label', async () => {
    // The narrowing above must not be a scrub of one bad value: a perfectly
    // ordinary `AUTH PLAIN` is dropped too, because the classifier compares
    // `command` against `'DATA'` and nothing else. Positive selection of the
    // one value that is read, not a blocklist of the ones that are dangerous.
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: () => ({
      sendMail: () => Promise.reject(Object.assign(new Error('535 bad login'), { command: 'AUTH PLAIN' })),
    }) }));
    const err = await transport.send(aMessage(), aContext()).catch((e: unknown) => e);
    expect((err as Error).message).toContain('535');
    expect((err as { command?: unknown }).command).toBeUndefined();
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

  it('carries exactly the three classification fields off a failed send, and nothing else', async () => {
    // This used to assert `Object.keys(err)` was empty — and that was the
    // defect, not the guarantee. `classifyTransportFailure`
    // (`src/orchestrator/adapters/mail.ts`) reads `responseCode`, `command`
    // and `code`; with all three stripped, every real SMTP failure fell to
    // its last branch and a *refused connection* was recorded as
    // `delivery_unknown` — an outcome nobody can determine. So the assertion
    // is now the allowlist stated exactly: these three, no more.
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: () => ({
      sendMail: () => Promise.reject(Object.assign(new Error('450 mailbox busy'), {
        responseCode: 450,
        command: 'DATA',
        code: 'EENVELOPE',
        // Everything below is what must NOT survive.
        response: '450 mailbox busy, try later',
        stage: 'after-data',
        cert: { subject: 'whatever' },
      })),
    }) }));
    const err = await transport.send(aMessage(), aContext()).catch((e: unknown) => e);

    // The positive half: the message an operator actually needs survives.
    expect((err as Error).message).toContain('450');
    // Checked against the thrown object rather than its stringified form:
    // `String(Object.assign(new Error('x'), { command: 'y' }))` is
    // `"Error: x"` either way, so a string assertion here could never go red.
    expect(Object.keys(err as object).sort()).toEqual(['code', 'command', 'responseCode']);
    expect(err).toMatchObject({ responseCode: 450, command: 'DATA', code: 'EENVELOPE' });
  });

  it('omits a field the failure did not carry rather than inventing one', async () => {
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: () => ({
      sendMail: () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    }) }));
    const err = await transport.send(aMessage(), aContext()).catch((e: unknown) => e);
    expect(Object.keys(err as object)).toEqual(['code']);
  });

  it('ignores a classification field reachable only through the prototype', async () => {
    // `command: 'DATA'` means "the body may already have left this process",
    // which turns a retryable failure into a terminal one. An inherited
    // property is not something the far end said, so it is not read — the
    // same `Object.hasOwn` discipline `readRecipients` and `SDK_TO_INTERNAL`
    // already hold to.
    const inherited = Object.create({ command: 'DATA', code: 'ECONNREFUSED' }) as Record<string, unknown>;
    const error = new Error('socket hang up');
    Object.setPrototypeOf(error, Object.getPrototypeOf(inherited) as object);
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: () => ({
      sendMail: () => Promise.reject(error),
    }) }));
    const err = await transport.send(aMessage(), aContext()).catch((e: unknown) => e);
    expect(Object.keys(err as object)).toEqual([]);
  });
});

/**
 * The gap that let the stripped-fields defect ship: every test of
 * `classifyTransportFailure` drives it with a hand-built
 * `Object.assign(new Error(…), { responseCode })` and none of them goes
 * through `createSmtpTransport`. These two compose the real transport with the
 * real adapter, so the rethrow above and the classifier are measured together.
 */
describe('a real transport failure, classified through the real adapter', () => {
  function adapterOver(rejection: unknown) {
    return createMailAdapter({
      system: 'office-mail',
      transport: createSmtpTransport(configWithoutAuth({ createTransport: () => ({
        sendMail: () => Promise.reject(rejection),
      }) })),
    });
  }

  const mailCall: AdapterCall = {
    toolName: 'mail.send',
    input: { to: 'a@b.com', subject: 's', body: 'b' },
    credential: createCredentialHandle('OFFICE_MAIL', 'pw'),
    endpoint: null,
    idempotencyKey: 'test-idempotency-key',
    signal: new AbortController().signal,
  };

  it('reports a refused connection as retryable, not as an undeterminable outcome', async () => {
    // Nothing was accepted, so nothing can be duplicated, and the step is
    // meant to come back in five minutes. Before the rethrow carried `code`,
    // this was `{ retryable: false, code: 'delivery_unknown' }`: the job
    // failed terminally, and the audit trail claimed an ambiguity that
    // provably did not exist.
    const result = await adapterOver(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), { code: 'ECONNREFUSED' }),
    ).execute(mailCall);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.retryable).toBe(true);
    expect(result.code).toBe('transport_error');
  });

  it('reports a 421 from the relay as retryable', async () => {
    const result = await adapterOver(
      Object.assign(new Error('421 too many connections'), { responseCode: 421, code: 'EENVELOPE' }),
    ).execute(mailCall);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.retryable).toBe(true);
    expect(result.code).toBe('transport_error');
  });

  it('still reports a failure mid-DATA as ambiguous, which is what carrying `command` buys', async () => {
    // The one case where carrying `command` changes the answer: with `code`
    // alone this reads as a transient socket error and gets retried, which
    // for a message the relay may already hold is a duplicate send.
    const result = await adapterOver(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', command: 'DATA' }),
    ).execute(mailCall);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.retryable).toBe(false);
    expect(result.code).toBe('delivery_unknown');
  });
});

describe('TLS is not optional', () => {
  function captureOptions(over: Partial<SmtpConfig> = {}): Record<string, unknown>[] {
    const captured: Record<string, unknown>[] = [];
    const transport = createSmtpTransport(configWithoutAuth({
      ...over,
      createTransport: (opts) => {
        captured.push(opts as unknown as Record<string, unknown>);
        return fakeTransporter();
      },
    }));
    void transport.send(aMessage(), aContext());
    return captured;
  }

  it('requires STARTTLS whenever the session is not already implicit TLS', async () => {
    const captured = captureOptions({ secure: false });
    await Promise.resolve();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.['requireTLS']).toBe(true);
  });

  it('does not ask for STARTTLS on an implicit-TLS session', async () => {
    const captured = captureOptions({ secure: true });
    await Promise.resolve();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.['requireTLS']).toBe(false);
  });

  it('drops the requirement only when a caller explicitly allows cleartext', async () => {
    const captured = captureOptions({ secure: false, allowCleartext: true });
    await Promise.resolve();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.['requireTLS']).toBe(false);
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
