import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase } from "@/lib/supabase";
import { NewJobForm } from "./form";

export default async function NewJobPage() {
  const supabase = await createServerSupabase();

  // Hide cleanup-completed clients from the select-client list. They show up
  // in the Completed Accounts table on /clients with a Reopen button if a
  // bookkeeper genuinely needs to start fresh work on a closed-out client.
  const { data: clientLinks } = await supabase
    .from("client_links")
    .select("*")
    .eq("is_active", true)
    .is("cleanup_completed_at", null)
    .order("client_name");

  return (
    <AppShell>
      <TopBar
        title="New COA Cleanup Job"
        subtitle="Select the client you want to clean up"
      />
      <WorkflowStepper currentStep="coa" currentState="active" />
      <div className="px-8 py-6 max-w-4xl">
        <NewJobForm clientLinks={clientLinks || []} />
      </div>
    </AppShell>
  );
}
