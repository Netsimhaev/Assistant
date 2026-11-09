-- 061_meetings.sql
--
-- Calendar scheduling: the owner's meeting settings, the meetings the assistant
-- creates / moves / updates / cancels, and the tentative holds it places before
-- the owner approves. `meetings` and `meeting_holds` carry a client's name,
-- email, phone and notes, so both are erasure targets (wired in a later task).
-- No FK on `job_id`: a job is scrubbed, never deleted (like 047, 053, 055).
CREATE TABLE meeting_settings (
  business_id text PRIMARY KEY,
  location_kind text NOT NULL CHECK (location_kind IN ('travel','fixed','mixed')),
  fixed_address text,
  gap_minutes int NOT NULL DEFAULT 30 CHECK (gap_minutes BETWEEN 0 AND 240),
  default_duration_minutes int NOT NULL DEFAULT 60 CHECK (default_duration_minutes BETWEEN 5 AND 600),
  work_start time, work_end time,              -- NULL: charter businessHours, else 09:00-18:00
  read_calendar_ids text[] NOT NULL DEFAULT '{}', -- '{}' = all calendars in the account
  write_calendar_id text,                       -- NULL = the primary calendar
  reminder_hours int NOT NULL DEFAULT 24, reminder_hours_soon int NOT NULL DEFAULT 2,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (location_kind <> 'fixed' OR fixed_address IS NOT NULL),
  CHECK ((work_start IS NULL) = (work_end IS NULL) AND (work_start IS NULL OR work_start < work_end)));
CREATE TABLE meetings (
  meeting_id text PRIMARY KEY, business_id text NOT NULL, job_id text NOT NULL, step_id text NOT NULL,
  calendar_id text NOT NULL, event_id text,           -- NULL until the step completes (create without hold)
  operation text NOT NULL CHECK (operation IN ('create','move','update','cancel')),
  client_name text NOT NULL, client_email text, client_email_verified boolean NOT NULL DEFAULT false,
  client_phone text, internal_note text, start_at timestamptz, end_at timestamptz,
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','active','abandoned','done')),
  response text NOT NULL DEFAULT 'needs_action' CHECK (response IN ('needs_action','accepted','declined','tentative','not_updated')),
  response_at timestamptz, reminder_claimed_at timestamptz, reminder_job_id text,
  declined_notified_at timestamptz, unanswered_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, job_id, step_id));
CREATE TABLE meeting_holds (
  hold_id text PRIMARY KEY, business_id text NOT NULL, job_id text NOT NULL,
  calendar_id text NOT NULL, event_id text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held','converted','released')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (business_id, event_id));
