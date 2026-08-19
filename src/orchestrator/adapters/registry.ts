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

  /** Raw system lookup, with no awareness of the charter's signed channel. */
  get(system: string): ExternalAdapter | null {
    return this.bySystem.get(system) ?? null;
  }

  /**
   * The adapter that may act for a resolved connection.
   *
   * A system-specific adapter wins if one is registered under that name,
   * otherwise the default adapter for the channel, otherwise `null`.
   *
   * `channel` here is `resolveChannel`'s output — the value the owner signed
   * in the charter (`CharterConnection.channel`). A system-specific adapter
   * whose own `channel` disagrees with it is refused outright rather than
   * falling through to the channel default: an adapter that would run on
   * `browser` for a connection signed as `api` is not the adapter for that
   * connection, on either channel.
   */
  resolve(system: string, channel: ExternalAdapter['channel']): ExternalAdapter | null {
    const specific = this.bySystem.get(system);
    if (specific !== undefined) {
      return specific.channel === channel ? specific : null;
    }
    return this.byChannelDefault.get(channel) ?? null;
  }

  systems(): string[] {
    return [...this.bySystem.keys()].sort();
  }
}
