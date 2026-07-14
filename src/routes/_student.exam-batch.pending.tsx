import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { StudentPending } from "@/components/exam-batch/student-pages";

// Route-level error boundary. Any error thrown during render of the
// Pending page (transient RPC failure after an admin status flip, a
// cache race, etc.) lands here instead of blanking the Exam Batch
// subtree. The user sees a friendly retry surface and can navigate
// away without a full refresh.
function PendingErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="mx-auto flex min-h-[40vh] max-w-lg flex-col items-center justify-center gap-3 rounded-3xl border border-border/60 bg-background/60 p-6 text-center">
      <h2 className="text-lg font-semibold text-foreground">Pending page is momentarily unavailable</h2>
      <p className="text-sm text-muted-foreground">
        {error?.message?.slice(0, 240) ||
          "We couldn't load your enrollment status. Please try again."}
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
          to="/exam-batch/sessions"
          className="inline-flex items-center justify-center rounded-lg border border-border/60 bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-accent"
        >
          Back to sessions
        </Link>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_student/exam-batch/pending")({
  component: StudentPending,
  errorComponent: PendingErrorFallback,
});

