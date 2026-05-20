import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase } from "@/lib/supabase";
import { NewReclassForm } from "./form";

export default async function NewReclassPage() {
  const supabase = await createServerSupabase();

  // Completed clients are hidden — they live in /clients Completed Accounts
  // with a Reopen button. In-review clients are still included: a bookkeeper
  // may need to run or re-run a reclassification as part of the cleanup work
  // even while it's awaiting senior approval (e.g. retrying a failed job).
  // Contrast with the COA job page which also excludes in-review clients,
  // since re-running the whole COA cleanup on something mid-review makes no
  // sense. For reclass, restricting to cleanup_completed_at IS NULL is enough.
  const { data: clientLinks } = await supabase
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, qbo_realm_id, double_client_id, double_client_name")
    .eq("is_active", true)
    .is("cleanup_completed_at", null)
    .order("client_name");

  return (
    <AppShell>
      <TopBar
        title="New Reclassification Job"
        subtitle="Categorize transactions against the new COA"
      />
      <WorkflowStepper currentStep="reclass" currentState="active" completedSteps={["coa"]} />
      <div className="px-8 py-6 max-w-4xl">
        <NewReclassForm clientLinks={clientLinks || []} />
      </div>
    </AppShell>
  );
}
