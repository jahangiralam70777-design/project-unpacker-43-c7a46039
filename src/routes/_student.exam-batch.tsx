import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExamBatchLayout } from "@/components/exam-batch/layout";
import { useExamBatchStudentNav } from "@/components/exam-batch/access-gate";
import { StudentExamBatchBanPage } from "@/components/exam-batch/student-ban-page";
import {
  listMyExamBatchEnrollments,
} from "@/lib/exam-batch/student-enrollment.functions";
import { getExamBatchAccessState } from "@/lib/exam-batch/student-attendance.functions";
import { getExamBatchPublicSettings } from "@/lib/exam-batch/public-settings.functions";
import type { ExamBatchEnrollmentRow } from "@/lib/exam-batch/types";

// Paths that only make sense BEFORE approval.
const PRE_APPROVAL_PATHS = new Set<string>([
  "/exam-batch",
  "/exam-batch/",
  "/exam-batch/sessions",
  "/exam-batch/subjects",
  "/exam-batch/enrollment",
  "/exam-batch/pending",
]);

// Paths that require approval to reach.
const POST_APPROVAL_PREFIXES = [
  "/exam-batch/dashboard",
  "/exam-batch/available",
  "/exam-batch/upcoming",
  "/exam-batch/leaderboard",
  "/exam-batch/progress",
  "/exam-batch/history",
];

function normalize(p: string) {
  const n = p.replace(/\/+$/, "");
  return n === "" ? "/" : n;
}

/**
 * Pick the "current" enrollment the same way `useExamBatchAccess` does:
 * prefer approved, then pending, then most-recent.
 */
function pickCurrentEnrollment(
  rows: ExamBatchEnrollmentRow[],
): ExamBatchEnrollmentRow | null {
  if (!rows.length) return null;
  return (
    rows.find((e) => e.status === "approved") ??
    rows.find((e) => e.status === "pending") ??
    rows[0]
  );
}

function accessFromEnrollment(row: ExamBatchEnrollmentRow | null) {
  const approved = row?.status === "approved" && typeof row.student_id === "number";
  return {
    enrolled: !!row,
    status: row?.status ?? null,
    studentId: row?.student_id ?? null,
    canAccessDashboard: approved,
    canTakeExams: approved,
    canViewLeaderboard: approved,
    canViewProgress: approved,
  };
}

function StudentExamBatchLayout() {
  const nav = useExamBatchStudentNav();

  // Attendance / ban gate — realtime invalidations on
  // exam_batch_attendance_state (see use-exam-batch-realtime.ts) flip this
  // instantly for the affected student, no manual refresh required.
  const banStateQuery = useQuery({
    queryKey: ["exam-batch", "student", "access", "ban-state"],
    queryFn: () => getExamBatchAccessState(),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
  const banDecision = banStateQuery.data;

  if ((banStateQuery.isLoading && !banStateQuery.data) || banStateQuery.isError) {
    return (
      <ExamBatchLayout nav={[]}>
        <div className="mx-auto flex min-h-[40vh] w-full max-w-lg flex-col items-center justify-center gap-3 rounded-3xl border border-border/60 bg-background/60 p-6 text-center">
          <div className="h-9 w-9 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          <p className="text-sm text-muted-foreground">Checking your Exam Batch access…</p>
        </div>
      </ExamBatchLayout>
    );
  }

  // Banned students see ONLY the ban screen inside the Exam Batch module.
  // The rest of the website (Dashboard, Quiz, Mock, MCQ Practice, etc.)
  // remains fully accessible.
  if (banDecision?.banned) {
    return (
      <ExamBatchLayout nav={[]}>
        <StudentExamBatchBanPage decision={banDecision} />
      </ExamBatchLayout>
    );
  }

  // Approval-driven redirects happen in `beforeLoad` (below) so the child
  // route never mounts on the wrong page. No spinner, no flash, no
  // useEffect race.
  return <ExamBatchLayout nav={nav} />;
}

// Never render nothing. Any time TanStack Router enters the pending state
// for this route — first load, hard refresh, direct URL entry, or a
// realtime `router.invalidate()` where no previous match is on screen —
// this skeleton renders instead of a blank page. Combined with the
// `errorComponent` below and `pendingMs: 0` this guarantees the Exam
// Batch subtree ALWAYS has something on screen while `beforeLoad`
// resolves, so admin-driven enrollment status transitions can never
// produce a white screen.
function ExamBatchLayoutPending() {
  return (
    <ExamBatchLayout nav={[]}>
      <div className="mx-auto flex min-h-[40vh] w-full max-w-lg flex-col items-center justify-center gap-3 rounded-3xl border border-border/60 bg-background/60 p-6 text-center">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        <p className="text-sm text-muted-foreground">Loading your Exam Batch workspace…</p>
      </div>
    </ExamBatchLayout>
  );
}

export const Route = createFileRoute("/_student/exam-batch")({
  // Render the pending UI IMMEDIATELY (pendingMs: 0). Historical value
  // of 30_000 meant that on mobile — where the initial load has no
  // previous match to keep on screen, and where `router.invalidate()`
  // after an enrollment status change re-runs `beforeLoad` before the
  // previous match finishes a background refetch — the router
  // rendered a blank pane for up to 30 seconds. That is the mobile
  // "white screen on open" and "white screen after admin status
  // change" symptom. With pendingMs: 0 the skeleton is always on
  // screen while `beforeLoad` resolves.
  pendingMs: 0,
  pendingMinMs: 0,
  pendingComponent: ExamBatchLayoutPending,
  // Runs BEFORE any child route mounts. Because `_student` is `ssr:false`,
  // this runs client-side with access to the authenticated Supabase
  // session. We throw `redirect()` here — TanStack Router applies the
  // redirect before rendering, so the Session page never appears for an
  // approved student.
  beforeLoad: async ({ context, location }) => {
    const here = normalize(location.pathname);

    // Guard rail: any transient failure here must NOT crash the entire
    // Exam Batch subtree. On network hiccups (very common when the tab
    // wakes up), keep the user on whichever page they were on and let
    // the realtime bridge re-invalidate once the socket is healthy.
    const safeFetch = async <T,>(
      queryKey: readonly unknown[],
      queryFn: () => Promise<T>,
      staleTime: number,
    ): Promise<T | undefined> => {
      try {
        return await context.queryClient.fetchQuery({
          queryKey: queryKey as unknown[],
          queryFn,
          staleTime,
        });
      } catch {
        // Fall back to any cached value we have; undefined otherwise.
        return context.queryClient.getQueryData<T>(queryKey as unknown[]);
      }
    };

    // 1) Module visibility (admin can hide Exam Batch entirely). Uses the
    //    same queryKey as `useExamBatchVisibility` so there is no duplicate
    //    request — the cached value is reused everywhere.
    const settings = await safeFetch(
      ["exam-batch", "public-settings"],
      () => getExamBatchPublicSettings(),
      30_000,
    );
    if (settings?.moduleVisible === false) {
      if (here !== "/dashboard") throw redirect({ to: "/dashboard", replace: true });
      return;
    }

    // 2) Load the student's enrollments (shared with `useExamBatchAccess`).
    // This row is the single authoritative state for route decisions:
    // status + student_id live on the same database row, so deriving access
    // from it prevents a split-query race where fresh enrollments + stale
    // access cache disagree during admin-driven status changes.
    const enrollments = await safeFetch(
      ["exam-batch", "student", "my-enrollments"],
      () => listMyExamBatchEnrollments({ data: {} }),
      0,
    );

    const currentEnrollment = pickCurrentEnrollment(enrollments ?? []);
    const sessionId = currentEnrollment?.session_id ?? null;

    // 3) Keep the access cache in lock-step with the enrollment row before
    //    child components render. This removes invalid intermediate states
    //    during simultaneous query invalidations on mobile resume/realtime.
    const derivedAccess = accessFromEnrollment(currentEnrollment);
    const canAccessDashboard = derivedAccess.canAccessDashboard;
    const enrollmentStatus = derivedAccess.status;
    if (sessionId) {
      context.queryClient.setQueryData(
        ["exam-batch", "student", "access", sessionId],
        derivedAccess,
      );
      void context.queryClient.invalidateQueries({
        queryKey: ["exam-batch", "student", "access", sessionId],
        refetchType: "active",
      });
    }

    const inPostArea = POST_APPROVAL_PREFIXES.some((p) => here.startsWith(p));

    if (canAccessDashboard) {
      // Approved + Student ID assigned → Dashboard is the only entry point.
      // The Session / Subjects / Enrollment / Pending screens are hidden
      // forever for this student unless approval is revoked server-side.
      if (PRE_APPROVAL_PATHS.has(here)) {
        throw redirect({ to: "/exam-batch/dashboard", replace: true });
      }
      return;
    }

    if (currentEnrollment && enrollmentStatus === "pending") {
      // Enrolled but awaiting admin approval.
      if (here !== "/exam-batch/pending") {
        throw redirect({ to: "/exam-batch/pending", replace: true });
      }
      return;
    }

    // Not enrolled / rejected / revoked → Session selection is the only
    // valid entry point.
    if (inPostArea || here === "/exam-batch/pending") {
      throw redirect({ to: "/exam-batch/sessions", replace: true });
    }
  },
  component: StudentExamBatchLayout,
  errorComponent: ExamBatchLayoutError,
  head: () => ({
    meta: [
      { title: "Exam Batch · CA Aspire BD" },
      { name: "description", content: "Your cohort-based exam preparation hub — sessions, subjects, exams and leaderboard." },
      { property: "og:title", content: "Exam Batch · CA Aspire BD" },
      { property: "og:description", content: "Cohort exam prep with live leaderboards and progress tracking." },
    ],
  }),
});

function ExamBatchLayoutError({ error, reset }: { error: Error; reset: () => void }) {
  // Any error escaping `beforeLoad` or the layout tree lands here.
  // Historically a transient tab-return failure would render the root
  // error boundary and blank the whole app; keeping the failure
  // contained inside the Exam Batch subtree preserves the rest of the
  // student experience (dashboard, quizzes, mocks, etc.).
  const router = useRouter();
  return (
    <div className="mx-auto flex min-h-[40vh] max-w-lg flex-col items-center justify-center gap-3 rounded-3xl border border-border/60 bg-background/60 p-6 text-center">
      <h2 className="text-lg font-semibold text-foreground">Exam Batch is momentarily unavailable</h2>
      <p className="text-sm text-muted-foreground">
        {error?.message?.slice(0, 200) || "We couldn't load your Exam Batch data. Please try again."}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => {
            reset();
            void router.invalidate();
          }}
          className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Retry
        </button>
        <Link
          to="/dashboard"
          className="inline-flex items-center justify-center rounded-lg border border-border/60 bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-accent"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
