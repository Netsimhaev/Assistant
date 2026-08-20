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
    return new Promise((resolve) => {
      let buffer = '';
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8');
        const newlineAt = buffer.indexOf('\n');
        if (newlineAt !== -1) {
          stdin.removeListener('data', onData);
          stdin.pause();
          resolve(buffer.slice(0, newlineAt).replace(/\r$/, ''));
        }
      };
      stdin.resume();
      stdin.on('data', onData);
    });
  }

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let input = '';
    const onData = (char: string): void => {
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl-D
          stdin.removeListener('data', onData);
          stdin.setRawMode(wasRaw);
          stdin.pause();
          process.stdout.write('\n');
          resolve(input);
          break;
        case '\u0003': // Ctrl-C — honour the interrupt instead of swallowing it
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
    stdin.on('data', onData);
  });
}

export const nodePromptIo: PromptIo = {
  readSecret,
  print: (text) => console.log(text),
  error: (text) => console.error(text),
};
