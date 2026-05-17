import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts } from "@/lib/qbo";
import { createBankRule } from "@/lib/qbo-rules";
import { NextResponse } from "next/server";

/**
 * POST /api/rules/execute
 *
 * Body: { discovery_job_id: string }
 *
 * Pushes all approved bank_rules for this discovery job to QuickBooks Online.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { discovery_job_id } = await request.json();
  if (!discovery_job_id) {
    return NextResponse.json({ error: "discovery_job_id required" }, { status: 400 });
  }

  const service = createServiceSupabase();

  // Load job + client
  const { data: job } = await service
    .from("rule_discovery_jobs")
    .select("*, client_links(*)")
    .eq("id", discovery_job_id)
    .single();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const clientLink = (job as any).client_links;
  if (!clientLink) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  await service
    .from("rule_discovery_jobs")
    .update({
      status: "executing",
      execution_started_at: new Date().toISOString(),
    } as any)
    .eq("id", discovery_job_id);

  // Load approved rules
  const { data: rules } = await service
    .from("bank_rules")
    .select("*")
    .eq("discovery_job_id", discovery_job_id)
    .eq("status", "approved");

  if (!rules || rules.length === 0) {
    return NextResponse.json({ error: "No approved rules to push" }, { status: 400 });
  }

  // Get fresh token + QBO account ID lookup
  const accessToken = await getValidToken(clientLink.id, service as any);
  const qboAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
  const accountByName = new Map(qboAccounts.map((a) => [a.Name, a]));

  const errors: string[] = [];
  let pushed = 0;

  for (const rule of rules) {
    try {
      const account = accountByName.get(rule.target_account_name);
      if (!account) {
        throw new Error(`Target account "${rule.target_account_name}" not found in QBO`);
      }

      const created = await createBankRule(clientLink.qbo_realm_id, accessToken, {
        name: `Ironbooks: ${rule.vendor_pattern}`,
        vendorPattern: rule.vendor_pattern,
        matchType: (rule.match_type || "contains") === "contains"
          ? "Contains"
          : rule.match_type === "startswith"
          ? "StartsWith"
          : "Is",
        targetAccountId: account.Id,
        taxCodeId: rule.tax_code_ref || undefined,
      });

      await service
        .from("bank_rules")
        .update({
          qbo_rule_id: created.Id,
          pushed_to_qbo: true,
          status: "pushed",
        } as any)
        .eq("id", rule.id);

      pushed++;
    } catch (e: any) {
      errors.push(`${rule.vendor_pattern}: ${e.message}`);
    }
  }

  await service
    .from("rule_discovery_jobs")
    .update({
      status: errors.length === 0 ? "complete" : "failed",
      execution_completed_at: new Date().toISOString(),
      rules_pushed: pushed,
      error_message: errors.length > 0 ? errors.join("; ") : null,
    } as any)
    .eq("id", discovery_job_id);

  return NextResponse.json({
    success: errors.length === 0,
    pushed,
    failed: errors.length,
    errors,
  });
}

export const maxDuration = 300;
