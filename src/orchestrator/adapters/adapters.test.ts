import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from './registry.js';
import { browserAdapter } from './browser.js';
import { assertAdapterContract, NON_COMMITTING_SAMPLE_TOOLS } from './contract.js';
import type { AdapterCall, AdapterResult, CredentialHandle, ExternalAdapter } from './types.js';
import { createCredentialHandle } from './types.js';
import { classifiedToolNames, READ_ONLY_TOOLS } from '../../policy/classify.js';
import { canonicalJson } from '../../util/canonical.js';
import { envCredentials } from '../credentials.js';

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
