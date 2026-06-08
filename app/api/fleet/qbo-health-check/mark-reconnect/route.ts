import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/fleet/qbo-health-check/mark-reconnect
 *
 * Bookkeeper hit "Reconnect" on a dead-connection row. Records who
 * initiated the OAuth re-auth + when, so the dashboard can show
 * "in progress" vs "stuck" rather than treating every dead row the same.
 *
 * Body: { client_link_ids: string[] }
 * Admin/lead only.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const ids: string[] = Array.isArray(body.client_link_ids) ? body.client_link_ids : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "client_link_ids required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { error } = await (service as any)
    .from("qbo_connection_health")
    .update({
      reconnect_initiated_at: now,
      reconnect_initiated_by: user.id,
      updated_at: now,
    })
    .in("client_link_id", ids);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, marked: ids.length });
}
