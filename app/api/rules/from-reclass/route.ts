import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts } from "@/lib/qbo";
import { createBankRule } from "@/lib/qbo-rules";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { reclass_job_id, client_link_id, selected_vendors, overrides } = body as {
    reclass_job_id: string;
    client_link_id: string;
    selected_vendors: string[];
    overrides?: Record<string, { id: string; name: string }>;
  };

  if (!reclass_job_id || !client_link_id || !selected_vendors?.length) {
    return NextResponse.json(
      { error: "reclass_job_id, client_link_id, and selected_vendors are required" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();

  // Include every decision type that came in with a vendor + target. The
  // page surfaces them all; the POST has to accept them all too, otherwise
  // selected vendors silently drop out at create time.
  const { data: rows } = await service
    .from("reclassifications")
    .select(
      "vendor_name, vendor_pattern_normalized, to_account_id, to_account_name, bookkeeper_override_target_id, bookkeeper_override_target_name, transaction_amount"
    )
    .eq("reclass_job_id", reclass_job_id)
    .in("decision", ["auto_approve", "approved", "needs_review", "flagged", "ask_client"])
    .not("vendor_name", "is", null);

  type ReclassRow = {
    vendor_name: string | null;
    vendor_pattern_normalized: string | null;
    to_account_id: string;
    to_account_name: string | null;
    bookkeeper_override_target_id: string | null;
    bookkeeper_override_target_name: string | null;
    transaction_amount: number | null;
  };

  const groupMap = new Map<
    string,
    {
      vendorDisplay: string;
      targetCounts: Map<string, { id: string; name: string; count: number }>;
      txCount: number;
      totalAmount: number;
      sampleDescriptions: string[];
    }
  >();

  for (const row of (rows || []) as ReclassRow[]) {
    const groupKey = row.vendor_pattern_normalized || row.vendor_name || "";
    if (!groupKey) continue;

    const targetId = row.bookkeeper_override_target_id || row.to_account_id;
    const targetName = row.bookkeeper_override_target_name || row.to_account_name;
    if (!targetName) continue;

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        vendorDisplay: row.vendor_name || groupKey,
        targetCounts: new Map(),
        txCount: 0,
        totalAmount: 0,
        sampleDescriptions: [],
      });
    }

    const group = groupMap.get(groupKey)!;
    group.txCount += 1;
    group.totalAmount += row.transaction_amount || 0;

    if (row.vendor_name && group.sampleDescriptions.length < 3) {
      if (!group.sampleDescriptions.includes(row.vendor_name)) {
        group.sampleDescriptions.push(row.vendor_name);
      }
    }

    const existing = group.targetCounts.get(targetId);
    if (existing) {
      existing.count += 1;
    } else {
      group.targetCounts.set(targetId, { id: targetId, name: targetName, count: 1 });
    }
  }

  const selectedSet = new Set(selected_vendors);
  const rulesToUpsert: Array<{
    client_link_id: string;
    vendor_pattern: string;
    match_type: string;
    target_account_name: string;
    status: string;
    ai_confidence: null;
    ai_reasoning: null;
    requires_approval: boolean;
    sample_descriptions: string[];
    transaction_count: number;
    total_amount: number;
    created_by: string;
    pushed_to_qbo: boolean;
  }> = [];

  for (const [vendorPattern, group] of groupMap.entries()) {
    if (!selectedSet.has(vendorPattern)) continue;

    // Prefer the bookkeeper's override (set in the dropdown); fall back to
    // the most-frequent AI-picked target.
    let bestTarget = { id: "", name: "" };
    const override = overrides?.[vendorPattern];
    if (override?.name) {
      bestTarget = { id: override.id || "", name: override.name };
    } else {
      let bestCount = 0;
      for (const t of group.targetCounts.values()) {
        if (t.count > bestCount) {
          bestCount = t.count;
          bestTarget = { id: t.id, name: t.name };
        }
      }
    }
    if (!bestTarget.name) continue;

    rulesToUpsert.push({
      client_link_id,
      vendor_pattern: vendorPattern,
      match_type: "CONTAINS",
      target_account_name: bestTarget.name,
      status: "approved",
      ai_confidence: null,
      ai_reasoning: null,
      requires_approval: false,
      sample_descriptions: group.sampleDescriptions,
      transaction_count: group.txCount,
      total_amount: group.totalAmount,
      created_by: user.id, // UUID — bank_rules.created_by FKs to users.id
      pushed_to_qbo: false,
    });
  }

  if (rulesToUpsert.length === 0) {
    return NextResponse.json({ created: 0, rules: [] });
  }

  const { data: upserted, error } = await service
    .from("bank_rules")
    .upsert(rulesToUpsert, { onConflict: "client_link_id,vendor_pattern" })
    .select();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // ──────────────────── PUSH TO QBO ────────────────────
  // Up to this point we've only written to the local bank_rules table —
  // every row is pushed_to_qbo=false. Historically the from-reclass flow
  // STOPPED here, which is exactly why LT Woodworks saw "X bank rules
  // created" but found nothing in QBO. Now we push synchronously, mark
  // success per row, and return both counts in the response.
  //
  // Per-rule failures are non-fatal — the row stays at pushed_to_qbo=false
  // and surfaces on the next bank-rules screen visit, where the bookkeeper
  // can retry just the failed ones.
  const upsertedRows = (upserted || []) as Array<{
    id: string;
    vendor_pattern: string;
    match_type: string | null;
    target_account_name: string;
    pushed_to_qbo: boolean | null;
    qbo_rule_id: string | null;
    tax_code_ref: string | null;
  }>;

  // Only push rows that aren't already in QBO. ON CONFLICT can return an
  // existing row that was previously pushed — re-pushing creates a
  // duplicate in QBO. Defensive filter prevents that.
  const needsPush = upsertedRows.filter(
    (r) => !r.pushed_to_qbo && !r.qbo_rule_id
  );

  let pushed = 0;
  const pushErrors: string[] = [];

  if (needsPush.length > 0) {
    let accessToken: string;
    try {
      accessToken = await getValidToken(client_link_id, service as any);
    } catch (err: any) {
      const msg = err?.message || String(err);
      const friendly = /invalid_grant|token refresh failed|Incorrect Token type/i.test(msg)
        ? "QBO connection is no longer valid. Reconnect QBO from the client's Settings → QuickBooks page, then re-open this Bank Rules step to push the saved rules."
        : `QBO token error: ${msg}`;
      // Local rules already saved; just report the push failure.
      return NextResponse.json({
        created: upsertedRows.length,
        rules: upsertedRows,
        pushed: 0,
        push_failed: needsPush.length,
        push_errors: [friendly],
      });
    }

    // Resolve target_account_name → QBO account id.
    let qboAccounts: Awaited<ReturnType<typeof fetchAllAccounts>>;
    try {
      const { data: clientLink } = await service
        .from("client_links")
        .select("qbo_realm_id")
        .eq("id", client_link_id)
        .single();
      const realmId = (clientLink as any)?.qbo_realm_id;
      if (!realmId) throw new Error("Client missing qbo_realm_id");
      qboAccounts = await fetchAllAccounts(realmId, accessToken);
    } catch (err: any) {
      return NextResponse.json({
        created: upsertedRows.length,
        rules: upsertedRows,
        pushed: 0,
        push_failed: needsPush.length,
        push_errors: [`Couldn't fetch QBO accounts: ${err.message}`],
      });
    }

    const accountByName = new Map<string, (typeof qboAccounts)[number]>(
      qboAccounts.map((a) => [a.Name, a])
    );

    const { data: clientLinkAgain } = await service
      .from("client_links")
      .select("qbo_realm_id")
      .eq("id", client_link_id)
      .single();
    const realmId = (clientLinkAgain as any).qbo_realm_id as string;

    for (const rule of needsPush) {
      try {
        const account = accountByName.get(rule.target_account_name);
        if (!account) {
          throw new Error(
            `Target account "${rule.target_account_name}" not found in QBO (may have been renamed/inactivated after the cleanup)`
          );
        }

        const matchType: "Contains" | "StartsWith" | "Is" =
          rule.match_type === "STARTSWITH" || rule.match_type === "startswith"
            ? "StartsWith"
            : rule.match_type === "IS" || rule.match_type === "is"
            ? "Is"
            : "Contains";

        const created = await createBankRule(realmId, accessToken, {
          name: `Ironbooks: ${rule.vendor_pattern}`,
          vendorPattern: rule.vendor_pattern,
          matchType,
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
        pushErrors.push(`${rule.vendor_pattern}: ${e?.message || String(e)}`);
      }
    }
  }

  return NextResponse.json({
    created: upsertedRows.length,
    rules: upsertedRows,
    pushed,
    push_failed: needsPush.length - pushed,
    push_errors: pushErrors,
  });
}

// QBO writes are sequential with rate-limit waits; budget for moderately
// large rule sets (50+ vendors) without hitting Vercel's default cap.
export const maxDuration = 300;
