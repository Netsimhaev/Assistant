import type { PromptIo } from './prompt-io.js';

/**
 * Reads one line from stdin without echoing it to the terminal.
 *
 * Node has no built-in masked-input API, so this uses the standard trick
 * every terminal password prompt relies on: put stdin into raw mode and
 * consume keystrokes one at a time, so the terminal driver never gets the
 * chance to echo them back. `readline`'s own line-reading always echoes —
 * it is built for visible input — so it cannot be reused here.
 *
 * When stdin is not a TTY (piped input, a test harness, CI), raw mode is
 * not available at all — there is no terminal driver to suppress in the
 * first place. In that case this simply reads a line; nothing is echoed
 * because there is no terminal rendering keystrokes to begin with, but the
 * distinction is stated here plainly rather than silently pretended away.
 * An implementation that *claims* masking it cannot actually provide would
 * be worse than one that is honest about the gap.
 */
function readSecret(promptText: string): Promise<string> {
  process.stdout.write(promptText);
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    // No raw mode is ever entered on this path, so there is nothing for a
    // stray error here to leave stuck — unlike the TTY branch below, an
    // error simply rejects with nothing further to undo.
    return new Promise((resolve, reject) => {
      let buffer = '';
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8');
        const newlineAt = buffer.indexOf('\n');
        if (newlineAt !== -1) {
          stdin.removeListener('data', onData);
          stdin.removeListener('error', onError);
          stdin.pause();
          resolve(buffer.slice(0, newlineAt).replace(/\r$/, ''));
        }
      };
      const onError = (err: Error): void => {
        stdin.removeListener('data', onData);
        stdin.pause();
        reject(err);
      };
      stdin.resume();
      stdin.on('data', onData);
      stdin.on('error', onError);
    });
  }

  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let input = '';

    // Restores stdin to the state it was in before this prompt touched it —
    // out of raw mode, listeners removed, paused. Every exit from this
    // promise (a finished line, Ctrl-D, Ctrl-C, or a stray stdin error) must
    // call this before doing anything else, or the terminal is left in raw
    // mode with echo off after the prompt — or the whole process — is gone.
    //
    // A `finally` cannot do this job here: the Ctrl-C path ends by calling
    // `process.exit`, which tears the process down immediately rather than
    // unwinding the call stack, so any code sitting after a `try` around
    // this logic would simply never run. Centralising the restore in one
    // function that every exit calls explicitly, before it does anything
    // else, is what makes a new exit path added later have to go out of its
    // way to skip it — the way the Ctrl-C path originally did by calling
    // `process.exit` directly with no cleanup at all.
    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.removeListener('error', onError);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onData = (char: string): void => {
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl-D
          cleanup();
          process.stdout.write('\n');
          resolve(input);
          break;
        case '\u0003': // Ctrl-C -- honour the interrupt instead of swallowing it
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
          break;
        case '\u007f': // Backspace (most terminals)
        case '\b': // Backspace (some Windows terminals)
          input = input.slice(0, -1);
          break;
        default:
          input += char;
          break;
      }
    };

    // A stray error on stdin mid-prompt (the underlying fd closing
    // unexpectedly, for instance) has no sensible "input" to resolve with
    // and no human left to re-prompt. Restoring the terminal first and then
    // rejecting is the honest response: the caller -- and, if uncaught, the
    // process itself -- fails loudly, but it does not fail with the
    // terminal stuck in raw mode and echo off, which is the one outcome
    // this function exists to prevent.
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    stdin.on('data', onData);
    stdin.on('error', onError);
  });
}

export const nodePromptIo: PromptIo = {
  readSecret,
  print: (text) => console.log(text),
  error: (text) => console.error(text),
};
