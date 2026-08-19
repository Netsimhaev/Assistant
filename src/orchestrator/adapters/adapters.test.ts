import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from './registry.js';
import { browserAdapter } from './browser.js';
import { assertAdapterContract } from './contract.js';
import type { AdapterCall, AdapterResult, CredentialHandle, ExternalAdapter } from './types.js';
import { createCredentialHandle } from './types.js';
import { classifiedToolNames, READ_ONLY_TOOLS } from '../../policy/classify.js';
import { canonicalJson } from '../../util/canonical.js';

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

    // The sibling of the channel-default serves check above: a
    // system-specific adapter must clear the same bar. Replacing
    // `specific.serves.includes(toolName) ? specific : null` with a bare
    // `return specific` leaves every other test in this file green, since
    // none of them call `resolve` with a system-specific adapter and a tool
    // outside its `serves`.
    it('refuses a system-specific adapter for a tool it does not serve, even on the right channel', () => {
      const specific = apiAdapter('office-mail', ['mail.send']);
      const registry = new AdapterRegistry([specific]);
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
