import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { JobHistory } from "./job-history";

export default async function HistoryPage() {
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();

  // Pull cleanup jobs + rule jobs + reclass jobs with joins
  const [cleanupJobsRes, ruleJobsRes, reclassJobsRes, bookkeepersRes, clientsRes] = await Promise.all([
    supabase
      .from("coa_jobs")
      .select(`
        id,
        status,
        created_at,
        execution_started_at,
        execution_completed_at,
        execution_duration_seconds,
        accounts_to_rename,
        accounts_to_create,
        accounts_to_delete,
        accounts_flagged,
        flagged_for_lisa,
        error_message,
        manual_cleanup_items,
        merge_candidates,
        bookkeeper_id,
        client_link_id,
        client_links (client_name, jurisdiction, state_province),
        users:bookkeeper_id (full_name)
      `)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("rule_discovery_jobs")
      .select(`
        id,
        status,
        created_at,
        execution_started_at,
        execution_completed_at,
        months_analyzed,
        transactions_pulled,
        vendors_identified,
        rules_suggested,
        rules_pushed,
        error_message,
        bookkeeper_id,
        client_link_id,
        client_links (client_name, jurisdiction, state_province),
        users:bookkeeper_id (full_name)
      `)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("reclass_jobs")
      .select(`
        id,
        status,
        workflow,
        created_at,
        execution_started_at,
        execution_completed_at,
        execution_duration_seconds,
        source_account_name,
        target_account_name,
        transactions_moved,
        transactions_failed,
        transactions_auto_approve,
        transactions_needs_review,
        transactions_flagged,
        is_rollback,
        rolled_back,
        error_message,
        bookkeeper_id,
        client_link_id,
        client_links (client_name, jurisdiction, state_province),
        users:bookkeeper_id (full_name)
      `)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("users")
      .select("id, full_name, role")
      .eq("is_active", true)
      .in("role", ["admin", "lead", "bookkeeper", "viewer"])
      .order("full_name"),
    supabase
      .from("client_links")
      .select("id, client_name")
      .order("client_name"),
  ]);

  // Normalize into unified job items
  const cleanupJobs = (cleanupJobsRes.data || []).map((j: any) => ({
    id: j.id,
    type: "cleanup" as const,
    status: j.status,
    created_at: j.created_at,
    started_at: j.execution_started_at,
    completed_at: j.execution_completed_at,
    duration_seconds: j.execution_duration_seconds,
    bookkeeper_id: j.bookkeeper_id,
    bookkeeper_name: j.users?.full_name,
    client_link_id: j.client_link_id,
    client_name: j.client_links?.client_name,
    client_jurisdiction: j.client_links?.jurisdiction,
    client_state: j.client_links?.state_province,
    flagged: j.flagged_for_lisa,
    error_message: j.error_message,
    summary: {
      renamed: j.accounts_to_rename || 0,
      created: j.accounts_to_create || 0,
      deleted: j.accounts_to_delete || 0,
      flagged: j.accounts_flagged || 0,
      manual_cleanup: Array.isArray(j.manual_cleanup_items) ? j.manual_cleanup_items.length : 0,
      merges: Array.isArray(j.merge_candidates) ? j.merge_candidates.length : 0,
    },
  }));

  const ruleJobs = (ruleJobsRes.data || []).map((j: any) => ({
    id: j.id,
    type: "rules" as const,
    status: j.status,
    created_at: j.created_at,
    started_at: j.execution_started_at,
    completed_at: j.execution_completed_at,
    duration_seconds: null,
    bookkeeper_id: j.bookkeeper_id,
    bookkeeper_name: j.users?.full_name,
    client_link_id: j.client_link_id,
    client_name: j.client_links?.client_name,
    client_jurisdiction: j.client_links?.jurisdiction,
    client_state: j.client_links?.state_province,
    flagged: false,
    error_message: j.error_message,
    summary: {
      months: j.months_analyzed || 0,
      transactions: j.transactions_pulled || 0,
      vendors: j.vendors_identified || 0,
      suggested: j.rules_suggested || 0,
      pushed: j.rules_pushed || 0,
    },
  }));

  const reclassJobs = (reclassJobsRes.data || []).map((j: any) => ({
    id: j.id,
    type: "reclass" as const,
    status: j.status,
    created_at: j.created_at,
    started_at: j.execution_started_at,
    completed_at: j.execution_completed_at,
    duration_seconds: j.execution_duration_seconds,
    bookkeeper_id: j.bookkeeper_id,
    bookkeeper_name: j.users?.full_name,
    client_link_id: j.client_link_id,
    client_name: j.client_links?.client_name,
    client_jurisdiction: j.client_links?.jurisdiction,
    client_state: j.client_links?.state_province,
    flagged: false,
    error_message: j.error_message,
    summary: {
      workflow: j.workflow,
      source: j.source_account_name,
      target: j.target_account_name,
      moved: j.transactions_moved || 0,
      failed: j.transactions_failed || 0,
      auto: j.transactions_auto_approve || 0,
      review: j.transactions_needs_review || 0,
      is_rollback: j.is_rollback,
      rolled_back: j.rolled_back,
    },
  }));

  // Merge + sort by created_at desc
  const allJobs = [...cleanupJobs, ...ruleJobs, ...reclassJobs].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return (
    <AppShell>
      <TopBar
        title="Job History"
        subtitle={`${allJobs.length} jobs (cleanups + rule discoveries + reclassifications)`}
      />
      <div className="px-8 py-6">
        <JobHistory
          initialJobs={allJobs}
          bookkeepers={bookkeepersRes.data || []}
          clients={clientsRes.data || []}
          currentUserId={user?.id || ""}
        />
      </div>
    </AppShell>
  );
}
