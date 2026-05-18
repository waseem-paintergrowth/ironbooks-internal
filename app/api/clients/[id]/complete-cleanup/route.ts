import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * Cleanup completion endpoints for a client.
 *
 * POST  → Mark the client's cleanup as complete. Body:
 *           { range_start?: string;  // YYYY-MM-DD — saved so the PDF
 *             range_end?: string;    //   report can be re-pulled without
 *             note?: string;         //   re-picking dates.
 *           }
 *         If range is omitted, falls back to the most recent
 *         coa_jobs.date_range_* for this client.
 *
 * DELETE → Reopen a previously-completed cleanup. Clears the completion
 *          markers. The bookkeeper can start new jobs on the client
 *          again as normal.
 */

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const note: string | undefined = body?.note;
  let rangeStart: string | null = body?.range_start || null;
  let rangeEnd: string | null = body?.range_end || null;

  const service = createServiceSupabase();

  // Verify the client exists + load most-recent COA job for fallback dates.
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, cleanup_completed_at")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  if ((client as any).cleanup_completed_at) {
    return NextResponse.json(
      { ok: true, already_complete: true },
      { status: 200 }
    );
  }

  if (!rangeStart || !rangeEnd) {
    // Most-recent completed COA job is the canonical cleanup range. Falls
    // back to whatever the cleanup actually touched, not whatever the
    // bookkeeper happens to be looking at.
    const { data: lastJob } = await service
      .from("coa_jobs")
      .select("date_range_start, date_range_end")
      .eq("client_link_id", clientLinkId)
      .eq("status", "complete")
      .order("execution_completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastJob) {
      rangeStart = rangeStart || (lastJob as any).date_range_start;
      rangeEnd = rangeEnd || (lastJob as any).date_range_end;
    }
  }

  const now = new Date().toISOString();
  const { error: updErr } = await service
    .from("client_links")
    .update({
      cleanup_completed_at: now,
      cleanup_completed_by: user.id,
      cleanup_completion_note: note || null,
      cleanup_range_start: rangeStart,
      cleanup_range_end: rangeEnd,
    } as any)
    .eq("id", clientLinkId);

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  // Audit trail
  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "client_cleanup_completed",
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
        range_start: rangeStart,
        range_end: rangeEnd,
        note: note || null,
      } as any,
    });
  } catch {
    // audit_log column shape varies across envs; non-fatal
  }

  return NextResponse.json({
    ok: true,
    cleanup_completed_at: now,
    cleanup_range_start: rangeStart,
    cleanup_range_end: rangeEnd,
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, cleanup_completed_at")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  if (!(client as any).cleanup_completed_at) {
    return NextResponse.json({ ok: true, already_open: true });
  }

  const { error: updErr } = await service
    .from("client_links")
    .update({
      cleanup_completed_at: null,
      cleanup_completed_by: null,
      cleanup_completion_note: null,
      // Keep range_* as historical breadcrumbs — useful if they reopen
      // and want to start from where they left off. Cleared on next
      // mark-complete anyway.
    } as any)
    .eq("id", clientLinkId);

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "client_cleanup_reopened",
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
      } as any,
    });
  } catch {
    // non-fatal
  }

  return NextResponse.json({ ok: true, reopened: true });
}
