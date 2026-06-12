import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { ProductionBoard } from "./production-board";

export const dynamic = "force-dynamic";

/**
 * /production — month-by-month board for graduated (production) clients.
 *
 * Columns: Not Started / In Progress / Stuck / Waiting on Client, plus a
 * Done strip. Clients arrive here when a manager approves their cleanup
 * sign-off. Each month is tracked separately — finish May and the client
 * shows up in June's Not Started.
 */
export default async function ProductionPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  return (
    <AppShell>
      <TopBar
        title="Production"
        subtitle="Monthly close board · graduated clients, month by month"
      />
      <div className="px-8 py-6 max-w-7xl">
        <ProductionBoard />
      </div>
    </AppShell>
  );
}
