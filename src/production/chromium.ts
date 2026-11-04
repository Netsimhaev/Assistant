/**
 * The production `PdfPrinter`: headless Chromium via `playwright-core`
 * (Apache-2.0), using a Chromium already installed on the server — this
 * module never downloads a browser. Spec §6.4. No unit test: it needs a real
 * browser and is exercised by `npm run doc:render-check`; every rule it
 * enforces is listed here so a reader can check them against the code.
 *
 *  - JavaScript is off for the page (`javaScriptEnabled: false`); the HTML has
 *    no script anyway (`render-html.ts`), this is the second layer.
 *  - No network: the context is `offline`, and every request whose URL is not
 *    `data:` is aborted by a `**` route. The HTML only carries `data:` URLs,
 *    so an abort means something unexpected tried to load and it simply fails.
 *  - Chromium inherits only a short allowlist of environment variables, never
 *    the process env: it must not see `ANTHROPIC_API_KEY`, `DATABASE_URL` or
 *    any other secret this process holds (same rule as the curator's
 *    `env: { PATH }`).
 *  - `--no-sandbox` only when `CHROMIUM_NO_SANDBOX=1` (a container without
 *    user namespaces); otherwise Chromium's own sandbox stays on.
 *  - One print is bounded by `PDF_PRINT_TIMEOUT_MS` through `withDeadline` —
 *    racing an independent timer, not trusting the signal alone — and the
 *    browser is closed in `finally` on every path, success or failure.
 *
 * Page numbers and the contract disclaimer come in as `footerTemplate`
 * (Playwright `displayHeaderFooter`); see `renderFooterTemplate` for why not
 * CSS `@page` margin boxes. The header template is an empty element, because
 * omitting it makes Chromium print its default header (title and date).
 *
 * The brief's `fontDir` option was left out on purpose: the fonts are
 * embedded in the HTML as `data:` URLs (`loadPdfAssets`), so Chromium needs
 * no font directory, and an option nothing reads is a control that does not
 * exist.
 */
import { chromium } from 'playwright-core';
import { withDeadline } from '../governance/notify.js';
import { PDF_PRINT_TIMEOUT_MS, type PdfPrinter } from './render-pdf.js';

export interface ChromiumPrinterOptions {
  /** Absolute path of the installed Chromium/Chrome executable. */
  executablePath: string;
}

/** Environment variables Chromium may see. Nothing that can carry a secret. */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'LOCALAPPDATA', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE'];

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function createChromiumPrinter(options: ChromiumPrinterOptions): PdfPrinter {
  return async (html, signal, printOptions) => {
    signal.throwIfAborted();
    const browser = await chromium.launch({
      executablePath: options.executablePath,
      args: process.env['CHROMIUM_NO_SANDBOX'] === '1' ? ['--no-sandbox'] : [],
      env: childEnv(),
      timeout: PDF_PRINT_TIMEOUT_MS,
    });
    let onAbort: (() => void) | undefined;
    try {
      const print = async (): Promise<Buffer> => {
        const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
        const page = await context.newPage();
        await page.route('**', (route) =>
          route.request().url().startsWith('data:') ? route.continue() : route.abort(),
        );
        await page.setContent(html, { waitUntil: 'load', timeout: PDF_PRINT_TIMEOUT_MS });
        return page.pdf({
          format: 'A4',
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: true,
          headerTemplate: '<span></span>',
          footerTemplate: printOptions.footerTemplate,
        });
      };
      // The listener is removed in `finally`, so an abort that fires after the
      // print settled (AbortSignal.timeout always fires eventually) rejects
      // nothing and cannot surface as an unhandled rejection.
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('PDF print aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await withDeadline(Promise.race([print(), aborted]), PDF_PRINT_TIMEOUT_MS, 'הפקת ה-PDF');
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      await browser.close().catch(() => undefined);
    }
  };
}
