import type { ExternalAdapter } from './types.js';

/**
 * Which adapter implements which system, and which adapter is the default
 * driver for a channel when no system-specific one is registered.
 *
 * Constructed rather than global so a test can inject a recording adapter and
 * no test ever sends a real message.
 *
 * Two registries rather than one: `resolveChannel` (`src/orchestrator/channels.ts`)
 * emits the charter's per-vendor system id — `office-mail`, `supplier-a-api` —
 * never a generic label like `browser`. An adapter that only ever registers
 * under its own literal `system` name is therefore unreachable for every real
 * charter, because nothing in a charter names a system `browser`. The browser
 * driver is a *channel* implementation, common to every vendor the owner has
 * signed onto that channel, so it is registered as the default for that
 * channel instead of under a system name a charter will never produce.
 */
export class AdapterRegistry {
  private readonly bySystem = new Map<string, ExternalAdapter>();
  private readonly byChannelDefault = new Map<ExternalAdapter['channel'], ExternalAdapter>();

  constructor(
    systemAdapters: readonly ExternalAdapter[],
    channelDefaults: readonly ExternalAdapter[] = [],
  ) {
    for (const adapter of systemAdapters) {
      if (this.bySystem.has(adapter.system)) {
        // Keeping one silently would make which adapter runs depend on
        // registration order.
        throw new Error(`adapter for system "${adapter.system}" is already registered`);
      }
      this.bySystem.set(adapter.system, adapter);
    }
    for (const adapter of channelDefaults) {
      if (this.byChannelDefault.has(adapter.channel)) {
        throw new Error(
          `default adapter for channel "${adapter.channel}" is already registered`,
        );
      }
      this.byChannelDefault.set(adapter.channel, adapter);
    }
  }

  /** Raw system lookup, with no awareness of the charter's signed channel or the tool being called. */
  get(system: string): ExternalAdapter | null {
    return this.bySystem.get(system) ?? null;
  }

  /**
   * The adapter that may act for a resolved connection and a specific tool.
   *
   * A system-specific adapter wins if one is registered under that name,
   * otherwise the default adapter for the channel, otherwise `null`. Either
   * way the winning candidate must also clear two checks, or the result is
   * `null` outright — never a fall-through to the other path:
   *
   * - `channel` must match `ChannelResolution.channel`, the value the owner
   *   signed in the charter (`CharterConnection.channel`). A system-specific
   *   adapter whose own `channel` disagrees with it is not the adapter for
   *   that connection, on either channel.
   * - `toolName` must appear in the winning adapter's `serves`. Without this,
   *   the channel default becomes a catch-all for every tool on that
   *   channel: a browser-signed webmail connection serving `mail.send` would
   *   otherwise resolve to `browserAdapter`, which does not implement it.
   *   Refusing here is what makes `browserAdapter`'s "not implemented yet"
   *   docblock claim true instead of aspirational.
   */
  resolve(
    system: string,
    channel: ExternalAdapter['channel'],
    toolName: string,
  ): ExternalAdapter | null {
    const specific = this.bySystem.get(system);
    if (specific !== undefined) {
      if (specific.channel !== channel) return null;
      return specific.serves.includes(toolName) ? specific : null;
    }
    const channelDefault = this.byChannelDefault.get(channel);
    if (channelDefault === undefined) return null;
    return channelDefault.serves.includes(toolName) ? channelDefault : null;
  }

  /**
   * Every registered adapter, as a readiness check would want to see them.
   *
   * System-specific entries are the bare system id (`office-mail`); channel
   * defaults are prefixed `channel:` (`channel:browser`) so the two kinds
   * are told apart at a glance instead of a channel default reading as an
   * ordinary, oddly-named system. Reading only `bySystem` here would report
   * zero adapters for a registry that holds nothing but a channel default —
   * exactly wrong for a check whose purpose is "does every connection have
   * something that can serve it".
   */
  systems(): string[] {
    const systemIds = [...this.bySystem.keys()].sort();
    const channelDefaultIds = [...this.byChannelDefault.keys()].sort().map((c) => `channel:${c}`);
    return [...systemIds, ...channelDefaultIds];
  }
}
