import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/hardcore-cleanup/[runId]
 * Returns run row + items + (lightweight) CRM job snapshots for context.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> }
) {
  const { id: clientLinkId, runId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: run } = await service
    .from("hardcore_cleanup_runs" as any)
    .select("*")
    .eq("id", runId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const { data: items } = await service
    .from("hardcore_cleanup_items" as any)
    .select("*")
    .eq("run_id", runId)
    .order("qbo_customer_name", { ascending: true })
    .order("qbo_invoice_date", { ascending: false });

  // CRM jobs for any item that links to one — small set per run, fine to
  // pull all in one shot.
  const { data: crmJobs } = await service
    .from("hardcore_cleanup_crm_jobs" as any)
    .select("id, crm_job_id, job_name, customer_name, amount, job_date, job_status")
    .eq("run_id", runId);

  return NextResponse.json({
    ok: true,
    run,
    items: items || [],
    crm_jobs: crmJobs || [],
  });
}
