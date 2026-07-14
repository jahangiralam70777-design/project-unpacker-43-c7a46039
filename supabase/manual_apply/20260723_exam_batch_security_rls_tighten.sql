-- =====================================================================
-- Exam Batch — Security & Realtime tightening (2026-07-23)
-- =====================================================================
-- Context
--   The initial exam-batch module (20260710_exam_batch_module.sql) shipped
--   with `FOR SELECT TO authenticated USING (true)` on four tables:
--     • exam_batch_session_subjects
--     • exam_batch_leaderboards
--     • exam_batch_leaderboard_entries
--     • exam_batch_countdown
--   That let any signed-in user read every session's subjects, every
--   exam's leaderboard rankings, and the global countdown directly via
--   PostgREST — bypassing the app's server-function enrollment gating.
--
--   This migration:
--     1. Adds a SECURITY DEFINER helper `has_exam_batch_enrollment(uuid)`
--        that returns true iff auth.uid() has an approved, non-removed
--        enrollment for the given session (STABLE, safe to use in RLS).
--     2. Adds `has_any_exam_batch_enrollment()` for the countdown
--        singleton (no session_id column to scope by).
--     3. Drops the four USING(true) policies and recreates them scoped
--        to (admin OR enrolled). Admin bypass keeps working through the
--        existing `manage_content` permission check.
--     4. Adds a supporting index on exam_batch_enrollments to keep the
--        RLS predicate lookup O(1).
--
--   Historical migrations are NEVER edited — this file is standalone
--   and idempotent.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Helper functions (SECURITY DEFINER, STABLE)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_exam_batch_enrollment(_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.exam_batch_enrollments e
     WHERE e.session_id = _session_id
       AND e.user_id    = auth.uid()
       AND e.status     = 'approved'
       AND e.removed    = false
  );
$$;

CREATE OR REPLACE FUNCTION public.has_any_exam_batch_enrollment()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.exam_batch_enrollments e
     WHERE e.user_id = auth.uid()
       AND e.status  = 'approved'
       AND e.removed = false
  );
$$;

REVOKE ALL ON FUNCTION public.has_exam_batch_enrollment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_exam_batch_enrollment(uuid)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_any_exam_batch_enrollment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_any_exam_batch_enrollment()
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Supporting index for the RLS predicate
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS exam_batch_enrollments_user_session_approved_idx
  ON public.exam_batch_enrollments (user_id, session_id)
  WHERE status = 'approved' AND removed = false;

-- ---------------------------------------------------------------------
-- 3. Tighten SELECT policies
-- ---------------------------------------------------------------------

-- exam_batch_session_subjects ------------------------------------------
DROP POLICY IF EXISTS exam_batch_session_subjects_read
  ON public.exam_batch_session_subjects;

CREATE POLICY exam_batch_session_subjects_read
  ON public.exam_batch_session_subjects
  FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'manage_content')
    OR public.has_exam_batch_enrollment(session_id)
  );

-- exam_batch_leaderboards ---------------------------------------------
DROP POLICY IF EXISTS exam_batch_leaderboards_read
  ON public.exam_batch_leaderboards;

CREATE POLICY exam_batch_leaderboards_read
  ON public.exam_batch_leaderboards
  FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'manage_content')
    OR public.has_exam_batch_enrollment(session_id)
  );

-- exam_batch_leaderboard_entries --------------------------------------
-- Entries have no direct session_id; resolve via parent leaderboards row.
DROP POLICY IF EXISTS exam_batch_leaderboard_entries_read
  ON public.exam_batch_leaderboard_entries;

CREATE POLICY exam_batch_leaderboard_entries_read
  ON public.exam_batch_leaderboard_entries
  FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'manage_content')
    OR EXISTS (
      SELECT 1
        FROM public.exam_batch_leaderboards lb
       WHERE lb.exam_id = exam_batch_leaderboard_entries.exam_id
         AND public.has_exam_batch_enrollment(lb.session_id)
    )
  );

-- exam_batch_countdown -------------------------------------------------
-- Singleton table (no session_id). Restrict to admins and users who have
-- at least one approved enrollment — the countdown is meaningful only
-- to active exam-batch students.
DROP POLICY IF EXISTS exam_batch_countdown_read
  ON public.exam_batch_countdown;

CREATE POLICY exam_batch_countdown_read
  ON public.exam_batch_countdown
  FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'manage_content')
    OR public.has_any_exam_batch_enrollment()
  );

COMMIT;