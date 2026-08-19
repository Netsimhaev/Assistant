import type { ExternalAdapter } from './types.js';

/**
 * Which adapter implements which system.
 *
 * Constructed rather than global so a test can inject a recording adapter and
 * no test ever sends a real message.
 */
export class AdapterRegistry {
  private readonly bySystem = new Map<string, ExternalAdapter>();

  constructor(adapters: readonly ExternalAdapter[]) {
    for (const adapter of adapters) {
      if (this.bySystem.has(adapter.system)) {
        // Keeping one silently would make which adapter runs depend on
        // registration order.
        throw new Error(`adapter for system "${adapter.system}" is already registered`);
      }
      this.bySystem.set(adapter.system, adapter);
    }
  }

  get(system: string): ExternalAdapter | null {
    return this.bySystem.get(system) ?? null;
  }

  systems(): string[] {
    return [...this.bySystem.keys()].sort();
  }
}
