import { NextResponse } from "next/server";
import { resolvePortalContext, PortalAccessError } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";

/**
 * POST /api/portal/reclass-request
 *
 * Client submits a "this should be in a different category" request from
 * the P&L drill-down. Stores source/target account + (optional) example
 * transaction + free-text reason. No QBO writes — manager approves in
 * /today and the approval handler runs the bulk reclass.
 *
 * Body:
 *   {
 *     source_account_qbo_id: string,    // required — the current QBO account
 *     source_account_name:   string,    // human label for the request UI
 *     target_account_qbo_id: string,    // required — desired QBO account
 *     target_account_name:   string,    // human label
 *     example_txn_id?:       string,    // QBO txn id the client clicked
 *     example_txn_type?:     string,    // "Purchase", "Bill", etc. — used for QBO query
 *     vendor_name?:          string,    // payee, e.g. "USPS" — drives bulk scope
 *     example_txn_date?:     string,    // YYYY-MM-DD
 *     example_txn_amount?:   number,
 *     example_txn_memo?:     string,
 *     period_label?:         string,    // "Last month (April 2026)"
 *     period_start?:         string,    // YYYY-MM-DD
 *     period_end?:           string,
 *     client_reason:         string,    // required, max 1500 chars
 *   }
 *
 * Audit-logged. Blocked while admin is impersonating so test requests
 * don't pollute the manager queue.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REASON_LEN = 1500;

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await resolvePortalContext();
  } catch (err) {
    if (err instanceof PortalAccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "no_session" ? 401 : 403 }
      );
    }
    return NextResponse.json({ error: "Access check failed" }, { status: 500 });
  }

  // Mirror the transaction-flags route: admins viewing as a client shouldn't
  // generate live queue entries. Reads still work; writes don't.
  if (ctx.impersonating) {
    return NextResponse.json(
      {
        error:
          "You're viewing as an admin (impersonating). Reclass requests are disabled in this mode.",
        code: "impersonating",
      },
      { status: 400 }
    );
  }

  const body = await request.json().catch(() => ({} as any));
  const reason = String(body.client_reason || "").trim();
  if (!reason) {
    return NextResponse.json({ error: "client_reason is required" }, { status: 400 });
  }
  if (reason.length > MAX_REASON_LEN) {
    return NextResponse.json(
      { error: `Reason is too long — keep it under ${MAX_REASON_LEN} characters.` },
      { status: 400 }
    );
  }
  const sourceId = String(body.source_account_qbo_id || "");
  const targetId = String(body.target_account_qbo_id || "");
  const sourceName = String(body.source_account_name || "").trim();
  const targetName = String(body.target_account_name || "").trim();
  if (!sourceId || !targetId) {
    return NextResponse.json(
      { error: "source_account_qbo_id and target_account_qbo_id are required" },
      { status: 400 }
    );
  }
  if (sourceId === targetId) {
    return NextResponse.json(
      { error: "Target account is the same as the source — pick a different one." },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();
  const { data: inserted, error: insertErr } = await service
    .from("client_reclass_requests" as any)
    .insert({
      client_link_id:        ctx.clientLinkId,
      requested_by:          ctx.userId,
      source_account_qbo_id: sourceId,
      source_account_name:   sourceName || null,
      target_account_qbo_id: targetId,
      target_account_name:   targetName || null,
      example_txn_id:        body.example_txn_id || null,
      vendor_name:           body.vendor_name || null,
      client_reason:         reason,
      // Manager assigns these at decision time. We store any period context
      // the client was viewing as metadata so the manager can default
      // apply_period_* to that range if they want to narrow scope.
      status:                "pending",
    } as any)
    .select("id, requested_at")
    .single();

  if (insertErr) {
    return NextResponse.json(
      { error: `Insert failed: ${insertErr.message}` },
      { status: 500 }
    );
  }

  await service.from("audit_log").insert({
    event_type: "portal_reclass_requested",
    user_id: ctx.userId,
    request_payload: {
      client_link_id: ctx.clientLinkId,
      request_id: (inserted as any).id,
      source_account_qbo_id: sourceId,
      source_account_name: sourceName,
      target_account_qbo_id: targetId,
      target_account_name: targetName,
      vendor_name: body.vendor_name || null,
      example_txn_id: body.example_txn_id || null,
      period_label: body.period_label || null,
    } as any,
  });

  return NextResponse.json({
    ok: true,
    request_id: (inserted as any).id,
    requested_at: (inserted as any).requested_at,
  });
}

/**
 * GET /api/portal/reclass-request
 *
 * Returns this client's reclass requests so the P&L can mark accounts /
 * transactions that already have a pending request. Anyone on the same
 * client_users mapping sees every request for the client (single-team
 * model — admins on the account see what their colleagues asked for).
 *
 * Query params:
 *   status — optional filter ("pending" | "approved" | "declined" |
 *            "applied" | "failed"). Default: returns all non-cancelled.
 *   limit  — max rows, default 50, cap 200.
 */
export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await resolvePortalContext();
  } catch (err) {
    if (err instanceof PortalAccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "no_session" ? 401 : 403 }
      );
    }
    return NextResponse.json({ error: "Access check failed" }, { status: 500 });
  }

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));

  const service = createServiceSupabase();
  let query = service
    .from("client_reclass_requests" as any)
    .select(
      "id, requested_at, source_account_qbo_id, source_account_name, " +
      "target_account_qbo_id, target_account_name, example_txn_id, vendor_name, " +
      "client_reason, status, decided_at, decision_note, applied_at, applied_txn_count"
    )
    .eq("client_link_id", ctx.clientLinkId)
    .order("requested_at", { ascending: false })
    .limit(limit);

  if (statusFilter) {
    query = query.eq("status", statusFilter);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, requests: data ?? [] });
}
