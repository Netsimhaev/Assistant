-- 077_external_systems.sql
--
-- Stage D (external systems): staff drafts of system definitions, the fields
-- read from a system for a job, events received or scanned, a content-free
-- call log, and per-system state. Migration 068 does not cover tables added
-- after it, so RLS is enabled here for each.

CREATE TABLE external_system_drafts (
    business_id       text        NOT NULL,
    system_id         text        NOT NULL,
    definition        jsonb       NOT NULL,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by_staff  text        NOT NULL,
    PRIMARY KEY (business_id, system_id)
);

CREATE TABLE external_reads (
    business_id text        NOT NULL,
    read_id     text        NOT NULL,
    job_id      text        NOT NULL,
    step_id     text        NOT NULL,
    system_id   text        NOT NULL,
    operation   text        NOT NULL,
    fields      jsonb       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, read_id)
);
CREATE INDEX external_reads_job ON external_reads (business_id, job_id);

CREATE TABLE external_events (
    business_id text        NOT NULL,
    event_id    text        NOT NULL,
    system_id   text        NOT NULL,
    source      text        NOT NULL CHECK (source IN ('webhook', 'scan')),
    event_type  text        NOT NULL,
    item_hash   text        NOT NULL,
    fields      jsonb       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    curated_at  timestamptz,
    PRIMARY KEY (business_id, event_id),
    CONSTRAINT external_events_one_per_item UNIQUE (business_id, system_id, item_hash)
);

-- Content-free on purpose: system, time and outcome only.
CREATE TABLE external_calls (
    business_id text        NOT NULL,
    system_id   text        NOT NULL,
    at          timestamptz NOT NULL DEFAULT now(),
    outcome     text        NOT NULL
);
CREATE INDEX external_calls_day ON external_calls (business_id, system_id, at);

CREATE TABLE external_system_state (
    business_id      text        NOT NULL,
    system_id        text        NOT NULL,
    last_scan_at     timestamptz,
    rejected_hooks   integer     NOT NULL DEFAULT 0,
    last_rejected_at timestamptz,
    PRIMARY KEY (business_id, system_id)
);

ALTER TABLE external_system_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_system_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_system_drafts
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());

ALTER TABLE external_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_reads
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());

ALTER TABLE external_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_events
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());

ALTER TABLE external_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_calls
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());

ALTER TABLE external_system_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_system_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_system_state
    USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());

-- NULL = the server default; 0 = off for this business (read in a later task).
ALTER TABLE business_runtime_settings ADD COLUMN external_curation_per_day integer;
