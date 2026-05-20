import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { runDailyRecon } from "@/lib/daily-recon";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/**
 * POST /api/daily-recon/run/[clientId]?dryRun=true&lookbackDays=30
 *
 * Admin-only manual trigger for the daily recon worker on a single client.
 * Defaults to dryRun=true so you can see what would happen without writing
 * to QBO. Pass ?dryRun=false to actually push categorizations.
 *
 * Used by the /admin/daily-recon panel for shadow-mode testing on pilot
 * clients before flipping on the cron.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ clientId: string }> }
) {
  const { clientId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead"].includes((actor as any)?.role)) {
    return NextResponse.json({ error: "Forbidden — admins/leads only" }, { status: 403 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") !== "false"; // default true
  const lookbackDays = url.searchParams.get("lookbackDays")
    ? Math.max(1, Math.min(90, parseInt(url.searchParams.get("lookbackDays")!, 10)))
    : undefined;
  const maxLines = url.searchParams.get("maxLines")
    ? Math.max(1, Math.min(2000, parseInt(url.searchParams.get("maxLines")!, 10)))
    : undefined;

  const result = await runDailyRecon(clientId, { dryRun, lookbackDays, maxLines });
  return NextResponse.json(result);
}
