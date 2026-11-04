/**
 * The production `PdfPrinter`: headless Chromium via `playwright-core`
 * (Apache-2.0), using a Chromium already installed on the server — this
 * module never downloads a browser. Spec §6.4: a separate process with time
 * and memory caps. The printing itself needs a real browser and is exercised
 * by `npm run doc:render-check`; the caps are unit-tested through the
 * injectable launcher and `/proc` sampler (`chromium.test.ts`).
 *
 *  - **JavaScript is off** for the page (`javaScriptEnabled: false`); the HTML
 *    has no script anyway (`render-html.ts`), this is the second layer.
 *  - **No network.** The control is the HTML itself plus its CSP meta
 *    (`default-src 'none'`, fonts/images `data:` only): that is what refuses
 *    `data:`/`about:`/`file:` tricks and anything a route never sees. The
 *    context is also `offline`, and a `**` route aborts every request whose
 *    URL is not `data:` — a backstop, not the boundary.
 *  - **Env allowlist.** Chromium inherits a short list of non-secret variables,
 *    never the process env: it must not see `ANTHROPIC_API_KEY`,
 *    `DATABASE_URL` or any other secret (the curator's `env: { PATH }` rule).
 *  - `--no-sandbox` only when `CHROMIUM_NO_SANDBOX=1`.
 *  - **One deadline for the whole print** (`PDF_PRINT_TIMEOUT_MS`): launch,
 *    print and close all run inside one `withDeadline` race, with
 *    `signal.throwIfAborted()` right after launch. `close()` is itself bounded
 *    (`CLOSE_TIMEOUT_MS`), and on timeout the process tree is killed. A launch
 *    that completes after the deadline already fired is killed on arrival.
 *  - **Memory.** The browser is started with `launchServer` so its PID is
 *    known; a watchdog sums the resident set of the browser and every
 *    descendant (renderer, GPU, utility processes, found by walking
 *    `/proc/<pid>/stat` ppids) every 100ms, and above
 *    `config.chromiumRssCapMb` (env `DOCUMENT_CHROMIUM_RSS_MB`, default 768)
 *    SIGKILLs the tree and fails with `SpecRenderError('pdf_memory')`.
 *    **Linux only**, exactly like `run-extractor.ts`: there is no `/proc`
 *    elsewhere, and on Windows/macOS (dev machines) only the time cap and the
 *    60MB HTML cap (`MAX_PDF_HTML_BYTES`, `render-pdf.ts`) apply. Between two
 *    samples the tree can overshoot.
 *
 * Page numbers and the contract disclaimer come in as `footerTemplate`
 * (Playwright `displayHeaderFooter`); see `renderFooterTemplate`. The header
 * template is an empty element, because omitting it makes Chromium print its
 * default header (title and date).
 *
 * The brief's `fontDir` option was left out on purpose: the fonts are
 * embedded in the HTML as `data:` URLs (`loadPdfAssets`), so Chromium needs
 * no font directory, and an option nothing reads is a control that does not
 * exist.
 */
import { readdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { config } from '../config.js';
import { vmRssBytes } from '../documents/run-extractor.js';
import { withDeadline } from '../governance/notify.js';
import { SpecRenderError } from './render-error.js';
import { PDF_PRINT_TIMEOUT_MS, type PdfPrinter } from './render-pdf.js';

/** One running browser, as the printer core needs it. The real one is `launchPlaywright`. */
export interface BrowserSession {
  /** PID of the browser process (root of the tree the watchdog measures). */
  pid: number | undefined;
  print(html: string, footerTemplate: string): Promise<Buffer>;
  /** Graceful shutdown. Bounded by the printer; may hang. */
  close(): Promise<void>;
  /** SIGKILL the whole process tree. Must not throw. */
  kill(): void;
}

export type BrowserLauncher = () => Promise<BrowserSession>;

/** The three `/proc` reads the tree walk needs; injectable for tests. */
export interface ProcReader {
  list(): Promise<string[]>;
  stat(pid: string): Promise<string>;
  status(pid: string): Promise<string>;
}

export interface ChromiumPrinterOptions {
  /** Absolute path of the installed Chromium/Chrome executable. */
  executablePath: string;
  /** Defaults to `config.chromiumRssCapMb`. */
  rssCapMb?: number;
  /** Test seams. Production uses the defaults. */
  launch?: BrowserLauncher;
  /** Tree RSS in bytes; `null` = could not read. Default: `/proc` on Linux, none elsewhere. */
  sampleTreeRss?: ((pid: number) => Promise<number | null>) | null;
  deadlineMs?: number;
  closeTimeoutMs?: number;
  sampleIntervalMs?: number;
}

const CLOSE_TIMEOUT_MS = 5_000;
const RSS_SAMPLE_INTERVAL_MS = 100;

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

const LINUX_PROC: ProcReader = {
  list: () => readdir('/proc'),
  stat: (pid) => readFile(`/proc/${pid}/stat`, 'utf8'),
  status: (pid) => readFile(`/proc/${pid}/status`, 'utf8'),
};

/** `pid` and all its descendants, by walking ppid links. `comm` may contain spaces and parens. */
async function treePids(root: number, proc: ProcReader): Promise<number[]> {
  const children = new Map<number, number[]>();
  for (const entry of await proc.list()) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await proc.stat(entry).catch(() => null);
    if (stat === null) continue;
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (!Number.isInteger(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(Number(entry));
    children.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (out.includes(pid)) continue;
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** Sum of `VmRSS` over the tree rooted at `pid`. `null` when the root itself cannot be read. */
export async function treeRssBytes(pid: number, proc: ProcReader = LINUX_PROC): Promise<number | null> {
  let total = 0;
  let rootRead = false;
  for (const p of await treePids(pid, proc)) {
    const status = await proc.status(String(p)).catch(() => null);
    const rss = status === null ? null : vmRssBytes(status);
    if (rss === null) continue;
    if (p === pid) rootRead = true;
    total += rss;
  }
  return rootRead ? total : null;
}

/**
 * Kill order: walk the tree FIRST (while every ppid link still exists), then
 * SIGKILL the descendants leaves-first, then the browser itself through
 * `server.kill()`. Killing the root first would orphan its children to init
 * and the walk would no longer find them. The primary guarantee is
 * Playwright's own kill, which signals the browser's whole process group;
 * this walk is the backstop for a descendant that left the group.
 */
async function killTree(pid: number | undefined, killServer: () => Promise<void>): Promise<void> {
  if (process.platform === 'linux' && pid !== undefined) {
    const pids = await treePids(pid, LINUX_PROC).catch(() => [pid]);
    for (const p of pids.filter((x) => x !== pid).reverse()) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  await killServer();
}

function launchPlaywright(executablePath: string): BrowserLauncher {
  return async () => {
    const server = await chromium.launchServer({
      executablePath,
      args: process.env['CHROMIUM_NO_SANDBOX'] === '1' ? ['--no-sandbox'] : [],
      env: childEnv(),
      timeout: PDF_PRINT_TIMEOUT_MS,
    });
    const pid = server.process().pid;
    const kill = () => {
      void killTree(pid, () => server.kill()).catch(() => undefined);
    };
    let browser;
    try {
      browser = await chromium.connect(server.wsEndpoint(), { timeout: PDF_PRINT_TIMEOUT_MS });
    } catch (err) {
      kill();
      throw err;
    }
    const connected = browser;
    return {
      pid,
      kill,
      close: async () => {
        await connected.close().catch(() => undefined);
        await server.close();
      },
      print: async (html, footerTemplate) => {
        const context = await connected.newContext({ javaScriptEnabled: false, offline: true });
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
          footerTemplate,
        });
      },
    };
  };
}

export function createChromiumPrinter(options: ChromiumPrinterOptions): PdfPrinter {
  const launch = options.launch ?? launchPlaywright(options.executablePath);
  const sample =
    options.sampleTreeRss !== undefined
      ? options.sampleTreeRss
      : process.platform === 'linux'
        ? (pid: number) => treeRssBytes(pid)
        : null;
  const capMb = options.rssCapMb ?? config.chromiumRssCapMb;
  const capBytes = capMb * 1024 * 1024;
  const deadlineMs = options.deadlineMs ?? PDF_PRINT_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  const intervalMs = options.sampleIntervalMs ?? RSS_SAMPLE_INTERVAL_MS;

  return async (html, signal, printOptions) => {
    signal.throwIfAborted();
    let session: BrowserSession | undefined;
    let finished = false;
    let shutDown = false;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let failMemory: (err: Error) => void = () => undefined;
    let onAbort: (() => void) | undefined;

    const memory = new Promise<never>((_resolve, reject) => {
      failMemory = reject;
    });
    memory.catch(() => undefined);
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('PDF print aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => undefined);

    const killNow = (s: BrowserSession) => {
      shutDown = true;
      try {
        s.kill();
      } catch {
        // kill must not mask the real error
      }
    };

    const closeBounded = async (s: BrowserSession) => {
      if (shutDown) return;
      shutDown = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), closeTimeoutMs);
      });
      const result = await Promise.race([s.close().then(() => 'closed' as const, () => 'failed' as const), timedOut]);
      if (timer !== undefined) clearTimeout(timer);
      if (result !== 'closed') {
        try {
          s.kill();
        } catch {
          // ignore
        }
      }
    };

    const run = async (): Promise<Buffer> => {
      const s = await launch();
      if (finished) {
        // The deadline (or an abort) already settled this print.
        killNow(s);
        throw new Error('PDF print already settled');
      }
      session = s;
      try {
        signal.throwIfAborted();
        if (sample !== null && s.pid !== undefined) {
          const pid = s.pid;
          // A tick is skipped while the previous sample is still walking
          // /proc, so slow reads never pile up into overlapping walks.
          let sampling = false;
          watchdog = setInterval(() => {
            if (sampling) return;
            sampling = true;
            sample(pid).finally(() => {
              sampling = false;
            }).then(
              (rss) => {
                if (rss !== null && rss > capBytes && !finished) {
                  killNow(s);
                  failMemory(new SpecRenderError('pdf_memory', `Chromium tree over ${capMb}MB`));
                }
              },
              () => undefined,
            );
          }, intervalMs);
        }
        return await s.print(html, printOptions.footerTemplate);
      } finally {
        if (watchdog !== undefined) clearInterval(watchdog);
        await closeBounded(s);
      }
    };

    try {
      return await withDeadline(Promise.race([run(), memory, aborted]), deadlineMs, 'הפקת ה-PDF');
    } finally {
      finished = true;
      if (watchdog !== undefined) clearInterval(watchdog);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      // Deadline/abort/memory fired while inside: kill whatever is still up.
      if (session !== undefined && !shutDown) killNow(session);
    }
  };
}
