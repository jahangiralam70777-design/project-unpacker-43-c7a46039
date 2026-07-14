import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { StudentDashboard } from "@/components/exam-batch/student-pages";

// Route-level error boundary. Any error thrown during render of the
// dashboard subtree — a transient RPC failure, a query cache race after
// admin approval, a subject-progress schema mismatch, anything — lands
// here instead of blanking the whole app to a white screen. The user
// sees a friendly retry surface AND the Exam Batch layout (sub-nav
// stays visible), so they can navigate away without a full refresh.
function DashboardErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="mx-auto flex min-h-[40vh] max-w-lg flex-col items-center justify-center gap-3 rounded-3xl border border-border/60 bg-background/60 p-6 text-center">
      <h2 className="text-lg font-semibold text-foreground">Dashboard is momentarily unavailable</h2>
      <p className="text-sm text-muted-foreground">
        {error?.message?.slice(0, 240) ||
          "We couldn't load your Exam Batch dashboard. Please try again."}
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
          to="/exam-batch/available"
          className="inline-flex items-center justify-center rounded-lg border border-border/60 bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-accent"
        >
          Available exams
        </Link>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_student/exam-batch/dashboard")({
  component: StudentDashboard,
  errorComponent: DashboardErrorFallback,
});
