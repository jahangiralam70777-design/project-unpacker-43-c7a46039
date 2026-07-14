import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  deleteStudyRoutine,
  deleteStudyRoutineTask,
  duplicateStudyRoutine,
  duplicateStudyRoutineTask,
  listStudyRoutines,
  listStudyRoutineTasks,
  saveStudyRoutineWithSchedule,
  setStudyRoutineFlags,
  setStudyRoutineTaskStatus,
  upsertStudyRoutine,
  upsertStudyRoutineTask,
  type StudyRoutineRow,
  type StudyRoutineTaskRow,
} from "@/lib/study-routine.functions";

// Keep query keys centralized so realtime invalidation matches exactly.
const ROUTINES_KEY = ["study-routines"] as const;
const TASKS_KEY = ["study-routine-tasks"] as const;

// Every query key that displays routine/task-derived data. Delete/edit
// mutations and realtime events invalidate this full set so the UI updates
// instantly with no manual refresh.
//
// NOTE: Study Routine is a fully independent module. It intentionally does
// NOT invalidate Daily Progress (`student-daily-progress`) or any other
// module's cache — the two modules share no tables or aggregation logic.
const AFFECTED_KEYS: readonly (readonly unknown[])[] = [
  ROUTINES_KEY,
  TASKS_KEY,
  ["study-goal-targets"],
  ["study-routine-streak"],
  ["admin-routine"],
];

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const key of AFFECTED_KEYS) {
    qc.invalidateQueries({ queryKey: key as unknown[], refetchType: "active" });
  }
}

function readError(e: unknown, fallback: string) {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return fallback;
}


/** List routines. Live-updated via a shared postgres_changes channel. */
export function useStudyRoutines(opts?: { includeArchived?: boolean }) {
  const fn = useServerFn(listStudyRoutines);
  const includeArchived = !!opts?.includeArchived;
  const qc = useQueryClient();

  useEffect(() => {
    // Unique per-mount channel name (StrictMode / HMR safe).
    const channelName = `study-routine:${Math.random().toString(36).slice(2)}:${Date.now()}`;
    const ch = supabase.channel(channelName);
    ch.on(
      "postgres_changes" as never,
      { event: "*", schema: "public", table: "study_routines" },
      () => invalidateAll(qc),
    )
      .on(
        "postgres_changes" as never,
        { event: "*", schema: "public", table: "study_routine_tasks" },
        () => invalidateAll(qc),
      )
      .on("system" as never, { event: "SUBSCRIBED" }, () => {
        // Auto-refresh on (re)connect so we don't miss events across
        // websocket drops — no polling required.
        invalidateAll(qc);
      })

      .subscribe();
    return () => {
      try {
        supabase.removeChannel(ch);
      } catch {
        /* noop */
      }
    };
  }, [qc]);

  return useQuery({
    queryKey: [...ROUTINES_KEY, includeArchived ? "all" : "active"],
    queryFn: async () => (await fn({ data: { includeArchived } })) as StudyRoutineRow[],
    // Realtime keeps this fresh; avoid extra background refetches.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useStudyRoutineTasks(params?: {
  routineId?: string | null;
  from?: string | null;
  to?: string | null;
}) {
  const fn = useServerFn(listStudyRoutineTasks);
  const routineId = params?.routineId ?? null;
  const from = params?.from ?? null;
  const to = params?.to ?? null;
  return useQuery({
    queryKey: [...TASKS_KEY, routineId, from, to],
    queryFn: async () =>
      (await fn({
        data: {
          routineId: routineId ?? undefined,
          from: from ?? undefined,
          to: to ?? undefined,
        },
      })) as StudyRoutineTaskRow[],
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

// ---------------------------------------------------------------- Mutations
export function useStudyRoutineMutations() {
  const qc = useQueryClient();
  const invalidate = () => invalidateAll(qc);


  const upsertRoutine = useServerFn(upsertStudyRoutine);
  const saveRoutine = useServerFn(saveStudyRoutineWithSchedule);
  const deleteRoutine = useServerFn(deleteStudyRoutine);
  const setFlags = useServerFn(setStudyRoutineFlags);
  const dupRoutine = useServerFn(duplicateStudyRoutine);
  const upsertTask = useServerFn(upsertStudyRoutineTask);
  const deleteTask = useServerFn(deleteStudyRoutineTask);
  const setStatus = useServerFn(setStudyRoutineTaskStatus);
  const dupTask = useServerFn(duplicateStudyRoutineTask);

  return {
    upsertRoutine: useMutation({
      mutationFn: (data: Parameters<typeof upsertRoutine>[0]["data"]) =>
        upsertRoutine({ data }),
      onSuccess: (_r, v) => {
        invalidate();
        toast.success(v?.id ? "Routine updated" : "Routine created");
      },
      onError: (e) => toast.error(readError(e, "Failed to save routine")),
    }),
    saveRoutine: useMutation({
      mutationFn: (data: Parameters<typeof saveRoutine>[0]["data"]) =>
        saveRoutine({ data }),
      onSuccess: (_r, v) => {
        invalidate();
        toast.success(v?.id ? "Routine updated" : "Routine created");
      },
      onError: (e) => toast.error(readError(e, "Failed to save routine")),
    }),
    deleteRoutine: useMutation({
      // Optimistic remove — routine card and its tasks disappear instantly.
      onMutate: async (id: string) => {
        await qc.cancelQueries({ queryKey: ROUTINES_KEY });
        await qc.cancelQueries({ queryKey: TASKS_KEY });
        const routineSnaps = qc.getQueriesData<StudyRoutineRow[]>({
          queryKey: ROUTINES_KEY,
        });
        const taskSnaps = qc.getQueriesData<StudyRoutineTaskRow[]>({
          queryKey: TASKS_KEY,
        });
        routineSnaps.forEach(([key, data]) => {
          if (Array.isArray(data)) {
            qc.setQueryData(key, data.filter((r) => r.id !== id));
          }
        });
        taskSnaps.forEach(([key, data]) => {
          if (Array.isArray(data)) {
            qc.setQueryData(key, data.filter((t) => t.routine_id !== id));
          }
        });
        return { routineSnaps, taskSnaps };
      },
      mutationFn: (id: string) => deleteRoutine({ data: { id } }),
      onError: (e, _id, ctx) => {
        ctx?.routineSnaps?.forEach(([key, data]) => qc.setQueryData(key, data));
        ctx?.taskSnaps?.forEach(([key, data]) => qc.setQueryData(key, data));
        toast.error(readError(e, "Failed to delete routine"));
      },
      onSuccess: () => toast.success("Routine deleted"),
      onSettled: invalidate,
    }),

    setRoutineFlags: useMutation({
      mutationFn: (data: Parameters<typeof setFlags>[0]["data"]) => setFlags({ data }),
      onSuccess: (_r, v) => {
        invalidate();
        if (typeof v.is_archived === "boolean") {
          toast.success(v.is_archived ? "Routine archived" : "Routine restored");
        } else if (typeof v.is_active === "boolean") {
          toast.success(v.is_active ? "Routine activated" : "Routine deactivated");
        }
      },
      onError: (e) => toast.error(readError(e, "Failed to update routine")),
    }),
    duplicateRoutine: useMutation({
      mutationFn: (id: string) => dupRoutine({ data: { id } }),
      onSuccess: () => {
        invalidate();
        toast.success("Routine duplicated");
      },
      onError: (e) => toast.error(readError(e, "Failed to duplicate routine")),
    }),
    upsertTask: useMutation({
      mutationFn: (data: Parameters<typeof upsertTask>[0]["data"]) =>
        upsertTask({ data }),
      onSuccess: (_r, v) => {
        invalidate();
        toast.success(v?.id ? "Task updated" : "Task added");
      },
      onError: (e) => toast.error(readError(e, "Failed to save task")),
    }),
    deleteTask: useMutation({
      // Optimistic remove
      onMutate: async (id: string) => {
        await qc.cancelQueries({ queryKey: TASKS_KEY });
        const snapshots = qc.getQueriesData<StudyRoutineTaskRow[]>({
          queryKey: TASKS_KEY,
        });
        snapshots.forEach(([key, data]) => {
          if (Array.isArray(data)) {
            qc.setQueryData(key, data.filter((t) => t.id !== id));
          }
        });
        return { snapshots };
      },
      mutationFn: (id: string) => deleteTask({ data: { id } }),
      onError: (e, _id, ctx) => {
        ctx?.snapshots?.forEach(([key, data]) => qc.setQueryData(key, data));
        toast.error(readError(e, "Failed to delete task"));
      },
      onSuccess: () => toast.success("Task deleted"),
      onSettled: invalidate,
    }),
    setTaskStatus: useMutation({
      onMutate: async (vars: {
        id: string;
        status: StudyRoutineTaskRow["status"];
        completion?: number;
      }) => {
        await qc.cancelQueries({ queryKey: TASKS_KEY });
        const snapshots = qc.getQueriesData<StudyRoutineTaskRow[]>({
          queryKey: TASKS_KEY,
        });
        snapshots.forEach(([key, data]) => {
          if (Array.isArray(data)) {
            qc.setQueryData(
              key,
              data.map((t) =>
                t.id === vars.id
                  ? {
                      ...t,
                      status: vars.status,
                      completion:
                        typeof vars.completion === "number"
                          ? vars.completion
                          : vars.status === "completed"
                            ? 100
                            : vars.status === "pending"
                              ? 0
                              : t.completion,
                    }
                  : t,
              ),
            );
          }
        });
        return { snapshots };
      },
      mutationFn: (vars: {
        id: string;
        status: StudyRoutineTaskRow["status"];
        completion?: number;
      }) => setStatus({ data: vars }),
      onError: (e, _v, ctx) => {
        ctx?.snapshots?.forEach(([key, data]) => qc.setQueryData(key, data));
        toast.error(readError(e, "Failed to update task"));
      },
      onSettled: invalidate,
    }),
    duplicateTask: useMutation({
      mutationFn: (id: string) => dupTask({ data: { id } }),
      onSuccess: () => {
        invalidate();
        toast.success("Task duplicated");
      },
      onError: (e) => toast.error(readError(e, "Failed to duplicate task")),
    }),
  };
}
