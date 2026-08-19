import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from './registry.js';
import { browserAdapter } from './browser.js';
import { assertAdapterContract } from './contract.js';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './types.js';
import { classifiedToolNames, READ_ONLY_TOOLS } from '../../policy/classify.js';

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
function apiAdapter(system: string): ExternalAdapter {
  return {
    system,
    channel: 'api',
    serves: ['x'],
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

  describe('resolve — system-specific then channel default', () => {
    it('falls back to the channel default when no system-specific adapter is registered', () => {
      // `resolveChannel` emits the charter's per-vendor system id, never the
      // literal string 'browser', so a connection named `supplier-a-portal`
      // with no adapter of its own must still reach the browser placeholder.
      const registry = new AdapterRegistry([], [browserAdapter]);
      expect(registry.resolve('supplier-a-portal', 'browser')).toBe(browserAdapter);
    });

    it('prefers a system-specific adapter over the channel default', () => {
      const specific = apiAdapter('supplier-a-api');
      const registry = new AdapterRegistry([specific], [browserAdapter]);
      expect(registry.resolve('supplier-a-api', 'api')).toBe(specific);
    });

    it('returns null when neither a system-specific nor a channel-default adapter exists', () => {
      const registry = new AdapterRegistry([]);
      expect(registry.resolve('ghost', 'api')).toBeNull();
    });

    it('refuses a system-specific adapter whose channel disagrees with the signed channel (adapter is browser, charter signed api)', () => {
      const registry = new AdapterRegistry([browserAdapter]);
      expect(registry.resolve('browser', 'api')).toBeNull();
    });

    it('refuses a system-specific adapter whose channel disagrees with the signed channel (adapter is api, charter signed browser)', () => {
      const registry = new AdapterRegistry([apiAdapter('office-mail')]);
      expect(registry.resolve('office-mail', 'browser')).toBeNull();
    });
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
    // Derived from classify.ts rather than hand-copied, so a new `browser.`
    // tool that forgets to update `browserAdapter.serves` fails this test
    // instead of surfacing later as a confusing "no adapter" error.
    const allKnownTools = [...classifiedToolNames(), ...READ_ONLY_TOOLS];
    const expected = allKnownTools
      .filter((name) => name.startsWith('browser.') || name === 'credential.request_session')
      .sort();

    expect([...browserAdapter.serves].sort()).toEqual(expected);
  });
});
