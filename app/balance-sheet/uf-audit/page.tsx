import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { UfAuditPicker } from "./picker-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/uf-audit
 *
 * Cross-client picker for the UF Audit — THE tool for clearing Undeposited
 * Funds (duplicate payments, missing deposits, CRM double-counts). Sidebar
 * entry under Operations routes here; pick a client and land on
 * /balance-sheet/[id]/uf-audit.
 */
export default async function UfAuditPickerPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: clientLinks } = await supabase
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, cleanup_completed_at, assigned_bookkeeper_id")
    .eq("is_active", true)
    .order("client_name");

  return (
    <AppShell>
      <TopBar
        title="UF Audit"
        subtitle="Clear Undeposited Funds — duplicates, missing deposits, CRM double-counts"
      />
      <div className="px-8 py-6 max-w-3xl space-y-4">
        <UfAuditPicker clientLinks={(clientLinks as any[]) || []} />
      </div>
    </AppShell>
  );
}
