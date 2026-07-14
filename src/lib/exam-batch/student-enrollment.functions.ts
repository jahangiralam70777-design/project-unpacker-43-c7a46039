// @ts-nocheck
// Student-facing enrollment flow for Exam Batch.
// Only authenticated students may enroll. Every state transition is
// re-validated server-side; the client's view of session state is treated
// as untrusted input.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  enforceRateLimit,
  RATE_LIMITS,
  rateLimitKey,
} from "@/integrations/security/rate-limit";
import { audit } from "./audit";
import { errors, mapSupabaseError } from "./errors";
import {
  enrollSchema,
  type ExamBatchAccess,
  type ExamBatchEnrollmentRow,
  type ExamBatchSessionRow,
} from "./types";

const PUBLIC_SESSION_COLUMNS =
  "id,title,subtitle,level,starts_at,registration_deadline,status,registration_open,is_archived,is_hidden,subjects_count,created_at,updated_at";

// ---------- List sessions visible to the current student ----------
export const listAvailableExamBatchSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: { level?: string }) =>
    z.object({ level: z.string().trim().min(1).max(40).optional() }).parse(i ?? {}),
  )
  .handler(async ({ data, context }): Promise<ExamBatchSessionRow[]> => {
    console.log("[exam-batch] listAvailableExamBatchSessions userId=", context.userId, "level=", data.level);
    let q = context.supabase
      .from("exam_batch_sessions")
      .select(PUBLIC_SESSION_COLUMNS)
      .eq("is_hidden", false)
      .eq("is_archived", false)
      .eq("status", "active")
      .order("starts_at", { ascending: true });
    if (data.level) q = q.eq("level", data.level);
    const { data: rows, error } = await q;
    if (error) mapSupabaseError(error, "listAvailableExamBatchSessions");
    return (rows ?? []) as ExamBatchSessionRow[];
  });

// ---------- Enroll ----------
// Guest users cannot reach this — requireSupabaseAuth already 401s.
// Rate-limited per user to defeat rapid clicks / duplicate submissions.
export const enrollInExamBatchSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: unknown) => enrollSchema.parse(i))
  .handler(async ({ data, context }): Promise<ExamBatchEnrollmentRow> => {
    // Rate-limit rapid clicks / duplicate submissions.
    await enforceRateLimit(
      context.supabase,
      rateLimitKey("exam_batch:enroll", "user", context.userId),
      RATE_LIMITS.ADMIN_WRITE,
    );

    // Enrollment + subject links are created atomically inside a
    // SECURITY DEFINER RPC. This eliminates the class of bug where the
    // enrollment row was created but the subject links silently dropped
    // (RLS mismatch), leaving approved students with zero subjects and
    // the "No enrolled subjects" empty state after admin approval.
    const { data: rows, error } = await context.supabase.rpc(
      "exam_batch_enroll_session",
      { _session_id: data.sessionId, _subject_ids: data.subjectIds },
    );
    if (error) {
      const msg = (error as { message?: string }).message ?? "";
      if (msg.includes("already_enrolled")) {
        throw errors.conflict("You are already enrolled in this session.");
      }
      if (msg.includes("session_not_found")) throw errors.notFound("Session");
      if (msg.includes("registration_closed")) {
        throw errors.invalidState("Registration for this session is closed.");
      }
      if (msg.includes("invalid_subjects")) {
        throw errors.invalidState("One or more selected subjects are invalid.");
      }
      if (msg.includes("no_subjects_selected")) {
        throw errors.invalidState("Please select at least one subject.");
      }
      mapSupabaseError(error, "enrollInExamBatchSession:rpc");
    }
    const created = (rows ?? [])[0] as ExamBatchEnrollmentRow | undefined;
    if (!created) throw errors.notFound("Enrollment");

    await audit(context.supabase, context.userId, "enroll", "enrollment", created.id, {
      sessionId: data.sessionId,
      subjectIds: data.subjectIds,
    });

    return created;
  });

// ---------- My enrollment for a session ----------
export const getMyExamBatchEnrollment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: { sessionId: string }) =>
    z.object({ sessionId: z.string().uuid() }).parse(i),
  )
  .handler(async ({ data, context }): Promise<ExamBatchEnrollmentRow | null> => {
    const { data: row, error } = await context.supabase
      .from("exam_batch_enrollments")
      .select("*")
      .eq("session_id", data.sessionId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) mapSupabaseError(error, "getMyExamBatchEnrollment");
    return (row ?? null) as ExamBatchEnrollmentRow | null;
  });

// ---------- Permissions probe (single source of truth for the UI) ----------
// The UI must call this before showing Dashboard / Exam / Leaderboard /
// Progress. Access is granted ONLY when status = 'approved' AND a Student ID
// has been assigned. Pending, rejected, and un-enrolled users get read-only
// access to the Pending screen (or nothing).
export const getExamBatchAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: { sessionId: string }) =>
    z.object({ sessionId: z.string().uuid() }).parse(i),
  )
  .handler(async ({ data, context }): Promise<ExamBatchAccess> => {
    console.log("[exam-batch] getExamBatchAccess userId=", context.userId, "sessionId=", data.sessionId);
    const { data: row, error } = await context.supabase
      .from("exam_batch_enrollments")
      .select("status,student_id")
      .eq("session_id", data.sessionId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) mapSupabaseError(error, "getExamBatchAccess");

    if (!row) {
      return {
        enrolled: false,
        status: null,
        studentId: null,
        canAccessDashboard: false,
        canTakeExams: false,
        canViewLeaderboard: false,
        canViewProgress: false,
      };
    }

    const approved = row.status === "approved" && typeof row.student_id === "number";
    return {
      enrolled: true,
      status: row.status,
      studentId: row.student_id ?? null,
      canAccessDashboard: approved,
      canTakeExams: approved,
      canViewLeaderboard: approved,
      canViewProgress: approved,
    };
  });

// ---------- All my enrollments (any status) ----------
// Used by the student flow to detect which session the current user is
// enrolled in without asking the browser to remember it. The `state.sessionId`
// localStorage cache is only a fallback: if a user clears their storage,
// this query recovers "where am I in the flow" from the backend.
export const listMyExamBatchEnrollments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(() => ({}))
  .handler(async ({ context }): Promise<ExamBatchEnrollmentRow[]> => {
    console.log("[exam-batch] listMyExamBatchEnrollments userId=", context.userId);
    const { data, error } = await context.supabase
      .from("exam_batch_enrollments")
      .select(
        "id,session_id,user_id,status,student_id,reviewed_by,reviewed_at,notes,created_at,updated_at",
      )
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) mapSupabaseError(error, "listMyExamBatchEnrollments");
    return (data ?? []) as ExamBatchEnrollmentRow[];
  });

// ---------- Subjects the student can pick for a session ----------
// STRICT: reads ONLY the admin-configured `exam_batch_session_subjects`
// whitelist for the session. No level-wide fallback — if the admin has
// not assigned any subjects, the picker shows an empty state. This keeps
// the Exam Batch academic surface fully explicit and isolated.
export const listExamBatchSessionSubjects = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: { sessionId: string }) =>
    z.object({ sessionId: z.string().uuid() }).parse(i),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<
      Array<{
        id: string;
        name: string;
        description: string | null;
        icon: string | null;
        sort_order: number;
      }>
    > => {
      // Two explicit queries instead of a PostgREST resource embed.
      //
      // Root-cause fix for "student sees no subjects even though admin
      // assigned some": PostgREST embeds via `subjects:subject_id(...)`
      // silently return `null` for the embedded row whenever the FK is
      // unresolvable in the schema cache (e.g. after a table
      // recreate/migration where the constraint was renamed or the
      // schema cache is stale). The old code then `.filter(Boolean)`ed
      // those nulls out, producing an empty picker with zero server
      // error. Splitting the join into two RLS-safe reads is immune to
      // that class of failure and also lets us sort by the admin's
      // `sort_order` deterministically.
      const { data: linked, error: linkErr } = await context.supabase
        .from("exam_batch_session_subjects")
        .select("subject_id, sort_order")
        .eq("session_id", data.sessionId)
        .order("sort_order", { ascending: true });
      if (linkErr) mapSupabaseError(linkErr, "listExamBatchSessionSubjects:linked");

      const ids = (linked ?? [])
        .map((r: any) => r.subject_id as string)
        .filter((v: unknown): v is string => typeof v === "string");
      if (ids.length === 0) return [];

      const orderIndex = new Map<string, number>();
      (linked ?? []).forEach((r: any, i: number) => {
        if (typeof r.subject_id === "string") {
          orderIndex.set(
            r.subject_id,
            typeof r.sort_order === "number" ? r.sort_order : i,
          );
        }
      });

      const { data: subjects, error: subjErr } = await context.supabase
        .from("exam_batch_subjects")
        .select("id,name,description,icon,sort_order,status")
        .in("id", ids)
        // Hide archived subjects from the student picker, but keep drafts
        // visible — admins sometimes stage a batch with drafts before
        // publishing them the day-of.
        .neq("status", "archived");
      if (subjErr) mapSupabaseError(subjErr, "listExamBatchSessionSubjects:subjects");

      return (subjects ?? [])
        .map((s: any) => ({
          id: s.id as string,
          name: s.name as string,
          description: (s.description ?? null) as string | null,
          icon: (s.icon ?? null) as string | null,
          // Preserve the ADMIN-defined ordering from
          // exam_batch_session_subjects, falling back to the subject's
          // own sort_order if the link row is missing (shouldn't happen).
          sort_order:
            orderIndex.get(s.id as string) ??
            (typeof s.sort_order === "number" ? s.sort_order : 0),
        }))
        .sort((a, b) => a.sort_order - b.sort_order);
    },
  );

// ---------- Subjects the CURRENT STUDENT is enrolled in for a session ----------
//
// Distinct from `listExamBatchSessionSubjects` (which returns the admin-
// configured picker list). This one returns only the subjects the calling
// student actually enrolled in and had approved — the authoritative source
// for the "No enrolled subjects" empty-state in Available / Upcoming exam
// views. Deriving that from the exam list is wrong: a student can have
// enrolled subjects but zero exams scheduled yet, or all exams already
// submitted, and the UI would falsely claim they have no subjects.
export const listMyEnrolledExamBatchSubjects = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: { sessionId: string }) =>
    z.object({ sessionId: z.string().uuid() }).parse(i),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<Array<{ id: string; name: string }>> => {
      const { data: enrollment, error: enrErr } = await context.supabase
        .from("exam_batch_enrollments")
        .select("id,status,student_id")
        .eq("session_id", data.sessionId)
        .eq("user_id", context.userId)
        .maybeSingle();
      if (enrErr) mapSupabaseError(enrErr, "listMyEnrolledExamBatchSubjects:enrollment");
      if (
        !enrollment ||
        enrollment.status !== "approved" ||
        typeof enrollment.student_id !== "number"
      ) {
        return [];
      }
      const { data: linked, error: linkErr } = await context.supabase
        .from("exam_batch_enrollment_subjects")
        .select("subject_id")
        .eq("enrollment_id", enrollment.id);
      if (linkErr) mapSupabaseError(linkErr, "listMyEnrolledExamBatchSubjects:linked");
      const ids = (linked ?? [])
        .map((r: any) => r.subject_id as string)
        .filter((v: unknown): v is string => typeof v === "string");
      if (ids.length === 0) return [];
      const { data: subjects, error: subjErr } = await context.supabase
        .from("exam_batch_subjects")
        .select("id,name,sort_order,status")
        .in("id", ids)
        .neq("status", "archived");
      if (subjErr) mapSupabaseError(subjErr, "listMyEnrolledExamBatchSubjects:subjects");
      return (subjects ?? [])
        .map((s: any) => ({
          id: s.id as string,
          name: s.name as string,
          sort_order: typeof s.sort_order === "number" ? s.sort_order : 0,
        }))
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
        .map(({ id, name }) => ({ id, name }));
    },
  );