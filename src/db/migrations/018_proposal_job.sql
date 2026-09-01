-- Which job a proposal was made for
-- (docs/superpowers/specs/2026-09-01-signature-design.md §6).
--
-- `proposeForReading` has always received a jobId — it loads the job to derive
-- provenance from the stamped column — and then discarded it. A proposal that
-- does not remember which job it served cannot be traced back from anything
-- downstream, and the dashboard needs exactly that trace to know which document
-- an approval concerns.
--
-- Nullable, because rows written before this column existed have no job to
-- name and inventing one would be worse than admitting the gap. Every row
-- written from now on carries it.
ALTER TABLE proposals
    ADD COLUMN job_id TEXT REFERENCES jobs (job_id) ON DELETE SET NULL;

CREATE INDEX proposals_by_job_idx ON proposals (business_id, job_id);
