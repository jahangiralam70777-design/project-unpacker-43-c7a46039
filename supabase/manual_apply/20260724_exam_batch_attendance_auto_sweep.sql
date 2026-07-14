-- =============================================================================
-- Exam Batch — attendance "Present = submitted" + fully automatic auto-ban
-- =============================================================================
-- Two production issues fixed inside the Exam Batch module only:
--
--   1. "Present / Absent" definition. The previous RPC counted a student as
--      Present if they had ANY row in `exam_batch_attempts` for the exam
--      (including started-but-abandoned attempts). The product contract is:
--          Present = student SUBMITTED the exam before window_end.
--          Absent  = student did NOT submit before window_end.
--      The RPC is updated to filter attempts by terminal submitted statuses
--      only ('submitted','auto_submitted','timed_out','admin_closed').
--
--   2. Auto-ban was gated behind `has_permission(auth.uid(),'manage_content')`
--      and there was no scheduler, so it only fired when an admin manually
--      triggered the sweep. The contract is: when consecutive missed exams
--      reach the configured limit, the student must be banned automatically,
--      no admin action required. Two changes make it truly automatic:
--        a) The permission gate now allows `auth.uid() IS NULL` so pg_cron /
--           service_role can invoke the RPC without a JWT.
--        b) A new sweep function `exam_batch_attendance_sweep_ended_exams()`
--           iterates every eligible exam whose window has ended and processes
--           it. A guarded pg_cron entry runs the sweep every minute.
--
-- Nothing outside the Exam Batch module is touched. Every write is bounded
-- to `exam_batch_*` tables and every idempotency guarantee of the existing
-- system is preserved (processed ledger, per-exam advisory lock, ON CONFLICT).
-- =============================================================================

set search_path = public;

-- 1) Updated RPC ---------------------------------------------------------------
create or replace function public.exam_batch_attendance_process_exam(_exam_id uuid)
returns table (processed int, auto_banned int, reset int)
language plpgsql security definer set search_path = public
as $$
declare
  v_exam       public.exam_batch_exams%rowtype;
  v_settings   jsonb;
  v_limit      int;
  v_auto       boolean;
  v_processed  int := 0;
  v_banned     int := 0;
  v_reset      int := 0;
  v_row        record;
  v_prev       int;
  v_new        int;
  v_should_ban boolean;
  v_duration   int;
  v_ban_until  timestamptz;
begin
  -- Permission gate: an admin (manage_content) OR a system caller
  -- (pg_cron / service_role, where auth.uid() is null) may invoke this RPC.
  if auth.uid() is not null
     and not public.has_permission(auth.uid(), 'manage_content') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Serialise concurrent sweeps of the same exam.
  perform pg_advisory_xact_lock(hashtext('exam_batch:attendance:' || _exam_id::text));

  select * into v_exam from public.exam_batch_exams where id = _exam_id;
  if not found
     or not v_exam.is_published
     or v_exam.is_hidden
     or v_exam.is_archived
     or v_exam.status <> 'active'
     or now() <= v_exam.window_end then
    return query select 0,0,0;
    return;
  end if;

  select coalesce(value->'attendance', '{}'::jsonb) into v_settings
    from public.exam_batch_settings where id = 'singleton';
  v_limit    := coalesce((v_settings->>'consecutiveMissLimit')::int, 0);
  v_auto     := coalesce((v_settings->>'autoBanEnabled')::boolean, false);
  v_duration := coalesce((v_settings->>'autoBanDurationDays')::int, 0);

  for v_row in
    insert into public.exam_batch_attendance_processed (user_id, session_id, subject_id, exam_id)
    select e.user_id, v_exam.session_id, v_exam.subject_id, _exam_id
      from public.exam_batch_enrollments e
     where e.session_id = v_exam.session_id
       and e.status     = 'approved'
       and e.removed    = false
       and exists (
             select 1 from public.exam_batch_enrollment_subjects es
              where es.enrollment_id = e.id and es.subject_id = v_exam.subject_id)
       -- Present = SUBMITTED (in any terminal submitted status). Anything else
       -- (no row, or in_progress with no submission) counts as Absent.
       and not exists (
             select 1 from public.exam_batch_attempts a
              where a.exam_id = _exam_id
                and a.user_id = e.user_id
                and a.status in ('submitted','auto_submitted','timed_out','admin_closed'))
    on conflict (user_id, session_id, subject_id, exam_id) do nothing
    returning user_id
  loop
    v_processed := v_processed + 1;

    select consecutive_missed_count into v_prev
      from public.exam_batch_attendance_state
     where user_id = v_row.user_id
       and session_id = v_exam.session_id
       and subject_id = v_exam.subject_id;
    v_new := coalesce(v_prev, 0) + 1;

    v_should_ban := v_auto and v_limit > 0 and v_new >= v_limit;
    v_ban_until  := case
                      when v_should_ban and v_duration > 0
                      then now() + make_interval(days => v_duration)
                    end;

    insert into public.exam_batch_attendance_state (
      user_id, session_id, subject_id,
      consecutive_missed_count, last_missed_exam_id, last_missed_at,
      banned, banned_at, banned_reason, banned_until, auto_banned, updated_at)
    values (
      v_row.user_id, v_exam.session_id, v_exam.subject_id,
      v_new, _exam_id, now(),
      v_should_ban,
      case when v_should_ban then now() end,
      case when v_should_ban then 'Auto-ban: consecutive missed exams' end,
      v_ban_until,
      v_should_ban, now())
    on conflict (user_id, session_id, subject_id) do update set
      consecutive_missed_count = v_new,
      last_missed_exam_id      = _exam_id,
      last_missed_at           = now(),
      banned                   = public.exam_batch_attendance_state.banned or v_should_ban,
      banned_at                = coalesce(public.exam_batch_attendance_state.banned_at,
                                          case when v_should_ban then now() end),
      banned_reason            = coalesce(public.exam_batch_attendance_state.banned_reason,
                                          case when v_should_ban then 'Auto-ban: consecutive missed exams' end),
      banned_until             = coalesce(public.exam_batch_attendance_state.banned_until, v_ban_until),
      auto_banned              = public.exam_batch_attendance_state.auto_banned or v_should_ban,
      updated_at               = now();

    insert into public.exam_batch_attendance_events (
      user_id, session_id, subject_id, kind, exam_id, previous_count, new_count)
    values (v_row.user_id, v_exam.session_id, v_exam.subject_id,
            'missed', _exam_id, v_prev, v_new);

    if v_should_ban and (v_prev is null or v_prev < v_limit) then
      v_banned := v_banned + 1;
      insert into public.exam_batch_attendance_events (
        user_id, session_id, subject_id, kind, exam_id, previous_count, new_count, reason)
      values (v_row.user_id, v_exam.session_id, v_exam.subject_id,
              'auto_ban', _exam_id, v_prev, v_new,
              'Auto-ban: consecutive missed exams');
      insert into public.exam_batch_ban_history (
        user_id, session_id, subject_id, ban_type, action, reason)
      values (v_row.user_id, v_exam.session_id, v_exam.subject_id,
              'auto', 'ban', 'Auto-ban: consecutive missed exams');
    end if;
  end loop;

  return query select v_processed, v_banned, v_reset;
end
$$;

revoke execute on function public.exam_batch_attendance_process_exam(uuid) from public, anon;
grant  execute on function public.exam_batch_attendance_process_exam(uuid) to authenticated, service_role;


-- 2) Sweep function ------------------------------------------------------------
-- Iterates every eligible exam whose window has ended and drives the RPC.
-- Idempotent: the processed-ledger unique key + advisory lock prevent double
-- counting when the sweep re-runs.
create or replace function public.exam_batch_attendance_sweep_ended_exams()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  r      record;
  v_done int := 0;
begin
  for r in
    select e.id
      from public.exam_batch_exams e
     where e.is_published
       and not e.is_hidden
       and not e.is_archived
       and e.status = 'active'
       and e.window_end < now()
     order by e.window_end asc
     limit 500
  loop
    begin
      perform public.exam_batch_attendance_process_exam(r.id);
      v_done := v_done + 1;
    exception when others then
      raise warning 'exam_batch_attendance_sweep skipped exam %: %', r.id, sqlerrm;
    end;
  end loop;
  return v_done;
end
$$;

revoke execute on function public.exam_batch_attendance_sweep_ended_exams() from public, anon, authenticated;
grant  execute on function public.exam_batch_attendance_sweep_ended_exams() to service_role;


-- 3) pg_cron schedule (optional; guarded) --------------------------------------
-- Runs the sweep every minute. Fully automatic — no admin action required.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
      from cron.job
     where jobname = 'exam_batch_attendance_sweep';

    perform cron.schedule(
      'exam_batch_attendance_sweep',
      '* * * * *',
      $cron$select public.exam_batch_attendance_sweep_ended_exams();$cron$
    );
  end if;
end
$$;