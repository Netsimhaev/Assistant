/**
 * A failure that came from the channel rather than from the gate.
 *
 * Thrown across the `perform` boundary because that callback's contract is a
 * value or a throw; `executeStep` catches it and turns it back into an
 * outcome, so nothing escapes to the caller unrecorded.
 *
 * Its own module rather than living beside either end of that boundary:
 * `run-plan.ts` throws it and `execute.ts` catches it, while `run-plan.ts`
 * already imports `executeStep` from `execute.ts`. Declaring it in either file
 * makes the two import each other.
 */
export class StepChannelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'StepChannelError';
  }
}
