import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { isIronbooks } from "@/lib/grain-matching";
import { getCallOverview } from "@/lib/grain-call-overview";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Unwrap Grain's {"text":"…"} JSON summary to its inner markdown. */
function cleanSummary(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (s.startsWith("{")) {
    try {
      const p = JSON.parse(s);
      if (typeof p?.text === "string") s = p.text;
      else if (typeof p?.summary === "string") s = p.summary;
    } catch { /* plain string */ }
  }
  return s.replace(/\\n/g, "\n").trim();
}

/**
 * GET /api/clients/[id]/grain/overview
 *
 * Cached AI synthesis of all this client's matched Grain calls. Internal
 * roles only. Returns { overview, recordingCount, generatedAt } or
 * { overview: null } when there are no calls / generation is unavailable.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!(actor as any)?.role || (actor as any).role === "client") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: matches } = await service
    .from("grain_recording_matches")
    .select("recording_id")
    .eq("client_link_id", id);
  const recIds = ((matches as any[]) || []).map((m) => m.recording_id);
  if (recIds.length === 0) return NextResponse.json({ overview: null });

  const { data: recs } = await service
    .from("grain_recordings")
    .select("id, title, start_datetime, summary, participants")
    .in("id", recIds)
    .order("start_datetime", { ascending: true });

  const rows = ((recs as any[]) || []);
  const { data: cl } = await service
    .from("client_links")
    .select("client_name")
    .eq("id", id)
    .single();
  const clientName = (cl as any)?.client_name || "this client";

  const detailed = rows.map((r) => ({
    title: r.title,
    start_datetime: r.start_datetime,
    summary: cleanSummary(r.summary),
    participants: ((r.participants as any[]) || [])
      .filter((p) => !isIronbooks(p.email))
      .map((p) => ({ name: p.name, email: p.email })),
  }));

  const result = await getCallOverview(
    service,
    id,
    clientName,
    rows.map((r) => ({ id: r.id, start_datetime: r.start_datetime })),
    detailed
  );

  if (!result) return NextResponse.json({ overview: null });
  return NextResponse.json(result);
}
