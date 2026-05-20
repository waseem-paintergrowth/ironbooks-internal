import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { DailyReconAdminClient } from "./admin-client";

export const dynamic = "force-dynamic";

/**
 * /admin/daily-recon — Admin control panel for the daily recon system.
 *
 * Lets an admin/lead:
 *   - Enable / disable daily_recon for individual clients
 *   - Pause / unpause clients (clears the auto-cap-exceeded paused flag)
 *   - Manually trigger the worker for a single client in dry-run mode
 *   - Inspect recent runs across all enrolled clients
 *
 * Pre-flight for the live cron rollout: enroll 2-3 pilot clients here,
 * run dry-runs for a few days, eyeball the daily_review_queue output.
 * When the auto-execute decisions look right, register the cron in
 * vercel.json and flip dryRun=false.
 */
export default async function DailyReconAdminPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return (
      <AppShell>
        <TopBar title="Forbidden" />
        <div className="px-8 py-12">
          <div className="p-4 bg-red-50 text-red-800 rounded-lg max-w-xl">
            Admin/lead role required.
          </div>
        </div>
      </AppShell>
    );
  }

  // All cleanup-complete clients (ones eligible to enroll). Daily recon only
  // makes sense post-cleanup — before that the reclass flow is doing the
  // bulk categorization.
  const { data: clientsData } = await service
    .from("client_links")
    .select(
      "id, client_name, jurisdiction, state_province, cleanup_completed_at, daily_recon_enabled, daily_recon_paused, daily_recon_paused_reason, last_synced_at"
    )
    .eq("is_active", true)
    .not("cleanup_completed_at", "is", null)
    .order("client_name");

  const clients = (clientsData || []) as any[];

  // Recent runs across all enrolled clients (last 50)
  const { data: runsData } = await service
    .from("daily_recon_runs" as any)
    .select("*")
    .order("run_at", { ascending: false })
    .limit(50);

  const runs = ((runsData as any[]) || []).map((r) => ({
    ...r,
    client_name:
      clients.find((c) => c.id === r.client_link_id)?.client_name || r.client_link_id,
  }));

  return (
    <AppShell>
      <TopBar title="Daily Recon — Admin" subtitle="Enroll clients, trigger dry-runs, inspect history" />
      <div className="px-8 py-6 max-w-6xl">
        <DailyReconAdminClient clients={clients} runs={runs} />
      </div>
    </AppShell>
  );
}
