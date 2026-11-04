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
 *    print and close all run inside one deadline race (`runGuarded`, shared
 *    with the page rasteriser of `page-images.ts`), with
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
import { chromium, type Browser, type Page } from 'playwright-core';
import { config } from '../config.js';
import { vmRssBytes } from '../documents/run-extractor.js';
import { SpecRenderError } from './render-error.js';
import { PDF_PRINT_TIMEOUT_MS, type PdfPrinter } from './render-pdf.js';

/**
 * One running browser process, as the guarded core (`runGuarded`) needs it:
 * the printer here and the page rasteriser (`page-images.ts`) both extend it
 * with the one operation they run.
 */
export interface BrowserProcess {
  /** PID of the browser process (root of the tree the watchdog measures). */
  pid: number | undefined;
  /** Graceful shutdown. Bounded by the core; may hang. */
  close(): Promise<void>;
  /** SIGKILL the whole process tree. Must not throw. */
  kill(): void;
}

/** One running browser, as the printer core needs it. The real one is `launchPlaywright`. */
export interface BrowserSession extends BrowserProcess {
  print(html: string, footerTemplate: string): Promise<Buffer>;
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

export const CLOSE_TIMEOUT_MS = 5_000;
export const RSS_SAMPLE_INTERVAL_MS = 100;

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

/** A launched, connected browser: the process handles plus the Playwright `Browser` to open contexts on. */
export interface OfflineBrowser extends BrowserProcess {
  browser: Browser;
}

/**
 * Start the installed Chromium with `launchServer` (so its PID is known to
 * the watchdog), with the env allowlist and the optional `--no-sandbox`, and
 * connect to it. Shared by the printer and the page rasteriser
 * (`page-images.ts`); each opens its own `offline` context with
 * `blockNetwork` installed.
 */
export async function launchOfflineBrowser(executablePath: string, timeoutMs: number): Promise<OfflineBrowser> {
  const server = await chromium.launchServer({
    executablePath,
    args: process.env['CHROMIUM_NO_SANDBOX'] === '1' ? ['--no-sandbox'] : [],
    env: childEnv(),
    timeout: timeoutMs,
  });
  const pid = server.process().pid;
  const kill = () => {
    void killTree(pid, () => server.kill()).catch(() => undefined);
  };
  let browser: Browser;
  try {
    browser = await chromium.connect(server.wsEndpoint(), { timeout: timeoutMs });
  } catch (err) {
    kill();
    throw err;
  }
  const connected = browser;
  return {
    pid,
    kill,
    browser: connected,
    close: async () => {
      await connected.close().catch(() => undefined);
      await server.close();
    },
  };
}

/** The `**` route every page installs: anything that is not a `data:` URL is aborted. A backstop, not the boundary. */
export async function blockNetwork(page: Page): Promise<void> {
  await page.route('**', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
}

function launchPlaywright(executablePath: string): BrowserLauncher {
  return async () => {
    const b = await launchOfflineBrowser(executablePath, PDF_PRINT_TIMEOUT_MS);
    return {
      pid: b.pid,
      kill: b.kill,
      close: b.close,
      print: async (html, footerTemplate) => {
        const context = await b.browser.newContext({ javaScriptEnabled: false, offline: true });
        const page = await context.newPage();
        await blockNetwork(page);
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

/** The tree sampler production uses: `/proc` on Linux, none elsewhere (see the module docblock). */
export function defaultTreeSampler(): ((pid: number) => Promise<number | null>) | null {
  return process.platform === 'linux' ? (pid: number) => treeRssBytes(pid) : null;
}

/** The caps one guarded browser run is held to. */
export interface GuardOptions {
  /** Tree RSS in bytes; `null` = could not read. A `null` sampler = no memory cap (non-Linux). */
  sample: ((pid: number) => Promise<number | null>) | null;
  capMb: number;
  deadlineMs: number;
  closeTimeoutMs: number;
  intervalMs: number;
  /** The error a memory kill fails with. */
  memoryError: (capMb: number) => Error;
  /** The error the one deadline fails with. */
  timeoutError: (deadlineMs: number) => Error;
}

/**
 * One browser run under ONE deadline: launch, the caller's operation and the
 * bounded close all race `guard.deadlineMs`; an RSS watchdog samples the tree
 * every `intervalMs` and kills it over the cap; an abort of `signal` rejects
 * at once. On any of the three, whatever browser is up is killed, and a
 * launch that completes after the run already settled is killed on arrival.
 * Generic over the session type so the printer and the page rasteriser
 * (`page-images.ts`) share it instead of each carrying a copy.
 */
export async function runGuarded<S extends BrowserProcess, T>(
  launch: () => Promise<S>,
  signal: AbortSignal,
  guard: GuardOptions,
  use: (session: S) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const capBytes = guard.capMb * 1024 * 1024;
  let session: S | undefined;
  let finished = false;
  let shutDown = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let failMemory: (err: Error) => void = () => undefined;
  let onAbort: (() => void) | undefined;

  const memory = new Promise<never>((_resolve, reject) => {
    failMemory = reject;
  });
  memory.catch(() => undefined);
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('browser run aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => reject(guard.timeoutError(guard.deadlineMs)), guard.deadlineMs);
  });
  deadline.catch(() => undefined);

  const killNow = (s: S) => {
    shutDown = true;
    try {
      s.kill();
    } catch {
      // kill must not mask the real error
    }
  };

  const closeBounded = async (s: S) => {
    if (shutDown) return;
    shutDown = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), guard.closeTimeoutMs);
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

  const run = async (): Promise<T> => {
    const s = await launch();
    if (finished) {
      // The deadline (or an abort) already settled this run.
      killNow(s);
      throw new Error('browser run already settled');
    }
    session = s;
    try {
      signal.throwIfAborted();
      const sample = guard.sample;
      if (sample !== null && s.pid !== undefined) {
        const pid = s.pid;
        // A tick is skipped while the previous sample is still walking
        // /proc, so slow reads never pile up into overlapping walks.
        let sampling = false;
        watchdog = setInterval(() => {
          if (sampling) return;
          sampling = true;
          sample(pid)
            .finally(() => {
              sampling = false;
            })
            .then(
              (rss) => {
                if (rss !== null && rss > capBytes && !finished) {
                  killNow(s);
                  failMemory(guard.memoryError(guard.capMb));
                }
              },
              () => undefined,
            );
        }, guard.intervalMs);
      }
      return await use(s);
    } finally {
      if (watchdog !== undefined) clearInterval(watchdog);
      await closeBounded(s);
    }
  };

  try {
    return await Promise.race([run(), memory, aborted, deadline]);
  } finally {
    finished = true;
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (watchdog !== undefined) clearInterval(watchdog);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    // Deadline/abort/memory fired while inside: kill whatever is still up.
    if (session !== undefined && !shutDown) killNow(session);
  }
}

export function createChromiumPrinter(options: ChromiumPrinterOptions): PdfPrinter {
  const launch = options.launch ?? launchPlaywright(options.executablePath);
  const guard: GuardOptions = {
    sample: options.sampleTreeRss !== undefined ? options.sampleTreeRss : defaultTreeSampler(),
    capMb: options.rssCapMb ?? config.chromiumRssCapMb,
    deadlineMs: options.deadlineMs ?? PDF_PRINT_TIMEOUT_MS,
    closeTimeoutMs: options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
    intervalMs: options.sampleIntervalMs ?? RSS_SAMPLE_INTERVAL_MS,
    memoryError: (capMb) => new SpecRenderError('pdf_memory', `Chromium tree over ${capMb}MB`),
    // The exact wording `withDeadline` gave this printer before the core was shared.
    timeoutError: (ms) => new Error(`הפקת ה-PDF לא הסתיימה תוך ${ms} מ״ש`),
  };
  return (html, signal, printOptions) => runGuarded(launch, signal, guard, (s) => s.print(html, printOptions.footerTemplate));
}

