/**
 * Page images for check 2 (spec §7.2): the second eye (`gov.verify`) judges
 * images of the produced document's pages, the way the client will see them,
 * plus the text extracted from them.
 *
 * **Two stages, two child processes, both with caps.**
 *
 *  1. docx/xlsx/pptx only: LibreOffice headless converts the file to a
 *     TEMPORARY PDF (`convertToPdf`). That PDF exists only to be looked at —
 *     it is never stored, attached or sent (spec §6.4: "LibreOffice does not
 *     produce any file that is sent"). The child runs with exactly
 *     `--headless --norestore -env:UserInstallation=<private profile>
 *     --convert-to pdf --outdir <tmp> <file>`, in a fresh temp dir, with env
 *     `{ PATH, HOME: <tmp> }` and nothing else (no secret reaches it), in its
 *     own process group, under a 90s deadline (`SOFFICE_TIMEOUT_MS`) whose
 *     expiry SIGKILLs the whole tree (`killProcessTree`) and fails with
 *     `SpecRenderError('render_timeout')`. The temp dir is removed on every
 *     path, success or failure. A produced PDF skips this stage.
 *
 *  2. Rasterising, in headless Chromium (`createChromiumRasteriser`), the
 *     same installed browser the printer uses and under the same shared core
 *     (`runGuarded`, `chromium.ts`): one deadline (`RASTER_TIMEOUT_MS`) over
 *     launch + work + close, the Linux tree-RSS watchdog
 *     (`config.chromiumRssCapMb`, failing with `render_memory`), an
 *     `offline` context and the `**` route that aborts every non-`data:`
 *     request.
 *
 *     **The one page in this codebase that runs JavaScript** (controller
 *     ruling R3). The PDF printer's page has JS off; this page has it ON,
 *     because the only renderer that turns PDF bytes into pixels inside
 *     Chromium is pdf.js running in the page. What makes that acceptable:
 *     the page loads NO external content — its HTML is a fixed constant here,
 *     pdf.js and its worker are passed in as source text from our own
 *     `node_modules` and imported from `blob:` URLs, and the PDF bytes are
 *     OUR OWN produced (or LibreOffice-converted) file, passed in as base64.
 *     A CSP meta (`RASTER_PAGE_HTML`) allows scripts from `blob:` only and
 *     images from `data:`/`blob:`, nothing else; the context is offline and
 *     the route aborts anything that is not `data:`. pdf.js runs with the
 *     extractor's load options (`PDF_LOAD_OPTIONS`: no XFA, no font-face
 *     install, no system fonts, no wasm, stop at errors) and a main-thread
 *     worker (`globalThis.pdfjsWorker`), so it never resolves a worker URL.
 *     The alternative the brief allowed — pdf.js + `@napi-rs/canvas` in a
 *     dedicated Node child — was not taken: it would load a native module
 *     the extractor refuses by design, and leave `chromiumPath` an option
 *     nothing reads.
 *
 * **Text.** pdf.js text items come back from the page as plain JSON and go
 * through the extractor's own `linesOf` (`documents/extractors/pdf.ts`), so
 * check 2 reads lines exactly the way an incoming PDF is read — the same
 * baseline grouping and right-to-left ordering heuristic, with the same
 * known limits (two-column layouts, a split LTR run inside an RTL line).
 *
 * **Which pages** (`selectPages`, spec §7.2): every page when there are ten
 * or fewer; otherwise ten — the first, the last, then the pages check 1
 * flagged, in page order, until the cap. Images are returned in page order.
 *
 * Tests never need LibreOffice or Chromium: `spawn` and `rasterise` are
 * seams. The real binaries run in `npm run doc:render-check`
 * (`run-render-check.ts`), a pre-launch check.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import type { DocumentFormat } from '../domain/document-spec.js';
import { linesOf, MAX_PDF_PAGES, PDF_LOAD_OPTIONS } from '../documents/extractors/pdf.js';
import {
  blockNetwork,
  CLOSE_TIMEOUT_MS,
  defaultTreeSampler,
  launchOfflineBrowser,
  RSS_SAMPLE_INTERVAL_MS,
  runGuarded,
  type BrowserProcess,
  type GuardOptions,
} from './chromium.js';
import { SpecRenderError } from './render-error.js';

export type ProducedFormat = DocumentFormat;

export { PRODUCTION_TOOLS_MISSING_REASON } from './render-error.js';

/** Spec §7.2: at most this many page images go to the judge. */
export const MAX_PAGE_IMAGES = 10;
/** The LibreOffice conversion child's deadline; on expiry the process tree is SIGKILLed. */
export const SOFFICE_TIMEOUT_MS = 90_000;
/** One deadline over the whole rasterise (launch, load, render, close). */
export const RASTER_TIMEOUT_MS = 60_000;
/** Pages rendered at ~150dpi for A4 portrait width. */
const RASTER_TARGET_WIDTH_PX = 1240;
/** No image edge longer than this (a very wide landscape sheet is scaled down to fit). */
const RASTER_MAX_EDGE_PX = 2000;
/** After a SIGKILL, how long to wait for `close` before giving up on the child. */
const KILL_SETTLE_MS = 5_000;

export interface PageImages {
  /** PNG bytes, in page order. */
  pages: Buffer[];
  /** Extracted text, pages separated by a blank line. */
  text: string;
  pageCount: number;
}

export interface PageRenderOptions {
  /** 1-based page numbers check 1 flagged; they are preferred in the sample of a long document. */
  flaggedPages?: readonly number[];
}

export type PageRenderer = (
  file: { format: ProducedFormat; bytes: Buffer },
  signal: AbortSignal,
  options?: PageRenderOptions,
) => Promise<PageImages>;

/** PDF bytes in; `select(pageCount)` decides which pages become images. */
export type Rasteriser = (pdf: Buffer, select: (pageCount: number) => number[], signal: AbortSignal) => Promise<PageImages>;

/**
 * The page sample, in page order: every page when `pageCount <= 10`;
 * otherwise first, last, then flagged pages (whole numbers within range,
 * ascending, de-duplicated) until `MAX_PAGE_IMAGES`.
 */
export function selectPages(pageCount: number, flagged: readonly number[]): number[] {
  if (pageCount <= MAX_PAGE_IMAGES) return Array.from({ length: Math.max(pageCount, 0) }, (_, i) => i + 1);
  const chosen = new Set<number>([1, pageCount]);
  const candidates = [...new Set(flagged)]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= pageCount)
    .sort((a, b) => a - b);
  for (const n of candidates) {
    if (chosen.size >= MAX_PAGE_IMAGES) break;
    chosen.add(n);
  }
  return [...chosen].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Stage 1: LibreOffice → temporary PDF
// ---------------------------------------------------------------------------

/** The slice of a child process the converter uses. Node's `ChildProcess` satisfies it. */
export interface SofficeChild {
  pid?: number | undefined;
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnSoffice = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; cwd: string; detached: boolean; stdio: ['ignore', 'ignore', 'pipe'] },
) => SofficeChild;

const defaultSpawn: SpawnSoffice = (command, args, options) => spawn(command, args, options);

/**
 * SIGKILL the child's whole tree: on POSIX the process group (`detached`
 * spawn makes the child its leader — `soffice` is a wrapper that starts
 * `soffice.bin`), on Windows `taskkill /T /F`; then the child itself.
 * Must not throw.
 */
export function killProcessTree(child: SofficeChild): void {
  const pid = child.pid;
  if (pid !== undefined) {
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined);
      } catch {
        // fall through to the direct kill
      }
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // group already gone
      }
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

/** The exact command line (spec/brief). `profileDir` is private to this run. */
export function sofficeArgs(dir: string, inputPath: string): string[] {
  return [
    '--headless',
    '--norestore',
    `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`,
    '--convert-to',
    'pdf',
    '--outdir',
    dir,
    inputPath,
  ];
}

interface SofficeRun {
  sofficePath: string;
  spawn: SpawnSoffice;
  killTree: (child: SofficeChild) => void;
  deadlineMs: number;
}

function runSoffice(run: SofficeRun, dir: string, inputPath: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let killedFor: 'timeout' | 'abort' | null = null;
    let stderr = '';
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const child = run.spawn(run.sofficePath, sofficeArgs(dir, inputPath), {
      // PATH and a HOME inside the temp dir — nothing else, no secret.
      env: { PATH: process.env['PATH'] ?? '', HOME: dir },
      cwd: dir,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      signal.removeEventListener('abort', onAbort);
      if (err === null) resolve();
      else reject(err);
    };
    const killedError = (): Error =>
      killedFor === 'timeout'
        ? new SpecRenderError('render_timeout', `soffice over ${run.deadlineMs}ms`)
        : ((signal.reason as Error | undefined) ?? new Error('page render aborted'));
    const kill = (reason: 'timeout' | 'abort') => {
      if (killedFor !== null || settled) return;
      killedFor = reason;
      run.killTree(child);
      // A SIGKILLed child that never reports `close` must not hang the render.
      settleTimer = setTimeout(() => finish(killedError()), KILL_SETTLE_MS);
    };

    const timer = setTimeout(() => kill('timeout'), run.deadlineMs);
    const onAbort = () => kill('abort');
    signal.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 2_000) stderr += String(chunk);
    });
    child.once('error', (err) => finish(new SpecRenderError('render_failed', `soffice: ${err.message}`)));
    child.once('close', (code, sig) => {
      if (killedFor !== null) finish(killedError());
      else if (code !== 0) finish(new SpecRenderError('render_failed', `soffice exit ${code ?? sig}: ${stderr.trim().slice(0, 300)}`));
      else finish(null);
    });
  });
}

/** Write the file into a fresh temp dir, convert it, return the PDF bytes. The dir is removed on every path. */
async function convertToPdf(
  run: SofficeRun,
  tmpRoot: string,
  format: Exclude<ProducedFormat, 'pdf'>,
  bytes: Buffer,
  signal: AbortSignal,
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpRoot, 'produce-pages-'));
  let primary: unknown = null;
  try {
    const input = join(dir, `document.${format}`);
    await writeFile(input, bytes);
    await runSoffice(run, dir, input, signal);
    try {
      return await readFile(join(dir, 'document.pdf'));
    } catch {
      throw new SpecRenderError('render_failed', 'soffice exited 0 but wrote no PDF');
    }
  } catch (err) {
    primary = err;
    throw err;
  } finally {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (rmErr) {
      // Never mask the real failure; surface a cleanup failure on success.
      if (primary === null) throw rmErr;
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 2: rasterise in Chromium
// ---------------------------------------------------------------------------

/** A running browser that can rasterise. The real one is `launchRasterSession`. */
export interface RasterSession extends BrowserProcess {
  rasterise(pdf: Buffer, select: (pageCount: number) => number[]): Promise<PageImages>;
}

/**
 * The page's whole HTML. Scripts only from `blob:` (pdf.js and its worker,
 * imported from blobs made of our own source text), images only `data:`/
 * `blob:`, nothing else at all.
 */
export const RASTER_PAGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src blob:; ' +
  'worker-src blob:; img-src data: blob:">' +
  '</head><body></body></html>';

/**
 * Runs in the page. Imports the pdf.js worker (as the main-thread worker)
 * and pdf.js itself from blobs, opens the base64 PDF, keeps the document on
 * `globalThis` for `RENDER_IN_PAGE`, and returns the page count and every
 * page's raw text items (up to `maxTextPages`). Plain JS source on purpose:
 * a TS function handed to `page.evaluate` would carry the TS loader's
 * helpers into the browser.
 */
const LOAD_IN_PAGE = `async ({ lib, worker, pdf, options, maxTextPages }) => {
  const blobUrl = (src) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  globalThis.pdfjsWorker = await import(blobUrl(worker));
  const pdfjs = await import(blobUrl(lib));
  const bin = atob(pdf);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const doc = await pdfjs.getDocument({ ...options, data }).promise;
  globalThis.__producedPdf = doc;
  const pages = [];
  for (let n = 1; n <= Math.min(doc.numPages, maxTextPages); n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(content.items.map((i) => ({ str: i.str, dir: i.dir, transform: i.transform, width: i.width, height: i.height })));
    page.cleanup();
  }
  return { pageCount: doc.numPages, pages };
}`;

/** Runs in the page: renders the chosen pages to canvases on a white ground and returns base64 PNGs. */
const RENDER_IN_PAGE = `async ({ pageNumbers, targetWidth, maxEdge }) => {
  const doc = globalThis.__producedPdf;
  const out = [];
  for (const n of pageNumbers) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    let scale = targetWidth / base.width;
    const edge = Math.max(base.width, base.height) * scale;
    if (edge > maxEdge) scale = scale * (maxEdge / edge);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    out.push(canvas.toDataURL('image/png').slice('data:image/png;base64,'.length));
    page.cleanup();
  }
  return out;
}`;

/** `(fn)(arg)` as one expression: `page.evaluate` only calls functions it was handed as functions. */
function call(fnSource: string, arg: unknown): string {
  return `(${fnSource})(${JSON.stringify(arg)})`;
}

let pdfjsSources: Promise<{ lib: string; worker: string }> | undefined;
function loadPdfjsSources(): Promise<{ lib: string; worker: string }> {
  pdfjsSources ??= (async () => {
    const require = createRequire(import.meta.url);
    const [lib, worker] = await Promise.all([
      readFile(require.resolve('pdfjs-dist/build/pdf.min.mjs'), 'utf8'),
      readFile(require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'), 'utf8'),
    ]);
    return { lib, worker };
  })();
  return pdfjsSources;
}

function launchRasterSession(executablePath: string): () => Promise<RasterSession> {
  return async () => {
    const b = await launchOfflineBrowser(executablePath, RASTER_TIMEOUT_MS);
    return {
      pid: b.pid,
      kill: b.kill,
      close: b.close,
      rasterise: async (pdf, select) => {
        const { lib, worker } = await loadPdfjsSources();
        // JS on for this internal page only — see the module docblock.
        const context = await b.browser.newContext({ javaScriptEnabled: true, offline: true });
        const page = await context.newPage();
        await blockNetwork(page);
        await page.setContent(RASTER_PAGE_HTML, { waitUntil: 'load', timeout: RASTER_TIMEOUT_MS });
        const loaded = (await page.evaluate(
          call(LOAD_IN_PAGE, {
            lib,
            worker,
            pdf: pdf.toString('base64'),
            options: PDF_LOAD_OPTIONS,
            maxTextPages: MAX_PDF_PAGES,
          }),
        )) as { pageCount: number; pages: unknown[][] };
        const pageNumbers = select(loaded.pageCount);
        const pngs = (await page.evaluate(
          call(RENDER_IN_PAGE, { pageNumbers, targetWidth: RASTER_TARGET_WIDTH_PX, maxEdge: RASTER_MAX_EDGE_PX }),
        )) as string[];
        await context.close().catch(() => undefined);
        return {
          pages: pngs.map((b64) => Buffer.from(b64, 'base64')),
          text: loaded.pages.map((items) => linesOf(items).join('\n')).join('\n\n'),
          pageCount: loaded.pageCount,
        };
      },
    };
  };
}

export interface ChromiumRasteriserOptions {
  executablePath: string;
  /** Defaults to `config.chromiumRssCapMb`. */
  rssCapMb?: number;
  /** Test seams. */
  launch?: () => Promise<RasterSession>;
  sampleTreeRss?: ((pid: number) => Promise<number | null>) | null;
  deadlineMs?: number;
  closeTimeoutMs?: number;
  sampleIntervalMs?: number;
}

export function createChromiumRasteriser(options: ChromiumRasteriserOptions): Rasteriser {
  const launch = options.launch ?? launchRasterSession(options.executablePath);
  const guard: GuardOptions = {
    sample: options.sampleTreeRss !== undefined ? options.sampleTreeRss : defaultTreeSampler(),
    capMb: options.rssCapMb ?? config.chromiumRssCapMb,
    deadlineMs: options.deadlineMs ?? RASTER_TIMEOUT_MS,
    closeTimeoutMs: options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
    intervalMs: options.sampleIntervalMs ?? RSS_SAMPLE_INTERVAL_MS,
    memoryError: (capMb) => new SpecRenderError('render_memory', `Chromium tree over ${capMb}MB`),
    timeoutError: (ms) => new SpecRenderError('render_timeout', `rasterise over ${ms}ms`),
  };
  return (pdf, select, signal) => runGuarded(launch, signal, guard, (s) => s.rasterise(pdf, select));
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export interface LocalPageRendererOptions {
  sofficePath: string;
  chromiumPath: string;
  /** Test seams. Production uses the defaults. */
  spawn?: SpawnSoffice;
  killTree?: (child: SofficeChild) => void;
  rasterise?: Rasteriser;
  /** Where the per-run temp dir is created. Default: the OS temp dir. */
  tmpRoot?: string;
  sofficeDeadlineMs?: number;
}

export function createLocalPageRenderer(options: LocalPageRendererOptions): PageRenderer {
  const run: SofficeRun = {
    sofficePath: options.sofficePath,
    spawn: options.spawn ?? defaultSpawn,
    killTree: options.killTree ?? killProcessTree,
    deadlineMs: options.sofficeDeadlineMs ?? SOFFICE_TIMEOUT_MS,
  };
  const rasterise = options.rasterise ?? createChromiumRasteriser({ executablePath: options.chromiumPath });
  const tmpRoot = options.tmpRoot ?? tmpdir();

  return async (file, signal, renderOptions = {}) => {
    signal.throwIfAborted();
    const pdf =
      file.format === 'pdf' ? file.bytes : await convertToPdf(run, tmpRoot, file.format, file.bytes, signal);
    const flagged = renderOptions.flaggedPages ?? [];
    return rasterise(pdf, (pageCount) => selectPages(pageCount, flagged), signal);
  };
}
