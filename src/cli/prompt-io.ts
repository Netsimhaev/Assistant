/**
 * Shared I/O abstraction for the local recovery commands (`owner:create`,
 * `owner:password`).
 *
 * Both commands take this as a parameter instead of touching stdin/stdout
 * directly, so tests can drive `run(argv, io)` with a fake that supplies
 * canned answers and records what was printed — no real terminal, no child
 * process, no TTY.
 */
export interface PromptIo {
  /**
   * Writes `promptText`, then reads one line of input without echoing it
   * back — this is how a secret (a new password) is collected. See
   * `node-prompt-io.ts` for what "without echoing" means in practice, and
   * where that guarantee does and does not hold.
   */
  readSecret(promptText: string): Promise<string>;
  /** A normal, non-secret line of output. */
  print(text: string): void;
  /** An error line — kept separate from `print` so a fake `io` can assert on it. */
  error(text: string): void;
}
