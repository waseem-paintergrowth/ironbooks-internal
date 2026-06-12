import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { CleanupBoard } from "./cleanup-board";

export const dynamic = "force-dynamic";

/**
 * /cleanup — every new client's home until their books are clean.
 *
 * Three columns: Needs Cleanup → In Progress → Awaiting Mgr Review.
 * Each card carries the step-by-step checklist (COA → Reclass → Bank
 * Rules → Stripe → BS Cleanup → Statements sign-off) with deep links into
 * the existing tools. Manager approval of the statement sign-off moves
 * the client off this board and into Production.
 */
export default async function CleanupPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  return (
    <AppShell>
      <TopBar
        title="Cleanup"
        subtitle="New clients · step-by-step to clean books, then on to Production"
      />
      <div className="px-8 py-6 max-w-7xl">
        <CleanupBoard />
      </div>
    </AppShell>
  );
}
