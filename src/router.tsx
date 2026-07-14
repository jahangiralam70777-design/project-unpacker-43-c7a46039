// @ts-nocheck
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import {
  DefaultErrorFallback,
  DefaultNotFoundFallback,
  DefaultPendingFallback,
} from "./components/route-fallbacks";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Reuse cached data across navigations — keeps page switches instant.
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        // Refetch on mount ONLY when the cached data is stale (TanStack's
        // default). Combined with `staleTime: 5m`, page switches inside
        // that window still hit cache instantly, but any query that was
        // marked stale via `invalidateQueries` (admin creates Level /
        // Subject / etc.) refetches the next time an observing component
        // mounts — no manual refresh required. `refetchOnMount: false`
        // suppressed those refetches even when the data was stale, so a
        // dropdown that lived inside a not-yet-open dialog would keep
        // showing pre-invalidation data on the next open.
        refetchOnMount: true,
        // Auto-recover when the network comes back without forcing a refresh.
        refetchOnReconnect: "always",
        // 3 retries with exponential backoff (capped at 5s) — but skip retrying
        // on auth/permission errors where retrying is pointless.
        retry: (failureCount, error) => {
          const msg = (error as Error)?.message ?? "";
          if (/Unauthorized|permission denied|Forbidden|not found|404|401|403/i.test(msg)) {
            return false;
          }
          return failureCount < 3;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
      },
      mutations: {
        // Never auto-retry writes. A retried admin mutation would fire a
        // second server request (double side effects — e.g. re-approve /
        // re-assign student_id / duplicate audit rows) and consume a
        // second rate-limit hit for the same click. One click = one
        // request; surface the error and let the user retry explicitly.
        retry: 0,
      },
    },
  });


  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadDelay: 30,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultErrorFallback,
    defaultNotFoundComponent: DefaultNotFoundFallback,
    defaultPendingComponent: DefaultPendingFallback,
    // Show bounded pending UI quickly on cold/direct loads so the app never
    // looks like a blank white page while route chunks or loaders resolve.
    defaultPendingMs: 300,
    defaultPendingMinMs: 200,
  });

  return router;
};