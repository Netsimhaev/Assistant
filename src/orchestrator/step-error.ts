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
  /**
   * @param outcomeUnknown The call was dispatched and nothing authoritative
   * came back, so the far end may or may not have acted. Distinct from
   * `retryable`, which an adapter sets to claim that nothing was created —
   * `AdapterCall`'s contract, and the adapters honour it. Only a failure the
   * orchestrator imposed from outside the adapter (`adapter_timeout`) leaves
   * the outcome genuinely unknown, and that is what makes a re-plan on top of
   * this step unsafe: a re-plan changes the idempotency key by definition, so
   * the far end's own deduplication cannot save it.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'StepChannelError';
  }
}
