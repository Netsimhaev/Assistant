import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createChromiumRasteriser,
  createLocalPageRenderer,
  MAX_PAGE_IMAGES,
  pageImagesFrom,
  selectPages,
  type PageImages,
  type Rasteriser,
  type RasterSession,
  type SofficeChild,
  type SpawnSoffice,
} from './page-images.js';
import { SpecRenderError } from './render-error.js';

const PDF = Buffer.from('%PDF-1.7\nconverted\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

interface SpawnCall {
  command: string;
  args: string[];
  env: Record<string, string>;
  detached: boolean;
}

/** A fake soffice child. `behaviour` decides what it does once spawned. */
class FakeChild extends EventEmitter implements SofficeChild {
  pid: number | undefined = undefined;
  readonly stderr = new EventEmitter();
  readonly signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    setImmediate(() => this.emit('close', null, signal));
    return true;
  }
}

type Behaviour = 'convert' | 'fail' | 'hang' | 'exit-without-output';

function fakeSpawn(behaviour: Behaviour, calls: SpawnCall[], children: FakeChild[]): SpawnSoffice {
  return (command, args, options) => {
    calls.push({ command, args: [...args], env: { ...options.env }, detached: options.detached });
    const child = new FakeChild();
    children.push(child);
    const outdir = args[args.indexOf('--outdir') + 1] as string;
    setImmediate(() => {
      if (behaviour === 'hang') return;
      if (behaviour === 'fail') {
        child.stderr.emit('data', Buffer.from('SECRET body text'));
        child.emit('close', 1, null);
        return;
      }
      if (behaviour === 'exit-without-output') {
        child.emit('close', 0, null);
        return;
      }
      void writeFile(join(outdir, 'document.pdf'), PDF).then(() => child.emit('close', 0, null));
    });
    return child;
  };
}

interface RasterProbe {
  received: Buffer[];
  selected: number[][];
}

function fakeRasteriser(probe: RasterProbe, pageCount = 3, fail = false): Rasteriser {
  return async (pdf, select) => {
    probe.received.push(pdf);
    if (fail) throw new SpecRenderError('render_failed', 'rasterise');
    const pages = select(pageCount);
    probe.selected.push(pages);
    return { pages: pages.map(() => PNG), text: 'שורה', pageCount, textTruncated: false };
  };
}

const signal = () => new AbortController().signal;

let ROOT: string;
beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'page-images-test-'));
});
afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

function renderer(behaviour: Behaviour, calls: SpawnCall[], children: FakeChild[], probe: RasterProbe, over = {}) {
  return createLocalPageRenderer({
    sofficePath: '/opt/libreoffice/program/soffice',
    chromiumPath: '/usr/bin/chromium',
    spawn: fakeSpawn(behaviour, calls, children),
    rasterise: fakeRasteriser(probe),
    tmpRoot: ROOT,
    ...over,
  });
}

describe('createLocalPageRenderer — the LibreOffice child', () => {
  it('soffice is called with headless, norestore and a private profile dir', async () => {
    const calls: SpawnCall[] = [];
    const probe: RasterProbe = { received: [], selected: [] };
    const render = renderer('convert', calls, [], probe);
    const out = await render({ format: 'docx', bytes: Buffer.from('PK docx') }, signal());

    expect(calls).toHaveLength(1);
    const call = calls[0] as SpawnCall;
    expect(call.command).toBe('/opt/libreoffice/program/soffice');
    const outdir = call.args[call.args.indexOf('--outdir') + 1] as string;
    expect(outdir.startsWith(ROOT)).toBe(true);
    expect(call.args).toEqual([
      '--headless',
      '--norestore',
      `-env:UserInstallation=${pathToFileURL(join(outdir, 'profile')).href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      outdir,
      join(outdir, 'document.docx'),
    ]);
    // The converted PDF — not the docx bytes — reaches the rasteriser.
    expect(probe.received).toEqual([PDF]);
    expect(out.pageCount).toBe(3);
    expect(out.pages).toHaveLength(3);
  });

  it('env passed to the child is only PATH and HOME', async () => {
    const calls: SpawnCall[] = [];
    const probe: RasterProbe = { received: [], selected: [] };
    process.env['ANTHROPIC_API_KEY_PROBE'] = 'secret-should-not-leak';
    try {
      await renderer('convert', calls, [], probe)({ format: 'xlsx', bytes: Buffer.from('PK xlsx') }, signal());
    } finally {
      delete process.env['ANTHROPIC_API_KEY_PROBE'];
    }
    const call = calls[0] as SpawnCall;
    expect(Object.keys(call.env).sort()).toEqual(['HOME', 'PATH']);
    const outdir = call.args[call.args.indexOf('--outdir') + 1] as string;
    expect(call.env['HOME']).toBe(outdir);
    expect(call.env['PATH']).toBe(process.env['PATH'] ?? '');
    // Ran for real: the conversion reached the rasteriser.
    expect(probe.received).toHaveLength(1);
  });

  it("child exceeding the deadline is SIGKILLed and the renderer rejects with 'render_timeout'", async () => {
    const calls: SpawnCall[] = [];
    const children: FakeChild[] = [];
    const probe: RasterProbe = { received: [], selected: [] };
    const render = renderer('hang', calls, children, probe, { sofficeDeadlineMs: 40 });
    const started = Date.now();
    const err = await render({ format: 'pptx', bytes: Buffer.from('PK pptx') }, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecRenderError);
    expect((err as SpecRenderError).code).toBe('render_timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(children).toHaveLength(1);
    expect((children[0] as FakeChild).signals).toContain('SIGKILL');
    expect(probe.received).toHaveLength(0);
  });

  it('the child is spawned in its own process group, so the tree can be killed', async () => {
    const calls: SpawnCall[] = [];
    const probe: RasterProbe = { received: [], selected: [] };
    await renderer('convert', calls, [], probe)({ format: 'docx', bytes: Buffer.from('PK') }, signal());
    expect((calls[0] as SpawnCall).detached).toBe(process.platform !== 'win32');
  });

  it('temp dir is removed on success and on failure', async () => {
    const probe: RasterProbe = { received: [], selected: [] };

    await renderer('convert', [], [], probe)({ format: 'docx', bytes: Buffer.from('PK') }, signal());
    expect(await readdir(ROOT)).toEqual([]);

    const failed = await renderer('fail', [], [], probe)({ format: 'docx', bytes: Buffer.from('PK') }, signal()).catch(
      (e: unknown) => e,
    );
    expect((failed as SpecRenderError).code).toBe('render_failed');
    expect(await readdir(ROOT)).toEqual([]);

    const noOutput = await renderer('exit-without-output', [], [], probe)(
      { format: 'docx', bytes: Buffer.from('PK') },
      signal(),
    ).catch((e: unknown) => e);
    expect((noOutput as SpecRenderError).code).toBe('render_failed');
    expect(await readdir(ROOT)).toEqual([]);

    const timedOut = await renderer('hang', [], [], probe, { sofficeDeadlineMs: 20 })(
      { format: 'docx', bytes: Buffer.from('PK') },
      signal(),
    ).catch((e: unknown) => e);
    expect((timedOut as SpecRenderError).code).toBe('render_timeout');
    expect(await readdir(ROOT)).toEqual([]);

    const rasterFailed = await createLocalPageRenderer({
      sofficePath: 's',
      chromiumPath: 'c',
      spawn: fakeSpawn('convert', [], []),
      rasterise: fakeRasteriser(probe, 3, true),
      tmpRoot: ROOT,
    })({ format: 'docx', bytes: Buffer.from('PK') }, signal()).catch((e: unknown) => e);
    expect((rasterFailed as SpecRenderError).code).toBe('render_failed');
    expect(await readdir(ROOT)).toEqual([]);
  });

  it('a pdf is rasterised directly, with no LibreOffice child and no temp dir', async () => {
    const calls: SpawnCall[] = [];
    const probe: RasterProbe = { received: [], selected: [] };
    const out = await renderer('convert', calls, [], probe)({ format: 'pdf', bytes: PDF }, signal());
    expect(calls).toHaveLength(0);
    expect(probe.received).toEqual([PDF]);
    expect(out.pageCount).toBe(3);
    expect(await readdir(ROOT)).toEqual([]);
  });

  it('flagged pages are passed through to the selection', async () => {
    const probe: RasterProbe = { received: [], selected: [] };
    const render = createLocalPageRenderer({
      sofficePath: 's',
      chromiumPath: 'c',
      spawn: fakeSpawn('convert', [], []),
      rasterise: fakeRasteriser(probe, 30),
      tmpRoot: ROOT,
    });
    const out: PageImages = await render({ format: 'pdf', bytes: PDF }, signal(), { flaggedPages: [17] });
    expect(probe.selected).toEqual([[1, 17, 30]]);
    expect(out.pages).toHaveLength(3);
  });
});

describe('selectPages', () => {
  it('more than 10 pages → 10 images chosen first, last, flagged', () => {
    const chosen = selectPages(40, [12, 3, 3, 0, 41, 25, 2, 9, 30, 31, 5, 7, 8, 20]);
    expect(chosen).toHaveLength(MAX_PAGE_IMAGES);
    // First and last always; then flagged pages ascending, de-duplicated (0 and
    // 41 are out of range) until the cap — 25/30/31 do not fit. Page order out.
    expect(chosen).toEqual([1, 2, 3, 5, 7, 8, 9, 12, 20, 40]);
  });

  it('ten pages or fewer → every page, in order', () => {
    expect(selectPages(4, [3])).toEqual([1, 2, 3, 4]);
    expect(selectPages(10, [])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('more than 10 pages and nothing flagged → 10 pages spread evenly, first and last included', () => {
    expect(selectPages(11, [])).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);
    expect(selectPages(100, [])).toEqual([1, 12, 23, 34, 45, 56, 67, 78, 89, 100]);
  });

  it('ignores flags that are not whole page numbers', () => {
    expect(selectPages(20, [2.5, Number.NaN, -1, 4])).toEqual([1, 4, 20]);
  });
});

describe('createChromiumRasteriser', () => {
  const MB = 1024 * 1024;
  function session(probe: { killed: number; closed: number }, over: Partial<RasterSession> = {}): RasterSession {
    return {
      pid: 777,
      rasterise: async (_pdf, select) => {
        const pages = select(2);
        return { pages: pages.map(() => PNG), text: 'א', pageCount: 2, textTruncated: false };
      },
      close: async () => {
        probe.closed += 1;
      },
      kill: () => {
        probe.killed += 1;
      },
      ...over,
    };
  }
  const never = <T,>() => new Promise<T>(() => undefined);

  it('rasterises and closes the browser on the happy path', async () => {
    const probe = { killed: 0, closed: 0 };
    const rasterise = createChromiumRasteriser({ executablePath: 'x', launch: async () => session(probe), sampleTreeRss: null });
    const out = await rasterise(PDF, (n) => selectPages(n, []), signal());
    expect(out.pageCount).toBe(2);
    expect(out.pages).toHaveLength(2);
    expect(probe).toEqual({ killed: 0, closed: 1 });
  });

  it("a hung rasterise is killed at the deadline with 'render_timeout'", async () => {
    const probe = { killed: 0, closed: 0 };
    const rasterise = createChromiumRasteriser({
      executablePath: 'x',
      deadlineMs: 40,
      closeTimeoutMs: 10,
      launch: async () => session(probe, { rasterise: never, close: never }),
      sampleTreeRss: null,
    });
    const err = await rasterise(PDF, (n) => selectPages(n, []), signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecRenderError);
    expect((err as SpecRenderError).code).toBe('render_timeout');
    expect(probe.killed).toBeGreaterThanOrEqual(1);
  });

  it("an over-cap tree RSS kills the browser and fails with 'render_memory'", async () => {
    const probe = { killed: 0, closed: 0 };
    let sampled = 0;
    const rasterise = createChromiumRasteriser({
      executablePath: 'x',
      rssCapMb: 100,
      sampleIntervalMs: 5,
      launch: async () => session(probe, { rasterise: never }),
      sampleTreeRss: async (pid) => {
        sampled = pid;
        return 101 * MB;
      },
    });
    const err = await rasterise(PDF, (n) => selectPages(n, []), signal()).catch((e: unknown) => e);
    expect((err as SpecRenderError).code).toBe('render_memory');
    expect(sampled).toBe(777);
    expect(probe.killed).toBeGreaterThanOrEqual(1);
  });
});

describe('createLocalPageRenderer — review fixes', () => {
  it('a non-zero exit names the exit code and the stderr size, never stderr itself', async () => {
    const probe: RasterProbe = { received: [], selected: [] };
    const err = await renderer('fail', [], [], probe)({ format: 'docx', bytes: Buffer.from('PK') }, signal()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SpecRenderError);
    expect((err as SpecRenderError).code).toBe('render_failed');
    expect((err as SpecRenderError).where).toBe('soffice exit 1 (stderr 16 bytes)');
    expect((err as SpecRenderError).message).not.toContain('SECRET');
  });

  it('the leftover process group is reaped after the child exits on its own, and not after a timeout kill', async () => {
    const probe: RasterProbe = { received: [], selected: [] };
    const reaped: string[] = [];
    const reapGroup = () => {
      reaped.push('reap');
    };
    await renderer('convert', [], [], probe, { reapGroup })({ format: 'docx', bytes: Buffer.from('PK') }, signal());
    expect(reaped).toEqual(['reap']);

    await renderer('fail', [], [], probe, { reapGroup })({ format: 'docx', bytes: Buffer.from('PK') }, signal()).catch(
      () => undefined,
    );
    expect(reaped).toEqual(['reap', 'reap']);

    const children: FakeChild[] = [];
    const timedOut = await renderer('hang', [], children, probe, { reapGroup, sofficeDeadlineMs: 20 })(
      { format: 'docx', bytes: Buffer.from('PK') },
      signal(),
    ).catch((e: unknown) => e);
    expect((timedOut as SpecRenderError).code).toBe('render_timeout');
    expect((children[0] as FakeChild).signals).toContain('SIGKILL');
    expect(reaped).toEqual(['reap', 'reap']);
  });
});

describe('pageImagesFrom', () => {
  const item = (str: string, x: number, width: number) => ({ str, dir: 'ltr', transform: [10, 0, 0, 10, x, 700], width, height: 10 });

  it('flags textTruncated only when the PDF has more pages than the text was read from', () => {
    const fifty = pageImagesFrom({ pageCount: 50, pages: [[item('a', 36, 5)]] }, []);
    expect(fifty.textTruncated).toBe(false);
    const fiftyOne = pageImagesFrom({ pageCount: 51, pages: [[item('a', 36, 5)]] }, []);
    expect(fiftyOne.textTruncated).toBe(true);
    expect(fiftyOne.pageCount).toBe(51);
  });

  it('joins text with the production joiner and decodes the PNGs', () => {
    const out = pageImagesFrom(
      {
        pageCount: 1,
        pages: [
          [
            { str: 'שולחן מעוצב חדש', dir: 'rtl', transform: [10, 0, 0, 10, 300, 700], width: 80, height: 10 },
            item('₪', 266, 9),
            item('1,890', 274, 22),
          ],
        ],
      },
      [PNG.toString('base64')],
    );
    // The incoming joiner would read `1,890₪` here; the production joiner keeps the run.
    expect(out.text).toBe('שולחן מעוצב חדש ₪1,890');
    expect(out.pages).toEqual([PNG]);
  });
});
