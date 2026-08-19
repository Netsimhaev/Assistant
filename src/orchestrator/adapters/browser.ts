import type { ExternalAdapter } from './types.js';

/**
 * The browser channel, registered but not yet implemented.
 *
 * Present from day one so `channel: 'browser'` in a charter is a statement
 * that resolves, is checked and is reported — and so building the real driver
 * later touches no other file.
 *
 * Registered as the `browser` channel *default* (`AdapterRegistry`'s second
 * constructor argument), not by its `system` name. `resolveChannel` emits the
 * charter's per-vendor system id — `office-mail`, `supplier-a-portal` —
 * never the literal string `browser`, so an adapter reachable only under its
 * own `system` name would never be found for any real charter. `system`
 * below is still a required, non-empty identifier for error messages and the
 * contract suite; it is not a charter system id.
 *
 * `serves` lists every `browser.`-prefixed tool the policy layer knows about
 * (`src/policy/classify.ts`, both `TOOL_ACTION_CLASS` and `READ_ONLY_TOOLS`),
 * plus `credential.request_session`, which classifies as `browser.session`
 * and exists only to open a browser session. Leaving one of these off would
 * surface later as a confusing "no adapter for this tool" error instead of
 * the honest "not implemented yet" this placeholder gives today. A structural
 * test (`adapters.test.ts`) derives the expected set from `classify.ts` and
 * checks `serves` against it, so a new `browser.` tool that forgets to update
 * this list fails the suite instead of drifting silently.
 */
export const browserAdapter: ExternalAdapter = {
  system: 'browser',
  channel: 'browser',
  serves: [
    'browser.navigate',
    'browser.click',
    'browser.fill',
    'browser.submit_order',
    'browser.snapshot',
    'browser.screenshot',
    'credential.request_session',
  ],
  async execute() {
    return {
      ok: false,
      retryable: false,
      code: 'browser_not_implemented',
      message: 'מנוע הדפדפן טרם נבנה — ראה תת-מערכת 4 באפיון',
    };
  },
};
