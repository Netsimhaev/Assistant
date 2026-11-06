import { describe, expect, it } from 'vitest';
import { createChromiumPrinter, treeRssBytes, type BrowserSession, type ProcReader } from './chromium.js';
import { SpecRenderError } from './render-error.js';

const PDF = Buffer.from('%PDF-1.7\n');
const MB = 1024 * 1024;

interface Probe {
  killed: number;
  closed: number;
  printed: number;
}

function session(probe: Probe, over: Partial<BrowserSession> = {}): BrowserSession {
  return {
    pid: 4242,
    print: async () => {
      probe.printed += 1;
      return PDF;
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
const signal = () => new AbortController().signal;

describe('createChromiumPrinter', () => {
  it('prints and closes the browser on the happy path', async () => {
    const probe: Probe = { killed: 0, closed: 0, printed: 0 };
    const printer = createChromiumPrinter({ executablePath: 'x', launch: async () => session(probe), sampleTreeRss: async () => 10 * MB });
    expect(await printer('<html></html>', signal(), { footerTemplate: '' })).toBe(PDF);
    expect(probe).toEqual({ killed: 0, closed: 1, printed: 1 });
  });

  it('an over-cap tree RSS kills the process tree and throws pdf_memory', async () => {
    const probe: Probe = { killed: 0, closed: 0, printed: 0 };
    const samples: number[] = [];
    const printer = createChromiumPrinter({
      executablePath: 'x',
      rssCapMb: 100,
      sampleIntervalMs: 5,
      launch: async () => session(probe, { print: never }),
      sampleTreeRss: async (pid) => {
        samples.push(pid);
        return 101 * MB;
      },
    });
    const err = await printer('<html></html>', signal(), { footerTemplate: '' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecRenderError);
    expect((err as SpecRenderError).code).toBe('pdf_memory');
    expect(samples[0]).toBe(4242);
    expect(probe.killed).toBeGreaterThanOrEqual(1);
  });

  it('a reading under the cap does not kill', async () => {
    const probe: Probe = { killed: 0, closed: 0, printed: 0 };
    let sampled = 0;
    const printer = createChromiumPrinter({
      executablePath: 'x',
      rssCapMb: 100,
      sampleIntervalMs: 2,
      launch: async () =>
        session(probe, {
          print: async () => {
            await new Promise((r) => setTimeout(r, 30));
            return PDF;
          },
        }),
      sampleTreeRss: async () => {
        sampled += 1;
        return 99 * MB;
      },
    });
    expect(await printer('<html></html>', signal(), { footerTemplate: '' })).toBe(PDF);
    expect(sampled).toBeGreaterThan(0);
    expect(probe.killed).toBe(0);
  });

  it('skips a watchdog tick while the previous /proc sample is still running', async () => {
    const probe: Probe = { killed: 0, closed: 0, printed: 0 };
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const printer = createChromiumPrinter({
      executablePath: 'x',
      sampleIntervalMs: 2,
      launch: async () =>
        session(probe, {
          print: async () => {
            await new Promise((r) => setTimeout(r, 80));
            return PDF;
          },
        }),
      sampleTreeRss: async () => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlight -= 1;
        return 0;
      },
    });
    expect(await printer('<html></html>', signal(), { footerTemplate: '' })).toBe(PDF);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBe(1);
  });

  it('a launch that hangs is rejected within the one deadline, and a late browser is killed', async () => {
    const probe: Probe = { killed: 0, closed: 0, printed: 0 };
    let resolveLaunch: (s: BrowserSession) => void = () => undefined;
    const printer = createChromiumPrinter({
      executablePath: 'x',
      deadlineMs: 50,
      launch: () => new Promise<BrowserSession>((r) => (resolveLaunch = r)),
      sampleTreeRss: async () => 0,
    });
    const started = Date.now();
    await expect(printer('<html></html>', signal(), { footerTemplate: '' })).rejects.toThrow(/50/);
    expect(Date.now() - started).toBeLessThan(1_000);
    resolveLaunch(session(probe));
    await new Promise((r) => setTimeout(r, 10));
    expect(probe.killed).toBe(1);
    expect(probe.printed).toBe(0);
  });

  it('a hung print is killed at the deadline', async () => {
    const probe: Probe = { killed: 0, closed: 0, printed: 0 };
    const printer = createChromiumPrinter({
      executablePath: 'x',
      deadlineMs: 40,
      closeTimeoutMs: 10,
      launch: async () => session(probe, { print: never, close: never }),
      sampleTreeRss: async () => 0,
    });
    await expect(printer('<html></html>', signal(), { footerTemplate: '' })).rejects.toThrow();
    expect(probe.killed).toBeGreaterThanOrEqual(1);
  });

  it('a close that hangs is bounded and falls back to kill', async () => {
    const probe: Probe = { killed: 0, closed: 0, printed: 0 };
    const printer = createChromiumPrinter({
      executablePath: 'x',
      closeTimeoutMs: 20,
      launch: async () => session(probe, { close: never }),
      sampleTreeRss: async () => 0,
    });
    const started = Date.now();
    expect(await printer('<html></html>', signal(), { footerTemplate: '' })).toBe(PDF);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(probe.killed).toBe(1);
  });

  it('an abort right after launch stops before printing', async () => {
    const probe: Probe = { killed: 0, closed: 0, printed: 0 };
    const ctl = new AbortController();
    const printer = createChromiumPrinter({
      executablePath: 'x',
      launch: async () => {
        ctl.abort(new Error('stop'));
        return session(probe);
      },
      sampleTreeRss: async () => 0,
    });
    await expect(printer('<html></html>', ctl.signal, { footerTemplate: '' })).rejects.toThrow('stop');
    expect(probe.printed).toBe(0);
    expect(probe.closed + probe.killed).toBeGreaterThanOrEqual(1);
  });
});

describe('treeRssBytes', () => {
  it('sums VmRSS over the browser and every descendant, by ppid', async () => {
    const procs: Record<string, { ppid: number; kb: number }> = {
      '100': { ppid: 1, kb: 1000 },
      '101': { ppid: 100, kb: 200 },
      '102': { ppid: 101, kb: 30 },
      '200': { ppid: 1, kb: 999999 },
    };
    const reader: ProcReader = {
      list: async () => [...Object.keys(procs), 'self', 'meminfo'],
      stat: async (pid) => `${pid} (chrome (renderer) x) S ${procs[pid]!.ppid} 1 1`,
      status: async (pid) => `Name:\tchrome\nVmRSS:\t   ${procs[pid]!.kb} kB\n`,
    };
    expect(await treeRssBytes(100, reader)).toBe((1000 + 200 + 30) * 1024);
  });
});
