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
