import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/clients/[id]/daily-recon-flag
 *
 * Toggles the daily_recon_enabled / daily_recon_paused flags on a client.
 * Admin/lead only — these flags directly control whether the unsupervised
 * worker touches the client's books.
 *
 * Body: { daily_recon_enabled?: boolean, daily_recon_paused?: boolean }
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
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
    return NextResponse.json({ error: "Forbidden — admins/leads only" }, { status: 403 });
  }

  const body = await request.json();
  const update: Record<string, any> = {};
  if (typeof body.daily_recon_enabled === "boolean") {
    update.daily_recon_enabled = body.daily_recon_enabled;
    // Enrolling also clears any paused state — fresh start.
    if (body.daily_recon_enabled) {
      update.daily_recon_paused = false;
      update.daily_recon_paused_reason = null;
    }
  }
  if (typeof body.daily_recon_paused === "boolean") {
    update.daily_recon_paused = body.daily_recon_paused;
    if (!body.daily_recon_paused) {
      update.daily_recon_paused_reason = null;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No valid fields provided" }, { status: 400 });
  }

  const { error } = await service
    .from("client_links")
    .update(update as any)
    .eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, updated: update });
}
