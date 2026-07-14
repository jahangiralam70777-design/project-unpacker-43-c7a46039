// @ts-nocheck
// Admin session management for Exam Batch.
// Uses createServerFn + requireSupabaseAuth. Every mutation runs through
// assertPermission("manage_content"), which also applies the admin-write
// rate limit and writes an authorization audit entry.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPermission } from "@/lib/admin-permissions";
import { audit } from "./audit";
import { errors, mapSupabaseError } from "./errors";
import {
  sessionCreateSchema,
  sessionIdOnly,
  sessionSetBool,
  sessionUpdateSchema,
  type ExamBatchSessionRow,
} from "./types";

const SESSION_COLUMNS =
  "id,title,subtitle,level,starts_at,registration_deadline,status,registration_open,is_archived,is_hidden,subjects_count,created_at,updated_at";

// ---------- List (admin sees everything, including hidden/archived) ----------
export const adminListExamBatchSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: { includeArchived?: boolean }) =>
    z.object({ includeArchived: z.boolean().default(true) }).parse(i ?? {}),
  )
  .handler(async ({ data, context }): Promise<ExamBatchSessionRow[]> => {
    await assertPermission(context.supabase, context.userId, "manage_content", "exam_batch.session.list");
    let q = context.supabase
      .from("exam_batch_sessions")
      .select(SESSION_COLUMNS)
      .order("starts_at", { ascending: false });
    if (!data.includeArchived) q = q.eq("is_archived", false);
    const { data: rows, error } = await q;
    if (error) mapSupabaseError(error, "adminListExamBatchSessions");
    return (rows ?? []) as ExamBatchSessionRow[];
  });

// ---------- Create ----------
export const adminCreateExamBatchSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: unknown) => sessionCreateSchema.parse(i))
  .handler(async ({ data, context }): Promise<ExamBatchSessionRow> => {
    await assertPermission(context.supabase, context.userId, "manage_content", "exam_batch.session.create");
    const { data: row, error } = await context.supabase
      .from("exam_batch_sessions")
      .insert({
        title: data.title,
        subtitle: data.subtitle ?? null,
        level: data.level,
        starts_at: data.startsAt,
        registration_deadline: data.registrationDeadline ?? null,
        status: data.status,
        registration_open: data.registrationOpen,
        is_hidden: data.isHidden,
        is_archived: false,
        created_by: context.userId,
      })
      .select(SESSION_COLUMNS)
      .single();
    if (error) mapSupabaseError(error, "adminCreateExamBatchSession");
    await audit(context.supabase, context.userId, "session.create", "session", row!.id, { title: data.title });
    return row as ExamBatchSessionRow;
  });

// ---------- Update ----------
export const adminUpdateExamBatchSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: unknown) => sessionUpdateSchema.parse(i))
  .handler(async ({ data, context }): Promise<ExamBatchSessionRow> => {
    await assertPermission(context.supabase, context.userId, "manage_content", "exam_batch.session.update");
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.title !== undefined) patch.title = data.title;
    if (data.subtitle !== undefined) patch.subtitle = data.subtitle ?? null;
    if (data.level !== undefined) patch.level = data.level;
    if (data.startsAt !== undefined) patch.starts_at = data.startsAt;
    if (data.registrationDeadline !== undefined) patch.registration_deadline = data.registrationDeadline ?? null;
    if (data.status !== undefined) patch.status = data.status;
    if (data.registrationOpen !== undefined) patch.registration_open = data.registrationOpen;
    if (data.isHidden !== undefined) patch.is_hidden = data.isHidden;

    const { data: row, error } = await context.supabase
      .from("exam_batch_sessions")
      .update(patch)
      .eq("id", data.id)
      .select(SESSION_COLUMNS)
      .single();
    if (error) mapSupabaseError(error, "adminUpdateExamBatchSession");
    if (!row) throw errors.notFound("Session");
    await audit(context.supabase, context.userId, "session.update", "session", data.id, { patch });
    return row as ExamBatchSessionRow;
  });

// ---------- Delete ----------
export const adminDeleteExamBatchSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: unknown) => sessionIdOnly.parse(i))
  .handler(async ({ data, context }) => {
    await assertPermission(context.supabase, context.userId, "manage_content", "exam_batch.session.delete");
    const { error } = await context.supabase.from("exam_batch_sessions").delete().eq("id", data.id);
    if (error) mapSupabaseError(error, "adminDeleteExamBatchSession");
    await audit(context.supabase, context.userId, "session.delete", "session", data.id);
    return { ok: true } as const;
  });

// ---------- Archive / Unarchive ----------
export const adminSetExamBatchSessionArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: unknown) => sessionSetBool.parse(i))
  .handler(async ({ data, context }) => {
    await assertPermission(context.supabase, context.userId, "manage_content", "exam_batch.session.archive");
    const { error } = await context.supabase
      .from("exam_batch_sessions")
      .update({ is_archived: data.value, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) mapSupabaseError(error, "adminSetExamBatchSessionArchived");
    await audit(context.supabase, context.userId, "session.archive", "session", data.id, { archived: data.value });
    return { ok: true } as const;
  });

// ---------- Hide / Unhide ----------
export const adminSetExamBatchSessionHidden = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: unknown) => sessionSetBool.parse(i))
  .handler(async ({ data, context }) => {
    await assertPermission(context.supabase, context.userId, "manage_content", "exam_batch.session.hide");
    const { error } = await context.supabase
      .from("exam_batch_sessions")
      .update({ is_hidden: data.value, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) mapSupabaseError(error, "adminSetExamBatchSessionHidden");
    await audit(context.supabase, context.userId, "session.hide", "session", data.id, { hidden: data.value });
    return { ok: true } as const;
  });

// ---------- Active / Inactive ----------
export const adminSetExamBatchSessionActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: unknown) => sessionSetBool.parse(i))
  .handler(async ({ data, context }) => {
    await assertPermission(context.supabase, context.userId, "manage_content", "exam_batch.session.set_active");
    const { error } = await context.supabase
      .from("exam_batch_sessions")
      .update({ status: data.value ? "active" : "inactive", updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) mapSupabaseError(error, "adminSetExamBatchSessionActive");
    await audit(context.supabase, context.userId, "session.set_active", "session", data.id, { active: data.value });
    return { ok: true } as const;
  });

// ---------- Registration open / closed ----------
export const adminSetExamBatchRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: unknown) => sessionSetBool.parse(i))
  .handler(async ({ data, context }) => {
    await assertPermission(context.supabase, context.userId, "manage_content", "exam_batch.session.set_registration");
    const { error } = await context.supabase
      .from("exam_batch_sessions")
      .update({ registration_open: data.value, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) mapSupabaseError(error, "adminSetExamBatchRegistration");
    await audit(context.supabase, context.userId, "session.set_registration", "session", data.id, {
      open: data.value,
    });
    return { ok: true } as const;
  });

// ---------- Session subjects (admin) ----------
// Read the admin-configured subject list for a session. Returns only the
// subject ids; the UI joins against `exam_batch_subjects` separately.
export const adminListExamBatchSessionSubjects = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: { sessionId: string }) =>
    z.object({ sessionId: z.string().uuid() }).parse(i),
  )
  .handler(async ({ data, context }): Promise<string[]> => {
    await assertPermission(
      context.supabase,
      context.userId,
      "manage_content",
      "exam_batch.session.subjects.list",
    );
    const { data: rows, error } = await context.supabase
      .from("exam_batch_session_subjects")
      .select("subject_id")
      .eq("session_id", data.sessionId);
    if (error) mapSupabaseError(error, "adminListExamBatchSessionSubjects");
    return (rows ?? []).map((r: any) => r.subject_id as string);
  });

// Replace the admin-configured subject list for a session with exactly
// `subjectIds` (may be empty). Uses delete + insert inside the same
// request so the set is atomic from the client's perspective. The
// `subjects_count` column on `exam_batch_sessions` is kept in sync by a
// database trigger — see `exam_batch_complete.sql`.
export const adminSetExamBatchSessionSubjects = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((i: { sessionId: string; subjectIds: string[] }) =>
    z
      .object({
        sessionId: z.string().uuid(),
        subjectIds: z.array(z.string().uuid()).max(200),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertPermission(
      context.supabase,
      context.userId,
      "manage_content",
      "exam_batch.session.subjects.set",
    );
    const sb = context.supabase;
    const unique = Array.from(new Set(data.subjectIds));

    // Load current selection so we can compute add/remove sets and skip
    // no-op writes (keeps realtime traffic quiet).
    const { data: current, error: readErr } = await sb
      .from("exam_batch_session_subjects")
      .select("subject_id")
      .eq("session_id", data.sessionId);
    if (readErr) mapSupabaseError(readErr, "adminSetExamBatchSessionSubjects:read");
    const currentIds = new Set((current ?? []).map((r: any) => r.subject_id as string));
    const nextIds = new Set(unique);
    const toRemove = [...currentIds].filter((id) => !nextIds.has(id));
    const toAdd = [...nextIds].filter((id) => !currentIds.has(id));

    if (toRemove.length) {
      const { error: delErr } = await sb
        .from("exam_batch_session_subjects")
        .delete()
        .eq("session_id", data.sessionId)
        .in("subject_id", toRemove);
      if (delErr) mapSupabaseError(delErr, "adminSetExamBatchSessionSubjects:delete");
    }
    if (toAdd.length) {
      const rows = toAdd.map((subject_id, i) => ({
        session_id: data.sessionId,
        subject_id,
        sort_order: i,
        added_by: context.userId,
      }));
      const { error: insErr } = await sb
        .from("exam_batch_session_subjects")
        .insert(rows);
      if (insErr) mapSupabaseError(insErr, "adminSetExamBatchSessionSubjects:insert");
    }

    // Touch updated_at so any observer refetches even if the count is unchanged.
    await sb
      .from("exam_batch_sessions")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", data.sessionId);

    await audit(
      context.supabase,
      context.userId,
      "session.subjects.set",
      "session",
      data.sessionId,
      { added: toAdd.length, removed: toRemove.length, total: unique.length },
    );
    return { ok: true, added: toAdd.length, removed: toRemove.length, total: unique.length } as const;
  });