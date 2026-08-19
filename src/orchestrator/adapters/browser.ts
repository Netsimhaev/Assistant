import type { ExternalAdapter } from './types.js';

/**
 * The browser channel, registered but not yet implemented.
 *
 * Present from day one so `channel: 'browser'` in a charter is a statement
 * that resolves, is checked and is reported — and so building the real driver
 * later touches no other file.
 *
 * `serves` lists every `browser.`-prefixed tool the policy layer knows about
 * (`src/policy/classify.ts`, both `TOOL_ACTION_CLASS` and `READ_ONLY_TOOLS`),
 * plus `credential.request_session`, which classifies as `browser.session`
 * and exists only to open a browser session. Leaving one of these off would
 * surface later as a confusing "no adapter for this tool" error instead of
 * the honest "not implemented yet" this placeholder gives today.
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
