/**
 * An `AbortController` that aborts when `signal` does — the shape the Agent
 * SDK's `query` takes (`options.abortController`), built from the plain
 * `AbortSignal` a deadline hands out. Already aborted in, aborted out.
 */
export function linkedAbortController(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal === undefined) return controller;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return controller;
  }
  signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  return controller;
}
