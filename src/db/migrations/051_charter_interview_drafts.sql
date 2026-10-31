-- 051_charter_interview_drafts.sql
--
-- Charter interview (spec 2026-10-31): the owner's answers to the setup
-- interview, saved one section at a time until they are frozen and turned into
-- a charter to sign. One row per business (`business_id` UNIQUE) — there is a
-- single draft in flight, never a history of them; the signed charter is the
-- history.
--
-- `answers` holds the sections answered so far, validated per section by the
-- store before every write (`src/charter/interview/draft-store.ts`).
-- `frozen_at` is set when the owner moves to review and cleared by any later
-- edit, so a frozen draft is always the one that was reviewed.
-- `base_charter_version` names the active charter an edit started from (NULL
-- for a first interview), written on insert only.
--
-- `answers` holds content about people — names, do-not-contact entries,
-- phone numbers — so the table is wired into erasure as a discovery source of
-- its own, by contact anchor (`erasure-plan.ts`). No foreign keys: the draft
-- belongs to the business, not to a job or a charter version.
CREATE TABLE charter_interview_drafts (
  draft_id             TEXT PRIMARY KEY,
  business_id          TEXT NOT NULL UNIQUE,
  answers              JSONB NOT NULL DEFAULT '{}',
  frozen_at            TIMESTAMPTZ,
  base_charter_version TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
