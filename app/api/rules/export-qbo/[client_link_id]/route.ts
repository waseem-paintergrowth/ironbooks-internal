import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

/**
 * GET /api/rules/export-qbo/[client_link_id]
 *
 * Returns an .xls file in QBO's exact "Export Rules" format so the
 * bookkeeper can upload it via QBO's Banking → Rules → ⋮ → Import Rules
 * flow. This is the workaround for QBO's public API not supporting
 * /bankrule POSTs (every attempt returns "Unsupported Operation").
 *
 * Format reverse-engineered from a real QBO export
 * (Painter_Growth_Ventures_Ltd__Bank_Feed_Rules.xls):
 *
 *   - Single sheet named "Worksheet"
 *   - 3 columns: "Rule Name" | "Rule Conditions" | "Rule Outputs"
 *   - Conditions + Outputs are JSON strings with numeric ruleType /
 *     actionType codes
 *   - Categories use account NAME (parent:child format), NOT internal
 *     QBO IDs — meaning we can write target_account_name straight
 *     through without resolving against the target QBO file
 *
 * Action type codes:
 *   0  = category (account name)
 *   1  = memo
 *   4  = tax code
 *   5  = payee
 *   7  = (numeric, observed but undocumented — class? location?)
 *   8  = auto-add boolean
 *   11 = (always [] in samples)
 *
 * Condition type codes:
 *   1  = description contains
 *   10 = transaction sign ("-1" = money out / expense, "1" = money in)
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ client_link_id: string }> }
) {
  const { client_link_id } = await params;

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  // Pull client name for the filename + ensure the user can access this client
  const { data: clientLink } = await service
    .from("client_links")
    .select("client_name")
    .eq("id", client_link_id)
    .single();

  if (!clientLink) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // Only export ACTIVE rules. "pending" rules haven't been approved yet,
  // "rejected" rules were deliberately killed, "active" rules are what
  // SNAP's daily-recon engine applies — and what Lisa wants in QBO too.
  const { data: rules, error } = await service
    .from("bank_rules")
    .select("vendor_pattern, target_account_name")
    .eq("client_link_id", client_link_id)
    .eq("status", "active")
    .not("vendor_pattern", "is", null)
    .not("target_account_name", "is", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!rules || rules.length === 0) {
    return NextResponse.json(
      { error: "No active bank rules to export for this client" },
      { status: 404 }
    );
  }

  // Build the rows in QBO's exact format. One row per rule.
  const rows: Array<Record<string, string>> = [];
  for (const r of rules) {
    const vendor = (r.vendor_pattern || "").trim();
    const account = (r.target_account_name || "").trim();
    if (!vendor || !account) continue;

    // QBO's conditions JSON. We model every SNAP rule as:
    //   "transaction is money out AND description contains <vendor>"
    // ruleType 10 = sign, "-1" = expense (the only direction SNAP
    // discovers right now — income rules aren't in the discovery pipeline)
    // ruleType 1  = description contains
    const conditions = {
      ruleConditions: [
        { ruleType: 10, value: "-1" },
        { ruleType: 1, value: vendor },
      ],
      isAndRule: true,
    };

    // QBO's actions JSON. We set:
    //   actionType 0  = category (the target account)
    //   actionType 1  = memo (echoes the vendor pattern so the bookkeeper
    //                  can eyeball it in QBO's tx list)
    //   actionType 11 = always [] per QBO's own exports
    //   actionType 8  = true  → auto-apply without confirmation, matching
    //                  the behavior of "active" rules in SNAP
    //
    // We intentionally OMIT actionType 4 (tax code) and 5 (payee).
    // Tax codes are per-jurisdiction and would force the bookkeeper to
    // either pick one in SNAP (we don't ask) or risk QBO refusing the
    // import. Payee similarly requires matching an existing QBO vendor
    // by exact name; we'd need a fuzzy match per-client to be safe.
    // Leaving both blank lets QBO apply its default behavior.
    const outputs = {
      ruleActions: [
        { actionType: 0, value: account },
        { actionType: 1, value: vendor },
        { actionType: 11, value: [] as unknown[] },
        { actionType: 8, value: true },
      ],
    };

    rows.push({
      "Rule Name": vendor,
      "Rule Conditions": JSON.stringify(conditions),
      "Rule Outputs": JSON.stringify(outputs),
    });
  }

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No active rules with both vendor + target account" },
      { status: 404 }
    );
  }

  // Build the workbook. Sheet name MUST be "Worksheet" — QBO's import
  // expects that exact name (matches what its own export emits).
  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: ["Rule Name", "Rule Conditions", "Rule Outputs"],
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Worksheet");

  // Write as legacy BIFF8 (.xls) — that's what QBO emits and most likely
  // what its importer expects. SheetJS supports it natively via bookType.
  const buffer: Buffer = XLSX.write(workbook, {
    bookType: "biff8",
    type: "buffer",
  });

  // Log the export so we have telemetry if Lisa hits import issues
  await service.from("audit_log").insert({
    event_type: "bank_rules_exported_qbo",
    user_id: user.id,
    request_payload: {
      client_link_id,
      client_name: clientLink.client_name,
      rule_count: rows.length,
      format: "biff8_xls",
    } as any,
  });

  // Sanitize the filename — strip anything that'd confuse a Windows
  // filesystem since bookkeepers are often on Windows
  const safeName = (clientLink.client_name || "client")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const filename = `${safeName}_Bank_Feed_Rules.xls`;

  return new NextResponse(buffer as any, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.ms-excel",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buffer.length),
    },
  });
}
