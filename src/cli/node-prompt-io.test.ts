import { describe, expect, it, vi } from 'vitest';
import { nodePromptIo } from './node-prompt-io.js';

/**
 * Exercises the one property of `readSecret`'s Ctrl-C path that a real
 * terminal, not a return value, would show: the terminal must be taken out
 * of raw mode *before* the process exits, not left stuck echo-off after the
 * process is already gone.
 *
 * `process.stdin` in this (non-interactive) test environment is not a TTY —
 * it doesn't even carry a `setRawMode` method — so this test stands one up
 * itself: `isTTY` and `setRawMode` are defined as own properties for the
 * duration of the test and torn down in `finally`, whether the test passes
 * or throws. A stub left behind here would corrupt every other file that
 * happens to run after this one in the same process, which is a worse bug
 * than the one this test exists to catch.
 */
/**
 * The piped-input path, which is how every scripted install reaches these
 * commands — and where two bugs sat that no test caught, because every
 * existing test supplied a fake `PromptIo` instead of real stdin.
 *
 * `process.stdin` here is genuinely not a TTY, so these need no stubbing at
 * all: they emit on the real stream and let the real code read it.
 */
describe('nodePromptIo.readSecret — piped input', () => {
  /** Fails loudly instead of hanging the suite when a read never settles. */
  function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`read did not settle within ${ms}ms`)), ms),
      ),
    ]);
  }

  it('keeps the lines a single chunk delivered beyond the first', async () => {
    // `printf 'a\nb\n' | cmd` arrives as ONE data event carrying both
    // lines. The first read used to consume the chunk, hand back line one
    // and discard the rest — so the confirmation prompt waited forever for
    // an event that had already happened. `owner:create` hung on exactly
    // this, and reported it only as an unsettled top-level await.
    const first = nodePromptIo.readSecret('one: ');
    process.stdin.emit('data', Buffer.from('alpha\nbeta\n'));

    expect(await within(first)).toBe('alpha');
    // No second emit: the line must already be buffered.
    expect(await within(nodePromptIo.readSecret('two: '))).toBe('beta');
  });

  it('accepts a final line that arrives without a trailing newline', async () => {
    const read = nodePromptIo.readSecret('three: ');
    process.stdin.emit('data', Buffer.from('no-newline'));
    process.stdin.emit('end');

    expect(await within(read)).toBe('no-newline');
  });

  it('rejects when stdin closes with nothing left to give', async () => {
    const read = nodePromptIo.readSecret('four: ');
    process.stdin.emit('end');

    await expect(within(read)).rejects.toThrow(/stdin closed/);
  });
});

describe('nodePromptIo.readSecret — Ctrl-C on a TTY', () => {
  it('restores raw mode before the process exits', () => {
    const stdin = process.stdin;

    const savedIsTTY = Object.getOwnPropertyDescriptor(stdin, 'isTTY');
    const savedIsRaw = Object.getOwnPropertyDescriptor(stdin, 'isRaw');
    const savedSetRawMode = Object.getOwnPropertyDescriptor(stdin, 'setRawMode');

    const callOrder: string[] = [];

    try {
      Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(stdin, 'isRaw', { value: false, configurable: true, writable: true });
      Object.defineProperty(stdin, 'setRawMode', {
        value: (mode: boolean) => {
          callOrder.push(`setRawMode(${mode})`);
          return stdin;
        },
        configurable: true,
        writable: true,
      });

      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(((code?: string | number | null) => {
          callOrder.push(`exit(${code})`);
          return undefined as never;
        }) as unknown as (code?: string | number | null) => never);

      // `process.exit` is mocked to return instead of terminating, so this
      // promise is left deliberately pending — the interrupt handler never
      // calls resolve or reject on the Ctrl-C path (in real life the
      // process would already be gone). `callOrder` is what this test
      // reads, not the promise.
      void nodePromptIo.readSecret('secret: ');

      // Fires the same code path a real Ctrl-C keystroke would in raw
      // mode: the terminal driver hands the byte to the stream as data,
      // not as a SIGINT.
      stdin.emit('data', '\u0003');

      expect(exitSpy).toHaveBeenCalledWith(130);

      const restoreIndex = callOrder.indexOf('setRawMode(false)');
      const exitIndex = callOrder.indexOf('exit(130)');
      // This is the whole fix: the restore must happen strictly before the
      // exit, not merely somewhere in the same run.
      expect(restoreIndex).toBeGreaterThanOrEqual(0);
      expect(exitIndex).toBeGreaterThan(restoreIndex);
    } finally {
      stdin.removeAllListeners('data');
      stdin.removeAllListeners('error');
      vi.restoreAllMocks();

      if (savedIsTTY) Object.defineProperty(stdin, 'isTTY', savedIsTTY);
      else delete (stdin as { isTTY?: boolean }).isTTY;

      if (savedIsRaw) Object.defineProperty(stdin, 'isRaw', savedIsRaw);
      else delete (stdin as { isRaw?: boolean }).isRaw;

      if (savedSetRawMode) Object.defineProperty(stdin, 'setRawMode', savedSetRawMode);
      else delete (stdin as { setRawMode?: unknown }).setRawMode;
    }
  });
});
