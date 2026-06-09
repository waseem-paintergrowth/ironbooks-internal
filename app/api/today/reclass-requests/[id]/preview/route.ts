import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  fetchTransactionsForAccount,
  normalizeVendorName,
  getValidToken,
  sourceFromRequest,
} from "@/lib/qbo-reclass";

/**
 * GET /api/today/reclass-requests/[id]/preview
 *
 * Returns a preview of what an approve-with-bulk decision would touch:
 * count of matching transactions, total amount, and a small sample list.
 *
 * Match scope (Phase 3 default): vendor + source account. The vendor
 * comparison uses normalizeVendorName so "USPS", "U.S. Postal Service",
 * and "USPS PRIORITY MAIL" cluster together. If the request has no
 * vendor_name (account-level request without a transaction example),
 * the preview just returns the account-level count.
 *
 * Time range: calendar year-to-date. Most QBO companies use a calendar
 * fiscal year; non-calendar FY companies will get a slightly different
 * preview from what the manager probably means, but the bookkeeper can
 * still approve and the apply step uses the same range — they stay
 * consistent with each other.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const SAMPLE_LIMIT = 10;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: requestId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role;
  if (!["admin", "lead", "bookkeeper"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: reqRow } = await service
    .from("client_reclass_requests" as any)
    .select(
      "id, client_link_id, source_account_qbo_id, source_account_name, " +
      "target_account_qbo_id, target_account_name, vendor_name, example_txn_id, status"
    )
    .eq("id", requestId)
    .single();
  if (!reqRow) return NextResponse.json({ error: "Request not found" }, { status: 404 });

  // Ownership check — bookkeepers can only preview their own clients
  if (role === "bookkeeper") {
    const { data: client } = await service
      .from("client_links")
      .select("assigned_bookkeeper_id")
      .eq("id", (reqRow as any).client_link_id)
      .single();
    if ((client as any)?.assigned_bookkeeper_id !== user.id) {
      return NextResponse.json({ error: "Not your client" }, { status: 403 });
    }
  }

  // ── Time range: calendar YTD ──
  const now = new Date();
  const yearStart = `${now.getFullYear()}-01-01`;
  const today = now.toISOString().slice(0, 10);

  // Get a QBO token via the vending machinery — uses the same lock + log path
  // as portal reads so we don't race anyone else.
  let accessToken: string;
  let realmId: string;
  try {
    const { data: link } = await service
      .from("client_links")
      .select("qbo_realm_id")
      .eq("id", (reqRow as any).client_link_id)
      .single();
    realmId = (link as any)?.qbo_realm_id;
    if (!realmId) {
      return NextResponse.json({ error: "Client has no QBO realm_id" }, { status: 400 });
    }
    accessToken = await getValidToken(
      (reqRow as any).client_link_id,
      service as any,
      sourceFromRequest(request)
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: `QBO token unavailable: ${e?.message || "unknown"}` },
      { status: 502 }
    );
  }

  // Fetch all lines hitting the source account in the FY range
  let result;
  try {
    result = await fetchTransactionsForAccount(
      realmId,
      accessToken,
      (reqRow as any).source_account_qbo_id,
      yearStart,
      today
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: `QBO query failed: ${e?.message || "unknown"}` },
      { status: 502 }
    );
  }

  // Filter by vendor if the request was tx-level (had an example txn → vendor)
  const requestVendor = (reqRow as any).vendor_name as string | null;
  const targetVendorNorm = requestVendor ? normalizeVendorName(requestVendor) : null;

  const allLines = result.lines;
  const matchedLines = targetVendorNorm
    ? allLines.filter((l) => normalizeVendorName(l.vendor_name) === targetVendorNorm)
    : allLines;

  // Build a small sample for the UI — most recent first
  const sample = matchedLines
    .slice()
    .sort((a, b) => (a.transaction_date < b.transaction_date ? 1 : -1))
    .slice(0, SAMPLE_LIMIT)
    .map((l) => ({
      transaction_id: l.transaction_id,
      transaction_type: l.transaction_type,
      transaction_date: l.transaction_date,
      vendor_name: l.vendor_name,
      amount: l.transaction_amount,
      description: l.description,
      is_reconciled: l.is_reconciled,
    }));

  const totalAmount = matchedLines.reduce((s, l) => s + (l.transaction_amount || 0), 0);
  const reconciledCount = matchedLines.filter((l) => l.is_reconciled).length;
  const uniqueTxns = new Set(matchedLines.map((l) => l.transaction_id)).size;

  return NextResponse.json({
    ok: true,
    request_id: requestId,
    period: { start: yearStart, end: today, label: `YTD ${now.getFullYear()}` },
    source_account: {
      id: (reqRow as any).source_account_qbo_id,
      name: (reqRow as any).source_account_name,
    },
    target_account: {
      id: (reqRow as any).target_account_qbo_id,
      name: (reqRow as any).target_account_name,
    },
    vendor: requestVendor,
    counts: {
      matched_lines: matchedLines.length,
      matched_transactions: uniqueTxns,
      reconciled_lines: reconciledCount,
      account_total_lines: allLines.length,
    },
    total_amount: totalAmount,
    unreclassifiable_in_account: result.unreclassifiableLines.length,
    sample,
  });
}
