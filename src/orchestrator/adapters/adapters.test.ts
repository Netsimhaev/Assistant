import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from './registry.js';
import { browserAdapter } from './browser.js';
import { assertAdapterContract, NON_COMMITTING_SAMPLE_TOOLS } from './contract.js';
import type { AdapterCall, AdapterResult, CredentialHandle, ExternalAdapter } from './types.js';
import { createCredentialHandle } from './types.js';
import { classifiedToolNames, READ_ONLY_TOOLS } from '../../policy/classify.js';
import { canonicalJson } from '../../util/canonical.js';
import { envCredentials } from '../credentials.js';
import { createMailAdapter, readRecipients, type MailTransport } from './mail.js';
import { readEmails } from '../../policy/facts.js';
import { REDACTED } from '../../policy/redact.js';

function call(over: Partial<AdapterCall> = {}): AdapterCall {
  return {
    // A read that never commits anything: `assertAdapterContract` executes
    // this call for real, and once a real driver backs an adapter, a sample
    // that places an order would place a real order on every test run.
    toolName: 'browser.navigate',
    input: { supplierId: 'supplier-a' },
    credential: null,
    idempotencyKey: 'test-idempotency-key',
    signal: new AbortController().signal,
    ...over,
  };
}

/** A stand-in for a real vendor API adapter, used only to exercise the registry. */
function apiAdapter(system: string, serves: readonly string[] = ['x']): ExternalAdapter {
  return {
    system,
    channel: 'api',
    serves,
    async execute(): Promise<AdapterResult> {
      return { ok: true, output: null, externalId: null };
    },
  };
}

describe('the adapter registry', () => {
  it('returns null for a system nothing implements', () => {
    expect(new AdapterRegistry([]).get('ghost')).toBeNull();
  });

  it('finds a system-specific adapter by system', () => {
    const registry = new AdapterRegistry([browserAdapter]);
    expect(registry.get('browser')?.channel).toBe('browser');
  });

  it('refuses to register two adapters for one system', () => {
    // Silently keeping one of them would make which adapter runs depend on
    // registration order.
    expect(() => new AdapterRegistry([browserAdapter, browserAdapter])).toThrow(
      /already registered/,
    );
  });

  it('refuses to register two default adapters for one channel', () => {
    expect(
      () => new AdapterRegistry([], [browserAdapter, { ...browserAdapter, system: 'other' }]),
    ).toThrow(/already registered/);
  });

  describe('resolve: system-specific, channel-checked, tool-checked', () => {
    it('falls back to the channel default when no system-specific adapter is registered', () => {
      // resolveChannel emits the charter's per-vendor system id, never the
      // literal string 'browser', so a connection named supplier-a-portal
      // with no adapter of its own must still reach the browser placeholder.
      const registry = new AdapterRegistry([], [browserAdapter]);
      expect(registry.resolve('supplier-a-portal', 'browser', 'browser.navigate')).toBe(
        browserAdapter,
      );
    });

    it('prefers a system-specific adapter over the channel default', () => {
      const specific = apiAdapter('supplier-a-api', ['x']);
      const registry = new AdapterRegistry([specific], [browserAdapter]);
      expect(registry.resolve('supplier-a-api', 'api', 'x')).toBe(specific);
    });

    it('returns null when neither a system-specific nor a channel-default adapter exists', () => {
      const registry = new AdapterRegistry([]);
      expect(registry.resolve('ghost', 'api', 'x')).toBeNull();
    });

    // A channel default is registered for the *signed* channel in both of
    // the next two tests, and it serves the same tool the system-specific
    // adapter does. That makes the two possible implementations
    // distinguishable: a real refusal returns null regardless, while a
    // lookup that merely falls through when the system-specific adapter
    // does not match would instead return that channel default. Registering
    // an *empty* channelDefaults list here would make both implementations
    // produce null, so the test would pass whether or not the refusal
    // actually runs -- which is exactly what happened in the previous round.
    it('refuses a mismatched system-specific adapter rather than falling through to a same-channel default (adapter is browser, charter signed api)', () => {
      const apiChannelDefault = apiAdapter('api-fallback', ['browser.navigate']);
      const registry = new AdapterRegistry([browserAdapter], [apiChannelDefault]);
      expect(registry.resolve('browser', 'api', 'browser.navigate')).toBeNull();
    });

    it('refuses a mismatched system-specific adapter rather than falling through to a same-channel default (adapter is api, charter signed browser)', () => {
      const specific = apiAdapter('office-mail', ['browser.navigate']);
      const registry = new AdapterRegistry([specific], [browserAdapter]);
      expect(registry.resolve('office-mail', 'browser', 'browser.navigate')).toBeNull();
    });

    // The channel default must not become a catch-all for every tool signed
    // onto that channel.
    it('refuses the channel default for a tool it does not serve, even on the right channel', () => {
      const registry = new AdapterRegistry([], [browserAdapter]);
      expect(registry.resolve('supplier-a-portal', 'browser', 'mail.send')).toBeNull();
    });

    // The sibling of the channel-default serves check above, and it needs the
    // same construction as the two mismatch tests: a same-channel default
    // that *does* serve the tool. Without one, a `resolve` that merely falls
    // through when the system-specific adapter's `serves` excludes the tool
    // (`if (specific.serves.includes(toolName)) return specific;`, no
    // explicit refusal) would reach an empty channelDefaults map and return
    // null anyway, so the test would pass whether or not the refusal exists.
    // Falling through is the dangerous behaviour here, not a harmless
    // simplification: it hands a connection that has its own adapter over to
    // the channel default, which is a different channel-level decision than
    // the one the owner signed.
    it('refuses a system-specific adapter for a tool it does not serve, even on the right channel', () => {
      const specific = apiAdapter('office-mail', ['mail.send']);
      const apiChannelDefault = apiAdapter('api-fallback', ['crm.write']);
      const registry = new AdapterRegistry([specific], [apiChannelDefault]);
      expect(registry.resolve('office-mail', 'api', 'crm.write')).toBeNull();
    });
  });

  it('lists channel defaults distinguishably from systems', () => {
    // A readiness check built on systems() must be able to tell "this
    // channel has a default driver" apart from "this is a charter system
    // id" -- and must see the default at all, not report zero adapters for
    // a registry that holds nothing else.
    const registry = new AdapterRegistry([apiAdapter('office-mail')], [browserAdapter]);
    expect(registry.systems()).toEqual(['office-mail', 'channel:browser']);
  });
});

describe('the browser adapter placeholder', () => {
  it('reports that it is not implemented rather than pretending', async () => {
    const result = await browserAdapter.execute(call());
    expect(result).toEqual({
      ok: false,
      retryable: false,
      code: 'browser_not_implemented',
      message: expect.any(String),
    });
  });

  it('passes the shared adapter contract', async () => {
    await assertAdapterContract(browserAdapter, call());
  });

  it('serves exactly the browser.-prefixed tools the policy layer knows about, plus credential.request_session', () => {
    // Derived from classify.ts rather than hand-copied, so a new browser.
    // tool that forgets to update browserAdapter.serves fails this test
    // instead of surfacing later as a confusing "no adapter" error.
    const allKnownTools = [...classifiedToolNames(), ...READ_ONLY_TOOLS];
    const expected = allKnownTools
      .filter((name) => name.startsWith('browser.') || name === 'credential.request_session')
      .sort();

    expect([...browserAdapter.serves].sort()).toEqual(expected);
  });
});

describe('assertAdapterContract requires a non-committing sample by default', () => {
  it('rejects a committing sample by default', async () => {
    const committing = call({
      toolName: 'browser.submit_order',
      input: { supplierId: 'supplier-a', amountMinor: 1000 },
    });
    await expect(assertAdapterContract(browserAdapter, committing)).rejects.toThrow();
  });

  it('allows a committing sample only when explicitly acknowledged, against a test double', async () => {
    const double: ExternalAdapter = {
      system: 'test-double',
      channel: 'api',
      serves: ['browser.submit_order'],
      async execute(): Promise<AdapterResult> {
        return { ok: true, output: null, externalId: 'not-a-real-order' };
      },
    };
    const committing = call({
      toolName: 'browser.submit_order',
      input: { supplierId: 'supplier-a', amountMinor: 1000 },
    });
    await expect(
      assertAdapterContract(double, committing, { allowCommittingSample: true }),
    ).resolves.toBeUndefined();
  });

  it('rejects media.generate_video as a sample even though it is not a classified, gated action', async () => {
    // media.generate_video sits in READ_ONLY_TOOLS (it bypasses the policy
    // gate) but generates real content and costs real money -- exactly the
    // tool that a `classifyAction(toolName) === null` check would have
    // waved through as "safe". It must never appear in
    // NON_COMMITTING_SAMPLE_TOOLS, and this suite must refuse it by default.
    const double: ExternalAdapter = {
      system: 'test-double-media',
      channel: 'api',
      serves: ['media.generate_video'],
      async execute(): Promise<AdapterResult> {
        return { ok: true, output: null, externalId: null };
      },
    };
    const committing = call({ toolName: 'media.generate_video', input: {} });
    await expect(assertAdapterContract(double, committing)).rejects.toThrow();
  });
});

describe('NON_COMMITTING_SAMPLE_TOOLS is pinned, not merely read-only', () => {
  it('holds exactly the three tools this suite has been reviewed to execute for real', () => {
    // The safety of this list cannot be derived from anything in classify.ts,
    // and pretending otherwise is the mistake `contract.ts`'s own docblock
    // warns about: READ_ONLY_TOOLS means "skips the policy gate", not
    // "harmless to run" — it knowingly holds media.generate_image and
    // media.generate_video, which cost real money every time they run. So a
    // check of the form "every member is read-only" would happily accept
    // media.generate_image being ADDED here, and the contract suite would
    // then generate a paid image on every `npm test`.
    //
    // Pinning the exact set is the only honest formulation: membership is a
    // human judgement about a specific tool, so adding one must be a
    // deliberate edit in two files rather than a one-line change nothing
    // notices. Extend both together, and only after deciding that running
    // the tool for real, repeatedly, against a live driver, is acceptable.
    expect([...NON_COMMITTING_SAMPLE_TOOLS].sort()).toEqual([
      'browser.navigate',
      'browser.screenshot',
      'browser.snapshot',
    ]);
  });

  it('names no tool that classify.ts has since reclassified as committing', () => {
    // A different mistake from the one above, and the pin does not catch it:
    // a tool can stay spelled the same here while its meaning changes over
    // there. browser.click and file.write both moved from READ_ONLY_TOOLS
    // into TOOL_ACTION_CLASS after the fact; had either been a sample tool,
    // it would have kept running for real. This fails in the same change
    // that reclassifies it.
    const classified = classifiedToolNames();
    for (const toolName of NON_COMMITTING_SAMPLE_TOOLS) {
      expect(
        classified,
        `${toolName} is now a classified, committing action and must leave ` +
          'NON_COMMITTING_SAMPLE_TOOLS',
      ).not.toContain(toolName);
      // Read-only membership is a staleness check — it catches a typo or a
      // tool deleted from classify.ts entirely. It is NOT the safety
      // argument; the pin above is. Read-only does not imply safe to run.
      expect(
        READ_ONLY_TOOLS.has(toolName),
        `${toolName} is not a known read-only tool in classify.ts — either the ` +
          'name is stale or the tool changed meaning',
      ).toBe(true);
    }
  });
});

describe('createCredentialHandle', () => {
  it('keeps the secret out of canonicalJson', () => {
    const handle = createCredentialHandle('ref-1', 'super-secret-value');
    const serialised = canonicalJson({ credential: handle });
    expect(serialised).toContain('ref-1');
    expect(serialised).not.toContain('super-secret-value');
  });

  it('still lets an adapter read the secret directly', () => {
    const handle = createCredentialHandle('ref-1', 'super-secret-value');
    expect(handle.value).toBe('super-secret-value');
  });
});

describe('CredentialHandle is branded, not just conventionally built', () => {
  it('rejects a hand-built literal at compile time', () => {
    // @ts-expect-error a plain { ref, value, toJSON } literal is missing the
    // private brand and must not satisfy CredentialHandle -- only
    // createCredentialHandle can produce one. If this ever stops being a
    // type error, the unused @ts-expect-error directive fails
    // `tsc --noEmit`, which is the proof this test relies on; the runtime
    // assertion below only keeps the binding used.
    const illTyped: CredentialHandle = {
      ref: 'r',
      value: 'v',
      toJSON: () => ({}),
    };
    expect(illTyped.ref).toBe('r');
  });

  it('accepts the factory output as a real CredentialHandle', () => {
    const handle: CredentialHandle = createCredentialHandle('ref-1', 'secret');
    expect(handle.ref).toBe('ref-1');
  });
});

describe('credentials', () => {
  // A short, readable prefix for these tests, distinct from the real
  // ASSISTANT_CREDENTIAL_ default — envCredentials takes prefix as an
  // explicit override precisely so tests are not tied to the production one.
  const P = 'TEST_CRED_';

  it('resolves a ref to a value from the environment, under the prefix', async () => {
    const source = envCredentials({ [`${P}OFFICE_MAIL`]: 'secret-value' }, P);
    const handle = await source.resolve('OFFICE_MAIL');
    expect(handle?.value).toBe('secret-value');
  });

  it('returns null for a ref nothing defines, rather than an empty secret', async () => {
    // An empty credential would be attempted and fail at the far end; null
    // stops the step before it reaches an external system at all.
    expect(await envCredentials({}, P).resolve('MISSING')).toBeNull();
  });

  it('returns null for a ref that resolves to an empty string', async () => {
    // Distinct from "nothing defines it": an env var can be present but set
    // to '', and that must be refused exactly like an absent one.
    expect(await envCredentials({ [`${P}EMPTY`]: '' }, P).resolve('EMPTY')).toBeNull();
  });

  it('does not serialise the value when the handle is stringified', async () => {
    const handle = await envCredentials({ [`${P}K`]: 'secret-value' }, P).resolve('K');
    expect(JSON.stringify(handle)).not.toContain('secret-value');
  });

  it('keeps the secret out of canonicalJson for a handle this module produces', async () => {
    // toJSON alone covers JSON.stringify; canonicalJson walks Object.keys
    // directly and never calls it, so this is a separate guard against a
    // separate path. envCredentials must go through createCredentialHandle
    // rather than a plain object literal for this to hold.
    const handle = await envCredentials({ [`${P}K`]: 'super-secret-value' }, P).resolve('K');
    const serialised = canonicalJson({ credential: handle });
    expect(serialised).toContain('K');
    expect(serialised).not.toContain('super-secret-value');
  });

  describe('the ref namespace is separated from infrastructure env vars, not policed', () => {
    it('cannot reach DATABASE_URL by name, even when the process actually defines it', async () => {
      // A binding's credential_ref is attacker- or misconfiguration-reachable
      // text. If the lookup were a bare env[ref], a ref of 'DATABASE_URL'
      // would hand an infrastructure secret to an external adapter. Under
      // the default prefix there is no ref that spells
      // ASSISTANT_CREDENTIAL_DATABASE_URL by accident.
      const env = {
        DATABASE_URL: 'postgres://real-infra-secret',
        ANTHROPIC_API_KEY: 'sk-real-infra-secret',
      };
      const source = envCredentials(env); // default prefix, not the test prefix
      expect(await source.resolve('DATABASE_URL')).toBeNull();
      expect(await source.resolve('ANTHROPIC_API_KEY')).toBeNull();
    });

    it('reaches only the prefixed form of the same name', async () => {
      const env = { ASSISTANT_CREDENTIAL_DATABASE_URL: 'not-actually-infra' };
      const handle = await envCredentials(env).resolve('DATABASE_URL');
      expect(handle?.value).toBe('not-actually-infra');
    });
  });

  describe('the lookup does not walk the prototype chain', () => {
    // These names are also illegal refs (lowercase / underscored-lowercase),
    // so with the ref-shape guard in place they are refused before the
    // environment is ever touched. They stay as a defense-in-depth check —
    // refusal must hold however it happens — but they no longer exercise
    // the Object.hasOwn guard specifically. The tests below this block are
    // the ones that do: they use a ref that legitimately passes REF_PATTERN
    // and isolate the hasOwn / typeof checks each on their own.
    it.each(['constructor', 'hasOwnProperty', 'isPrototypeOf', '__proto__', 'toString'])(
      'returns null for ref %s against an injected {}',
      async (ref) => {
        expect(await envCredentials({}, P).resolve(ref)).toBeNull();
      },
    );

    it.each(['constructor', 'hasOwnProperty', 'isPrototypeOf', '__proto__', 'toString'])(
      'returns null for ref %s against the real process.env',
      async (ref) => {
        expect(await envCredentials(undefined, P).resolve(ref)).toBeNull();
      },
    );

    it('rejects a prefixed key inherited via the prototype chain rather than owned', async () => {
      // A ref of 'SECRET' is a legal, all-uppercase ref, so it reaches the
      // environment lookup. env[key] would find this value because plain
      // indexing walks the prototype chain; Object.hasOwn must not.
      const env = Object.create({ [`${P}SECRET`]: 'leaked' }) as Record<
        string,
        string | undefined
      >;
      expect(await envCredentials(env, P).resolve('SECRET')).toBeNull();
    });

    it('rejects a prefixed own key whose value is not a string', async () => {
      // Also a legal ref, so this isolates the typeof guard from the
      // hasOwn guard: the key genuinely is an own property here.
      const env = { [`${P}WEIRD`]: 12345 } as unknown as Record<string, string | undefined>;
      expect(await envCredentials(env, P).resolve('WEIRD')).toBeNull();
    });
  });

  describe('a ref must be uppercase letters, digits and underscores only', () => {
    it('rejects a lower-case ref even when the prefixed key exists in that case', async () => {
      // The ref-shape guard refuses the illegal ref outright, before any
      // environment lookup happens. Against an injected plain object this is
      // the only guard in play anyway, since plain-object property access is
      // already case-sensitive; the platform-dependent gap this rules out
      // only shows up against the real process.env (see the describe block
      // below).
      const source = envCredentials({ [`${P}OFFICE_MAIL`]: 'secret-value' }, P);
      expect(await source.resolve('office_mail')).toBeNull();
      expect(await source.resolve('OFFICE_MAIL')).not.toBeNull();
    });

    it('rejects a ref containing characters outside [A-Z0-9_]', async () => {
      const source = envCredentials({ [`${P}OFFICE-MAIL`]: 'secret-value' }, P);
      expect(await source.resolve('OFFICE-MAIL')).toBeNull();
      expect(await source.resolve('OFFICE.MAIL')).toBeNull();
      expect(await source.resolve('')).toBeNull();
    });
  });

  describe('the environment key check is exact-case, not Object.hasOwn', () => {
    it('rejects a same key set under a different case in the real process.env', async () => {
      // This can only be demonstrated against the real process.env, not an
      // injected {} literal: Object.hasOwn(process.env, key) is
      // case-insensitive on Windows -- confirmed here:
      // Object.hasOwn(process.env, 'X') is true even when the variable was
      // actually set as 'x' -- while Object.keys(process.env) always lists
      // it under the exact case it was set with. A plain object literal's
      // property access is already case-sensitive on every platform, so the
      // same test against an injected {} would pass whether or not this
      // guard used hasOwn or exact-key matching, and would prove nothing.
      // resolve() must use the exact-key check, or a ref legally spelled in
      // upper case could still be answered by a same-named lower-case real
      // env var on Windows and return null for the identical setup on Linux.
      const suffix = `PROBE_${Date.now()}`;
      const key = `${P}${suffix}`;
      const differentCaseKey = key.toLowerCase();
      process.env[differentCaseKey] = 'leaked-cross-case-value';
      try {
        expect(await envCredentials(undefined, P).resolve(suffix)).toBeNull();
      } finally {
        delete process.env[differentCaseKey];
      }
    });
  });

  describe('the prefix itself cannot be switched off', () => {
    it('refuses an empty prefix at construction', () => {
      // Not a resolve-time null: a caller that can pass '' and get a working
      // CredentialSource back has a way to disable the entire namespace
      // separation control, silently, with every other test still green.
      expect(() => envCredentials({}, '')).toThrow(/prefix/i);
    });

    it('refuses a whitespace-only prefix at construction', () => {
      expect(() => envCredentials({}, '   ')).toThrow(/prefix/i);
    });
  });
});

function recordingTransport() {
  const sent: { to: string[]; subject: string; body: string }[] = [];
  const transport: MailTransport = {
    async send(message) {
      sent.push(message);
      return { messageId: 'MSG-1' };
    },
  };
  return { transport, sent };
}

/** A ready-to-use call, overridable per test the same way `call()` is above. */
function mailCall(over: Partial<AdapterCall> = {}): AdapterCall {
  return {
    toolName: 'mail.send',
    input: { to: 'a@b.com', subject: 's', body: 'b' },
    credential: createCredentialHandle('K', 'pw'),
    idempotencyKey: 'test-idempotency-key',
    signal: new AbortController().signal,
    ...over,
  };
}

describe('the mail adapter', () => {
  it('sends the payload it was given and returns the provider id', async () => {
    const { transport, sent } = recordingTransport();
    const adapter = createMailAdapter({ system: 'office-mail', transport });

    const result = await adapter.execute(
      mailCall({
        input: { to: 'a@b.com', subject: 'שלום', body: 'הגוף' },
        credential: createCredentialHandle('OFFICE_MAIL', 'pw'),
      }),
    );

    expect(result).toEqual({ ok: true, output: { messageId: 'MSG-1' }, externalId: 'MSG-1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['a@b.com']);
  });

  it('reads several recipients, whether a list or one joined string', async () => {
    const { transport, sent } = recordingTransport();
    const adapter = createMailAdapter({ system: 'office-mail', transport });

    await adapter.execute(mailCall({ input: { to: ['a@b.com', 'c@d.com'], subject: 's', body: 'b' } }));
    await adapter.execute(mailCall({ input: { to: 'e@f.com, g@h.com', subject: 's', body: 'b' } }));

    expect(sent[0]?.to).toEqual(['a@b.com', 'c@d.com']);
    expect(sent[1]?.to).toEqual(['e@f.com', 'g@h.com']);
  });

  it('refuses a payload with no recipient rather than sending to nobody', async () => {
    const { transport } = recordingTransport();
    const adapter = createMailAdapter({ system: 'office-mail', transport });

    const result = await adapter.execute(mailCall({ input: { subject: 's', body: 'b' } }));

    expect(result).toEqual({
      ok: false,
      retryable: false,
      code: 'no_recipient',
      message: expect.any(String),
    });
  });

  it('refuses without a credential rather than trying anonymously', async () => {
    const { transport } = recordingTransport();
    const adapter = createMailAdapter({ system: 'office-mail', transport });

    const result = await adapter.execute(mailCall({ credential: null }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('credential_missing');
  });

  it('refuses a call for a tool it does not serve, rather than sending mail for it', async () => {
    // AdapterRegistry.get looks an adapter up by system name and does not
    // check `serves` -- a mis-wired binding could otherwise route an
    // unrelated tool through this adapter and have it send mail anyway.
    const { transport, sent } = recordingTransport();
    const adapter = createMailAdapter({ system: 'office-mail', transport });

    const result = await adapter.execute(mailCall({ toolName: 'crm.write' }));

    expect(result).toEqual({
      ok: false,
      retryable: false,
      code: 'unsupported_tool',
      message: expect.any(String),
    });
    expect(sent).toHaveLength(0);
  });

  it('refuses before sending when the call is already aborted', async () => {
    const { transport, sent } = recordingTransport();
    const adapter = createMailAdapter({ system: 'office-mail', transport });
    const controller = new AbortController();
    controller.abort();

    const result = await adapter.execute(mailCall({ signal: controller.signal }));

    expect(result).toEqual({
      ok: false,
      retryable: true,
      code: 'aborted',
      message: expect.any(String),
    });
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['missing subject', { body: 'b' }],
    ['missing body', { subject: 's' }],
    ['non-string subject', { subject: 5, body: 'b' }],
    ['empty body', { subject: 's', body: '' }],
  ])('refuses to send an incomplete message (%s) rather than mailing it empty', async (_label, extra) => {
    const { transport, sent } = recordingTransport();
    const adapter = createMailAdapter({ system: 'office-mail', transport });

    const result = await adapter.execute(mailCall({ input: { to: 'a@b.com', ...extra } }));

    expect(result).toEqual({
      ok: false,
      retryable: false,
      code: 'message_incomplete',
      message: expect.any(String),
    });
    expect(sent).toHaveLength(0);
  });

  describe('recipient shape validation', () => {
    it('refuses the redaction placeholder as a recipient', async () => {
      const { transport, sent } = recordingTransport();
      const adapter = createMailAdapter({ system: 'office-mail', transport });

      const result = await adapter.execute(mailCall({ input: { to: REDACTED, subject: 's', body: 'b' } }));

      expect(result).toEqual({
        ok: false,
        retryable: false,
        code: 'no_recipient',
        message: expect.any(String),
      });
      expect(sent).toHaveLength(0);
    });

    it('refuses a partially-redacted address, not only the exact placeholder', async () => {
      // redactPayload does substring replacement, so '[הוסר]@x.com' is what
      // a redacted local part actually looks like -- it passes both an
      // exact-placeholder check and the shape check, and would otherwise be
      // mailed to the real, unredacted domain.
      const { transport, sent } = recordingTransport();
      const adapter = createMailAdapter({ system: 'office-mail', transport });

      const result = await adapter.execute(
        mailCall({ input: { to: `${REDACTED}@x.com`, subject: 's', body: 'b' } }),
      );

      expect(result).toEqual({
        ok: false,
        retryable: false,
        code: 'no_recipient',
        message: expect.any(String),
      });
      expect(sent).toHaveLength(0);
    });

    it('extracts the address from a display-name wrapper', async () => {
      // 'Dana Cohen <dana@x.com>' has no comma, so it survives the split
      // intact; EMAIL_SHAPE alone would refuse it for the internal
      // whitespace, which is exactly the regression this guards.
      const { transport, sent } = recordingTransport();
      const adapter = createMailAdapter({ system: 'office-mail', transport });

      const result = await adapter.execute(
        mailCall({ input: { to: 'Dana Cohen <dana@x.com>', subject: 's', body: 'b' } }),
      );

      expect(result.ok).toBe(true);
      expect(sent[0]?.to).toEqual(['dana@x.com']);
    });

    it('recovers the bracketed address from a comma-shredded display name', async () => {
      // '"Cohen, Dana" <dana@x.com>' splits on the comma into '"Cohen' and
      // 'Dana" <dana@x.com>'. The first fragment has no address and is
      // dropped; the second still ends in a well-formed <addr> wrapper, so
      // extractEmail recovers the real address from it. This is the
      // intended effect of accepting display-name wrappers at all -- it is
      // not a special case for shredded input, just what falls out of
      // extracting from whichever fragment carries the brackets.
      const { transport, sent } = recordingTransport();
      const adapter = createMailAdapter({ system: 'office-mail', transport });

      const result = await adapter.execute(
        mailCall({ input: { to: '"Cohen, Dana" <dana@x.com>', subject: 's', body: 'b' } }),
      );

      expect(result.ok).toBe(true);
      expect(sent[0]?.to).toEqual(['dana@x.com']);
    });

    it('refuses when no fragment contains a valid address to extract', async () => {
      const { transport, sent } = recordingTransport();
      const adapter = createMailAdapter({ system: 'office-mail', transport });

      const result = await adapter.execute(
        mailCall({ input: { to: '"Cohen, just a name, no address at all"', subject: 's', body: 'b' } }),
      );

      expect(result).toEqual({
        ok: false,
        retryable: false,
        code: 'no_recipient',
        message: expect.any(String),
      });
      expect(sent).toHaveLength(0);
    });

    it('dedupes a repeated address, preserving the order the rest arrived in', async () => {
      const { transport, sent } = recordingTransport();
      const adapter = createMailAdapter({ system: 'office-mail', transport });

      await adapter.execute(mailCall({ input: { to: 'a@b.com, c@d.com, a@b.com', subject: 's', body: 'b' } }));

      expect(sent[0]?.to).toEqual(['a@b.com', 'c@d.com']);
    });

    it('dedupes case-insensitively, keeping the first casing seen', async () => {
      const { transport, sent } = recordingTransport();
      const adapter = createMailAdapter({ system: 'office-mail', transport });

      await adapter.execute(mailCall({ input: { to: 'A@b.com, a@b.com', subject: 's', body: 'b' } }));

      expect(sent[0]?.to).toEqual(['A@b.com']);
    });
  });

  describe('the credential reaches the transport', () => {
    it('passes the resolved secret to transport.send, not just the ref', async () => {
      const seenCredentialValues: string[] = [];
      const transport: MailTransport = {
        async send(_message, context) {
          seenCredentialValues.push(context.credential.value);
          return { messageId: 'MSG-1' };
        },
      };
      const adapter = createMailAdapter({ system: 'office-mail', transport });

      await adapter.execute(mailCall({ credential: createCredentialHandle('K', 'super-secret-value') }));

      expect(seenCredentialValues).toEqual(['super-secret-value']);
    });
  });

  it('forwards the idempotency key to the transport', async () => {
    const seen: string[] = [];
    const transport: MailTransport = {
      async send(_message, context) {
        seen.push(context.idempotencyKey);
        return { messageId: 'MSG-1' };
      },
    };
    const adapter = createMailAdapter({ system: 'office-mail', transport });

    await adapter.execute(mailCall({ idempotencyKey: 'attempt-42' }));

    expect(seen).toEqual(['attempt-42']);
  });

  it('forwards the abort signal to the transport', async () => {
    const seen: AbortSignal[] = [];
    const transport: MailTransport = {
      async send(_message, context) {
        seen.push(context.signal);
        return { messageId: 'MSG-1' };
      },
    };
    const adapter = createMailAdapter({ system: 'office-mail', transport });
    const controller = new AbortController();

    await adapter.execute(mailCall({ signal: controller.signal }));

    expect(seen).toEqual([controller.signal]);
  });

  describe('classifying a transport failure into permanent, transient and ambiguous', () => {
    async function sendWithFailure(error: unknown): Promise<AdapterResult> {
      const transport: MailTransport = {
        async send() {
          throw error;
        },
      };
      const adapter = createMailAdapter({ system: 'office-mail', transport });
      return adapter.execute(mailCall());
    }

    it('treats a 5xx SMTP rejection as permanent -- not retryable', async () => {
      const result = await sendWithFailure(
        Object.assign(new Error('550 no such mailbox'), { responseCode: 550 }),
      );
      expect(result).toEqual({
        ok: false,
        retryable: false,
        code: 'send_rejected',
        message: expect.any(String),
      });
    });

    it('treats a 535 auth rejection as permanent -- not retryable', async () => {
      const result = await sendWithFailure(
        Object.assign(new Error('535 bad credentials'), { responseCode: 535 }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('send_rejected');
    });

    it('treats a 4xx SMTP rejection as transient -- retryable', async () => {
      const result = await sendWithFailure(
        Object.assign(new Error('421 too busy'), { responseCode: 421 }),
      );
      expect(result).toEqual({
        ok: false,
        retryable: true,
        code: 'transport_error',
        message: expect.any(String),
      });
    });

    it('treats connection refused as transient -- retryable', async () => {
      // The server being down is a reason to come back later. A malformed
      // address is not, which the two permanent-failure tests above cover.
      const result = await sendWithFailure(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );
      expect(result).toEqual({
        ok: false,
        retryable: true,
        code: 'transport_error',
        message: expect.any(String),
      });
    });

    it('treats a DNS failure as transient -- retryable', async () => {
      const result = await sendWithFailure(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.retryable).toBe(true);
    });

    it('treats a failure mid-DATA as ambiguous -- not retryable, and not the same code as a rejection', async () => {
      // The connection dropped while (or after) the body was in transit,
      // with no final reply. The server may already have the message; a
      // duplicate on retry is the risk this must not take.
      const result = await sendWithFailure(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', command: 'DATA' }),
      );
      expect(result).toEqual({
        ok: false,
        retryable: false,
        code: 'delivery_unknown',
        message: expect.any(String),
      });
    });

    it('treats an unclassifiable failure as ambiguous rather than guessing it is safe to retry', async () => {
      const result = await sendWithFailure(new Error('mystery failure'));
      expect(result).toEqual({
        ok: false,
        retryable: false,
        code: 'delivery_unknown',
        message: expect.any(String),
      });
    });
  });

  describe('recipient delivery is a subset of what the gate screened, never equal', () => {
    // Screening (readEmails, in the gate) deliberately over-approximates:
    // it reads to/recipient/email so do-not-contact checks the widest
    // plausible set, and a false positive there costs nothing. Delivery
    // (readRecipients, here) must be exact -- every address it returns gets
    // a real message -- so it reads `to` alone. The two were briefly made to
    // read the same three keys so an equality-based version of this test
    // would pass; that widening let a payload's `email` field become a
    // delivery target instead of something the gate merely noticed, for
    // `{ to: 'accounting@firm.com', email: 'client@ext.com' }`. Equality is
    // the wrong relation between screening and delivery and must never come
    // back; subset is.
    const cases: { label: string; input: Record<string, unknown> }[] = [
      { label: 'a single to string', input: { to: 'a@b.com' } },
      { label: 'a to list', input: { to: ['a@b.com', 'c@d.com'] } },
      { label: 'a comma-joined to string', input: { to: 'a@b.com, c@d.com' } },
      { label: 'a semicolon-joined to string', input: { to: 'a@b.com; c@d.com' } },
      { label: 'the recipient key alone (must deliver nothing)', input: { recipient: 'a@b.com' } },
      { label: 'the email key alone (must deliver nothing)', input: { email: 'a@b.com' } },
      {
        label: 'to, recipient and email all present (must deliver only to)',
        input: { to: 'a@b.com', recipient: 'c@d.com', email: 'e@f.com' },
      },
      { label: 'no recipient key at all', input: {} },
      { label: 'an empty to string', input: { to: '' } },
      { label: 'an empty to list', input: { to: [] } },
      { label: 'a non-string to value', input: { to: 123 } },
      { label: 'a mixed-type to list', input: { to: [123, 'a@b.com'] } },
      { label: 'a display-name-wrapped to string', input: { to: 'Dana Cohen <dana@x.com>' } },
      // The adversarial form: a bare address followed by a bracketed one.
      // Both readers must extract the bracketed address and nothing else --
      // 'a@b.com' is display-name-shaped text here, not a second recipient.
      { label: 'a bare address followed by a bracket-wrapped one', input: { to: 'a@b.com <evil@x.com>' } },
    ];

    it.each(cases.map(({ label, input }) => [label, input] as const))(
      'is contained in what the gate screened, for: %s',
      (_label, input) => {
        const delivered = readRecipients(input);

        // Exact membership, not substring containment: `readEmails` and
        // `readRecipients` now both extract addresses through the same
        // `extractAddressCandidate` (`src/util/address.ts`), so for a
        // fragment that came from `to`, the two must produce the identical
        // token, not merely tokens where one contains the other. A
        // substring check would still pass if the gate kept the raw,
        // un-unwrapped token and the adapter delivered to something merely
        // *found inside* it -- which is exactly the shape of the bypass this
        // suite exists to catch (T7-13): the adapter unwrapping a
        // display-name form for delivery while the gate screened the whole
        // un-unwrapped string, or a domain parsed off a different substring
        // of it entirely.
        const screenedEverywhere = readEmails(input);
        for (const address of delivered) {
          expect(
            screenedEverywhere.includes(address.toLowerCase()),
            `delivered "${address}" does not exactly match anything screened: ${JSON.stringify(screenedEverywhere)}`,
          ).toBe(true);
        }

        // The property that actually catches the regression: everything
        // delivered must be traceable to `to` alone, not to `recipient` or
        // `email`. `screenedEverywhere` above is a superset regardless of
        // which keys the adapter reads (the gate always reads all three),
        // so that check alone passes even if `readRecipients` is widened
        // back to three keys -- only comparing against the gate's `to`-only
        // view can fail in that case.
        const screenedFromToAlone = readEmails({ to: input['to'] });
        for (const address of delivered) {
          expect(
            screenedFromToAlone.includes(address.toLowerCase()),
            `delivered "${address}" did not come from \`to\`: ${JSON.stringify(screenedFromToAlone)}`,
          ).toBe(true);
        }
      },
    );

    it('delivers only the `to` address, never one that arrived under `recipient` or `email`', () => {
      // The coordinator's own example, pinned directly: a stray `email`
      // field must never become a delivery target.
      const input = { to: 'accounting@firm.com', recipient: 'other@firm.com', email: 'client@ext.com' };
      expect(readRecipients(input)).toEqual(['accounting@firm.com']);
    });

    it('extracts the bracketed address, not the bare one preceding it, and the gate screens the same address', () => {
      // Directly pins the adversarial example from T7-13: before the shared
      // normalisation, the gate's domain parse on the raw token
      // 'a@b.com <evil@x.com>' was 'b.com <evil' -- neither real domain --
      // while the adapter delivered to evil@x.com regardless.
      const input = { to: 'a@b.com <evil@x.com>' };
      expect(readRecipients(input)).toEqual(['evil@x.com']);
      expect(readEmails(input)).toEqual(['evil@x.com']);
    });
  });

  it('passes the shared adapter contract', async () => {
    const { transport } = recordingTransport();
    await assertAdapterContract(createMailAdapter({ system: 'office-mail', transport }), mailCall(), {
      allowCommittingSample: true,
    });
  });
});
