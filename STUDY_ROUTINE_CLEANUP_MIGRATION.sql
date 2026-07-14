-- =============================================================================
-- Study Routine — cleanup migration (idempotent, data-preserving)
--
-- Applies the two architecture changes:
--   1. Removes the Reminder feature from the schema (`reminder_minutes` column
--      on public.study_routines).
--   2. Confirms Study Routine is independent from Daily Progress — no
--      cross-table triggers, RPCs, or views ever existed, so no DB changes
--      are needed on that front. This block is included as a documented
--      no-op so operators can see the intent.
--
-- Safe to run on:
--   * a FRESH empty database (after STUDY_ROUTINE_MIGRATION.sql)
--   * a LIVE production database (no DROP TABLE, no TRUNCATE, no data loss)
-- Fully IDEMPOTENT — running twice must not fail.
--
-- Includes NO sample or demo data.
-- =============================================================================


-- ---------------------------------------------------------------------
-- 1. Drop the reminder column if present (Reminder feature removal)
-- ---------------------------------------------------------------------
ALTER TABLE IF EXISTS public.study_routines
  DROP COLUMN IF EXISTS reminder_minutes;


-- ---------------------------------------------------------------------
-- 2. Daily Progress independence — verification only (no-op)
--
-- The Study Routine module uses only these tables:
--     public.study_routines
--     public.study_routine_tasks
--     public.study_routine_settings
--     public.user_goals   (weekly/monthly study-minute targets only)
--
-- It does NOT read from, write to, or trigger anything on:
--     public.mcq_practice_progress
--     public.exam_attempts
--     public.attempt_answers
--     public.mcq_bookmarks
--     public.mcq_wrong_questions
-- (all of which back the Daily Progress module).
--
-- No triggers, foreign keys, or views bridge the two — the frontend cache
-- key `student-daily-progress` is likewise no longer invalidated by the
-- Study Routine hooks. This section is intentionally empty; it exists so
-- the intent is recorded next to the schema change.
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 3. Ask PostgREST to reload its schema cache so the dropped column is
--    picked up immediately on hosted Supabase.
-- ---------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- END — Study Routine cleanup migration.
-- =============================================================================
