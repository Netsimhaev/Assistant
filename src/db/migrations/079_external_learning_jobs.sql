-- 079_external_learning_jobs.sql
--
-- Stage D, Task 12 fix round 1: a positive record of every learning job over
-- external events — which system it learned for, and when (if) it failed.
--
-- Why a table and not the claimed-events marker (`external_events.curation_job_id`):
-- a claim is given back when the curator was never reached, so the marker
-- vanishes exactly on the failures the digest must recognise as learning (not
-- as a failed instruction of the owner's) and that `/systems` must show.
-- Ids and a timestamp only — no content, nothing about a person.

CREATE TABLE external_learning_jobs (
    business_id text        NOT NULL,
    job_id      text        NOT NULL,
    system_id   text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    failed_at   timestamptz,
    PRIMARY KEY (business_id, job_id)
);
CREATE INDEX external_learning_jobs_failed
    ON external_learning_jobs (business_id, system_id, failed_at)
    WHERE failed_at IS NOT NULL;

ALTER TABLE external_learning_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_learning_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_learning_jobs
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());
