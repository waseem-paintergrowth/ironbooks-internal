import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { QboHealthClient, type ClientHealthRow } from "./qbo-health-client";

export const dynamic = "force-dynamic";

/**
 * /fleet/qbo-health
 *
 * Single page showing every client's QBO connection health, with
 * inline re-auth buttons + a bulk-reconnect mode.
 *
 * Data source: qbo_connection_health (populated by /api/fleet/qbo-health-check).
 * If the table is empty (probe never run), prompts the bookkeeper to
 * run it from the page.
 *
 * Admin/lead only — the probe + re-auth flows shouldn't be initiated
 * by bookkeepers casually.
 */
export default async function QboHealthPage() {
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
    redirect("/dashboard");
  }

  // Pull every active client + their health row + bookkeeper.
  const [clientsRes, healthRes, bookkeepersRes] = await Promise.all([
    service
      .from("client_links")
      .select(
        "id, client_name, qbo_realm_id, assigned_bookkeeper_id, jurisdiction, state_province, created_at"
      )
      .eq("is_active", true)
      .order("client_name"),
    (service as any)
      .from("qbo_connection_health")
      .select(
        "client_link_id, status, last_checked_at, error_message, last_ok_at, first_failed_at, reconnect_initiated_at, reconnect_initiated_by"
      ),
    service
      .from("users")
      .select("id, full_name")
      .eq("is_active", true),
  ]);

  const healthByClient = new Map<string, any>();
  for (const h of (healthRes.data as any[]) || []) {
    healthByClient.set(h.client_link_id, h);
  }
  const bookkeepersById = new Map<string, string>();
  for (const u of (bookkeepersRes.data as any[]) || []) {
    bookkeepersById.set(u.id, u.full_name);
  }

  const rows: ClientHealthRow[] = ((clientsRes.data as any[]) || []).map((c) => {
    const h = healthByClient.get(c.id);
    let status: ClientHealthRow["status"];
    if (!c.qbo_realm_id) status = "never_connected";
    else if (!h) status = "unknown";
    else status = h.status;
    return {
      client_link_id: c.id,
      client_name: c.client_name,
      qbo_realm_id: c.qbo_realm_id,
      jurisdiction: c.jurisdiction || null,
      state_province: c.state_province || null,
      bookkeeper_id: c.assigned_bookkeeper_id,
      bookkeeper_name: c.assigned_bookkeeper_id
        ? bookkeepersById.get(c.assigned_bookkeeper_id) || null
        : null,
      client_created_at: c.created_at,
      status,
      last_checked_at: h?.last_checked_at || null,
      error_message: h?.error_message || null,
      last_ok_at: h?.last_ok_at || null,
      first_failed_at: h?.first_failed_at || null,
      reconnect_initiated_at: h?.reconnect_initiated_at || null,
      reconnect_initiated_by_name: h?.reconnect_initiated_by
        ? bookkeepersById.get(h.reconnect_initiated_by) || null
        : null,
    };
  });

  const probeNeverRun = ((healthRes.data as any[]) || []).length === 0;

  return (
    <AppShell>
      <TopBar
        title="QBO Connection Health"
        subtitle="Every client's QuickBooks refresh-token state — re-auth dead connections in bulk"
      />
      <div className="px-6 py-5 max-w-[1400px] mx-auto">
        <QboHealthClient rows={rows} probeNeverRun={probeNeverRun} />
      </div>
    </AppShell>
  );
}
