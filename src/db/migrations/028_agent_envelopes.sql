CREATE TABLE agent_envelopes (
    business_id       TEXT        NOT NULL,
    envelope_id       TEXT        NOT NULL,
    correlation_id    TEXT        NOT NULL,
    causal_chain      TEXT[]      NOT NULL,
    from_agent        TEXT        NOT NULL,
    to_agent          TEXT        NOT NULL,
    kind              TEXT        NOT NULL,
    intent            TEXT        NOT NULL,
    payload           JSONB       NOT NULL,
    context_refs      JSONB       NOT NULL,
    context_refs_hash TEXT        NOT NULL,
    constraints       JSONB       NOT NULL,
    hops              INT         NOT NULL CHECK (hops >= 0 AND hops <= 6),
    idempotency_key   TEXT        NOT NULL,
    parent_job_id     TEXT        NOT NULL,
    child_job_id      TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (business_id, envelope_id),
    CONSTRAINT envelope_idempotency_unique UNIQUE (business_id, idempotency_key)
);

-- Guard 4: the quadruple, inside one correlation.
CREATE INDEX agent_envelopes_no_new_info_idx
    ON agent_envelopes (business_id, correlation_id, from_agent, to_agent, intent, context_refs_hash);

-- resumeDelegatedJobs: find the envelope of a child that just finished.
CREATE INDEX agent_envelopes_child_idx
    ON agent_envelopes (business_id, child_job_id) WHERE child_job_id IS NOT NULL;

CREATE TABLE verification_verdicts (
    business_id TEXT        NOT NULL,
    job_id      TEXT        NOT NULL,
    verdict     JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (business_id, job_id)
);

ALTER TABLE jobs ADD COLUMN awaiting_envelope_id TEXT;
