-- A step result is now one of two different facts, and conflating them let a
-- re-plan place a second real order.
--
-- `completed` — the step finished and we know it. `external_id` is the
-- provider's handle on what it created.
--
-- `unknown` — the call was dispatched and nothing authoritative came back.
-- `adapter_timeout` is the case: `callWithDeadline` gives up on a call that
-- outlasted the deadline, and that call may or may not have landed at the far
-- end. An adapter's own `retryable: true` is a claim that nothing was created
-- (see `AdapterCall`), and adapters honour it — the mail adapter deliberately
-- classifies an ambiguous post-DATA failure as NON-retryable for this reason.
-- A deadline the orchestrator enforced from outside carries no such claim.
--
-- The two readers of this table filter differently, on purpose:
--
--   * `completedSteps` takes only `completed`, so a same-plan resume re-runs
--     an `unknown` step under the identical idempotency key — which is the
--     entire defence the timeout path is built on.
--   * `bindPlanToJob` counts rows of BOTH statuses, so a *different* plan
--     cannot be layered on top of an action whose outcome nobody knows. A
--     re-plan changes the step id or the input, and therefore changes the
--     idempotency key, so the far end's own deduplication cannot fire.
--
-- Existing rows are completions: nothing wrote an `unknown` row before now.
ALTER TABLE job_step_results
    ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';

ALTER TABLE job_step_results
    ADD CONSTRAINT job_step_result_status_known
        CHECK (status IN ('completed', 'unknown'));
