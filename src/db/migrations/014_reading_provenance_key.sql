-- `provenance` joins the reading dedupe key
-- (docs/superpowers/specs/2026-08-29-reading-comprehension-design.md §7.7, §8).
--
-- Migration 013 keyed a stored reading on
-- `(business_id, document_id, brief_hash, prompt_version)` and left
-- `provenance` as a stored-but-unmatched column. Intake dedupes documents on
-- `(business_id, sha256)`, so byte-identical files are one `documents` row
-- however they arrived — which made the gap reachable: read a document once
-- under `boss`, let the same bytes arrive later from an untrusted sender,
-- call `readDocument` with `unknown_external`, and the cache hands back the
-- row whose `provenance` says `boss`.
--
-- That is exactly what 013's own column comment forbids: nothing here may
-- raise a trust level. A reading made under one trust level is not an answer
-- to the same question asked under another — the question includes who the
-- material came from — so the trust level belongs in the key, next to the
-- brief and the prompt version.
--
-- The cost is one extra stored reading per document per distinct provenance.
-- That is the correct cost: the two readings are answers to two different
-- questions, and collapsing them was only ever cheap because the collapse
-- was in the permissive direction.

DROP INDEX document_readings_dedupe_idx;

CREATE UNIQUE INDEX document_readings_dedupe_idx
    ON document_readings (business_id, document_id, brief_hash, prompt_version, provenance);
